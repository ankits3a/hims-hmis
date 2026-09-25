import { createHash } from "node:crypto";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { pharmacyTallyConfig, pharmacyTallyExports } from "../../kernel/db/schema";
import { receiptAllocationsBetween, refundVouchersPaidBetween } from "../billing";
import { purchaseAdjustmentsBetween, purchaseRegister, supplierPaymentsBetween } from "../materials";
import { userNames } from "./queue";
import { PharmacyError } from "./errors";
import { reportRange, reportToday, requireReportPermission } from "./report-range";
import { pharmacySalesPeriod } from "./sales-register";
import type { ReportInput } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE TALLY EXPORT (TallyPrime XML, owner ruling 2026-09-25) ═══
 *
 * Our app is the payables book of record (owner, 2026-09-24); the hospital's accounts are kept in
 * TallyPrime. So the office hands the accountant every pharmacy voucher of a period as a TallyPrime
 * "Import Data" file — ENVELOPE → HEADER (TALLYREQUEST `Import Data`) → BODY → IMPORTDATA →
 * REQUESTDESC (REPORTNAME `Vouchers`) → REQUESTDATA → TALLYMESSAGE → VOUCHER — and a second file of
 * the ledgers those vouchers name (REPORTNAME `All Masters`), imported first so no voucher meets an
 * unknown ledger.
 *
 * THE VOUCHERS, each on OUR stable number and date:
 *   - Sales        a pharmacy bill (`INV/…`, its service day): Dr the patient, Cr sales, Output CGST
 *                  and SGST, the rupee rounding to Round Off;
 *   - Credit Note  a credit note against one (`CN/…`, its issue day): the same, reversed;
 *   - Receipt      the money taken for pharmacy bills (`RCP/…`): Dr Cash (cash) and Bank (UPI, card),
 *                  Cr the patient — without it every patient would stay a debtor in Tally for ever;
 *   - Payment      a refund voucher paid against a pharmacy credit note (`RFV/…`): Dr the patient,
 *                  Cr Cash or Bank; and every supplier payment (`MPV…`, its paid-on date): Dr the
 *                  vendor, Cr Cash (mode cash) or Bank (NEFT, RTGS, UPI, cheque);
 *   - Purchase     a supplier bill booked as payable (`MSB…`, the bill date; the vendor's own number
 *                  as REFERENCE): Dr purchases and Input CGST / SGST or IGST, Cr the vendor;
 *   - Debit Note   our debit note on a return (`MDN…`): Dr the vendor, Cr purchases and the input tax;
 *   - Journal      the vendor credit note adjustment: what a debit note will not get back — a vendor
 *                  credit short of it (`MCN…`) or a return closed without credit (`MRT…`): Dr Purchase
 *                  Return Shortfall, Cr the vendor. (A credit equal to the debit note moves nothing in
 *                  Tally: the debit note already reduced the vendor.)
 *
 * TALLY'S SIGN: a debit is `ISDEEMEDPOSITIVE Yes` with a NEGATIVE amount, a credit `No` and positive.
 * Every voucher must balance (the amounts sum to zero); one that did not would be a defect here, so the
 * build refuses the whole file (`tally_unbalanced`) rather than hand Tally a voucher it would reject.
 *
 * LEDGER NAMES are the accountant's (`pharmacy_tally_config`, edited on the settings screen): the
 * defaults are names, not the hospital's company, so the export refuses until the mapping has been
 * confirmed once (`tally_ledgers_unconfirmed`; census row `pharmacy_tally_ledgers_confirmed`). A party
 * is the vendor's name, and the patient's name with the UHID (or one "patients" ledger, the
 * accountant's choice).
 *
 * EVERY EXPORT IS RECORDED (`pharmacy_tally_exports`: the range, who, when, how many of each voucher,
 * the SHA-256 of the vouchers file, the mapping used, and both files) — so a re-export of a range is
 * visible before it is made, and an earlier file downloads again byte for byte. Each VOUCHER carries a
 * stable REMOTEID (`hmis:<kind>:<our id>`), so TallyPrime alters rather than duplicates a voucher it
 * has already imported.
 */
export const TALLY_EXPORT = "pharmacy.tally.export";

export type TallyLedgers = {
  companyName: string;
  sales: string; salesReturns: string; outputCgst: string; outputSgst: string;
  purchases: string; purchaseReturns: string; inputCgst: string; inputSgst: string; inputIgst: string;
  cash: string; bank: string; roundOff: string; returnShortfall: string;
  /** `patient`: each patient their own debtor, "Name (UHID)"; `single`: every pharmacy patient on `patientLedger`. */
  patientParty: "patient" | "single";
  patientLedger: string;
};

/** The spec's defaults (and the owner's ruling's words); the accountant confirms or renames each before the first export. */
export const DEFAULT_TALLY_LEDGERS: TallyLedgers = {
  companyName: "",
  sales: "Pharmacy Sales", salesReturns: "Pharmacy Sales", outputCgst: "Output CGST", outputSgst: "Output SGST",
  purchases: "Purchase — Medicines", purchaseReturns: "Purchase — Medicines", inputCgst: "Input CGST", inputSgst: "Input SGST", inputIgst: "Input IGST",
  cash: "Cash", bank: "Bank", roundOff: "Round Off", returnShortfall: "Purchase Return Shortfall",
  patientParty: "patient", patientLedger: "Pharmacy Patients",
};

const LEDGER_KEYS = [
  "sales", "salesReturns", "outputCgst", "outputSgst", "purchases", "purchaseReturns", "inputCgst", "inputSgst", "inputIgst",
  "cash", "bank", "roundOff", "returnShortfall", "patientLedger",
] as const;

/** The Tally group each ledger is created under in the masters file. */
const GROUP: Record<(typeof LEDGER_KEYS)[number], string> = {
  sales: "Sales Accounts", salesReturns: "Sales Accounts", outputCgst: "Duties & Taxes", outputSgst: "Duties & Taxes",
  purchases: "Purchase Accounts", purchaseReturns: "Purchase Accounts", inputCgst: "Duties & Taxes", inputSgst: "Duties & Taxes",
  inputIgst: "Duties & Taxes", cash: "Cash-in-Hand", bank: "Bank Accounts", roundOff: "Indirect Expenses", returnShortfall: "Indirect Expenses",
  patientLedger: "Sundry Debtors",
};

export function cleanLedgers(input: Partial<TallyLedgers>): TallyLedgers {
  const out = { ...DEFAULT_TALLY_LEDGERS, ...input };
  for (const k of LEDGER_KEYS) {
    const v = String(out[k] ?? "").trim().replace(/\s+/g, " ");
    if (v === "" || v.length > 100) throw new PharmacyError("invalid_tally_ledgers", `the ${k} ledger needs a name of 1–100 characters`, { field: k });
    out[k] = v;
  }
  out.companyName = String(out.companyName ?? "").trim().slice(0, 100);
  if (out.patientParty !== "patient" && out.patientParty !== "single") throw new PharmacyError("invalid_tally_ledgers", "patient party is `patient` or `single`", { field: "patientParty" });
  return out;
}

export type TallyLedgerState = { ledgers: TallyLedgers; confirmed: boolean; updatedBy: string | null; updatedAt: string | null };

/** The mapping as saved, or the defaults — and whether anybody has confirmed it. */
export async function tallyLedgers(db: Db, actor: Actor): Promise<TallyLedgerState> {
  await requireReportPermission(db, actor, TALLY_EXPORT, "the Tally ledgers");
  return readLedgers(db);
}

async function readLedgers(db: Db): Promise<TallyLedgerState> {
  const [row] = await db.select().from(pharmacyTallyConfig).where(eq(pharmacyTallyConfig.id, "main"));
  if (row === undefined) return { ledgers: DEFAULT_TALLY_LEDGERS, confirmed: false, updatedBy: null, updatedAt: null };
  const names = await userNames(db, [row.updatedBy]);
  return { ledgers: cleanLedgers(row.ledgers as Partial<TallyLedgers>), confirmed: true, updatedBy: names.get(row.updatedBy) ?? row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}

/** The accountant saves the mapping (which is also confirming it). */
export async function saveTallyLedgers(db: Db, actor: Actor, input: Partial<TallyLedgers>, now: Date = new Date()): Promise<TallyLedgerState> {
  await requireReportPermission(db, actor, TALLY_EXPORT, "saving the Tally ledgers");
  const ledgers = cleanLedgers(input);
  await db.insert(pharmacyTallyConfig).values({ id: "main", ledgers, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: pharmacyTallyConfig.id, set: { ledgers, updatedBy: actor.id, updatedAt: now } });
  return readLedgers(db);
}

/** Census: the accountant has confirmed the ledger names at least once. */
export async function tallyLedgersConfirmed(db: Db): Promise<boolean> {
  return (await db.select({ id: pharmacyTallyConfig.id }).from(pharmacyTallyConfig).limit(1)).length > 0;
}

// ═══════════════════════════════════ the vouchers, pure ═══════════════════════════════════

export type TallyVoucherType = "Sales" | "Credit Note" | "Receipt" | "Payment" | "Purchase" | "Debit Note" | "Journal";
export type TallyVoucherKind =
  | "sale" | "sales_return" | "receipt" | "refund" | "purchase" | "purchase_return" | "supplier_payment" | "credit_shortfall" | "return_closed";
export const TALLY_KINDS: readonly TallyVoucherKind[] = [
  "sale", "sales_return", "receipt", "refund", "purchase", "purchase_return", "supplier_payment", "credit_shortfall", "return_closed",
];
const TYPE_OF: Record<TallyVoucherKind, TallyVoucherType> = {
  sale: "Sales", sales_return: "Credit Note", receipt: "Receipt", refund: "Payment", purchase: "Purchase",
  purchase_return: "Debit Note", supplier_payment: "Payment", credit_shortfall: "Journal", return_closed: "Journal",
};

/** One line of a voucher: `amountPaise` > 0 is a DEBIT, < 0 a credit (the internal sign; Tally's is flipped in the XML). */
export type TallyEntry = { ledger: string; amountPaise: number; party: boolean };
export type TallyVoucher = {
  kind: TallyVoucherKind; type: TallyVoucherType; remoteId: string; number: string; date: string; reference: string | null;
  party: string; narration: string; entries: TallyEntry[];
};
/** A party ledger the masters file creates: its group and, for a vendor, its GSTIN. */
export type TallyParty = { name: string; group: "Sundry Debtors" | "Sundry Creditors"; gstin: string | null };

type Build = { vouchers: TallyVoucher[]; parties: Map<string, TallyParty> };

function voucher(b: Build, kind: TallyVoucherKind, v: Omit<TallyVoucher, "kind" | "type" | "entries">, entries: TallyEntry[]): void {
  const kept = entries.filter((e) => e.amountPaise !== 0);
  const sum = kept.reduce((s, e) => s + e.amountPaise, 0);
  if (sum !== 0) {
    throw new PharmacyError("tally_unbalanced", `voucher ${v.number} (${TYPE_OF[kind]}) does not balance by ${String(sum)} paise — nothing was exported`, { number: v.number, kind, sum });
  }
  b.vouchers.push({ kind, type: TYPE_OF[kind], ...v, entries: kept });
}
const dr = (ledger: string, paise: number, party = false): TallyEntry => ({ ledger, amountPaise: paise, party });
const cr = (ledger: string, paise: number, party = false): TallyEntry => ({ ledger, amountPaise: -paise, party });
/** A rounding or round-off as the entry that closes the voucher: a positive amount is income (credit). */
const roundOffEntry = (ledger: string, incomePaise: number): TallyEntry => ({ ledger, amountPaise: -incomePaise, party: false });

export type TallySource = {
  sales: { id: string; no: string; date: string; ref: string | null; patient: { name: string; uhid: string }; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number }[];
  salesReturns: { id: string; no: string; date: string; invoiceNo: string; patient: { name: string; uhid: string }; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number }[];
  receipts: { id: string; no: string; date: string; patient: { name: string; uhid: string }; invoiceNos: string[]; cashPaise: number; bankPaise: number }[];
  refunds: { id: string; no: string; date: string; patient: { name: string; uhid: string }; invoiceNo: string | null; amountPaise: number; cash: boolean }[];
  purchases: { id: string; no: string; date: string; vendorBillNo: string; vendor: { name: string; gstin: string | null }; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number }[];
  debitNotes: { id: string; no: string; date: string; returnNo: string | null; vendor: { name: string; gstin: string | null }; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }[];
  supplierPayments: { id: string; no: string; date: string; vendor: { name: string; gstin: string | null }; mode: string; reference: string | null; amountPaise: number; bills: string[] }[];
  adjustments: { kind: "short_credit" | "closed"; id: string; no: string; date: string; ref: string | null; reason: string | null; vendor: { name: string; gstin: string | null }; amountPaise: number }[];
};

/**
 * THE VOUCHERS OF A PERIOD, PURE: our documents in, balanced Tally vouchers out, in date order and,
 * on one day, sales and their receipts first, then refunds, then purchases, returns, adjustments and
 * payments. Throws `tally_unbalanced` on the first voucher that would not balance.
 */
export function buildVouchers(src: TallySource, l: TallyLedgers): { vouchers: TallyVoucher[]; parties: TallyParty[] } {
  const b: Build = { vouchers: [], parties: new Map() };
  const patient = (p: { name: string; uhid: string }): string => {
    const name = l.patientParty === "single" ? l.patientLedger : `${p.name} (${p.uhid})`;
    b.parties.set(name, { name, group: "Sundry Debtors", gstin: null });
    return name;
  };
  const vendor = (v: { name: string; gstin: string | null }): string => {
    b.parties.set(v.name, { name: v.name, group: "Sundry Creditors", gstin: v.gstin ?? b.parties.get(v.name)?.gstin ?? null });
    return v.name;
  };
  for (const s of src.sales) {
    const party = patient(s.patient);
    voucher(b, "sale", { remoteId: `hmis:sale:${s.id}`, number: s.no, date: s.date, reference: s.ref, party, narration: `Pharmacy bill ${s.no}${s.ref === null ? "" : ` (dispense ${s.ref})`}` }, [
      dr(party, s.netPaise, true), cr(l.sales, s.taxablePaise), cr(l.outputCgst, s.cgstPaise), cr(l.outputSgst, s.sgstPaise), roundOffEntry(l.roundOff, s.roundingPaise),
    ]);
  }
  for (const r of src.receipts) {
    const party = patient(r.patient);
    voucher(b, "receipt", { remoteId: `hmis:receipt:${r.id}`, number: r.no, date: r.date, reference: r.invoiceNos.join(", "), party, narration: `Received against ${r.invoiceNos.join(", ")}` }, [
      dr(l.cash, r.cashPaise), dr(l.bank, r.bankPaise), cr(party, r.cashPaise + r.bankPaise, true),
    ]);
  }
  for (const c of src.salesReturns) {
    const party = patient(c.patient);
    voucher(b, "sales_return", { remoteId: `hmis:sales_return:${c.id}`, number: c.no, date: c.date, reference: c.invoiceNo, party, narration: `Credit note ${c.no} against ${c.invoiceNo}` }, [
      dr(l.salesReturns, c.taxablePaise), dr(l.outputCgst, c.cgstPaise), dr(l.outputSgst, c.sgstPaise), roundOffEntry(l.roundOff, -c.roundingPaise), cr(party, c.netPaise, true),
    ]);
  }
  for (const r of src.refunds) {
    const party = patient(r.patient);
    voucher(b, "refund", { remoteId: `hmis:refund:${r.id}`, number: r.no, date: r.date, reference: r.invoiceNo, party, narration: `Refund ${r.no}${r.invoiceNo === null ? "" : ` on ${r.invoiceNo}`}` }, [
      dr(party, r.amountPaise, true), cr(r.cash ? l.cash : l.bank, r.amountPaise),
    ]);
  }
  for (const p of src.purchases) {
    const party = vendor(p.vendor);
    voucher(b, "purchase", { remoteId: `hmis:purchase:${p.id}`, number: p.no, date: p.date, reference: p.vendorBillNo, party, narration: `Supplier bill ${p.vendorBillNo} booked as ${p.no}` }, [
      dr(l.purchases, p.taxablePaise), dr(l.inputCgst, p.cgstPaise), dr(l.inputSgst, p.sgstPaise), dr(l.inputIgst, p.igstPaise),
      roundOffEntry(l.roundOff, -p.roundOffPaise), cr(party, p.totalPaise, true),
    ]);
  }
  for (const d of src.debitNotes) {
    const party = vendor(d.vendor);
    voucher(b, "purchase_return", { remoteId: `hmis:purchase_return:${d.id}`, number: d.no, date: d.date, reference: d.returnNo, party, narration: `Debit note ${d.no}${d.returnNo === null ? "" : ` for return ${d.returnNo}`}` }, [
      dr(party, d.totalPaise, true), cr(l.purchaseReturns, d.taxablePaise), cr(l.inputCgst, d.cgstPaise), cr(l.inputSgst, d.sgstPaise), cr(l.inputIgst, d.igstPaise),
    ]);
  }
  for (const a of src.adjustments) {
    const party = vendor(a.vendor);
    const kind: TallyVoucherKind = a.kind === "short_credit" ? "credit_shortfall" : "return_closed";
    const why = a.kind === "short_credit" ? `Vendor credit ${a.no} short of debit note ${a.ref ?? ""}` : `Return ${a.no} closed without credit (debit note ${a.ref ?? ""})`;
    voucher(b, kind, { remoteId: `hmis:${kind}:${a.id}`, number: a.no, date: a.date, reference: a.ref, party, narration: `${why}${a.reason === null ? "" : `: ${a.reason}`}` }, [
      dr(l.returnShortfall, a.amountPaise), cr(party, a.amountPaise, true),
    ]);
  }
  for (const p of src.supplierPayments) {
    const party = vendor(p.vendor);
    voucher(b, "supplier_payment", { remoteId: `hmis:supplier_payment:${p.id}`, number: p.no, date: p.date, reference: p.reference, party, narration: `${p.mode.toUpperCase()}${p.reference === null ? "" : ` ${p.reference}`} for ${p.bills.join(", ")}` }, [
      dr(party, p.amountPaise, true), cr(p.mode === "cash" ? l.cash : l.bank, p.amountPaise),
    ]);
  }
  const order: Record<TallyVoucherKind, number> = { sale: 0, receipt: 1, sales_return: 2, refund: 3, purchase: 4, purchase_return: 5, credit_shortfall: 6, return_closed: 7, supplier_payment: 8 };
  b.vouchers.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : order[x.kind] - order[y.kind] || x.number.localeCompare(y.number)));
  return { vouchers: b.vouchers, parties: [...b.parties.values()].sort((x, y) => x.name.localeCompare(y.name)) };
}

