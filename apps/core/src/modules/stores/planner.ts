import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { argsHash } from "../../kernel/copilot/act";
import { withTx } from "../../kernel/db/client";
import {
  copilotActs, items, resources, storesOverBudgetMarks, storesPlannerDrafts, storesPlannerForecasts, storesPlannerSettings, storesPlannerWarnings,
} from "../../kernel/db/schema";
import { purchaseHistoryByItem } from "../materials";
import { STORES_AUDIT_READ, STORES_MASTERS, STORES_SHELF_READ, STORES_SHELF_WORK, departmentOf, holds, recordAct, requireShelf, requireShelfAct } from "./access";
import { budgetLineFor } from "./budgets";
import { holdsRole } from "./buying-common";
import { raiseReturn } from "./custody";
import { StoresError } from "./errors";
import {
  PLANNER_AGENT, STORES_PLANNER_MANAGE, activeLines, onHandAt, openDrafts, plannerSettingsOf, shelvesOfDepartment,
} from "./planner-core";
import { HISTORY_WEEKS, PLANNER_WORDS, learningWords, whyOf } from "./planner-math";
import { plannerMonthly, plannerScore } from "./planner-score";
import { getTicket, raiseTicket } from "./tickets";
import type { DraftRow } from "./planner-core";
import type { TicketView } from "./types";
import type {
  Actor, StoresPlannerWord, WirePlannerForecast, WirePlannerMonthly, WirePlannerScore, WirePlannerSettings, WirePlannerTrailRow, WireSlowStockCard,
  WireTopUpLine, WireTopUpProposal, WireTopUpSection,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S7 (#1117, flows 2, 5, 7; decisions 6, 10, 11, 14) — WHAT PEOPLE DO WITH THE PLANNER'S DRAFTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The department's in-charge reads ONE top-up proposal (a section per shelf) and sends each section as its own S2 ticket
 * (`sendTopUp`: channel `agent`, the person as requester, the HOD approves as any ticket), editing a number if needed —
 * the planner's and the person's numbers are both kept. "Not now" needs a reason chip. A slow-stock card's Return is an
 * S2 return. Each of these is a `copilot_acts` row naming the person (the copilot ledger), a closing step on the draft
 * and one act, in one transaction. A budget past 80 % or 100 % is a word on the draft, never a refusal (decision 10).
 *
 * No new grant reads a draft (decision 14): the shelf's grant holders and the materials head. `stores.planner.manage`
 * (materials head) pauses a department, sets the safety-days table, and turns T3 on — only when `plannerScore` passes
 * and the owner's approval is on record.
 */
export const NOT_NOW_REASONS = ["stock_arrived", "use_changed", "other"] as const;
export type NotNowReason = (typeof NOT_NOW_REASONS)[number];
export const PLANNER_TOOLS = {
  send: "stores.planner_topup", notNow: "stores.planner_not_now", ret: "stores.planner_return", accept: "stores.planner_par_accept",
  keep: "stores.planner_par_keep", t3: "stores.planner_t3_send",
} as const;
export const BUDGET_DRAFT_WORDS = { warn80: ["Budget 80% used", "बजट 80% खर्च"], over: ["Over budget", "बजट से ज़्यादा"] } as const;
/** The T3 gate reads the planner's record over the last 8 weeks and needs 4 of them (decision 11). */
export const T3_SCORE_WINDOW_MS = HISTORY_WEEKS * 7 * 86_400_000;

const ex = (db: Db | Tx): Db => db as Db;

async function requireDepartmentReader(db: Db | Tx, actor: Actor, departmentId: string): Promise<void> {
  if (await holds(db, actor, STORES_SHELF_READ, departmentId)) return;
  if (await holds(db, actor, STORES_MASTERS)) return;
  throw new StoresError("not_permitted", "not your department", { permission: STORES_SHELF_READ, departmentId });
}

async function requirePlannerManager(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_PLANNER_MANAGE))) {
    throw new StoresError("not_permitted", "the planner's settings are the materials head's", { permission: STORES_PLANNER_MANAGE });
  }
}

// ═══════════════════════════════ reads ═══════════════════════════════

