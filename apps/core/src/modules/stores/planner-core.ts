import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { readCopilotGate } from "../../kernel/copilot/halt";
import {
  itemStockLevels, roleAssignments, rolePermissions, storesParSuggestions, storesPlannerDrafts, storesPlannerForecasts, storesPlannerSettings,
  storesPlannerWarnings, users,
} from "../../kernel/db/schema";
import { STORES_MASTERS, recordAct } from "./access";
import { issuePacks } from "./items";
import {
  DEFAULT_COVER_DAYS, DEFAULT_SAFETY_DAYS, HISTORY_WEEKS, recovered, topUpQty, verdictOf, weeksOfHistory,
} from "./planner-math";
import type { CoverDays, SafetyDays, Verdict } from "./planner-math";
import type { Actor, StoresPar } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S7 (#1117) — THE PLANNER'S ROWS: FORECASTS, WARNINGS, DRAFT LINES, THE PROPOSAL LIMIT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What both the night (`planner-night.ts`) and the day call. The day's call is `recheckShelfItem`, made by `use.ts` in
 * the SAME transaction as each "Used" and each receipt at a shelf (decision 5): plain arithmetic against the item's
 * stored forecast — no job, no model — so a sudden run warns that hour, not the next morning.
 *
 * Everything written here is an append-only row (migration 0250) plus one `stores.act_recorded` act:
 *   a warning (`planner_warning`, the shelf and item), its end (`planner_recovered`), a draft line (`planner_draft`).
 * The planner sends nothing: a draft is sent by a person (`planner.ts` `sendTopUp`), or under T3 by the night (OFF).
 *
 * The limit (decision 12, programme §7): at most THREE open proposals per department — its top-up proposal (all its
 * shelves' drafts are ONE proposal), its slow-stock proposal, and each quarter's par-suggestion set. A fourth is not
 * opened: the planner is halted for that department and the materials head is told once (the notice's source key is the
 * set of proposals that blocked it). Warnings (T0) are never held back by the limit.
 *
 * This file must not import `use.ts`, `tickets.ts` or `custody.ts` (they import `use.ts`, which imports this).
 */
export const PLANNER_AGENT: Actor = { type: "agent", id: "stores-planner-agent" };
export const PROPOSAL_CAP = 3;
export const PLANNER_HALT_WORDS = (n: number): [string, string] => [`Planner paused: ${String(n)} open`, `प्लानर रुका: ${String(n)} खुले`];
const DAY_MS = 86_400_000;
export const STORES_PLANNER_MANAGE = "stores.planner.manage";

const ex = (db: Db | Tx): Db => db as Db;

/** Net use at a shelf: `consume` rows less their reversals (S1's rule, `reads.ts`), positive. */
export const SHELF_NET_USE = sql`case when sl.reason = 'consume' or sl.ref_type = 'reversal' then -sl.qty_delta else 0 end`;
/** What leaves a central store: its issues (transfers out) and anything consumed there, net of reversals. */
export const STORE_NET_OUT = sql`case when sl.reason in ('issue', 'consume') and sl.qty_delta < 0 then -sl.qty_delta when sl.ref_type = 'reversal' then -sl.qty_delta else 0 end`;

// ═══════════════════════════════ reads ═══════════════════════════════

export type History = { firstAt: Date | null; weekly: number[]; total: number };

/** Per item at one place: the first ledger row, and the use in each of the last 8 weeks (`weekly[0]` = the last 7 days). */
export async function historyAt(db: Db | Tx, storeId: string, now: Date, use: "shelf" | "store", itemIds?: readonly string[]): Promise<Map<string, History>> {
  const expr = use === "shelf" ? SHELF_NET_USE : STORE_NET_OUT;
  const only = itemIds === undefined ? sql`` : itemIds.length === 0 ? sql` and false` : sql` and sl.item_id in (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)})`;
  const first = (await ex(db).execute(sql`select sl.item_id, min(sl.occurred_at) as first from stock_ledger sl
    where sl.resource_id = ${storeId}${only} group by sl.item_id`)).rows as { item_id: string; first: string | Date }[];
  const since = new Date(now.getTime() - HISTORY_WEEKS * 7 * DAY_MS);
  const weeks = (await ex(db).execute(sql`select sl.item_id, floor(extract(epoch from (${now.toISOString()}::timestamptz - sl.occurred_at)) / 604800)::int as w,
      coalesce(sum(${expr}), 0)::int as used
    from stock_ledger sl where sl.resource_id = ${storeId}${only}
      and sl.occurred_at >= ${since.toISOString()}::timestamptz and sl.occurred_at < ${now.toISOString()}::timestamptz
    group by 1, 2`)).rows as { item_id: string; w: number; used: number }[];
  const out = new Map<string, History>();
  for (const f of first) out.set(f.item_id, { firstAt: new Date(f.first), weekly: Array.from({ length: HISTORY_WEEKS }, () => 0), total: 0 });
  for (const r of weeks) {
    const h = out.get(r.item_id);
    if (h === undefined || r.w < 0 || r.w >= HISTORY_WEEKS) continue;
    h.weekly[r.w] = (h.weekly[r.w] ?? 0) + Number(r.used);
    h.total += Number(r.used);
  }
  return out;
}

/** Use per IST day over the `days` days before today (index 0 = yesterday, IST). */
export async function dailyUseAt(db: Db | Tx, storeId: string, itemId: string, today: string, days: number): Promise<number[]> {
  const rows = (await ex(db).execute(sql`select (${today}::date - (sl.occurred_at at time zone 'Asia/Kolkata')::date - 1)::int as d,
      coalesce(sum(${SHELF_NET_USE}), 0)::int as used
    from stock_ledger sl where sl.resource_id = ${storeId} and sl.item_id = ${itemId}
      and (sl.occurred_at at time zone 'Asia/Kolkata')::date < ${today}::date
      and (sl.occurred_at at time zone 'Asia/Kolkata')::date >= (${today}::date - ${days}::int) group by 1`)).rows as { d: number; used: number }[];
  const out = Array.from({ length: days }, () => 0);
  for (const r of rows) if (r.d >= 0 && r.d < days) out[r.d] = Number(r.used);
  return out;
}

export async function onHandAt(db: Db | Tx, storeId: string, itemIds?: readonly string[]): Promise<Map<string, number>> {
  const only = itemIds === undefined ? sql`` : itemIds.length === 0 ? sql` and false` : sql` and item_id in (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)})`;
  const rows = (await ex(db).execute(sql`select item_id, coalesce(sum(qty_on_hand), 0)::int as q from stock_balances where resource_id = ${storeId}${only} group by item_id`))
    .rows as { item_id: string; q: number }[];
  return new Map(rows.map((r) => [r.item_id, Number(r.q)] as const));
}

/**
 * What is already on its way to a shelf (decision 5, edge 4): its open tickets — asked (or as approved) while waiting,
 * issued while the transfer is still in transit. A declined or cancelled ticket brings nothing.
 */
export async function onWayAt(db: Db | Tx, shelfId: string): Promise<Map<string, number>> {
  const rows = (await ex(db).execute(sql`select l.item_id,
      coalesce(sum(case when i.status = 'requested' then coalesce(l.qty_approved, l.qty_base)
                        when i.status = 'issued' and t.status = 'in_transit' then coalesce(l.qty_issued, 0) else 0 end), 0)::int as q
    from store_indent_lines l join store_indents i on i.id = l.indent_id left join transfers t on t.id = i.transfer_id
    where i.from_resource_id = ${shelfId} and i.status in ('requested', 'issued') group by l.item_id`)).rows as { item_id: string; q: number }[];
  return new Map(rows.map((r) => [r.item_id, Number(r.q)] as const));
}

export async function parsAt(db: Db | Tx, storeId: string): Promise<Map<string, StoresPar>> {
  const rows = await ex(db).select().from(itemStockLevels).where(eq(itemStockLevels.storeResourceId, storeId));
  return new Map(rows.map((l) => [l.itemId, { minBase: l.minBase, reorderBase: l.reorderBase, maxBase: l.maxBase }] as const));
}

// ═══════════════════════════════ settings ═══════════════════════════════

export type PlannerSettings = { paused: boolean; t3: boolean; ownerApproved: boolean; safetyDays: SafetyDays; coverDays: CoverDays };

/** The newest settings row for the department (paused, T3) and the hospital's (department null) tables; ruled defaults. */
export async function plannerSettingsOf(db: Db | Tx, departmentId: string | null): Promise<PlannerSettings> {
  const newest = async (dept: string | null) => (await ex(db).select().from(storesPlannerSettings)
    .where(and(eq(storesPlannerSettings.kind, "settings"), dept === null ? sql`${storesPlannerSettings.departmentId} is null` : eq(storesPlannerSettings.departmentId, dept)))
    .orderBy(desc(storesPlannerSettings.at), desc(storesPlannerSettings.id)).limit(1))[0];
  const hospital = await newest(null);
  const own = departmentId === null ? undefined : await newest(departmentId);
  const approved = departmentId === null ? [] : await ex(db).select({ id: storesPlannerSettings.id }).from(storesPlannerSettings)
    .where(and(eq(storesPlannerSettings.kind, "owner_t3"), eq(storesPlannerSettings.departmentId, departmentId))).limit(1);
  const tableOr = <T extends object>(v: unknown, d: T): T => (v !== null && typeof v === "object" ? { ...d, ...(v as Partial<T>) } : { ...d });
  return {
    paused: own?.paused ?? false, t3: own?.t3 ?? false, ownerApproved: approved.length > 0,
    safetyDays: tableOr(hospital?.safetyDays, DEFAULT_SAFETY_DAYS as SafetyDays), coverDays: tableOr(hospital?.coverDays, DEFAULT_COVER_DAYS as CoverDays),
  };
}

/**
 * The copilot's draft switch (or the global one): drafts stop, warnings (T0) do not. The `read` halt (the asks, the
 * model's text) does NOT stop the planner (decision 12, D10): its numbers need no model and its "why" is a template.
 */
export async function draftsHalted(db: Db | Tx, now: Date): Promise<boolean> {
  const halts = (await readCopilotGate(db as Db, now)).halts;
  return halts.has("global") || halts.has("draft");
}

// ═══════════════════════════════ forecasts ═══════════════════════════════

export type ForecastRow = typeof storesPlannerForecasts.$inferSelect;

export async function insertForecast(
  tx: Tx, f: Omit<typeof storesPlannerForecasts.$inferInsert, "id" | "madeBy"> & { madeBy?: string },
): Promise<ForecastRow> {
  const row = { ...f, id: newId(), madeBy: f.madeBy ?? PLANNER_AGENT.id } as typeof storesPlannerForecasts.$inferInsert;
  await tx.insert(storesPlannerForecasts).values(row);
  return row as ForecastRow;
}

export async function latestForecast(db: Db | Tx, storeId: string, itemId: string): Promise<ForecastRow | null> {
  const [f] = await ex(db).select().from(storesPlannerForecasts)
    .where(and(eq(storesPlannerForecasts.storeId, storeId), eq(storesPlannerForecasts.itemId, itemId)))
    .orderBy(desc(storesPlannerForecasts.at), desc(storesPlannerForecasts.id)).limit(1);
  return f ?? null;
}

// ═══════════════════════════════ warnings ═══════════════════════════════

export type WarningRow = typeof storesPlannerWarnings.$inferSelect;

/** The live warning of a shelf item: its newest row, when that row is a `warn`. */
export async function liveWarning(db: Db | Tx, storeId: string, itemId: string): Promise<WarningRow | null> {
  const [w] = await ex(db).select().from(storesPlannerWarnings)
    .where(and(eq(storesPlannerWarnings.storeId, storeId), eq(storesPlannerWarnings.itemId, itemId)))
    .orderBy(desc(storesPlannerWarnings.at), desc(storesPlannerWarnings.id)).limit(1);
  return w !== undefined && w.kind === "warn" ? w : null;
}

type ShelfCtx = { id: string; departmentId: string; departmentCode: string };

async function writeWarning(
  tx: Tx, shelf: ShelfCtx, itemId: string, v: Verdict, f: ForecastRow, source: "night" | "use" | "receipt", now: Date,
): Promise<WarningRow> {
  const row = {
    id: newId(), storeId: shelf.id, itemId, departmentId: shelf.departmentId, kind: "warn", rule: v.rule, urgent: v.urgent,
    hoursToZero: v.hoursToZero, onHand: f.onHand, onWay: f.onWay, forecastId: f.id, source, at: now,
  };
  await tx.insert(storesPlannerWarnings).values(row);
  await recordAct(tx, PLANNER_AGENT, now, {
    act: "planner_warning", storeId: shelf.id, itemId, refId: row.id, before: null,
    after: { rule: v.rule, urgent: v.urgent, hoursToZero: v.hoursToZero, onHand: f.onHand, onWay: f.onWay, usePerDay: f.usePerDay, forecastId: f.id, source },
  });
  return row as WarningRow;
}

async function writeRecovered(tx: Tx, shelf: ShelfCtx, itemId: string, onHand: number, onWay: number, source: "night" | "use" | "receipt", now: Date): Promise<void> {
  const id = newId();
  await tx.insert(storesPlannerWarnings).values({
    id, storeId: shelf.id, itemId, departmentId: shelf.departmentId, kind: "recovered", rule: null, urgent: false, hoursToZero: null, onHand, onWay,
    forecastId: null, source, at: now,
  });
  await recordAct(tx, PLANNER_AGENT, now, { act: "planner_recovered", storeId: shelf.id, itemId, refId: id, after: { onHand } });
}

// ═══════════════════════════════ drafts and the limit ═══════════════════════════════

export type DraftRow = typeof storesPlannerDrafts.$inferSelect;
const CLOSING = ["sent", "not_now", "withdrawn"];

/** The open drafts (no closing step yet) among the given shelves, of one proposal kind. */
export async function openDrafts(db: Db | Tx, shelfIds: readonly string[], proposal: "topup" | "slow"): Promise<DraftRow[]> {
  if (shelfIds.length === 0) return [];
  const rows = await ex(db).select().from(storesPlannerDrafts)
    .where(and(inArray(storesPlannerDrafts.storeId, [...shelfIds]), eq(storesPlannerDrafts.proposal, proposal), eq(storesPlannerDrafts.kind, "open")));
  if (rows.length === 0) return [];
  const closed = new Set((await ex(db).select({ d: storesPlannerDrafts.draftId }).from(storesPlannerDrafts)
    .where(and(inArray(storesPlannerDrafts.draftId, rows.map((r) => r.draftId)), inArray(storesPlannerDrafts.kind, CLOSING)))).map((r) => r.d));
  return rows.filter((r) => !closed.has(r.draftId)).sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The lines still on a draft: every `line` with no `line_withdrawn` after it, in the order they joined. */
export async function activeLines(db: Db | Tx, draftIds: readonly string[]): Promise<DraftRow[]> {
  if (draftIds.length === 0) return [];
  const rows = await ex(db).select().from(storesPlannerDrafts).where(inArray(storesPlannerDrafts.draftId, [...draftIds]))
    .orderBy(asc(storesPlannerDrafts.at), asc(storesPlannerDrafts.id));
  const gone = new Set(rows.filter((r) => r.kind === "line_withdrawn").map((r) => `${r.draftId}|${r.itemId ?? ""}`));
  return rows.filter((r) => r.kind === "line" && !gone.has(`${r.draftId}|${r.itemId ?? ""}`));
}

export async function shelvesOfDepartment(db: Db | Tx, departmentId: string): Promise<string[]> {
  const rows = (await ex(db).execute(sql`select id from resources where kind = 'store' and attributes->>'domain' = 'stores'
    and attributes->>'kind' = 'shelf' and attributes->>'departmentId' = ${departmentId} and status <> 'retired'`)).rows as { id: string }[];
  return rows.map((r) => r.id);
}

/** The department's open planner proposals: its top-up (one, however many shelves), its slow-stock, each open par set. */
export async function openProposalKeys(db: Db | Tx, departmentId: string): Promise<string[]> {
  const shelves = await shelvesOfDepartment(db, departmentId);
  const keys: string[] = [];
  const topup = await openDrafts(db, shelves, "topup");
  if (topup.length > 0) keys.push("topup");
  const slow = await openDrafts(db, shelves, "slow");
  if (slow.length > 0) keys.push(`slow:${slow[0]!.draftId}`);
  const sets = (await ex(db).execute(sql`select distinct s.quarter from stores_par_suggestions s
    where s.department_id = ${departmentId} and s.kind = 'suggested'
      and not exists (select 1 from stores_par_suggestions c where c.suggestion_id = s.id and c.kind in ('accepted', 'kept'))
    order by 1`)).rows as { quarter: string }[];
  for (const s of sets) keys.push(`par:${s.quarter}`);
  return keys;
}

async function plannerManagers(db: Db | Tx): Promise<string[]> {
  const of = async (permission: string): Promise<string[]> => (await ex(db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey)).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(rolePermissions.permission, permission), eq(users.active, true), eq(roleAssignments.scopeType, "hospital")))).map((r) => r.userId).sort();
  const own = await of(STORES_PLANNER_MANAGE);
  return own.length > 0 ? own : of(STORES_MASTERS);
}

