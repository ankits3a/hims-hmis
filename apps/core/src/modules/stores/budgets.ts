import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  purchaseOrders, storeIndents, storesAwardLines, storesAwards, storesDepartmentBudgets, storesOverBudgetMarks, storesPrDeliveries, storesPurchaseRequestLines,
  storesPurchaseRequestStamps, storesPurchaseRequests,
} from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { STORES_BUDGET_MANAGE, departmentOf, holds, recordAct } from "./access";
import { groupLines, holdsRole, lineMoney } from "./buying-common";
import { StoresError } from "./errors";
import { departmentSpendByMonth, nextMonthStart } from "./spend";
import { approversToTell } from "./tickets";
import type { WireDepartmentBudget, WireOverBudgetMonth } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, decision 15; ruling 0099 Q4) — DEPARTMENT BUDGETS: A WARNING, NEVER A REFUSAL.
 *
 * Finance (`stores.budget.manage`: the accounts officer and the owner) sets a department's month figure, or an annual
 * amount split into 12 equal months (DECIDED, flagged to the owner: editable per month, no carry-forward). Every change is
 * a new row and one act.
 *
 * Spent = S3's spend rule (`spend.ts`: receipts into the department's shelves at batch cost, less returns), which already
 * leaves tagged units out, plus (S5c) the Stores POs of the department's requests at PO value when ordered (`committedByPo`).
 * Equipment is apart: band C equipment requests never count and are listed as "Equipment" beside the month.
 *
 * Warnings: one notice at 80 % and one at 100 % per department per month to the HOD (else the stand-in) and the
 * accounts officer, made idempotent by the notice's source key. A ticket approved when the month is used up, or a
 * request that takes it past 100 %, is approved; its stamp carries "over budget". NOTHING IS REFUSED FOR BUDGET.
 */
export const BUDGET_WORDS = {
  warn80: ["Budget 80% used", "बजट 80% खर्च"],
  usedUp: ["Budget used up", "बजट खत्म"],
} as const;

const monthOf = (now: Date): string => istDayString(now).slice(0, 7);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function requireMonth(month: string): void {
  if (!MONTH_RE.test(month)) throw new StoresError("bad_month", "a month is YYYY-MM", { month });
}

function addMonths(month: string, n: number): string {
  let m = month;
  for (let i = 0; i < n; i++) m = nextMonthStart(m).slice(0, 7);
  return m;
}

export async function setDepartmentBudget(
  db: Db, actor: Actor, input: { departmentId: string; month: string; amountPaise: number; annual?: boolean; note?: string | null }, now: Date = new Date(),
): Promise<WireDepartmentBudget[]> {
  if (!(await holds(db, actor, STORES_BUDGET_MANAGE))) {
    throw new StoresError("not_permitted", "budgets are set by finance", { permission: STORES_BUDGET_MANAGE });
  }
  requireMonth(input.month);
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 0) throw new StoresError("bad_quantity", "a budget is a sum of money, zero or more");
  const dept = await departmentOf(db, input.departmentId);
  const annual = input.annual === true;
  const months = annual ? Array.from({ length: 12 }, (_, i) => addMonths(input.month, i)) : [input.month];
  // Twelve equal months, the paise left over on the last one, so the year adds up exactly.
  const each = annual ? Math.floor(input.amountPaise / 12) : input.amountPaise;
  const last = annual ? input.amountPaise - each * 11 : input.amountPaise;
  await withTx(db, async (tx) => {
    for (const [i, month] of months.entries()) {
      const amount = i === months.length - 1 ? last : each;
      const before = await budgetRow(tx, dept.id, month);
      await tx.insert(storesDepartmentBudgets).values({
        id: newId(), departmentId: dept.id, month, amountPaise: amount, note: input.note?.trim() || null, setBy: actor.id, at: now,
      });
      await recordAct(tx, actor, now, {
        act: "set_budget", refId: dept.id, before: before?.amountPaise ?? null, after: { month, amountPaise: amount, annual },
        reason: input.note?.trim() || null,
      });
    }
  });
  return Promise.all(months.map((m) => departmentBudget(db, dept.id, m)));
}

async function budgetRow(db: Db | Tx, departmentId: string, month: string): Promise<typeof storesDepartmentBudgets.$inferSelect | undefined> {
  const [row] = await (db as Db).select().from(storesDepartmentBudgets)
    .where(and(eq(storesDepartmentBudgets.departmentId, departmentId), eq(storesDepartmentBudgets.month, month)))
    .orderBy(desc(storesDepartmentBudgets.at), desc(storesDepartmentBudgets.id)).limit(1);
  return row;
}

