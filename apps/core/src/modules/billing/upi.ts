import { eq } from "drizzle-orm";
import { billingConfig } from "../../kernel/db/schema";
import { BillingError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE HOSPITAL'S UPI ID (owner 2026-10-09) ═══
 *
 * *"UPI link and QR to the hospital's UPI id. Without a payment company, the cashier confirms the
 * money and marks it paid."* Two columns on `billing_config`, read and written by these two
 * functions — NEW functions beside the config loader, whose signature and shape are untouched.
 *
 * Nothing here moves money or talks to a bank. The id is only what a QR code names as the payee;
 * the payment is the patient's own, in their own app, and the hospital learns of it the way it
 * learns of every UPI payment today: the cashier sees it and types its reference on the receipt.
 */
export type UpiPayee = { vpa: string; payeeName: string };

/** `name@handle` — the NPCI shape: letters, digits, dot, hyphen, underscore; then a bank handle. */
const VPA = /^[a-zA-Z0-9._-]{2,60}@[a-zA-Z0-9]{2,40}$/;
export const UPI_PAYEE_NAME_MAX = 40;

export async function loadUpiPayee(db: Db | Tx): Promise<UpiPayee | null> {
  const row = (await db.select({ vpa: billingConfig.upiVpa, payeeName: billingConfig.upiPayeeName }).from(billingConfig).where(eq(billingConfig.id, "main")))[0];
  if (!row || row.vpa === null || row.vpa.trim() === "") return null;
  return { vpa: row.vpa, payeeName: (row.payeeName ?? "").trim() };
}

/** Sets or clears (a blank or null id) the hospital's UPI id. A malformed id is refused, not stored. */
export async function setUpiPayee(db: Db | Tx, input: { vpa: string | null; payeeName?: string | null }, now: Date = new Date()): Promise<UpiPayee | null> {
  const vpa = (input.vpa ?? "").trim();
  const payeeName = (input.payeeName ?? "").trim();
  if (vpa !== "" && !VPA.test(vpa)) throw new BillingError("invalid_upi_id", "a UPI id reads name@bank — letters, digits, dot, hyphen and underscore before the @");
  if (payeeName.length > UPI_PAYEE_NAME_MAX) throw new BillingError("invalid_upi_id", `the payee name is at most ${UPI_PAYEE_NAME_MAX} characters`);
  const rows = await db.update(billingConfig)
    .set({ upiVpa: vpa === "" ? null : vpa, upiPayeeName: vpa === "" || payeeName === "" ? null : payeeName, updatedAt: now })
    .where(eq(billingConfig.id, "main")).returning({ id: billingConfig.id });
  if (rows.length === 0) throw new BillingError("billing_not_configured", "billing_config row 'main' is missing — run seed:billing");
  return loadUpiPayee(db);
}

/**
 * The payment request a UPI app reads from a QR: the payee, the exact amount in rupees and paise,
 * and the appointment number as the note — so the reference the cashier is shown names the booking.
 */
export function upiPayUri(payee: UpiPayee, amountPaise: number, note: string): string {
  const q = [
    `pa=${encodeURIComponent(payee.vpa)}`,
    ...(payee.payeeName === "" ? [] : [`pn=${encodeURIComponent(payee.payeeName)}`]),
    `am=${upiAmount(amountPaise)}`,
    "cu=INR",
    `tn=${encodeURIComponent(note)}`,
  ];
  return `upi://pay?${q.join("&")}`;
}

/** Paise as the UPI `am` field ("250.00"), in integers only — billing does no float arithmetic (billing-purity.test.ts). */
function upiAmount(amountPaise: number): string {
  const whole = Math.trunc(amountPaise / 100);
  const rest = Math.abs(amountPaise % 100);
  return `${whole}.${String(rest).padStart(2, "0")}`;
}
