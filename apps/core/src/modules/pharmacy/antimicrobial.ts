import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { requestApproval } from "../../kernel/approvals/requests";
import { approvals, pharmacyDispenses, users } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { usersHoldingRoleAtScope } from "../../kernel/workflow/roles";
import { medicinesByIds, restrictedAntimicrobialExists } from "../formulary";
import { getDoctor, getPrescription } from "../opd";
import { ANTIMICROBIAL_STEWARD_ROLE, RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE } from "./approval-types";
import { PharmacyError } from "./errors";
import { requireRegisteredPharmacist } from "./pharmacists";
import { getDispenseRow, linesOf, userNames } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { MedicineWithSalts } from "../formulary";
import type { RxLine } from "../opd";

/**
 * ═══ PHARMACY STAGE D5 — THE RESERVE / RESTRICTED ANTIMICROBIAL GATE ═══
 *
 * Basis: WHO AWaRe 2023; ICMR AMSP guidelines 2018 — a Reserve or restricted agent is dispensed only after prior
 * authorisation by the antimicrobial stewardship team.
 *
 * A line whose medicine is `antimicrobial_restricted` leaves the pharmacy (verify, and again at hand-over) only with
 * a GRANTED `pharmacy_restricted_antimicrobial` approval BOUND to it, checked on execute (the
 * `billing/credit-notes.ts` `assertGrantedApproval` shape — no module subscribes to `approval.granted`).
 *
 * ═══ THE BINDING IS THE APPROVALS KERNEL'S OWN ROW — NO TABLE OF OUR OWN ═══
 *
 * The request is filed with subject `{ type: "pharmacy_dispense_moieties", id: "<dispenseId>|<saltIds>" }` and the
 * patient. `approvals` already holds who asked and when (`requester_id`, `requested_at`), who decided and when, and
 * the decision note, and a decided row is never edited (the kernel's conditional UPDATE on `pending`). So the gate
 * re-reads the approval rows by that subject at the act and asks: granted, of this type, this subject, this patient —
 * the smallest honest shape. A binding table would copy four of those columns and need a trigger to stay honest.
 *
 * BOUND TO THE MOIETY SET, NOT THE BRAND: the steward approves meropenem for this patient on this dispense; a generic
 * substitution of the same moieties does not need a second approval, and a different antibiotic cannot ride on it.
 *
 * ═══ THE STEWARD MAY NOT APPROVE THEIR OWN PRESCRIPTION ═══
 *
 * The kernel refuses requester = approver (`requester_approver`, `kernel/approvals/decisions.ts`), but the requester
 * here is the PHARMACIST; the conflict the AMSP rule names is prescriber = approver, which the kernel cannot see (the
 * approval knows no prescriber). It is enforced HERE, at execute: a grant decided by the prescribing doctor's user
 * does not count, and the refusal (`antimicrobial_self_approval`) says so, so the counter asks again and another
 * steward decides. `kernel/**` is untouched.
 */
export const STEWARD_SUBJECT_TYPE = "pharmacy_dispense_moieties";

/** The moiety set a restricted line is approved for: its salt ids, sorted and de-duplicated. */
export function moietyKeyOf(m: Pick<MedicineWithSalts, "salts">): string {
  return [...new Set(m.salts.map((s) => s.saltId))].sort().join(",");
}
const subjectIdOf = (dispenseId: string, key: string): string => `${dispenseId}|${key}`;

/** Every ACTIVE user holding `antimicrobial_steward` at hospital scope (the census's `*_held` rule). */
export async function activeStewards(db: Db): Promise<string[]> {
  const holders = await withTx(db, (tx) => usersHoldingRoleAtScope(tx, ANTIMICROBIAL_STEWARD_ROLE, "hospital"));
  if (holders.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, holders), eq(users.active, true)));
  return rows.map((r) => r.id);
}

export type StewardStatus = "none" | "pending" | "granted" | "rejected" | "self_approved";
export type StewardVerdict = { status: StewardStatus; approvalId: string | null; decisionNote: string | null };

type ApprovalRow = typeof approvals.$inferSelect;

async function boundApprovals(db: Db, dispenseId: string, patientId: string): Promise<ApprovalRow[]> {
  return db.select().from(approvals).where(and(
    eq(approvals.typeKey, RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE),
    eq(approvals.patientId, patientId),
    eq(approvals.subjectType, STEWARD_SUBJECT_TYPE),
    sql`${approvals.subjectId} like ${`${dispenseId}|%`}`,
  )).orderBy(asc(approvals.requestedAt));
}