const pctOf = (spent: number, budget: number): number => (budget > 0 ? Math.floor((spent * 100) / budget) : spent > 0 ? 100 : 0);

/** The department's month: budget (null = "No budget set"), spent, the share used, and the equipment kept apart. */
export async function departmentBudget(db: Db | Tx, departmentId: string, month: string): Promise<WireDepartmentBudget> {
  requireMonth(month);
  const dept = await departmentOf(db, departmentId);
  const row = await budgetRow(db, dept.id, month);
  const spentPaise = (await departmentSpendByMonth(db, month)).get(dept.code) ?? 0;
  const start = new Date(`${month}-01T00:00:00+05:30`);
  const end = new Date(`${nextMonthStart(month)}T00:00:00+05:30`);
  const approved = await (db as Db).select({ id: storesPurchaseRequests.id, prNo: storesPurchaseRequests.prNo }).from(storesPurchaseRequests)
    .innerJoin(storesPurchaseRequestStamps, eq(storesPurchaseRequestStamps.prId, storesPurchaseRequests.id))
    .where(and(
      eq(storesPurchaseRequests.departmentId, dept.id), eq(storesPurchaseRequestStamps.kind, "approved"),
      gte(storesPurchaseRequestStamps.at, start), lt(storesPurchaseRequestStamps.at, end),
    ));
  const lines = approved.length === 0 ? [] : await (db as Db).select().from(storesPurchaseRequestLines)
    .where(inArray(storesPurchaseRequestLines.prId, approved.map((p) => p.id)));
  const requests = approved.filter((p) => lines.some((l) => l.prId === p.id && l.equipment)).map((p) => ({
    prId: p.id, prNo: p.prNo,
    estimatePaise: lines.filter((l) => l.prId === p.id).reduce((a, l) => a + l.qtyBase * l.unitEstimatePaise, 0),
  }));
  const budgetPaise = row?.amountPaise ?? null;
  const committedPaise = await committedByPo(db, dept.id, month);
  const total = spentPaise + committedPaise;
  return {
    departmentId: dept.id, month, budgetPaise, spentPaise: total, committedPaise, pct: budgetPaise === null ? null : pctOf(total, budgetPaise), equipment: { requests },
  };
}

/**
 * S5c (#1115, decision 15) — "plus Stores POs for that department's non-stock PRs at PO value when ordered". For each
 * Stores PO APPROVED in the IST month (approved, sent or received; an award links it to its group), the department's own
 * request lines on it, priced at the award's rate with GST (Stores input GST is a cost, ruling 0100 Q2), for the
 * quantity NOT YET DELIVERED to the department (`stores_pr_deliveries`): once delivered, the shelf's receipt is counted
 * by S3's rule instead, so nothing is counted twice. Equipment lines never count (they are "Equipment", apart).
 * DECIDED: a delivery ticket raised but not yet received counts in neither, for those hours.
 */
async function committedByPo(db: Db | Tx, departmentId: string, month: string): Promise<number> {
  const start = new Date(`${month}-01T00:00:00+05:30`);
  const end = new Date(`${nextMonthStart(month)}T00:00:00+05:30`);
  const pos = await (db as Db).select({ awardId: purchaseOrders.awardId, vendorId: purchaseOrders.vendorId, groupId: storesAwards.groupId })
    .from(purchaseOrders).innerJoin(storesAwards, eq(storesAwards.id, purchaseOrders.awardId))
    .where(and(inArray(purchaseOrders.status, ["approved", "sent", "part_received", "received"]), gte(purchaseOrders.approvedAt, start), lt(purchaseOrders.approvedAt, end)));
  let total = 0;
  for (const po of pos) {
    const mine = (await groupLines(db, po.groupId)).filter((l) => l.source === "department" && l.departmentId === departmentId && !l.equipment);
    if (mine.length === 0) continue;
    const rates = await (db as Db).select().from(storesAwardLines).where(and(eq(storesAwardLines.awardId, po.awardId!), eq(storesAwardLines.vendorId, po.vendorId)));
    const delivered = await (db as Db).select().from(storesPrDeliveries).where(inArray(storesPrDeliveries.prId, [...new Set(mine.map((l) => l.prId))]));
    for (const l of mine) {
      const r = rates.find((x) => x.itemId === l.itemId);
      if (r === undefined) continue;
      const left = l.qtyBase - delivered.filter((d) => d.prId === l.prId && d.lineIdx === l.lineIdx).reduce((a, d) => a + d.qtyBase, 0);
      if (left <= 0) continue;
      const m = lineMoney(left, r.ratePaise, r.discountBps, r.gstRateBps);
      total += m.taxablePaise + m.gstPaise;
    }
  }
  return total;
}

