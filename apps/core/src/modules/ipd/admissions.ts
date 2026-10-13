import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { IPD_INTENTS, ipdIsInFuture, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissionDeposits, ipdAdmissions, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { startInstance } from "../../kernel/workflow/instances";
import { rescheduleBudget } from "../../kernel/workflow/timers";
import { advanceOf } from "../billing";
import { getEncounter } from "../opd";
import { getPatient } from "../patients";
import { resolveActiveTariffVersion } from "../tariff";
import { ADMISSION_WORKFLOW_DEF_KEY, requestedBudgetMinutes } from "./admission-workflow";
import {
  alreadyOpen, holdsPermission, isIcuClass, isOpenAdmissionRace, lockAdmission, mintAdmissionNo, moveAdmission, needOf,
  onceIpd, openAdmissionOf, provenanceOf, readAdmission, requireIpdPermission, workflowRefusal,
} from "./admission-core";
import {
  admissionAdmitted, admissionBackfilled, admissionCancelled, admissionConsented, admissionRequested, admissionStabilised,
} from "./admission-events";
import { grantedApproval } from "./approval-types";
import { assignBedIn, endAdmissionHolds, placementContext, readBedFacts, withNextRuleValidBeds } from "./beds";
import { depositPaidPaise } from "./deposit";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_ADMIT, IPD_ADMIT_REQUEST } from "./manifest";
import type { Actor, IpdAdmissionIncomplete, IpdBedClass, IpdBedNeed, IpdConsent, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E1.2 (#719) — THE ADMISSION INTENTS (spec SPEC-ipd-core §4.2; contracts `packages/contracts/src/ipd/intents-admit.ts`).
 *
 * Same shape as the bed intents: parse the contract input → re-check the permission → run once under the
 * idempotency key → lock (bed first, then the admission row) → re-check state and rules → write the row, move the
 * workflow instance (one per admission, mirrored in `ipd_admissions.state`) and append the event.
 *
 * The rules this file owns: one open admission per patient (refused showing the first, and a partial unique index
 * behind the check); advice expires 24 h after its planned date; ICU needs an intensivist's GRANTED approval; consent
 * before admission (the emergency lane catches up later); a deposit receipt or a valid exemption before admission.
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

const DAY_MS = 86_400_000;
const SCHEME: ReadonlySet<string> = new Set(["pmjay", "state_scheme"]);
const ENDED_STATES = ["discharged", "lama", "absconded", "deceased", "transferred_out"];
const IST_OFFSET_MS = 330 * 60_000;
const istDay = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The patient through the merge chain; refuses unknown and deceased. Returns the canonical id. */
async function livePatient(db: Db, actor: Actor, patientId: string): Promise<string> {
  const found = await getPatient(db, actor, patientId);
  if (found === null) throw new IpdRefusal("patient_not_found");
  if (found.patient.deceasedAt !== null) throw new IpdRefusal("patient_deceased");
  return found.patient.id;
}

function checkConsent(consent: IpdConsent): void {
  if (consent.signedBy === "representative" && consent.representativeReason === undefined) {
    throw new IpdRefusal("representative_reason_missing");
  }
}

function consentRecord(c: IpdConsent, actor: Actor): Record<string, unknown> {
  return {
    signedBy: c.signedBy, method: c.method ?? (c.documentId === undefined ? null : "tablet_signature"),
    documentId: c.documentId ?? null, signerName: c.signerName ?? null, relation: c.relation ?? null,
    witnessName: c.witnessName ?? null, representativeReason: c.representativeReason ?? null, language: c.language ?? null,
    takenBy: actor.id,
  };
}

/** ICU needs the intensivist's GRANTED approval on this admission (or, for the emergency lane, on the patient). */
async function requireIcuApproval(db: Db | Tx, approvalId: string | undefined, subjects: string[]): Promise<string> {
  const ok = await grantedApproval(db, approvalId, "icu", subjects);
  if (ok === null) {
    throw new IpdRefusal("icu_needs_intensivist", undefined, { approvalId: approvalId ?? null, action: "request_approval" });
  }
  return ok.id;
}

/** Starts the instance and re-lays the `requested` clock to the advice expiry (PR #745's helper). */
async function startAdmissionInstance(tx: Tx, admissionId: string, patientId: string, requestedAt: Date, plannedFor?: Date): Promise<string> {
  try {
    const { instanceId } = await startInstance(tx, ADMISSION_WORKFLOW_DEF_KEY, {
      type: "ipd_admission", id: admissionId, patientId, encounterId: admissionId,
    });
    const minutes = requestedBudgetMinutes(requestedAt, plannedFor);
    if (minutes !== 24 * 60) await rescheduleBudget(tx, instanceId, minutes);
    return instanceId;
  } catch (e) {
    throw workflowRefusal(e);
  }
}

async function insertAdmission(tx: Tx, row: typeof ipdAdmissions.$inferInsert): Promise<void> {
  try {
    // A savepoint: a lost race on the one-open-admission index must not poison the caller's transaction.
    await tx.transaction(async (sp) => { await sp.insert(ipdAdmissions).values(row); });
  } catch (e) {
    if (isOpenAdmissionRace(e)) {
      const first = await openAdmissionOf(tx, row.patientId);
      if (first !== undefined) throw alreadyOpen(first);
    }
    throw e;
  }
}

// ═══════════════════════════════════════════ request_admission ═══════════════════════════════════════════

/**
 * The doctor's advice, or the desk on the advising doctor's word (DECIDED: OPD records only an "admission advised"
 * flag and an `admission.requested` event, so the desk raises the request from it, naming the advising doctor). The
 * answer carries no money (decision 0058) — a doctor holds this permission.
 */
export async function requestAdmission(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"request_admission">> {
  const input: Input<"request_admission"> = IPD_INTENTS.request_admission.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT_REQUEST);
  const at = opts.now ?? new Date();
  const plannedFor = input.plannedFor === undefined ? undefined : new Date(input.plannedFor);
  if (plannedFor !== undefined && istDay(plannedFor) < istDay(at)) throw new IpdRefusal("planned_date_past");
  return onceIpd(db, actor, "request_admission", input.idempotencyKey, input, async () => {
    const patientId = await livePatient(db, actor, input.patientId);
    if (input.source === "opd_advice" && input.sourceRef !== undefined) {
      const enc = await getEncounter(db, input.sourceRef);
      if (enc === null || enc.patientId !== patientId) throw new IpdRefusal("state_changed", "Advice is for another patient");
    }
    const first = await openAdmissionOf(db, patientId);
    if (first !== undefined) throw alreadyOpen(first);
    const recent = await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions).where(and(
      eq(ipdAdmissions.patientId, patientId), inArray(ipdAdmissions.state, ENDED_STATES), isNotNull(ipdAdmissions.endedAt),
      gte(ipdAdmissions.endedAt, new Date(at.getTime() - 30 * DAY_MS)),
    )).limit(1);
    const admissionId = newId();
    const expiresAt = new Date((plannedFor ?? at).getTime() + DAY_MS);
    return withTx(db, async (tx) => {
      const instanceId = await startAdmissionInstance(tx, admissionId, patientId, at, plannedFor);
      await insertAdmission(tx, {
        id: admissionId, patientId, workflowInstanceId: instanceId, state: "requested", source: input.source,
        sourceRef: input.sourceRef ?? null, consultantId: input.consultantId, department: input.department ?? null,
        requestedClass: input.requestedClass, isolation: input.isolation, icu: isIcuClass(input.requestedClass),
        placeAs: input.placeAs ?? null, provisionalDiagnosis: input.provisionalDiagnosis, mlc: input.mlc,
        plannedFor: plannedFor ?? null, requestedAt: at, expiresAt, requestedBy: actor.id, updatedAt: at,
      });
      await appendEvent(tx, admissionRequested.make({
        payload: {
          admissionId, patientId, source: input.source, requestedClass: input.requestedClass,
          icu: isIcuClass(input.requestedClass), provenance: provenanceOf(actor),
        },
        actor, correlationId: admissionId, patientId, occurredAt: at,
      }));
      return {
        admissionId, state: "requested" as const, expiresAt: expiresAt.toISOString(), consultantId: input.consultantId,
        // DECIDED (E1.2): the roster exposes no leave-cover lookup by consultant yet; the chosen consultant stands.
        coveringFor: null, readmissionWithin30Days: recent.length > 0,
      };
    });
  }, at);
}

// ═══════════════════════════════════════════ cancel_admission ═══════════════════════════════════════════

/** A request (or a held bed) cancelled; its live hold is released in the same transaction. */
export async function cancelAdmission(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"cancel_admission">> {
  const input: Input<"cancel_admission"> = IPD_INTENTS.cancel_admission.input.parse(raw);
  if (!(await holdsPermission(db, actor, IPD_ADMIT)) && !(await holdsPermission(db, actor, IPD_ADMIT_REQUEST))) {
    throw new IpdError("ipd_forbidden", `this act needs the permission ${IPD_ADMIT}`, { permission: IPD_ADMIT });
  }
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "cancel_admission", input.idempotencyKey, input, async () => {
    const peek = await readAdmission(db, input.admissionId);
    if (peek.state !== "requested" && peek.state !== "reserved") throw new IpdRefusal("admission_wrong_state", undefined, { state: peek.state });
    return withTx(db, async (tx) => {
      // Review #8: the admission (advisory lock, then the row) first, then the beds of its holds.
      const a = await lockAdmission(tx, peek.id);
      if (a.state !== "requested" && a.state !== "reserved") throw new IpdRefusal("state_changed");
      // Review #9: money taken for this admission and still on the patient's account is refunded first (billing's
      // refund route); the cancel never strands a deposit. DECIDED: what is still owed back = min(Σ deposits, advance).
      const paid = await depositPaidPaise(tx, a.id);
      const onAccount = paid > 0 ? Math.min(paid, await advanceOf(tx, a.patientId)) : 0;
      if (onAccount > 0) throw new IpdRefusal("deposit_not_refunded", undefined, { depositPaise: paid, onAccountPaise: onAccount });
      const releasedBedId = await endAdmissionHolds(tx, actor, a.id, at);
      await moveAdmission(tx, actor, a, "cancelled", at, { cancelReason: input.reason, endedAt: at, endedBy: actor.id }, input.note);
      await appendEvent(tx, admissionCancelled.make({
        payload: { admissionId: a.id, reason: input.reason, releasedBedId, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return { admissionId: a.id, state: "cancelled" as const, releasedBedId };
    });
  }, at);
}

// ═══════════════════════════════════════════ admit ═══════════════════════════════════════════

const EXEMPTION_BASIS: Record<string, string> = {
  scheme: "scheme_zero",
  emergency_not_stabilised: "emergency_exempt",
  cashless_no_non_payables: "cashless_non_payables",
};

/** The deposit rule at the moment of admission: a receipt that covers what the plan requires, or a valid exemption. */
async function checkDeposit(db: Db | Tx, a: AdmissionRow, deposit: Input<"admit">["deposit"]): Promise<{ exemption: string | null; approvalId: string | null }> {
  const required = a.depositRequiredPaise ?? 0;
  if ("receiptId" in deposit) {
    const paid = await depositPaidPaise(db, a.id);
    const linked = (await db.select({ id: ipdAdmissionDeposits.id }).from(ipdAdmissionDeposits)
      .where(and(eq(ipdAdmissionDeposits.admissionId, a.id), eq(ipdAdmissionDeposits.receiptId, deposit.receiptId))))[0];
    if (linked === undefined || paid < required) {
      throw new IpdRefusal("deposit_required", undefined, { requiredPaise: required, paidPaise: paid });
    }
    return { exemption: null, approvalId: null };
  }
  if (deposit.exempt === "approved_waiver") {
    const ok = await grantedApproval(db, deposit.approvalId, "deposit_waiver", [a.id]);
    if (ok === null) throw new IpdRefusal("deposit_required", "Waiver not approved", { requiredPaise: required });
    return { exemption: deposit.exempt, approvalId: ok.id };
  }
  const basisOk = EXEMPTION_BASIS[deposit.exempt] === a.depositBasis;
  // A cashless exemption holds only when the class's non-payables deposit is configured at zero.
  if (!basisOk || (deposit.exempt === "cashless_no_non_payables" && required > 0)) {
    throw new IpdRefusal("deposit_required", "Exemption does not apply", { requiredPaise: required, basis: a.depositBasis });
  }
  return { exemption: deposit.exempt, approvalId: null };
}

/**
 * Admits onto a bed: the bed is assigned through the bed intents' placement IN THE SAME TRANSACTION (rules re-checked
 * under the bed lock), the admission moves to `admitted` with its IP number, and the admission is the IP encounter.
 */
export async function admit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"admit">> {
  const input: Input<"admit"> = IPD_INTENTS.admit.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "admit", input.idempotencyKey, input, async () => {
    const a = await readAdmission(db, input.admissionId);
    if (a.state !== "requested" && a.state !== "reserved") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    if (a.expiresAt.getTime() < at.getTime()) throw new IpdRefusal("advice_expired");
    const other = await openAdmissionOf(db, a.patientId, a.id);
    if (other !== undefined) throw alreadyOpen(other);
    if (a.payerKind === null || a.depositRequiredPaise === null) throw new IpdRefusal("plan_missing");
    checkConsent(input.consent);
    const need = needOf(a);
    const ctx = await placementContext(db, actor, a.patientId, at);
    const tariffVersionId = await tariffLockAt(db, at);
    return withNextRuleValidBeds(db, actor, { bedId: input.bedId, patientId: a.patientId, need, at }, () => withTx(db, async (tx) => {
      await assignBedIn(tx, db, actor, { admissionId: a.id, bedId: input.bedId, patientId: a.patientId, need }, at, ctx, { viaAdmit: true });
      const locked = await lockAdmission(tx, a.id);
      // Review #5: the plan, the ICU approval and the deposit are judged on the LOCKED row, not the earlier read.
      if (locked.state !== a.state || locked.requestedClass !== a.requestedClass || locked.isolation !== a.isolation) {
        throw new IpdRefusal("state_changed");
      }
      if (locked.payerKind === null || locked.depositRequiredPaise === null) throw new IpdRefusal("plan_missing");
      const icuApprovalId = locked.icu ? await requireIcuApproval(tx, input.intensivistApprovalId, [locked.id]) : null;
      const dep = await checkDeposit(tx, locked, input.deposit);
      const no = await mintAdmissionNo(tx, at);
      await moveAdmission(tx, actor, locked, "admitted", at, {
        admissionYear: no.year, admissionSerial: no.serial, admissionNo: no.admissionNo, admittedAt: at, admittedBy: actor.id,
        consent: consentRecord(input.consent, actor), consentAt: at, icuApprovalId,
        depositExemption: dep.exemption, depositExemptionApprovalId: dep.approvalId, tariffVersionId,
      });
      await appendEvent(tx, admissionAdmitted.make({
        payload: {
          admissionId: a.id, patientId: a.patientId, bedId: input.bedId, admissionNo: no.admissionNo,
          source: a.source as "direct", provenance: provenanceOf(actor),
        },
        actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
      }));
      return { admissionId: a.id, encounterId: a.id, state: "admitted" as const, bedId: input.bedId, admittedAt: at.toISOString() };
    }));
  }, at);
}

/**
 * E2.1 (#725) — THE TARIFF LOCK: the version in force at the admitted instant, recorded on the admission by every admit
 * path. The running bill prices every day of the stay from it; a revision activated later never reaches this stay. No
 * active tariff → null (care never waits for money); the bill then lists a `tariff_missing` exception per day.
 */
async function tariffLockAt(db: Db, at: Date): Promise<string | null> {
  return (await resolveActiveTariffVersion(db, at))?.versionId ?? null;
}

// ═══════════════════════════════════════════ the emergency lane ═══════════════════════════════════════════

/** What an admission still owes (the emergency lane's "incomplete" list). */
export function incompleteOf(a: AdmissionRow, bandPrinted: boolean): IpdAdmissionIncomplete[] {
  const out: IpdAdmissionIncomplete[] = [];
  if (a.consentAt === null) out.push("consent");
  if (a.payerKind === null) out.push("payer");
  if (!bandPrinted) out.push("band");
  if (a.source === "er" && a.stabilisedAt === null) out.push("stabilised");
  if (a.provisionalDiagnosis === null) out.push("diagnosis");
  return out;
}

/**
 * §4.9 B emergency lane — one tap: patient + bed. The need is the bed's own class (an emergency bay, an ICU bed);
 * no deposit before stabilisation; consent, payer, band and diagnosis catch up. ICU still needs the approval.
 */
export async function emergencyAdmit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"emergency_admit">> {
  const input: Input<"emergency_admit"> = IPD_INTENTS.emergency_admit.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "emergency_admit", input.idempotencyKey, input, async () => {
    const patientId = await livePatient(db, actor, input.patientId);
    const first = await openAdmissionOf(db, patientId);
    if (first !== undefined) throw alreadyOpen(first);
    const bed = await readBedFacts(db, input.bedId);
    const admissionId = input.admissionId ?? newId();
    if (input.admissionId !== undefined && (await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId))).length > 0) {
      throw new IpdRefusal("admission_already_open", undefined, { admissionId });
    }
    // Review #10: the approval names THIS admission (the id the desk asked under), never just the patient.
    const icuApprovalId = bed.icu ? await requireIcuApproval(db, input.intensivistApprovalId, [admissionId]) : null;
    const need: IpdBedNeed = { requestedClass: bed.class, isolation: input.isolation, icu: bed.icu, ...(input.placeAs ? { placeAs: input.placeAs } : {}) };
    const ctx = await placementContext(db, actor, patientId, at);
    const tariffVersionId = await tariffLockAt(db, at);
    return withNextRuleValidBeds(db, actor, { bedId: input.bedId, patientId, need, at }, () => withTx(db, async (tx) => {
      const instanceId = await startAdmissionInstance(tx, admissionId, patientId, at);
      await insertAdmission(tx, {
        id: admissionId, patientId, workflowInstanceId: instanceId, state: "requested", source: "er", consultantId: input.consultantId,
        requestedClass: bed.class, isolation: input.isolation, icu: bed.icu, placeAs: input.placeAs ?? null,
        provisionalDiagnosis: input.provisionalDiagnosis ?? null, mlc: input.mlc, requestedAt: at,
        expiresAt: new Date(at.getTime() + DAY_MS), requestedBy: actor.id, depositRequiredPaise: 0,
        depositBasis: "emergency_exempt", icuApprovalId, updatedAt: at,
      });
      const provenance = provenanceOf(actor);
      await appendEvent(tx, admissionRequested.make({
        payload: { admissionId, patientId, source: "er", requestedClass: bed.class, icu: bed.icu, provenance },
        actor, correlationId: admissionId, patientId, occurredAt: at,
      }));
      await assignBedIn(tx, db, actor, { admissionId, bedId: input.bedId, patientId, need }, at, ctx, { viaAdmit: true });
      const a = await lockAdmission(tx, admissionId);
      const no = await mintAdmissionNo(tx, at);
      await moveAdmission(tx, actor, a, "admitted", at, {
        admissionYear: no.year, admissionSerial: no.serial, admissionNo: no.admissionNo, admittedAt: at, admittedBy: actor.id,
        depositExemption: "emergency_not_stabilised", tariffVersionId,
      });
      await appendEvent(tx, admissionAdmitted.make({
        payload: { admissionId, patientId, bedId: input.bedId, admissionNo: no.admissionNo, source: "er", provenance },
        actor, correlationId: admissionId, patientId, encounterId: admissionId, occurredAt: at,
      }));
      const fresh = await readAdmission(tx, admissionId);
      return {
        admissionId, admissionNo: no.admissionNo, encounterId: admissionId, state: "admitted" as const, bedId: input.bedId,
        admittedAt: at.toISOString(), incomplete: incompleteOf(fresh, false),
      };
    }));
  }, at);
}

// ═══════════════════════════════════════════ downtime back-fill ═══════════════════════════════════════════

/**
 * §4.2 edge — a paper admission entered after downtime: the paper's request and admission times are kept (the bed
 * and its stay start at the paper's admitted time, which is what the bill will count from), the reserved paper serial
 * is unique (refused showing the admission that used it), and the paper consent is recorded with its witness.
 */
export async function backfillDowntime(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"backfill_downtime">> {
  const input: Input<"backfill_downtime"> = IPD_INTENTS.backfill_downtime.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const now = opts.now ?? new Date();
  if (ipdIsInFuture(input.requestedAt, now) || ipdIsInFuture(input.admittedAt, now)) throw new IpdRefusal("time_in_future");
  const requestedAt = new Date(input.requestedAt);
  const admittedAt = new Date(input.admittedAt);
  const serial = input.paperSerial.toUpperCase();
  return onceIpd(db, actor, "backfill_downtime", input.idempotencyKey, input, async () => {
    const used = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.downtimeSerial, serial)))[0];
    if (used !== undefined) {
      throw new IpdRefusal("downtime_serial_used", undefined, { admissionId: used.id, admissionNo: used.admissionNo });
    }
    const patientId = await livePatient(db, actor, input.patientId);
    const first = await openAdmissionOf(db, patientId);
    if (first !== undefined) throw alreadyOpen(first);
    checkConsent(input.consent);
    const icu = isIcuClass(input.requestedClass as IpdBedClass);
    const admissionId = newId();
    // A paper ICU admission's approval is asked before entry; the request names the back-fill's patient (the
    // admission id does not exist until this act mints it). DECIDED (review #10 applies to the live emergency lane).
    const icuApprovalId = icu ? await requireIcuApproval(db, input.intensivistApprovalId, [patientId]) : null;
    const need: IpdBedNeed = { requestedClass: input.requestedClass, isolation: input.isolation, icu, ...(input.placeAs ? { placeAs: input.placeAs } : {}) };
    const ctx = await placementContext(db, actor, patientId, admittedAt);
    const tariffVersionId = await tariffLockAt(db, admittedAt);
    try {
      return await withTx(db, async (tx) => {
        const instanceId = await startAdmissionInstance(tx, admissionId, patientId, requestedAt);
        await insertAdmission(tx, {
          id: admissionId, patientId, workflowInstanceId: instanceId, state: "requested", source: "downtime",
          consultantId: input.consultantId, requestedClass: input.requestedClass, isolation: input.isolation, icu,
          placeAs: input.placeAs ?? null, provisionalDiagnosis: input.provisionalDiagnosis, mlc: input.mlc, requestedAt,
          expiresAt: new Date(requestedAt.getTime() + DAY_MS), requestedBy: actor.id, payerKind: input.payerKind,
          downtimeSerial: serial, paperReceiptNo: input.paperReceiptNo ?? null, icuApprovalId, updatedAt: now,
          // Review #7 (DECIDED): the deposit was settled on paper; the bill desk checks it (a scheme patient owes none).
          depositBasis: "downtime_backfill", depositRequiredPaise: 0,
          depositCheckPending: !SCHEME.has(input.payerKind),
        });
        const provenance = provenanceOf(actor);
        await appendEvent(tx, admissionRequested.make({
          payload: { admissionId, patientId, source: "downtime", requestedClass: input.requestedClass, icu, provenance },
          actor, correlationId: admissionId, patientId, occurredAt: requestedAt,
        }));
        await appendEvent(tx, admissionBackfilled.make({
          payload: { admissionId, paperSerial: serial, provenance },
          actor, correlationId: admissionId, patientId, occurredAt: now,
        }));
        await assignBedIn(tx, db, actor, {
          admissionId, bedId: input.bedId, patientId, need, ...(input.classChange ? { classChange: input.classChange } : {}),
        }, admittedAt, ctx, { viaAdmit: true });
        const a = await lockAdmission(tx, admissionId);
        const no = await mintAdmissionNo(tx, admittedAt);
        await moveAdmission(tx, actor, a, "admitted", now, {
          admissionYear: no.year, admissionSerial: no.serial, admissionNo: no.admissionNo, admittedAt, admittedBy: actor.id,
          consent: consentRecord(input.consent, actor), consentAt: admittedAt, tariffVersionId,
        }, `downtime paper ${serial}`);
        await appendEvent(tx, admissionAdmitted.make({
          payload: { admissionId, patientId, bedId: input.bedId, admissionNo: no.admissionNo, source: "downtime", provenance },
          actor, correlationId: admissionId, patientId, encounterId: admissionId, occurredAt: admittedAt,
        }));
        return {
          admissionId, admissionNo: no.admissionNo, encounterId: admissionId, state: "admitted" as const, bedId: input.bedId,
          admittedAt: admittedAt.toISOString(),
        };
      });
    } catch (e) {
      const c = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
      if (c.code === "23505" && c.constraint === "ipd_admissions_downtime_serial_ux") {
        const other = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.downtimeSerial, serial)))[0];
        throw new IpdRefusal("downtime_serial_used", undefined, { admissionId: other?.id ?? null, admissionNo: other?.admissionNo ?? null });
      }
      throw e;
    }
  }, now);
}

