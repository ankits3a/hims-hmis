import { and, asc, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { allocations, creditNoteLines, creditNotes, invoiceLines, invoices, receiptTenders } from "../../kernel/db/schema";
import { enteredInErrorDocIds } from "./daily-close";
import { allocatedByInvoice, creditedByInvoice } from "./receipts";
import { IST_OFFSET_MS } from "./time";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE MONEY A REPORT READS, AS BILLING STORED IT ═══
 *
 * The office's registers (sales, margin, HSN) and the Tally export are about pharmacy bills, and a
 * pharmacy bill is billing's invoice: billing owns `invoices`, `invoice_lines`, `credit_notes` and the
 * receipts that settle them. These readers hand those rows out, read-only, so the pharmacy never
 * queries a billing table for money (spec §4, the `invoiceLineCredits` precedent).
 *
 * THE SAME TWO RULES AS THE DAY BOOK AND GSTR-1 (`daily-close.ts`):
 *   - an `entered-in-error` invoice or credit note is not a document: it is left out here exactly
 *     as `dayBook` and `gstr1Summary` leave it out, so a register can be reconciled to either;
 *   - money is the STORED heads, never recomputed: every figure below is a column persistence wrote.
 *
 * Bounded: a caller passes ids in any number, and each `inArray` goes in chunks well under the
 * 65,535-parameter bind ceiling (`pharmacy/bounded-reads.test.ts` is why that matters).
 */
const CHUNK = 5_000;
const DAY_MS = 86_400_000;

async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const wanted = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < wanted.length; i += CHUNK) out.push(...(await read(wanted.slice(i, i + CHUNK))));
  return out;
}

async function deadAmong(exec: Db | Tx, docType: string, ids: readonly string[]): Promise<Set<string>> {
  const dead = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const id of await enteredInErrorDocIds(exec, docType, ids.slice(i, i + CHUNK))) dead.add(id);
  }
  return dead;
}

/** The UTC half-open window of IST days `from`..`to` inclusive — the grain credit notes are cut on. */
function istWindow(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - IST_OFFSET_MS);
  const end = new Date(Date.parse(`${to}T00:00:00.000Z`) - IST_OFFSET_MS + DAY_MS);
  return { start, end };
}

export type InvoiceHead = {
  id: string; invoiceNo: string; patientId: string; encounterId: string | null; serviceDay: string; issuedAt: string; issuedBy: string;
  buyerGstin: string | null; grossPaise: number; discountPaise: number; taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
  rawTotalPaise: number; roundingPaise: number; netPayablePaise: number;
};

const headColumns = {
  id: invoices.id, invoiceNo: invoices.invoiceNo, patientId: invoices.patientId, encounterId: invoices.encounterId,
  serviceDay: invoices.serviceDay, issuedAt: invoices.issuedAt, issuedBy: invoices.issuedBy, buyerGstin: invoices.buyerGstin,
  grossPaise: invoices.grossPaise, discountPaise: invoices.discountPaise, taxableBasePaise: invoices.taxableBasePaise,
  cgstPaise: invoices.cgstPaise, sgstPaise: invoices.sgstPaise, rawTotalPaise: invoices.rawTotalPaise,
  roundingPaise: invoices.roundingPaise, netPayablePaise: invoices.netPayablePaise,
};

function toHead(r: Omit<InvoiceHead, "issuedAt"> & { issuedAt: Date }): InvoiceHead {
  return { ...r, issuedAt: r.issuedAt.toISOString() };
}

/**
 * Every LIVE invoice whose service day (the IST grain persistence stamps, the day book's) falls in
 * `from`..`to` inclusive, oldest first. `entered-in-error` invoices are left out.
 */
export async function invoicesBetween(exec: Db | Tx, from: string, to: string): Promise<InvoiceHead[]> {
  const rows = await exec.select(headColumns).from(invoices)
    .where(and(gte(invoices.serviceDay, from), lte(invoices.serviceDay, to)))
    .orderBy(asc(invoices.serviceDay), asc(invoices.seq));
  const dead = await deadAmong(exec, "invoice", rows.map((r) => r.id));
  return rows.filter((r) => !dead.has(r.id)).map(toHead);
}

/** The named invoices, live ones only (an `entered-in-error` invoice is not a document). */
export async function invoiceHeadsByIds(exec: Db | Tx, ids: readonly string[]): Promise<InvoiceHead[]> {
  const rows = await inChunks(ids, (chunk) => exec.select(headColumns).from(invoices).where(inArray(invoices.id, chunk)));
  const dead = await deadAmong(exec, "invoice", rows.map((r) => r.id));
  return rows.filter((r) => !dead.has(r.id)).map(toHead);
}