/**
 * S5c (#1115, decision 15: "a monthly over-budget list to the owner") — every department past 100 % of a month's budget,
 * with the approvals that carried "over budget" (tickets' marks and requests' stamps) in that month. The owner and
 * finance read it; nothing in it refuses anything.
 */
export async function overBudgetList(db: Db, actor: Actor, month: string): Promise<WireOverBudgetMonth> {
  if (!(await holds(db, actor, STORES_BUDGET_MANAGE)) && !(await holdsRole(db, actor, "owner"))) {
    throw new StoresError("not_permitted", "the over-budget list is the owner's and finance's", { permission: STORES_BUDGET_MANAGE });
  }
  return overBudgetMonth(db, month);
}

export async function overBudgetMonth(db: Db | Tx, month: string): Promise<WireOverBudgetMonth> {
  requireMonth(month);
  const start = new Date(`${month}-01T00:00:00+05:30`);
  const end = new Date(`${nextMonthStart(month)}T00:00:00+05:30`);
  const depts = await (db as Db).selectDistinct({ id: storesDepartmentBudgets.departmentId }).from(storesDepartmentBudgets).where(eq(storesDepartmentBudgets.month, month));
  const out: WireOverBudgetMonth["departments"] = [];
  for (const { id } of depts) {
    const b = await departmentBudget(db, id, month);
    if (b.budgetPaise === null || b.spentPaise <= b.budgetPaise) continue;
    const dept = await departmentOf(db, id);
    const tickets = await (db as Db).select({ id: storesOverBudgetMarks.refId, at: storesOverBudgetMarks.at, no: storeIndents.indentNo }).from(storesOverBudgetMarks)
      .innerJoin(storeIndents, eq(storeIndents.id, storesOverBudgetMarks.refId))
      .where(and(eq(storesOverBudgetMarks.departmentId, id), eq(storesOverBudgetMarks.month, month)));
    const prs = await (db as Db).select({ id: storesPurchaseRequests.id, no: storesPurchaseRequests.prNo, at: storesPurchaseRequestStamps.at }).from(storesPurchaseRequestStamps)
      .innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesPurchaseRequestStamps.prId))
      .where(and(eq(storesPurchaseRequests.departmentId, id), eq(storesPurchaseRequestStamps.overBudget, true), gte(storesPurchaseRequestStamps.at, start), lt(storesPurchaseRequestStamps.at, end)));
    out.push({
      departmentId: id, code: dept.code, name: dept.name, budgetPaise: b.budgetPaise, spentPaise: b.spentPaise, committedPaise: b.committedPaise, pct: b.pct ?? 100,
      marks: [
        ...tickets.map((t) => ({ refType: "ticket" as const, refId: t.id, no: t.no, at: t.at.toISOString() })),
        ...prs.map((p) => ({ refType: "pr" as const, refId: p.id, no: p.no, at: p.at.toISOString() })),
      ].sort((a, b2) => a.at.localeCompare(b2.at)),
    });
  }
  return { month, departments: out.sort((a, b) => b.pct - a.pct) };
}

export const OVER_BUDGET_WORDS = ["Over budget last month", "पिछले महीने बजट से ज़्यादा"] as const;

/**
 * Once a month (the buyer agent's night run calls it every night; the notice's source key makes it once): when the
 * month before has a department over budget, each owner gets one notice that opens the list. Returns the notices raised.
 */
export async function sendOwnerOverBudgetList(db: Db, now: Date): Promise<number> {
  const thisMonth = monthOf(now);
  const [y, m] = thisMonth.split("-").map(Number) as [number, number];
  const prev = m === 1 ? `${String(y - 1)}-12` : `${String(y)}-${String(m - 1).padStart(2, "0")}`;
  const list = await overBudgetMonth(db, prev);
  if (list.departments.length === 0) return 0;
  let n = 0;
  await withTx(db, async (tx) => {
    for (const userId of await usersHoldingRole(tx, "owner")) {
      const ok = await raiseNotice(tx as unknown as Db, {
        userId, kind: "stores.budget", title: OVER_BUDGET_WORDS[0], body: `${OVER_BUDGET_WORDS[1]} · ${String(list.departments.length)}`,
        refType: "stores_budget", refId: prev, sourceKey: `stores-over-budget:${prev}:${userId}`, at: now,
      });
      if (ok) n += 1;
    }
  });
  return n;
}

