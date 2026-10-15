import { and, desc, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { invoiceLines, invoices, opdDoctors, opdEncounters, opdQueueEntries, patients, users } from "../../kernel/db/schema";
import { feeQuote } from "./charge-rules";
import { BillingError } from "./errors";
import { encounterFeeStatuses } from "./fee-status";
import { invoiceSettlement } from "./invoices";
import { enteredInErrorDocIds } from "./receipts";
import { istDay } from "./time";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayName } from "../patients";
import { hasPermission } from "../../kernel/auth/permissions";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ "TO COLLECT" — THE DESK DOES NOT LOSE SIGHT OF A PATIENT IT LET THROUGH (OWNER, 2026-10-09) ═══
 *
 * Owner: *"'To collect' list for desk, with money-off-doctor release: yes."* The same day the owner
 * ruled that a visit the desk let through unpaid is an ordinary patient for the doctor, with no
 * mark and no hold (`opd/consultation.ts`, `opd/queue.ts`). The hold was also the only thing that
 * kept such a visit in front of somebody until it paid; this list replaces that, on the DESK's side.
 *
 * WHO IS ON IT: every OPD visit of today and of the seven days before it (IST) that carries a
 * recorded fee bypass — the front desk's (FD-32) or the bay's emergency save — and whose
 * consultation fee is still `unsettled`, whatever became of the visit (waiting, with the doctor,
 * finished, left the queue). An abandoned visit is not owed for and is not listed.
 *
 * WHEN IT LEAVES: DERIVED, never stored — `encounterFeeStatuses` is the ledger, read. The row goes
 * the moment the fee is `settled` (paid, or discounted to nothing by an approved discount),
 * `credit` (credit extended on the bill) or `free` (the fee switch, or the visit re-classified to a
 * free revisit). There is no "clear" button and nothing to forget to clear.
 *
 * THE AMOUNT is what the counter would take now: the outstanding of the fee bill if one stands,
 * otherwise the fee as `feeQuote` prices it. `null` when billing cannot price it — never a guess.
 *
 * NEVER A DOCTOR'S. The route admits the desk's and the cashier's keys only (`billing.invoice.read`,
 * `opd.visits.open`, `billing.dues.patient.read`); the `doctor` role holds none of them.
 */
export const TO_COLLECT_DAYS_BACK = 7;

/** Where the patient is, as a desk needs to know it: most at risk of walking out unpaid first. */
export type ToCollectState = "done" | "left" | "with_doctor" | "waiting";
const RANK: Record<ToCollectState, number> = { done: 0, left: 1, with_doctor: 2, waiting: 3 };

export type ToCollectRow = {
  encounterId: string; visitNo: string; serviceDate: string;
  patientId: string; patientName: string; uhid: string; isConfidential: boolean;
  tokenNo: number | null;
  doctorName: string | null;
  state: ToCollectState;
  /** Paise the counter would take now; null when it cannot be priced. */
  amountDuePaise: number | null;
  letThroughBy: string; letThroughAt: string; reason: string;
  minutesSince: number;
};

function stateOf(encounterStatus: string, entryStatus: string | undefined): ToCollectState {
  if (encounterStatus === "completed") return "done";
  if (encounterStatus === "in_consultation") return "with_doctor";
  return entryStatus === "left" ? "left" : "waiting";
}

function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

async function amountDue(db: Db, encounterId: string, now: Date): Promise<number | null> {
  try {
    const quote = await feeQuote(db, encounterId, now);
    if (quote.feeServiceId === null) return null;
    // A fee bill already raised and not yet paid is collected by ITS outstanding, not re-quoted.
    const bills = await db
      .selectDistinct({ id: invoices.id })
      .from(invoices).innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .where(and(eq(invoices.encounterId, encounterId), eq(invoiceLines.serviceId, quote.feeServiceId)));
    const dead = await enteredInErrorDocIds(db, "invoice", bills.map((b) => b.id));
    const live = bills.filter((b) => !dead.has(b.id));
    if (live.length > 0) {
      let outstanding = 0;
      for (const b of live) outstanding += (await invoiceSettlement(db, b.id)).outstandingPaise;
      return outstanding;
    }
    return quote.draft === null ? null : quote.draft.totals.netPayablePaise;
  } catch (e) {
    if (e instanceof BillingError) return null;
    throw e;
  }
}

