import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { argsHash } from "../../kernel/copilot/act";
import { withTx } from "../../kernel/db/client";
import {
  copilotActs, events, grnLines, grns, itemCategories, items, opdEncounters, orgDepartments, purchaseOrderLines, purchaseOrders, roleAssignments, storesAuditFlagReviews,
  storesAuditFlags, storesAwards, storesBuyGroupMoves, storesPurchaseRequests, storesServiceEntries, supplierBillLines, supplierBills, supplierPaymentRunLines,
  supplierPayments,
} from "../../kernel/db/schema";
import { PO_HEAD_APPROVAL_LIMIT_PAISE, contractRatesFor } from "../materials";
import { recordAct } from "./access";
import { agentHalted, nightOf } from "./buyer-agent";
import { clean, ex, holdsRole, peopleNamed, usersWithRole } from "./buying-common";
import { StoresError } from "./errors";
import { STORES_ACT_EVENT } from "./events";
import { quarterBounds, quarterOf } from "./scorecard";
import { listShelves } from "./shelves";
import type { Exec } from "./buying-common";
import type { Actor, WireAuditFlag, WireAuditFlagKind } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S6c (#1116, decision 11, "Audit by construction"; D17, D18) — THE AUDITOR AGENT (T1): IT FLAGS, A PERSON DECIDES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Nightly (22:00 IST, on the minute sweep after the buyer's night; S3's precedent, no new job name) it reads rows and
 * writes `stores_audit_flags`, nothing else. Five rules, each over rows, so it works with the model off (no model is
 * used here at all):
 *   use_out_of_pattern  a department's use in the last 7 days (per OPD visit when the department has visits every week,
 *                       else at cost) above 1.5 × its own median of the 12 weeks before (at least 6 weeks with use);
 *                       DECIDED: per bed-day once IPD is on production (S3's `perBedDayPaise` is null until then).
 *   price_drift         a GRN line's cost per base unit above the supplier's live contract rate + 2 %.
 *   split_po            the same supplier and top category, 2 or more Stores POs within 7 days, each under the materials
 *                       head's PO tier (₹50,000), together above it.
 *   both_ends           the same user at both ends of one chain: PR raise and GRN QC, PO approval and bill booking, bill
 *                       booking and payment recording (booking = entering or accepting the bill).
 *   more_than_book      "More than book" 3 or more times in a calendar quarter at one shelf.
 * Each flag cites its rows; its text names departments and documents only — never a person (D17): the person is seen
 * only by opening a cited document under that document's own grant. A finding is raised once (`key`).
 *
 * NEVER: a hold, a release, a payment or a supplier message. Placing a hold is T3, which needs 8 weeks with ≥ 90 % upheld
 * and the owner's yes; S6 ships T1 only.
 *
 * The copilot's halt (`draft` or `global`) stops the night (nothing written; it runs the minute the halt is lifted). The
 * cap: at most 50 new flags a night (the rest wait for the next night). The ledger: each review is a `copilot_acts` row
 * (the reviewer, the flag as the proposal, `confirm_id` = `af_<flag>`, so a flag is reviewed once) plus one act.
 *
 * Review (D18): the materials head or the stores auditor (role), never the flagged department's HOD; Upheld needs one line
 * on what was done and goes on the owner's monthly list; Dismissed needs a reason. A flag open for 7 days is a Now card.
 * Edge case 8: flags go only to the materials head and the stores auditor (and the owner's monthly list), never to a board.
 */
export const AUDITOR_AGENT: Actor = { type: "agent", id: "stores-auditor-agent" };
export const AUDITOR_TOOL = "stores.auditor_flag";
export const AUDIT_FLAGS_PER_NIGHT = 50;
export const AUDIT_FLAG_STALE_DAYS = 7;
export const AUDIT_FLAG_WORDS = { toReview: ["Flags to review", "जाँच के संकेत"] } as const;
const REVIEWERS = ["materials_head", "stores_auditor"] as const;
const LOOKBACK_DAYS = 35;
const SPLIT_WINDOW_DAYS = 7;
const PRICE_DRIFT_BPS = 200;
const USE_MULTIPLE = 1.5;
const USE_WEEKS = 12;
const USE_MIN_WEEKS = 6;
const MORE_THAN_BOOK_TIMES = 3;
const IST = "Asia/Kolkata";
const DAY_MS = 86_400_000;

type FlagRow = typeof storesAuditFlags.$inferSelect;
type ReviewRow = typeof storesAuditFlagReviews.$inferSelect;
type Cite = { type: string; id: string; no: string };
type Candidate = { kind: WireAuditFlagKind; key: string; departmentIds: string[]; text: string; cites: Cite[] };

const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const dayMinus = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
const localDay = (col: unknown) => sql`(${col} at time zone ${IST})::date`;
/** A Stores item line: an item with a track mode that is not a drug (`items.ts` `storesItemWhere`). */
const storesItem = sql`${items.trackMode} is not null and ${items.class} <> 'drug'`;

async function departmentNames(db: Exec, ids: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const want = [...new Set(ids)];
  if (want.length === 0) return new Map();
  return new Map((await ex(db).select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, want))).map((d) => [d.id, d] as const));
}

