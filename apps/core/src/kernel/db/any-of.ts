import { sql } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";

/**
 * ═══ `col = any($1::text[])` — ONE BIND PARAMETER, WHERE `inArray` EMITS ONE PER VALUE ═══
 *
 * drizzle's `inArray(col, values)` renders `col in ($1, $2, … $N)`. The Postgres wire Bind message
 * counts its parameters in an **Int16**, so past 65,535 values the count wraps and the server
 * refuses the message. A caller-sized `inArray` therefore does not get SLOW as its list grows — it
 * STOPS WORKING, with a protocol error, at a threshold no test seeded below it can see.
 *
 * MEASURED read-only against `hmis_cds_dev` (103,383 medicines), issuing the exact statement shape
 * drizzle emits:
 *
 *     n =  65,535  ->  OK
 *     n =  65,536  ->  08P01  bind message supplies 0 parameters, but prepared statement ""
 *                            requires 65536
 *     n = 103,383  ->  08P01  bind message has 37847 parameter formats but 0 parameters
 *                            (103,383 mod 65,536 = 37,847 — the wrap, arithmetically)
 *
 * And this helper, measured the same way on the same rows: 103,383 ids, **1 bind parameter,
 * 153 ms, no error**. The array crosses the wire as one text[] value.
 *
 * ═══ WHEN TO REACH FOR IT ═══
 *
 * USE IT whenever the list comes from a CALLER — request bodies, a dispense's lines, an importer's
 * batch, anything whose length is data rather than a literal. A fixed two-element or constant
 * array may stay `inArray`; nothing is gained by churning those, and `inArray` reads better.
 *
 * The idiom is already the house precedent for exactly this reason — `kernel/events/dispatcher.ts`,
 * `kernel/realtime/tail.ts`, `modules/partners/replay.ts` all spell it by hand. This file exists so
 * the MEASUREMENT above has one home, because the next author to write `inArray` over a caller's
 * list will not rediscover it.
 *
 * DO NOT copy `modules/opd/complaints.ts`, which builds `array[$1, $2, …]::text[]` by joining one
 * placeholder per element. That is the same defect wearing the fix's syntax: it is back to one bind
 * parameter per value and wraps at the same 65,536.
 *
 * ═══ SEMANTICS ═══
 *
 * Identical to `inArray` for a non-empty array. For an EMPTY one both are false — `= any('{}')`
 * matches nothing, as `in ()` does — so neither is a silent "match everything". Every call site in
 * this repo early-returns on an empty list regardless, because a query it already knows the answer
 * to is a round trip nobody needs.
 */
export function anyOfText(column: Column, values: readonly string[]): SQL {
  return sql`${column} = any(${sql.param([...values])}::text[])`;
}
