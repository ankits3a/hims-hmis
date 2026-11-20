import { sql } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { onOrderAt } from "../materials";
import { listStoresStores } from "./shelves";
import { openCentralAsks } from "./buyer-agent";
import { StoresError } from "./errors";
import { PLANNER_AGENT, historyAt, insertForecast, onHandAt, plannerSettingsOf } from "./planner-core";
import { DEFAULT_LEAD_DAYS, HISTORY_WEEKS, centralOrderQty, coverDaysOf, median, safetyDaysOf, weeksOfHistory, weightedUsePerDay } from "./planner-math";
import { raisePurchaseRequest } from "./purchase-requests";
import { unitCosts } from "./planner";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S7 (#1117, flow 4, decision 7; ruling 0101 Q8) — THE CENTRAL STORE'S SHORTFALLS AS `planner` PURCHASE REQUESTS.
 *
 * For each central Stores store and each Stores item with 8 weeks of history there: use per day = what left the store
 * (issues, net of reversals), weighted 2 : 1 as at the shelves; reorder point = use × (lead time + safety days); order up
 * to = reorder point + use × cover days, less on hand, on order (open POs and drafts) and what open central or planner
 * requests already ask; rounded up to the purchase pack; a dated consumable never beyond the use before expiry − 30 days.
 * Lead time = the item's `lead_time_days`, else the median of its last 3 PO-to-GRN days, else 7 (DECIDED). One `planner`
 * request per category per night, raised by the planner actor; the materials head approves it as any central request and
 * S5's buyer groups it. A learning item (under 8 weeks here) is left to the buyer's par rule (`raiseCentralShortfall`),
 * which subtracts the planner's open requests, as this subtracts the buyer's: neither asks twice.
 */
const DAY_MS = 86_400_000;

const ex = (db: Db | Tx): Db => db as Db;

async function leadDaysOf(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0) return out;
  const rows = (await ex(db).execute(sql`select l.item_id, extract(epoch from (g.posted_at - coalesce(p.approved_at, p.created_at))) / 86400 as days
    from grns g join purchase_orders p on p.id = g.purchase_order_id join grn_lines l on l.grn_id = g.id
    where g.status = 'posted' and g.posted_at is not null and l.item_id in (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)})
    order by g.posted_at desc`)).rows as { item_id: string; days: number }[];
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const xs = by.get(r.item_id) ?? [];
    if (xs.length < 3) xs.push(Math.max(1, Math.round(Number(r.days))));
    by.set(r.item_id, xs);
  }
  for (const [id, xs] of by) out.set(id, median(xs) ?? DEFAULT_LEAD_DAYS);
  return out;
}

async function packsOf(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = (await ex(db).execute(sql`select item_id, max(to_base_multiplier)::int as m from item_uoms
    where is_purchase_uom and item_id in (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)}) group by item_id`)).rows as { item_id: string; m: number }[];
  return new Map(rows.map((r) => [r.item_id, Number(r.m)] as const));
}

/** Shelf life of a new batch: the item's `shelf_life_days`, else its newest batch's expiry less the day it was made. */
async function lifeDaysOf(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = (await ex(db).execute(sql`select i.id, i.shelf_life_days,
      (select (b.expiry_date - (b.created_at at time zone 'Asia/Kolkata')::date) from stock_batches b where b.item_id = i.id and b.expiry_date is not null
        order by b.created_at desc limit 1) as batch_days
    from items i where i.id in (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)})`)).rows as { id: string; shelf_life_days: number | null; batch_days: number | null }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const d = r.shelf_life_days ?? r.batch_days;
    if (d !== null) out.set(r.id, Number(d));
  }
  return out;
}

export type CentralRun = { prIds: string[]; lines: number; noPrice: string[] };