/** A bill with a Stores item line or a service line (the auditor reads Stores' money chains, not pharmacy's). */
async function storesBillIds(db: Exec, billIds: readonly string[]): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const rows = await ex(db).selectDistinct({ id: supplierBillLines.billId }).from(supplierBillLines).innerJoin(items, eq(items.id, supplierBillLines.itemId))
    .where(and(inArray(supplierBillLines.billId, [...billIds]), sql`(${supplierBillLines.sesId} is not null or (${storesItem}))`));
  return new Set(rows.map((r) => r.id));
}

/** The departments a bill is charged to that a row names: its service entries' departments. */
async function billDepartments(db: Exec, billIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (billIds.length === 0) return out;
  const rows = await ex(db).selectDistinct({ bill: supplierBillLines.billId, dept: storesServiceEntries.departmentId }).from(supplierBillLines)
    .innerJoin(storesServiceEntries, eq(storesServiceEntries.id, supplierBillLines.sesId)).where(inArray(supplierBillLines.billId, [...billIds]));
  for (const r of rows) out.set(r.bill, [...(out.get(r.bill) ?? []), r.dept].sort());
  return out;
}

// ═══════════════════════════════ the five rules ═══════════════════════════════

async function splitPos(db: Exec, now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const top = sql<string | null>`coalesce(${itemCategories.parentId}, ${itemCategories.id})`;
  const when = sql<Date>`coalesce(${purchaseOrders.submittedAt}, ${purchaseOrders.createdAt})`;
  const rows = await ex(db).selectDistinct({
    id: purchaseOrders.id, no: purchaseOrders.poNo, vendorId: purchaseOrders.vendorId, total: purchaseOrders.totalPaise, at: when, cat: top,
  }).from(purchaseOrders).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .innerJoin(items, eq(items.id, purchaseOrderLines.itemId)).leftJoin(itemCategories, eq(itemCategories.id, items.categoryId))
    .where(and(notInArray(purchaseOrders.status, ["draft", "cancelled"]), sql`${storesItem}`, sql`${when} >= ${since.toISOString()}::timestamptz`,
      lt(purchaseOrders.totalPaise, PO_HEAD_APPROVAL_LIMIT_PAISE)));
  const catIds = [...new Set(rows.map((r) => r.cat).filter((x): x is string => x !== null))];
  const catNames = new Map(catIds.length === 0 ? [] : (await ex(db).select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories)
    .where(inArray(itemCategories.id, catIds))).map((c) => [c.id, c.name] as const));
  const buckets = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.vendorId}|${r.cat ?? "-"}`;
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const out: Candidate[] = [];
  for (const list of buckets.values()) {
    const sorted = list.map((r) => ({ ...r, at: new Date(r.at) })).sort((a, b) => a.at.getTime() - b.at.getTime() || a.no.localeCompare(b.no));
    const used = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(sorted[i]!.id)) continue;
      const win = sorted.filter((r, j) => j >= i && !used.has(r.id) && r.at.getTime() - sorted[i]!.at.getTime() <= SPLIT_WINDOW_DAYS * DAY_MS);
      const sum = win.reduce((s, r) => s + r.total, 0);
      if (win.length < 2 || sum <= PO_HEAD_APPROVAL_LIMIT_PAISE) continue;
      for (const r of win) used.add(r.id);
      const cat = sorted[i]!.cat === null ? "—" : (catNames.get(sorted[i]!.cat!) ?? "—");
      out.push({
        kind: "split_po", key: `split_po:${win.map((r) => r.id).sort().join(",")}`, departmentIds: [],
        text: `Split purchase: ${win.map((r) => r.no).join(", ")} · one supplier, ${cat} · ${String(win.length)} orders within ${String(SPLIT_WINDOW_DAYS)} days, each under ${rupees(PO_HEAD_APPROVAL_LIMIT_PAISE)}, together ${rupees(sum)}`,
        cites: win.map((r) => ({ type: "po", id: r.id, no: r.no })),
      });
    }
  }
  return out;
}

async function bothEnds(db: Exec, now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const out: Candidate[] = [];

  // Bill booking and payment recording.
  const paid = await ex(db).select({
    payId: supplierPayments.id, payNo: supplierPayments.paymentNo, by: supplierPayments.recordedBy,
    billId: supplierBills.id, billNo: supplierBills.billNo, created: supplierBills.createdBy, accepted: supplierBills.acceptedBy,
  }).from(supplierPayments).innerJoin(supplierPaymentRunLines, eq(supplierPaymentRunLines.paymentId, supplierPayments.id))
    .innerJoin(supplierBills, eq(supplierBills.id, supplierPaymentRunLines.billId))
    .where(and(gte(supplierPayments.recordedAt, since), sql`(${supplierBills.createdBy} = ${supplierPayments.recordedBy} or ${supplierBills.acceptedBy} = ${supplierPayments.recordedBy})`));
  const payStores = await storesBillIds(db, paid.map((p) => p.billId));
  const payDepts = await billDepartments(db, paid.map((p) => p.billId));
  for (const p of paid.filter((x) => payStores.has(x.billId))) {
    out.push({
      kind: "both_ends", key: `both_ends:bill_payment:${p.billId}:${p.payId}`, departmentIds: payDepts.get(p.billId) ?? [],
      text: `One person at both ends: bill ${p.billNo} booked and its payment ${p.payNo} recorded by the same user`,
      cites: [{ type: "bill", id: p.billId, no: p.billNo }, { type: "payment", id: p.payId, no: p.payNo }],
    });
  }

  // PO approval and bill booking.
  const bills = await ex(db).select({ id: supplierBills.id, no: supplierBills.billNo, po: supplierBills.purchaseOrderId, created: supplierBills.createdBy, accepted: supplierBills.acceptedBy })
    .from(supplierBills).where(and(isNotNull(supplierBills.acceptedAt), gte(supplierBills.acceptedAt, since), ne(supplierBills.status, "cancelled")));
  const billStores = await storesBillIds(db, bills.map((b) => b.id));
  const storesBills = bills.filter((b) => billStores.has(b.id));
  if (storesBills.length > 0) {
    const viaGrn = await ex(db).selectDistinct({ bill: supplierBillLines.billId, po: grns.purchaseOrderId }).from(supplierBillLines)
      .innerJoin(grns, eq(grns.id, supplierBillLines.grnId)).where(inArray(supplierBillLines.billId, storesBills.map((b) => b.id)));
    const viaSes = await ex(db).selectDistinct({ bill: supplierBillLines.billId, po: storesServiceEntries.purchaseOrderId }).from(supplierBillLines)
      .innerJoin(storesServiceEntries, eq(storesServiceEntries.id, supplierBillLines.sesId)).where(inArray(supplierBillLines.billId, storesBills.map((b) => b.id)));
    const poIds = [...new Set([...storesBills.map((b) => b.po), ...viaGrn.map((r) => r.po), ...viaSes.map((r) => r.po)].filter((x): x is string => x !== null))];
    const pos = new Map(poIds.length === 0 ? [] : (await ex(db).select({ id: purchaseOrders.id, no: purchaseOrders.poNo, by: purchaseOrders.approvedBy }).from(purchaseOrders)
      .where(inArray(purchaseOrders.id, poIds))).map((p) => [p.id, p] as const));
    const depts = await billDepartments(db, storesBills.map((b) => b.id));
    for (const b of storesBills) {
      const mine = new Set([b.po, ...viaGrn.filter((r) => r.bill === b.id).map((r) => r.po), ...viaSes.filter((r) => r.bill === b.id).map((r) => r.po)].filter((x): x is string => x !== null));
      for (const poId of [...mine].sort()) {
        const po = pos.get(poId);
        if (po?.by == null || (po.by !== b.created && po.by !== b.accepted)) continue;
        out.push({
          kind: "both_ends", key: `both_ends:po_bill:${poId}:${b.id}`, departmentIds: depts.get(b.id) ?? [],
          text: `One person at both ends: ${po.no} approved and its bill ${b.no} booked by the same user`,
          cites: [{ type: "po", id: poId, no: po.no }, { type: "bill", id: b.id, no: b.no }],
        });
      }
    }
  }

  // PR raise and GRN QC (a Stores PO made from an award: award → group → the requests in it).
  const qc = await ex(db).select({ grnId: grns.id, grnNo: grns.grnNo, qcBy: grns.qcBy, prId: storesPurchaseRequests.id, prNo: storesPurchaseRequests.prNo, dept: storesPurchaseRequests.departmentId })
    .from(grns).innerJoin(purchaseOrders, eq(purchaseOrders.id, grns.purchaseOrderId)).innerJoin(storesAwards, eq(storesAwards.id, purchaseOrders.awardId))
    .innerJoin(storesBuyGroupMoves, eq(storesBuyGroupMoves.groupId, storesAwards.groupId)).innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesBuyGroupMoves.prId))
    .where(and(isNotNull(grns.postedAt), gte(grns.postedAt, since), isNotNull(grns.qcBy), sql`${storesPurchaseRequests.raisedBy} = ${grns.qcBy}`));
  const seen = new Set<string>();
  for (const r of qc) {
    const key = `both_ends:pr_grn:${r.prId}:${r.grnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "both_ends", key, departmentIds: r.dept === null ? [] : [r.dept],
      text: `One person at both ends: ${r.prNo} raised and its goods ${r.grnNo} passed at QC by the same user`,
      cites: [{ type: "pr", id: r.prId, no: r.prNo }, { type: "grn", id: r.grnId, no: r.grnNo }],
    });
  }
  return out;
}

