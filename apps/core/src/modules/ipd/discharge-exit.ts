import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_INTENTS, IpdPoliceClearanceSchema, IpdReceiveBodySchema, IpdReleaseBodySchema, ipdIsInFuture, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  ipdAdmissions, ipdBedStays, ipdChargeLines, ipdDischargeSummaries, ipdDischarges, ipdGatePasses, ipdMortuaryRegister, ipdStayExits, ipdTransfers, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withIdempotency } from "../billing";
import { getPatientSummaries } from "../patients";
import { holdsPermission, lockAdmission, moveAdmission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { endHoldIn, releaseBedOccupant } from "./beds";
import { hasUnbilledLines, liveBills } from "./bill-cover";
import { postAdmissionCharges } from "./charges";
import { finalBillRow } from "./discharge-bill";
import { activeDischarge, confirmationsOf, ensureSummaryDraft, pendingDepartments } from "./discharge";
import {
  admissionAbsconded, admissionDeceased, admissionDischarged, admissionLama, gatePassIssued, gatePassScanned, mortuaryReceived,
  mortuaryReleased,
} from "./discharge-events";
import { IpdError, IpdRefusal } from "./errors";
import {
  IPD_BILL_VIEW, IPD_DISCHARGE_BILL, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_EXIT, IPD_GATE_PASS, IPD_GATE_SCAN, IPD_MORTUARY_MANAGE,
} from "./manifest";
import { transferCancelled } from "./transfer-events";
import type { Actor, IpdAdmissionState, IpdIntentName, IpdMortuaryEntry } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E3.2 (#730) — THE GATE PASS AND THE OTHER WAYS A STAY ENDS (spec SPEC-ipd-core §4.7; the admission workflow's E0.2
 * decision: `issue_gate_pass` is the cascade's single gate, the security scan ends the stay).
 *
 * - `issueGatePass` refuses until every department confirmed (`charges_unconfirmed`), the summary is signed
 *   (`summary_unsigned`) and the final bill is settled or its dues approved (`bill_unsettled`); a refer-out needs its
 *   receiving hospital. It moves the admission to `discharging`.
 * - `scanGatePass` (the front office at the exit, or the duty manager — no security role is seeded yet) ends the stay:
 *   `discharged`, or `transferred_out` for a refer-out (emitted as `ipd.admission.discharged` with that state, the passes
 *   lane's decision); the bed goes to cleaning (`clean:terminal` for an isolated patient).
 * - LAMA / DAMA, absconded and death each end the stay in one transaction: the bed is released (a terminal clean after a
 *   death or an abscond — DECIDED: the room is searched and deep-cleaned before the next patient), an open transfer is
 *   cancelled with its hold, a live gate pass is voided, the cascade's declaration is closed, and the passes lane's event
 *   goes out ONCE (the intent's idempotency key plus the workflow's single-winner move).
 * - ⚖ Nothing here reads the bill to refuse a departure: a LAMA, an abscond or a death settles later (dues if unpaid), and
 *   a body is never held for money — the mortuary register's release checks the police clearance of an MLC and nothing
 *   else (Consumer Protection Act; state clinical-establishment rules; NHRC charter).
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

async function openStayOf(tx: Tx, admissionId: string) {
  return (await tx.select().from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0];
}

/**
 * Ends the stay: releases the bed, cancels an open transfer (and its hold), voids a live gate pass, closes the
 * declaration, and moves the admission to its terminal state with `ended_at`. Returns the released bed (null when the
 * patient was on no bed).
 */
async function endStay(
  tx: Tx, actor: Actor, a: AdmissionRow, to: IpdAdmissionState, at: Date, opts: { terminal: boolean; reason: string },
): Promise<string | null> {
  const open = (await tx.select().from(ipdTransfers).where(and(eq(ipdTransfers.admissionId, a.id), eq(ipdTransfers.status, "open"))).for("update"))[0];
  if (open !== undefined) {
    await endHoldIn(tx, actor, open.reservationId, at);
    await tx.update(ipdTransfers).set({ status: "cancelled", endedBy: actor.id, endedAt: at, cancelReason: "other", cancelNote: opts.reason })
      .where(eq(ipdTransfers.id, open.id));
    await appendEvent(tx, transferCancelled.make({
      payload: { transferId: open.id, admissionId: a.id, fromBedId: open.fromBedId, toBedId: open.toBedId, reason: "other", provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
  }
  const stay = await openStayOf(tx, a.id);
  if (stay !== undefined) await releaseBedOccupant(tx, actor, stay.bedId, at, { terminal: opts.terminal || a.isolation !== "none" });
  await tx.update(ipdGatePasses).set({ status: "void", voidedBy: actor.id, voidedAt: at, voidReason: opts.reason })
    .where(and(eq(ipdGatePasses.admissionId, a.id), eq(ipdGatePasses.status, "issued")));
  const d = await activeDischarge(tx, a.id);
  if (d !== undefined) {
    await tx.update(ipdDischarges).set({ status: "cancelled", endedBy: actor.id, endedAt: at, cancelReason: opts.reason }).where(eq(ipdDischarges.id, d.id));
  }
  await moveAdmission(tx, actor, a, to, at, { endedAt: at, endedBy: actor.id }, opts.reason);
  return stay?.bedId ?? null;
}

/**
 * Review #762 RED 3 — the end of the time the stay's posted charges cover: per live (non-reversed) line, the earlier of
 * the IST midnight closing its service date and the instant it was posted (a line posted at 15:00 for today covers until
 * 15:00). An ending stamped before it contradicts a posted charge — billing reverses the charge first.
 */
async function chargesCoverUntil(tx: Tx, admissionId: string): Promise<Date | null> {
  const lines = await tx.select({ id: ipdChargeLines.id, serviceDate: ipdChargeLines.serviceDate, postedAt: ipdChargeLines.postedAt, reversalOf: ipdChargeLines.reversalOf })
    .from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
  const reversed = new Set(lines.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  let until: number | null = null;
  for (const l of lines) {
    if (l.reversalOf !== null || reversed.has(l.id)) continue;
    const dayEnd = new Date(`${l.serviceDate}T00:00:00+05:30`).getTime() + 24 * 3_600_000;
    const end = Math.min(dayEnd, l.postedAt.getTime());
    if (until === null || end > until) until = end;
  }
  return until === null ? null : new Date(until);
}

/** ⚖ With a final bill the stay still ends (the bill desk reconciles, `ended_after_bill`); without one, refuse the contradiction. */
async function refuseBeforeCharges(tx: Tx, admissionId: string, when: Date): Promise<void> {
  if ((await finalBillRow(tx, admissionId)) !== undefined) return;
  const until = await chargesCoverUntil(tx, admissionId);
  if (until !== null && when.getTime() < until.getTime()) {
    throw new IpdRefusal("time_before_charges", undefined, { chargedUntil: until.toISOString() });
  }
}

// ═══════════════════════════════════════════ the gate pass ═══════════════════════════════════════════

/** A gate pass code: short enough to type at the gate, unguessable enough not to be invented (ULID randomness). */
function gatePassCode(): string {
  return `GP-${newId().slice(-10)}`;
}

export async function issueGatePass(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"issue_gate_pass">> {
  const input: Input<"issue_gate_pass"> = IPD_INTENTS.issue_gate_pass.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_GATE_PASS);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "issue_gate_pass", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    // #763: a void in `discharging` voids its gate pass; the re-settled bill's pass issues from there (no state move).
    const reissue = a.state === "discharging" && (await tx.select({ id: ipdGatePasses.id }).from(ipdGatePasses)
      .where(and(eq(ipdGatePasses.admissionId, a.id), eq(ipdGatePasses.status, "issued")))).length === 0;
    if (a.state !== "fit_declared" && !reissue) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const d = await activeDischarge(tx, a.id);
    if (d === undefined) throw new IpdRefusal("admission_wrong_state", "No fit declaration");
    const pending = pendingDepartments(await confirmationsOf(tx, d.id));
    if (pending.length > 0) throw new IpdRefusal("charges_unconfirmed", undefined, { pending });
    const summary = (await tx.select().from(ipdDischargeSummaries).where(eq(ipdDischargeSummaries.admissionId, a.id)))[0];
    if (summary?.status !== "signed") throw new IpdRefusal("summary_unsigned", undefined, { status: summary?.status ?? "none" });
    const bill = await finalBillRow(tx, a.id);
    if (bill === undefined) throw new IpdRefusal("bill_unsettled");
    // #763: after the settlement day the stay may have run on (another night, services). Post the running bill as if the
    // patient leaves now — the settlement day stays closed — and ask for the supplementary bill when anything waits. ⚖ The
    // dues path stays open: a supplementary bill settled with dues recorded lets the pass issue.
    await postAdmissionCharges(tx as unknown as Db, a.id, { upToIstDate: istDayString(at), now: at, presumedDischargeAt: at });
    if (await hasUnbilledLines(tx, a.id)) throw new IpdRefusal("supplementary_unsettled");
    const referOut = d.disposition === "transfer_out";
    if (referOut && input.receivingHospital === undefined) throw new IpdRefusal("receiving_hospital_missing");

    if (!reissue) await moveAdmission(tx, actor, a, "discharging", at, {}, "issue_gate_pass");
    const gatePassId = newId();
    const code = gatePassCode();
    const duesRecorded = (await liveBills(tx, a.id)).some((b) => b.duesPaise > 0);
    await tx.insert(ipdGatePasses).values({
      id: gatePassId, admissionId: a.id, code, kind: referOut ? "transfer_out" : "discharge", status: "issued", duesRecorded,
      receivingHospital: referOut ? input.receivingHospital! : null, followUpAppointmentId: input.followUpAppointmentId ?? null,
      issuedBy: actor.id, issuedAt: at,
    });
    await appendEvent(tx, gatePassIssued.make({
      payload: { admissionId: a.id, gatePassId, kind: referOut ? "transfer_out" : "discharge", provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    // Review #762 item 9: the dues flag is a money fact — only for an issuer who may see money.
    const money = (await holdsPermission(db, actor, IPD_BILL_VIEW)) || (await holdsPermission(db, actor, IPD_DISCHARGE_BILL));
    return { gatePassId, code, state: "discharging" as const, issuedAt: at.toISOString(), duesRecorded: money ? duesRecorded : null };
  }), at);
}

export async function scanGatePass(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"scan_gate_pass">> {
  const input: Input<"scan_gate_pass"> = IPD_INTENTS.scan_gate_pass.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_GATE_SCAN);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "scan_gate_pass", input.idempotencyKey, input, async () => {
    const code = input.gatePassCode.trim().toUpperCase();
    const p0 = (await db.select().from(ipdGatePasses).where(eq(ipdGatePasses.code, code)))[0];
    if (p0 === undefined) throw new IpdRefusal("gate_pass_not_found");
    return withTx(db, async (tx) => {
      const a = await lockAdmission(tx, p0.admissionId);
      const p = (await tx.select().from(ipdGatePasses).where(eq(ipdGatePasses.id, p0.id)).for("update"))[0]!;
      if (p.status === "void") throw new IpdRefusal("gate_pass_void");
      if (p.status === "used") throw new IpdRefusal("gate_pass_used", undefined, { scannedAt: p.scannedAt?.toISOString() ?? null });
      if (a.state !== "discharging") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
      const to = p.kind === "transfer_out" ? "transferred_out" as const : "discharged" as const;
      const stay = await openStayOf(tx, a.id);
      const released = stay === undefined ? null : await releaseBedOccupant(tx, actor, stay.bedId, at, { terminal: a.isolation !== "none" });
      await moveAdmission(tx, actor, a, to, at, { endedAt: at, endedBy: actor.id }, "scan_gate_pass");
      await tx.update(ipdGatePasses).set({ status: "used", scannedBy: actor.id, scannedAt: at, gateId: input.gateId }).where(eq(ipdGatePasses.id, p.id));
      const d = await activeDischarge(tx, a.id);
      if (d !== undefined) await tx.update(ipdDischarges).set({ status: "completed", endedBy: actor.id, endedAt: at }).where(eq(ipdDischarges.id, d.id));
      await appendEvent(tx, gatePassScanned.make({
        payload: { admissionId: a.id, gatePassId: p.id, gateId: input.gateId, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      await appendEvent(tx, admissionDischarged.make({
        payload: { admissionId: a.id, patientId: a.patientId, state: to, bedId: stay?.bedId ?? null, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return { admissionId: a.id, state: to, bedId: stay?.bedId ?? a.id, bedStatus: released?.bedStatus ?? "cleaning" };
    });
  }, at);
}

// ═══════════════════════════════════════════ LAMA / abscond / death ═══════════════════════════════════════════

export async function recordLama(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_lama">> {
  const input: Input<"record_lama"> = IPD_INTENTS.record_lama.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_EXIT);
  const at = opts.now ?? new Date();
  if (input.signedBy === "representative" && input.representativeReason === undefined) throw new IpdRefusal("representative_reason_missing");
  if (ipdIsInFuture(input.at, at)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_lama", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (a.state !== "admitted" && a.state !== "fit_declared") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const when = new Date(input.at);
    await refuseBeforeCharges(tx, a.id, when);
    const bedId = await endStay(tx, actor, a, "lama", when, { terminal: false, reason: input.kind });
    await tx.insert(ipdStayExits).values({
      id: newId(), admissionId: a.id, kind: input.kind, at: when, recordedBy: actor.id, recordedAt: at,
      details: {
        signedBy: input.signedBy, representativeReason: input.representativeReason ?? null, risksExplainedBy: input.risksExplainedBy,
        formDocumentId: input.formDocumentId, witnessName: input.witnessName ?? null,
      },
    });
    // §4.7: a LAMA patient still gets a summary — a draft is opened for the doctor to complete and sign.
    const summaryId = await ensureSummaryDraft(tx, actor, a, at);
    await appendEvent(tx, admissionLama.make({
      payload: { admissionId: a.id, patientId: a.patientId, kind: input.kind, bedId, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: when,
    }));
    return { admissionId: a.id, state: "lama" as const, summaryTaskId: summaryId };
  }), at);
}

export async function recordAbscond(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_abscond">> {
  const input: Input<"record_abscond"> = IPD_INTENTS.record_abscond.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_EXIT);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.lastSeenAt, at)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_abscond", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!["admitted", "fit_declared", "discharging"].includes(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    // ⚖ A medico-legal patient who absconds is reported to the police.
    if (a.mlc && input.policeIntimationRef === undefined) throw new IpdRefusal("police_intimation_required");
    await refuseBeforeCharges(tx, a.id, at);
    const bedId = await endStay(tx, actor, a, "absconded", at, { terminal: true, reason: "absconded" });
    await tx.insert(ipdStayExits).values({
      id: newId(), admissionId: a.id, kind: "absconded", at: new Date(input.lastSeenAt), recordedBy: actor.id, recordedAt: at,
      details: { searchDone: input.searchDone, policeIntimationRef: input.policeIntimationRef ?? null, note: input.note ?? null, mlc: a.mlc },
    });
    await appendEvent(tx, admissionAbsconded.make({
      payload: { admissionId: a.id, patientId: a.patientId, bedId, policeIntimated: input.policeIntimationRef !== undefined, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { admissionId: a.id, state: "absconded" as const, billFrozen: true as const };
  }), at);
}

export async function recordDeath(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_death">> {
  const input: Input<"record_death"> = IPD_INTENTS.record_death.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.diedAt, at)) throw new IpdRefusal("time_in_future");
  return onceIpd(db, actor, "record_death", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!["admitted", "transferring", "fit_declared", "discharging"].includes(a.state)) {
      throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    }
    if (a.mlc && input.policeIntimationRef === undefined) throw new IpdRefusal("police_intimation_required");
    const diedAt = new Date(input.diedAt);
    await refuseBeforeCharges(tx, a.id, diedAt);
    const bedId = await endStay(tx, actor, a, "deceased", diedAt, { terminal: true, reason: "deceased" });
    await tx.insert(ipdStayExits).values({
      id: newId(), admissionId: a.id, kind: "deceased", at: diedAt, recordedBy: actor.id, recordedAt: at,
      details: {
        certifiedBy: input.certifiedBy, policeIntimationRef: input.policeIntimationRef ?? null, cause: input.cause ?? null,
        note: input.note ?? null, mlc: a.mlc,
      },
    });
    const mortuaryEntryId = newId();
    await tx.insert(ipdMortuaryRegister).values({
      id: mortuaryEntryId, admissionId: a.id, patientId: a.patientId, status: "expected", diedAt, mlc: a.mlc,
      createdBy: actor.id, createdAt: at,
    });
    await ensureSummaryDraft(tx, actor, a, at);
    await appendEvent(tx, admissionDeceased.make({
      payload: { admissionId: a.id, patientId: a.patientId, bedId, mortuaryEntryId, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: diedAt,
    }));
    // No task engine in this branch: the MCCD and the mortuary handover are the register's and a later lane's.
    return { admissionId: a.id, state: "deceased" as const, taskIds: [], mortuaryEntryId };
  }), at);
}

// ═══════════════════════════════════════════ the mortuary register ═══════════════════════════════════════════

type MortuaryRow = typeof ipdMortuaryRegister.$inferSelect;

async function lockEntry(tx: Tx, entryId: string): Promise<MortuaryRow> {
  const row = (await tx.select().from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.id, entryId)).for("update"))[0];
  if (row === undefined) throw new IpdError("mortuary_entry_not_found", "no mortuary register entry with that id");
  return row;
}

function onceMortuary<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, at: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:mortuary_${act}`, key: key.toLowerCase() }, body, work, at);
}

/** The body arrives: the receiver and a second person check the identity together (§4.7: two-person check). */
export async function receiveBody(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<IpdMortuaryEntry> {
  const input = IpdReceiveBodySchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_MORTUARY_MANAGE);
  const at = opts.now ?? new Date();
  if (input.identityCheckedBy === actor.id) throw new IpdError("identity_check_same_person", "the identity check needs a second person");
  await onceMortuary(db, actor, "receive", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const second = (await tx.select({ id: users.id }).from(users).where(eq(users.id, input.identityCheckedBy)))[0];
    if (second === undefined) throw new IpdError("identity_check_same_person", "the second person is not a known user");
    const e = await lockEntry(tx, input.entryId);
    if (e.status !== "expected") throw new IpdError("mortuary_wrong_state", `the body is already ${e.status}`, { status: e.status });
    await tx.update(ipdMortuaryRegister).set({ status: "received", receivedAt: at, receivedBy: actor.id, identityCheckedBy: input.identityCheckedBy })
      .where(eq(ipdMortuaryRegister.id, e.id));
    await appendEvent(tx, mortuaryReceived.make({
      payload: { admissionId: e.admissionId, entryId: e.id, provenance: provenanceOf(actor) },
      actor, correlationId: e.admissionId, patientId: e.patientId, occurredAt: at,
    }));
  }), at);
  return readMortuaryEntry(db, actor, input.entryId);
}

export async function recordPoliceClearance(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<IpdMortuaryEntry> {
  const input = IpdPoliceClearanceSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_MORTUARY_MANAGE);
  const at = opts.now ?? new Date();
  await onceMortuary(db, actor, "clearance", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEntry(tx, input.entryId);
    if (e.status === "released") throw new IpdError("mortuary_wrong_state", "the body is already released", { status: e.status });
    await tx.update(ipdMortuaryRegister).set({ policeClearance: true, policeClearanceRef: input.ref }).where(eq(ipdMortuaryRegister.id, e.id));
  }), at);
  return readMortuaryEntry(db, actor, input.entryId);
}

/** ⚖ Release to the next of kin: an MLC needs the police clearance; the bill is never consulted (a body is never held for money). */
export async function releaseBody(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<IpdMortuaryEntry> {
  const input = IpdReleaseBodySchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_MORTUARY_MANAGE);
  const at = opts.now ?? new Date();
  await onceMortuary(db, actor, "release", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEntry(tx, input.entryId);
    if (e.status !== "received") throw new IpdError("mortuary_wrong_state", `a body ${e.status} cannot be released`, { status: e.status });
    if (e.mlc && !e.policeClearance) throw new IpdError("police_clearance_required", "a medico-legal case is released after the police clearance is recorded");
    await tx.update(ipdMortuaryRegister).set({ status: "released", releasedTo: input.releasedTo, releasedAt: at, releasedBy: actor.id })
      .where(eq(ipdMortuaryRegister.id, e.id));
    await appendEvent(tx, mortuaryReleased.make({
      payload: { admissionId: e.admissionId, entryId: e.id, provenance: provenanceOf(actor) },
      actor, correlationId: e.admissionId, patientId: e.patientId, occurredAt: at,
    }));
  }), at);
  return readMortuaryEntry(db, actor, input.entryId);
}

async function toEntries(db: Db, actor: Actor, rows: MortuaryRow[]): Promise<IpdMortuaryEntry[]> {
  if (rows.length === 0) return [];
  const people = new Map((await getPatientSummaries(db, actor, [...new Set(rows.map((r) => r.patientId))])).map((p) => [p.requestedId, p] as const));
  const adm = new Map((await db.select({ id: ipdAdmissions.id, no: ipdAdmissions.admissionNo }).from(ipdAdmissions)
    .where(inArray(ipdAdmissions.id, [...new Set(rows.map((r) => r.admissionId))]))).map((r) => [r.id, r.no] as const));
  return rows.map((r) => {
    const p = people.get(r.patientId);
    return {
      id: r.id, admissionId: r.admissionId, admissionNo: adm.get(r.admissionId) ?? null,
      patientName: p === undefined ? null : p.restricted ? p.alias : p.name, uhid: p?.uhid ?? "", status: r.status as IpdMortuaryEntry["status"],
      diedAt: r.diedAt.toISOString(), mlc: r.mlc, receivedAt: r.receivedAt?.toISOString() ?? null, policeClearance: r.policeClearance,
      releasedTo: r.releasedTo ?? null, releasedAt: r.releasedAt?.toISOString() ?? null,
    };
  });
}

export async function readMortuaryEntry(db: Db, actor: Actor, entryId: string): Promise<IpdMortuaryEntry> {
  const row = (await db.select().from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.id, entryId)))[0];
  if (row === undefined) throw new IpdError("mortuary_entry_not_found", "no mortuary register entry with that id");
  return (await toEntries(db, actor, [row]))[0]!;
}

/** The register: bodies not yet released first, then the latest releases. */
export async function listMortuary(db: Db, actor: Actor): Promise<IpdMortuaryEntry[]> {
  await requireIpdPermission(db, actor, IPD_MORTUARY_MANAGE);
  const rows = await db.select().from(ipdMortuaryRegister).orderBy(asc(ipdMortuaryRegister.status), desc(ipdMortuaryRegister.diedAt)).limit(200);
  return toEntries(db, actor, rows);
}
