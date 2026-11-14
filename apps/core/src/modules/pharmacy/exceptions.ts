import { and, eq, gt, gte, inArray, lt } from "drizzle-orm";
import {
  approvals, cashierSessions, enteredInErrorMarks, events, grns, invoices, items, pharmacyDispenseLines, pharmacyDispenses,
  pharmacyRetailSaleLines, pharmacyRetailSales, resources, stockAdjustments, stockCounts, stockWriteOffs, supplierCreditNotes,
  supplierReturns, users, vendors,
} from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { usersHoldingRoleAtScope } from "../../kernel/workflow/roles";
import { creditNotesBetween, invoiceHeadsByIds } from "../billing";
import { consumptionRowsAt, findStoreByCode, getBatch, itemsByIds, purchaseAnalysisReport } from "../materials";
import { DISCOUNT_INCHARGE_APPROVAL_TYPE, DISCOUNT_OWNER_APPROVAL_TYPE, discountDraftOf } from "./discount";
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
 * the page is the owner's alone), the record's own reference, and a link to the screen that holds the record with
 * the rights that open it (`linkNeeds`): the page links a row only for a viewer who holds one, and shows the
 * reference as text otherwise — no right is widened for this page (ruling 0097). Every exception is listed; there
 * is no threshold. "Expiring stock not acted on" joins when #1063 is built.
 *
 * THE SAME MONEY ONCE. A refund at the billing desk with nothing returned is a credit note (a `refund` row) and,
 * to the leakage auditor, units that left the shelf unpaid. The leakage line that day's credit notes explain (same
 * dispense or sale, same item and batch) is listed with `sameMoneyAs` = the refund row, and is left out of the
 * count, the totals and the digest; only units no credit note explains are counted as leakage.
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
  /** The record's own reference (P-number, bill, GRN, write-off, count, slip): what the owner asks for by name. */
  ref: string;
  /** A route of the web app. */
  link: string;
  /** Any one of these rights opens `link`'s screen (they mirror the web's `pages.ts` and nav rows). */
  linkNeeds: string[];
  /** The id of the row that already carries this money (a leakage line a listed refund explains); null otherwise. Never counted twice. */
  sameMoneyAs: string | null;
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

type Go = { link: string; linkNeeds: string[] };
/** Each target and the rights that open it: the desk's and approvals' nav rows, the office pages' `perms` (`pages.ts`). */
const LINK = {
  dispense: (id: string): Go => ({ link: `/pharmacy/desk/${id}`, linkNeeds: ["pharmacy.dispense.read"] }),
  approval: (id: string): Go => ({ link: `/approvals?focus=${id}`, linkNeeds: ["approvals.requests.read"] }),
  reports: { link: "/pharmacy/office?view=reports&page=reports", linkNeeds: ["pharmacy.reports.read"] },
  /** The purchase analysis report is the margin right's (`officePurchaseAnalysis`). */
  purchases: { link: "/pharmacy/office?view=reports&page=reports", linkNeeds: ["pharmacy.reports.margin"] },
  counts: { link: "/pharmacy/office?view=stock&page=counts", linkNeeds: ["materials.counts.perform"] },
  returns: { link: "/pharmacy/office?view=returns&page=returns", linkNeeds: ["materials.returns.manage", "materials.writeoffs.manage", "materials.recall.manage"] },
  bills: { link: "/pharmacy/office?view=pay&page=bills", linkNeeds: ["materials.bills.manage"] },
  downtime: { link: "/pharmacy/office?view=stock&page=downtime", linkNeeds: ["pharmacy.downtime.enter"] },
  leakage: { link: "/pharmacy/leakage", linkNeeds: ["billing.reports.read"] },
  drawers: { link: "/billing/office", linkNeeds: ["billing.reports.read"] },
} satisfies Record<string, Go | ((id: string) => Go)>;