/** "Planner paused: 3 open" to the materials head, once per set of proposals that blocked it. */
async function haltNotice(tx: Tx, departmentId: string, departmentCode: string, keys: readonly string[], now: Date): Promise<void> {
  const hash = createHash("sha1").update([...keys].sort().join("|")).digest("hex").slice(0, 16);
  const [en, hi] = PLANNER_HALT_WORDS(keys.length);
  for (const userId of await plannerManagers(tx)) {
    await raiseNotice(tx as unknown as Db, {
      userId, kind: "stores.planner", title: en, body: `${hi} · ${departmentCode}`, refType: "stores_planner", refId: departmentId,
      sourceKey: `stores-planner-halt:${departmentId}:${hash}`, at: now,
    });
  }
}

/**
 * May the planner open a NEW proposal of `key` for the department? Not when it is paused, and not when three are open
 * (then the materials head is told). Returns false when it may not.
 */
export async function mayOpenProposal(tx: Tx, departmentId: string, departmentCode: string, key: "topup" | "slow" | `par:${string}`, now: Date): Promise<boolean> {
  const keys = await openProposalKeys(tx, departmentId);
  if (keys.some((k) => k === key || (key === "slow" && k.startsWith("slow:")))) return true;
  if (keys.length < PROPOSAL_CAP) return true;
  await haltNotice(tx, departmentId, departmentCode, keys, now);
  return false;
}

