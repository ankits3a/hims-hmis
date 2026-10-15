import { and, gte, inArray, lt } from "drizzle-orm";
import { pharmacyCreditMoves, pharmacyDispenses, pharmacyRetailSales, refundVouchers } from "../../kernel/db/schema";
import { invoicePayments, refundVouchersPaidBetween } from "../billing";
import { getPatientSummaries } from "../patients";
import { istInstantOf } from "./config";
import { officePurchaseRegister } from "./office-reports";
import { userNames } from "./queue";
import { REPORTS_READ, requireReportPermission } from "./report-range";
import { salesRegister } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ReportInput } from "./sales-register";

/**
 * ═══ THE PHARMACY'S ACCOUNTS, ON ONE SCREEN, FOR THE CA (owner 2026-10-03) ═══
 *
 * "A CA-friendly screen for a day, week, month or financial year, where every money-related thing is
 * auditable and exportable — start from the pharmacy." One read over the period, built only from the books
 * the other reports already read (so its figures are theirs):
 *
 *   SALES      bills and credit notes (the sales register's two sides), net sales;
 *   GST        output (sales − credit notes) less input (purchase bills − debit notes) — an estimate of the
 *              cash GST; the GSTR-3B report applies the set-off rules;
 *   MONEY IN   what the period's bills were paid by (cash / UPI / card, each receipt split by its own
 *              tenders), what is still owed, and how much of it was earlier pharmacy credit;
 *   MONEY OUT  refund vouchers PAID in the period against pharmacy bills, cash and bank;
 *   CREDIT     pharmacy credit kept and used in the period, and what patients hold now;
 *   PURCHASES  supplier bills, input GST, paid and due;
 *   DOCUMENTS  every money document of the period, in time order, with who made it — the audit trail.
 */
type Side = { count: number; grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number };
export type AccountsDocument = {
  at: string; type: "bill" | "credit_note" | "refund_paid" | "credit_kept" | "credit_used" | "purchase_bill" | "debit_note";
  no: string; party: string; amountPaise: number; gstPaise: number | null; mode: string | null; by: string;
};
export type PharmacyAccounts = {
  from: string; to: string; preset: string;
  sales: Side; returns: Side; netSalesPaise: number;
  gst: { outputPaise: number; inputPaise: number; netPayablePaise: number };
  moneyIn: { cashPaise: number; upiPaise: number; cardPaise: number; totalPaise: number; fromCreditPaise: number; outstandingPaise: number };
  moneyOut: { count: number; cashPaise: number; bankPaise: number; totalPaise: number };
  credit: { keptPaise: number; usedPaise: number; heldNowPaise: number };
  purchases: { bills: number; taxablePaise: number; gstPaise: number; totalPaise: number; paidPaise: number; duePaise: number; returnsPaise: number };
  documents: AccountsDocument[];
};

