import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { IPD_IN_PLACE_CLASSES, IPD_INTENTS, IPD_TRANSFER_HOLD_MINUTES, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  ipdAdmissions, ipdBedReservations, ipdBedStays, ipdClassChanges, ipdTransfers, resources, workflowTimers,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { getPatientSummaries } from "../patients";
import {
  admissionAdvisoryLock, holdsPermission, lockAdmission, moveAdmission, needOf, onceIpd, provenanceOf, readAdmission,
  requireIpdPermission,
} from "./admission-core";
import { userNames } from "./admissions";
import { grantedApproval } from "./approval-types";
import { IpdBedAttributesSchema } from "./bed-attributes";
import { ageInYears, checkBedRules } from "./bed-rules";
import {
  assignBedIn, bedWithWard, endHoldIn, holdBedForTransferIn, lockBedsInOrder, placementContext, readBedFacts,
  releaseBedOccupant, vacateBedForSwapIn, withNextRuleValidBeds,
} from "./beds";
import { initialsOf } from "./beds-board";
import { classRank, rentClassOf } from "./charge-days";
import { applyClassChanges, nextNoonIst } from "./class-change";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_ADMIT, IPD_TRANSFER_ACCEPT, IPD_TRANSFER_START } from "./manifest";
import { admissionClassChanged, bedSwapped, transferAccepted, transferCancelled, transferStarted } from "./transfer-events";
import type {
  Actor, IpdBedClass, IpdBedNeed, IpdConsent, IpdHandoverCard, IpdHandoverList, IpdIntentName, IpdTransferOptions,
  IpdTransferTarget,
} from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E3.1 (#729) — TRANSFERS (spec SPEC-ipd-core §4.4; contracts `intents-ward.ts`): moves between beds and wards with a
 * handover the receiving nurse accepts, the swap of two patients, and the class change in place.
 *
 * - START holds the target bed for the admission and moves the admission to `transferring`; the patient stays on the
 *   origin bed, which stays OCCUPIED (the sending ward is still responsible — "no patient in limbo with no bed").
 * - ACCEPT is the only act that moves the patient: in ONE transaction the origin stay closes, the target stay opens on
 *   the held bed, the origin bed goes to cleaning (housekeeping picks it up from the kernel release; `clean:routine`,
 *   or `clean:terminal` for an isolated patient — G3's vocabulary), the admission is `admitted` again and
 *   `ipd.transfer.accepted` goes out once.
 * - CANCEL (the patient worsened, the receiving ward declined) releases the hold; the patient never left.
 * - The 30-minute escalation is the admission workflow's SLA ladder on `transferring` (100 % rung → nursing supervisor;
 *   the kernel falls back to the duty manager while no one holds that role). No job of ours.
 * - A class move by transfer bills itself through the day rule (the new stay carries the new bed's class).
 *
 * LOCK ORDER (the bed intents' and admission-core's): the admission's advisory lock(s) in id order → the beds' parents
 * then the beds, each in id order (`lockBedsInOrder`) → the admission row(s) → IPD rows.
 *
 * DECIDED (E3.1, standard Indian corporate-hospital practice; owner rulings are for money, procurement and law):
 * - The target must be free AND clean at start; it is held `IPD_TRANSFER_HOLD_MINUTES` (12 h), far past the escalation.
 * - Moving onto an ICU-flagged bed from a non-ICU bed needs a GRANTED intensivist approval (`ipd_icu_admission`) on the
 *   admission (`icu_needs_intensivist` otherwise); a step-down needs none.
 * - A transfer derives the patient's need from the TARGET bed's class and ICU flag (a clinical move needs no class
 *   consent, §4.4) and keeps the admission's isolation and gender facts; the admission's requested class is the
 *   request's record and is not rewritten.
 * - `not_receiving_ward`: there is no nurse-to-ward roster yet, so any holder of `ipd.transfer.accept` may accept for
 *   any ward (seam: the ipd-nursing lane's ward assignment narrows it). The sender may never accept their own.
 * - The receiving ward = the target bed's ward (the room's parent when it hangs from a room).
 * - A swap moves both patients to each other's beds and bills each at the new bed's class by the day rule; a bed with a
 *   block waiting for release cannot take a swap.
 * - Transport: the porter task is the transport lane's `requestPatientMove` — not in this branch (seam below).
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type BedFacts = Awaited<ReturnType<typeof readBedFacts>>;

/** The patient's need for a bed of this class: the admission's isolation and gender, the bed's class and ICU flag. */
function transferNeed(a: AdmissionRow, bed: BedFacts): IpdBedNeed {
  return { ...needOf(a), requestedClass: bed.class, icu: bed.icu };
}

async function openStayOf(db: Db | Tx, admissionId: string) {
  return (await db.select().from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0];
}

async function lockAdmissionRow(tx: Tx, admissionId: string): Promise<AdmissionRow> {
  const row = (await tx.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)).for("update"))[0];
  if (row === undefined) throw new IpdRefusal("admission_not_found");
  return row;
}