export async function planCentral(db: Db, now: Date): Promise<CentralRun> {
  const run: CentralRun = { prIds: [], lines: 0, noPrice: [] };
  const settings = await plannerSettingsOf(db, null);
  for (const store of (await listStoresStores(db)).filter((s) => s.kind === "central")) {
    const hist = await historyAt(db, store.id, now, "store");
    const ids = [...hist.keys()];
    if (ids.length === 0) continue;
    const meta = new Map(((await db.execute(sql`select id, class, category_id, lead_time_days, abc_class, ved_class, track_mode from items
      where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).rows as {
      id: string; class: string; category_id: string | null; lead_time_days: number | null; abc_class: string | null; ved_class: string | null; track_mode: string | null;
    }[]).filter((r) => r.track_mode !== null && r.class !== "drug").map((r) => [r.id, r] as const));
    const wanted = ids.filter((i) => meta.has(i) && weeksOfHistory(hist.get(i)!.firstAt, now) >= HISTORY_WEEKS);
    if (wanted.length === 0) continue;
    const [have, coming, asked, leads, packs, lives, costs] = await Promise.all([
      onHandAt(db, store.id, wanted), onOrderAt(db, store.id, wanted), openCentralAsks(db, wanted), leadDaysOf(db, wanted), packsOf(db, wanted),
      lifeDaysOf(db, wanted), unitCosts(db, wanted),
    ]);
    const byCategory = new Map<string, { itemId: string; qtyBase: number; estimatePaise: number }[]>();
    await withTx(db, async (tx) => {
      for (const id of wanted) {
        const m = meta.get(id)!;
        const h = hist.get(id)!;
        const usePerDay = weightedUsePerDay(h.weekly);
        const onHand = have.get(id) ?? 0;
        const onOrder = (coming.get(id)?.onOrderBase ?? 0) + (coming.get(id)?.inDraftBase ?? 0) + (asked.get(id) ?? 0);
        const leadDays = m.lead_time_days ?? leads.get(id) ?? DEFAULT_LEAD_DAYS;
        const safetyDays = safetyDaysOf(m.ved_class, settings.safetyDays);
        const coverDays = coverDaysOf(m.abc_class, settings.coverDays);
        const lifeDays = m.class === "consumable_dated" ? (lives.get(id) ?? null) : null;
        const calc = centralOrderQty({ usePerDay, leadDays, safetyDays, coverDays, position: onHand + onOrder, pack: packs.get(id) ?? 1, lifeDays });
        if (calc.qty <= 0 && onHand + onOrder > calc.reorderPoint) continue;
        await insertForecast(tx, {
          storeId: store.id, itemId: id, departmentId: null, scope: "central", method: "plain", weeks: HISTORY_WEEKS, usePerDay, onHand, onWay: onOrder,
          minBase: null, reorderBase: Math.ceil(calc.reorderPoint), maxBase: Math.ceil(calc.orderUpTo), hoursToZero: usePerDay > 0 ? onHand / (usePerDay / 24) : null,
          inputs: {
            window: { from: new Date(now.getTime() - HISTORY_WEEKS * 7 * DAY_MS).toISOString(), to: now.toISOString() }, weekly: h.weekly, method: "plain",
            error: null, factor: null, leadDays, safetyDays, coverDays, lifeDays, reorderPoint: calc.reorderPoint, orderUpTo: calc.orderUpTo, cap: calc.cap, qty: calc.qty,
          },
          at: now,
        });
        if (calc.qty <= 0) continue;
        const key = m.category_id ?? "-";
        const list = byCategory.get(key) ?? [];
        list.push({ itemId: id, qtyBase: calc.qty, estimatePaise: Math.max(1, costs.get(id) ?? 0) });
        byCategory.set(key, list);
      }
    });
    for (const lines of byCategory.values()) {
      try {
        const pr = await raisePurchaseRequest(db, PLANNER_AGENT, { source: "planner", priority: "routine", note: "Planner shortfall", lines }, now, { agent: true });
        run.prIds.push(pr.id);
        run.lines += lines.length;
      } catch (e) {
        if (e instanceof StoresError && e.code === "estimate_required") { run.noPrice.push(String(e.detail?.itemId ?? "")); continue; }
        throw e;
      }
    }
  }
  return run;
}