export async function plannerForecast(db: Db | Tx, storeId: string, itemId: string): Promise<WirePlannerForecast | null> {
  const [f] = await ex(db).select().from(storesPlannerForecasts)
    .where(and(eq(storesPlannerForecasts.storeId, storeId), eq(storesPlannerForecasts.itemId, itemId)))
    .orderBy(desc(storesPlannerForecasts.at), desc(storesPlannerForecasts.id)).limit(1);
  if (f === undefined) return null;
  const learning = f.weeks < HISTORY_WEEKS;
  return {
    id: f.id, storeId: f.storeId, itemId: f.itemId, scope: f.scope as "shelf" | "central", method: f.method as WirePlannerForecast["method"], weeks: f.weeks,
    learning, learningWords: learning ? learningWords(f.weeks) : null, usePerDay: f.usePerDay, onHand: f.onHand, onWay: f.onWay,
    hoursToZero: f.hoursToZero, inputs: f.inputs as Record<string, unknown>, at: f.at.toISOString(),
  };
}

/** Per base unit: the last paid receipt, else the newest batch's landed cost (the opening rate). 0 when unknown. */
export async function unitCosts(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0) return out;
  const history = await purchaseHistoryByItem(db, itemIds, 1);
  for (const id of itemIds) {
    const h = history.get(id)?.[0];
    if (h !== undefined) out.set(id, h.paisePerBase);
  }
  const rest = itemIds.filter((i) => !out.has(i));
  if (rest.length > 0) {
    const rows = (await ex(db).execute(sql`select distinct on (item_id) item_id, landed_cost_paise::bigint as c from stock_batches
      where item_id in (${sql.join(rest.map((i) => sql`${i}`), sql`, `)}) order by item_id, created_at desc, id desc`)).rows as { item_id: string; c: number }[];
    for (const r of rows) out.set(r.item_id, Number(r.c));
  }
  return out;
}

function wordOf(weeks: number, rule: string | null): StoresPlannerWord {
  if (weeks < HISTORY_WEEKS) return "learning";
  return rule === "hours" ? "runs_out_soon" : "low";
}

async function sectionsOf(db: Db | Tx, departmentId: string, drafts: readonly DraftRow[], now: Date): Promise<WireTopUpSection[]> {
  if (drafts.length === 0) return [];
  const lines = await activeLines(db, drafts.map((d) => d.draftId));
  const fIds = lines.map((l) => l.forecastId).filter((x): x is string => x !== null);
  const wIds = lines.map((l) => l.warningId).filter((x): x is string => x !== null);
  const forecasts = new Map(fIds.length === 0 ? [] : (await ex(db).select().from(storesPlannerForecasts).where(inArray(storesPlannerForecasts.id, fIds))).map((f) => [f.id, f] as const));
  const warns = new Map(wIds.length === 0 ? [] : (await ex(db).select().from(storesPlannerWarnings).where(inArray(storesPlannerWarnings.id, wIds))).map((w) => [w.id, w] as const));
  const itemIds = [...new Set(lines.map((l) => l.itemId!))];
  const names = new Map(itemIds.length === 0 ? [] : (await ex(db).select({ id: items.id, code: items.code, name: items.name }).from(items)
    .where(inArray(items.id, itemIds))).map((i) => [i.id, i] as const));
  const shelves = new Map((await ex(db).select({ id: resources.id, name: resources.name, attributes: resources.attributes }).from(resources)
    .where(inArray(resources.id, drafts.map((d) => d.storeId)))).map((r) => [r.id, r] as const));
  const cost = await unitCosts(db, itemIds);
  const out: WireTopUpSection[] = [];
  for (const d of drafts) {
    const mine = lines.filter((l) => l.draftId === d.draftId);
    if (mine.length === 0) continue;
    const view: WireTopUpLine[] = mine.map((l) => {
      const f = l.forecastId === null ? undefined : forecasts.get(l.forecastId);
      const w = l.warningId === null ? undefined : warns.get(l.warningId);
      const weeks = f?.weeks ?? 0;
      const word = wordOf(weeks, w?.rule ?? null);
      const onHand = f?.onHand ?? 0;
      const usePerDay = f?.usePerDay ?? 0;
      return {
        itemId: l.itemId!, code: names.get(l.itemId!)?.code ?? "", name: names.get(l.itemId!)?.name ?? "", qty: l.qty ?? 0, onHand, onWay: f?.onWay ?? 0, usePerDay,
        word, words: PLANNER_WORDS[word], why: whyOf(usePerDay, onHand), urgent: w?.urgent ?? false,
        learningWeeks: weeks < HISTORY_WEEKS ? weeks : null, forecastId: f?.id ?? null, warningId: w?.id ?? null,
      };
    });
    const value = view.reduce((s, l) => s + l.qty * (cost.get(l.itemId) ?? 0), 0);
    const b = await budgetLineFor(db, departmentId, value, now);
    const budget = b.noBudget || b.pct === null ? null
      : b.over ? { pct: b.pct, over: true, words: [...BUDGET_DRAFT_WORDS.over] as [string, string] }
        : b.pct >= 80 ? { pct: b.pct, over: false, words: [...BUDGET_DRAFT_WORDS.warn80] as [string, string] } : null;
    const shelf = shelves.get(d.storeId);
    const supplier = ((shelf?.attributes ?? {}) as { suppliedBy?: string }).suppliedBy ?? null;
    const atStore = supplier === null ? new Map<string, number>() : await onHandAt(db, supplier, view.map((l) => l.itemId));
    out.push({
      draftId: d.draftId, shelfId: d.storeId, shelfName: shelf?.name ?? "", status: "open", budget,
      storeShort: supplier !== null && view.some((l) => (atStore.get(l.itemId) ?? 0) < l.qty), lines: view,
    });
  }
  return out.sort((a, b) => a.shelfName.localeCompare(b.shelfName));
}