/** The open escalation rung the workflow laid on `transferring` (its due instant is the handover clock). */
async function escalationDue(tx: Tx, instanceId: string): Promise<Date | null> {
  const rung = (await tx.select({ dueAt: workflowTimers.dueAt }).from(workflowTimers).where(and(
    eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.state, "transferring"), eq(workflowTimers.kind, "escalation"),
    isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt),
  )).orderBy(desc(workflowTimers.dueAt)).limit(1))[0];
  return rung?.dueAt ?? null;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.cause?.code ?? err.code) === "23505";
}

// ═══════════════════════════════════════════ start_transfer ═══════════════════════════════════════════

export async function startTransfer(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"start_transfer">> {
  const input: Input<"start_transfer"> = IPD_INTENTS.start_transfer.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_TRANSFER_START);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "start_transfer", input.idempotencyKey, input, async () => {
    const a0 = await readAdmission(db, input.admissionId);
    const target = await readBedFacts(db, input.toBedId);
    const need = transferNeed(a0, target);
    const ctx = await placementContext(db, actor, a0.patientId, at);
    return withNextRuleValidBeds(db, actor, { bedId: input.toBedId, patientId: a0.patientId, need, at }, () => withTx(db, async (tx) => {
      await admissionAdvisoryLock(tx, a0.id);
      const stay0 = await openStayOf(tx, a0.id);
      if (stay0 === undefined) {
        throw new IpdRefusal(a0.state === "transferring" ? "transfer_already_open" : "admission_wrong_state", "Not on a bed");
      }
      await lockBedsInOrder(tx, [stay0.bedId, input.toBedId]);
      const a = await lockAdmissionRow(tx, a0.id);
      if (a.state === "transferring") {
        const open = (await tx.select({ id: ipdTransfers.id }).from(ipdTransfers).where(and(eq(ipdTransfers.admissionId, a.id), eq(ipdTransfers.status, "open"))))[0];
        throw new IpdRefusal("transfer_already_open", undefined, { transferId: open?.id ?? null });
      }
      if (a.state !== "admitted") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
      const stay = await openStayOf(tx, a.id);
      if (stay?.bedId !== stay0.bedId) throw new IpdRefusal("state_changed", "Patient moved");
      if (input.toBedId === stay.bedId) throw new IpdRefusal("bed_not_available", "Patient is already on this bed");
      const origin = await readBedFacts(tx, stay.bedId);
      if (target.icu && !origin.icu && await grantedApproval(tx, input.intensivistApprovalId, "icu", [a.id, a.patientId]) === null) {
        throw new IpdRefusal("icu_needs_intensivist", undefined, { approvalId: input.intensivistApprovalId ?? null, action: "request_approval" });
      }

      const hold = await holdBedForTransferIn(tx, actor, { admissionId: a.id, bedId: input.toBedId, need }, at, ctx, IPD_TRANSFER_HOLD_MINUTES);
      await moveAdmission(tx, actor, a, "transferring", at, {}, `start_transfer: ${input.reason}`);
      const escalatesAt = await escalationDue(tx, a.workflowInstanceId);
      const transferId = newId();
      await tx.insert(ipdTransfers).values({
        id: transferId, admissionId: a.id, patientId: a.patientId, fromBedId: stay.bedId, toBedId: input.toBedId,
        reservationId: hold.reservationId, reason: input.reason, situation: input.handover.situation,
        background: input.handover.background, assessment: input.handover.assessment,
        recommendation: input.handover.recommendation, draftId: input.handover.draftId ?? null,
        intensivistApprovalId: input.intensivistApprovalId ?? null, status: "open", startedBy: actor.id, startedAt: at,
        escalatesAt,
      });
      await appendEvent(tx, transferStarted.make({
        payload: {
          transferId, admissionId: a.id, patientId: a.patientId, fromBedId: stay.bedId, toBedId: input.toBedId,
          reservationId: hold.reservationId, reason: input.reason, escalatesAt: escalatesAt?.toISOString() ?? null,
          provenance: provenanceOf(actor),
        },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      // SEAM (transport lane): the porter task — `requestPatientMove({ admissionId, fromBedId, toBedId })` from the
      // transport module's index — is created here once that lane merges; it is not in this branch.
      return {
        transferId, fromBedId: stay.bedId, toBedId: input.toBedId, state: "transferring" as const,
        escalatesAt: (escalatesAt ?? new Date(at.getTime() + 30 * 60_000)).toISOString(),
      };
    }).catch((e: unknown) => {
      if (isUniqueViolation(e)) throw new IpdRefusal("transfer_already_open");
      throw e;
    }));
  }, at);
}

// ═══════════════════════════════════════════ accept_handover ═══════════════════════════════════════════

export async function acceptHandover(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"accept_handover">> {
  const input: Input<"accept_handover"> = IPD_INTENTS.accept_handover.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_TRANSFER_ACCEPT);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "accept_handover", input.idempotencyKey, input, async () => {
    const t0 = (await db.select().from(ipdTransfers).where(eq(ipdTransfers.id, input.transferId)))[0];
    if (t0 === undefined) throw new IpdRefusal("transfer_not_found");
    const a0 = await readAdmission(db, t0.admissionId);
    const target = await readBedFacts(db, t0.toBedId);
    const need = transferNeed(a0, target);
    // The overflow gate was the sender's to pass at start; the receiving nurse is not asked again.
    const ctx = { ...(await placementContext(db, actor, a0.patientId, at)), mayUseOverflow: true };
    return withNextRuleValidBeds(db, actor, { bedId: t0.toBedId, patientId: a0.patientId, need, at }, () => withTx(db, async (tx) => {
      await admissionAdvisoryLock(tx, a0.id);
      await lockBedsInOrder(tx, [t0.fromBedId, t0.toBedId]);
      const a = await lockAdmissionRow(tx, a0.id);
      const t = (await tx.select().from(ipdTransfers).where(eq(ipdTransfers.id, t0.id)).for("update"))[0]!;
      if (t.status !== "open") throw new IpdRefusal("transfer_not_open", undefined, { status: t.status });
      if (t.startedBy === actor.id) throw new IpdRefusal("sender_cannot_accept");
      // SEAM (ipd-nursing): `not_receiving_ward` once nurses are assigned to wards.
      if (a.state !== "transferring") throw new IpdRefusal("state_changed", undefined, { state: a.state });
      const origin = await openStayOf(tx, a.id);
      if (origin?.bedId !== t.fromBedId) throw new IpdRefusal("state_changed", "Patient moved");

      await releaseBedOccupant(tx, actor, t.fromBedId, at, { terminal: a.isolation !== "none" });
      await assignBedIn(tx, db, actor, { admissionId: a.id, bedId: t.toBedId, patientId: a.patientId, need }, at, ctx, { viaAdmit: true });
      await moveAdmission(tx, actor, a, "admitted", at, {}, "accept_handover");
      await tx.update(ipdTransfers).set({ status: "accepted", endedBy: actor.id, endedAt: at }).where(eq(ipdTransfers.id, t.id));
      await appendEvent(tx, transferAccepted.make({
        payload: {
          transferId: t.id, admissionId: a.id, patientId: a.patientId, fromBedId: t.fromBedId, toBedId: t.toBedId,
          provenance: provenanceOf(actor),
        },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return { admissionId: a.id, bedId: t.toBedId, originBedId: t.fromBedId, state: "admitted" as const, acceptedAt: at.toISOString() };
    }));
  }, at);
}

// ═══════════════════════════════════════════ cancel_transfer ═══════════════════════════════════════════

/** The sending side (`ipd.transfer.start`) calls it off, or the receiving side (`ipd.transfer.accept`) declines it. */
export async function cancelTransfer(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"cancel_transfer">> {
  const input: Input<"cancel_transfer"> = IPD_INTENTS.cancel_transfer.input.parse(raw);
  if (!(await holdsPermission(db, actor, IPD_TRANSFER_START)) && !(await holdsPermission(db, actor, IPD_TRANSFER_ACCEPT))) {
    throw new IpdError("ipd_forbidden", `this act needs the permission ${IPD_TRANSFER_START} or ${IPD_TRANSFER_ACCEPT}`, { permission: IPD_TRANSFER_START });
  }
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "cancel_transfer", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const t0 = (await tx.select().from(ipdTransfers).where(eq(ipdTransfers.id, input.transferId)))[0];
    if (t0 === undefined) throw new IpdRefusal("transfer_not_found");
    await admissionAdvisoryLock(tx, t0.admissionId);
    await lockBedsInOrder(tx, [t0.fromBedId, t0.toBedId]);
    const a = await lockAdmissionRow(tx, t0.admissionId);
    const t = (await tx.select().from(ipdTransfers).where(eq(ipdTransfers.id, t0.id)).for("update"))[0]!;
    if (t.status !== "open") throw new IpdRefusal("transfer_not_open", undefined, { status: t.status });
    if (a.state !== "transferring") throw new IpdRefusal("state_changed", undefined, { state: a.state });
    await endHoldIn(tx, actor, t.reservationId, at);
    await moveAdmission(tx, actor, a, "admitted", at, {}, `cancel_transfer: ${input.reason}`);
    await tx.update(ipdTransfers).set({
      status: "cancelled", endedBy: actor.id, endedAt: at, cancelReason: input.reason, cancelNote: input.note ?? null,
    }).where(eq(ipdTransfers.id, t.id));
    await appendEvent(tx, transferCancelled.make({
      payload: { transferId: t.id, admissionId: a.id, fromBedId: t.fromBedId, toBedId: t.toBedId, reason: input.reason, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { admissionId: a.id, bedId: t.fromBedId, state: "admitted" as const, cancelledAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ swap_beds ═══════════════════════════════════════════

/**
 * Two admitted patients exchange beds in ONE transaction (§4.4: "one atomic act"): both stays close, both open, both
 * beds end occupied by the other admission — or, if any write or rule fails, nothing changed. Both admissions are
 * locked in id order, then both beds' parents and beds (`lockBedsInOrder`), then both admission rows in id order.
 */
export async function swapBeds(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"swap_beds">> {
  const input: Input<"swap_beds"> = IPD_INTENTS.swap_beds.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_TRANSFER_START);
  if (input.admissionIdA === input.admissionIdB) throw new IpdRefusal("swap_same_admission");
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "swap_beds", input.idempotencyKey, input, async () => {
    const a0 = await readAdmission(db, input.admissionIdA);
    const b0 = await readAdmission(db, input.admissionIdB);
    const stayA0 = await openStayOf(db, a0.id);
    const stayB0 = await openStayOf(db, b0.id);
    for (const [adm, stay] of [[a0, stayA0], [b0, stayB0]] as const) {
      if (stay === undefined) {
        throw new IpdRefusal(adm.state === "transferring" ? "transfer_already_open" : "admission_wrong_state", "Not on a bed", { admissionId: adm.id });
      }
    }
    const bedA = await readBedFacts(db, stayA0!.bedId);
    const bedB = await readBedFacts(db, stayB0!.bedId);
    const ctxA = await placementContext(db, actor, a0.patientId, at);
    const ctxB = await placementContext(db, actor, b0.patientId, at);
    return withTx(db, async (tx) => {
      for (const id of [a0.id, b0.id].sort()) await admissionAdvisoryLock(tx, id);
      await lockBedsInOrder(tx, [bedA.id, bedB.id]);
      const locked = new Map<string, AdmissionRow>();
      for (const id of [a0.id, b0.id].sort()) locked.set(id, await lockAdmissionRow(tx, id));
      const a = locked.get(a0.id)!;
      const b = locked.get(b0.id)!;
      for (const adm of [a, b]) {
        if (adm.state === "transferring") throw new IpdRefusal("transfer_already_open", undefined, { admissionId: adm.id });
        if (adm.state !== "admitted") throw new IpdRefusal("admission_wrong_state", undefined, { admissionId: adm.id, state: adm.state });
      }
      if ((await openStayOf(tx, a.id))?.bedId !== bedA.id || (await openStayOf(tx, b.id))?.bedId !== bedB.id) {
        throw new IpdRefusal("state_changed", "Patient moved");
      }
      await vacateBedForSwapIn(tx, actor, bedA.id, at);
      await vacateBedForSwapIn(tx, actor, bedB.id, at);
      await assignBedIn(tx, db, actor, { admissionId: a.id, bedId: bedB.id, patientId: a.patientId, need: transferNeed(a, bedB) }, at, ctxA, { viaAdmit: true });
      await assignBedIn(tx, db, actor, { admissionId: b.id, bedId: bedA.id, patientId: b.patientId, need: transferNeed(b, bedA) }, at, ctxB, { viaAdmit: true });
      await appendEvent(tx, bedSwapped.make({
        payload: { admissionIdA: a.id, admissionIdB: b.id, bedIdA: bedA.id, bedIdB: bedB.id, reason: input.reason, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return { a: { admissionId: a.id, bedId: bedB.id }, b: { admissionId: b.id, bedId: bedA.id } };
    });
  }, at);
}

// ═══════════════════════════════════════════ change_class ═══════════════════════════════════════════

const IN_PLACE: ReadonlySet<IpdBedClass> = new Set(IPD_IN_PLACE_CLASSES);

function consentRecord(c: IpdConsent, actor: Actor): Record<string, unknown> {
  return {
    signedBy: c.signedBy, method: c.method ?? (c.documentId === undefined ? null : "tablet_signature"),
    documentId: c.documentId ?? null, signerName: c.signerName ?? null, relation: c.relation ?? null,
    witnessName: c.witnessName ?? null, representativeReason: c.representativeReason ?? null, language: c.language ?? null,
    takenBy: actor.id,
  };
}

/**
 * A billing-class change WITHOUT a bed move, on request (§4.4): consent recorded (who, relation, method — paper names
 * its witness), effective at the next 12:00 IST (`nextNoonIst`), folded into the stay by the running bill
 * (`class-change.ts`). An upgrade needs the room-rent cap warning acknowledged first.
 * SEAM (ipd-payer, E2.2): the cap warning's TEXT (the payer's room-rent limit against the new class) comes from the
 * payer lane's function, not in this branch; the screen shows a generic warning and the intent checks the tick.
 */
export async function changeClass(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"change_class">> {
  const input: Input<"change_class"> = IPD_INTENTS.change_class.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "change_class", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (a.state !== "admitted") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const stay = await openStayOf(tx, a.id);
    if (stay === undefined) throw new IpdRefusal("admission_wrong_state", "Not on a bed");
    if (!IN_PLACE.has(input.toClass) || !IN_PLACE.has(rentClassOf(stay.bedClass as IpdBedClass) ?? stay.bedClass as IpdBedClass)) {
      throw new IpdRefusal("class_not_ward", undefined, { toClass: input.toClass, bedClass: stay.bedClass });
    }
    if (input.consent.signedBy === "representative" && input.consent.representativeReason === undefined) {
      throw new IpdRefusal("representative_reason_missing");
    }
    const changes = await tx.select().from(ipdClassChanges)
      .where(and(eq(ipdClassChanges.stayId, stay.id), eq(ipdClassChanges.status, "active"))).orderBy(asc(ipdClassChanges.effectiveFrom));
    const pending = changes.filter((c) => c.effectiveFrom.getTime() > at.getTime());
    const inEffect = changes.filter((c) => c.effectiveFrom.getTime() <= at.getTime()).at(-1);
    const fromClass = (inEffect?.toClass ?? stay.billedClass) as IpdBedClass;
    if (fromClass === input.toClass) throw new IpdRefusal("class_unchanged", undefined, { billedClass: fromClass });
    const direction = classRank(input.toClass) > classRank(rentClassOf(fromClass) ?? fromClass) ? "upgrade" as const : "downgrade" as const;
    if (direction === "upgrade" && !input.roomRentCapAcknowledged) throw new IpdRefusal("room_rent_cap_not_acknowledged");

    const effectiveFrom = nextNoonIst(at);
    for (const p of pending) {
      await tx.update(ipdClassChanges).set({ status: "superseded", supersededAt: at }).where(eq(ipdClassChanges.id, p.id));
    }
    const classChangeId = newId();
    await tx.insert(ipdClassChanges).values({
      id: classChangeId, admissionId: a.id, stayId: stay.id, fromClass, toClass: input.toClass, direction, effectiveFrom,
      consent: consentRecord(input.consent, actor), roomRentCapAcknowledged: input.roomRentCapAcknowledged, status: "active",
      requestedBy: actor.id, requestedAt: at,
    });
    await appendEvent(tx, admissionClassChanged.make({
      payload: {
        admissionId: a.id, classChangeId, stayId: stay.id, fromClass, toClass: input.toClass, direction,
        effectiveFrom: effectiveFrom.toISOString(), provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { admissionId: a.id, toClass: input.toClass, effectiveFrom: effectiveFrom.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ reads ═══════════════════════════════════════════

function ageSex(dob: Date | null, gender: string, at: Date): string {
  const age = ageInYears(dob, at);
  const sex = gender === "male" ? "M" : gender === "female" ? "F" : "O";
  return `${sex} ${age === null ? "?" : String(age)}`;
}

async function identities(db: Db, actor: Actor, patientIds: string[], at: Date) {
  const people = await getPatientSummaries(db, actor, patientIds);
  return new Map(people.map((p) => {
    const name = p.restricted ? p.alias : p.name;
    return [p.requestedId, { name, uhid: p.uhid, ageSex: ageSex(p.dob, p.administrativeGender, at), initials: initialsOf(name ?? p.uhid) }] as const;
  }));
}

/** The receiving wards' "Waiting for you" list (§4.9 D handover): every open transfer, oldest first. */
export async function listHandovers(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdHandoverList> {
  await requireIpdPermission(db, actor, IPD_TRANSFER_ACCEPT);
  const at = opts.now ?? new Date();
  const open = await db.select().from(ipdTransfers).where(eq(ipdTransfers.status, "open")).orderBy(asc(ipdTransfers.startedAt));
  const who = await identities(db, actor, open.map((t) => t.patientId), at);
  const names = await userNames(db, open.map((t) => t.startedBy));
  const admissionNos = new Map(open.length === 0 ? [] : (await db.select({ id: ipdAdmissions.id, no: ipdAdmissions.admissionNo }).from(ipdAdmissions)
    .where(inArray(ipdAdmissions.id, open.map((t) => t.admissionId)))).map((r) => [r.id, r.no] as const));
  const cards: IpdHandoverCard[] = [];
  const wards = new Map<string, { id: string; name: string; count: number }>();
  for (const t of open) {
    const from = await bedWithWard(db, t.fromBedId);
    const to = await bedWithWard(db, t.toBedId);
    if (to.wardId !== null) {
      const w = wards.get(to.wardId) ?? { id: to.wardId, name: to.wardName ?? to.wardId, count: 0 };
      w.count += 1;
      wards.set(to.wardId, w);
    }
    if (opts.wardId !== undefined && to.wardId !== opts.wardId) continue;
    const p = who.get(t.patientId);
    cards.push({
      transferId: t.id, admissionId: t.admissionId, admissionNo: admissionNos.get(t.admissionId) ?? null,
      patient: p ?? { name: null, uhid: "", ageSex: "", initials: "?" },
      fromBed: { id: from.id, code: from.code, wardName: from.wardName },
      toBed: { id: to.id, code: to.code, wardId: to.wardId, wardName: to.wardName, class: to.class },
      reason: t.reason as IpdHandoverCard["reason"],
      sbar: { situation: t.situation, background: t.background, assessment: t.assessment, recommendation: t.recommendation },
      startedAt: t.startedAt.toISOString(), startedBy: { id: t.startedBy, name: names.get(t.startedBy) ?? t.startedBy },
      escalatesAt: t.escalatesAt?.toISOString() ?? null,
      escalated: t.escalatesAt !== null && t.escalatesAt.getTime() <= at.getTime(),
      sentByViewer: t.startedBy === actor.id,
    });
  }
  return { asOf: at.toISOString(), wards: [...wards.values()].sort((x, y) => x.name.localeCompare(y.name)), handovers: cards };
}

const TARGET_LIMIT = 40;
const SWAP_LIMIT = 60;

/** The Beds drawer's Transfer panel for one admission: targets, swap partners, classes, and what is in flight. */
export async function transferOptions(db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {}): Promise<IpdTransferOptions> {
  await requireIpdPermission(db, actor, IPD_TRANSFER_START);
  const at = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  const who = await identities(db, actor, [a.patientId], at);
  const stay = await openStayOf(db, a.id);
  const bed = stay === undefined ? null : await bedWithWard(db, stay.bedId);

  const changes = stay === undefined ? [] : await db.select().from(ipdClassChanges)
    .where(and(eq(ipdClassChanges.stayId, stay.id), eq(ipdClassChanges.status, "active"))).orderBy(asc(ipdClassChanges.effectiveFrom));
  const billedClass = stay === undefined ? null : applyClassChanges(
    [{ id: stay.id, bedClass: stay.bedClass as IpdBedClass, billedClass: stay.billedClass as IpdBedClass, startedAt: stay.startedAt, endedAt: null }],
    changes.map((c) => ({ stayId: c.stayId, toClass: c.toClass as IpdBedClass, effectiveFrom: c.effectiveFrom })),
  ).filter((s) => s.startedAt.getTime() <= at.getTime()).at(-1)?.billedClass ?? (stay.billedClass as IpdBedClass);
  const pending = changes.filter((c) => c.effectiveFrom.getTime() > at.getTime()).at(-1);

  const openT = (await db.select().from(ipdTransfers).where(and(eq(ipdTransfers.admissionId, a.id), eq(ipdTransfers.status, "open"))))[0];
  const openTarget = openT === undefined ? null : await readBedFacts(db, openT.toBedId);

  // Targets: free, clean, unheld beds that pass every rule for this patient with the bed's own class as the need.
  const targets: IpdTransferTarget[] = [];
  if (stay !== undefined && a.state === "admitted") {
    const ctx = await placementContext(db, actor, a.patientId, at);
    const free = await db.select().from(resources)
      .where(and(eq(resources.kind, "bed"), eq(resources.status, "available"), isNull(resources.occupantRef), ne(resources.id, stay.bedId)))
      .orderBy(asc(resources.code));
    const held = new Set((await db.select({ bedId: ipdBedReservations.bedId }).from(ipdBedReservations)
      .where(eq(ipdBedReservations.status, "active"))).map((r) => r.bedId));
    const withWard: (IpdTransferTarget & { sameWard: boolean })[] = [];
    for (const b of free) {
      if (held.has(b.id)) continue;
      const parsed = IpdBedAttributesSchema.safeParse(b.attributes);
      if (!parsed.success) continue;
      const attrs = parsed.data;
      const need = { ...needOf(a), requestedClass: attrs.class, icu: attrs.icu };
      if (checkBedRules({ code: b.code, attributes: attrs }, ctx.patient, need, undefined, { roomGender: null, mayUseOverflow: ctx.mayUseOverflow }) !== null) continue;
      const placed = await bedWithWard(db, b.id);
      const reasons = [attrs.genderRule === "any" ? "Any gender" : attrs.genderRule === "female" ? "Female bay" : attrs.genderRule === "male" ? "Male bay" : "Paediatric"];
      if (attrs.icu) reasons.push("ICU");
      if (attrs.isolation !== "none") reasons.push(`Isolation: ${attrs.isolation}`);
      withWard.push({ bedId: b.id, code: b.code, wardName: placed.wardName, class: attrs.class, icu: attrs.icu, reasons, sameWard: placed.wardId === bed?.wardId });
      if (withWard.length >= TARGET_LIMIT * 3) break;
    }
    withWard.sort((x, y) => Number(y.sameWard) - Number(x.sameWard) || x.code.localeCompare(y.code));
    for (const t of withWard.slice(0, TARGET_LIMIT)) {
      targets.push({ bedId: t.bedId, code: t.code, wardName: t.wardName, class: t.class, icu: t.icu, reasons: t.reasons });
    }
  }

  // Swap partners: other admitted patients on a bed.
  const swapWith: IpdTransferOptions["swapWith"] = [];
  if (stay !== undefined && a.state === "admitted") {
    const others = await db.select({ admissionId: ipdBedStays.admissionId, bedId: ipdBedStays.bedId, patientId: ipdBedStays.patientId, code: resources.code })
      .from(ipdBedStays).innerJoin(resources, eq(resources.id, ipdBedStays.bedId)).innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdBedStays.admissionId))
      .where(and(isNull(ipdBedStays.endedAt), ne(ipdBedStays.admissionId, a.id), eq(ipdAdmissions.state, "admitted")))
      .orderBy(asc(resources.code)).limit(SWAP_LIMIT);
    const people = await identities(db, actor, others.map((o) => o.patientId), at);
    for (const o of others) {
      const placed = await bedWithWard(db, o.bedId);
      swapWith.push({ admissionId: o.admissionId, bedId: o.bedId, bedCode: o.code, wardName: placed.wardName, initials: people.get(o.patientId)?.initials ?? "?", class: placed.class });
    }
  }

  const inPlace = bed !== null && IN_PLACE.has(rentClassOf(bed.class) ?? bed.class);
  return {
    admissionId: a.id, admissionNo: a.admissionNo, state: a.state as IpdTransferOptions["state"],
    patient: who.get(a.patientId) ?? { name: null, uhid: "", ageSex: "", initials: "?" },
    bed: bed === null ? null : { id: bed.id, code: bed.code, class: bed.class, wardName: bed.wardName },
    billedClass,
    pendingClassChange: pending === undefined ? null : { toClass: pending.toClass as IpdBedClass, effectiveFrom: pending.effectiveFrom.toISOString() },
    openTransfer: openT === undefined ? null : { transferId: openT.id, toBedCode: openTarget?.code ?? "", startedAt: openT.startedAt.toISOString() },
    targets,
    swapWith,
    classes: inPlace && a.state === "admitted" ? IPD_IN_PLACE_CLASSES.filter((c) => c !== (pending?.toClass ?? billedClass)) : [],
  };
}
