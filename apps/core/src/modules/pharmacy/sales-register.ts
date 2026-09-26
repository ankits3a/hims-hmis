import { inArray } from "drizzle-orm";
import { opdPrescriptions, pharmacyDispenseLines, pharmacyDispenses, pharmacyRetailSaleLines, pharmacyRetailSales } from "../../kernel/db/schema";
import { creditNotesBetween, invoiceHeadsByIds, invoiceLinesOf, invoicePayments, invoicesBetween } from "../billing";
import { medicinesByIds } from "../formulary";
import { batchesByIds, itemsByIds, listStores } from "../materials";
import { getDoctor } from "../opd";
import { getPatientSummaries } from "../patients";
import { userNames } from "./queue";
import { REPORTS_MARGIN, REPORTS_READ, mayReadMargin, reportRange, reportToday, requireReportPermission } from "./report-range";
import { PharmacyError } from "./errors";
import type { CreditNoteRead, InvoiceHead, InvoiceLineRead, InvoicePayment } from "../billing";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE SALES REGISTER, THE MARGIN, THE HSN SUMMARY ═══
 *
 * Plan `docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md`, P5. Healthray's
 * Sales-Purchase/Refund grid (s11) and its Margin and HSN reports, our way: one read of the period's
 * pharmacy bills, folded three ways.
 *
 * WHAT A PHARMACY SALE IS. A billing invoice that a counter dispense (`pharmacy_dispenses.invoice_id`)
 * or a walk-in / paper sale (`pharmacy_retail_sales.invoice_id`) names. Its money is billing's, read
 * through `billing/index.ts` (the stored heads, never recomputed — GSTR-1's rule K35); what it sold
 * — item, batch, base units — is the pharmacy's own sale line, which names its invoice line.
 *
 *   - A sale is dated by its invoice's service day (the day book's grain); a refund (a credit note
 *     against a pharmacy bill) by the IST day it was issued, whatever day its bill was (GSTR-1 nets a
 *     credit note in the period it is issued). So the register's totals are exactly the day book's
 *     and GSTR-1's for the same days and the same bills.
 *   - A loose-MRP pack residue (the owner's ruling, 2026-09-22) is its own invoice line that follows
 *     its drug's main line; it belongs to that sale line here, so an item's revenue is whole.
 *   - COST AND MARGIN only for a reader who also holds `pharmacy.reports.margin` (Healthray puts
 *     profit on the sale screen; we keep it in reports behind a permission — plan principle 3). The
 *     cost of a unit is its batch's GRN cost (`stock_batches.landed_cost_paise`, per base unit):
 *     per-batch costing, which is FIFO by construction. A returned unit gives its cost back.
 *   - The patient is named by name and UHID (a sealed patient by alias, as everywhere); no phone:
 *     a register is an accounting read, not a contact list.
 */

const CHUNK = 5_000;

export const SALES_GROUPS = ["document", "item", "doctor", "patient", "operator", "tender"] as const;
export type SalesGroupBy = (typeof SALES_GROUPS)[number];
export const MARGIN_GROUPS = ["item", "category", "doctor"] as const;
export type MarginGroupBy = (typeof MARGIN_GROUPS)[number];

export type SaleSource = "dispense" | "walk_in" | "downtime";
export type TenderLabel = "cash" | "upi" | "card" | "split" | "unpaid";

type SaleLine = { saleLineId: string; invoiceLineId: string; itemId: string; batchId: string; qtyBase: number };
type SaleDoc = {
  invoiceId: string; source: SaleSource; ref: string | null; storeResourceId: string | null; patientId: string;
  operatorId: string; prescriber: string | null; lines: SaleLine[];
};

async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const wanted = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < wanted.length; i += CHUNK) out.push(...(await read(wanted.slice(i, i + CHUNK))));
  return out;
}

