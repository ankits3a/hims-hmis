import { and, eq, isNull } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdAppointments } from "../../kernel/db/schema";
import { consultFeeAt, recordReceipt } from "../billing";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { visitTypeIn } from "./encounters";
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
};

async function loadTele(db: Db, appointmentId: string): Promise<AppointmentRow> {
  const a = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0];
  if (!a) throw new OpdError("unknown_appointment", `unknown appointment ${appointmentId}`);
  if (a.mode !== "tele") throw new OpdError("not_a_tele_appointment", "only a tele-call is paid for before its slot");
  return a;
}

export async function teleFee(db: Db, appointmentId: string): Promise<TeleFee> {
  const a = await loadTele(db, appointmentId);
  if (teleCovered(a)) return { appointmentId, amountPaise: a.advanceQuotePaise ?? 0, covered: true, receiptId: a.advanceReceiptId };
  return { appointmentId, amountPaise: await slotQuotePaise(db, a), covered: false, receiptId: null };
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
  return withTx(db, async (tx) => {
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
    return { appointment: stamped[0]!, amountPaise: quotePaise, receiptId: receipt?.receiptId ?? null, receiptNo: receipt?.receiptNo ?? null };
  });
}