async function slowCards(db: Db | Tx, drafts: readonly DraftRow[]): Promise<WireSlowStockCard[]> {
  if (drafts.length === 0) return [];
  const lines = await activeLines(db, drafts.map((d) => d.draftId));
  const itemIds = [...new Set(lines.map((l) => l.itemId!))];
  const names = new Map(itemIds.length === 0 ? [] : (await ex(db).select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, itemIds))).map((i) => [i.id, i.name] as const));
  const shelves = new Map((await ex(db).select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, drafts.map((d) => d.storeId)))).map((r) => [r.id, r.name] as const));
  const out: WireSlowStockCard[] = [];
  for (const d of drafts) {
    const have = await onHandAt(db, d.storeId);
    const mine = lines.filter((l) => l.draftId === d.draftId && (have.get(l.itemId!) ?? 0) > 0);
    if (mine.length === 0) continue;
    out.push({ draftId: d.draftId, shelfId: d.storeId, shelfName: shelves.get(d.storeId) ?? "", lines: mine.map((l) => ({ itemId: l.itemId!, name: names.get(l.itemId!) ?? "", onHand: have.get(l.itemId!) ?? 0 })) });
  }
  return out;
}

/** Flow 2: the department's one top-up proposal (and its slow-stock card), or null when there is nothing open. */
export async function topUpProposal(db: Db | Tx, actor: Actor, departmentId: string, now: Date = new Date()): Promise<WireTopUpProposal | null> {
  await requireDepartmentReader(db, actor, departmentId);
  return proposalOf(db, departmentId, now);
}

export async function proposalOf(db: Db | Tx, departmentId: string, now: Date): Promise<WireTopUpProposal | null> {
  const shelves = await shelvesOfDepartment(db, departmentId);
  const sections = await sectionsOf(db, departmentId, await openDrafts(db, shelves, "topup"), now);
  const slow = await slowCards(db, await openDrafts(db, shelves, "slow"));
  if (sections.length === 0 && slow.length === 0) return null;
  const dept = await departmentOf(db, departmentId);
  const all = sections.flatMap((s) => s.lines);
  const hours = all.map((l) => (l.usePerDay > 0 ? (l.onHand + l.onWay) / (l.usePerDay / 24) : null)).filter((h): h is number => h !== null);
  return {
    departmentId, departmentName: dept.name, sections, slow,
    runOut: { count: all.length, days: hours.length === 0 ? 2 : Math.max(1, Math.ceil(Math.max(...hours) / 24)), urgent: all.some((l) => l.urgent) },
  };
}