/** Which of these invoices are pharmacy sales, and what each sold. Invoices the pharmacy did not raise are absent. */
async function saleDocsOf(db: Db, invoiceIds: readonly string[]): Promise<Map<string, SaleDoc>> {
  const out = new Map<string, SaleDoc>();
  const dispenses = await inChunks(invoiceIds, (chunk) => db.select({
    id: pharmacyDispenses.id, invoiceId: pharmacyDispenses.invoiceId, dispenseNo: pharmacyDispenses.dispenseNo,
    storeResourceId: pharmacyDispenses.storeResourceId, patientId: pharmacyDispenses.patientId, prescriptionId: pharmacyDispenses.prescriptionId,
  }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.invoiceId, chunk)));
  const dLines = await inChunks(dispenses.map((d) => d.id), (chunk) => db.select({
    id: pharmacyDispenseLines.id, dispenseId: pharmacyDispenseLines.dispenseId, invoiceLineId: pharmacyDispenseLines.invoiceLineId,
    itemId: pharmacyDispenseLines.itemId, batchId: pharmacyDispenseLines.batchId, qtyBase: pharmacyDispenseLines.qtyBase,
  }).from(pharmacyDispenseLines).where(inArray(pharmacyDispenseLines.dispenseId, chunk)));
  const rx = await inChunks(dispenses.map((d) => d.prescriptionId), (chunk) => db.select({ id: opdPrescriptions.id, doctorId: opdPrescriptions.doctorId })
    .from(opdPrescriptions).where(inArray(opdPrescriptions.id, chunk)));
  const doctorOf = new Map(rx.map((r) => [r.id, r.doctorId] as const));
  const doctorNames = new Map<string, string>();
  for (const id of new Set(rx.map((r) => r.doctorId))) doctorNames.set(id, (await getDoctor(db, id))?.displayName ?? id);
  const sales = await inChunks(invoiceIds, (chunk) => db.select({
    id: pharmacyRetailSales.id, invoiceId: pharmacyRetailSales.invoiceId, channel: pharmacyRetailSales.channel,
    storeResourceId: pharmacyRetailSales.storeResourceId, patientId: pharmacyRetailSales.patientId, soldBy: pharmacyRetailSales.soldBy,
    prescriber: pharmacyRetailSales.rxPrescriberName,
  }).from(pharmacyRetailSales).where(inArray(pharmacyRetailSales.invoiceId, chunk)));
  const rLines = await inChunks(sales.map((s) => s.id), (chunk) => db.select({
    id: pharmacyRetailSaleLines.id, saleId: pharmacyRetailSaleLines.saleId, invoiceLineId: pharmacyRetailSaleLines.invoiceLineId,
    itemId: pharmacyRetailSaleLines.itemId, batchId: pharmacyRetailSaleLines.batchId, qtyBase: pharmacyRetailSaleLines.qtyBase,
  }).from(pharmacyRetailSaleLines).where(inArray(pharmacyRetailSaleLines.saleId, chunk)));

  for (const d of dispenses) {
    if (d.invoiceId === null) continue;
    const doctorId = doctorOf.get(d.prescriptionId);
    out.set(d.invoiceId, {
      invoiceId: d.invoiceId, source: "dispense", ref: d.dispenseNo, storeResourceId: d.storeResourceId, patientId: d.patientId,
      operatorId: "", // the invoice's issuer — filled from the head
      prescriber: doctorId === undefined ? null : (doctorNames.get(doctorId) ?? doctorId),
      lines: dLines.filter((l) => l.dispenseId === d.id && l.invoiceLineId !== null && l.itemId !== null && l.batchId !== null && l.qtyBase !== null)
        .map((l) => ({ saleLineId: l.id, invoiceLineId: l.invoiceLineId!, itemId: l.itemId!, batchId: l.batchId!, qtyBase: l.qtyBase! })),
    });
  }
  for (const s of sales) {
    out.set(s.invoiceId, {
      invoiceId: s.invoiceId, source: s.channel === "downtime" ? "downtime" : "walk_in", ref: null, storeResourceId: s.storeResourceId,
      patientId: s.patientId, operatorId: s.soldBy, prescriber: s.prescriber,
      lines: rLines.filter((l) => l.saleId === s.id).map((l) => ({ saleLineId: l.id, invoiceLineId: l.invoiceLineId, itemId: l.itemId, batchId: l.batchId, qtyBase: l.qtyBase })),
    });
  }
  return out;
}

/** One invoice line's share of a sale line: its own line (the main one) or the pack residue that follows it. */
type LineOwner = { doc: SaleDoc; line: SaleLine; main: boolean };

function ownersOf(docs: Map<string, SaleDoc>, lines: readonly InvoiceLineRead[]): Map<string, LineOwner> {
  const owners = new Map<string, LineOwner>();
  const mainOf = new Map<string, { doc: SaleDoc; line: SaleLine }>();
  for (const d of docs.values()) for (const l of d.lines) mainOf.set(l.invoiceLineId, { doc: d, line: l });
  let prev: LineOwner | null = null;
  let prevInvoice = "";
  for (const l of lines) {
    if (l.invoiceId !== prevInvoice) { prev = null; prevInvoice = l.invoiceId; }
    const m = mainOf.get(l.id);
    if (m !== undefined) {
      prev = { ...m, main: true };
      owners.set(l.id, prev);
    } else if (prev !== null) {
      owners.set(l.id, { doc: prev.doc, line: prev.line, main: false });
    }
  }
  return owners;
}

