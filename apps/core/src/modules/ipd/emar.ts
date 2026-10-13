import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  IPD_CLOCK_SKEW_MS, IPD_EMAR_GIVE_STALE_MS, IPD_EMAR_LABEL_PREFIX, IPD_EMAR_SECOND_CHECK_MINUTES, IPD_INTENTS, ipdIsInFuture, newId,
} from "@hmis/contracts";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { verifyPinByUsername } from "../../kernel/auth/identity";
import { clearThrottle, recordThrottleFailure, throttleRetryAt } from "../../kernel/auth/throttle";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  ipdBands, ipdEmarActs, ipdEmarAllergyFlags, ipdEmarDoses, ipdEmarInfusionEvents, ipdEmarIssues, ipdEmarLabels, ipdEmarNarcoticRegister,
  ipdEmarReturns, ipdEmarSecondChecks, ipdEmarVerbalOrders, ipdEmarVerifications, ipdOrders, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { THERAPEUTIC_DUPLICATE_CLASSES, interactionRulesPresent, listInteractionsAmong, resolveDrugTexts, resolveMedicines } from "../formulary";
import { MaterialsError, fefoPick, findStoreByCode, postMovements } from "../materials";
import { allergyRecorded, getPatientSummaries, listAllergies } from "../patients";
import { OPD_PHARMACY_STORE_CODE, recordIncident } from "../pharmacy";
import { matchAllergiesSaltAware } from "../opd";
import { holdsPermission, lockAdmission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { admissionPlace } from "./admission-place";
import { checkPrinter } from "./bands";
import { ageInYears } from "./bed-rules";
import { IPD_SYSTEM_ACTOR } from "./beds";
import { horizonOf, scheduleDosesIn } from "./emar-doses";
import { emarDrugsOf } from "./emar-drug";
import {
  allergyFlagRaised, allergyFlagResolved, doseCorrected, doseGiven, doseHeld, doseMissed, doseRefused, dosesReoffered, infusionRecorded,
  medIssued, medReturned, narcoticWasted, orderVerified, secondCheckPassed, verbalOrderSigned,
} from "./emar-events";
import { doseWordsOf, giveTiming, prnState, windowMinutesFor } from "./emar-rules";
import { IpdRefusal } from "./errors";
import { IPD_NURSING_STATES, activeHolders, dutyDoctorsFor, nursingFallback, whereWords } from "./nursing";
import { CHILD_WEIGHT_AGE_YEARS, markIpdOrderIssuedIn } from "./orders";
import { IPD_EMAR_GIVE, IPD_EMAR_ISSUE, IPD_EMAR_VERIFY, IPD_ORDER_PLACE } from "./permissions";
import { onTeam, treatingTeamOf } from "./rounds-team";
import type { Actor, IpdEmarFinding, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";
import type { AdmissionRow } from "./admission-core";
import type { EmarDrug } from "./emar-drug";
import type { IpdOrderRow } from "./orders";

/**
 * E4.3 (#735) — THE eMAR's ACTS (spec SPEC-ipd-core §4.6; §0B "Offline"; §4.10 edges 6–9). Each is one intent: parse the
 * contract → re-check the permission → run under the idempotency key → lock (the admission's advisory lock, then the order,
 * then the dose slot) → re-check state → write + event. Refusals are `IpdRefusal` with the contract's rule and fix.
 *
 * PHARMACIST: `verifyOrder` (allergy — salt-aware, the OPD matcher; interaction — the formulary's adopted pairs, or "no
 * interaction data"; dose; duplicate therapy), `issueMed` (stock out through the materials ledger, FEFO; a label per unit
 * or strip; `markIpdOrderIssuedIn`), `returnMed` (stock back, the units credited), `resolveAllergyFlag`.
 *
 * NURSE: `administerDose` — NO GIVE WITHOUT BOTH SCANS: the wristband (the band's serial, `ipd_bands`) or a reasoned
 * override (counted per nurse and ward), and the drug's label (always). High-alert: a second nurse's PIN proof (another
 * person holding a nursing role, single use, 5 minutes). LASA: the tall-man name confirmed. PRN: minimum interval and the
 * 24-hour cap. Weight: a weight-based dose and every child's. A give stamped more than 2 minutes before the server's clock
 * is refused (`give_expired`): doses never queue offline. `holdDose` (NPO / off the ward re-offer on return),
 * `refuseDose` (the duty doctor told), `missDose`, `reofferHeldDoses`, `markDoseInError` (never a delete),
 * `recordInfusionEvent`, `recordNarcoticWastage` (witnessed), `secondCheck`. DOCTOR: `signVerbalOrder`.
 *
 * TWO NURSES, ONE DOSE: every outcome locks the admission (advisory) and the slot row FOR UPDATE and re-reads its status,
 * so exactly one records; `(dose_id, slot_seq)` unique is the database's backstop.
 */
type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
export type EmarOpts = { now?: Date };
type DoseRow = typeof ipdEmarDoses.$inferSelect;

/** The nursing roles a second nurse must hold (§4.6 "a second nurse's PIN"). */
export const IPD_EMAR_NURSE_ROLES = ["ward_nurse", "nursing_supervisor", "nursing_superintendent"];

async function lockOrderIn(tx: Tx, orderId: string): Promise<{ o: IpdOrderRow; a: AdmissionRow }> {
  const first = (await tx.select().from(ipdOrders).where(eq(ipdOrders.id, orderId)))[0];
  if (first === undefined || first.kind !== "drug") throw new IpdRefusal("order_not_found");
  const a = await lockAdmission(tx, first.admissionId);
  const o = (await tx.select().from(ipdOrders).where(eq(ipdOrders.id, orderId)).for("update"))[0]!;
  return { o, a };
}

const inNursing = (a: AdmissionRow): boolean => (IPD_NURSING_STATES as readonly string[]).includes(a.state);

function requireGivable(o: IpdOrderRow, a: AdmissionRow): void {
  if (o.status !== "active" || !inNursing(a)) throw new IpdRefusal("order_not_active", undefined, { status: o.status, state: a.state });
  if (o.verification !== "verified") throw new IpdRefusal("order_not_verified", undefined, { verification: o.verification });
}

async function slotIn(tx: Tx, orderId: string, dueAt: Date): Promise<DoseRow> {
  const d = (await tx.select().from(ipdEmarDoses).where(and(eq(ipdEmarDoses.orderId, orderId), eq(ipdEmarDoses.dueAt, dueAt))).for("update"))[0];
  if (d === undefined) throw new IpdRefusal("dose_not_found", undefined, { doseDueAt: dueAt.toISOString() });
  return d;
}

/** A slot that already has its outcome (or is held, not yet re-offered) takes no other. */
function requireOpen(d: DoseRow): void {
  if (d.status === "scheduled") return;
  throw new IpdRefusal("dose_already_recorded", undefined, { status: d.status, actId: d.lastActId });
}

async function wardOf(tx: Tx, admissionId: string): Promise<string | null> {
  return (await admissionPlace(tx, admissionId))?.wardId ?? null;
}

// ═══════════════════════════════════════ the pharmacist ═══════════════════════════════════════

/** Every finding the verify checks raise for one order (the queue shows them; the act re-runs them under lock). */
export async function verifyFindingsOf(db: Db | Tx, o: IpdOrderRow, drug: EmarDrug | undefined, at: Date): Promise<{ findings: IpdEmarFinding[]; interactionDataPresent: boolean }> {
  const findings: IpdEmarFinding[] = [];
  // Allergy — the OPD prescription's salt-aware matcher against the patient's active allergies.
  const active = (await listAllergies(db as Db, o.patientId)).filter((x) => x.status === "active");
  if (active.length > 0 && o.medicineId !== null) {
    const resolution = (await resolveMedicines(db as Db, [o.medicineId])).get(o.medicineId) ?? null;
    const texts = await resolveDrugTexts(db as Db, active.map((x) => x.substance));
    const hits = matchAllergiesSaltAware([{ lineIndex: 0, drug: o.medicineName ?? "", resolution }], active.map((x) => ({
      substance: x.substance, resolution: texts.get(x.substance) ?? null, allergenClass: x.allergenClass,
    })));
    for (const s of [...new Set(hits.map((h) => h.substance))]) {
      findings.push({ check: "allergy", severity: "stop", words: `Allergy: ${s}${o.allergyOverrideReason !== null ? ` — prescriber overrode: ${o.allergyOverrideReason}` : ""}` });
    }
  }
  // Interaction and duplicate therapy — against the admission's other active drug orders.
  const others = (await (db as Db).select().from(ipdOrders).where(and(
    eq(ipdOrders.admissionId, o.admissionId), eq(ipdOrders.status, "active"), eq(ipdOrders.kind, "drug"), ne(ipdOrders.id, o.id),
  ))).filter((x) => x.verification !== "rejected");
  const otherDrugs = await emarDrugsOf(db, others);
  const interactionDataPresent = await interactionRulesPresent(db as Db);
  if (drug !== undefined && interactionDataPresent && others.length > 0) {
    const mine = new Set(drug.saltIds);
    const pairs = await listInteractionsAmong(db as Db, [...drug.saltIds, ...[...otherDrugs.values()].flatMap((d) => d.saltIds)]);
    for (const other of others) {
      const od = otherDrugs.get(other.id);
      if (od === undefined) continue;
      const theirs = new Set(od.saltIds);
      for (const p of pairs) {
        const hit = (mine.has(p.saltAId) && theirs.has(p.saltBId)) || (mine.has(p.saltBId) && theirs.has(p.saltAId));
        if (!hit || (p.routeScope === "systemic_only" && (o.route === "topical" || other.route === "topical"))) continue;
        findings.push({ check: "interaction", severity: p.severity === "severe" ? "stop" : "warn", words: `Interaction with ${other.medicineName ?? "another order"} (${p.severity}): ${p.note}` });
      }
    }
  }
  if (drug !== undefined) {
    for (const other of others) {
      const od = otherDrugs.get(other.id);
      if (od === undefined) continue;
      const same = drug.moieties.filter((m) => od.moieties.map((x) => x.toLowerCase()).includes(m.toLowerCase()));
      if (same.length > 0) { findings.push({ check: "duplicate", severity: "warn", words: `Same drug (${same.join(", ")}) as ${other.medicineName ?? "another order"}` }); continue; }
      const cls = drug.classes.find((c) => c !== null && (THERAPEUTIC_DUPLICATE_CLASSES as readonly string[]).includes(c) && od.classes.includes(c));
      if (cls != null) findings.push({ check: "duplicate", severity: "warn", words: `Same class (${cls}) as ${other.medicineName ?? "another order"}` });
    }
  }
  // Dose — the weight the order was written against; a child (< 16) or a per-kg dose without one stops.
  const patient = (await getPatientSummaries(db as Db, IPD_SYSTEM_ACTOR, [o.patientId]))[0];
  const age = patient?.dob == null ? null : ageInYears(patient.dob, at);
  const child = age !== null && age < CHILD_WEIGHT_AGE_YEARS;
  if ((o.weightBasedPerKg || child) && o.weightKg === null) {
    findings.push({ check: "dose", severity: "stop", words: "No weight recorded for a weight-based dose" });
  } else if (o.weightBasedPerKg && o.weightKg !== null && o.doseValue !== null) {
    findings.push({ check: "dose", severity: "info", words: `${String(o.doseValue)} ${o.doseUnit ?? ""}/kg × ${String(o.weightKg)} kg = ${String(Math.round(o.doseValue * o.weightKg * 100) / 100)} ${o.doseUnit ?? ""}` });
  }
  return { findings, interactionDataPresent };
}

export async function verifyOrder(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"verify_order">> {
  const input: Input<"verify_order"> = IPD_INTENTS.verify_order.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_VERIFY);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "verify_order", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    if (o.status !== "active" || !inNursing(a)) throw new IpdRefusal("order_not_active", undefined, { status: o.status });
    if (o.verification !== "pending" && o.verification !== "query") throw new IpdRefusal("order_not_pending", undefined, { verification: o.verification });
    const drug = (await emarDrugsOf(tx, [o])).get(o.id);
    const { findings } = await verifyFindingsOf(tx, o, drug, at);
    if (input.decision === "verified") {
      if (!(input.checks.allergy && input.checks.interaction && input.checks.dose && input.checks.duplicate)) throw new IpdRefusal("checks_incomplete");
      const needsNote = findings.some((f) => f.severity !== "info") || o.allergyOverrideReason !== null;
      if (needsNote && input.note === undefined) throw new IpdRefusal("verify_note_required", undefined, { findings });
    } else if (input.note === undefined) {
      throw new IpdRefusal("verify_note_required");
    }
    await tx.insert(ipdEmarVerifications).values({
      id: newId(), orderId: o.id, decision: input.decision, checks: input.checks, findings, note: input.note ?? null, verifiedBy: actor.id, verifiedAt: at,
    });
    await tx.update(ipdOrders).set({ verification: input.decision }).where(eq(ipdOrders.id, o.id));
    let dosesScheduled = 0;
    if (input.decision === "verified") {
      const w = windowMinutesFor(drug?.timeCritical ?? o.antibiotic) * 60_000;
      dosesScheduled = await scheduleDosesIn(tx, o, new Date(at.getTime() - w), horizonOf(at), at);
    } else {
      // The prescriber hears of a rejection or a query at once (no drug or patient name in the notice).
      const where = await whereWords(tx, a);
      await raiseNoticeIn(tx, {
        userId: o.orderedBy, kind: "ipd.emar.order_query", title: input.decision === "rejected" ? "Pharmacy rejected an order" : "Pharmacy query on an order",
        body: [...where.words, "Open rounds"].join(" · "), refType: "ipd_order", refId: o.id, sourceKey: `ipd.emar.verify:${o.id}:${at.toISOString()}`, at,
      });
    }
    await appendEvent(tx, orderVerified.make({
      payload: { orderId: o.id, admissionId: a.id, decision: input.decision, findings: findings.length, dosesScheduled, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { orderId: o.id, status: input.decision, dosesScheduled };
  }), at);
}

export async function issueMed(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"issue_med">> {
  const input: Input<"issue_med"> = IPD_INTENTS.issue_med.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  const at = opts.now ?? new Date();
  await checkPrinter(db, input.labelPrinterId, at);
  return onceIpd(db, actor, "issue_med", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    if (o.status !== "active" || !inNursing(a)) throw new IpdRefusal("order_not_active", undefined, { status: o.status });
    if (o.verification !== "verified") throw new IpdRefusal("order_not_verified");
    const issueId = newId();
    const drug = (await emarDrugsOf(tx, [o])).get(o.id);
    let batches: { batchId: string; qty: number; ledgerEntryId: string }[] = [];
    let itemId: string | null = null;
    let storeId: string | null = null;
    if (input.ownMedicine) {
      if (input.ownBatch === undefined) throw new IpdRefusal("own_medicine_unchecked");
    } else {
      const shelf = drug?.shelf ?? null;
      const store = await findStoreByCode(tx, OPD_PHARMACY_STORE_CODE);
      if (shelf === null || store === undefined) throw new IpdRefusal("medicine_not_stocked", undefined, { medicineId: o.medicineId });
      itemId = shelf.item.id;
      storeId = store.id;
      const picks = input.batchId !== undefined ? [{ batchId: input.batchId, qty: input.units }] : await fefoPick(tx, store.id, shelf.item.id, input.units, at);
      if (picks.reduce((s, p) => s + p.qty, 0) < input.units) throw new IpdRefusal("stock_short", undefined, { asked: input.units, available: picks.reduce((s, p) => s + p.qty, 0) });
      try {
        const moved = await postMovements(tx, actor, picks.map((p) => ({
          resourceId: store.id, batchId: p.batchId, qtyDelta: -p.qty, reason: "consume" as const, refType: "ipd_emar_issue", refId: issueId,
          patientId: o.patientId, encounterId: a.id, occurredAt: at,
        })));
        batches = picks.map((p, i) => ({ batchId: p.batchId, qty: p.qty, ledgerEntryId: moved[i]!.ledgerEntryId }));
      } catch (e) {
        if (e instanceof MaterialsError) throw new IpdRefusal("stock_short", undefined, { reason: e.code });
        throw e;
      }
    }
    const stripSize = input.stripSize ?? 1;
    await tx.insert(ipdEmarIssues).values({
      id: issueId, orderId: o.id, admissionId: a.id, patientId: o.patientId, itemId, storeId, batches, units: input.units, stripSize,
      ownMedicine: input.ownMedicine, ownBatchNo: input.ownBatch?.batchNo ?? null, ownExpiry: input.ownBatch?.expiry ?? null,
      printerId: input.labelPrinterId ?? null, issuedBy: actor.id, issuedAt: at,
    });
    const count = Math.ceil(input.units / stripSize);
    const labels = Array.from({ length: count }, (_, i) => {
      const id = newId();
      return {
        id, issueId, orderId: o.id, admissionId: a.id, code: `${IPD_EMAR_LABEL_PREFIX}${id}`, seq: i + 1,
        units: i === count - 1 ? input.units - stripSize * (count - 1) : stripSize, createdAt: at,
      };
    });
    await tx.insert(ipdEmarLabels).values(labels);
    const stamp = await markIpdOrderIssuedIn(tx, o.id, at);
    if (stamp === "not_active" || stamp === "not_found") throw new IpdRefusal("order_not_active", undefined, { stamp });
    if (drug?.narcotic === true) {
      await tx.insert(ipdEmarNarcoticRegister).values({
        id: newId(), orderId: o.id, admissionId: a.id, kind: "received", qty: input.units, unit: drug.shelf?.item.baseUom ?? "unit", issueId, actorId: actor.id, at,
      });
    }
    await appendEvent(tx, medIssued.make({
      payload: { issueId, orderId: o.id, admissionId: a.id, units: input.units, labels: count, ownMedicine: input.ownMedicine, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { issueId, units: input.units, labelIds: labels.map((l) => l.id) };
  }), at);
}

/**
 * Unused units back to the pharmacy. Stock returns to the batches it left (newest-taken first); the units are CREDITED —
 * the patient owes for issued minus returned (own medicine: never charged, 0 credited). A return on a stopped order
 * clears `return_owed` (the pharmacist counted what came back). DECIDED: no running-bill line exists for a ward issue yet
 * (the charges lane's seam, MAP.md), so the credit is recorded in units on the issue; billing composes from them.
 */
export async function returnMed(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"return_med">> {
  const input: Input<"return_med"> = IPD_INTENTS.return_med.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_ISSUE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "return_med", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const first = (await tx.select().from(ipdEmarIssues).where(eq(ipdEmarIssues.id, input.issueId)))[0];
    if (first === undefined) throw new IpdRefusal("issue_not_found");
    const { o, a } = await lockOrderIn(tx, first.orderId);
    const back = (await tx.select({ n: sql<number>`coalesce(sum(${ipdEmarReturns.units}), 0)` }).from(ipdEmarReturns).where(eq(ipdEmarReturns.issueId, first.id)))[0]?.n ?? 0;
    if (Number(back) + input.units > first.units) throw new IpdRefusal("return_exceeds_issue", undefined, { issued: first.units, returned: Number(back) });
    const returnId = newId();
    let batches: { batchId: string; qty: number; ledgerEntryId: string }[] = [];
    if (!first.ownMedicine && first.storeId !== null) {
      let left = input.units;
      const plan: { batchId: string; qty: number }[] = [];
      for (const b of [...first.batches].reverse()) {
        if (left <= 0) break;
        const q = Math.min(b.qty, left);
        plan.push({ batchId: b.batchId, qty: q });
        left -= q;
      }
      const storeId = first.storeId;
      const moved = await postMovements(tx, actor, plan.map((p) => ({
        resourceId: storeId, batchId: p.batchId, qtyDelta: p.qty, reason: "return" as const, refType: "ipd_emar_return", refId: returnId,
        patientId: o.patientId, encounterId: a.id, occurredAt: at,
      })));
      batches = plan.map((p, i) => ({ ...p, ledgerEntryId: moved[i]!.ledgerEntryId }));
    }
    const creditedUnits = first.ownMedicine ? 0 : input.units;
    await tx.insert(ipdEmarReturns).values({
      id: returnId, issueId: first.id, orderId: o.id, admissionId: a.id, units: input.units, creditedUnits, reason: input.reason, batches,
      returnedBy: actor.id, returnedAt: at,
    });
    if (o.status !== "active" && o.returnOwed) await tx.update(ipdOrders).set({ returnOwed: false }).where(eq(ipdOrders.id, o.id));
    const drug = (await emarDrugsOf(tx, [o])).get(o.id);
    if (drug?.narcotic === true) {
      await tx.insert(ipdEmarNarcoticRegister).values({
        id: newId(), orderId: o.id, admissionId: a.id, kind: "returned", qty: input.units, unit: drug.shelf?.item.baseUom ?? "unit", issueId: first.id, actorId: actor.id, at,
      });
    }
    await appendEvent(tx, medReturned.make({
      payload: { returnId, issueId: first.id, orderId: o.id, admissionId: a.id, units: input.units, creditedUnits, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { returnId, units: input.units, creditedUnits };
  }), at);
}

export async function resolveAllergyFlag(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"resolve_allergy_flag">> {
  const input: Input<"resolve_allergy_flag"> = IPD_INTENTS.resolve_allergy_flag.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_VERIFY);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "resolve_allergy_flag", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const f = (await tx.select().from(ipdEmarAllergyFlags).where(eq(ipdEmarAllergyFlags.id, input.flagId)).for("update"))[0];
    if (f === undefined) throw new IpdRefusal("allergy_flag_not_found");
    if (f.resolvedAt !== null) throw new IpdRefusal("allergy_flag_resolved");
    await tx.update(ipdEmarAllergyFlags).set({ resolvedAt: at, resolvedBy: actor.id, resolutionNote: input.note }).where(eq(ipdEmarAllergyFlags.id, f.id));
    await appendEvent(tx, allergyFlagResolved.make({
      payload: { flagId: f.id, orderId: f.orderId, admissionId: f.admissionId, provenance: provenanceOf(actor) },
      actor, correlationId: f.admissionId, patientId: f.patientId, encounterId: f.admissionId, occurredAt: at,
    }));
    return { flagId: f.id, resolvedAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════ the second nurse ═══════════════════════════════════════

/**
 * The second nurse types THEIR username and PIN at the first nurse's phone (the pharmacy's witness pattern): throttled on
 * the shared-terminal PIN counter; never the same person; the checker must hold a nursing role. The proof is a row id,
 * spent by one act within 5 minutes, bound to the nurse who asked.
 */
export async function secondCheck(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"second_check">> {
  const input: Input<"second_check"> = IPD_INTENTS.second_check.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  const username = input.username.trim();
  if (await throttleRetryAt(db, "pin", username, at) !== null) throw new IpdRefusal("second_nurse_not_confirmed", undefined, { throttled: true });
  const verified = await verifyPinByUsername(db, username, input.pin);
  if (verified === null) {
    await recordThrottleFailure(db, "pin", username, at);
    throw new IpdRefusal("second_nurse_not_confirmed");
  }
  await clearThrottle(db, "pin", username);
  if (verified.userId === actor.id) throw new IpdRefusal("second_nurse_same_person");
  return withTx(db, async (tx) => {
    if (!(await actorHoldsAnyRole(tx, verified.userId, IPD_EMAR_NURSE_ROLES))) throw new IpdRefusal("second_nurse_not_nurse");
    const user = (await tx.select({ name: users.fullName }).from(users).where(eq(users.id, verified.userId)))[0];
    const id = newId();
    const expiresAt = new Date(at.getTime() + IPD_EMAR_SECOND_CHECK_MINUTES * 60_000);
    await tx.insert(ipdEmarSecondChecks).values({ id, checkerId: verified.userId, forUserId: actor.id, purpose: input.purpose, createdAt: at, expiresAt });
    await appendEvent(tx, secondCheckPassed.make({ payload: { checkId: id, purpose: input.purpose, provenance: provenanceOf(actor) }, actor, occurredAt: at }));
    return { pinProof: id, userId: verified.userId, name: user?.name ?? "", expiresAt: expiresAt.toISOString() };
  });
}

/** Spends a second-check proof inside the act's transaction: right person, not self, unexpired, unused. */
async function spendSecondCheck(tx: Tx, actor: Actor, proof: { userId: string; pinProof: string } | undefined, at: Date): Promise<string> {
  if (proof === undefined) throw new IpdRefusal("second_nurse_required");
  if (proof.userId === actor.id) throw new IpdRefusal("second_nurse_same_person");
  const c = (await tx.select().from(ipdEmarSecondChecks).where(eq(ipdEmarSecondChecks.id, proof.pinProof)).for("update"))[0];
  if (c === undefined || c.checkerId !== proof.userId || c.forUserId !== actor.id || c.usedAt !== null || c.expiresAt.getTime() < at.getTime()) {
    throw new IpdRefusal("second_nurse_required", undefined, { proof: "invalid_or_spent" });
  }
  await tx.update(ipdEmarSecondChecks).set({ usedAt: at }).where(eq(ipdEmarSecondChecks.id, c.id));
  return c.checkerId;
}

// ═══════════════════════════════════════ the bedside acts ═══════════════════════════════════════

/** The band a scan read, if live: `{ admissionId }` or null. */
export async function bandOf(db: Db | Tx, code: string): Promise<{ admissionId: string; serial: string } | null> {
  const b = (await (db as Db).select({ admissionId: ipdBands.admissionId, serial: ipdBands.serial }).from(ipdBands)
    .where(and(eq(ipdBands.serial, code.trim()), eq(ipdBands.status, "printed"))))[0];
  return b ?? null;
}

/** The label a scan read: `EML-<id>`. */
export async function labelOf(db: Db | Tx, code: string): Promise<typeof ipdEmarLabels.$inferSelect | null> {
  const c = code.trim();
  if (!c.toUpperCase().startsWith(IPD_EMAR_LABEL_PREFIX)) return null;
  return (await (db as Db).select().from(ipdEmarLabels).where(eq(ipdEmarLabels.code, `${IPD_EMAR_LABEL_PREFIX}${c.slice(IPD_EMAR_LABEL_PREFIX.length)}`)))[0] ?? null;
}

/** The instants of the order's GIVEN doses that stand (a given later marked entered-in-error does not count). */
export async function givenTimesOf(db: Db | Tx, orderIds: readonly string[]): Promise<Map<string, Date[]>> {
  const out = new Map<string, Date[]>();
  if (orderIds.length === 0) return out;
  const acts = await (db as Db).select({ id: ipdEmarActs.id, orderId: ipdEmarActs.orderId, at: ipdEmarActs.at, kind: ipdEmarActs.kind, corrects: ipdEmarActs.correctsActId })
    .from(ipdEmarActs).where(and(inArray(ipdEmarActs.orderId, [...orderIds]), inArray(ipdEmarActs.kind, ["given", "entered_in_error"])));
  const voided = new Set(acts.filter((x) => x.kind === "entered_in_error").map((x) => x.corrects));
  for (const x of acts) {
    if (x.kind !== "given" || voided.has(x.id)) continue;
    out.set(x.orderId, [...(out.get(x.orderId) ?? []), x.at]);
  }
  return out;
}

export async function administerDose(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"administer_dose">> {
  const input: Input<"administer_dose"> = IPD_INTENTS.administer_dose.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  const givenAt = new Date(input.givenAt);
  if (ipdIsInFuture(input.givenAt, at)) throw new IpdRefusal("time_in_future");
  // §0B: doses never queue. A give stamped long before the server's clock sat somewhere (a queue, an interrupted screen).
  if (givenAt.getTime() < at.getTime() - IPD_EMAR_GIVE_STALE_MS) throw new IpdRefusal("give_expired", undefined, { givenAt: input.givenAt });
  return onceIpd(db, actor, "administer_dose", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    requireGivable(o, a);
    const flag = (await tx.select({ id: ipdEmarAllergyFlags.id }).from(ipdEmarAllergyFlags)
      .where(and(eq(ipdEmarAllergyFlags.orderId, o.id), isNull(ipdEmarAllergyFlags.resolvedAt))))[0];
    if (flag !== undefined) throw new IpdRefusal("allergy_conflict", undefined, { flagId: flag.id });
    // 1. The patient: the band's serial, or a reasoned override (counted per nurse and ward).
    let overrideCounted = false;
    if (input.patientCheck.kind === "scan") {
      const band = await bandOf(tx, input.patientCheck.wristbandCode);
      if (band === null || band.admissionId !== a.id) throw new IpdRefusal("wrong_patient_scanned", undefined, { scannedAdmissionId: band?.admissionId ?? null });
    } else {
      overrideCounted = true;
    }
    // 2. The drug: this order's own label (always scanned).
    const label = await labelOf(tx, input.labelCode);
    if (label === null) throw new IpdRefusal("wrong_drug_scanned");
    if (label.admissionId !== a.id) throw new IpdRefusal("wrong_patient_scanned", undefined, { labelAdmissionId: label.admissionId });
    if (label.orderId !== o.id) throw new IpdRefusal("wrong_drug_scanned", undefined, { labelOrderId: label.orderId });
    // 3. High-alert, LASA, weight.
    const drug = (await emarDrugsOf(tx, [o])).get(o.id);
    const highAlert = drug?.highAlert === true;
    const secondNurseId = highAlert ? await spendSecondCheck(tx, actor, input.secondNurse, at) : null;
    if (drug?.lasa === true && input.lasaConfirmed !== true) throw new IpdRefusal("lasa_confirm_required", undefined, { tallMan: drug.tallMan });
    const patient = (await getPatientSummaries(db, IPD_SYSTEM_ACTOR, [o.patientId]))[0];
    const age = patient?.dob == null ? null : ageInYears(patient.dob, givenAt);
    const child = age !== null && age < CHILD_WEIGHT_AGE_YEARS;
    if ((o.weightBasedPerKg || child) && o.weightKg === null && input.weightKg === undefined) throw new IpdRefusal("weight_required", undefined, { child });
    // 4. The slot: PRN makes its own inside the interval and the 24-hour cap; a scheduled dose must be open.
    let slot: DoseRow;
    let late = false;
    if (o.prn !== null) {
      if (o.startAt !== null && givenAt < new Date(o.startAt.getTime() - IPD_CLOCK_SKEW_MS)) throw new IpdRefusal("outside_due_window");
      if (o.stopAt !== null && givenAt > o.stopAt) throw new IpdRefusal("outside_due_window");
      const state = prnState((await givenTimesOf(tx, [o.id])).get(o.id) ?? [], o.prn, givenAt);
      if (state.capped) throw new IpdRefusal("prn_daily_max_reached", undefined, { nextAt: state.nextAt?.toISOString() ?? null, in24h: state.in24h });
      if (state.nextAt !== null) throw new IpdRefusal("prn_interval_not_met", undefined, { nextAt: state.nextAt.toISOString() });
      const dueAt = new Date(Math.floor(givenAt.getTime() / 60_000) * 60_000);
      await tx.insert(ipdEmarDoses).values({
        id: newId(), orderId: o.id, admissionId: a.id, patientId: o.patientId, dueAt, windowMinutes: windowMinutesFor(drug?.timeCritical ?? false),
        prn: true, status: "scheduled", createdAt: at,
      }).onConflictDoNothing();
      slot = await slotIn(tx, o.id, dueAt);
      requireOpen(slot);
    } else {
      slot = await slotIn(tx, o.id, new Date(input.doseDueAt));
      if (slot.status !== "scheduled" && slot.status !== "missed") requireOpen(slot);
      const timing = giveTiming(slot, givenAt);
      if (timing === "early" || timing === "closed") throw new IpdRefusal("outside_due_window", undefined, { timing, dueAt: slot.dueAt.toISOString() });
      late = timing === "late" || slot.status === "missed";
      if (late && input.lateReason === undefined) throw new IpdRefusal("late_reason_required", undefined, { dueAt: slot.dueAt.toISOString() });
    }
    const administrationId = newId();
    const wardId = await wardOf(tx, a.id);
    const pc = input.patientCheck;
    await tx.insert(ipdEmarActs).values({
      id: administrationId, doseId: slot.id, orderId: o.id, admissionId: a.id, patientId: o.patientId, kind: "given", slotSeq: slot.slotSeq + 1,
      at: givenAt, recordedAt: at, actorId: actor.id, provenance: provenanceOf(actor), reason: late ? input.lateReason ?? null : null,
      note: pc.kind === "override" ? pc.note : null, patientCheck: pc.kind, overrideReason: pc.kind === "override" ? pc.overrideReason : null,
      wristbandCode: pc.kind === "scan" ? pc.wristbandCode : null, labelId: label.id, secondNurseId, weightKg: input.weightKg ?? null, late,
      lasaConfirmed: input.lasaConfirmed === true, wardId,
    });
    await tx.update(ipdEmarDoses).set({ status: "given", slotSeq: slot.slotSeq + 1, lastActId: administrationId }).where(eq(ipdEmarDoses.id, slot.id));
    if (drug?.narcotic === true) {
      await tx.insert(ipdEmarNarcoticRegister).values({
        id: newId(), orderId: o.id, admissionId: a.id, kind: "given", qty: o.doseValue ?? 0, unit: o.doseUnit ?? "unit", actId: administrationId, actorId: actor.id, at: givenAt,
      });
    }
    await appendEvent(tx, doseGiven.make({
      payload: {
        administrationId, doseId: slot.id, orderId: o.id, admissionId: a.id, wardId,
        patientCheck: pc.kind === "scan" ? { kind: "scan" } : { kind: "override", overrideReason: pc.overrideReason },
        labelCode: label.code, givenAt: givenAt.toISOString(), late, highAlert, secondNurse: secondNurseId !== null, prn: o.prn !== null,
        provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: givenAt,
    }));
    return { administrationId, givenAt: givenAt.toISOString(), late, overrideCounted };
  }), at);
}

/** Hold, refuse and miss share the slot rules: a scheduled (or re-offered) dose takes the outcome; anything else is refused. */
async function recordOutcome(
  tx: Tx, actor: Actor, o: IpdOrderRow, a: AdmissionRow, dueAt: Date, kind: "held" | "refused" | "missed",
  reason: string, note: string | null, at: Date, extra: Partial<typeof ipdEmarDoses.$inferInsert> = {},
): Promise<{ actId: string; slot: DoseRow }> {
  const slot = await slotIn(tx, o.id, dueAt);
  requireOpen(slot);
  const actId = newId();
  await tx.insert(ipdEmarActs).values({
    id: actId, doseId: slot.id, orderId: o.id, admissionId: a.id, patientId: o.patientId, kind, slotSeq: slot.slotSeq + 1, at, recordedAt: at,
    actorId: actor.id, provenance: provenanceOf(actor), reason, note, wardId: await wardOf(tx, a.id),
  });
  await tx.update(ipdEmarDoses).set({ status: kind, slotSeq: slot.slotSeq + 1, lastActId: actId, reofferedAt: null, ...extra }).where(eq(ipdEmarDoses.id, slot.id));
  return { actId, slot };
}

export async function holdDose(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"hold_dose">> {
  const input: Input<"hold_dose"> = IPD_INTENTS.hold_dose.input.parse(raw);
  if (!(await holdsPermission(db, actor, IPD_EMAR_GIVE))) await requireIpdPermission(db, actor, IPD_ORDER_PLACE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "hold_dose", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    if (o.status !== "active" || !inNursing(a)) throw new IpdRefusal("order_not_active");
    const reoffer = input.reason === "npo" || input.reason === "off_ward";
    const { actId, slot } = await recordOutcome(tx, actor, o, a, new Date(input.doseDueAt), "held", input.reason, input.note ?? null, at, { reoffer });
    await appendEvent(tx, doseHeld.make({
      payload: { holdId: actId, doseId: slot.id, orderId: o.id, admissionId: a.id, reason: input.reason, reofferOnReturn: reoffer, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { holdId: actId, reofferOnReturn: reoffer };
  }), at);
}

export async function refuseDose(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"refuse_dose">> {
  const input: Input<"refuse_dose"> = IPD_INTENTS.refuse_dose.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "refuse_dose", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    if (o.status !== "active" || !inNursing(a)) throw new IpdRefusal("order_not_active");
    const { actId, slot } = await recordOutcome(tx, actor, o, a, new Date(input.doseDueAt), "refused", input.reason, input.note ?? null, at);
    // The duty doctor hears of a refused dose (a few words; no patient or drug name in the bell).
    const where = await whereWords(tx, a);
    let told = 0;
    for (const userId of await dutyDoctorsFor(tx, a, at)) {
      if (await raiseNoticeIn(tx, {
        userId, kind: "ipd.emar.dose_refused", title: "Dose refused", body: [...where.words, "Review"].join(" · "),
        refType: "ipd_admission", refId: a.id, sourceKey: `ipd.emar.refused:${actId}`, at,
      })) told += 1;
    }
    await appendEvent(tx, doseRefused.make({
      payload: { refusalId: actId, doseId: slot.id, orderId: o.id, admissionId: a.id, reason: input.reason, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { refusalId: actId, doctorNotified: told > 0 };
  }), at);
}

export async function missDose(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"miss_dose">> {
  const input: Input<"miss_dose"> = IPD_INTENTS.miss_dose.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "miss_dose", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    const { actId, slot } = await recordOutcome(tx, actor, o, a, new Date(input.doseDueAt), "missed", input.reason, input.note ?? null, at);
    const notified = await tellMissed(tx, a, slot, at);
    await appendEvent(tx, doseMissed.make({
      payload: { missId: actId, doseId: slot.id, orderId: o.id, admissionId: a.id, by: "nurse", notified, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { missId: actId };
  }), at);
}

/** One missed-dose notice per dose (the alerts seam's unique key), to the duty doctors and the nursing fallback chain. */
async function tellMissed(tx: Tx, a: AdmissionRow, slot: DoseRow, at: Date): Promise<number> {
  const where = await whereWords(tx, a);
  const people = new Set([...(await dutyDoctorsFor(tx, a, at)), ...(await nursingFallback(tx))]);
  let told = 0;
  for (const userId of [...people].sort()) {
    if (await raiseNoticeIn(tx, {
      userId, kind: "ipd.emar.dose_missed", title: "Dose missed", body: [...where.words, "Open MAR"].join(" · "),
      refType: "ipd_emar_dose", refId: slot.id, sourceKey: `ipd.emar.missed:${slot.id}`, at,
    })) told += 1;
  }
  if (told > 0) await tx.update(ipdEmarDoses).set({ missAlertedAt: at }).where(eq(ipdEmarDoses.id, slot.id));
  return told;
}

export async function reofferHeldDoses(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"reoffer_held_doses">> {
  const input: Input<"reoffer_held_doses"> = IPD_INTENTS.reoffer_held_doses.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "reoffer_held_doses", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!inNursing(a)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    // DECIDED: a hold from the last 24 hours on a still-active order re-offers; older ones are history.
    const held = await tx.select().from(ipdEmarDoses).where(and(
      eq(ipdEmarDoses.admissionId, a.id), eq(ipdEmarDoses.status, "held"), eq(ipdEmarDoses.reoffer, true),
      gte(ipdEmarDoses.dueAt, new Date(at.getTime() - 86_400_000)),
    )).for("update");
    const active = new Set((await tx.select({ id: ipdOrders.id }).from(ipdOrders).where(and(eq(ipdOrders.admissionId, a.id), eq(ipdOrders.status, "active")))).map((r) => r.id));
    let n = 0;
    for (const d of held.filter((x) => active.has(x.orderId))) {
      const actId = newId();
      await tx.insert(ipdEmarActs).values({
        id: actId, doseId: d.id, orderId: d.orderId, admissionId: a.id, patientId: a.patientId, kind: "reoffered", slotSeq: d.slotSeq + 1, at, recordedAt: at,
        actorId: actor.id, provenance: provenanceOf(actor), reason: input.reason,
      });
      await tx.update(ipdEmarDoses).set({ status: "scheduled", reofferedAt: at, slotSeq: d.slotSeq + 1, lastActId: actId }).where(eq(ipdEmarDoses.id, d.id));
      n += 1;
    }
    await appendEvent(tx, dosesReoffered.make({
      payload: { admissionId: a.id, count: n, reason: input.reason, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { reoffered: n };
  }), at);
}

/**
 * A wrong record is never deleted (the acts table refuses UPDATE and DELETE). `entered_in_error`: the record never
 * happened — a given / held / refused / missed slot opens again (a PRN slot closes). `medication_incident`: the dose stays
 * GIVEN and the pharmacy's medication-incident register gets an administration-stage entry (NCC MERP C–I).
 */
export async function markDoseInError(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"mark_dose_in_error">> {
  const input: Input<"mark_dose_in_error"> = IPD_INTENTS.mark_dose_in_error.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  if (input.kind === "medication_incident" && input.incident === undefined) throw new IpdRefusal("incident_details_required");
  return onceIpd(db, actor, "mark_dose_in_error", input.idempotencyKey, input, async () => {
    const act = (await db.select().from(ipdEmarActs).where(eq(ipdEmarActs.id, input.actId)))[0];
    if (act === undefined || !["given", "held", "refused", "missed"].includes(act.kind)) throw new IpdRefusal("dose_act_not_found");
    const done = (await db.select({ id: ipdEmarActs.id }).from(ipdEmarActs).where(eq(ipdEmarActs.correctsActId, act.id)))[0];
    if (done !== undefined) throw new IpdRefusal("dose_act_already_corrected");
    let incident: { incidentId: string; no: string } | null = null;
    if (input.kind === "medication_incident" && input.incident !== undefined) {
      incident = await recordIncident(db, actor, {
        kind: "error", stage: "administration", type: input.incident.type, category: input.incident.category, patientId: act.patientId,
        whatHappened: `Inpatient dose (eMAR record ${act.id}): ${input.reason}`,
      }, at);
    }
    return withTx(db, async (tx) => {
      const a = await lockAdmission(tx, act.admissionId);
      const slot = (await tx.select().from(ipdEmarDoses).where(eq(ipdEmarDoses.id, act.doseId)).for("update"))[0]!;
      const correctionId = newId();
      try {
        await tx.insert(ipdEmarActs).values({
          id: correctionId, doseId: slot.id, orderId: act.orderId, admissionId: a.id, patientId: act.patientId, kind: input.kind, slotSeq: null,
          at, recordedAt: at, actorId: actor.id, provenance: provenanceOf(actor), reason: input.reason, correctsActId: act.id,
          incidentId: incident?.incidentId ?? null,
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new IpdRefusal("dose_act_already_corrected");
        throw e;
      }
      if (input.kind === "entered_in_error" && slot.lastActId === act.id) {
        await tx.update(ipdEmarDoses).set({ status: slot.prn ? "cancelled" : "scheduled", lastActId: correctionId, reofferedAt: null }).where(eq(ipdEmarDoses.id, slot.id));
      }
      await appendEvent(tx, doseCorrected.make({
        payload: { correctionId, actId: act.id, orderId: act.orderId, admissionId: a.id, kind: input.kind, incidentId: incident?.incidentId ?? null, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
      }));
      return { correctionId, incidentNo: incident?.no ?? null };
    });
  }, at);
}

/** Infusions: start → rate change / pause → resume → stop, each recorded; a high-alert start or rate change needs the second nurse. */
export async function recordInfusionEvent(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"record_infusion_event">> {
  const input: Input<"record_infusion_event"> = IPD_INTENTS.record_infusion_event.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const now = opts.now ?? new Date();
  if (ipdIsInFuture(input.at, now)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_infusion_event", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    requireGivable(o, a);
    const last = (await tx.select().from(ipdEmarInfusionEvents).where(eq(ipdEmarInfusionEvents.orderId, o.id)).orderBy(desc(ipdEmarInfusionEvents.at), desc(ipdEmarInfusionEvents.id)).limit(1))[0];
    const state = infusionStateOf(last?.event ?? null);
    const allowed: Record<string, readonly string[]> = { none: ["start"], running: ["rate_change", "pause", "stop"], paused: ["resume", "stop", "rate_change"], stopped: [] };
    if (!allowed[state]!.includes(input.event)) throw new IpdRefusal("infusion_out_of_order", undefined, { state, event: input.event });
    if ((input.event === "start" || input.event === "rate_change") && input.rateMlPerHour === undefined) throw new IpdRefusal("infusion_out_of_order", undefined, { rateRequired: true });
    if (last !== undefined && new Date(input.at) < last.at) throw new IpdRefusal("infusion_out_of_order", undefined, { before: last.at.toISOString() });
    const drug = (await emarDrugsOf(tx, [o])).get(o.id);
    const secondNurseId = drug?.highAlert === true && (input.event === "start" || input.event === "rate_change" || input.event === "resume")
      ? await spendSecondCheck(tx, actor, input.secondNurse, now) : null;
    const id = newId();
    await tx.insert(ipdEmarInfusionEvents).values({
      id, orderId: o.id, admissionId: a.id, event: input.event, rateMlPerHour: input.rateMlPerHour ?? null, at: new Date(input.at), recordedAt: now,
      actorId: actor.id, secondNurseId,
    });
    const next = infusionStateOf(input.event);
    await appendEvent(tx, infusionRecorded.make({
      payload: { infusionEventId: id, orderId: o.id, admissionId: a.id, event: input.event, state: next as "running" | "paused" | "stopped", provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: new Date(input.at),
    }));
    return { infusionEventId: id, infusionState: next as "running" | "paused" | "stopped" };
  }), now);
}

export function infusionStateOf(lastEvent: string | null): "none" | "running" | "paused" | "stopped" {
  if (lastEvent === null) return "none";
  if (lastEvent === "pause") return "paused";
  if (lastEvent === "stop") return "stopped";
  return "running";
}

export async function recordNarcoticWastage(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"record_narcotic_wastage">> {
  const input: Input<"record_narcotic_wastage"> = IPD_INTENTS.record_narcotic_wastage.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "record_narcotic_wastage", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    const drug = (await emarDrugsOf(tx, [o])).get(o.id);
    if (drug?.narcotic !== true) throw new IpdRefusal("not_a_narcotic");
    const witnessId = await spendSecondCheck(tx, actor, input.witness, at);
    const entryId = newId();
    await tx.insert(ipdEmarNarcoticRegister).values({
      id: entryId, orderId: o.id, admissionId: a.id, kind: "wasted", qty: input.qty, unit: input.unit, reason: input.reason, actorId: actor.id, witnessId, at,
    });
    await appendEvent(tx, narcoticWasted.make({
      payload: { entryId, orderId: o.id, admissionId: a.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { entryId };
  }), at);
}

export async function signVerbalOrder(db: Db, actor: Actor, raw: unknown, opts: EmarOpts = {}): Promise<Output<"sign_verbal_order">> {
  const input: Input<"sign_verbal_order"> = IPD_INTENTS.sign_verbal_order.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ORDER_PLACE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "sign_verbal_order", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrderIn(tx, input.orderId);
    const v = (await tx.select().from(ipdEmarVerbalOrders).where(eq(ipdEmarVerbalOrders.orderId, o.id)).for("update"))[0];
    if (v === undefined) throw new IpdRefusal("verbal_order_not_found");
    if (v.signedAt !== null) throw new IpdRefusal("verbal_order_signed");
    if (v.fromDoctorId !== actor.id && !onTeam(await treatingTeamOf(tx, a, at), actor.id)) throw new IpdRefusal("not_treating_team");
    await tx.update(ipdEmarVerbalOrders).set({ signedAt: at, signedBy: actor.id }).where(eq(ipdEmarVerbalOrders.id, v.id));
    await appendEvent(tx, verbalOrderSigned.make({
      payload: { orderId: o.id, admissionId: a.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { orderId: o.id, signedAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════ allergy added later (§4.6 edge) ═══════════════════════════════════════

/**
 * An allergy was recorded: every ACTIVE drug order of the patient's open admission is re-checked with the same salt-aware
 * matcher; each conflict raises ONE flag per (order, allergy) — the give refuses `allergy_conflict` while it is open — and
 * tells the duty doctors and every active pharmacist once. Idempotent on redelivery (the flag's unique index).
 */
export async function recheckOrdersForAllergy(tx: Tx, payload: { patientId: string; allergyId: string; substance: string }, at: Date): Promise<number> {
  const orders = await tx.select().from(ipdOrders).where(and(eq(ipdOrders.patientId, payload.patientId), eq(ipdOrders.kind, "drug"), eq(ipdOrders.status, "active")));
  if (orders.length === 0) return 0;
  const allergy = (await listAllergies(tx as unknown as Db, payload.patientId)).find((x) => x.id === payload.allergyId && x.status === "active");
  if (allergy === undefined) return 0;
  const texts = await resolveDrugTexts(tx as unknown as Db, [allergy.substance]);
  const resolved = await resolveMedicines(tx as unknown as Db, orders.map((o) => o.medicineId!));
  let raised = 0;
  for (const o of orders) {
    const hit = matchAllergiesSaltAware([{ lineIndex: 0, drug: o.medicineName ?? "", resolution: resolved.get(o.medicineId!) ?? null }],
      [{ substance: allergy.substance, resolution: texts.get(allergy.substance) ?? null, allergenClass: allergy.allergenClass }]);
    if (hit.length === 0) continue;
    const a = await lockAdmission(tx, o.admissionId);
    if (!inNursing(a)) continue;
    const flagId = newId();
    const won = await tx.insert(ipdEmarAllergyFlags).values({
      id: flagId, orderId: o.id, admissionId: a.id, patientId: o.patientId, allergyId: allergy.id, substances: [allergy.substance], raisedAt: at,
    }).onConflictDoNothing().returning({ id: ipdEmarAllergyFlags.id });
    if (won.length === 0) continue;
    const where = await whereWords(tx, a);
    const people = new Set([...(await dutyDoctorsFor(tx, a, at)), ...(await activeHolders(tx, "pharmacy"))]);
    let notified = 0;
    for (const userId of [...people].sort()) {
      if (await raiseNoticeIn(tx, {
        userId, kind: "ipd.emar.allergy_conflict", title: "New allergy vs active order", body: [...where.words, "Review order"].join(" · "),
        refType: "ipd_order", refId: o.id, sourceKey: `ipd.emar.allergy:${flagId}`, at,
      })) notified += 1;
    }
    await appendEvent(tx, allergyFlagRaised.make({
      payload: { flagId, orderId: o.id, admissionId: a.id, notified, provenance: "system" },
      actor: EMAR_SYSTEM_ACTOR, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    raised += 1;
  }
  return raised;
}

export const EMAR_SYSTEM_ACTOR: Actor = { type: "system", id: "ipd-emar" };

// ═══════════════════════════════════════ the minute sweep ═══════════════════════════════════════

export type EmarSweepResult = { scheduled: number; missed: number; verbalNudged: number; failed: number };

/**
 * Rides the nursing minute job (`kernel/worker/jobs.ts` `sweepIpdNursing`): no job of its own. (1) Tops up every verified
 * active order's slots to the horizon. (2) A scheduled dose past its window (re-offered: past the new window) becomes
 * MISSED with ONE notice per dose to the duty doctors and the nursing fallback chain (the alerts seam's unique key).
 * (3) A verbal order unsigned 4 hours before its deadline nudges the doctor once; past the deadline, once more. Each row
 * in its own transaction; a failure is counted and the rest go on.
 */
export async function sweepIpdEmar(db: Db, now: Date): Promise<EmarSweepResult> {
  const out: EmarSweepResult = { scheduled: 0, missed: 0, verbalNudged: 0, failed: 0 };
  const orders = await db.select().from(ipdOrders).where(and(
    eq(ipdOrders.kind, "drug"), eq(ipdOrders.status, "active"), eq(ipdOrders.verification, "verified"),
    ne(ipdOrders.frequency, "SOS"), ne(ipdOrders.frequency, "STAT"),
    sql`not exists (select 1 from ipd_emar_doses d where d.order_id = ${ipdOrders.id} and d.due_at >= ${new Date(now.getTime() + 12 * 3_600_000).toISOString()}::timestamptz)`,
  ));
  for (const o of orders) {
    try { out.scheduled += await withTx(db, (tx) => scheduleDosesIn(tx, o, now, horizonOf(now), now)); } catch { out.failed += 1; }
  }
  const due = await db.select({ id: ipdEmarDoses.id, admissionId: ipdEmarDoses.admissionId }).from(ipdEmarDoses).where(and(
    eq(ipdEmarDoses.status, "scheduled"), eq(ipdEmarDoses.prn, false),
    sql`coalesce(${ipdEmarDoses.reofferedAt}, ${ipdEmarDoses.dueAt}) + make_interval(mins => ${ipdEmarDoses.windowMinutes}) < ${now.toISOString()}::timestamptz`,
  ));
  for (const d of due) {
    try {
      const done = await withTx(db, async (tx) => {
        const a = await lockAdmission(tx, d.admissionId);
        const slot = (await tx.select().from(ipdEmarDoses).where(eq(ipdEmarDoses.id, d.id)).for("update"))[0]!;
        if (slot.status !== "scheduled" || !inNursing(a)) return false;
        const end = (slot.reofferedAt ?? slot.dueAt).getTime() + slot.windowMinutes * 60_000;
        if (end >= now.getTime()) return false;
        const actId = newId();
        await tx.insert(ipdEmarActs).values({
          id: actId, doseId: slot.id, orderId: slot.orderId, admissionId: a.id, patientId: slot.patientId, kind: "missed", slotSeq: slot.slotSeq + 1,
          at: now, recordedAt: now, actorId: EMAR_SYSTEM_ACTOR.id, provenance: "system", reason: "window_passed",
        });
        await tx.update(ipdEmarDoses).set({ status: "missed", slotSeq: slot.slotSeq + 1, lastActId: actId }).where(eq(ipdEmarDoses.id, slot.id));
        const notified = await tellMissed(tx, a, slot, now);
        await appendEvent(tx, doseMissed.make({
          payload: { missId: actId, doseId: slot.id, orderId: slot.orderId, admissionId: a.id, by: "sweep", notified, provenance: "system" },
          actor: EMAR_SYSTEM_ACTOR, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: now,
        }));
        return true;
      });
      if (done) out.missed += 1;
    } catch { out.failed += 1; }
  }
  const verbal = await db.select().from(ipdEmarVerbalOrders).where(and(
    isNull(ipdEmarVerbalOrders.signedAt), lte(ipdEmarVerbalOrders.signBy, new Date(now.getTime() + 4 * 3_600_000)),
  ));
  for (const v of verbal) {
    try {
      await withTx(db, async (tx) => {
        const overdue = v.signBy.getTime() <= now.getTime();
        const won = await raiseNoticeIn(tx, {
          userId: v.fromDoctorId, kind: "ipd.emar.verbal_unsigned", title: overdue ? "Verbal order unsigned — past 24 h" : "Sign verbal order",
          body: "Open rounds", refType: "ipd_order", refId: v.orderId, sourceKey: `ipd.emar.verbal:${v.id}:${overdue ? "overdue" : "due"}`, at: now,
        });
        if (won) { out.verbalNudged += 1; await tx.update(ipdEmarVerbalOrders).set({ nudgedAt: now }).where(eq(ipdEmarVerbalOrders.id, v.id)); }
      });
    } catch { out.failed += 1; }
  }
  return out;
}

/** Re-exported for the reads: the dose words a label and a screen print. */
export { doseWordsOf };

/** The worker's handler for `allergy.recorded` (manifest subscription `IPD_EMAR_ALLERGY_CONSUMER`). */
export function emarAllergyConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== allergyRecorded.name) return;
    const p = allergyRecorded.payloadSchema.parse(e.payload);
    await withTx(db, (tx) => recheckOrdersForAllergy(tx, p, e.occurredAt));
  };
}
