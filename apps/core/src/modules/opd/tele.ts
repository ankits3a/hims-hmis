import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdAppointments } from "../../kernel/db/schema";
import { encodeQr } from "../../kernel/printing/qr";
import { consultFeeAt, loadUpiPayee, recordReceipt, upiPayUri } from "../billing";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { appendEvent } from "../../kernel/events/append";
import { openTeleVisitInTx, TELE_OPEN_ACTOR, visitTypeIn } from "./encounters";
import { teleVisitsOpened } from "./events";
import { istDate } from "./time";
import { OpdError } from "./errors";
import type { AppointmentRow } from "./appointments";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * TELE-CALL — THE DESK'S HALF: WHAT IT COSTS, AND TAKING THE MONEY (owner 2026-10-09)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"Fee: tele-call costs same as in-person visit. tele-call start the free follow-up window like a
 * normal visit."* and *"Doctor will see the patient name in his queue only when the patient have
 * paid."*
 *
 * So the money comes FIRST and the visit second. The desk is quoted what an in-person visit of this
 * patient with this doctor on the slot's date would cost — the same classifier (`visitTypeIn`) and
 * the same pricer the counter uses — and takes exactly that as an ordinary advance receipt in the
 * cashier's own open drawer. The appointment is stamped with the quote and the receipt; that stamp
 * is "covered", and it is honoured at the slot whatever the price list says by then. A ₹0 quote (a
 * follow-up inside the doctor's free window, or consultation switched off) is covered with no
 * receipt at all.
 *
 * EVERYTHING HERE IS DESK-SIDE. Nothing in this file is read by a doctor's screen: an uncovered
 * tele-call has no visit, so it is absent from every doctor read by construction.
 */

/** Covered = the desk's quote was met (a receipt for exactly it, or a ₹0 quote). */
export function teleCovered(a: Pick<AppointmentRow, "advanceQuotedAt">): boolean {
  return a.advanceQuotedAt !== null;
}

/** The statuses in which a tele-call can still be paid for: it holds (or is owed) a slot. */
const PAYABLE = ["booked", "needs_rebooking"];

/** What the consultation costs this appointment's patient on the SLOT's date. */
async function slotQuotePaise(db: Db, a: AppointmentRow): Promise<number> {
  const canonical = (await resolvePatientId(db, a.patientId)) ?? a.patientId;
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const visitType = await visitTypeIn(db, chainIds, a.departmentId, a.slotStart);
  return (await consultFeeAt(db, { patientId: canonical, visitType, at: a.slotStart })).paise;
}

export type TeleFee = {
  appointmentId: string;
  /** The stamped quote once covered; otherwise the price as of the slot's date. */
  amountPaise: number;
  covered: boolean;
  receiptId: string | null;
  /**
   * Owner 2026-10-09 — the hospital's UPI id as a QR for the desk's Collect sheet: present only when
   * a UPI id is set, the appointment still owes something, and the request fits a QR. `qr` is the
   * code's rows, '1' a dark module — encoded HERE by the server's own encoder, so the phone and the
   * counter PC draw the same square and neither needs a library or a network. No link is sent to
   * anyone: the patient scans it at the desk, or pays any way they like and reads out the reference.
   */
  upi: { vpa: string; payeeName: string; uri: string; qr: string[] } | null;
};

async function upiFor(db: Db, a: AppointmentRow, amountPaise: number): Promise<TeleFee["upi"]> {
  if (amountPaise <= 0) return null;
  const payee = await loadUpiPayee(db);
  if (payee === null) return null;
  const uri = upiPayUri(payee, amountPaise, a.appointmentNo);
  try {
    return { vpa: payee.vpa, payeeName: payee.payeeName, uri, qr: encodeQr(uri).map((row) => row.map((dark) => (dark ? "1" : "0")).join("")) };
  } catch {
    return null; // longer than the encoder takes: no QR, counter collection only
  }
}

async function loadTele(db: Db, appointmentId: string): Promise<AppointmentRow> {
  const a = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0];
  if (!a) throw new OpdError("unknown_appointment", `unknown appointment ${appointmentId}`);
  if (a.mode !== "tele") throw new OpdError("not_a_tele_appointment", "only a tele-call is paid for before its slot");
  return a;
}

export async function teleFee(db: Db, appointmentId: string): Promise<TeleFee> {
  const a = await loadTele(db, appointmentId);
  if (teleCovered(a)) return { appointmentId, amountPaise: a.advanceQuotePaise ?? 0, covered: true, receiptId: a.advanceReceiptId, upi: null };
  const amountPaise = await slotQuotePaise(db, a);
  return { appointmentId, amountPaise, covered: false, receiptId: null, upi: PAYABLE.includes(a.status) ? await upiFor(db, a, amountPaise) : null };
}