/** The period's pharmacy money: its sales (by service day) and its refunds (by issue day), with what each sold. */
type Period = {
  from: string; to: string;
  sales: InvoiceHead[];
  refunds: CreditNoteRead[];
  heads: Map<string, InvoiceHead>;
  docs: Map<string, SaleDoc>;
  lines: Map<string, InvoiceLineRead>;
  linesByInvoice: Map<string, InvoiceLineRead[]>;
  owners: Map<string, LineOwner>;
};

async function loadPeriod(db: Db, from: string, to: string, storeResourceId: string | null): Promise<Period> {
  const inRange = await invoicesBetween(db, from, to);
  const notes = await creditNotesBetween(db, from, to);
  const candidateIds = [...new Set([...inRange.map((i) => i.id), ...notes.map((n) => n.invoiceId)])];
  const docs = await saleDocsOf(db, candidateIds);
  if (storeResourceId !== null) for (const [k, d] of docs) if (d.storeResourceId !== storeResourceId) docs.delete(k);
  const outside = [...new Set(notes.map((n) => n.invoiceId))].filter((id) => docs.has(id) && !inRange.some((i) => i.id === id));
  const heads = new Map([...inRange, ...(await invoiceHeadsByIds(db, outside))].filter((h) => docs.has(h.id)).map((h) => [h.id, h] as const));
  for (const d of docs.values()) if (d.source === "dispense") d.operatorId = heads.get(d.invoiceId)?.issuedBy ?? "";
  const lineRows = await invoiceLinesOf(db, [...heads.keys()]);
  const linesByInvoice = new Map<string, InvoiceLineRead[]>();
  for (const l of lineRows) linesByInvoice.set(l.invoiceId, [...(linesByInvoice.get(l.invoiceId) ?? []), l]);
  return {
    from, to,
    sales: inRange.filter((i) => docs.has(i.id)),
    refunds: notes.filter((n) => docs.has(n.invoiceId) && heads.has(n.invoiceId)),
    heads, docs, lines: new Map(lineRows.map((l) => [l.id, l] as const)), linesByInvoice, owners: ownersOf(docs, lineRows),
  };
}

async function storeFilter(db: Db, storeCode: string | null | undefined): Promise<{ id: string | null; stores: Map<string, { code: string; name: string }> }> {
  const all = await listStores(db);
  const stores = new Map(all.map((s) => [s.id, { code: s.code, name: s.name }] as const));
  if (storeCode == null || storeCode === "") return { id: null, stores };
  const hit = all.find((s) => s.code.toLowerCase() === storeCode.toLowerCase());
  if (hit === undefined) throw new PharmacyError("store_missing", `${storeCode} is not a store here`);
  return { id: hit.id, stores };
}

async function patientNames(db: Db, actor: Actor, ids: readonly string[]): Promise<Map<string, { name: string; uhid: string }>> {
  const out = new Map<string, { name: string; uhid: string }>();
  const wanted = [...new Set(ids)];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    for (const p of await getPatientSummaries(db, actor, wanted.slice(i, i + CHUNK))) {
      out.set(p.requestedId, { name: p.name ?? p.alias ?? "—", uhid: p.uhid });
    }
  }
  return out;
}

function tenderOf(p: InvoicePayment | undefined): TenderLabel {
  if (p === undefined || p.allocatedPaise <= 0) return "unpaid";
  const used = (["cash", "upi", "card"] as const).filter((m) => p.byMode[m] > 0);
  return used.length === 1 ? used[0]! : used.length === 0 ? "unpaid" : "split";
}

const bps = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part * 10_000) / whole));

// ═══════════════════════════════════ the sales register ═══════════════════════════════════

export type SalesRegisterLine = {
  itemId: string; itemCode: string; itemName: string; batchId: string; batchNo: string; expiryDate: string | null;
  qtyBase: number; hsn: string; rateBps: number;
  discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number;
  costPaise: number | null; profitPaise: number | null;
};

export type SalesRegisterRow = {
  kind: "sale" | "refund";
  id: string;
  /** The invoice number, or the credit note's. */
  docNo: string;
  invoiceId: string;
  invoiceNo: string;
  date: string;
  at: string;
  source: SaleSource;
  /** The counter's dispense number (`P…`), when the sale was a dispense. */
  ref: string | null;
  storeCode: string | null;
  patientId: string; patientName: string; uhid: string;
  prescriber: string | null;
  operatorName: string;
  tender: TenderLabel | null;
  grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number;
  /** What the bill still owes (a sale only). */
  outstandingPaise: number | null;
  costPaise: number | null; profitPaise: number | null; marginBps: number | null;
  lines: SalesRegisterLine[];
};

export type SalesGroupRow = {
  key: string; label: string; sub: string | null;
  sales: number; refunds: number; qtyBase: number | null;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; discountPaise: number; returnsPaise: number; netPaise: number;
  profitPaise: number | null;
};

