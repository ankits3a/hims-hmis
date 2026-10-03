import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { creditNotes, invoices, pharmacyCreditMoves, pharmacyDispenses, pharmacyRetailSales } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { istDateOf } from "./config";
import { REPORTS_READ, requireReportPermission } from "./report-range";
import { salesRegister } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ReportInput, SaleSource, TenderLabel } from "./sales-register";

/**
 * ═══ THE PHARMACY'S BOOKS, THREE WAYS (owner 2026-10-03) ═══
 *
 * "Let me see invoices against each ticket in a single dashboard, invoices against the respective ticket in
 * the patient dashboard, and a CA-friendly accounting screen — simple and easy."
 *
 * 1. TICKETS & INVOICES — one row per pharmacy bill in the range: the ticket (`P…`, or the walk-in sale), the
 *    invoice, its taxable value and GST, every credit note against it (whenever issued), the credit spent on
 *    it, and what is left. Built on the sales register (same range, store filter, `pharmacy.reports.read`).
 * 2. THE PATIENT'S PHARMACY BILLS — the same row, for one patient, newest first (the profile's left lane).
 * 3. THE GST BOOK — what a CA files: outward supply rate by rate, less the credit notes rate by rate, net; each
 *    credit note with the invoice it reverses (GSTR-1 asks for both numbers and dates); and the money check
 *    that answers "is GST charged twice when a credit note is spent?" — earlier credit spent on a bill is a
 *    PAYMENT, not a sale and not a discount, so it is shown apart from the tax and never reduces it
 *    (Section 34 CGST Act: the credit note itself reverses the first bill's tax).
 */
export type TicketCreditNote = { id: string; creditNoteNo: string; date: string; taxablePaise: number; gstPaise: number; netPaise: number };
export type TicketInvoiceRow = {
  invoiceId: string; invoiceNo: string; date: string; ticket: string | null; source: SaleSource;
  patientId: string; patientName: string; uhid: string;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number;
  tender: TenderLabel | null; creditUsedPaise: number; outstandingPaise: number | null;
  creditNotes: TicketCreditNote[]; returnedPaise: number;
  /** The bill less every credit note against it: what the patient was finally charged. */
  finalPaise: number;
};
export type TicketInvoices = {
  from: string; to: string; preset: string; rows: TicketInvoiceRow[];
  totals: { bills: number; netPaise: number; gstPaise: number; returnedPaise: number; finalPaise: number; creditUsedPaise: number; outstandingPaise: number };
};

type Money = { taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number };
const zero = (): Money => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, netPaise: 0 });
const add = (a: Money, b: Money): void => { a.taxablePaise += b.taxablePaise; a.cgstPaise += b.cgstPaise; a.sgstPaise += b.sgstPaise; a.netPaise += b.netPaise; };

/** Earlier credit spent on each bill (`pharmacy_credit_moves` kind `used`). */
async function creditUsedByInvoice(db: Db, invoiceIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (invoiceIds.length === 0) return out;
  const rows = await db.select({ invoiceId: pharmacyCreditMoves.invoiceId, amount: pharmacyCreditMoves.amountPaise }).from(pharmacyCreditMoves)
    .where(and(inArray(pharmacyCreditMoves.invoiceId, [...invoiceIds]), eq(pharmacyCreditMoves.kind, "used")));
  for (const r of rows) out.set(r.invoiceId, (out.get(r.invoiceId) ?? 0) + r.amount);
  return out;
}

/** Every credit note against these bills, whenever it was issued. */
async function notesByInvoice(db: Db, invoiceIds: readonly string[]): Promise<Map<string, TicketCreditNote[]>> {
  const out = new Map<string, TicketCreditNote[]>();
  if (invoiceIds.length === 0) return out;
  const rows = await db.select().from(creditNotes).where(inArray(creditNotes.invoiceId, [...invoiceIds])).orderBy(creditNotes.issuedAt);
  for (const n of rows) {
    out.set(n.invoiceId, [...(out.get(n.invoiceId) ?? []), {
      id: n.id, creditNoteNo: n.creditNoteNo, date: istDateOf(n.issuedAt), taxablePaise: n.taxableBasePaise, gstPaise: n.cgstPaise + n.sgstPaise, netPaise: n.netPaise,
    }]);
  }
  return out;
}