const DAY_MS = 86_400_000;
/** At one instant the document comes before what it moved: a bill before the credit it spent, a credit note before the credit it kept. */
const RANK: Record<AccountsDocument["type"], number> = { purchase_bill: 0, debit_note: 1, bill: 2, credit_note: 3, credit_used: 4, credit_kept: 5, refund_paid: 6 };
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export async function pharmacyAccounts(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<PharmacyAccounts> {
  await requireReportPermission(db, actor, REPORTS_READ, "the pharmacy accounts");
  const reg = await salesRegister(db, actor, { ...input, groupBy: "document" }, now);
  const range = { preset: reg.preset, from: reg.from, to: reg.to };
  const purchases = await officePurchaseRegister(db, actor, { preset: "custom", from: range.from, to: range.to }, now);
  const sales = reg.rows.filter((r) => r.kind === "sale");
  const pays = await invoicePayments(db, sales.map((r) => r.invoiceId));
  const start = istInstantOf(range.from, "00:00");
  const end = istInstantOf(nextDay(range.to), "00:00");

  // MONEY OUT — refund vouchers paid in the period, against a pharmacy bill.
  const paid = await refundVouchersPaidBetween(db, range.from, range.to);
  const paidInvoiceIds = [...new Set(paid.map((v) => v.invoiceId).filter((x): x is string => x !== null))];
  const pharmacyInvoices = new Set(paidInvoiceIds.length === 0 ? [] : [
    ...(await db.select({ id: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.invoiceId, paidInvoiceIds))).map((r) => r.id),
    ...(await db.select({ id: pharmacyRetailSales.invoiceId }).from(pharmacyRetailSales).where(inArray(pharmacyRetailSales.invoiceId, paidInvoiceIds))).map((r) => r.id),
  ]);
  const refunds = paid.filter((v) => v.invoiceId !== null && pharmacyInvoices.has(v.invoiceId));
  const voucherRows = refunds.length === 0 ? [] : await db.select({ id: refundVouchers.id, paidBy: refundVouchers.paidBy, payee: refundVouchers.payeeName }).from(refundVouchers).where(inArray(refundVouchers.id, refunds.map((r) => r.id)));
  const voucherOf = new Map(voucherRows.map((v) => [v.id, v] as const));

  // CREDIT — the pharmacy's credit book: moves in the period, and what is held now (kept − used, all time).
  const [periodMoves, allMoves] = await Promise.all([
    db.select().from(pharmacyCreditMoves).where(and(gte(pharmacyCreditMoves.at, start), lt(pharmacyCreditMoves.at, end))),
    db.select({ kind: pharmacyCreditMoves.kind, amount: pharmacyCreditMoves.amountPaise }).from(pharmacyCreditMoves),
  ]);
  const sumKind = (rows: readonly { kind: string; amount?: number; amountPaise?: number }[], kind: string): number =>
    rows.filter((m) => m.kind === kind).reduce((s, m) => s + (m.amount ?? m.amountPaise ?? 0), 0);

  const people = await getPatientSummaries(db, actor, [...new Set([...refunds.map((r) => r.patientId), ...periodMoves.map((m) => m.patientId)])]);
  const nameOf = new Map(people.map((p) => [p.id, `${p.alias ?? p.name ?? "—"} (${p.uhid})`] as const));
  const names = await userNames(db, [...voucherRows.map((v) => v.paidBy), ...periodMoves.map((m) => m.actorId)]);

  const byMode = { cash: 0, upi: 0, card: 0 };
  for (const p of pays.values()) { byMode.cash += p.byMode.cash; byMode.upi += p.byMode.upi; byMode.card += p.byMode.card; }
  const fromCreditPaise = sumKind(periodMoves, "used");
  const outputPaise = reg.totals.sales.cgstPaise + reg.totals.sales.sgstPaise - reg.totals.refunds.cgstPaise - reg.totals.refunds.sgstPaise;
  const pb = purchases.totals.bills;
  const pd = purchases.totals.debitNotes;
  const inputPaise = pb.cgstPaise + pb.sgstPaise + pb.igstPaise - (pd.cgstPaise + pd.sgstPaise + pd.igstPaise);

  const documents: AccountsDocument[] = [
    ...reg.rows.map((r): AccountsDocument => ({
      at: r.at, type: r.kind === "sale" ? "bill" : "credit_note", no: r.docNo, party: `${r.patientName} (${r.uhid})`,
      amountPaise: r.kind === "sale" ? r.netPaise : -r.netPaise, gstPaise: (r.kind === "sale" ? 1 : -1) * (r.cgstPaise + r.sgstPaise),
      mode: r.kind === "sale" ? r.tender : null, by: r.operatorName,
    })),
    ...refunds.map((v): AccountsDocument => ({
      at: v.paidAt, type: "refund_paid", no: v.voucherNo, party: nameOf.get(v.patientId) ?? v.patientId, amountPaise: -v.amountPaise, gstPaise: null,
      mode: v.method, by: names.get(voucherOf.get(v.id)?.paidBy ?? "") ?? "—",
    })),
    ...periodMoves.map((m): AccountsDocument => ({
      at: m.at.toISOString(), type: m.kind === "kept" ? "credit_kept" : "credit_used", no: "—",
      party: nameOf.get(m.patientId) ?? m.patientId, amountPaise: m.kind === "kept" ? m.amountPaise : -m.amountPaise, gstPaise: null, mode: null, by: names.get(m.actorId) ?? m.actorId,
    })),
    ...purchases.rows.filter((r) => r.kind !== "credit_note").map((r): AccountsDocument => ({
      at: `${r.date}T00:00:00.000Z`, type: r.kind === "bill" ? "purchase_bill" : "debit_note", no: r.vendorDocNo === null ? r.docNo : `${r.docNo} / ${r.vendorDocNo}`, party: r.vendorName,
      amountPaise: (r.kind === "bill" ? -1 : 1) * r.totalPaise, gstPaise: (r.kind === "bill" ? 1 : -1) * (r.cgstPaise + r.sgstPaise + r.igstPaise), mode: null, by: "—",
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : RANK[a.type] - RANK[b.type] || a.no.localeCompare(b.no)));

  const side = (s: typeof reg.totals.sales): Side => ({
    count: s.count, grossPaise: s.grossPaise, discountPaise: s.discountPaise, taxablePaise: s.taxablePaise,
    cgstPaise: s.cgstPaise, sgstPaise: s.sgstPaise, roundingPaise: s.roundingPaise, netPaise: s.netPaise,
  });
  return {
    ...range,
    sales: side(reg.totals.sales), returns: side(reg.totals.refunds), netSalesPaise: reg.totals.net.netPaise,
    gst: { outputPaise, inputPaise, netPayablePaise: outputPaise - inputPaise },
    moneyIn: {
      cashPaise: byMode.cash, upiPaise: byMode.upi, cardPaise: byMode.card, totalPaise: byMode.cash + byMode.upi + byMode.card,
      fromCreditPaise, outstandingPaise: [...pays.values()].reduce((s, p) => s + p.outstandingPaise, 0),
    },
    moneyOut: {
      count: refunds.length,
      cashPaise: refunds.filter((v) => v.method === "cash").reduce((s, v) => s + v.amountPaise, 0),
      bankPaise: refunds.filter((v) => v.method === "bank_transfer").reduce((s, v) => s + v.amountPaise, 0),
      totalPaise: refunds.reduce((s, v) => s + v.amountPaise, 0),
    },
    credit: { keptPaise: sumKind(periodMoves, "kept"), usedPaise: fromCreditPaise, heldNowPaise: sumKind(allMoves, "kept") - sumKind(allMoves, "used") },
    purchases: { bills: pb.count, taxablePaise: pb.taxablePaise, gstPaise: pb.cgstPaise + pb.sgstPaise + pb.igstPaise, totalPaise: pb.totalPaise, paidPaise: pb.paidPaise, duePaise: pb.duePaise, returnsPaise: pd.totalPaise },
    documents,
  };
}