type SideTotals = { count: number; grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number };
export type SalesRegister = {
  from: string; to: string; preset: string; groupBy: SalesGroupBy; storeCode: string | null;
  /** Whether cost and margin are shown to this reader (`pharmacy.reports.margin`). */
  margin: boolean;
  rows: SalesRegisterRow[];
  groups: SalesGroupRow[];
  totals: {
    sales: SideTotals; refunds: SideTotals;
    net: { taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number };
    costPaise: number | null; profitPaise: number | null; marginBps: number | null;
  };
};

export type ReportInput = { preset?: string; from?: string | null; to?: string | null; storeCode?: string | null };

function emptySide(): SideTotals {
  return { count: 0, grossPaise: 0, discountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPaise: 0 };
}

export async function salesRegister(
  db: Db, actor: Actor, input: ReportInput & { groupBy?: string }, now: Date = new Date(),
): Promise<SalesRegister> {
  await requireReportPermission(db, actor, REPORTS_READ, "the sales register");
  const groupBy = (input.groupBy ?? "document") as SalesGroupBy;
  if (!SALES_GROUPS.includes(groupBy)) throw new PharmacyError("invalid_range", `"${String(input.groupBy)}" is not a way to group the register (${SALES_GROUPS.join(", ")})`);
  const range = reportRange(input.preset, reportToday(now), input);
  const withMargin = await mayReadMargin(db, actor);
  const store = await storeFilter(db, input.storeCode);
  const p = await loadPeriod(db, range.from, range.to, store.id);

  const itemIds = [...new Set([...p.docs.values()].flatMap((d) => d.lines.map((l) => l.itemId)))];
  const batchIds = [...new Set([...p.docs.values()].flatMap((d) => d.lines.map((l) => l.batchId)))];
  const [items, batches, payments, patients, operators] = await Promise.all([
    itemsByIds(db, itemIds), batchesByIds(db, batchIds), invoicePayments(db, p.sales.map((s) => s.id)),
    patientNames(db, actor, [...p.heads.values()].map((h) => h.patientId)),
    userNames(db, [...[...p.docs.values()].map((d) => d.operatorId), ...p.refunds.map((n) => n.issuedBy)].filter((id) => id !== "")),
  ]);
  const costOf = (batchId: string, qty: number): number => qty * (batches.get(batchId)?.landedCostPaise ?? 0);

  /** A register line per sale line: its main invoice line plus its pack residue, if any. */
  const saleLinesOf = (invoiceId: string): SalesRegisterLine[] => {
    const byLine = new Map<string, SalesRegisterLine>();
    for (const l of p.linesByInvoice.get(invoiceId) ?? []) {
      const o = p.owners.get(l.id);
      if (o === undefined) continue;
      const cur = byLine.get(o.line.saleLineId) ?? lineShell(o.line, l);
      cur.discountPaise += l.discountPaise;
      cur.taxablePaise += l.taxableBasePaise;
      cur.cgstPaise += l.cgstPaise;
      cur.sgstPaise += l.sgstPaise;
      cur.netPaise += l.netPaise;
      byLine.set(o.line.saleLineId, cur);
    }
    return [...byLine.values()].map((l) => withProfit(l, costOf(l.batchId, l.qtyBase)));
  };
  const lineShell = (line: SaleLine, first: InvoiceLineRead): SalesRegisterLine => {
    const item = items.get(line.itemId);
    const batch = batches.get(line.batchId);
    return {
      itemId: line.itemId, itemCode: item?.code ?? "", itemName: item?.name ?? first.serviceName, batchId: line.batchId, batchNo: batch?.batchNo ?? "",
      expiryDate: batch?.expiryDate ?? null, qtyBase: line.qtyBase, hsn: first.sacCode, rateBps: first.rateBps,
      discountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, netPaise: 0, costPaise: null, profitPaise: null,
    };
  };
  const withProfit = (l: SalesRegisterLine, cost: number): SalesRegisterLine =>
    withMargin ? { ...l, costPaise: cost, profitPaise: l.taxablePaise - cost } : l;

  /** A refund's lines: each credited invoice line folded onto its sale line; units back only off the main line. */
  const refundLinesOf = (note: CreditNoteRead): SalesRegisterLine[] => {
    const byLine = new Map<string, SalesRegisterLine>();
    for (const c of note.lines) {
      const o = p.owners.get(c.invoiceLineId);
      const il = p.lines.get(c.invoiceLineId);
      if (o === undefined || il === undefined) continue;
      const cur = byLine.get(o.line.saleLineId) ?? { ...lineShell(o.line, il), qtyBase: 0 };
      if (o.main) cur.qtyBase += c.qty;
      cur.discountPaise += c.discountPaise;
      cur.taxablePaise += c.taxableBasePaise;
      cur.cgstPaise += c.cgstPaise;
      cur.sgstPaise += c.sgstPaise;
      cur.netPaise += c.taxableBasePaise + c.cgstPaise + c.sgstPaise;
      byLine.set(o.line.saleLineId, cur);
    }
    return [...byLine.values()].map((l) => withProfit(l, costOf(l.batchId, l.qtyBase)));
  };

  const rows: SalesRegisterRow[] = [];
  for (const h of p.sales) {
    const d = p.docs.get(h.id)!;
    const who = patients.get(h.patientId);
    const lines = saleLinesOf(h.id);
    const cost = withMargin ? lines.reduce((s, l) => s + (l.costPaise ?? 0), 0) : null;
    rows.push({
      kind: "sale", id: h.id, docNo: h.invoiceNo, invoiceId: h.id, invoiceNo: h.invoiceNo, date: h.serviceDay, at: h.issuedAt,
      source: d.source, ref: d.ref, storeCode: d.storeResourceId === null ? null : (store.stores.get(d.storeResourceId)?.code ?? null),
      patientId: h.patientId, patientName: who?.name ?? "—", uhid: who?.uhid ?? "", prescriber: d.prescriber,
      operatorName: operators.get(d.operatorId) ?? d.operatorId, tender: tenderOf(payments.get(h.id)),
      grossPaise: h.grossPaise, discountPaise: h.discountPaise, taxablePaise: h.taxableBasePaise, cgstPaise: h.cgstPaise, sgstPaise: h.sgstPaise,
      roundingPaise: h.roundingPaise, netPaise: h.netPayablePaise, outstandingPaise: payments.get(h.id)?.outstandingPaise ?? h.netPayablePaise,
      costPaise: cost, profitPaise: cost === null ? null : h.taxableBasePaise - cost, marginBps: cost === null ? null : bps(h.taxableBasePaise - cost, h.taxableBasePaise),
      lines,
    });
  }
  for (const n of p.refunds) {
    const h = p.heads.get(n.invoiceId)!;
    const d = p.docs.get(n.invoiceId)!;
    const who = patients.get(h.patientId);
    const lines = refundLinesOf(n);
    const cost = withMargin ? lines.reduce((s, l) => s + (l.costPaise ?? 0), 0) : null;
    rows.push({
      kind: "refund", id: n.id, docNo: n.creditNoteNo, invoiceId: h.id, invoiceNo: h.invoiceNo, date: n.day, at: n.issuedAt,
      source: d.source, ref: d.ref, storeCode: d.storeResourceId === null ? null : (store.stores.get(d.storeResourceId)?.code ?? null),
      patientId: h.patientId, patientName: who?.name ?? "—", uhid: who?.uhid ?? "", prescriber: d.prescriber,
      operatorName: operators.get(n.issuedBy) ?? n.issuedBy, tender: null,
      grossPaise: n.grossPaise, discountPaise: n.discountPaise, taxablePaise: n.taxableBasePaise, cgstPaise: n.cgstPaise, sgstPaise: n.sgstPaise,
      roundingPaise: n.roundingPaise, netPaise: n.netPaise, outstandingPaise: null,
      costPaise: cost, profitPaise: cost === null ? null : n.taxableBasePaise - cost, marginBps: cost === null ? null : bps(n.taxableBasePaise - cost, n.taxableBasePaise),
      lines,
    });
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.docNo.localeCompare(b.docNo)));

  const sales = emptySide();
  const refunds = emptySide();
  for (const r of rows) {
    const s = r.kind === "sale" ? sales : refunds;
    s.count += 1;
    s.grossPaise += r.grossPaise;
    s.discountPaise += r.discountPaise;
    s.taxablePaise += r.taxablePaise;
    s.cgstPaise += r.cgstPaise;
    s.sgstPaise += r.sgstPaise;
    s.roundingPaise += r.roundingPaise;
    s.netPaise += r.netPaise;
  }
  const costPaise = withMargin ? rows.reduce((s, r) => s + (r.kind === "sale" ? 1 : -1) * (r.costPaise ?? 0), 0) : null;
  const netTaxable = sales.taxablePaise - refunds.taxablePaise;
  return {
    from: range.from, to: range.to, preset: range.preset, groupBy, storeCode: input.storeCode ?? null, margin: withMargin,
    rows, groups: groupSales(rows, groupBy, withMargin),
    totals: {
      sales, refunds,
      net: { taxablePaise: netTaxable, cgstPaise: sales.cgstPaise - refunds.cgstPaise, sgstPaise: sales.sgstPaise - refunds.sgstPaise, netPaise: sales.netPaise - refunds.netPaise },
      costPaise, profitPaise: costPaise === null ? null : netTaxable - costPaise, marginBps: costPaise === null ? null : bps(netTaxable - costPaise, netTaxable),
    },
  };
}