export type InvoiceLineRead = {
  id: string; invoiceId: string; lineNo: number; serviceId: string; serviceName: string; category: string; qty: number;
  unitPaise: number; grossPaise: number; discountPaise: number; taxableBasePaise: number; sacCode: string; rateBps: number;
  exempt: boolean; cgstPaise: number; sgstPaise: number; netPaise: number;
};

/** The stored lines of the named invoices, in invoice and line order. */
export async function invoiceLinesOf(exec: Db | Tx, invoiceIds: readonly string[]): Promise<InvoiceLineRead[]> {
  const rows = await inChunks(invoiceIds, (chunk) => exec.select({
    id: invoiceLines.id, invoiceId: invoiceLines.invoiceId, lineNo: invoiceLines.lineNo, serviceId: invoiceLines.serviceId,
    serviceName: invoiceLines.serviceName, category: invoiceLines.category, qty: invoiceLines.qty, unitPaise: invoiceLines.unitPaise,
    grossPaise: invoiceLines.grossPaise, discountPaise: invoiceLines.discountPaise, taxableBasePaise: invoiceLines.taxableBasePaise,
    sacCode: invoiceLines.sacCode, rateBps: invoiceLines.rateBps, exempt: invoiceLines.exempt, cgstPaise: invoiceLines.cgstPaise,
    sgstPaise: invoiceLines.sgstPaise, netPaise: invoiceLines.netPaise,
  }).from(invoiceLines).where(inArray(invoiceLines.invoiceId, chunk)));
  return rows.sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : a.lineNo - b.lineNo));
}

export type CreditNoteLineRead = {
  invoiceLineId: string; qty: number; grossPaise: number; discountPaise: number; taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
};
export type CreditNoteRead = {
  id: string; creditNoteNo: string; invoiceId: string; kind: string; reason: string; issuedBy: string; issuedAt: string; day: string;
  grossPaise: number; discountPaise: number; taxableBasePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number;
  netPaise: number; lines: CreditNoteLineRead[];
};

/**
 * Every LIVE credit note issued in the IST days `from`..`to` inclusive, with its lines — the grain
 * `gstr1Summary` nets a period on: a credit note reduces the period it is ISSUED in, whatever day its
 * invoice was.
 */
