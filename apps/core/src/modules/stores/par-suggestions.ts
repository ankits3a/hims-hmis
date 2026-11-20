import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { argsHash } from "../../kernel/copilot/act";
import { withTx } from "../../kernel/db/client";
import { copilotActs, items, resources, storesParSuggestions } from "../../kernel/db/schema";
import { writeStockLevel } from "../materials";
import { recordAct, requireMasters } from "./access";
import { StoresError } from "./errors";
import { listShelves } from "./shelves";
import { PLANNER_AGENT, SHELF_NET_USE, mayOpenProposal, parsAt } from "./planner-core";
import { DEFAULT_SUPPLY_INTERVAL_DAYS, median, quarterOfDay, round1, suggestedPar } from "./planner-math";
import type { Actor, StoresPar, WireParSuggestion } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S7 (#1117, flow 5, decision 8) — PAR SUGGESTIONS, QUARTERLY; ONLY A PERSON CHANGES A PAR.
 *
 * Once per IST calendar quarter, for each shelf item with 90 days of history and some use: min = use per day × 1 day,
 * reorder = use per day × (supply interval + 1 day), max = reorder + use per day × supply interval, where the supply
 * interval is the median days between the shelf's deliveries over the last 180 days (DECIDED; 7 days with fewer than two)
 * and use per day is the last 90 days' net use ÷ 90. A suggestion equal to today's par is not written. The quarter's
 * suggestions for a department are ONE proposal (the planner's limit, decision 12).
 *
 * Accept (`stores.masters.manage`, the materials head) writes S1's par (`writeStockLevel`) and S1's `par` act with before
 * and after, an `accepted` row keeping the suggestion beside what was written (an edit keeps both), and a `copilot_acts`
 * row naming the person. Keep writes a `kept` row. Each suggestion closes once (partial unique index).
 */
const DAY_MS = 86_400_000;
export const PAR_USE_DAYS = 90;
const SUPPLY_LOOKBACK_DAYS = 180;

/** Write this quarter's suggestions (once per shelf item and quarter). Returns how many were written. */
export async function suggestPars(db: Db, now: Date = new Date()): Promise<number> {
  const quarter = quarterOfDay(istDayString(now));
  const since = new Date(now.getTime() - PAR_USE_DAYS * DAY_MS);
  let written = 0;
  for (const shelf of await listShelves(db)) {
    if (shelf.departmentId === null) continue;
    const departmentId = shelf.departmentId;
    const rows = (await db.execute(sql`select sl.item_id, min(sl.occurred_at) as first,
        coalesce(sum(case when sl.occurred_at >= ${since.toISOString()}::timestamptz and sl.occurred_at < ${now.toISOString()}::timestamptz then ${SHELF_NET_USE} else 0 end), 0)::int as used
      from stock_ledger sl join items i on i.id = sl.item_id and i.track_mode = 'shelf'
      where sl.resource_id = ${shelf.id} group by sl.item_id`)).rows as { item_id: string; first: string | Date; used: number }[];
    const eligible = rows.filter((r) => new Date(r.first).getTime() <= since.getTime() && Number(r.used) > 0);
    if (eligible.length === 0) continue;
    const done = new Set((await db.select({ itemId: storesParSuggestions.itemId }).from(storesParSuggestions).where(and(
      eq(storesParSuggestions.storeId, shelf.id), eq(storesParSuggestions.quarter, quarter), eq(storesParSuggestions.kind, "suggested"),
    ))).map((r) => r.itemId));
    const days = ((await db.execute(sql`select distinct (sl.occurred_at at time zone 'Asia/Kolkata')::date as d from stock_ledger sl
      where sl.resource_id = ${shelf.id} and sl.reason = 'receive' and sl.qty_delta > 0
        and sl.occurred_at >= ${new Date(now.getTime() - SUPPLY_LOOKBACK_DAYS * DAY_MS).toISOString()}::timestamptz order by 1`)).rows as { d: string }[])
      .map((r) => new Date(String(r.d).slice(0, 10)).getTime());
    const gaps = days.slice(1).map((d, i) => Math.round((d - days[i]!) / DAY_MS));
    const interval = median(gaps) ?? DEFAULT_SUPPLY_INTERVAL_DAYS;
    const pars = await parsAt(db, shelf.id);
    const todo: { itemId: string; used: number; s: StoresPar; old: StoresPar | null; upd: number }[] = [];
    for (const r of eligible) {
      if (done.has(r.item_id)) continue;
      const upd = Number(r.used) / PAR_USE_DAYS;
      const s = suggestedPar(upd, interval);
      const old = pars.get(r.item_id) ?? null;
      if (old !== null && old.minBase === s.minBase && old.reorderBase === s.reorderBase && old.maxBase === s.maxBase) continue;
      todo.push({ itemId: r.item_id, used: Number(r.used), s, old, upd });
    }
    if (todo.length === 0) continue;
    written += await withTx(db, async (tx) => {
      if (!(await mayOpenProposal(tx, departmentId, shelf.departmentCode ?? "", `par:${quarter}`, now))) return 0;
      await tx.insert(storesParSuggestions).values(todo.map((t) => ({
        id: newId(), suggestionId: "", kind: "suggested", storeId: shelf.id, itemId: t.itemId, departmentId, quarter,
        oldMin: t.old?.minBase ?? null, oldReorder: t.old?.reorderBase ?? null, oldMax: t.old?.maxBase ?? null, ...t.s, usePerDay: t.upd,
        supplyIntervalDays: interval, by: PLANNER_AGENT.id, at: now,
        inputs: { window: { from: since.toISOString(), to: now.toISOString(), days: PAR_USE_DAYS }, used: t.used, deliveryDays: days.length, gaps },
      })).map((r) => ({ ...r, suggestionId: r.id })));
      return todo.length;
    });
  }
  return written;
}

type SuggestionRow = typeof storesParSuggestions.$inferSelect;

function whyOfPar(upd: number, interval: number): [string, string] {
  return [`uses ${String(round1(upd))} a day, delivered every ${String(round1(interval))} days`, `रोज़ ${String(round1(upd))}, हर ${String(round1(interval))} दिन में आता है`];
}

/** Flow 5: the open suggestions, shelf then item, old par beside the suggested. The materials head's. */
export async function parSuggestions(db: Db, actor: Actor, now: Date = new Date(), opts: { all?: boolean } = {}): Promise<WireParSuggestion[]> {
  await requireMasters(db, actor);
  const rows = (await db.select().from(storesParSuggestions)).filter((r) => r.at.getTime() <= now.getTime());
  const closed = new Map(rows.filter((r) => r.kind !== "suggested").map((r) => [r.suggestionId, r.kind as "accepted" | "kept"] as const));
  const open = rows.filter((r) => r.kind === "suggested" && (opts.all === true || !closed.has(r.id)));
  if (open.length === 0) return [];
  const names = new Map((await db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, [...new Set(open.map((r) => r.itemId))]))).map((i) => [i.id, i.name] as const));
  const shelves = new Map((await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, [...new Set(open.map((r) => r.storeId))]))).map((s) => [s.id, s.name] as const));
  return open.map((r) => ({
    id: r.id, shelfId: r.storeId, shelfName: shelves.get(r.storeId) ?? "", itemId: r.itemId, itemName: names.get(r.itemId) ?? "", quarter: r.quarter,
    now: r.oldMin === null || r.oldReorder === null || r.oldMax === null ? null : { minBase: r.oldMin, reorderBase: r.oldReorder, maxBase: r.oldMax },
    suggested: { minBase: r.minBase, reorderBase: r.reorderBase, maxBase: r.maxBase }, usePerDay: round1(r.usePerDay), supplyIntervalDays: r.supplyIntervalDays,
    why: whyOfPar(r.usePerDay, r.supplyIntervalDays), status: closed.get(r.id) ?? ("open" as const),
  })).sort((a, b) => a.shelfName.localeCompare(b.shelfName) || a.itemName.localeCompare(b.itemName));
}