function groupSales(rows: readonly SalesRegisterRow[], groupBy: SalesGroupBy, withMargin: boolean): SalesGroupRow[] {
  if (groupBy === "document") return [];
  const groups = new Map<string, SalesGroupRow>();
  const at = (key: string, label: string, sub: string | null, qty: boolean): SalesGroupRow => {
    const g = groups.get(key) ?? {
      key, label, sub, sales: 0, refunds: 0, qtyBase: qty ? 0 : null, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, discountPaise: 0,
      returnsPaise: 0, netPaise: 0, profitPaise: withMargin ? 0 : null,
    };
    groups.set(key, g);
    return g;
  };
  for (const r of rows) {
    const sign = r.kind === "sale" ? 1 : -1;
    if (groupBy === "item") {
      for (const l of r.lines) {
        const g = at(l.itemId, l.itemName, l.itemCode, true);
        if (r.kind === "sale") g.sales += 1; else g.refunds += 1;
        g.qtyBase = (g.qtyBase ?? 0) + sign * l.qtyBase;
        g.taxablePaise += sign * l.taxablePaise;
        g.cgstPaise += sign * l.cgstPaise;
        g.sgstPaise += sign * l.sgstPaise;
        g.discountPaise += sign * l.discountPaise;
        if (r.kind === "refund") g.returnsPaise += l.netPaise;
        g.netPaise += sign * l.netPaise;
        if (g.profitPaise !== null) g.profitPaise += sign * (l.profitPaise ?? 0);
      }
      continue;
    }
    const [key, label, sub] = groupBy === "doctor" ? [r.prescriber ?? "", r.prescriber ?? "—", null]
      : groupBy === "patient" ? [r.patientId, r.patientName, r.uhid]
        : groupBy === "operator" ? [r.operatorName, r.operatorName, null]
          : [r.tender ?? "refund", r.tender ?? "refund", null];
    const g = at(key, label, sub, false);
    if (r.kind === "sale") g.sales += 1; else g.refunds += 1;
    g.taxablePaise += sign * r.taxablePaise;
    g.cgstPaise += sign * r.cgstPaise;
    g.sgstPaise += sign * r.sgstPaise;
    g.discountPaise += sign * r.discountPaise;
    if (r.kind === "refund") g.returnsPaise += r.netPaise;
    g.netPaise += sign * r.netPaise;
    if (g.profitPaise !== null) g.profitPaise += sign * (r.profitPaise ?? 0);
  }
  return [...groups.values()].sort((a, b) => b.netPaise - a.netPaise || a.label.localeCompare(b.label));
}

