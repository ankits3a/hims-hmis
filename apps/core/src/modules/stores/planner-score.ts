import { sql } from "drizzle-orm";
import { HISTORY_WEEKS } from "./planner-math";
import type { WirePlannerMonthly, WirePlannerScore } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S7 (#1117, decisions 11, 13) — THE METRIC AND THE SCORE, read from rows only.
 *
 * `stockOutsWithoutWarning(from, to)`: every time a Stores shelf item reached 0 on the ledger in the window (a row that
 * took the running balance at that shelf from above 0 to 0), was there a planner warning for it at least 24 h before,
 * still live (no `recovered` row between it and the zero)? Those without are the count, on the tower (a red card each) and
 * in the monthly line. A spike too sharp to warn 24 h ahead is counted honestly (edge 1).
 *
 * `plannerScore`: of the top-up sections sent in the window, the share sent with every line at the planner's quantity,
 * and the stock-outs without warning at the department's shelves. It passes (the T3 gate, decision 11) after 4 weeks of
 * drafts with ≥ 95 % unchanged and no stock-out without warning. Shown, not enforced, except by the T3 switch.
 */
export const WARNING_LEAD_MS = 24 * 3_600_000;
/** The tower's red cards look back this far for stock-outs without warning. */
export const NO_WARNING_WINDOW_MS = 7 * 86_400_000;
export const T3_UNCHANGED_PCT = 95;
export const T3_WEEKS = 4;

const ex = (db: Db | Tx): Db => db as Db;

export type StockOutEvent = { storeId: string; itemId: string; departmentId: string | null; at: string };

export async function stockOutsWithoutWarning(db: Db | Tx, from: Date, to: Date): Promise<{ count: number; events: StockOutEvent[] }> {
  const rows = (await ex(db).execute(sql`
    with places as (
      select r.id, r.attributes->>'departmentId' as dept from resources r
      where r.kind = 'store' and r.attributes->>'domain' = 'stores' and r.attributes->>'kind' = 'shelf'
    ), moves as (
      select sl.resource_id, sl.item_id, sl.occurred_at, sl.seq, sl.qty_delta,
        sum(sl.qty_delta) over (partition by sl.resource_id, sl.item_id order by sl.occurred_at, sl.seq rows unbounded preceding) as bal
      from stock_ledger sl join places p on p.id = sl.resource_id join items i on i.id = sl.item_id and i.track_mode = 'shelf'
      where sl.occurred_at <= ${to.toISOString()}::timestamptz
    ), zeros as (
      select m.resource_id, m.item_id, m.occurred_at from moves m
      where m.bal = 0 and m.qty_delta < 0 and m.occurred_at >= ${from.toISOString()}::timestamptz and m.occurred_at <= ${to.toISOString()}::timestamptz
    )
    select z.resource_id as store_id, z.item_id, p.dept as department_id, z.occurred_at as at from zeros z join places p on p.id = z.resource_id
    where not exists (
      select 1 from stores_planner_warnings w
      where w.store_id = z.resource_id and w.item_id = z.item_id and w.kind = 'warn'
        and w.at <= z.occurred_at - ${`${String(WARNING_LEAD_MS / 1000)} seconds`}::interval
        and not exists (select 1 from stores_planner_warnings rcv where rcv.store_id = w.store_id and rcv.item_id = w.item_id
          and rcv.kind = 'recovered' and rcv.at > w.at and rcv.at <= z.occurred_at)
    )
    order by z.occurred_at, z.resource_id, z.item_id`)).rows as { store_id: string; item_id: string; department_id: string | null; at: string | Date }[];
  const events = rows.map((r) => ({ storeId: r.store_id, itemId: r.item_id, departmentId: r.department_id, at: new Date(r.at).toISOString() }));
  return { count: events.length, events };
}

type SentRow = { department_id: string; at: string | Date; data: { lines?: { plannerQty: number; qty: number }[] } | null };

async function sentBetween(db: Db | Tx, departmentId: string | null, from: Date, to: Date): Promise<SentRow[]> {
  return (await ex(db).execute(sql`select department_id, at, data from stores_planner_drafts
    where kind = 'sent' and proposal = 'topup' and at >= ${from.toISOString()}::timestamptz and at < ${to.toISOString()}::timestamptz
    ${departmentId === null ? sql`` : sql`and department_id = ${departmentId}`}`)).rows as SentRow[];
}

const unchanged = (r: SentRow): boolean => (r.data?.lines ?? []).every((l) => l.plannerQty === l.qty);
const pctOf = (n: number, d: number): number | null => (d === 0 ? null : Math.round((100 * n) / d));

export async function plannerScore(db: Db | Tx, departmentId: string, from: Date, to: Date): Promise<WirePlannerScore> {
  const sent = await sentBetween(db, departmentId, from, to);
  const same = sent.filter(unchanged).length;
  const outs = (await stockOutsWithoutWarning(db, from, to)).events.filter((e) => e.departmentId === departmentId).length;
  const [first] = (await ex(db).execute(sql`select min(at) as first from stores_planner_drafts where department_id = ${departmentId} and kind = 'open'
    and proposal = 'topup'`)).rows as { first: string | Date | null }[];
  const firstAt = first?.first == null ? null : new Date(first.first);
  const weeks = firstAt === null ? 0 : Math.min(HISTORY_WEEKS, Math.floor((to.getTime() - firstAt.getTime()) / (7 * 86_400_000)));
  const unchangedPct = pctOf(same, sent.length);
  return {
    departmentId, from: from.toISOString(), to: to.toISOString(), weeks, sent: sent.length, sentUnchanged: same, unchangedPct,
    stockOutsWithoutWarning: outs,
    passes: weeks >= T3_WEEKS && sent.length > 0 && (unchangedPct ?? 0) >= T3_UNCHANGED_PCT && outs === 0,
  };
}

/** The owner's monthly line (`YYYY-MM`, IST): "Stock-outs without warning: 0 · Drafts unchanged: 93%". */
export async function plannerMonthly(db: Db | Tx, month: string): Promise<WirePlannerMonthly> {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${String(y + 1)}-01` : `${String(y)}-${String(m + 1).padStart(2, "0")}`;
  const from = new Date(`${month}-01T00:00:00+05:30`);
  const to = new Date(`${next}-01T00:00:00+05:30`);
  const sent = await sentBetween(db, null, from, to);
  return {
    month, stockOutsWithoutWarning: (await stockOutsWithoutWarning(db, from, new Date(to.getTime() - 1))).count,
    unchangedPct: pctOf(sent.filter(unchanged).length, sent.length),
  };
}