/**
 * The verdict for ONE moiety set on ONE dispense, from the approval rows. Every clause of the binding is asked of the
 * row itself (type, subject, patient), not of the query that found it — the check-on-execute contract.
 */
export function judgeSteward(
  rows: readonly ApprovalRow[], bind: { dispenseId: string; patientId: string; key: string }, prescriberUserId: string | null,
): StewardVerdict {
  const bound = rows.filter((a) => a.typeKey === RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE && a.subjectType === STEWARD_SUBJECT_TYPE
    && a.subjectId === subjectIdOf(bind.dispenseId, bind.key) && a.patientId === bind.patientId);
  const pick = (status: StewardStatus, a: ApprovalRow | undefined): StewardVerdict | null =>
    a === undefined ? null : { status, approvalId: a.id, decisionNote: a.decisionNote ?? null };
  const granted = bound.filter((a) => a.status === "granted");
  return pick("granted", granted.find((a) => a.decidedBy !== null && a.decidedBy !== prescriberUserId))
    ?? pick("pending", bound.find((a) => a.status === "pending"))
    ?? pick("self_approved", granted.at(-1))
    ?? pick("rejected", bound.filter((a) => a.status === "rejected").at(-1))
    ?? { status: "none", approvalId: null, decisionNote: null };
}

/** The prescribing doctor's user, for the self-approval rule; null when the prescription names none on file. */
export async function prescriberUserOf(db: Db, doctorId: string | null): Promise<string | null> {
  // null: an OUTSIDE doctor's paper prescription (2026-09-30) — no login of ours wrote it.
  return doctorId === null ? null : (await getDoctor(db, doctorId))?.userId ?? null;
}

export type StewardLine = { lineIdx: number; drug: string; medicine: MedicineWithSalts | undefined };

/**
 * THE GATE. Each restricted line needs its moiety set granted on this dispense by a steward who is not the
 * prescriber. The refusal names the drug and the act: ask the steward from the authorisation sheet — or, while
 * nobody holds the role, that the hospital must appoint one.
 */
export async function assertStewardApprovals(
  db: Db, dispense: { id: string; patientId: string }, prescriberUserId: string | null, lines: readonly StewardLine[],
): Promise<void> {
  const restricted = lines.filter((l) => l.medicine?.antimicrobialRestricted === true);
  if (restricted.length === 0) return;
  const rows = await boundApprovals(db, dispense.id, dispense.patientId);
  const missing: { lineIdx: number; drug: string; status: StewardStatus }[] = [];
  for (const l of restricted) {
    const v = judgeSteward(rows, { dispenseId: dispense.id, patientId: dispense.patientId, key: moietyKeyOf(l.medicine!) }, prescriberUserId);
    if (v.status !== "granted") missing.push({ lineIdx: l.lineIdx, drug: l.drug, status: v.status });
  }
  if (missing.length === 0) return;
  const drugs = missing.map((m) => `line ${String(m.lineIdx + 1)} (${m.drug})`).join(", ");
  const self = missing.filter((m) => m.status === "self_approved");
  if (self.length === missing.length) {
    throw new PharmacyError(
      "antimicrobial_self_approval",
      `${drugs}: the only approval was given by the prescribing doctor — a steward may not approve their own prescription; ask the antimicrobial steward again from the authorisation sheet so another steward decides`,
      { lines: missing },
    );
  }
  if ((await activeStewards(db)).length === 0) {
    throw new PharmacyError(
      "antimicrobial_steward_not_appointed",
      `${drugs} is a restricted antimicrobial and needs the antimicrobial steward's approval, but nobody holds the antimicrobial_steward role — the hospital must appoint one (the infectious-disease physician, else the clinical microbiologist, else the AMSP lead the medical superintendent names) at /admin/users`,
      { lines: missing },
    );
  }
  throw new PharmacyError(
    "antimicrobial_steward_approval_required",
    `${drugs} is a restricted antimicrobial (WHO AWaRe Reserve or hospital policy) — ask the antimicrobial steward from the authorisation sheet; it leaves only once a steward has approved it`,
    { lines: missing },
  );
}

/** What the desk's pre-check says about each restricted open line of a claimed ticket. */
export type StewardLineState = StewardVerdict & { lineIdx: number; drug: string; appointed: boolean };

