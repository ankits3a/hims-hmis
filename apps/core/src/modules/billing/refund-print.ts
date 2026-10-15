import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { creditNotes, invoices, refundVouchers, users } from "../../kernel/db/schema";
import { CREST_PNG_DATA_URI } from "../../kernel/printing/crest";
import { HOSPITAL, esc, registerDocumentRenderer } from "../../kernel/printing/document-kit";
import type { RenderedDocument } from "../../kernel/printing/document-kit";
import { getPatientSummaries } from "../patients";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #655 — THE PRINTED REFUND VOUCHER ═══
 *
 * Board "Billing back office", step 6: *"Print the voucher and take a signature. The printed voucher
 * carries RFV/26-27/000004, the amount in words, and a line for the payee's signature."* Owner ruling
 * 2026-09-04: printing is server-side — `payRefundVoucher` queues `billing_refund_voucher` in the
 * payment's own transaction, the relay (or the counter's browser, decision 0045) prints THIS rendering.
 *
 * WHAT IS NOT ON IT: no ID number of any kind. The voucher names the TYPE of document the payee showed
 * (owner ruling 2026-09-28: Aadhaar is never stored, and no number is ever shown back), and the
 * relation of whoever collected for the patient.
 *
 * A voucher that is not paid renders NOTHING: the paper is the record that money left.
 */

const ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0–99 in words. */
function two(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? t : `${t} ${ONES[n % 10]!}`;
}
/** 0–999 in words; "" for 0. */
function three(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h > 0 ? `${ONES[h]!} Hundred` : "", r > 0 ? two(r) : ""].filter((x) => x !== "").join(" ");
}

/** Whole rupees in the Indian grouping: crore, lakh, thousand, hundred. */
function rupeeWords(rupees: number): string {
  if (rupees === 0) return "Zero";
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1_000);
  const rest = rupees % 1_000;
  return [
    crore > 0 ? `${crore >= 100 ? rupeeWords(crore) : two(crore)} Crore` : "",
    lakh > 0 ? `${two(lakh)} Lakh` : "",
    thousand > 0 ? `${two(thousand)} Thousand` : "",
    three(rest),
  ].filter((x) => x !== "").join(" ");
}