/**
 * Decision 6: a warned line joins the shelf's ONE open top-up draft (a draft is opened when there is none). A warning
 * is drafted once: a line the person sent or set aside is not drafted again until the item recovers and is warned anew.
 * Returns the draft id, or null when nothing was drafted (no par, nothing to add, paused, halted, or the limit).
 */
export async function draftLine(
  tx: Tx, shelf: ShelfCtx, item: { id: string; pack: number }, w: WarningRow, f: ForecastRow, par: StoresPar | null, now: Date,
): Promise<string | null> {
  if (par === null) return null;
  const qty = topUpQty(par, f.onHand, f.onWay, item.pack);
  if (qty <= 0) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-planner-draft:${shelf.id}`}))`);
  const [done] = await tx.select({ id: storesPlannerDrafts.id }).from(storesPlannerDrafts)
    .where(and(eq(storesPlannerDrafts.warningId, w.id), eq(storesPlannerDrafts.kind, "line"))).limit(1);
  if (done !== undefined) return null;
  let [open] = await openDrafts(tx, [shelf.id], "topup");
  if (open !== undefined && (await activeLines(tx, [open.draftId])).some((l) => l.itemId === item.id)) return null;
  if (open === undefined) {
    if (!(await mayOpenProposal(tx, shelf.departmentId, shelf.departmentCode, "topup", now))) return null;
    const draftId = newId();
    open = {
      id: draftId, draftId, kind: "open", proposal: "topup", storeId: shelf.id, departmentId: shelf.departmentId, itemId: null, qty: null, warningId: null,
      forecastId: null, indentId: null, reason: null, data: null, by: PLANNER_AGENT.id, at: now,
    };
    await tx.insert(storesPlannerDrafts).values(open);
  }
  await tx.insert(storesPlannerDrafts).values({
    id: newId(), draftId: open.draftId, kind: "line", proposal: "topup", storeId: shelf.id, departmentId: shelf.departmentId, itemId: item.id, qty,
    warningId: w.id, forecastId: f.id, by: PLANNER_AGENT.id, at: now,
    data: { onHand: f.onHand, onWay: f.onWay, usePerDay: f.usePerDay, max: par.maxBase, pack: item.pack },
  });
  await recordAct(tx, PLANNER_AGENT, now, {
    act: "planner_draft", storeId: shelf.id, itemId: item.id, refId: open.draftId, after: { qty, warningId: w.id, forecastId: f.id },
    lines: [{ itemId: item.id, qty }],
  });
  return open.draftId;
}

