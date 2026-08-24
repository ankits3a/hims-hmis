import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * PLAN 11h T3 — ONE COPY OF "USER TEXT IS LITERAL", for every provider.
 *
 * `%` and `_` are LIKE metacharacters; unescaped, a user typing `%` matches the entire table, and
 * that is a data-exfiltration primitive dressed as a typo. `patients/search.ts` has enforced this
 * since Plan 05 and its own private copy now lives here, because the second provider that needed
 * the rule is exactly where a duplicated rule starts drifting (§2.54).
 *
 * Postgres' default LIKE escape is the backslash, which must itself be escaped.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive PREFIX match on a text column.
 *
 * Prefix, not substring, and that is a performance contract rather than a preference: a prefix is
 * served by a `text_pattern_ops` btree index, and `%foo%` is a sequential scan of the table on
 * every keystroke of every desk in the hospital. T7's trigram index is what makes the substring
 * and misspelling cases affordable; until then a provider that reaches for `%foo%` is writing a
 * 300 ms budget it cannot pay.
 */
export function prefixMatch(column: AnyPgColumn, text: string): SQL {
  return sql`lower(${column}) like ${`${escapeLike(text.toLowerCase())}%`}`;
}

/**
 * PREFIX-OF-ANY-WORD match, for the SMALL master tables only.
 *
 * MEASURED, T3: every doctor is stored as "Dr Mehra", so a plain prefix match means a desk typing
 * `mehra` finds nobody — the one thing they will actually type. The same holds for "General
 * Medicine" searched as `medicine`. A palette that only matches the first word of a name is a
 * palette staff route around.
 *
 * The second pattern has a LEADING WILDCARD and therefore cannot use a btree index — it is a scan,
 * and it is affordable here precisely because it is restricted to bounded master data: doctors,
 * departments and the service catalogue are hundreds of rows at this hospital's target scale, not
 * millions. **Do not reach for this on `patients`.** That table is the one that grows without
 * bound, it keeps the strict-prefix contract, and T7's trigram index is what buys it fuzzy
 * matching at an affordable price.
 */
export function wordPrefixMatch(column: AnyPgColumn, text: string): SQL {
  const needle = escapeLike(text.toLowerCase());
  return sql`(lower(${column}) like ${`${needle}%`} or lower(${column}) like ${`% ${needle}%`})`;
}