/**
 * The desk list's money mark for each tele row — DESK-ONLY. One quote per uncovered live row; a
 * quote that cannot be made (no price list yet) is `null`, and the row simply shows no amount.
 */
export type TeleDeskMark = { amountPaise: number | null; covered: boolean };
export async function teleDeskMarks(db: Db, rows: readonly AppointmentRow[]): Promise<Map<string, TeleDeskMark>> {
  const out = new Map<string, TeleDeskMark>();
  for (const a of rows) {
    if (a.mode !== "tele") continue;
    if (teleCovered(a)) { out.set(a.id, { amountPaise: a.advanceQuotePaise ?? 0, covered: true }); continue; }
    if (!PAYABLE.includes(a.status)) { out.set(a.id, { amountPaise: null, covered: false }); continue; }
    let amountPaise: number | null = null;
    try { amountPaise = await slotQuotePaise(db, a); } catch { amountPaise = null; }
    out.set(a.id, { amountPaise, covered: false });
  }
  return out;
}

export type TeleTender = { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string };
export type TeleAdvanceInput = { amountPaise: number; tenders?: TeleTender[] };
export type TeleAdvanceResult = {
  /** True when the slot had already been reached and this payment opened the visit in the same request. */
  opened: boolean;
  appointment: AppointmentRow;
  amountPaise: number;
  receiptId: string | null;
  receiptNo: string | null;
};

/**
 * Takes the tele-call's fee: ONE advance receipt for exactly the quote, in the acting cashier's
 * open drawer (billing's `recordReceipt`, unchanged — the cash law and the drawer are its own).
 *
 * The appointment row is held FOR UPDATE for the whole act, so two desks collecting for one
 * appointment are served one after the other and the second is told it is already paid — before
 * any money is written for it.
 */
export async function recordTeleAdvance(
  db: Db, actor: Actor, appointmentId: string, input: TeleAdvanceInput, now: Date = new Date(),
): Promise<TeleAdvanceResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  await loadTele(db, appointmentId); // unknown / not tele, before a lock is taken
  const paid = await withTx(db, async (tx) => {
    const a = (await tx.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)).for("update"))[0]!;
    if (teleCovered(a)) throw new OpdError("tele_advance_state_conflict", "This tele-call is already paid for", { receiptId: a.advanceReceiptId });
    if (!PAYABLE.includes(a.status)) throw new OpdError("tele_advance_state_conflict", `a ${a.status} appointment cannot be paid for`);

    const quotePaise = await slotQuotePaise(db, a);
    if (input.amountPaise !== quotePaise) {
      throw new OpdError("tele_amount_mismatch", `the fee for this tele-call is ₹${(quotePaise / 100).toFixed(2)} — read it again and collect exactly that`, { expectedPaise: quotePaise });
    }
    const tenders = input.tenders ?? [];
    let receipt: { receiptId: string; receiptNo: string } | null = null;
    if (quotePaise > 0) {
      const total = tenders.reduce((sum, t) => sum + t.amountPaise, 0);
      if (total !== quotePaise) {
        throw new OpdError("tele_amount_mismatch", "the tenders must add up to exactly the fee", { expectedPaise: quotePaise });
      }
      if (tenders.some((t) => t.mode === "upi" && (t.refText ?? "").trim() === "")) {
        throw new OpdError("tele_upi_reference_required", "Enter the UPI reference of the payment");
      }
      // Billing's own act and its own transaction: no open drawer, the cash law — its refusals, unchanged.
      receipt = await recordReceipt(db, actor, {
        patientId: (await resolvePatientId(db, a.patientId)) ?? a.patientId,
        tenders: tenders.map((t) => ({ mode: t.mode, amountPaise: t.amountPaise, ...((t.refText ?? "").trim() === "" ? {} : { refText: t.refText!.trim() }) })),
        note: `Tele-call ${a.appointmentNo}`,
      }, now);
    }
    const stamped = await tx.update(opdAppointments)
      .set({ advanceReceiptId: receipt?.receiptId ?? null, advanceQuotePaise: quotePaise, advanceQuotedAt: now, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdAppointments.id, appointmentId), isNull(opdAppointments.advanceQuotedAt)))
      .returning();
    return { opened: false, appointment: stamped[0]!, amountPaise: quotePaise, receiptId: receipt?.receiptId ?? null, receiptNo: receipt?.receiptNo ?? null };
  });
  /*
    A PAYMENT AFTER THE SLOT OPENS THE VISIT IN THIS REQUEST — the patient is on the telephone to the
    desk now, and a minute's wait for the job is a minute the doctor's line is wrong. A failure here
    costs nothing: the money is in, the appointment is covered, and the job opens it on its next tick.
  */
  let opened = false;
  try { opened = (await openTeleVisitFor(db, appointmentId, now)).opened; } catch { opened = false; }
  if (!opened) return paid;
  const fresh = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0]!;
  return { ...paid, opened: true, appointment: fresh };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPEN AT THE SLOT — the visit exists only when the slot has come AND the desk has been paid
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Due = a tele-call still `booked`, for today, whose slot has been reached, and which is covered. */
function dueNow(a: AppointmentRow, now: Date): boolean {
  return a.mode === "tele" && a.status === "booked" && a.serviceDate === istDate(now)
    && a.slotStart.getTime() <= now.getTime() && teleCovered(a);
}