/** Every department whose shelves the person works: their proposals (the phone's top-up screen). */
export async function myTopUps(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<WireTopUpProposal[]> {
  const depts = ((await ex(db).execute(sql`select distinct attributes->>'departmentId' as d from resources where kind = 'store'
    and attributes->>'domain' = 'stores' and attributes->>'kind' = 'shelf' and status <> 'retired'`)).rows as { d: string | null }[])
    .map((r) => r.d).filter((d): d is string => d !== null);
  const out: WireTopUpProposal[] = [];
  for (const d of depts.sort()) {
    if (!(await holds(db, actor, STORES_SHELF_WORK, d))) continue;
    const p = await proposalOf(db, d, now);
    if (p !== null) out.push(p);
  }
  return out;
}

// ═══════════════════════════════ acts ═══════════════════════════════

async function requireOpenDraft(tx: Db | Tx, draftId: string, lock: boolean): Promise<DraftRow> {
  if (lock) await (tx as Tx).execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-planner-close:${draftId}`}))`);
  const rows = await ex(tx).select().from(storesPlannerDrafts).where(eq(storesPlannerDrafts.draftId, draftId));
  const head = rows.find((r) => r.kind === "open");
  if (head === undefined) throw new StoresError("unknown_draft", "no such draft", { draftId });
  if (rows.some((r) => ["sent", "not_now", "withdrawn"].includes(r.kind))) throw new StoresError("draft_closed", "this draft is already done", { draftId });
  return head;
}

async function ledger(tx: Tx, actor: Actor, tool: string, draftId: string, confirmId: string, args: unknown, resultRowId: string | null, now: Date): Promise<string> {
  const id = newId();
  await tx.insert(copilotActs).values({
    id, at: now, actorId: actor.id, tool, subjectPatientId: null, argsHash: argsHash(args), proposalId: draftId, confirmId,
    resultModule: "stores", resultRowId,
  });
  return id;
}

/**
 * Flow 2, the third tap: one section sent as its own S2 ticket (channel `agent`, the in-charge as requester), the
 * planner's and the person's numbers side by side. Over 100 % of the month's budget the ticket carries "over budget"
 * from the start (decision 10) and is sent all the same.
 */
export async function sendTopUp(
  db: Db, actor: Actor, draftId: string, input: { lines?: readonly { itemId: string; qty: number }[] }, now: Date = new Date(),
): Promise<{ ticket: TicketView; actId: string }> {
  const head = await requireOpenDraft(db, draftId, false);
  if (head.proposal !== "topup") throw new StoresError("unknown_draft", "this is not a top-up draft", { draftId });
  const shelf = await requireShelf(db, head.storeId);
  await requireShelfAct(db, actor, shelf, "work");
  const result = await withTx(db, async (tx) => {
    await requireOpenDraft(tx, draftId, true);
    const lines = await activeLines(tx, [draftId]);
    if (lines.length === 0) throw new StoresError("draft_closed", "nothing is left on this draft", { draftId });
    const edits = new Map<string, number>();
    for (const e of input.lines ?? []) {
      if (!lines.some((l) => l.itemId === e.itemId)) throw new StoresError("not_on_draft", "that item is not on this draft", { itemId: e.itemId });
      if (!Number.isSafeInteger(e.qty) || e.qty <= 0) throw new StoresError("bad_quantity", "each quantity is a whole number above zero", { itemId: e.itemId });
      edits.set(e.itemId, e.qty);
    }
    const sent = lines.map((l) => ({ itemId: l.itemId!, plannerQty: l.qty!, qty: edits.get(l.itemId!) ?? l.qty! }));
    const warnIds = lines.map((l) => l.warningId).filter((x): x is string => x !== null);
    const urgent = warnIds.length > 0 && (await tx.select({ u: storesPlannerWarnings.urgent }).from(storesPlannerWarnings)
      .where(inArray(storesPlannerWarnings.id, warnIds))).some((w) => w.u);
    const cost = await unitCosts(tx, sent.map((s) => s.itemId));
    const budget = await budgetLineFor(tx, head.departmentId, sent.reduce((s, l) => s + l.qty * (cost.get(l.itemId) ?? 0), 0), now);
    const ticket = await raiseTicket(tx as unknown as Db, actor, {
      shelfId: shelf.id, lines: sent.map((s) => ({ itemId: s.itemId, qtyBase: s.qty })), priority: urgent ? "urgent" : "routine", channel: "agent",
      note: "Planner top-up",
    }, now);
    if (budget.over && budget.pct !== null) {
      await tx.insert(storesOverBudgetMarks).values({ refType: "ticket", refId: ticket.id, departmentId: head.departmentId, month: budget.month, pct: budget.pct, at: now })
        .onConflictDoNothing();
    }
    const confirmId = `sp_${draftId}`;
    const actId = await ledger(tx, actor, PLANNER_TOOLS.send, draftId, confirmId, { draftId, lines: sent }, ticket.id, now);
    await tx.insert(storesPlannerDrafts).values({
      id: newId(), draftId, kind: "sent", proposal: "topup", storeId: shelf.id, departmentId: head.departmentId, indentId: ticket.id, by: actor.id, at: now,
      data: { lines: sent, overBudget: budget.over, pct: budget.pct, confirmId, actId },
    });
    await recordAct(tx, actor, now, {
      act: "planner_send", storeId: shelf.id, refId: draftId, after: { indentId: ticket.id, indentNo: ticket.indentNo, confirmId, actId, overBudget: budget.over },
      lines: sent.map((s) => ({ ...s })),
    });
    return { id: ticket.id, actId };
  });
  return { ticket: (await getTicket(db, result.id, now))!, actId: result.actId };
}