async function lockOpen(tx: Tx, id: string): Promise<SuggestionRow> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-par-suggestion:${id}`}))`);
  const rows = await tx.select().from(storesParSuggestions).where(eq(storesParSuggestions.suggestionId, id));
  const s = rows.find((r) => r.kind === "suggested");
  if (s === undefined) throw new StoresError("unknown_suggestion", "no such par suggestion", { suggestionId: id });
  if (rows.some((r) => r.kind !== "suggested")) throw new StoresError("suggestion_closed", "this suggestion is already decided", { suggestionId: id });
  return s;
}

/** Accept (as suggested, or edited): S1's par is written with its `par` act; the suggestion keeps both numbers. */
export async function acceptParSuggestion(
  db: Db, actor: Actor, suggestionId: string, edit: StoresPar | null, now: Date = new Date(),
): Promise<{ par: StoresPar; actId: string }> {
  await requireMasters(db, actor);
  return withTx(db, async (tx) => {
    const s = await lockOpen(tx, suggestionId);
    const levels = edit ?? { minBase: s.minBase, reorderBase: s.reorderBase, maxBase: s.maxBase };
    const { previous } = await writeStockLevel(tx, actor, { itemId: s.itemId, storeResourceId: s.storeId, ...levels }, now);
    await recordAct(tx, actor, now, { act: "par", storeId: s.storeId, itemId: s.itemId, before: previous, after: levels });
    const confirmId = `pa_${s.id}`;
    const actId = newId();
    await tx.insert(copilotActs).values({
      id: actId, at: now, actorId: actor.id, tool: "stores.planner_par_accept", subjectPatientId: null, argsHash: argsHash({ suggestionId, levels }),
      proposalId: s.id, confirmId, resultModule: "stores", resultRowId: s.id,
    });
    await tx.insert(storesParSuggestions).values({
      ...s, id: newId(), kind: "accepted", ...levels, confirmId, by: actor.id, at: now,
      inputs: { ...(s.inputs as Record<string, unknown>), suggested: { minBase: s.minBase, reorderBase: s.reorderBase, maxBase: s.maxBase }, edited: edit !== null },
    });
    await recordAct(tx, actor, now, {
      act: "planner_par_accept", storeId: s.storeId, itemId: s.itemId, refId: s.id,
      before: previous, after: { written: levels, suggested: { minBase: s.minBase, reorderBase: s.reorderBase, maxBase: s.maxBase }, confirmId, actId },
    });
    return { par: levels, actId };
  });
}

/** Keep / जैसा है: the par stays; the suggestion closes. */
export async function keepParSuggestion(db: Db, actor: Actor, suggestionId: string, now: Date = new Date()): Promise<{ actId: string }> {
  await requireMasters(db, actor);
  return withTx(db, async (tx) => {
    const s = await lockOpen(tx, suggestionId);
    const confirmId = `pk_${s.id}`;
    const actId = newId();
    await tx.insert(copilotActs).values({
      id: actId, at: now, actorId: actor.id, tool: "stores.planner_par_keep", subjectPatientId: null, argsHash: argsHash({ suggestionId }),
      proposalId: s.id, confirmId, resultModule: "stores", resultRowId: s.id,
    });
    await tx.insert(storesParSuggestions).values({ ...s, id: newId(), kind: "kept", confirmId, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "planner_par_keep", storeId: s.storeId, itemId: s.itemId, refId: s.id, after: { confirmId, actId } });
    return { actId };
  });
}