async function priceDrift(db: Exec, now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const rows = await ex(db).select({ lineId: grnLines.id, grnId: grns.id, grnNo: grns.grnNo, vendorId: grns.vendorId, itemId: grnLines.itemId, itemName: items.name, cost: grnLines.unitCostPaise })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).innerJoin(items, eq(items.id, grnLines.itemId))
    .where(and(isNotNull(grns.postedAt), gte(grns.postedAt, since), sql`${storesItem}`));
  if (rows.length === 0) return [];
  const rates = await contractRatesFor(db, [...new Set(rows.map((r) => r.itemId))], now);
  const out: Candidate[] = [];
  for (const r of rows) {
    const c = (rates.get(r.itemId) ?? []).find((x) => x.vendorId === r.vendorId);
    if (c === undefined || c.multiplier <= 0) continue;
    const perBase = c.ratePaise / c.multiplier;
    if (r.cost * 10_000 <= perBase * (10_000 + PRICE_DRIFT_BPS)) continue;
    const pct = Math.round(((r.cost - perBase) / perBase) * 1000) / 10;
    out.push({
      kind: "price_drift", key: `price_drift:${r.lineId}`, departmentIds: [],
      text: `Price above contract: ${r.grnNo} · ${r.itemName} at ${rupees(r.cost)} against ${rupees(perBase)} a unit (+${String(pct)} %)`,
      cites: [{ type: "grn", id: r.grnId, no: r.grnNo }, { type: "contract", id: c.rateId, no: "" }],
    });
  }
  return out;
}