/** "Not now / अभी नहीं" — closes the card until the item is warned again; only with a reason chip. */
export async function notNowTopUp(db: Db, actor: Actor, draftId: string, reason: string | null, now: Date = new Date()): Promise<{ actId: string }> {
  if (reason === null || !(NOT_NOW_REASONS as readonly string[]).includes(reason)) {
    throw new StoresError("reason_required", "choose why: stock arrived, use changed or other", { reasons: NOT_NOW_REASONS });
  }
  const head = await requireOpenDraft(db, draftId, false);
  const shelf = await requireShelf(db, head.storeId);
  await requireShelfAct(db, actor, shelf, "work");
  return withTx(db, async (tx) => {
    await requireOpenDraft(tx, draftId, true);
    const confirmId = `sn_${draftId}`;
    const actId = await ledger(tx, actor, PLANNER_TOOLS.notNow, draftId, confirmId, { draftId, reason }, null, now);
    await tx.insert(storesPlannerDrafts).values({
      id: newId(), draftId, kind: "not_now", proposal: head.proposal, storeId: shelf.id, departmentId: head.departmentId, reason, by: actor.id, at: now,
      data: { confirmId, actId },
    });
    await recordAct(tx, actor, now, { act: "planner_not_now", storeId: shelf.id, refId: draftId, reason, after: { confirmId, actId } });
    return { actId };
  });
}

/** The slow-stock card's "Return / लौटाएँ": every item on it goes back to the supplying store as unused (an S2 return). */
export async function returnSlowStock(db: Db, actor: Actor, draftId: string, now: Date = new Date()): Promise<{ transferIds: string[]; actId: string }> {
  const head = await requireOpenDraft(db, draftId, false);
  if (head.proposal !== "slow") throw new StoresError("unknown_draft", "this is not a slow-stock card", { draftId });
  const shelf = await requireShelf(db, head.storeId);
  await requireShelfAct(db, actor, shelf, "work");
  return withTx(db, async (tx) => {
    await requireOpenDraft(tx, draftId, true);
    const have = await onHandAt(tx, shelf.id);
    const lines = (await activeLines(tx, [draftId])).map((l) => ({ itemId: l.itemId!, qtyBase: have.get(l.itemId!) ?? 0 })).filter((l) => l.qtyBase > 0);
    if (lines.length === 0) throw new StoresError("draft_closed", "nothing left to return", { draftId });
    const made = await raiseReturn(tx as unknown as Db, actor, { shelfId: shelf.id, lines: lines.map((l) => ({ ...l, reason: "unused" as const })), note: "Not used in 90 days" }, now);
    const transferIds = made.map((m) => m.transferId);
    const confirmId = `sr_${draftId}`;
    const actId = await ledger(tx, actor, PLANNER_TOOLS.ret, draftId, confirmId, { draftId, lines }, transferIds[0] ?? null, now);
    await tx.insert(storesPlannerDrafts).values({
      id: newId(), draftId, kind: "sent", proposal: "slow", storeId: shelf.id, departmentId: head.departmentId, by: actor.id, at: now,
      data: { lines: lines.map((l) => ({ itemId: l.itemId, plannerQty: l.qtyBase, qty: l.qtyBase })), transferIds, confirmId, actId },
    });
    await recordAct(tx, actor, now, { act: "planner_return", storeId: shelf.id, refId: draftId, after: { transferIds, confirmId, actId }, lines });
    return { transferIds, actId };
  });
}