export async function ticketInvoices(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<TicketInvoices> {
  await requireReportPermission(db, actor, REPORTS_READ, "tickets and invoices");
  const reg = await salesRegister(db, actor, { ...input, groupBy: "document" }, now);
  const sales = reg.rows.filter((r) => r.kind === "sale");
  const ids = sales.map((r) => r.invoiceId);
  const [used, notes] = await Promise.all([creditUsedByInvoice(db, ids), notesByInvoice(db, ids)]);
  const rows: TicketInvoiceRow[] = sales.map((r) => {
    const cn = notes.get(r.invoiceId) ?? [];
    const returnedPaise = cn.reduce((s, n) => s + n.netPaise, 0);
    return {
      invoiceId: r.invoiceId, invoiceNo: r.invoiceNo, date: r.date, ticket: r.ref, source: r.source,
      patientId: r.patientId, patientName: r.patientName, uhid: r.uhid,
      taxablePaise: r.taxablePaise, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, netPaise: r.netPaise,
      tender: r.tender, creditUsedPaise: used.get(r.invoiceId) ?? 0, outstandingPaise: r.outstandingPaise,
      creditNotes: cn, returnedPaise, finalPaise: r.netPaise - returnedPaise,
    };
  });
  return {
    from: reg.from, to: reg.to, preset: reg.preset, rows,
    totals: {
      bills: rows.length,
      netPaise: rows.reduce((s, r) => s + r.netPaise, 0),
      gstPaise: rows.reduce((s, r) => s + r.cgstPaise + r.sgstPaise, 0),
      returnedPaise: rows.reduce((s, r) => s + r.returnedPaise, 0),
      finalPaise: rows.reduce((s, r) => s + r.finalPaise, 0),
      creditUsedPaise: rows.reduce((s, r) => s + r.creditUsedPaise, 0),
      outstandingPaise: rows.reduce((s, r) => s + (r.outstandingPaise ?? 0), 0),
    },
  };
}

export type GstRateRow = { rateBps: number; sales: Money; returns: Money; net: Money };
export type GstBook = {
  from: string; to: string; preset: string;
  rates: GstRateRow[];
  totals: { sales: Money; returns: Money; net: Money };
  /** Each credit note of the period with the bill it reverses — GSTR-1 needs both numbers and dates. */
  creditNotes: { id: string; creditNoteNo: string; date: string; invoiceNo: string; invoiceDate: string; patientName: string; uhid: string; taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number }[];
  /** The money check: billed (with GST) = paid from earlier credit + collected now + still owed. */
  money: { billedPaise: number; paidFromCreditPaise: number; outstandingPaise: number; collectedPaise: number };
};

export async function gstBook(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<GstBook> {
  await requireReportPermission(db, actor, REPORTS_READ, "the GST book");
  const reg = await salesRegister(db, actor, { ...input, groupBy: "document" }, now);
  const byRate = new Map<number, GstRateRow>();
  const rateRow = (rateBps: number): GstRateRow => {
    const cur = byRate.get(rateBps) ?? { rateBps, sales: zero(), returns: zero(), net: zero() };
    byRate.set(rateBps, cur);
    return cur;
  };
  for (const r of reg.rows) {
    for (const l of r.lines) add(r.kind === "sale" ? rateRow(l.rateBps).sales : rateRow(l.rateBps).returns, l);
  }
  const totals = { sales: zero(), returns: zero(), net: zero() };
  const rates = [...byRate.values()].sort((a, b) => a.rateBps - b.rateBps).map((g) => {
    g.net = { taxablePaise: g.sales.taxablePaise - g.returns.taxablePaise, cgstPaise: g.sales.cgstPaise - g.returns.cgstPaise, sgstPaise: g.sales.sgstPaise - g.returns.sgstPaise, netPaise: g.sales.netPaise - g.returns.netPaise };
    add(totals.sales, g.sales); add(totals.returns, g.returns); add(totals.net, g.net);
    return g;
  });
  const refunds = reg.rows.filter((r) => r.kind === "refund");
  const heads = refunds.length === 0 ? [] : await db.select({ id: invoices.id, issuedAt: invoices.issuedAt }).from(invoices).where(inArray(invoices.id, [...new Set(refunds.map((r) => r.invoiceId))]));
  const invoiceDay = new Map(heads.map((h) => [h.id, istDateOf(h.issuedAt)] as const));
  const sales = reg.rows.filter((r) => r.kind === "sale");
  const used = await creditUsedByInvoice(db, sales.map((r) => r.invoiceId));
  const billedPaise = sales.reduce((s, r) => s + r.netPaise, 0);
  const paidFromCreditPaise = sales.reduce((s, r) => s + (used.get(r.invoiceId) ?? 0), 0);
  const outstandingPaise = sales.reduce((s, r) => s + (r.outstandingPaise ?? 0), 0);
  return {
    from: reg.from, to: reg.to, preset: reg.preset, rates, totals,
    creditNotes: refunds.map((r) => ({
      id: r.id, creditNoteNo: r.docNo, date: r.date, invoiceNo: r.invoiceNo, invoiceDate: invoiceDay.get(r.invoiceId) ?? "",
      patientName: r.patientName, uhid: r.uhid, taxablePaise: r.taxablePaise, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, netPaise: r.netPaise,
    })),
    money: { billedPaise, paidFromCreditPaise, outstandingPaise, collectedPaise: billedPaise - paidFromCreditPaise - outstandingPaise },
  };
}

export type PatientPharmacyBill = {
  invoiceId: string; invoiceNo: string; date: string; ticket: string | null; source: "dispense" | "walk_in";
  netPaise: number; gstPaise: number; creditUsedPaise: number; creditNotes: TicketCreditNote[]; returnedPaise: number; finalPaise: number;
};

/** The patient's pharmacy bills, newest first, each with its ticket and its credit notes (the profile's lane). */
export async function patientPharmacyBills(db: Db, actor: Actor, patientId: string): Promise<{ bills: PatientPharmacyBill[] }> {
  const [who] = await getPatientSummaries(db, actor, [patientId]);
  if (who === undefined) return { bills: [] };
  const [desk, walkIn] = await Promise.all([
    db.select({ invoiceId: pharmacyDispenses.invoiceId, ticket: pharmacyDispenses.dispenseNo }).from(pharmacyDispenses)
      .where(and(eq(pharmacyDispenses.patientId, patientId), isNotNull(pharmacyDispenses.invoiceId))),
    db.select({ invoiceId: pharmacyRetailSales.invoiceId }).from(pharmacyRetailSales).where(eq(pharmacyRetailSales.patientId, patientId)),
  ]);
  const ticketOf = new Map<string, { ticket: string | null; source: "dispense" | "walk_in" }>();
  for (const d of desk) if (d.invoiceId !== null) ticketOf.set(d.invoiceId, { ticket: d.ticket, source: "dispense" });
  for (const w of walkIn) ticketOf.set(w.invoiceId, { ticket: null, source: "walk_in" });
  const ids = [...ticketOf.keys()];
  if (ids.length === 0) return { bills: [] };
  const [heads, used, notes] = await Promise.all([
    db.select().from(invoices).where(inArray(invoices.id, ids)).orderBy(desc(invoices.issuedAt)).limit(200),
    creditUsedByInvoice(db, ids), notesByInvoice(db, ids),
  ]);
  return {
    bills: heads.map((h) => {
      const cn = notes.get(h.id) ?? [];
      const returnedPaise = cn.reduce((s, n) => s + n.netPaise, 0);
      const t = ticketOf.get(h.id)!;
      return {
        invoiceId: h.id, invoiceNo: h.invoiceNo, date: istDateOf(h.issuedAt), ticket: t.ticket, source: t.source,
        netPaise: h.netPayablePaise, gstPaise: h.cgstPaise + h.sgstPaise, creditUsedPaise: used.get(h.id) ?? 0,
        creditNotes: cn, returnedPaise, finalPaise: h.netPayablePaise - returnedPaise,
      };
    }),
  };
}