async function moreThanBook(db: Exec, now: Date): Promise<Candidate[]> {
  const quarter = quarterOf(now);
  const { from, to } = quarterBounds(quarter);
  const rows = await ex(db).select({ eventId: events.eventId, payload: events.payload }).from(events)
    .where(and(
      eq(events.name, STORES_ACT_EVENT), gte(events.recordedAt, new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS)),
      sql`${events.payload}->>'act' = 'check'`, sql`${events.payload}->>'reason' = 'more_than_book'`,
      sql`${localDay(events.occurredAt)} >= ${from}::date`, sql`${localDay(events.occurredAt)} < ${to}::date`,
    )).orderBy(asc(events.seq));
  const byShelf = new Map<string, string[]>();
  for (const r of rows) {
    const p = r.payload as { storeId: string; refId: string };
    byShelf.set(p.storeId, [...(byShelf.get(p.storeId) ?? []), p.refId]);
  }
  const shelves = new Map((await listShelves(db)).map((s) => [s.id, s] as const));
  const out: Candidate[] = [];
  for (const [shelfId, checks] of byShelf) {
    if (checks.length < MORE_THAN_BOOK_TIMES) continue;
    const s = shelves.get(shelfId);
    out.push({
      kind: "more_than_book", key: `more_than_book:${shelfId}:${quarter}`, departmentIds: s?.departmentId == null ? [] : [s.departmentId],
      text: `"More than book" ${String(checks.length)} times in ${quarter} at ${s?.code ?? shelfId}${s?.departmentName == null ? "" : ` (${s.departmentName})`}`,
      cites: [{ type: "shelf", id: shelfId, no: s?.code ?? "" }, ...checks.map((c) => ({ type: "check", id: c, no: "" }))],
    });
  }
  return out;
}