/**
 * Opens ONE due tele-call's visit. IDEMPOTENT: the appointment is claimed `booked → checked_in`
 * first, so a second caller (the job racing the desk's payment) claims nothing and opens nothing.
 * An appointment that is not due — unpaid, early, another day, already opened — answers
 * `opened: false` and writes nothing: it is absent from every doctor read by construction.
 */
export async function openTeleVisitFor(db: Db, appointmentId: string, now: Date = new Date()): Promise<{ opened: boolean; encounterId: string | null }> {
  const a = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0];
  if (!a || !dueNow(a, now)) return { opened: false, encounterId: null };
  const canonical = await resolvePatientId(db, a.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${a.patientId}`);
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  return withTx(db, async (tx) => {
    const claimed = await tx.update(opdAppointments)
      .set({ status: "checked_in", updatedBy: TELE_OPEN_ACTOR.id, updatedAt: now })
      .where(and(eq(opdAppointments.id, appointmentId), eq(opdAppointments.status, "booked"), isNotNull(opdAppointments.advanceQuotedAt)))
      .returning({ id: opdAppointments.id });
    if (claimed.length === 0) return { opened: false, encounterId: null };
    const result = await openTeleVisitInTx(tx, {
      patientId: canonical, departmentId: a.departmentId, doctorId: a.doctorId,
      appointment: { id: appointmentId, slotStart: a.slotStart }, chainIds,
    }, now);
    await tx.update(opdAppointments).set({ encounterId: result.encounter.id }).where(eq(opdAppointments.id, appointmentId));
    return { opened: true, encounterId: result.encounter.id };
  });
}

/**
 * The minute job. Each due appointment is opened in its OWN transaction, so one that cannot open (a
 * doctor made inactive, a department closed) does not stop the rest; it stays `booked` and is tried
 * again next tick, and the nightly sweep sends a paid one that never opened to the re-booking list.
 * The summary event carries counts only, and is written only for a tick that found something due.
 */
export async function openDueTeleVisits(db: Db, now: Date = new Date()): Promise<{ due: number; opened: number; failed: number }> {
  const serviceDate = istDate(now);
  /*
    NOTHING TO PAY NEEDS NOBODY. A due tele-call the desk has not touched is priced here; when the
    answer is ₹0 — a follow-up inside the doctor's free window, or consultation switched off — it is
    covered by that answer and opens like any other. One that costs anything is left exactly as it
    is: unpaid, and so absent. A quote that cannot be made is not a zero.
  */
  const untouched = await db.select().from(opdAppointments)
    .where(and(
      eq(opdAppointments.mode, "tele"), eq(opdAppointments.status, "booked"), eq(opdAppointments.serviceDate, serviceDate),
      lte(opdAppointments.slotStart, now), isNull(opdAppointments.advanceQuotedAt),
    ));
  for (const a of untouched) {
    let paise: number | null = null;
    try { paise = await slotQuotePaise(db, a); } catch { paise = null; }
    if (paise !== 0) continue;
    await db.update(opdAppointments)
      .set({ advanceQuotePaise: 0, advanceQuotedAt: now, updatedBy: TELE_OPEN_ACTOR.id, updatedAt: now })
      .where(and(eq(opdAppointments.id, a.id), eq(opdAppointments.status, "booked"), isNull(opdAppointments.advanceQuotedAt)));
  }
  const due = await db.select({ id: opdAppointments.id }).from(opdAppointments)
    .where(and(
      eq(opdAppointments.mode, "tele"), eq(opdAppointments.status, "booked"), eq(opdAppointments.serviceDate, serviceDate),
      lte(opdAppointments.slotStart, now), isNotNull(opdAppointments.advanceQuotedAt),
    ))
    .orderBy(asc(opdAppointments.slotStart));
  let opened = 0; let failed = 0;
  for (const row of due) {
    try {
      if ((await openTeleVisitFor(db, row.id, now)).opened) opened += 1;
    } catch {
      failed += 1;
    }
  }
  if (due.length > 0) {
    await withTx(db, (tx) => appendEvent(tx, teleVisitsOpened.make({
      actor: TELE_OPEN_ACTOR, payload: { serviceDate, due: due.length, opened, failed },
    })));
  }
  return { due: due.length, opened, failed };
}