/**
 * One shelf item against a forecast (the night's new one, or the stored one at a use or receipt): end a live warning
 * that recovered, or warn (and draft) one that crossed. Returns what it wrote.
 */
export async function judgeShelfItem(
  tx: Tx, shelf: ShelfCtx, item: { id: string; pack: number }, f: ForecastRow, par: StoresPar | null, source: "night" | "use" | "receipt", now: Date,
  opts: { drafts: boolean },
): Promise<{ warned: boolean; recovered: boolean; draftId: string | null }> {
  const live = await liveWarning(tx, shelf.id, item.id);
  const learning = f.weeks < HISTORY_WEEKS;
  if (live !== null) {
    if (recovered({ usePerDay: f.usePerDay, onHand: f.onHand, par })) {
      await writeRecovered(tx, shelf, item.id, f.onHand, f.onWay, source, now);
      return { warned: false, recovered: true, draftId: null };
    }
    // Still warned: a line the limit or a halt held back is drafted when it may be.
    const draftId = opts.drafts ? await draftLine(tx, shelf, item, live, f, par, now) : null;
    return { warned: false, recovered: false, draftId };
  }
  const v = verdictOf({ learning, usePerDay: f.usePerDay, onHand: f.onHand, onWay: f.onWay, par });
  if (!v.warn) return { warned: false, recovered: false, draftId: null };
  const w = await writeWarning(tx, shelf, item.id, v, f, source, now);
  const draftId = opts.drafts ? await draftLine(tx, shelf, item, w, f, par, now) : null;
  return { warned: true, recovered: false, draftId };
}