async function useOutOfPattern(db: Exec, now: Date): Promise<Candidate[]> {
  const today = istDayString(now);
  const first = dayMinus(today, 7 * (USE_WEEKS + 1));
  const day = localDay(sql.raw("sl.occurred_at"));
  const week = sql<number>`floor((${today}::date - ${day}) / 7)::int`;
  const rows = await ex(db).execute(sql`
    select sl.cost_center as code, ${week} as week,
      coalesce(sum(case when r.attributes->>'kind' = 'shelf' then 1 else -1 end * sl.qty_delta::bigint * b.landed_cost_paise), 0)::bigint as paise
    from stock_ledger sl join stock_batches b on b.id = sl.batch_id join resources r on r.id = sl.resource_id
    where sl.cost_center is not null and sl.reason = 'receive' and sl.qty_delta > 0
      and ${day} >= ${first}::date and ${day} < ${today}::date
      and not exists (select 1 from stores_asset_units u where u.batch_id = sl.batch_id)
    group by 1, 2`);
  const byCode = new Map<string, number[]>();
  for (const r of rows.rows as { code: string; week: number; paise: string }[]) {
    const w = byCode.get(r.code) ?? Array.from({ length: USE_WEEKS + 1 }, () => 0);
    if (r.week >= 0 && r.week <= USE_WEEKS) w[r.week] = Number(r.paise);
    byCode.set(r.code, w);
  }
  if (byCode.size === 0) return [];
  const depts = await ex(db).select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name, opd: orgDepartments.opdDepartmentId }).from(orgDepartments)
    .where(inArray(orgDepartments.code, [...byCode.keys()]));
  const opdIds = depts.map((d) => d.opd).filter((x): x is string => x !== null);
  const visits = new Map<string, number[]>();
  if (opdIds.length > 0) {
    const v = await ex(db).select({ dept: opdEncounters.departmentId, week: sql<number>`floor((${today}::date - ${opdEncounters.serviceDate}::date) / 7)::int`, n: sql<number>`count(*)::int` })
      .from(opdEncounters).where(and(inArray(opdEncounters.departmentId, opdIds), ne(opdEncounters.status, "abandoned"), gte(opdEncounters.serviceDate, first), lt(opdEncounters.serviceDate, today)))
      .groupBy(opdEncounters.departmentId, sql`2`);
    for (const r of v) {
      if (r.dept === null) continue;
      const w = visits.get(r.dept) ?? Array.from({ length: USE_WEEKS + 1 }, () => 0);
      if (r.week >= 0 && r.week <= USE_WEEKS) w[r.week] = r.n;
      visits.set(r.dept, w);
    }
  }
  const out: Candidate[] = [];
  const weekStart = dayMinus(today, 7);
  for (const d of depts) {
    const w = byCode.get(d.code)!;
    const vis = d.opd === null ? undefined : visits.get(d.opd);
    const perVisit = vis !== undefined && vis.every((n) => n > 0);
    const value = w.map((p, i) => (perVisit ? p / vis[i]! : p));
    const past = value.slice(1).sort((a, b) => a - b);
    if (past.filter((x) => x > 0).length < USE_MIN_WEEKS) continue;
    const median = (past[(past.length - 1) >> 1]! + past[past.length >> 1]!) / 2;
    if (median <= 0 || value[0]! <= USE_MULTIPLE * median) continue;
    const times = Math.round((value[0]! / median) * 10) / 10;
    out.push({
      kind: "use_out_of_pattern", key: `use_out_of_pattern:${d.id}:${weekStart}`, departmentIds: [d.id],
      text: `Use above pattern: ${d.name} ${perVisit ? `${rupees(value[0]!)} a visit` : rupees(value[0]!)} in the 7 days to ${today}, ${String(times)} × its ${String(USE_WEEKS)}-week median`,
      cites: [{ type: "department", id: d.id, no: d.code }],
    });
  }
  return out;
}