export async function stewardStates(db: Db, actor: Actor, dispenseId: string): Promise<StewardLineState[]> {
  const d = await getDispenseRow(db, dispenseId);
  const open = (await linesOf(db, dispenseId)).filter((l) => l.status === "open" && l.dispensedMedicineId !== null);
  if (open.length === 0) return [];
  const medicines = await medicinesByIds(db, open.map((l) => l.dispensedMedicineId!));
  const restricted = open.filter((l) => medicines.get(l.dispensedMedicineId!)?.antimicrobialRestricted === true);
  if (restricted.length === 0) return [];
  const rx = await getPrescription(db, actor, d.prescriptionId);
  const prescriber = rx === null ? null : await prescriberUserOf(db, rx.doctorId);
  const rows = await boundApprovals(db, d.id, d.patientId);
  const appointed = (await activeStewards(db)).length > 0;
  return restricted.map((l) => {
    const m = medicines.get(l.dispensedMedicineId!)!;
    return { lineIdx: l.lineIdx, drug: m.brandName, appointed, ...judgeSteward(rows, { dispenseId: d.id, patientId: d.patientId, key: moietyKeyOf(m) }, prescriber) };
  });
}

export type StewardAskInput = {
  /** Why the doctor chose it — "culture-proven ESBL UTI", "febrile neutropenia". */
  indication: string;
  cultureSent: boolean;
  plannedDays: number;
  note?: string | null;
};

/**
 * THE ASK, from the desk's authorisation sheet: a registered pharmacist files the approval for one restricted line's
 * moiety set on a ticket not yet handed over, the indication, whether a culture was sent and the planned days in its note.
 * Idempotent: a pending or granted one for the same moiety set is returned, not duplicated. A new ask is allowed
 * after a rejection, and after a grant that the prescriber gave themselves.
 */