// ═══════════════════════════════════ the margin report ═══════════════════════════════════

export type MarginRow = {
  key: string; label: string; sub: string | null;
  qtyBase: number | null; revenuePaise: number; costPaise: number; marginPaise: number; marginBps: number | null;
};
export type MarginReport = {
  from: string; to: string; preset: string; groupBy: MarginGroupBy; storeCode: string | null;
  rows: MarginRow[];
  totals: { revenuePaise: number; costPaise: number; marginPaise: number; marginBps: number | null };
};

/**
 * REVENUE LESS COST, per sale line, folded by item, category (the dosage form the formulary records
 * for a drug; the item's class otherwise) or prescriber. Revenue is the TAXABLE value (GST is not the
 * hospital's income), net of the period's refunds; cost is the units sold less the units returned,
 * at the batch's GRN cost. Refused without `pharmacy.reports.margin`.
 */
export async function marginReport(
  db: Db, actor: Actor, input: ReportInput & { groupBy?: string }, now: Date = new Date(),
): Promise<MarginReport> {
  await requireReportPermission(db, actor, REPORTS_READ, "the margin report");
  await requireReportPermission(db, actor, REPORTS_MARGIN, "the margin report");
  const groupBy = (input.groupBy ?? "item") as MarginGroupBy;
  if (!MARGIN_GROUPS.includes(groupBy)) throw new PharmacyError("invalid_range", `"${String(input.groupBy)}" is not a way to group the margin (${MARGIN_GROUPS.join(", ")})`);
  const register = await salesRegister(db, actor, { ...input, groupBy: "document" }, now);
  const itemIds = [...new Set(register.rows.flatMap((r) => r.lines.map((l) => l.itemId)))];
  const items = await itemsByIds(db, itemIds);
  const categoryOf = new Map<string, string>();
  if (groupBy === "category") {
    const medIds = [...new Set([...items.values()].map((i) => i.formularyMedicineId).filter((m): m is string => m !== null))];
    const forms = new Map<string, string>();
    for (let i = 0; i < medIds.length; i += 500) {
      for (const [id, m] of await medicinesByIds(db, medIds.slice(i, i + 500))) forms.set(id, m.form);
    }
    for (const it of items.values()) categoryOf.set(it.id, (it.formularyMedicineId === null ? undefined : forms.get(it.formularyMedicineId)) ?? it.class);
  }
  const groups = new Map<string, MarginRow>();
  for (const r of register.rows) {
    const sign = r.kind === "sale" ? 1 : -1;
    for (const l of r.lines) {
      const [key, label, sub] = groupBy === "item" ? [l.itemId, l.itemName, l.itemCode]
        : groupBy === "category" ? [categoryOf.get(l.itemId) ?? "—", categoryOf.get(l.itemId) ?? "—", null]
          : [r.prescriber ?? "", r.prescriber ?? "—", null];
      const g = groups.get(key) ?? { key, label, sub, qtyBase: groupBy === "item" ? 0 : null, revenuePaise: 0, costPaise: 0, marginPaise: 0, marginBps: null };
      if (g.qtyBase !== null) g.qtyBase += sign * l.qtyBase;
      g.revenuePaise += sign * l.taxablePaise;
      g.costPaise += sign * (l.costPaise ?? 0);
      groups.set(key, g);
    }
  }
  const rows = [...groups.values()].map((g) => ({ ...g, marginPaise: g.revenuePaise - g.costPaise, marginBps: bps(g.revenuePaise - g.costPaise, g.revenuePaise) }))
    .sort((a, b) => b.marginPaise - a.marginPaise || a.label.localeCompare(b.label));
  const revenuePaise = rows.reduce((s, r) => s + r.revenuePaise, 0);
  const costPaise = rows.reduce((s, r) => s + r.costPaise, 0);
  return {
    from: register.from, to: register.to, preset: register.preset, groupBy, storeCode: register.storeCode, rows,
    totals: { revenuePaise, costPaise, marginPaise: revenuePaise - costPaise, marginBps: bps(revenuePaise - costPaise, revenuePaise) },
  };
}

