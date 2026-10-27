import { sql } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";

/** LD-1 (#978) — the laundry's theatre-set demand: how many cases are on the day's lists (IST date), every theatre. */
export async function theatreCasesOn(exec: Db | Tx, listDate: string): Promise<number> {
  const r = await exec.execute<{ n: string }>(sql`select count(*) as n from ot_cases where list_date = ${listDate}`);
  return Number(r.rows[0]?.n ?? 0);
}