export async function creditNotesBetween(exec: Db | Tx, from: string, to: string): Promise<CreditNoteRead[]> {
  const { start, end } = istWindow(from, to);
  const heads = await exec.select().from(creditNotes)
    .where(and(gte(creditNotes.issuedAt, start), lt(creditNotes.issuedAt, end)))
    .orderBy(asc(creditNotes.issuedAt), asc(creditNotes.creditNoteNo));
  const dead = await deadAmong(exec, "credit_note", heads.map((h) => h.id));
  const live = heads.filter((h) => !dead.has(h.id));
  const lines = await inChunks(live.map((h) => h.id), (chunk) => exec.select().from(creditNoteLines).where(inArray(creditNoteLines.creditNoteId, chunk)));
  const byNote = new Map<string, CreditNoteLineRead[]>();
  for (const l of lines) {
    const list = byNote.get(l.creditNoteId) ?? [];
    list.push({
      invoiceLineId: l.invoiceLineId, qty: l.qty, grossPaise: l.grossPaise, discountPaise: l.discountPaise,
      taxableBasePaise: l.taxableBasePaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise,
    });
    byNote.set(l.creditNoteId, list);
  }
  return live.map((h) => ({
    id: h.id, creditNoteNo: h.creditNoteNo, invoiceId: h.invoiceId, kind: h.kind, reason: h.reason, issuedBy: h.issuedBy,
    issuedAt: h.issuedAt.toISOString(),
    day: new Date(Math.floor((h.issuedAt.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10),
    grossPaise: h.grossPaise, discountPaise: h.discountPaise, taxableBasePaise: h.taxableBasePaise, cgstPaise: h.cgstPaise,
    sgstPaise: h.sgstPaise, roundingPaise: h.roundingPaise, netPaise: h.netPaise, lines: byNote.get(h.id) ?? [],
  }));
}

export type TenderMode = "cash" | "upi" | "card";
export type InvoicePayment = {
  /** Σ apply − Σ reverse allocated to the invoice (D1). */
  allocatedPaise: number;
  /** Σ live credit notes against it, whenever issued. */
  creditedPaise: number;
  /** What is still owed: net payable − allocated − credited, never below 0. */
  outstandingPaise: number;
  /** The allocated money by tender mode, each receipt's allocation split by its own tenders (cash last, since change comes out of cash). */
  byMode: Record<TenderMode, number>;
};

/**
 * How each named invoice was paid: what was allocated to it, by tender mode, what was credited and
 * what is outstanding. A receipt's allocation is split across its tenders: the non-cash tenders are
 * exact amounts the bank received, so they are set against the allocation first and cash takes the
 * rest (the change a cashier hands back comes out of cash).
 */
export async function invoicePayments(exec: Db | Tx, invoiceIds: readonly string[]): Promise<Map<string, InvoicePayment>> {
  const out = new Map<string, InvoicePayment>();
  const wanted = [...new Set(invoiceIds)];
  if (wanted.length === 0) return out;
  const heads = await inChunks(wanted, (chunk) => exec.select({ id: invoices.id, net: invoices.netPayablePaise }).from(invoices).where(inArray(invoices.id, chunk)));
  const allocated = new Map<string, number>();
  const credited = new Map<string, number>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    for (const [k, v] of await allocatedByInvoice(exec, chunk)) allocated.set(k, v);
    for (const [k, v] of await creditedByInvoice(exec, chunk)) credited.set(k, v);
  }
  const allocs = await inChunks(wanted, (chunk) => exec.select({
    receiptId: allocations.receiptId, invoiceId: allocations.invoiceId, amountPaise: allocations.amountPaise, kind: allocations.kind,
  }).from(allocations).where(inArray(allocations.invoiceId, chunk)));
  const receiptIds = [...new Set(allocs.map((a) => a.receiptId))];
  const tenders = await inChunks(receiptIds, (chunk) => exec.select({ receiptId: receiptTenders.receiptId, mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise })
    .from(receiptTenders).where(inArray(receiptTenders.receiptId, chunk)));
  const nonCashOf = new Map<string, { upi: number; card: number }>();
  for (const t of tenders) {
    const s = nonCashOf.get(t.receiptId) ?? { upi: 0, card: 0 };
    if (t.mode === "upi") s.upi += t.amountPaise;
    if (t.mode === "card") s.card += t.amountPaise;
    nonCashOf.set(t.receiptId, s);
  }
  // A receipt's non-cash pool is spent across its allocations in arrival order.
  const pool = new Map<string, { upi: number; card: number }>([...nonCashOf].map(([k, v]) => [k, { ...v }]));
  const perInvoice = new Map<string, Map<string, number>>();
  for (const a of allocs) {
    const m = perInvoice.get(a.invoiceId) ?? new Map<string, number>();
    m.set(a.receiptId, (m.get(a.receiptId) ?? 0) + (a.kind === "apply" ? a.amountPaise : -a.amountPaise));
    perInvoice.set(a.invoiceId, m);
  }
  for (const h of heads) {
    const byMode: Record<TenderMode, number> = { cash: 0, upi: 0, card: 0 };
    for (const [receiptId, amount] of perInvoice.get(h.id) ?? []) {
      if (amount <= 0) continue;
      const p = pool.get(receiptId) ?? { upi: 0, card: 0 };
      const upi = Math.min(amount, p.upi);
      const card = Math.min(amount - upi, p.card);
      p.upi -= upi;
      p.card -= card;
      pool.set(receiptId, p);
      byMode.upi += upi;
      byMode.card += card;
      byMode.cash += amount - upi - card;
    }
    const a = allocated.get(h.id) ?? 0;
    const c = credited.get(h.id) ?? 0;
    out.set(h.id, { allocatedPaise: a, creditedPaise: c, outstandingPaise: Math.max(0, h.net - a - c), byMode });
  }
  return out;
}

export type BillingDocRef = { kind: "invoice" | "credit_note"; id: string; no: string; invoiceId: string };

/** An invoice or credit note by the number printed on it (case and surrounding spaces ignored). */
export async function billingDocumentByNo(exec: Db | Tx, typed: string): Promise<BillingDocRef | null> {
  const no = typed.trim().toUpperCase();
  if (no === "") return null;
  const inv = (await exec.select({ id: invoices.id, no: invoices.invoiceNo }).from(invoices).where(sql`upper(${invoices.invoiceNo}) = ${no}`).limit(1))[0];
  if (inv !== undefined) return { kind: "invoice", id: inv.id, no: inv.no, invoiceId: inv.id };
  const cn = (await exec.select({ id: creditNotes.id, no: creditNotes.creditNoteNo, invoiceId: creditNotes.invoiceId })
    .from(creditNotes).where(sql`upper(${creditNotes.creditNoteNo}) = ${no}`).limit(1))[0];
  return cn === undefined ? null : { kind: "credit_note", id: cn.id, no: cn.no, invoiceId: cn.invoiceId };
}