// ═══════════════════════════════════ the HSN summary ═══════════════════════════════════

export type HsnRow = {
  hsn: string; rateBps: number; exempt: boolean; uqc: string;
  qty: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number; valuePaise: number;
};
export type HsnReport = {
  from: string; to: string; preset: string; storeCode: string | null;
  rows: HsnRow[];
  totals: { qty: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number; valuePaise: number };
};

/** GSTR-1's unit quantity codes for the base units a pharmacy counts in; anything else is `NOS`. */
const UQC: Record<string, string> = {
  tablet: "TBS", tab: "TBS", ml: "MLT", millilitre: "MLT", g: "GMS", gm: "GMS", gram: "GMS", kg: "KGS", bottle: "BTL", box: "BOX",
  vial: "NOS", ampoule: "NOS", capsule: "NOS", strip: "NOS", piece: "PCS", pcs: "PCS", pair: "PRS", tube: "TUB", litre: "LTR",
};
export const uqcOf = (baseUom: string): string => UQC[baseUom.trim().toLowerCase()] ?? "NOS";

/**
 * GSTR-1 TABLE 12 FOR THE PHARMACY: outward supply by HSN × rate × unit — taxable value, the tax
 * heads and the quantity — net of the period's credit notes. Billing's GSTR-1 (`gstr1Summary`) has no
 * HSN table, so this is built here from the SAME stored line heads it sums (never recomputed), with
 * the HSN each invoice line printed (its `sacCode`, which the pharmacy bill prints as "HSN"). The
 * quantity is the base units sold less the units returned (a pack residue line carries none). Intra-
 * state supply only: IGST is nil.
 */