/** "Rupees Two Thousand Four Hundred Only"; "… and Fifty Paise Only" when there are paise. */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${rupeeWords(rupees)}${p > 0 ? ` and ${two(p)} Paise` : ""} Only`;
}

const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ID_WORDS: Record<string, string> = {
  aadhaar: "Aadhaar card", pan: "PAN card", voter_id: "Voter ID", driving_licence: "Driving licence", passport: "Passport",
};
const idWords = (t: string | null): string => (t === null ? "—" : ID_WORDS[t] ?? t);

const dateTime = (d: Date): string =>
  d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "")
    // The house date: 28-Sep-2026 (board "Money reads as money").
    .replace(/^(\d{2}) (\w{3}) (\d{4})/, "$1-$2-$3");

const CSS = `
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 13px; line-height: 18px; color: #000; }
  .num { font-variant-numeric: tabular-nums; }
  .sheet { width: 210mm; height: 296.8mm; padding: 26px 30px 20px; display: flex; flex-direction: column; overflow: hidden; }
  .hd { display: flex; gap: 20px; align-items: flex-start; }
  .hd img { width: 70px; height: auto; display: block; }
  .nm { font-size: 17px; font-weight: 700; line-height: 22px; }
  .ad { font-size: 11.5px; color: #333; margin-top: 2px; }
  .rule { height: 1px; background: #000; margin: 10px 0 0; }
  h1 { font-size: 18px; letter-spacing: .06em; text-transform: uppercase; margin: 14px 0 4px; }
  .no { font-size: 14px; font-weight: 700; }
  table.kv { width: 100%; border-collapse: collapse; margin-top: 14px; }
  table.kv td { border: 1px solid #000; padding: 7px 10px; vertical-align: top; }
  table.kv td.k { width: 32%; background: #f2f2f2; font-weight: 700; }
  .amt { font-size: 18px; font-weight: 700; }
  .words { font-style: italic; }
  .sp { flex-grow: 1; }
  .sig { display: flex; justify-content: space-between; gap: 40px; margin-top: 60px; }
  .sig .b { flex: 1; }
  .sig .line { height: 1px; background: #000; margin-bottom: 4px; }
  .sig .c { font-size: 11px; color: #333; }
  .ft { font-size: 11px; padding-top: 12px; }
`;

/** The renderer for `billing_refund_voucher`. Pure of the clock: what it prints is the stored payment. */
export async function renderRefundVoucher(
  db: Db, params: Record<string, unknown>, _now: Date, requester: Actor | null,
): Promise<RenderedDocument | null> {
  const voucherId = typeof params.voucherId === "string" ? params.voucherId : null;
  if (voucherId === null) return null;
  const [v] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, voucherId));
  if (v === undefined || v.status !== "paid" || v.paidAt === null) return null;

  // FD-25 — no requester on record defaults to the ALIAS for a sealed patient, as the kernel's own papers do:
  // an actor that holds no grant (never `system`, which sees through the seal).
  const [who] = await getPatientSummaries(db, requester ?? { type: "agent", id: "print-relay" }, [v.patientId]);
  const patient = who === undefined ? "—" : who.restricted ? who.alias ?? "—" : who.name ?? "—";
  const inv = v.invoiceId === null ? undefined : (await db.select({ no: invoices.invoiceNo }).from(invoices).where(eq(invoices.id, v.invoiceId)))[0];
  const cn = v.creditNoteId === null ? undefined : (await db.select({ no: creditNotes.creditNoteNo }).from(creditNotes).where(eq(creditNotes.id, v.creditNoteId)))[0];
  const payer = v.paidBy === null ? undefined : (await db.select({ name: users.fullName }).from(users).where(eq(users.id, v.paidBy)))[0];

  const row = (k: string, val: string): string => `<tr><td class="k">${esc(k)}</td><td>${val}</td></tr>`;
  const against = v.kind === "invoice_refund"
    ? `Bill <span class="num">${esc(inv?.no ?? "—")}</span>${cn === undefined ? "" : ` · credit note <span class="num">${esc(cn.no)}</span>`}`
    : "Advance balance";
  const collector = v.payeeRelation === null
    ? esc(v.payeeName ?? "—")
    : `${esc(v.payeeName ?? "—")} — ${esc(v.payeeRelation)} of the patient`;

  const body = `
    <div class="sheet">
      <div class="hd">
        <img src="${CREST_PNG_DATA_URI}" alt="${HOSPITAL.nameTitleCase}">
        <div><div class="nm">${HOSPITAL.nameTitleCase}</div><div class="ad">${HOSPITAL.address} · ${HOSPITAL.contact}</div></div>
      </div>
      <div class="rule"></div>
      <h1>Refund voucher</h1>
      <div class="no num">${esc(v.voucherNo)}</div>
      <table class="kv">
        ${row("Patient", `${esc(patient)}${who === undefined ? "" : ` · UHID <span class="num">${esc(who.uhid)}</span>`}`)}
        ${row("Refund against", against)}
        ${row("Amount", `<span class="amt num">${esc(rupees(v.amountPaise))}</span><br><span class="words">${esc(rupeesInWords(v.amountPaise))}</span>`)}
        ${row("Paid by", esc(v.method === "cash" ? "Cash" : "Bank transfer"))}
        ${row("Paid on", `<span class="num">${esc(dateTime(v.paidAt))}</span>${payer === undefined ? "" : ` · ${esc(payer.name)}`}`)}
        ${row("Received by", collector)}
        ${row("Identity shown", esc(idWords(v.payeeIdType)))}
      </table>
      <div class="sig">
        <div class="b"><div class="line"></div><div class="c">Signature of the payee</div></div>
        <div class="b"><div class="line"></div><div class="c">Signature of the cashier</div></div>
      </div>
      <div class="sp"></div>
      <div class="ft"><div class="rule"></div>Received the amount above in full. Printed from the voucher record.</div>
    </div>`;
  return {
    title: `Refund voucher ${v.voucherNo}`,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refund voucher</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}

/** Registered by `BillingModule.onModuleInit`; exported so a suite can register it without Nest. Returns the unregister. */
export function registerBillingPrinting(): () => void {
  return registerDocumentRenderer("billing_refund_voucher", renderRefundVoucher);
}