// ═══════════════════════════════ the night ═══════════════════════════════

export type AuditorNightRun = { halted: boolean; flags: string[]; capped: number; notices: number };

/** One night's flags: every rule, new findings only, at most `AUDIT_FLAGS_PER_NIGHT`. Writes flags and one act; nothing else. */
export async function runAuditorNight(db: Db, now: Date = new Date()): Promise<AuditorNightRun> {
  if (await agentHalted(db, now)) return { halted: true, flags: [], capped: 0, notices: 0 };
  const night = nightOf(now) ?? istDayString(now);
  const found = [
    ...(await bothEnds(db, now)), ...(await splitPos(db, now)), ...(await priceDrift(db, now)), ...(await moreThanBook(db, now)), ...(await useOutOfPattern(db, now)),
  ];
  const known = new Set(found.length === 0 ? [] : (await db.select({ key: storesAuditFlags.key }).from(storesAuditFlags)
    .where(inArray(storesAuditFlags.key, found.map((f) => f.key)))).map((r) => r.key));
  const fresh = [...new Map(found.filter((f) => !known.has(f.key)).map((f) => [f.key, f] as const)).values()];
  const take = fresh.slice(0, AUDIT_FLAGS_PER_NIGHT);
  const ids: string[] = [];
  let notices = 0;
  await withTx(db, async (tx) => {
    for (const f of take) {
      const id = newId();
      const ins = await tx.insert(storesAuditFlags).values({
        id, kind: f.kind, key: f.key, departmentIds: f.departmentIds, text: f.text.slice(0, 500), cites: f.cites, night, raisedBy: AUDITOR_AGENT.id, raisedAt: now,
      }).onConflictDoNothing({ target: storesAuditFlags.key }).returning({ id: storesAuditFlags.id });
      if (ins.length > 0) ids.push(id);
    }
    await recordAct(tx, AUDITOR_AGENT, now, { act: "auditor_night", after: { night, flags: ids, capped: fresh.length - take.length } });
    if (ids.length > 0) {
      const people = [...new Set((await Promise.all(REVIEWERS.map((r) => usersWithRole(tx, r)))).flat())].sort();
      for (const userId of people) {
        const ok = await raiseNotice(tx as unknown as Db, {
          userId, kind: "stores.audit", title: AUDIT_FLAG_WORDS.toReview[0], body: `${AUDIT_FLAG_WORDS.toReview[1]} · ${String(ids.length)}`,
          refType: "stores_audit_flags", refId: night, sourceKey: `stores-audit-flags:${night}:${userId}`, at: now,
        });
        if (ok) notices += 1;
      }
    }
  });
  return { halted: false, flags: ids, capped: fresh.length - take.length, notices };
}

/**
 * On the minute sweep (`runStoresChaser`), after the buyer's night: the night of D runs once, at the first minute from
 * 22:00 on D to 07:00 on D+1 that finds no `auditor_night` act for D. A halted night writes no act, so it runs when the
 * halt is lifted. Under an advisory lock, so two workers cannot both run it.
 */