// ═══════════════════════════════════ the XML, pure ═══════════════════════════════════

export const xmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!)
    // XML 1.0 forbids most control characters outright, escaped or not.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** Tally's amount: a debit NEGATIVE, a credit positive, two decimals. */
export const tallyAmount = (paise: number): string => {
  const v = -paise;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return `${sign}${String(Math.floor(a / 100))}.${String(a % 100).padStart(2, "0")}`;
};
const tallyDate = (day: string): string => day.replace(/-/g, "");

function envelope(reportName: "Vouchers" | "All Masters", companyName: string, messages: string[]): string {
  const company = companyName === "" ? "" : `\n     <STATICVARIABLES>\n      <SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY>\n     </STATICVARIABLES>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>${company}
   </REQUESTDESC>
   <REQUESTDATA>
${messages.join("\n")}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}

export function voucherXml(v: TallyVoucher): string {
  const entries = v.entries.map((e) => `     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(e.ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${e.amountPaise > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>${e.party ? "Yes" : "No"}</ISPARTYLEDGER>
      <AMOUNT>${tallyAmount(e.amountPaise)}</AMOUNT>
     </ALLLEDGERENTRIES.LIST>`).join("\n");
  return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER REMOTEID="${xmlEscape(v.remoteId)}" VCHTYPE="${v.type}" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${tallyDate(v.date)}</DATE>
      <EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER>${v.reference === null || v.reference === "" ? "" : `\n      <REFERENCE>${xmlEscape(v.reference)}</REFERENCE>`}
      <PARTYLEDGERNAME>${xmlEscape(v.party)}</PARTYLEDGERNAME>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <NARRATION>${xmlEscape(v.narration)}</NARRATION>
${entries}
     </VOUCHER>
    </TALLYMESSAGE>`;
}

export function vouchersXml(vouchers: readonly TallyVoucher[], l: TallyLedgers): string {
  return envelope("Vouchers", l.companyName, vouchers.map(voucherXml));
}

/** Every ledger the vouchers name, under its group: the accounts from the mapping, the parties as Sundry Debtors / Creditors. */
export function mastersXml(vouchers: readonly TallyVoucher[], parties: readonly TallyParty[], l: TallyLedgers): string {
  const used = new Set(vouchers.flatMap((v) => v.entries.map((e) => e.ledger)));
  const accounts = new Map<string, string>();
  for (const k of LEDGER_KEYS) if (used.has(l[k]) && !accounts.has(l[k])) accounts.set(l[k], GROUP[k]);
  const ledger = (name: string, group: string, extra = ""): string => `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${xmlEscape(name)}" ACTION="Create">
      <NAME.LIST>
       <NAME>${xmlEscape(name)}</NAME>
      </NAME.LIST>
      <PARENT>${xmlEscape(group)}</PARENT>${extra}
     </LEDGER>
    </TALLYMESSAGE>`;
  const messages = [
    ...[...accounts].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => ledger(name, group)),
    ...parties.filter((p) => !accounts.has(p.name)).map((p) => ledger(p.name, p.group, `\n      <ISBILLWISEON>Yes</ISBILLWISEON>${p.gstin === null ? "" : `\n      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>\n      <PARTYGSTIN>${xmlEscape(p.gstin)}</PARTYGSTIN>`}`)),
  ];
  return envelope("All Masters", l.companyName, messages);
}

// ═══════════════════════════════════ the period's documents ═══════════════════════════════════

async function sourceOf(db: Db, actor: Actor, from: string, to: string): Promise<TallySource> {
  const [sales, receipts, refunds, register, payments, adjustments] = await Promise.all([
    pharmacySalesPeriod(db, actor, from, to),
    receiptAllocationsBetween(db, from, to),
    refundVouchersPaidBetween(db, from, to),
    purchaseRegister(db, from, to),
    supplierPaymentsBetween(db, from, to),
    purchaseAdjustmentsBetween(db, from, to),
  ]);
  // Receipts and refunds are hospital-wide in billing: keep the pharmacy's own bills'.
  const pharmacyInvoices = await sales.pharmacyInvoiceIds([...receipts.map((r) => r.invoiceId), ...refunds.map((r) => r.invoiceId).filter((x): x is string => x !== null)]);
  const who = await sales.patients([...receipts.map((r) => r.patientId), ...refunds.map((r) => r.patientId)]);
  const person = (id: string): { name: string; uhid: string } => who.get(id) ?? { name: id, uhid: "" };
  const byReceipt = new Map<string, TallySource["receipts"][number]>();
  for (const r of receipts) {
    if (!pharmacyInvoices.has(r.invoiceId)) continue;
    const cur = byReceipt.get(r.receiptId) ?? { id: r.receiptId, no: r.receiptNo, date: r.day, patient: person(r.patientId), invoiceNos: [], cashPaise: 0, bankPaise: 0 };
    cur.invoiceNos.push(pharmacyInvoices.get(r.invoiceId)!);
    cur.cashPaise += r.byMode.cash;
    cur.bankPaise += r.byMode.upi + r.byMode.card;
    byReceipt.set(r.receiptId, cur);
  }
  return {
    sales: sales.sales.map((s) => ({
      id: s.id, no: s.invoiceNo, date: s.serviceDay, ref: s.ref, patient: s.patient, taxablePaise: s.taxableBasePaise, cgstPaise: s.cgstPaise, sgstPaise: s.sgstPaise,
      roundingPaise: s.roundingPaise, netPaise: s.netPayablePaise,
    })),
    salesReturns: sales.refunds.map((n) => ({
      id: n.id, no: n.creditNoteNo, date: n.day, invoiceNo: n.invoiceNo, patient: n.patient, taxablePaise: n.taxableBasePaise, cgstPaise: n.cgstPaise,
      sgstPaise: n.sgstPaise, roundingPaise: n.roundingPaise, netPaise: n.netPaise,
    })),
    receipts: [...byReceipt.values()],
    refunds: refunds.filter((r) => r.invoiceId !== null && pharmacyInvoices.has(r.invoiceId)).map((r) => ({
      id: r.id, no: r.voucherNo, date: r.day, patient: person(r.patientId), invoiceNo: pharmacyInvoices.get(r.invoiceId!) ?? null, amountPaise: r.amountPaise, cash: r.method === "cash",
    })),
    purchases: register.rows.filter((r) => r.kind === "bill").map((r) => ({
      id: r.id, no: r.docNo, date: r.date, vendorBillNo: r.vendorDocNo ?? "", vendor: { name: r.vendorName, gstin: r.gstin }, taxablePaise: r.taxablePaise,
      cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise, roundOffPaise: r.roundOffPaise, totalPaise: r.totalPaise,
    })),
    debitNotes: register.rows.filter((r) => r.kind === "debit_note").map((r) => ({
      id: r.id, no: r.docNo, date: r.date, returnNo: r.ref, vendor: { name: r.vendorName, gstin: r.gstin }, taxablePaise: r.taxablePaise,
      cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise, totalPaise: r.totalPaise,
    })),
    supplierPayments: payments.map((p) => ({
      id: p.id, no: p.paymentNo, date: p.paidOn, vendor: { name: p.vendorName, gstin: p.gstin }, mode: p.mode, reference: p.reference, amountPaise: p.amountPaise,
      bills: p.bills.map((x) => `${x.billNo} (${x.vendorBillNo})`),
    })),
    adjustments: adjustments.map((a) => ({ kind: a.kind, id: a.id, no: a.no, date: a.date, ref: a.ref, reason: a.reason, vendor: { name: a.vendorName, gstin: null }, amountPaise: a.amountPaise })),
  };
}

export type TallyExportSummary = {
  id: string; from: string; to: string; voucherCount: number; counts: Record<TallyVoucherKind, number>; debitPaise: number; checksum: string;
  exportedBy: string; exportedAt: string;
};
export type TallyPreview = {
  from: string; to: string; preset: string; confirmed: boolean; ledgers: TallyLedgers;
  voucherCount: number; counts: Record<TallyVoucherKind, number>; debitPaise: number;
  /** The first vouchers as they will be written, for the accountant to read before exporting. */
  sample: TallyVoucher[];
  /** Earlier exports whose range overlaps this one: a re-export is seen before it is made. */
  earlier: TallyExportSummary[];
};

function countsOf(vouchers: readonly TallyVoucher[]): Record<TallyVoucherKind, number> {
  const c = Object.fromEntries(TALLY_KINDS.map((k) => [k, 0])) as Record<TallyVoucherKind, number>;
  for (const v of vouchers) c[v.kind] += 1;
  return c;
}
const debitOf = (vouchers: readonly TallyVoucher[]): number => vouchers.reduce((s, v) => s + v.entries.filter((e) => e.amountPaise > 0).reduce((t, e) => t + e.amountPaise, 0), 0);

async function earlierExports(db: Db, from: string, to: string): Promise<TallyExportSummary[]> {
  const rows = await db.select({
    id: pharmacyTallyExports.id, from: pharmacyTallyExports.fromDate, to: pharmacyTallyExports.toDate, voucherCount: pharmacyTallyExports.voucherCount,
    counts: pharmacyTallyExports.counts, debitPaise: pharmacyTallyExports.debitPaise, checksum: pharmacyTallyExports.checksum,
    exportedBy: pharmacyTallyExports.exportedBy, exportedAt: pharmacyTallyExports.exportedAt,
  }).from(pharmacyTallyExports)
    .where(and(lte(pharmacyTallyExports.fromDate, to), gte(pharmacyTallyExports.toDate, from)))
    .orderBy(desc(pharmacyTallyExports.exportedAt)).limit(50);
  return summaries(db, rows);
}

async function summaries(db: Db, rows: { id: string; from: string; to: string; voucherCount: number; counts: unknown; debitPaise: number; checksum: string; exportedBy: string; exportedAt: Date }[]): Promise<TallyExportSummary[]> {
  const names = await userNames(db, rows.map((r) => r.exportedBy));
  return rows.map((r) => ({ ...r, counts: r.counts as Record<TallyVoucherKind, number>, exportedBy: names.get(r.exportedBy) ?? r.exportedBy, exportedAt: r.exportedAt.toISOString() }));
}

/** What an export of the range would carry — nothing is recorded. */
export async function tallyPreview(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<TallyPreview> {
  await requireReportPermission(db, actor, TALLY_EXPORT, "the Tally export");
  const range = reportRange(input.preset ?? "month", reportToday(now), input);
  const state = await readLedgers(db);
  const { vouchers } = buildVouchers(await sourceOf(db, actor, range.from, range.to), state.ledgers);
  return {
    from: range.from, to: range.to, preset: range.preset, confirmed: state.confirmed, ledgers: state.ledgers,
    voucherCount: vouchers.length, counts: countsOf(vouchers), debitPaise: debitOf(vouchers), sample: vouchers.slice(0, 5),
    earlier: await earlierExports(db, range.from, range.to),
  };
}

/**
 * THE EXPORT: build, write both files, record it. Refused until the accountant has confirmed the
 * ledger mapping, and refused whole if any voucher would not balance.
 */
export async function tallyExport(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<TallyExportSummary> {
  await requireReportPermission(db, actor, TALLY_EXPORT, "the Tally export");
  const range = reportRange(input.preset ?? "month", reportToday(now), input);
  const state = await readLedgers(db);
  if (!state.confirmed) {
    throw new PharmacyError("tally_ledgers_unconfirmed", "confirm the Tally ledger names first (Tally → Ledgers): the defaults are names, not your company's ledgers");
  }
  const { vouchers, parties } = buildVouchers(await sourceOf(db, actor, range.from, range.to), state.ledgers);
  const vXml = vouchersXml(vouchers, state.ledgers);
  const mXml = mastersXml(vouchers, parties, state.ledgers);
  const row = {
    id: newId(), fromDate: range.from, toDate: range.to, voucherCount: vouchers.length, counts: countsOf(vouchers), debitPaise: debitOf(vouchers),
    checksum: createHash("sha256").update(vXml, "utf8").digest("hex"), ledgers: state.ledgers, vouchersXml: vXml, mastersXml: mXml,
    exportedBy: actor.id, exportedAt: now,
  };
  await db.insert(pharmacyTallyExports).values(row);
  return (await summaries(db, [{ id: row.id, from: row.fromDate, to: row.toDate, voucherCount: row.voucherCount, counts: row.counts, debitPaise: row.debitPaise, checksum: row.checksum, exportedBy: row.exportedBy, exportedAt: row.exportedAt }]))[0]!;
}

/** The exports made, newest first. */
export async function tallyExports(db: Db, actor: Actor): Promise<TallyExportSummary[]> {
  await requireReportPermission(db, actor, TALLY_EXPORT, "the Tally exports");
  const rows = await db.select({
    id: pharmacyTallyExports.id, from: pharmacyTallyExports.fromDate, to: pharmacyTallyExports.toDate, voucherCount: pharmacyTallyExports.voucherCount,
    counts: pharmacyTallyExports.counts, debitPaise: pharmacyTallyExports.debitPaise, checksum: pharmacyTallyExports.checksum,
    exportedBy: pharmacyTallyExports.exportedBy, exportedAt: pharmacyTallyExports.exportedAt,
  }).from(pharmacyTallyExports).orderBy(desc(pharmacyTallyExports.exportedAt)).limit(50);
  return summaries(db, rows);
}

/** One recorded export's file, exactly as it was written: the vouchers or the masters. */
export async function tallyExportFile(db: Db, actor: Actor, exportId: string, file: "vouchers" | "masters"): Promise<{ fileName: string; xml: string }> {
  await requireReportPermission(db, actor, TALLY_EXPORT, "a Tally export file");
  const [row] = await db.select().from(pharmacyTallyExports).where(eq(pharmacyTallyExports.id, exportId));
  if (row === undefined) throw new PharmacyError("not_found", `Tally export ${exportId} not found`);
  const stem = `tally-pharmacy-${row.fromDate}-to-${row.toDate}`;
  return file === "vouchers" ? { fileName: `${stem}-vouchers.xml`, xml: row.vouchersXml } : { fileName: `${stem}-masters.xml`, xml: row.mastersXml };
}