export async function toCollectList(db: Db, actor: Actor, now: Date = new Date()): Promise<ToCollectRow[]> {
  const today = istDay(now);
  const encounters = await db
    .select({
      id: opdEncounters.id, visitNo: opdEncounters.visitNo, patientId: opdEncounters.patientId, visitType: opdEncounters.visitType,
      doctorId: opdEncounters.doctorId, serviceDate: opdEncounters.serviceDate, status: opdEncounters.status,
      feeBypassBy: opdEncounters.feeBypassBy, feeBypassReason: opdEncounters.feeBypassReason, feeBypassAt: opdEncounters.feeBypassAt,
    })
    .from(opdEncounters)
    .where(and(
      eq(opdEncounters.type, "opd"), isNotNull(opdEncounters.feeBypassBy), isNotNull(opdEncounters.feeBypassReason),
      gte(opdEncounters.serviceDate, daysBefore(today, TO_COLLECT_DAYS_BACK)), lte(opdEncounters.serviceDate, today),
      ne(opdEncounters.status, "abandoned"),
    ));
  if (encounters.length === 0) return [];
  const statuses = await encounterFeeStatuses(db, encounters);
  const owing = encounters.filter((e) => statuses.get(e.id) === "unsettled");
  if (owing.length === 0) return [];
  const ids = owing.map((e) => e.id);

  const people = await db
    .select({ id: patients.id, name: patients.name, uhid: patients.uhid, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(inArray(patients.id, [...new Set(owing.map((e) => e.patientId))]));
  const personById = new Map(people.map((p) => [p.id, p] as const));
  const doctorIds = [...new Set(owing.map((e) => e.doctorId).filter((d): d is string => d !== null))];
  const doctors = doctorIds.length === 0 ? [] : await db
    .select({ id: opdDoctors.id, displayName: opdDoctors.displayName }).from(opdDoctors).where(inArray(opdDoctors.id, doctorIds));
  const doctorById = new Map(doctors.map((d) => [d.id, d.displayName] as const));
  const staff = await db
    .select({ id: users.id, fullName: users.fullName }).from(users)
    .where(inArray(users.id, [...new Set(owing.map((e) => e.feeBypassBy!))]));
  const staffById = new Map(staff.map((u) => [u.id, u.fullName] as const));
  // The NEWEST queue entry is the visit's place now (seq, never id).
  const entries = await db
    .select({ encounterId: opdQueueEntries.encounterId, tokenNo: opdQueueEntries.tokenNo, status: opdQueueEntries.status })
    .from(opdQueueEntries).where(inArray(opdQueueEntries.encounterId, ids)).orderBy(desc(opdQueueEntries.seq));
  const entryOf = new Map<string, { tokenNo: number; status: string }>();
  for (const e of entries) if (!entryOf.has(e.encounterId)) entryOf.set(e.encounterId, e);
  // The seal and the audit row, exactly as the cashier's worklist beside this keeps them (`worklist.ts`).
  const canSeeConfidential = actor.type === "user" && await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const why = `to-collect list ${today}, ${String(owing.length)} rows`;
  for (const patientId of new Set(owing.map((e) => e.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "billing.collection_worklist", reason: why, sealed: personById.get(patientId)?.isConfidential ?? false });
  }

  const rows: ToCollectRow[] = [];
  for (const e of owing) {
    const person = personById.get(e.patientId);
    if (person === undefined) continue;
    const at = e.feeBypassAt ?? now;
    rows.push({
      encounterId: e.id, visitNo: e.visitNo, serviceDate: e.serviceDate,
      patientId: e.patientId, patientName: displayName(person, canSeeConfidential), uhid: person.uhid, isConfidential: person.isConfidential,
      tokenNo: entryOf.get(e.id)?.tokenNo ?? null,
      doctorName: e.doctorId === null ? null : doctorById.get(e.doctorId) ?? null,
      state: stateOf(e.status, entryOf.get(e.id)?.status),
      amountDuePaise: await amountDue(db, e.id, now),
      letThroughBy: staffById.get(e.feeBypassBy!) ?? e.feeBypassBy!, letThroughAt: at.toISOString(), reason: e.feeBypassReason!,
      minutesSince: Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000)),
    });
  }
  // Gone first (the money most likely to walk out), then with the doctor, then waiting; the longest-owed first within each.
  return rows.sort((a, b) => RANK[a.state] - RANK[b.state] || b.minutesSince - a.minutesSince);
}
