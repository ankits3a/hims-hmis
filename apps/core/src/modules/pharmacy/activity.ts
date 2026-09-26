import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { events, pharmacyDispenses, pharmacyRetailSales } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { billingDocumentByNo } from "../billing";
import { findDocumentByNo, itemsByIds } from "../materials";
import { userNames } from "./queue";
import { PharmacyError } from "./errors";
import { REPORTS_READ, reportRange, reportToday, requireReportPermission } from "./report-range";
import type { MaterialsDocKind } from "../materials";
import type { ReportInput } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE ACTIVITY VIEW: WHAT HAPPENED TO A DOCUMENT, AND WHAT CHANGED ═══
 *
 * Healthray's Activity screens (s15–s17) show a bill's history with a before/after of each edit. Our
 * history is the EVENT LOG (`events`: name, actor, occurred_at, payload), which every act already
 * writes in the same transaction as the act — so nothing new is recorded for this view; it only reads.
 *
 * A person types a document number — a pharmacy bill (`INV/…`) or its dispense (`P…`), a credit note
 * against one, our supplier bill (`MSB…`), a payment run (`MPR…`), a return or its debit note
 * (`MRT…` / `MDN…`), the vendor's credit as booked (`MCN…`), a write-off (`MWO…`) — and gets its
 * timeline, oldest first. Each entry says what changed:
 *
 *   - where the event CARRIES before and after (`supplier_bill.updated`'s `changes`, parity P5), those;
 *   - otherwise, derived from CONSECUTIVE STATES: every event's payload is folded into the document's
 *     running state (its status, its total, its line count, …) and an entry lists each field whose
 *     value moved from the state before it.
 *
 * Read-only, under `pharmacy.reports.read` (the owner, the materials head, the pharmacist in charge,
 * the billing office). The feed (`recentActivity`) lists the period's events on these documents so a
 * person can open one without knowing its number.
 */

export type ActivityKind = "pharmacy_bill" | MaterialsDocKind;
export type ActivityChange = { field: string; label: string; before: string | number | boolean | null; after: string | number | boolean | null };
export type ActivityEntry = {
  at: string; name: string; actorId: string; actorName: string;
  /** The document's status after this event, when the event moves it. */
  status: string | null;
  changes: ActivityChange[];
  /** The payload's scalar facts worth a line on the timeline (numbers, references, reasons). */
  facts: Record<string, string | number | boolean | null>;
};
export type ActivityTimeline = { kind: ActivityKind; id: string; no: string; label: string; entries: ActivityEntry[] };

/** Every event name the view reads, and the status each one leaves its document in (null: none). */
const STATUS_AFTER: Record<string, string | null> = {
  // the pharmacy bill: billing's invoice and the counter's dispense or sale
  "invoice.issued": "issued", "payment.received": null, "invoice.credit_extended": null, "credit_note.issued": "credited",
  "refund_voucher.issued": null, "payment.refunded": null, "allocation.reversed": null,
  "dispense.billed": "billed", "dispense.handed_over": "handed_over", "dispense.cancelled": "cancelled", "dispense.line_returned": null,
  "retail.sold": "sold", "retail.line_returned": null,
  // the supplier bill
  "supplier_bill.drafted": "draft", "supplier_bill.updated": "draft", "supplier_bill.matched": null, "supplier_bill.accepted": "accepted",
  "supplier_bill.cancelled": "cancelled", "supplier_payment.recorded": null,
  // the payment run
  "payment_run.drafted": "draft", "payment_run.updated": "draft", "payment_run.submitted": "pending_authorisation",
  "payment_run.authorised": "authorised", "payment_run.rejected": "draft", "payment_run.cancelled": "cancelled", "payment_run.completed": "completed",
  // the return, our debit note, the vendor's credit
  "supplier_return.drafted": "draft", "supplier_return.updated": "draft", "supplier_return.approved": "approved",
  "supplier_return.dispatched": "dispatched", "supplier_return.cancelled": "cancelled", "supplier_return.closed": "closed",
  "supplier_credit.recorded": "credited", "supplier_credit.cancelled": "dispatched",
  // the write-off
  "stock_write_off.requested": "requested", "stock_write_off.refused": "refused", "stock_write_off.posted": "posted",
};
const NAMES = Object.keys(STATUS_AFTER);

/** Payload fields that describe the document's state (compared event to event); the rest are facts. */
const STATE_FIELDS = [
  "totalPaise", "netPaise", "netPayablePaise", "expectedTotalPaise", "lines", "bills", "vendors", "vendorBillNo", "dueDate", "amountPaise",
  "debitNoteNo", "taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "outcome", "tier",
] as const;
const FACT_FIELDS = [
  "billNo", "runNo", "returnNo", "writeOffNo", "creditNo", "creditNoteNo", "invoiceNo", "paymentNo", "dispenseNo", "mode", "reference", "paidOn",
  "reason", "note", "differenceReason", "differencePaise", "source", "disposalAgency", "manifestNo", "kind", "vendorCreditNoteNo", "fromStatus",
] as const;

const LABEL: Record<string, string> = {
  totalPaise: "Total", netPaise: "Net", netPayablePaise: "Net payable", expectedTotalPaise: "Expected total", lines: "Lines", bills: "Bills",
  vendors: "Vendors", vendorBillNo: "Vendor bill no.", dueDate: "Due date", amountPaise: "Amount", debitNoteNo: "Debit note",
  taxablePaise: "Taxable", cgstPaise: "CGST", sgstPaise: "SGST", igstPaise: "IGST", outcome: "Match", tier: "Approval tier", status: "Status",
  billDate: "Bill date", interState: "Inter-state", roundOffPaise: "Round-off", qtyPacks: "Qty (packs)", ratePaise: "Rate", gstRateBps: "GST rate",
  uom: "Pack",
};

type Scalar = string | number | boolean | null;
const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

/** The document a typed number names, and every id its events are correlated on. */
async function resolve(db: Db, typed: string): Promise<{ kind: ActivityKind; id: string; no: string; label: string; ids: string[]; runId?: string; billId?: string }> {
  const no = typed.trim();
  if (no === "") throw new PharmacyError("not_found", "type a document number");
  const m = await findDocumentByNo(db, no);
  if (m !== null) {
    return { kind: m.kind, id: m.id, no: m.no, label: m.label, ids: m.ids, ...(m.kind === "payment_run" ? { runId: m.id } : {}), ...(m.kind === "supplier_bill" ? { billId: m.id } : {}) };
  }
  let invoiceId: string | null = null;
  let shownNo = no;
  const b = await billingDocumentByNo(db, no);
  if (b !== null) { invoiceId = b.invoiceId; shownNo = b.no; }
  const byDispenseNo = invoiceId === null
    ? (await db.select({ invoiceId: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(sql`upper(${pharmacyDispenses.dispenseNo}) = ${no.toUpperCase()}`).limit(1))[0]
    : undefined;
  if (byDispenseNo?.invoiceId != null) invoiceId = byDispenseNo.invoiceId;
  if (invoiceId === null) throw new PharmacyError("not_found", `no document numbered ${no} — a pharmacy bill, credit note, dispense, supplier bill, payment run, return, debit note, vendor credit or write-off`);
  const d = (await db.select({ id: pharmacyDispenses.id, no: pharmacyDispenses.dispenseNo }).from(pharmacyDispenses).where(eq(pharmacyDispenses.invoiceId, invoiceId)))[0];
  const s = (await db.select({ id: pharmacyRetailSales.id }).from(pharmacyRetailSales).where(eq(pharmacyRetailSales.invoiceId, invoiceId)))[0];
  if (d === undefined && s === undefined) throw new PharmacyError("not_found", `${no} is not a pharmacy bill — the activity view reads the pharmacy's documents`);
  return {
    kind: "pharmacy_bill", id: invoiceId, no: shownNo, label: d?.no ?? "walk-in sale",
    ids: [invoiceId, ...(d === undefined ? [] : [d.id]), ...(s === undefined ? [] : [s.id])],
  };
}

/** The timeline of one document, oldest first, each entry with what it changed. */
export async function documentActivity(db: Db, actor: Actor, typed: string): Promise<ActivityTimeline> {
  await requireReportPermission(db, actor, REPORTS_READ, "the activity view");
  const doc = await resolve(db, typed);
  const rows = await db.select({
    seq: events.seq, name: events.name, actorId: events.actorId, occurredAt: events.occurredAt, payload: events.payload,
  }).from(events).where(and(
    inArray(events.name, NAMES),
    or(
      inArray(events.correlationId, doc.ids),
      doc.runId === undefined ? undefined : and(eq(events.name, "supplier_payment.recorded"), sql`${events.payload}->>'runId' = ${doc.runId}`),
      doc.billId === undefined ? undefined : and(eq(events.name, "supplier_payment.recorded"), sql`${events.payload}->'bills' @> ${JSON.stringify([{ billId: doc.billId }])}::jsonb`),
    ),
  )).orderBy(asc(events.occurredAt), asc(events.seq)).limit(500);

  const itemIds = new Set<string>();
  for (const r of rows) {
    const p = r.payload as { changes?: { field: string }[] };
    for (const c of p.changes ?? []) { const m = /^lines\.([^.]+)\./.exec(c.field); if (m !== null) itemIds.add(m[1]!); }
  }
  const [names, items] = await Promise.all([userNames(db, rows.map((r) => r.actorId)), itemsByIds(db, [...itemIds])]);
  const labelOf = (field: string): string => {
    const m = /^lines\.([^.]+)\.(.+)$/.exec(field);
    if (m !== null) return `${items.get(m[1]!)?.name ?? m[1]!} · ${LABEL[m[2]!] ?? m[2]!}`;
    return LABEL[field] ?? field;
  };

  const state = new Map<string, Scalar>();
  const entries: ActivityEntry[] = [];
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>;
    const changes: ActivityChange[] = [];
    const moved = (field: string, value: Scalar): void => {
      if (state.has(field) && state.get(field) !== value) changes.push({ field, label: labelOf(field), before: state.get(field)!, after: value });
      state.set(field, value);
    };
    // A bill paid on a voucher: its own settlement, not the voucher's total.
    const mine = doc.billId !== undefined && r.name === "supplier_payment.recorded"
      ? (p.bills as { billId: string; paidPaise: number; status: string; creditPaise?: number }[] | undefined)?.find((x) => x.billId === doc.billId)
      : undefined;
    const status = mine?.status ?? (r.name === "supplier_bill.matched" ? String(p.outcome) : STATUS_AFTER[r.name] ?? null);
    const explicit = Array.isArray(p.changes) ? (p.changes as { field: string; before: Scalar; after: Scalar }[]) : null;
    if (explicit !== null) {
      for (const c of explicit) changes.push({ field: c.field, label: labelOf(c.field), before: c.before, after: c.after });
      for (const f of STATE_FIELDS) if (isScalar(p[f])) state.set(f, p[f]);
    } else {
      for (const f of STATE_FIELDS) if (isScalar(p[f]) && !(mine !== undefined && f === "amountPaise")) moved(f, p[f]);
    }
    if (status !== null) moved("status", status);
    const facts: Record<string, Scalar> = {};
    for (const f of FACT_FIELDS) if (isScalar(p[f]) && p[f] !== null) facts[f] = p[f];
    if (mine !== undefined) { facts.paidPaise = mine.paidPaise; if (mine.creditPaise !== undefined) facts.creditPaise = mine.creditPaise; }
    entries.push({ at: r.occurredAt.toISOString(), name: r.name, actorId: r.actorId, actorName: names.get(r.actorId) ?? r.actorId, status, changes, facts });
  }
  return { kind: doc.kind, id: doc.id, no: doc.no, label: doc.label, entries };
}

export type ActivityFeedRow = { at: string; name: string; actorName: string; docNo: string | null; amountPaise: number | null };

/**
 * The period's events on the office's documents, newest first (at most 300): the list a person opens
 * a document's timeline from. The document number is whichever the payload names.
 */
export async function recentActivity(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<{ from: string; to: string; rows: ActivityFeedRow[] }> {
  await requireReportPermission(db, actor, REPORTS_READ, "the activity view");
  const range = reportRange(input.preset, reportToday(now), input);
  const { start } = istDayWindow(new Date(`${range.from}T12:00:00+05:30`));
  const { end } = istDayWindow(new Date(`${range.to}T12:00:00+05:30`));
  const rows = await db.select({ name: events.name, actorId: events.actorId, occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(and(inArray(events.name, NAMES.filter((n) => !["payment.received", "allocation.reversed", "payment.refunded"].includes(n))),
      gte(events.occurredAt, start), lt(events.occurredAt, end), gte(events.recordedAt, start)))
    .orderBy(desc(events.occurredAt), desc(events.seq)).limit(300);
  // Billing's invoice events are hospital-wide: keep only the pharmacy's own bills.
  const invoiceIds = [...new Set(rows.filter((r) => r.name.startsWith("invoice.") || r.name.startsWith("credit_note.") || r.name.startsWith("refund_voucher."))
    .map((r) => String((r.payload as { invoiceId?: unknown }).invoiceId ?? "")).filter((x) => x !== ""))];
  const pharmacyInvoices = new Set<string>();
  if (invoiceIds.length > 0) {
    for (const r of await db.select({ id: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.invoiceId, invoiceIds))) if (r.id !== null) pharmacyInvoices.add(r.id);
    for (const r of await db.select({ id: pharmacyRetailSales.invoiceId }).from(pharmacyRetailSales).where(inArray(pharmacyRetailSales.invoiceId, invoiceIds))) pharmacyInvoices.add(r.id);
  }
  const kept = rows.filter((r) => {
    if (!(r.name.startsWith("invoice.") || r.name.startsWith("credit_note.") || r.name.startsWith("refund_voucher."))) return true;
    return pharmacyInvoices.has(String((r.payload as { invoiceId?: unknown }).invoiceId ?? ""));
  });
  const names = await userNames(db, kept.map((r) => r.actorId));
  return {
    from: range.from, to: range.to,
    // An event that names no document number (a dispense's own steps) is reached through its bill's.
    rows: kept.map((r) => {
      const p = r.payload as Record<string, unknown>;
      const docNo = ["creditNoteNo", "invoiceNo", "billNo", "runNo", "debitNoteNo", "returnNo", "writeOffNo", "creditNo"]
        .map((k) => p[k]).find((v): v is string => typeof v === "string" && v !== "") ?? null;
      const money = ["totalPaise", "netPaise", "netPayablePaise", "amountPaise", "totalValuePaise"].map((k) => p[k]).find((v): v is number => typeof v === "number");
      return { at: r.occurredAt.toISOString(), name: r.name, actorName: names.get(r.actorId) ?? r.actorId, docNo, amountPaise: money ?? null };
    }).filter((r) => r.docNo !== null),
  };
}