// ═══════════════════════════════ look back (flow 7) ═══════════════════════════════

const RANK: Record<WirePlannerTrailRow["kind"], number> = {
  forecast: 0, warning: 1, recovered: 2, draft: 3, line_withdrawn: 4, ticket: 5, not_now: 5, withdrawn: 5,
};

/** For one shelf item: its forecasts, warnings, draft lines and what people did with them, in order. */
export async function plannerTrail(db: Db | Tx, actor: Actor, shelfId: string, itemId: string): Promise<WirePlannerTrailRow[]> {
  const shelf = await requireShelf(db, shelfId);
  if (!(await holds(db, actor, STORES_AUDIT_READ)) && !(await holds(db, actor, STORES_SHELF_READ, shelf.departmentId)) && !(await holds(db, actor, STORES_MASTERS))) {
    throw new StoresError("not_permitted", "not your department", { permission: STORES_SHELF_READ, departmentId: shelf.departmentId });
  }
  const out: WirePlannerTrailRow[] = [];
  for (const f of await ex(db).select().from(storesPlannerForecasts).where(and(eq(storesPlannerForecasts.storeId, shelfId), eq(storesPlannerForecasts.itemId, itemId)))) {
    out.push({ kind: "forecast", at: f.at.toISOString(), id: f.id, refId: null, detail: { method: f.method, weeks: f.weeks, usePerDay: f.usePerDay, onHand: f.onHand, onWay: f.onWay } });
  }
  for (const w of await ex(db).select().from(storesPlannerWarnings).where(and(eq(storesPlannerWarnings.storeId, shelfId), eq(storesPlannerWarnings.itemId, itemId)))) {
    out.push({ kind: w.kind === "warn" ? "warning" : "recovered", at: w.at.toISOString(), id: w.id, refId: w.forecastId, detail: { rule: w.rule, urgent: w.urgent, onHand: w.onHand, source: w.source } });
  }
  const mine = await ex(db).select().from(storesPlannerDrafts).where(and(eq(storesPlannerDrafts.storeId, shelfId), eq(storesPlannerDrafts.itemId, itemId)));
  const draftIds = [...new Set(mine.map((m) => m.draftId))];
  for (const l of mine) {
    out.push({ kind: l.kind === "line" ? "draft" : "line_withdrawn", at: l.at.toISOString(), id: l.id, refId: l.draftId, detail: { qty: l.qty, warningId: l.warningId, proposal: l.proposal } });
  }
  if (draftIds.length > 0) {
    for (const c of await ex(db).select().from(storesPlannerDrafts).where(and(inArray(storesPlannerDrafts.draftId, draftIds), inArray(storesPlannerDrafts.kind, ["sent", "not_now", "withdrawn"])))) {
      const line = ((c.data as { lines?: { itemId: string; plannerQty: number; qty: number }[] } | null)?.lines ?? []).find((x) => x.itemId === itemId) ?? null;
      out.push({
        kind: c.kind === "sent" ? "ticket" : (c.kind as "not_now" | "withdrawn"), at: c.at.toISOString(), id: c.id, refId: c.indentId ?? c.draftId,
        detail: { by: c.by, reason: c.reason, line },
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || RANK[a.kind] - RANK[b.kind]);
}

// ═══════════════════════════════ settings, the score, T3 (decisions 11, 14) ═══════════════════════════════

export async function plannerSettingsView(db: Db | Tx, departmentId: string | null): Promise<WirePlannerSettings> {
  const s = await plannerSettingsOf(db, departmentId);
  return { departmentId, paused: s.paused, t3: s.t3, ownerApproved: s.ownerApproved, safetyDays: s.safetyDays, coverDays: s.coverDays };
}

function table<T extends Record<string, number>>(v: unknown, keys: readonly (keyof T)[], what: string): T | null {
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  for (const k of keys) {
    const n = o[k as string];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 365) throw new StoresError("bad_quantity", `${what} are whole days, 0 to 365`, { key: k });
  }
  return Object.fromEntries(keys.map((k) => [k, o[k as string]])) as T;
}

/**
 * Pause a department, turn T3 on or off, or set the hospital's safety-days and cover table (department null). Every
 * change is a new row and one act. T3 on needs `plannerScore` to pass over the last 8 weeks (`t3_not_earned`) and the
 * owner's approval on record for that department (`owner_approval_needed`).
 */
export async function setPlannerSettings(
  db: Db, actor: Actor,
  input: { departmentId?: string | null; paused?: boolean; t3?: boolean; safetyDays?: unknown; coverDays?: unknown; reason?: string | null },
  now: Date = new Date(),
): Promise<WirePlannerSettings> {
  await requirePlannerManager(db, actor);
  const dept = input.departmentId == null ? null : (await departmentOf(db, input.departmentId)).id;
  const cur = await plannerSettingsOf(db, dept);
  const safety = table<{ V: number; E: number; D: number }>(input.safetyDays, ["V", "E", "D"], "safety days");
  const cover = table<{ A: number; B: number; C: number }>(input.coverDays, ["A", "B", "C"], "cover days");
  if (dept === null && (input.paused !== undefined || input.t3 !== undefined)) {
    throw new StoresError("unknown_department", "pause and T3 are per department");
  }
  if (dept !== null && input.t3 === true && !cur.t3) {
    const score = await plannerScore(db, dept, new Date(now.getTime() - T3_SCORE_WINDOW_MS), now);
    if (!score.passes) throw new StoresError("t3_not_earned", "T3 needs 4 weeks with 95% of drafts sent unchanged and no stock-out without warning", { score });
    if (!cur.ownerApproved) throw new StoresError("owner_approval_needed", "T3 needs the owner's yes for this department", { departmentId: dept });
  }
  const row = {
    id: newId(), kind: "settings", departmentId: dept, paused: input.paused ?? cur.paused, t3: input.t3 ?? cur.t3,
    safetyDays: dept === null ? (safety ?? cur.safetyDays) : null, coverDays: dept === null ? (cover ?? cur.coverDays) : null,
    reason: input.reason?.trim() || null, by: actor.id, at: now,
  };
  await withTx(db, async (tx) => {
    await tx.insert(storesPlannerSettings).values(row);
    await recordAct(tx, actor, now, {
      act: "planner_settings", refId: row.id, before: { paused: cur.paused, t3: cur.t3, safetyDays: cur.safetyDays, coverDays: cur.coverDays },
      after: { departmentId: dept, paused: row.paused, t3: row.t3, safetyDays: row.safetyDays, coverDays: row.coverDays }, reason: row.reason,
    });
  });
  return plannerSettingsView(db, dept);
}

/** The owner's yes to T3 for one department (decision 11): a row and an act. Only the owner role gives it. */
export async function approvePlannerT3(db: Db, actor: Actor, departmentId: string, now: Date = new Date()): Promise<WirePlannerSettings> {
  if (!(await holdsRole(db, actor, "owner"))) throw new StoresError("not_permitted", "T3 is the owner's to approve", { role: "owner" });
  const dept = (await departmentOf(db, departmentId)).id;
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesPlannerSettings).values({ id, kind: "owner_t3", departmentId: dept, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "planner_t3_approve", refId: id, after: { departmentId: dept } });
  });
  return plannerSettingsView(db, dept);
}

export async function departmentPlannerScore(db: Db, actor: Actor, departmentId: string, now: Date = new Date()): Promise<WirePlannerScore> {
  await requireDepartmentReader(db, actor, departmentId);
  return plannerScore(db, departmentId, new Date(now.getTime() - T3_SCORE_WINDOW_MS), now);
}

/** Flow 6: the owner's and the materials head's monthly line. */
export async function plannerMonthlyLine(db: Db, actor: Actor, month?: string, now: Date = new Date()): Promise<WirePlannerMonthly> {
  if (!(await holds(db, actor, STORES_MASTERS)) && !(await holds(db, actor, STORES_PLANNER_MANAGE)) && !(await holdsRole(db, actor, "owner"))) {
    throw new StoresError("not_permitted", "the monthly line is the owner's and the materials head's", { permission: STORES_PLANNER_MANAGE });
  }
  const m = month ?? istDayString(now).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new StoresError("bad_month", "a month is YYYY-MM", { month: m });
  return plannerMonthly(db, m);
}

export { PLANNER_AGENT };