// ═══════════════════════════════════════════ consent and stabilisation ═══════════════════════════════════════════

const CONSENT_STATES = new Set(["requested", "reserved", "admitted", "transferring", "fit_declared"]);

export async function recordConsent(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_consent">> {
  const input: Input<"record_consent"> = IPD_INTENTS.record_consent.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  checkConsent(input.consent);
  return onceIpd(db, actor, "record_consent", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!CONSENT_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    await tx.update(ipdAdmissions).set({ consent: consentRecord(input.consent, actor), consentAt: at, updatedAt: at }).where(eq(ipdAdmissions.id, a.id));
    await appendEvent(tx, admissionConsented.make({
      payload: { admissionId: a.id, signedBy: input.consent.signedBy, method: input.consent.method ?? null, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { admissionId: a.id, consentAt: at.toISOString() };
  }), at);
}

/** The treating team marks an emergency patient stabilised; the deposit may be asked only after this. */
export async function recordStabilised(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_stabilised">> {
  const input: Input<"record_stabilised"> = IPD_INTENTS.record_stabilised.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT_REQUEST);
  const now = opts.now ?? new Date();
  if (ipdIsInFuture(input.stabilisedAt, now)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_stabilised", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (a.source !== "er" || a.state !== "admitted" || a.stabilisedAt !== null) throw new IpdRefusal("admission_wrong_state");
    const stabilisedAt = new Date(input.stabilisedAt);
    await tx.update(ipdAdmissions).set({ stabilisedAt, updatedAt: now }).where(eq(ipdAdmissions.id, a.id));
    await appendEvent(tx, admissionStabilised.make({
      payload: { admissionId: a.id, stabilisedAt: stabilisedAt.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: now,
    }));
    return { admissionId: a.id, stabilisedAt: stabilisedAt.toISOString() };
  }), now);
}

/** The consultant's display name (users.full_name), or the id when the user is unknown. */
export async function userNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}