/** Who is told: the department's approvers (else the stand-in) and every accounts officer. */
async function budgetRecipients(tx: Tx, departmentId: string): Promise<string[]> {
  const hods = await approversToTell(tx, departmentId, "");
  const accounts = await usersHoldingRole(tx, "accounts_officer");
  return [...new Set([...hods, ...accounts])].sort();
}

/** One department's warnings for a month, at most once each (the notice's source key); returns the notices raised. */
export async function warnBudget(tx: Tx, departmentId: string, now: Date): Promise<number> {
  const month = monthOf(now);
  const b = await departmentBudget(tx, departmentId, month);
  if (b.budgetPaise === null || b.pct === null || b.pct < 80) return 0;
  const dept = await departmentOf(tx, departmentId);
  const levels: { key: string; words: readonly [string, string] }[] = [{ key: "80", words: BUDGET_WORDS.warn80 }];
  if (b.pct >= 100) levels.push({ key: "100", words: BUDGET_WORDS.usedUp });
  let raised = 0;
  for (const userId of await budgetRecipients(tx, departmentId)) {
    for (const l of levels) {
      const ok = await raiseNotice(tx as unknown as Db, {
        userId, kind: "stores.budget", title: l.words[0], body: `${l.words[1]} · ${dept.code}`,
        refType: "stores_budget", refId: departmentId, sourceKey: `stores-budget:${departmentId}:${month}:${l.key}`, at: now,
      });
      if (ok) raised += 1;
    }
  }
  return raised;
}

/** Every department with a budget this month (the chaser's minute sweep calls it, so a receipt is seen within a minute). */
export async function sweepBudgetWarnings(db: Db, now: Date = new Date()): Promise<number> {
  const month = monthOf(now);
  const depts = await db.selectDistinct({ id: storesDepartmentBudgets.departmentId }).from(storesDepartmentBudgets).where(eq(storesDepartmentBudgets.month, month));
  let n = 0;
  for (const d of depts) n += await withTx(db, (tx) => warnBudget(tx, d.id, now));
  return n;
}

/**
 * The budget line on an approval: the month's share used once this request's value is added (an equipment request
 * adds nothing). `over` is "Over budget": past 100 %.
 */
export async function budgetLineFor(
  db: Db | Tx, departmentId: string, addPaise: number, now: Date,
): Promise<{ month: string; pct: number | null; over: boolean; noBudget: boolean }> {
  const month = monthOf(now);
  const b = await departmentBudget(db, departmentId, month);
  if (b.budgetPaise === null) return { month, pct: null, over: false, noBudget: true };
  const total = b.spentPaise + addPaise;
  return { month, pct: pctOf(total, b.budgetPaise), over: total > b.budgetPaise, noBudget: false };
}

/** A ticket approved when its department's month is used up: "over budget" beside the indent's own stamp, once. */
export async function markTicketOverBudget(tx: Tx, indentId: string, departmentId: string, now: Date): Promise<boolean> {
  const month = monthOf(now);
  const b = await departmentBudget(tx, departmentId, month);
  if (b.budgetPaise === null || b.spentPaise < b.budgetPaise) return false;
  await tx.insert(storesOverBudgetMarks).values({
    refType: "ticket", refId: indentId, departmentId, month, pct: pctOf(b.spentPaise, b.budgetPaise), at: now,
  }).onConflictDoNothing();
  return true;
}

/** The tickets among `ids` whose approval carries "over budget". */
export async function ticketsOverBudget(db: Db | Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await (db as Db).select({ id: storesOverBudgetMarks.refId }).from(storesOverBudgetMarks)
    .where(and(eq(storesOverBudgetMarks.refType, "ticket"), inArray(storesOverBudgetMarks.refId, [...ids])));
  return new Set(rows.map((r) => r.id));
}

/** The budget reader's view: finance, the owner and the HOD of the department. */
export async function budgetView(db: Db, actor: Actor, departmentId: string, month: string): Promise<WireDepartmentBudget> {
  if (!(await holds(db, actor, STORES_BUDGET_MANAGE)) && !(await holds(db, actor, "stores.indents.approve", departmentId))) {
    throw new StoresError("not_permitted", "the budget is finance's and the department head's", { permission: STORES_BUDGET_MANAGE });
  }
  return departmentBudget(db, departmentId, month);
}