export async function hsnReport(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<HsnReport> {
  await requireReportPermission(db, actor, REPORTS_READ, "the HSN summary");
  const range = reportRange(input.preset, reportToday(now), input);
  const store = await storeFilter(db, input.storeCode);
  const p = await loadPeriod(db, range.from, range.to, store.id);
  const itemIds = [...new Set([...p.docs.values()].flatMap((d) => d.lines.map((l) => l.itemId)))];
  const items = await itemsByIds(db, itemIds);
  const groups = new Map<string, HsnRow>();
  const fold = (l: InvoiceLineRead, qty: number, money: { taxable: number; cgst: number; sgst: number }, sign: 1 | -1): void => {
    const o = p.owners.get(l.id);
    const uqc = uqcOf(o === undefined ? "" : (items.get(o.line.itemId)?.baseUom ?? ""));
    const key = `${l.sacCode}|${String(l.rateBps)}|${String(l.exempt)}|${uqc}`;
    const g = groups.get(key) ?? { hsn: l.sacCode, rateBps: l.rateBps, exempt: l.exempt, uqc, qty: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, valuePaise: 0 };
    g.qty += sign * qty;
    g.taxablePaise += sign * money.taxable;
    g.cgstPaise += sign * money.cgst;
    g.sgstPaise += sign * money.sgst;
    g.taxPaise = g.cgstPaise + g.sgstPaise + g.igstPaise;
    g.valuePaise = g.taxablePaise + g.taxPaise;
    groups.set(key, g);
  };
  for (const h of p.sales) {
    for (const l of p.linesByInvoice.get(h.id) ?? []) {
      const o = p.owners.get(l.id);
      fold(l, o?.main === true ? o.line.qtyBase : 0, { taxable: l.taxableBasePaise, cgst: l.cgstPaise, sgst: l.sgstPaise }, 1);
    }
  }
  for (const n of p.refunds) {
    for (const c of n.lines) {
      const l = p.lines.get(c.invoiceLineId);
      if (l === undefined) continue;
      fold(l, p.owners.get(l.id)?.main === true ? c.qty : 0, { taxable: c.taxableBasePaise, cgst: c.cgstPaise, sgst: c.sgstPaise }, -1);
    }
  }
  const rows = [...groups.values()].sort((a, b) => (a.hsn < b.hsn ? -1 : a.hsn > b.hsn ? 1 : a.rateBps - b.rateBps || a.uqc.localeCompare(b.uqc)));
  const sum = (k: "qty" | "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "taxPaise" | "valuePaise"): number => rows.reduce((s, r) => s + r[k], 0);
  return {
    from: range.from, to: range.to, preset: range.preset, storeCode: input.storeCode ?? null, rows,
    totals: { qty: sum("qty"), taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise"), taxPaise: sum("taxPaise"), valuePaise: sum("valuePaise") },
  };
}

// ═══════════════════════════════════ the period, for the Tally export ═══════════════════════════════════

/** A B2B buyer: the GSTIN billing recorded on the invoice, and the legal name with it. A B2C bill has none. */
export type SaleBuyer = { gstin: string; legalName: string | null };
const buyerOf = (h: { buyerGstin: string | null; buyerLegalName: string | null }): SaleBuyer | null => {
  const gstin = h.buyerGstin?.trim() ?? "";
  return gstin === "" ? null : { gstin, legalName: h.buyerLegalName?.trim() || null };
};

export type PeriodSale = {
  id: string; invoiceNo: string; serviceDay: string; ref: string | null; buyer: SaleBuyer | null;
  taxableBasePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPayablePaise: number;
};
export type PeriodRefund = {
  id: string; creditNoteNo: string; day: string; invoiceNo: string; buyer: SaleBuyer | null;
  taxableBasePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number;
};

/**
 * PARITY P5 (TALLY) — the period's pharmacy bills and credit notes exactly as the register reads them
 * (the same `loadPeriod`), each with its B2B buyer if billing recorded one; and a lookup over billing's
 * hospital-wide receipts and refunds: which of those invoices are the pharmacy's (their numbers and
 * buyers). NO PATIENT: the books take a counter sale on one ledger, so nothing here reads who the
 * patient is. The caller has already been gated.
 */
export async function pharmacySalesPeriod(db: Db, from: string, to: string): Promise<{
  sales: PeriodSale[]; refunds: PeriodRefund[];
  pharmacyInvoices: (invoiceIds: readonly string[]) => Promise<Map<string, { invoiceNo: string; buyer: SaleBuyer | null }>>;
}> {
  const p = await loadPeriod(db, from, to, null);
  return {
    sales: p.sales.map((h) => ({
      id: h.id, invoiceNo: h.invoiceNo, serviceDay: h.serviceDay, ref: p.docs.get(h.id)?.ref ?? null, buyer: buyerOf(h),
      taxableBasePaise: h.taxableBasePaise, cgstPaise: h.cgstPaise, sgstPaise: h.sgstPaise, roundingPaise: h.roundingPaise, netPayablePaise: h.netPayablePaise,
    })),
    refunds: p.refunds.map((n) => {
      const h = p.heads.get(n.invoiceId)!;
      return {
        id: n.id, creditNoteNo: n.creditNoteNo, day: n.day, invoiceNo: h.invoiceNo, buyer: buyerOf(h),
        taxableBasePaise: n.taxableBasePaise, cgstPaise: n.cgstPaise, sgstPaise: n.sgstPaise, roundingPaise: n.roundingPaise, netPaise: n.netPaise,
      };
    }),
    pharmacyInvoices: async (invoiceIds) => {
      const docs = await saleDocsOf(db, invoiceIds);
      const heads = await invoiceHeadsByIds(db, [...docs.keys()]);
      return new Map(heads.map((h) => [h.id, { invoiceNo: h.invoiceNo, buyer: buyerOf(h) }] as const));
    },
  };
}