/** ₹1,234.50 — the page's words carry money the way the bill does. */
const inr = (paise: number): string =>
  `₹${(Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString());

type Draft = Omit<PharmacyExceptionRow, "who" | "sameMoneyAs"> & { whoId: string | null; whoName?: string | null; sameMoneyAs?: string | null };
/** Units a listed credit note took back, by sold line (dispense or sale · item code · batch no): what explains leakage. */
type Credited = Map<string, { rowId: string; qty: number }[]>;

/** The day's exceptions, every one, biggest first. No actor: the callers below are gated. */
export async function pharmacyExceptionsOn(db: Db, day: string): Promise<PharmacyExceptionDay> {
  if (!isIsoDate(day)) throw new PharmacyError("invalid_day", `"${day}" is not a date (YYYY-MM-DD)`);
  const { start, end } = istDayWindow(istInstantOf(day, "12:00"));
  const refund = await refunds(db, day, start, end);
  const drafts: Draft[] = [
    ...refund.drafts,
    ...(await discounts(db, start, end)),
    ...(await adjustments(db, start, end)),
    ...(await writeOffs(db, start, end)),
    ...(await mrpRevisions(db, start, end)),
    ...(await leakage(db, day, start, end, refund.credited)),
    ...(await cash(db, start, end)),
    ...(await purchases(db, day)),
    ...(await supplierCredits(db, start, end)),
    ...(await downtime(db, start, end)),
  ];
  const names = await userNames(db, drafts.map((d) => d.whoId));
  const rows: PharmacyExceptionRow[] = drafts.map(({ whoId, whoName, sameMoneyAs, ...r }) => ({
    ...r, who: whoName ?? (whoId === null ? null : names.get(whoId) ?? whoId), sameMoneyAs: sameMoneyAs ?? null,
  }));
  rows.sort((a, b) => b.paise - a.paise || (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
  const counted = rows.filter((r) => r.sameMoneyAs === null);
  const byKind = new Map<ExceptionKind, { kind: ExceptionKind; count: number; paise: number }>();
  for (const r of counted) {
    const t = byKind.get(r.kind) ?? { kind: r.kind, count: 0, paise: 0 };
    t.count += 1;
    t.paise += r.paise;
    byKind.set(r.kind, t);
  }
  const totals = [...byKind.values()].sort((a, b) => b.paise - a.paise || EXCEPTION_KINDS.indexOf(a.kind) - EXCEPTION_KINDS.indexOf(b.kind));
  return { day, rows, totals, count: counted.length, totalPaise: counted.reduce((s, r) => s + r.paise, 0) };
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
type Bill = { dispenseId: string | null; dispenseNo: string | null; saleId: string | null; channel: string };
async function pharmacyBillsOf(db: Db, invoiceIds: readonly string[]): Promise<Map<string, Bill>> {
  const out = new Map<string, Bill>();
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return out;
  for (const d of await db.select({ id: pharmacyDispenses.id, no: pharmacyDispenses.dispenseNo, invoiceId: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.invoiceId, ids))) {
    if (d.invoiceId !== null) out.set(d.invoiceId, { dispenseId: d.id, dispenseNo: d.no, saleId: null, channel: "dispense" });
  }
  for (const s of await db.select({ id: pharmacyRetailSales.id, invoiceId: pharmacyRetailSales.invoiceId, channel: pharmacyRetailSales.channel }).from(pharmacyRetailSales).where(inArray(pharmacyRetailSales.invoiceId, ids))) {
    out.set(s.invoiceId, { dispenseId: null, dispenseNo: null, saleId: s.id, channel: s.channel });
  }
  return out;
}

/** The sold line each of these invoice lines bills (a dispense's or a sale's), as the leakage auditor names it. */
async function soldLinesOf(db: Db, invoiceLineIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(invoiceLineIds)];
  if (ids.length === 0) return out;
  const lines = [
    ...(await db.select({ doc: pharmacyDispenseLines.dispenseId, itemId: pharmacyDispenseLines.itemId, batchId: pharmacyDispenseLines.batchId, invoiceLineId: pharmacyDispenseLines.invoiceLineId })
      .from(pharmacyDispenseLines).where(inArray(pharmacyDispenseLines.invoiceLineId, ids))),
    ...(await db.select({ doc: pharmacyRetailSaleLines.saleId, itemId: pharmacyRetailSaleLines.itemId, batchId: pharmacyRetailSaleLines.batchId, invoiceLineId: pharmacyRetailSaleLines.invoiceLineId })
      .from(pharmacyRetailSaleLines).where(inArray(pharmacyRetailSaleLines.invoiceLineId, ids))),
  ];
  const codes = await itemsByIds(db, [...new Set(lines.flatMap((l) => (l.itemId === null ? [] : [l.itemId])))]);
  for (const l of lines) {
    if (l.invoiceLineId === null || l.itemId === null || l.batchId === null) continue;
    const batchNo = (await getBatch(db, l.batchId))?.batchNo ?? l.batchId;
    out.set(l.invoiceLineId, soldKey(l.doc, codes.get(l.itemId)?.code ?? "", batchNo));
  }
  return out;
}
const soldKey = (doc: string, itemCode: string, batchNo: string): string => `${doc}|${itemCode}|${batchNo}`;

async function refunds(db: Db, day: string, start: Date, end: Date): Promise<{ drafts: Draft[]; credited: Credited }> {
  const notes = await creditNotesBetween(db, day, day);
  const voids = await db.select({ docId: enteredInErrorMarks.docId, markedBy: enteredInErrorMarks.markedBy, markedAt: enteredInErrorMarks.markedAt, reason: enteredInErrorMarks.reason })
    .from(enteredInErrorMarks).where(and(eq(enteredInErrorMarks.docType, "invoice"), gte(enteredInErrorMarks.markedAt, start), lt(enteredInErrorMarks.markedAt, end)));
  const bills = await pharmacyBillsOf(db, [...notes.map((n) => n.invoiceId), ...voids.map((v) => v.docId)]);
  const heads = new Map((bills.size === 0 ? [] : await invoiceHeadsByIds(db, [...bills.keys()])).map((h) => [h.id, h] as const));
  const refundAsks = notes.length === 0 ? [] : await db.select({ id: approvals.id, subjectId: approvals.subjectId }).from(approvals)
    .where(and(eq(approvals.subjectType, "billing_refund"), inArray(approvals.subjectId, notes.map((n) => n.id))));
  const askOf = new Map(refundAsks.map((a) => [a.subjectId, a.id] as const));
  const where = (b: Bill): string => b.dispenseId !== null ? "desk" : b.channel === "downtime" ? "paper sale" : "walk-in";
  const listed = notes.filter((n) => bills.has(n.invoiceId));
  const soldOf = await soldLinesOf(db, listed.flatMap((n) => n.lines.map((l) => l.invoiceLineId)));
  const credited: Credited = new Map();
  const out: Draft[] = [];
  for (const n of listed) {
    const bill = bills.get(n.invoiceId)!;
    const ask = askOf.get(n.id);
    const id = `refund:${n.id}`;
    const billNo = heads.get(n.invoiceId)?.invoiceNo ?? "";
    out.push({
      id, kind: "refund", paise: n.netPaise, whoId: n.issuedBy, at: n.issuedAt,
      what: `${n.creditNoteNo} on bill ${billNo} (${where(bill)}) · ${n.reason}`, ref: bill.dispenseNo ?? billNo,
      ...(bill.dispenseId !== null ? LINK.dispense(bill.dispenseId) : ask !== undefined ? LINK.approval(ask) : LINK.reports),
    });
    for (const l of n.lines) {
      const key = soldOf.get(l.invoiceLineId);
      if (key !== undefined) credited.set(key, [...(credited.get(key) ?? []), { rowId: id, qty: l.qty }]);
    }
  }
  for (const v of voids) {
    const bill = bills.get(v.docId);
    if (bill === undefined) continue;
    const billNo = heads.get(v.docId)?.invoiceNo ?? "";
    out.push({
      id: `void:${v.docId}`, kind: "refund", paise: heads.get(v.docId)?.netPayablePaise ?? 0, whoId: v.markedBy, at: v.markedAt.toISOString(),
      what: `bill ${billNo} voided (${where(bill)}) · ${v.reason}`, ref: bill.dispenseNo ?? billNo,
      ...(bill.dispenseId !== null ? LINK.dispense(bill.dispenseId) : LINK.reports),
    });
  }
  return { drafts: out, credited };
}

async function discounts(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select().from(approvals).where(and(
    inArray(approvals.typeKey, [DISCOUNT_INCHARGE_APPROVAL_TYPE, DISCOUNT_OWNER_APPROVAL_TYPE]), eq(approvals.status, "granted"),
    gte(approvals.decidedAt, start), lt(approvals.decidedAt, end),
  ));
  const names = await userNames(db, rows.map((r) => r.requesterId));
  const drafts = [...new Set(rows.map((r) => discountDraftOf(r.subjectId)))];
  const refOf = new Map<string, string>();
  if (drafts.length > 0) {
    for (const d of await db.select({ id: pharmacyDispenses.id, no: pharmacyDispenses.dispenseNo }).from(pharmacyDispenses).where(inArray(pharmacyDispenses.id, drafts))) if (d.no !== null) refOf.set(d.id, d.no);
    for (const s of await db.select({ id: pharmacyRetailSales.id, no: invoices.invoiceNo }).from(pharmacyRetailSales)
      .innerJoin(invoices, eq(invoices.id, pharmacyRetailSales.invoiceId)).where(inArray(pharmacyRetailSales.id, drafts))) refOf.set(s.id, s.no);
  }
  return rows.map((a) => ({
    id: `discount:${a.id}`, kind: "discount" as const, paise: a.amountPaise ?? 0, whoId: a.decidedBy, at: iso(a.decidedAt),
    what: `${a.requestNote ?? "discount"} · asked by ${names.get(a.requesterId) ?? a.requesterId}${a.typeKey === DISCOUNT_OWNER_APPROVAL_TYPE ? " · owner's tier" : ""}`,
    ref: refOf.get(discountDraftOf(a.subjectId)) ?? "not billed", ...LINK.approval(a.id),
  }));
}

async function adjustments(db: Db, start: Date, end: Date): Promise<Draft[]> {
  const rows = await db.select({
    id: stockAdjustments.id, qtyDelta: stockAdjustments.qtyDelta, valuePaise: stockAdjustments.valuePaise, reason: stockAdjustments.reasonCode,
    postedAt: stockAdjustments.postedAt, postedBy: stockAdjustments.postedBy, approvedBy: approvals.decidedBy, itemName: items.name, storeCode: resources.code,
    batchId: stockAdjustments.batchId, frozenAt: stockCounts.frozenAt,
  }).from(stockAdjustments)
    .innerJoin(stockCounts, eq(stockCounts.id, stockAdjustments.countId))
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
      ref: `count ${istDateOf(r.frozenAt)}`, ...LINK.counts,
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
    what: `${r.no} · ${r.reason} · ${r.storeCode}`, ref: r.no, ...LINK.returns,
  }));
}

/** Events are windowed on `occurred_at`; `recorded_at` bounds the partition scan (an event is never recorded before it occurred). */
async function eventsOf(db: Db, module: string, name: string, start: Date, end: Date): Promise<{ actorId: string; occurredAt: Date; payload: unknown }[]> {
  return db.select({ actorId: events.actorId, occurredAt: events.occurredAt, payload: events.payload }).from(events).where(and(
    eq(events.module, module), eq(events.name, name), gte(events.occurredAt, start), lt(events.occurredAt, end), gte(events.recordedAt, start),
  ));
}

async function mrpRevisions(db: Db, start: Date, end: Date): Promise<Draft[]> {
  type Revised = { batchId: string; itemId: string; batchNo: string; grnId: string; grnLineId: string; approvalId: string; from: { mrpPaise: number | null; mrpUom: string | null }; to: { mrpPaise: number | null; mrpUom: string | null } };
  const evs = await eventsOf(db, "materials", "batch.mrp_revised", start, end);
  if (evs.length === 0) return [];
  const ps = evs.map((e) => e.payload as Revised);
  const names = await itemsByIds(db, [...new Set(ps.map((p) => p.itemId))]);
  const deciders = await db.select({ id: approvals.id, decidedBy: approvals.decidedBy }).from(approvals).where(inArray(approvals.id, ps.map((p) => p.approvalId)));
  const deciderOf = new Map(deciders.map((d) => [d.id, d.decidedBy] as const));
  const grnNoOf = new Map((await db.select({ id: grns.id, no: grns.grnNo }).from(grns).where(inArray(grns.id, [...new Set(ps.map((p) => p.grnId))]))).map((g) => [g.id, g.no] as const));
  return evs.map((e, i) => {
    const p = ps[i]!;
    const from = p.from.mrpPaise ?? 0;
    const to = p.to.mrpPaise ?? 0;
    const uom = p.to.mrpUom ?? p.from.mrpUom ?? "pack";
    return {
      id: `mrp:${p.grnLineId}:${p.batchId}`, kind: "mrp_revision" as const, paise: Math.abs(to - from), whoId: deciderOf.get(p.approvalId) ?? e.actorId,
      at: e.occurredAt.toISOString(),
      what: `${names.get(p.itemId)?.name ?? p.itemId} ${p.batchNo}: MRP ${inr(from)} → ${inr(to)} per ${uom}`,
      ref: grnNoOf.get(p.grnId) ?? p.batchNo, ...LINK.approval(p.approvalId),
    };
  });
}

async function leakage(db: Db, day: string, start: Date, end: Date, credited: Credited): Promise<Draft[]> {
  const out: Draft[] = [];
  for (const code of LEAKAGE_STORE_CODES) {
    const store = await findStoreByCode(db, code);
    if (store === undefined) continue; // a hospital without this counter has nothing to leak from it
    const report = await pharmacyLeakage(db, day, code);
    for (const [i, m] of report.mismatches.entries()) {
      const id = `leak:${code}:${String(i)}:${m.dispenseId ?? m.saleId ?? ""}:${m.batchNo}`;
      const ref = m.dispenseNo ?? m.invoiceNo ?? "";
      const row = (units: number, sameMoneyAs: string | null, suffix: string): Draft => ({
        id: `${id}${suffix}`, kind: "leakage", paise: Math.abs(units) * (m.unbilledUnits === 0 ? 0 : Math.abs(m.unbilledPaise / m.unbilledUnits)), whoId: null, at: null,
        what: `${ref} ${m.itemCode} ${m.batchNo}: ${String(units)} ${Math.abs(units) === 1 ? "unit" : "units"} ${units > 0 ? "issued, not billed" : "billed, not issued"} · ${code}`,
        ref, sameMoneyAs, ...LINK.leakage,
      });
      // Units that day's listed credit notes took back on this very sold line are that refund's money: point at it.
      const takers = m.unbilledUnits > 0 ? (credited.get(soldKey(m.dispenseId ?? m.saleId ?? "", m.itemCode, m.batchNo)) ?? []) : [];
      let left = m.unbilledUnits;
      for (const t of takers) {
        const took = Math.min(left, t.qty);
        if (took <= 0) continue;
        out.push(row(took, t.rowId, `:${t.rowId}`));
        t.qty -= took;
        left -= took;
      }
      if (left !== 0) out.push(row(left, null, ""));
    }
    // Consumption outside any sale, at the batch's cost: the leakage report's second list, with the batch to price it.
    for (const c of await consumptionRowsAt(db, store.id, start, end)) {
      if (c.refType === DISPENSE_REF_TYPE || c.refType === RETAIL_REF_TYPE) continue;
      const units = Math.abs(c.units);
      const cost = (await getBatch(db, c.batchId))?.landedCostPaise ?? 0;
      out.push({
        id: `used:${c.id}`, kind: "leakage", paise: units * cost, whoId: c.actorId, at: c.occurredAt.toISOString(),
        what: `${c.itemCode} ${c.batchNo}: ${String(units)} used outside a sale (${c.refType ?? "no reference"}${c.refId === null ? "" : ` ${c.refId}`}) · ${code}`,
        ref: `${c.refType ?? "no reference"}${c.refId === null ? "" : ` ${c.refId}`}`, ...LINK.leakage,
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
  const missed = [...last.values()].filter((v) => v.variancePaise !== 0);
  const opened = new Map((missed.length === 0 ? [] : await db.select({ id: cashierSessions.id, at: cashierSessions.openedAt }).from(cashierSessions)
    .where(inArray(cashierSessions.id, missed.map((v) => v.sessionId)))).map((x) => [x.id, x.at] as const));
  return missed.map((v) => ({
    id: `cash:${v.sessionId}`, kind: "cash" as const, paise: Math.abs(v.variancePaise), whoId: v.cashierUserId, at: v.at.toISOString(),
    what: `Drawer counted ${inr(v.variancePaise)} ${v.variancePaise < 0 ? "short" : "over"}`,
    ref: `drawer opened ${istDateOf(opened.get(v.sessionId) ?? v.at)}`, ...LINK.drawers,
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
    ref: r.grnNo, ...LINK.purchases,
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
    ref: r.debitNoteNo ?? r.no, ...LINK.bills,
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
    ref: heads.get(r.invoiceId)?.invoiceNo ?? "", ...LINK.downtime,
  }));
}