/**
 * DECISION 5, THE DAY'S CHECK — in the transaction of a shelf "Used" or receipt, for that one item, against its stored
 * forecast (a learning item, or one never forecast, is judged by its par alone). Writes a forecast row only when it acts
 * (a warning, its end or a draft line), copying the stored use per day with today's on hand and on its way, so every
 * number a warning or draft shows is a stored row's.
 */
export async function recheckShelfItem(
  tx: Tx, shelf: ShelfCtx, it: { id: string; trackMode: string }, source: "use" | "receipt", now: Date,
): Promise<void> {
  if (it.trackMode !== "shelf") return;
  const item = { id: it.id, pack: (await issuePacks(tx, [it.id])).get(it.id)?.multiplier ?? 1 };
  const settings = await plannerSettingsOf(tx, shelf.departmentId);
  if (settings.paused) return;
  const stored = await latestForecast(tx, shelf.id, item.id);
  const par = (await parsAt(tx, shelf.id)).get(item.id) ?? null;
  const onHand = (await onHandAt(tx, shelf.id, [item.id])).get(item.id) ?? 0;
  const onWay = (await onWayAt(tx, shelf.id)).get(item.id) ?? 0;
  const weeks = stored?.weeks ?? weeksOfHistory((await historyAt(tx, shelf.id, now, "shelf", [item.id])).get(item.id)?.firstAt ?? null, now);
  const usePerDay = stored?.usePerDay ?? 0;
  const learning = weeks < HISTORY_WEEKS;
  const live = await liveWarning(tx, shelf.id, item.id);
  const acts = live !== null
    ? recovered({ usePerDay, onHand, par })
    : verdictOf({ learning, usePerDay, onHand, onWay, par }).warn;
  if (!acts) return;
  const v = verdictOf({ learning, usePerDay, onHand, onWay, par });
  const f = await insertForecast(tx, {
    storeId: shelf.id, itemId: item.id, departmentId: shelf.departmentId, scope: "shelf", method: stored?.method ?? "learning", weeks, usePerDay, onHand, onWay,
    minBase: par?.minBase ?? null, reorderBase: par?.reorderBase ?? null, maxBase: par?.maxBase ?? null, hoursToZero: v.hoursToZero,
    inputs: { ...((stored?.inputs as Record<string, unknown> | undefined) ?? { window: null, weekly: [], method: "learning", error: null, factor: null }), recheckOf: stored?.id ?? null, source },
    at: now,
  });
  await judgeShelfItem(tx, shelf, item, f, par, source, now, { drafts: !(await draftsHalted(tx, now)) });
}

/** The par suggestions still open for a department's quarter — used by the night's limit check. */
export async function openParSuggestionIds(db: Db | Tx, storeIds: readonly string[]): Promise<string[]> {
  if (storeIds.length === 0) return [];
  const rows = await ex(db).select({ id: storesParSuggestions.id, kind: storesParSuggestions.kind, sid: storesParSuggestions.suggestionId })
    .from(storesParSuggestions).where(inArray(storesParSuggestions.storeId, [...storeIds]));
  const closed = new Set(rows.filter((r) => r.kind !== "suggested").map((r) => r.sid));
  return rows.filter((r) => r.kind === "suggested" && !closed.has(r.id)).map((r) => r.id);
}
