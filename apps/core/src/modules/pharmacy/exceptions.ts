import { and, eq, gt, gte, inArray, lt } from "drizzle-orm";
import {
  approvals, enteredInErrorMarks, events, grns, items, pharmacyDispenses, pharmacyRetailSales, resources, stockAdjustments,
  stockWriteOffs, supplierCreditNotes, supplierReturns, users, vendors,
} from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { usersHoldingRoleAtScope } from "../../kernel/workflow/roles";
import { creditNotesBetween, invoiceHeadsByIds } from "../billing";
import { consumptionRowsAt, findStoreByCode, getBatch, itemsByIds, purchaseAnalysisReport } from "../materials";
import { DISCOUNT_INCHARGE_APPROVAL_TYPE, DISCOUNT_OWNER_APPROVAL_TYPE } from "./discount";
import { RETAIL_REF_TYPE, istDateOf, istInstantOf, isIsoDate } from "./config";
import { PharmacyError } from "./errors";
import { LEAKAGE_STORE_CODES, pharmacyLeakage } from "./leakage";
import { userNames } from "./queue";
import { requireReportPermission } from "./report-range";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #1065 — THE PHARMACY'S EXCEPTIONS OF A DAY, AND THE OWNER'S 08:00 DIGEST (ruling 0097) ═══
 *
 * Every exception was already recorded somewhere; nothing reached the owner without going to look. This is
 * ONE read, computed on demand from the records themselves (no table of its own), for one IST day:
 *
 *   refund            a live credit note issued that day on a pharmacy bill (a paid ticket cancelled, a pack
 *                     returned at either counter, a refund at the billing desk), or a pharmacy bill voided
 *   discount          a sale discount above the pharmacist's 10% granted that day (in-charge or owner tier)
 *   stock_adjustment  a count variance posted that day under its approval (one row per line)
 *   write_off         a destruction write-off posted that day
 *   mrp_revision      a batch repriced that day at a GRN's post under its approval
 *   leakage           issued vs billed per sold line, and stock consumed outside any sale, at both counters
 *   cash              a pharmacy cashier's blind count that came out short or over (the cashier never sees it)
 *   purchase_price    a GRN line captured above the last paid price or the contract, with its reason (#1061)
 *   supplier_credit   a supplier's credit note accepted below our debit note
 *   downtime          a paper (downtime) sale entered that day
 *
 * Each row: the kind, the rupees (paise, a magnitude — biggest first), who, when, what (codes and numbers;
 * the page is the owner's alone), and a link to the screen that holds the record. Every exception is listed;
 * there is no threshold. "Expiring stock not acted on" joins when #1063 is built.
 */
export const EXCEPTIONS_VIEW = "pharmacy.exceptions.view";
export const EXCEPTION_KINDS = [
  "refund", "discount", "stock_adjustment", "write_off", "mrp_revision", "leakage", "cash", "purchase_price", "supplier_credit", "downtime",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export type PharmacyExceptionRow = {
  id: string;
  kind: ExceptionKind;
  paise: number;
  /** The person who made it happen (the approver, where an approval let it through); null when the record names nobody. */
  who: string | null;
  /** ISO instant; null when the record keeps only its day (a leakage mismatch). */
  at: string | null;
  what: string;
  /** A route of the web app. */
  link: string;
};
export type PharmacyExceptionDay = {
  day: string;
  rows: PharmacyExceptionRow[];
  totals: { kind: ExceptionKind; count: number; paise: number }[];
  count: number;
  totalPaise: number;
};

/** The alert kind and ref of the 08:00 digest; the web bell opens `refId` (the day) on the Exceptions page. */
export const EXCEPTION_DIGEST_ALERT_KIND = "pharmacy_exception_digest";
export const EXCEPTION_DIGEST_REF_TYPE = "pharmacy_exceptions_day";
/** Whose phones get the digest (ruling 0097): the owner role, alone. */
export const EXCEPTION_DIGEST_ROLE = "owner";
const PHARMACY_CASHIER_ROLES = ["pharmacy", "pharmacy_assistant", "pharmacy_incharge"] as const;
const DAY_MS = 86_400_000;
const DISPENSE_REF_TYPE = "pharmacy_dispense";

const LINK = {
  dispense: (id: string): string => `/pharmacy/desk/${id}`,
  approval: (id: string): string => `/approvals?focus=${id}`,
  reports: "/pharmacy/office?view=reports&page=reports",
  counts: "/pharmacy/office?view=stock&page=counts",
  returns: "/pharmacy/office?view=returns&page=returns",
  grn: "/pharmacy/office?view=stock&page=grn",
  bills: "/pharmacy/office?view=pay&page=bills",
  downtime: "/pharmacy/office?view=stock&page=downtime",
  leakage: "/pharmacy/leakage",
  drawers: "/billing/office",
} as const;

/** ₹1,234.50 — the page's words carry money the way the bill does. */
const inr = (paise: number): string =>
  `₹${(Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString());

type Draft = Omit<PharmacyExceptionRow, "who"> & { whoId: string | null; whoName?: string | null };

/** The day's exceptions, every one, biggest first. No actor: the callers below are gated. */
export async function pharmacyExceptionsOn(db: Db, day: string): Promise<PharmacyExceptionDay> {
  if (!isIsoDate(day)) throw new PharmacyError("invalid_day", `"${day}" is not a date (YYYY-MM-DD)`);
  const { start, end } = istDayWindow(istInstantOf(day, "12:00"));
  const drafts: Draft[] = [
    ...(await refunds(db, day, start, end)),
    ...(await discounts(db, start, end)),
    ...(await adjustments(db, start, end)),
    ...(await writeOffs(db, start, end)),
    ...(await mrpRevisions(db, start, end)),
    ...(await leakage(db, day, start, end)),
    ...(await cash(db, start, end)),
    ...(await purchases(db, day)),
    ...(await supplierCredits(db, start, end)),
    ...(await downtime(db, start, end)),
  ];
  const names = await userNames(db, drafts.map((d) => d.whoId));
  const rows: PharmacyExceptionRow[] = drafts.map(({ whoId, whoName, ...r }) => ({
    ...r, who: whoName ?? (whoId === null ? null : names.get(whoId) ?? whoId),
  }));
  rows.sort((a, b) => b.paise - a.paise || (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
  const byKind = new Map<ExceptionKind, { kind: ExceptionKind; count: number; paise: number }>();
  for (const r of rows) {
    const t = byKind.get(r.kind) ?? { kind: r.kind, count: 0, paise: 0 };
    t.count += 1;
    t.paise += r.paise;
    byKind.set(r.kind, t);
  }
  const totals = [...byKind.values()].sort((a, b) => b.paise - a.paise || EXCEPTION_KINDS.indexOf(a.kind) - EXCEPTION_KINDS.indexOf(b.kind));
  return { day, rows, totals, count: rows.length, totalPaise: rows.reduce((s, r) => s + r.paise, 0) };
}

/** The office's Exceptions page: any IST day up to today, yesterday when none is named. The owner's right. */
export async function officeExceptions(db: Db, actor: Actor, input: { day?: string | null }, now: Date): Promise<PharmacyExceptionDay> {
  await requireReportPermission(db, actor, EXCEPTIONS_VIEW, "the pharmacy's exceptions");
  const today = istDateOf(now);
  const day = input.day == null || input.day === "" ? istDateOf(new Date(now.getTime() - DAY_MS)) : input.day;
  if (!isIsoDate(day)) throw new PharmacyError("invalid_day", `"${day}" is not a date (YYYY-MM-DD)`);
  if (day > today) throw new PharmacyError("invalid_day", `the exceptions are of a day that has happened; ${day} is after today (${today})`);
  return pharmacyExceptionsOn(db, day);
}

/** The words the bell row carries: counts and money only, never a patient (GC6). The phone says its own sentence. */
export function digestTitle(day: string, count: number, totalPaise: number): string {
  const when = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  return `Pharmacy: ${String(count)} ${count === 1 ? "exception" : "exceptions"} on ${when}, ₹${Math.round(totalPaise / 100).toLocaleString("en-IN")}`;
}

/**
 * 08:00 IST — YESTERDAY'S DIGEST, to the owner's bell and phones (ruling 0097). One bell row per holder of the
 * owner role, keyed by the day (`raiseNotice`: the same key raises nothing twice, so a re-run, a late first tick
 * or a second worker sends nothing again); the phone relay (`kernel/push`) turns it into "Pharmacy: 7 exceptions
 * yesterday, ₹3,240" from the two numbers alone. A day with no exceptions raises nothing.
 */
export async function sendPharmacyExceptionDigest(db: Db, now: Date): Promise<{ day: string; count: number; totalPaise: number; notified: number }> {
  const day = istDateOf(new Date(now.getTime() - DAY_MS));
  const digest = await pharmacyExceptionsOn(db, day);
  if (digest.count === 0) return { day, count: 0, totalPaise: 0, notified: 0 };
  const holders = await withTx(db, (tx) => usersHoldingRoleAtScope(tx, EXCEPTION_DIGEST_ROLE, "hospital"));
  const active = holders.length === 0 ? [] : await db.select({ id: users.id }).from(users).where(and(inArray(users.id, holders), eq(users.active, true)));
  const body = digest.totals.slice(0, 3).map((t) => `${t.kind.replaceAll("_", " ")} ${String(t.count)} · ₹${Math.round(t.paise / 100).toLocaleString("en-IN")}`).join(" · ");
  let notified = 0;
  for (const { id } of active) {
    const raised = await raiseNotice(db, {
      userId: id, kind: EXCEPTION_DIGEST_ALERT_KIND, title: digestTitle(day, digest.count, digest.totalPaise), body,
      refType: EXCEPTION_DIGEST_REF_TYPE, refId: day, sourceKey: `pharmacy_exceptions:${day}`, at: now,
      figures: { count: digest.count, paise: digest.totalPaise },
    });
    if (raised) notified += 1;
  }
  return { day, count: digest.count, totalPaise: digest.totalPaise, notified };
}

// ═══════════════════════════════════ the sources ═══════════════════════════════════

/** The pharmacy's bills among these invoices: which dispense or which walk-in / paper sale raised each. */
async function pharmacyBillsOf(db: Db, invoiceIds: readonly string[]): Promise<Map<string, { dispenseId: string | null; channel: string }>> {
  const out = new Map<string, { dispenseId: string | null; channel: string }>();
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return out;
  for (const d of await db.select({ id: pharmacyDispenses.id, invoiceId: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.invoiceId, ids))) {
    if (d.invoiceId !== null) out.set(d.invoiceId, { dispenseId: d.id, channel: "dispense" });
  }
  for (const s of await db.select({ invoiceId: pharmacyRetailSales.invoiceId, channel: pharmacyRetailSales.channel }).from(pharmacyRetailSales).where(inArray(pharmacyRetailSales.invoiceId, ids))) {
    out.set(s.invoiceId, { dispenseId: null, channel: s.channel });
  }
  return out;
}

async function refunds(db: Db, day: string, start: Date, end: Date): Promise<Draft[]> {
  const notes = await creditNotesBetween(db, day, day);
  const voids = await db.select({ docId: enteredInErrorMarks.docId, markedBy: enteredInErrorMarks.markedBy, markedAt: enteredInErrorMarks.markedAt, reason: enteredInErrorMarks.reason })
    .from(enteredInErrorMarks).where(and(eq(enteredInErrorMarks.docType, "invoice"), gte(enteredInErrorMarks.markedAt, start), lt(enteredInErrorMarks.markedAt, end)));
  const bills = await pharmacyBillsOf(db, [...notes.map((n) => n.invoiceId), ...voids.map((v) => v.docId)]);
  const heads = new Map((bills.size === 0 ? [] : await invoiceHeadsByIds(db, [...bills.keys()])).map((h) => [h.id, h] as const));
  const refundAsks = notes.length === 0 ? [] : await db.select({ id: approvals.id, subjectId: approvals.subjectId }).from(approvals)
    .where(and(eq(approvals.subjectType, "billing_refund"), inArray(approvals.subjectId, notes.map((n) => n.id))));
  const askOf = new Map(refundAsks.map((a) => [a.subjectId, a.id] as const));
  const where = (b: { dispenseId: string | null; channel: string }): string =>
    b.dispenseId !== null ? "desk" : b.channel === "downtime" ? "paper sale" : "walk-in";
  const out: Draft[] = [];
  for (const n of notes) {
    const bill = bills.get(n.invoiceId);
    if (bill === undefined) continue;
    const ask = askOf.get(n.id);
    out.push({
      id: `refund:${n.id}`, kind: "refund", paise: n.netPaise, whoId: n.issuedBy, at: n.issuedAt,
      what: `${n.creditNoteNo} on bill ${heads.get(n.invoiceId)?.invoiceNo ?? ""} (${where(bill)}) · ${n.reason}`,
      link: bill.dispenseId !== null ? LINK.dispense(bill.dispenseId) : ask !== undefined ? LINK.approval(ask) : LINK.reports,
    });
  }
  for (const v of voids) {
    const bill = bills.get(v.docId);
    if (bill === undefined) continue;
    out.push({
      id: `void:${v.docId}`, kind: "refund", paise: heads.get(v.docId)?.netPayablePaise ?? 0, whoId: v.markedBy, at: v.markedAt.toISOString(),
      what: `bill ${heads.get(v.docId)?.invoiceNo ?? ""} voided (${where(bill)}) · ${v.reason}`,
      link: bill.dispenseId !== null ? LINK.dispense(bill.dispenseId) : LINK.reports,
    });
  }
  return out;
}

async function discounts(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select().from(approvals).where(and(
    inArray(approvals.typeKey, [DISCOUNT_INCHARGE_APPROVAL_TYPE, DISCOUNT_OWNER_APPROVAL_TYPE]), eq(approvals.status, "granted"),
    gte(approvals.decidedAt, start), lt(approvals.decidedAt, end),
  ));
  const names = await userNames(db, rows.map((r) => r.requesterId));
  return rows.map((a) => ({
    id: `discount:${a.id}`, kind: "discount" as const, paise: a.amountPaise ?? 0, whoId: a.decidedBy, at: iso(a.decidedAt),
    what: `${a.requestNote ?? "discount"} · asked by ${names.get(a.requesterId) ?? a.requesterId}${a.typeKey === DISCOUNT_OWNER_APPROVAL_TYPE ? " · owner's tier" : ""}`,
    link: LINK.approval(a.id),
  }));
}

async function adjustments(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select({
    id: stockAdjustments.id, qtyDelta: stockAdjustments.qtyDelta, valuePaise: stockAdjustments.valuePaise, reason: stockAdjustments.reasonCode,
    postedAt: stockAdjustments.postedAt, postedBy: stockAdjustments.postedBy, approvedBy: approvals.decidedBy, itemName: items.name, storeCode: resources.code,
    batchId: stockAdjustments.batchId,
  }).from(stockAdjustments)
    .innerJoin(items, eq(items.id, stockAdjustments.itemId))
    .innerJoin(resources, eq(resources.id, stockAdjustments.resourceId))
    .leftJoin(approvals, eq(approvals.id, stockAdjustments.approvalId))
    .where(and(eq(stockAdjustments.status, "posted"), gte(stockAdjustments.postedAt, start), lt(stockAdjustments.postedAt, end)));
  const out: Draft[] = [];
  for (const r of rows) {
    const batchNo = (await getBatch(db, r.batchId))?.batchNo ?? "";
    out.push({
      id: `adjust:${r.id}`, kind: "stock_adjustment", paise: Math.abs(r.valuePaise), whoId: r.approvedBy ?? r.postedBy, at: iso(r.postedAt),
      what: `${r.itemName} ${batchNo} ${r.qtyDelta > 0 ? "+" : ""}${String(r.qtyDelta)} · ${r.reason.replaceAll("_", " ")} · ${r.storeCode}`,
      link: LINK.counts,
    });
  }
  return out;
}

async function writeOffs(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select({
    id: stockWriteOffs.id, no: stockWriteOffs.writeOffNo, reason: stockWriteOffs.reason, value: stockWriteOffs.totalValuePaise,
    postedAt: stockWriteOffs.postedAt, postedBy: stockWriteOffs.postedBy, approvedBy: approvals.decidedBy, storeCode: resources.code,
  }).from(stockWriteOffs)
    .innerJoin(resources, eq(resources.id, stockWriteOffs.storeResourceId))
    .leftJoin(approvals, eq(approvals.id, stockWriteOffs.approvalId))
    .where(and(eq(stockWriteOffs.status, "posted"), gte(stockWriteOffs.postedAt, start), lt(stockWriteOffs.postedAt, end)));
  return rows.map((r) => ({
    id: `writeoff:${r.id}`, kind: "write_off" as const, paise: r.value, whoId: r.approvedBy ?? r.postedBy, at: iso(r.postedAt),
    what: `${r.no} · ${r.reason} · ${r.storeCode}`, link: LINK.returns,
  }));
}

/** Events are windowed on `occurred_at`; `recorded_at` bounds the partition scan (an event is never recorded before it occurred). */
async function eventsOf(db: Db, module: string, name: string, start: Date, end: Date): Promise<{ actorId: string; occurredAt: Date; payload: unknown }[]> {
  return db.select({ actorId: events.actorId, occurredAt: events.occurredAt, payload: events.payload }).from(events).where(and(
    eq(events.module, module), eq(events.name, name), gte(events.occurredAt, start), lt(events.occurredAt, end), gte(events.recordedAt, start),
  ));
}

async function mrpRevisions(db: Db, start: Date, end: Date): Promise<Draft[]> {
  type Revised = { batchId: string; itemId: string; batchNo: string; grnLineId: string; approvalId: string; from: { mrpPaise: number | null; mrpUom: string | null }; to: { mrpPaise: number | null; mrpUom: string | null } };
  const evs = await eventsOf(db, "materials", "batch.mrp_revised", start, end);
  if (evs.length === 0) return [];
  const ps = evs.map((e) => e.payload as Revised);
  const names = await itemsByIds(db, [...new Set(ps.map((p) => p.itemId))]);
  const deciders = await db.select({ id: approvals.id, decidedBy: approvals.decidedBy }).from(approvals).where(inArray(approvals.id, ps.map((p) => p.approvalId)));
  const deciderOf = new Map(deciders.map((d) => [d.id, d.decidedBy] as const));
  return evs.map((e, i) => {
    const p = ps[i]!;
    const from = p.from.mrpPaise ?? 0;
    const to = p.to.mrpPaise ?? 0;
    const uom = p.to.mrpUom ?? p.from.mrpUom ?? "pack";
    return {
      id: `mrp:${p.grnLineId}:${p.batchId}`, kind: "mrp_revision" as const, paise: Math.abs(to - from), whoId: deciderOf.get(p.approvalId) ?? e.actorId,
      at: e.occurredAt.toISOString(),
      what: `${names.get(p.itemId)?.name ?? p.itemId} ${p.batchNo}: MRP ${inr(from)} → ${inr(to)} per ${uom}`,
      link: LINK.approval(p.approvalId),
    };
  });
}

async function leakage(db: Db, day: string, start: Date, end: Date): Promise<Draft[]> {
  const out: Draft[] = [];
  for (const code of LEAKAGE_STORE_CODES) {
    const store = await findStoreByCode(db, code);
    if (store === undefined) continue; // a hospital without this counter has nothing to leak from it
    const report = await pharmacyLeakage(db, day, code);
    for (const [i, m] of report.mismatches.entries()) {
      out.push({
        id: `leak:${code}:${String(i)}:${m.dispenseId ?? m.saleId ?? ""}:${m.batchNo}`, kind: "leakage", paise: Math.abs(m.unbilledPaise), whoId: null, at: null,
        what: `${m.dispenseNo ?? m.invoiceNo ?? ""} ${m.itemCode} ${m.batchNo}: ${String(m.unbilledUnits)} ${Math.abs(m.unbilledUnits) === 1 ? "unit" : "units"} ${m.unbilledUnits > 0 ? "issued, not billed" : "billed, not issued"} · ${code}`,
        link: LINK.leakage,
      });
    }
    // Consumption outside any sale, at the batch's cost: the leakage report's second list, with the batch to price it.
    for (const c of await consumptionRowsAt(db, store.id, start, end)) {
      if (c.refType === DISPENSE_REF_TYPE || c.refType === RETAIL_REF_TYPE) continue;
      const units = Math.abs(c.units);
      const cost = (await getBatch(db, c.batchId))?.landedCostPaise ?? 0;
      out.push({
        id: `used:${c.id}`, kind: "leakage", paise: units * cost, whoId: c.actorId, at: c.occurredAt.toISOString(),
        what: `${c.itemCode} ${c.batchNo}: ${String(units)} used outside a sale (${c.refType ?? "no reference"}${c.refId === null ? "" : ` ${c.refId}`}) · ${code}`,
        link: LINK.leakage,
      });
    }
  }
  return out;
}

/** A pharmacy cashier's blind count that missed the till: the LAST count of each drawer that day (a retracted count is superseded). */
async function cash(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const evs = (await eventsOf(db, "billing", "variance.flagged", start, end)).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (evs.length === 0) return [];
  const cashiers = new Set<string>();
  await withTx(db, async (tx) => {
    for (const role of PHARMACY_CASHIER_ROLES) for (const id of await usersHoldingRoleAtScope(tx, role, "hospital")) cashiers.add(id);
  });
  const last = new Map<string, { sessionId: string; cashierUserId: string; variancePaise: number; at: Date }>();
  for (const e of evs) {
    const p = e.payload as { sessionId: string; cashierUserId: string; variancePaise: number };
    if (cashiers.has(p.cashierUserId)) last.set(p.sessionId, { ...p, at: e.occurredAt });
  }
  return [...last.values()].filter((v) => v.variancePaise !== 0).map((v) => ({
    id: `cash:${v.sessionId}`, kind: "cash" as const, paise: Math.abs(v.variancePaise), whoId: v.cashierUserId, at: v.at.toISOString(),
    what: `Drawer counted ${inr(v.variancePaise)} ${v.variancePaise < 0 ? "short" : "over"}`,
    link: LINK.drawers,
  }));
}

async function purchases(db: Db, day: string): Promise<Draft[]> {
  const report = await purchaseAnalysisReport(db, day, day);
  if (report.rows.length === 0) return [];
  const created = new Map((await db.select({ id: grns.id, at: grns.createdAt }).from(grns).where(inArray(grns.id, [...new Set(report.rows.map((r) => r.grnId))])))
    .map((g) => [g.id, g.at] as const));
  return report.rows.map((r) => ({
    id: `price:${r.grnLineId}`, kind: "purchase_price" as const, paise: r.extraPaise, whoId: r.capturedBy, whoName: r.capturedByName,
    at: iso(created.get(r.grnId)),
    what: `${r.itemName} · ${r.grnNo} · ${r.vendorName}: ${(r.riseBps / 100).toFixed(1)}% above the ${r.refKind === "contract" ? "contract" : "last purchase"} · ${r.reasonCode.replaceAll("_", " ")}${r.reasonText === null ? "" : ` (${r.reasonText})`}`,
    link: LINK.reports,
  }));
}

async function supplierCredits(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select({
    id: supplierCreditNotes.id, no: supplierCreditNotes.vendorCreditNoteNo, difference: supplierCreditNotes.differencePaise,
    reason: supplierCreditNotes.differenceReason, recordedBy: supplierCreditNotes.recordedBy, recordedAt: supplierCreditNotes.recordedAt,
    vendor: vendors.legalName, debitNoteNo: supplierReturns.debitNoteNo,
  }).from(supplierCreditNotes)
    .innerJoin(vendors, eq(vendors.id, supplierCreditNotes.vendorId))
    .leftJoin(supplierReturns, eq(supplierReturns.id, supplierCreditNotes.returnId))
    .where(and(
      eq(supplierCreditNotes.status, "accepted"), gt(supplierCreditNotes.differencePaise, 0),
      gte(supplierCreditNotes.recordedAt, start), lt(supplierCreditNotes.recordedAt, end),
    ));
  return rows.map((r) => ({
    id: `credit:${r.id}`, kind: "supplier_credit" as const, paise: r.difference, whoId: r.recordedBy, at: r.recordedAt.toISOString(),
    what: `${r.vendor}: credit ${r.no} ${inr(r.difference)} below debit note ${r.debitNoteNo ?? ""}${r.reason === null ? "" : ` · ${r.reason}`}`,
    link: LINK.bills,
  }));
}

async function downtime(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select({
    id: pharmacyRetailSales.id, invoiceId: pharmacyRetailSales.invoiceId, soldAt: pharmacyRetailSales.soldAt, enteredBy: pharmacyRetailSales.enteredBy,
    soldBy: pharmacyRetailSales.soldBy, createdAt: pharmacyRetailSales.createdAt, storeId: pharmacyRetailSales.storeResourceId,
  }).from(pharmacyRetailSales).where(and(
    eq(pharmacyRetailSales.channel, "downtime"), gte(pharmacyRetailSales.createdAt, start), lt(pharmacyRetailSales.createdAt, end),
  ));
  if (rows.length === 0) return [];
  const heads = new Map((await invoiceHeadsByIds(db, rows.map((r) => r.invoiceId))).map((h) => [h.id, h] as const));
  const stores = new Map((await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, [...new Set(rows.map((r) => r.storeId))])))
    .map((s) => [s.id, s.code] as const));
  return rows.map((r) => ({
    id: `paper:${r.id}`, kind: "downtime" as const, paise: heads.get(r.invoiceId)?.netPayablePaise ?? 0, whoId: r.enteredBy ?? r.soldBy,
    at: r.createdAt.toISOString(),
    what: `bill ${heads.get(r.invoiceId)?.invoiceNo ?? ""} sold on paper on ${istDateOf(r.soldAt)}, entered later · ${stores.get(r.storeId) ?? ""}`,
    link: LINK.downtime,
  }));
}