export async function askSteward(db: Db, actor: Actor, dispenseId: string, lineIdx: number, input: StewardAskInput, now: Date): Promise<StewardVerdict> {
  const d = await getDispenseRow(db, dispenseId);
  /* Claimed is the usual moment; a line restricted after verify (the hospital restricted it mid-way) is asked before hand-over. */
  if (!["claimed", "verified", "picked", "billed"].includes(d.status)) {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}; nothing is left to approve`, { status: d.status });
  }
  await requireRegisteredPharmacist(db, actor, now);
  const line = (await linesOf(db, dispenseId)).find((l) => l.lineIdx === lineIdx);
  if (line === undefined) throw new PharmacyError("unknown_line", `line ${String(lineIdx)} not found`);
  if (line.dispensedMedicineId === null) {
    throw new PharmacyError("unresolved_medicine", `line ${String(lineIdx + 1)} resolves to no formulary medicine — resolve it first`, { lineIdx });
  }
  const medicine = (await medicinesByIds(db, [line.dispensedMedicineId])).get(line.dispensedMedicineId);
  if (medicine?.antimicrobialRestricted !== true) {
    throw new PharmacyError("authorisation_not_needed", `line ${String(lineIdx + 1)} is not a restricted antimicrobial — there is nothing for the steward to approve`, { lineIdx });
  }
  const indication = input.indication.trim();
  if (indication.length < 3) throw new PharmacyError("reason_required", "the steward decides on the indication — say what it is being given for");
  if (!Number.isInteger(input.plannedDays) || input.plannedDays < 1 || input.plannedDays > 90) {
    throw new PharmacyError("reason_required", "the planned course is a whole number of days, 1 to 90");
  }
  if ((await activeStewards(db)).length === 0) {
    throw new PharmacyError(
      "antimicrobial_steward_not_appointed",
      "nobody holds the antimicrobial_steward role — the hospital must appoint one at /admin/users before a restricted antimicrobial can be approved",
    );
  }
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) throw new PharmacyError("unknown_prescription", `prescription ${d.prescriptionId} not found`);
  const prescriber = await prescriberUserOf(db, rx.doctorId);
  const key = moietyKeyOf(medicine);
  const current = judgeSteward(await boundApprovals(db, d.id, d.patientId), { dispenseId: d.id, patientId: d.patientId, key }, prescriber);
  if (current.status === "pending" || current.status === "granted") return current;

  const rxLine = line.rxLine as RxLine;
  const names = await userNames(db, [prescriber]);
  const extra = (input.note ?? "").trim();
  const requestNote = [
    `${medicine.brandName} — ${rxLine.dose} ${rxLine.frequency}${rxLine.durationDays == null ? "" : ` × ${String(rxLine.durationDays)} days`} (line ${String(lineIdx + 1)}${d.dispenseNo === null ? "" : `, ${d.dispenseNo}`})`,
    `Indication: ${indication}`,
    `Culture sent: ${input.cultureSent ? "yes" : "no"}`,
    `Planned days: ${String(input.plannedDays)}`,
    `Prescriber: ${prescriber === null ? "not on file" : names.get(prescriber) ?? "on file"}`,
    ...(extra === "" ? [] : [`Pharmacist: ${extra}`]),
  ].join(" · ");
  const filed = await withTx(db, (tx) => requestApproval(tx, actor, {
    typeKey: RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE,
    subject: { type: STEWARD_SUBJECT_TYPE, id: subjectIdOf(d.id, key) },
    patientId: d.patientId, encounterId: d.encounterId, requestNote,
  }));
  return { status: "pending", approvalId: filed.approvalId, decisionNote: null };
}

/** What the steward reads beside the inbox card (`pharmacy.antimicrobial.approve`): the line as written, and whose. */
export type StewardRequestDetail = {
  approvalId: string;
  dispenseNo: string | null;
  lines: { lineIdx: number; drug: string; brandName: string; dose: string; frequency: string; durationDays: number | null }[];
  prescriberUserId: string | null;
  prescriberName: string | null;
};

export async function stewardRequestDetail(db: Db, actor: Actor, approvalId: string): Promise<StewardRequestDetail> {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (a === undefined || a.typeKey !== RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE || a.subjectType !== STEWARD_SUBJECT_TYPE) {
    throw new PharmacyError("not_found", `approval ${approvalId} is not a restricted-antimicrobial request`);
  }
  const [dispenseId, key] = a.subjectId.split("|") as [string, string];
  const d = await getDispenseRow(db, dispenseId);
  const lines = (await linesOf(db, dispenseId)).filter((l) => l.dispensedMedicineId !== null);
  const medicines = await medicinesByIds(db, lines.map((l) => l.dispensedMedicineId!));
  const rx = await getPrescription(db, actor, d.prescriptionId);
  const prescriber = rx === null ? null : await prescriberUserOf(db, rx.doctorId);
  const names = await userNames(db, [prescriber]);
  return {
    approvalId, dispenseNo: d.dispenseNo,
    lines: lines.filter((l) => { const m = medicines.get(l.dispensedMedicineId!); return m !== undefined && moietyKeyOf(m) === key; }).map((l) => {
      const r = l.rxLine as RxLine;
      return { lineIdx: l.lineIdx, drug: r.drug, brandName: medicines.get(l.dispensedMedicineId!)!.brandName, dose: r.dose, frequency: r.frequency, durationDays: r.durationDays ?? null };
    }),
    prescriberUserId: prescriber,
    prescriberName: prescriber === null ? null : names.get(prescriber) ?? null,
  };
}

/** Pending steward approvals older than this are an office LAW row (amber): the SLA the type carries. */
export const STEWARD_WAIT_HOURS = 4;

export type StewardToday = {
  /** Restricted products exist in the formulary and nobody holds the steward role — red, tier 0. */
  notAppointed: boolean;
  waiting: { approvalId: string; dispenseNo: string | null; requestedAt: string }[];
};

/** The office's LAW side for stage D5 — read under `pharmacy.licences.manage` (`office-needs.ts`). */
export async function stewardToday(db: Db, now: Date = new Date()): Promise<StewardToday> {
  const notAppointed = (await restrictedAntimicrobialExists(db)) && (await activeStewards(db)).length === 0;
  const cutoff = new Date(now.getTime() - STEWARD_WAIT_HOURS * 3_600_000);
  const pending = await db.select({ id: approvals.id, subjectId: approvals.subjectId, requestedAt: approvals.requestedAt }).from(approvals)
    .where(and(eq(approvals.typeKey, RESTRICTED_ANTIMICROBIAL_APPROVAL_TYPE), eq(approvals.status, "pending"), lt(approvals.requestedAt, cutoff)))
    .orderBy(asc(approvals.requestedAt)).limit(50);
  const ids = [...new Set(pending.map((p) => p.subjectId.split("|")[0]!))];
  const nos = ids.length === 0 ? new Map<string, string | null>()
    : new Map((await db.select({ id: pharmacyDispenses.id, no: pharmacyDispenses.dispenseNo }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.id, ids))).map((r) => [r.id, r.no]));
  return {
    notAppointed,
    waiting: pending.map((p) => ({ approvalId: p.id, dispenseNo: nos.get(p.subjectId.split("|")[0]!) ?? null, requestedAt: p.requestedAt.toISOString() })),
  };
}
