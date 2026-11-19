import { and, eq, sql } from "drizzle-orm";
import { resources, stockBatches, stockLedger } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S3 (#1113, decision 5) — THE MONTH'S SPEND RULE, moved out of `tower.ts` by S5a (#1115) unchanged, so the
 * department budgets (`budgets.ts`, read by the ticket's approval) can use it without importing the tower.
 */
const IST = "Asia/Kolkata";

/** `YYYY-MM` → the first day of the next month, `YYYY-MM-01`. */
export function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${String(y + 1)}-01-01` : `${String(y)}-${String(m + 1).padStart(2, "0")}-01`;
}

/**
 * A department's charge this IST month, at cost: Σ quantity × batch cost over the receive rows that carry its cost
 * centre — receipts INTO its shelves count +, a store's receipt of its return counts − (`departmentChargeOn`'s rule,
 * by month). `consume` rows carry the same cost centre and are never read: the charge is at receipt.
 */
export async function departmentSpendByMonth(db: Db | Tx, month: string): Promise<Map<string, number>> {
  const next = nextMonthStart(month).slice(0, 7);
  const localAt = sql`(${stockLedger.occurredAt} at time zone ${IST})`;
  const rows = await (db as Db).select({
    code: stockLedger.costCenter,
    paise: sql<string>`coalesce(sum(case when ${resources.attributes}->>'kind' = 'shelf' then 1 else -1 end * ${stockLedger.qtyDelta}::bigint * ${stockBatches.landedCostPaise}), 0)`,
  }).from(stockLedger).innerJoin(stockBatches, eq(stockBatches.id, stockLedger.batchId)).innerJoin(resources, eq(resources.id, stockLedger.resourceId))
    .where(and(
      sql`${stockLedger.costCenter} is not null`, eq(stockLedger.reason, "receive"), sql`${stockLedger.qtyDelta} > 0`,
      sql`${localAt} >= ${`${month}-01`}::timestamp`, sql`${localAt} < ${`${next}-01`}::timestamp`,
      // S4 (#1114, decision 19): equipment is not monthly spend. A tagged unit's batch is "Equipment received", apart.
      sql`not exists (select 1 from stores_asset_units u where u.batch_id = ${stockLedger.batchId})`,
    )).groupBy(stockLedger.costCenter);
  return new Map(rows.map((r) => [r.code!, Number(r.paise)] as const));
}