export async function runAuditorNightIfDue(db: Db, now: Date = new Date()): Promise<AuditorNightRun | null> {
  const night = nightOf(now);
  if (night === null) return null;
  const since = new Date(now.getTime() - 36 * 3_600_000);
  const ran = async (exec: Exec): Promise<boolean> => (await ex(exec).execute(sql`
    select 1 from events where name = 'stores.act_recorded' and recorded_at >= ${since.toISOString()}::timestamptz
      and payload->>'act' = 'auditor_night' and payload->'after'->>'night' = ${night} limit 1`)).rows.length > 0;
  if (await ran(db)) return null;
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('stores-auditor-night'))`);
    if (await ran(tx)) return null;
    return runAuditorNight(tx as unknown as Db, now);
  });
}

// ═══════════════════════════════ reads ═══════════════════════════════

async function isReviewer(db: Exec, actor: Actor): Promise<boolean> {
  for (const r of REVIEWERS) if (await holdsRole(db, actor, r)) return true;
  return false;
}

/** The flags are read by the materials head, the stores auditor and the owner, nobody else (edge case 8). */
async function requireFlagReader(db: Exec, actor: Actor): Promise<void> {
  if ((await isReviewer(db, actor)) || (await holdsRole(db, actor, "owner"))) return;
  throw new StoresError("not_permitted", "the auditor's flags are the materials head's, the stores auditor's and the owner's");
}

/** Is this person the HOD of a department the flag names? */
async function hodOf(db: Exec, actor: Actor, departmentIds: readonly string[]): Promise<boolean> {
  if (actor.type !== "user" || departmentIds.length === 0) return false;
  const [r] = await ex(db).select({ u: roleAssignments.userId }).from(roleAssignments).where(and(
    eq(roleAssignments.userId, actor.id), eq(roleAssignments.roleKey, "department_head"), eq(roleAssignments.scopeType, "department"),
    inArray(roleAssignments.scopeId, [...departmentIds]),
  )).limit(1);
  return r !== undefined;
}

async function flagViews(db: Exec, actor: Actor, rows: readonly FlagRow[], now: Date): Promise<WireAuditFlag[]> {
  if (rows.length === 0) return [];
  const reviews = await ex(db).select().from(storesAuditFlagReviews).where(inArray(storesAuditFlagReviews.flagId, rows.map((r) => r.id)));
  const person = await peopleNamed(db, reviews.map((r) => r.by));
  const depts = await departmentNames(db, rows.flatMap((r) => r.departmentIds));
  const reviewer = await isReviewer(db, actor);
  const out: WireAuditFlag[] = [];
  for (const f of rows) {
    const rv: ReviewRow | undefined = reviews.find((r) => r.flagId === f.id);
    const hod = rv === undefined && reviewer ? await hodOf(db, actor, f.departmentIds) : false;
    out.push({
      id: f.id, kind: f.kind as WireAuditFlagKind, text: f.text, departments: f.departmentIds.map((d) => depts.get(d) ?? { id: d, code: d, name: d }),
      cites: f.cites as Cite[], raisedAt: f.raisedAt.toISOString(), night: f.night,
      status: rv === undefined ? "open" : (rv.verdict as "upheld" | "dismissed"),
      stale: rv === undefined && now.getTime() - f.raisedAt.getTime() >= AUDIT_FLAG_STALE_DAYS * DAY_MS,
      review: rv === undefined ? null : { verdict: rv.verdict as "upheld" | "dismissed", note: rv.note, by: person(rv.by), at: rv.at.toISOString() },
      canReview: rv === undefined && reviewer && !hod, refusal: rv !== undefined ? null : !reviewer ? "not_permitted" : hod ? "hod_reviews_own" : null,
    });
  }
  return out;
}

/** The flags, newest first; `status` filters (open, upheld, dismissed). */
export async function auditFlags(db: Db, actor: Actor, filter: { status?: WireAuditFlag["status"] } = {}, now: Date = new Date()): Promise<WireAuditFlag[]> {
  await requireFlagReader(db, actor);
  const rows = await db.select().from(storesAuditFlags).orderBy(desc(storesAuditFlags.raisedAt), asc(storesAuditFlags.id)).limit(300);
  const views = await flagViews(db, actor, rows, now);
  return filter.status === undefined ? views : views.filter((v) => v.status === filter.status);
}

/** Open flags only, for the Now card and the waiting line (the reviewer's). */
export async function flagsToReview(db: Db, actor: Actor, now: Date = new Date()): Promise<WireAuditFlag[]> {
  if (!(await isReviewer(db, actor))) return [];
  const reviewed = db.select({ id: storesAuditFlagReviews.flagId }).from(storesAuditFlagReviews);
  const rows = await db.select().from(storesAuditFlags).where(notInArray(storesAuditFlags.id, reviewed)).orderBy(asc(storesAuditFlags.raisedAt)).limit(200);
  return (await flagViews(db, actor, rows, now)).filter((f) => f.canReview);
}

/** The owner's monthly list: flags UPHELD in an IST month (`YYYY-MM`), with what was done. */
export async function ownerMonthlyList(db: Db, actor: Actor, month: string, now: Date = new Date()): Promise<WireAuditFlag[]> {
  await requireFlagReader(db, actor);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new StoresError("bad_month", "a month is YYYY-MM", { month });
  const ids = await db.select({ id: storesAuditFlagReviews.flagId }).from(storesAuditFlagReviews)
    .where(and(eq(storesAuditFlagReviews.verdict, "upheld"), sql`to_char(${storesAuditFlagReviews.at} at time zone ${IST}, 'YYYY-MM') = ${month}`));
  if (ids.length === 0) return [];
  const rows = await db.select().from(storesAuditFlags).where(inArray(storesAuditFlags.id, ids.map((r) => r.id))).orderBy(asc(storesAuditFlags.raisedAt));
  return flagViews(db, actor, rows, now);
}

// ═══════════════════════════════ the review ═══════════════════════════════

/**
 * D18: a person decides. Upheld needs one line on what was done, Dismissed a reason; the materials head or the stores
 * auditor; never the HOD of a department the flag names; once per flag. The review, its `copilot_acts` row (the reviewer,
 * the flag as the proposal) and one act are one transaction.
 */
export async function reviewFlag(
  db: Db, actor: Actor, flagId: string, input: { verdict: "upheld" | "dismissed"; note: string }, now: Date = new Date(),
): Promise<WireAuditFlag> {
  if (input.verdict !== "upheld" && input.verdict !== "dismissed") throw new StoresError("reason_required", "Upheld or Dismissed");
  await withTx(db, async (tx) => {
    const [f] = await tx.select().from(storesAuditFlags).where(eq(storesAuditFlags.id, flagId)).for("update");
    if (f === undefined) throw new StoresError("unknown_flag", "no such flag", { flagId });
    if (!(await isReviewer(tx, actor))) throw new StoresError("not_permitted", "the materials head or the stores auditor reviews a flag");
    const [had] = await tx.select({ id: storesAuditFlagReviews.id }).from(storesAuditFlagReviews).where(eq(storesAuditFlagReviews.flagId, flagId));
    if (had !== undefined) throw new StoresError("flag_reviewed", "this flag is already reviewed");
    const note = clean(input.note);
    if (note === null) throw new StoresError("reason_required", input.verdict === "upheld" ? "say in one line what was done" : "say why it is dismissed");
    if (await hodOf(tx, actor, f.departmentIds)) throw new StoresError("hod_reviews_own", "the department's HOD does not review a flag about the department");
    const reviewId = newId();
    const confirmId = `af_${flagId}`;
    await tx.insert(storesAuditFlagReviews).values({ id: reviewId, flagId, verdict: input.verdict, note: note.slice(0, 300), confirmId, by: actor.id, at: now });
    await tx.insert(copilotActs).values({
      id: newId(), at: now, actorId: actor.id, tool: AUDITOR_TOOL, subjectPatientId: null, argsHash: argsHash({ flagId, verdict: input.verdict }),
      proposalId: flagId, confirmId, resultModule: "stores", resultRowId: reviewId,
    });
    await recordAct(tx, actor, now, {
      act: "audit_flag_review", refId: flagId, reason: note.slice(0, 300), before: { status: "open" }, after: { verdict: input.verdict, kind: f.kind, reviewId, confirmId },
    });
  });
  const [row] = await db.select().from(storesAuditFlags).where(eq(storesAuditFlags.id, flagId));
  return (await flagViews(db, actor, [row!], now))[0]!;
}
