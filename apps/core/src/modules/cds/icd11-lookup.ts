import { and, eq, sql } from "drizzle-orm";
import { anyOfText } from "../../kernel/db/any-of";
import { icd11MapRows } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE ICD-11 CODE BESIDE AN ICD-10 ONE — LOOKED UP AT READ TIME, NEVER STORED ON A DIAGNOSIS ═══
 *
 * A diagnosis is coded in ICD-10 and stays so: `icd10Code` is what the doctor picked and what the
 * record, the print and a claim carry. This read answers one question for a screen — "what does
 * WHO's one-to-one table say ICD-11 calls this code?" — from the LATEST loaded release, so loading a
 * new release changes what the screen shows and never what any record says.
 *
 * ═══ NULL IS THE ORDINARY ANSWER ═══
 *
 * Null when nothing is loaded (the state this ships in — no WHO data is loaded by any migration,
 * seed or deploy), when the code is absent from WHO's table, when WHO says `No Mapping`, and when
 * the target is a block: a block bears no ICD-11 code, and a pill reading "ICD-11" with nothing
 * after it would say less than showing nothing.
 *
 * ═══ AN EXACT MATCH ONLY — NO PARENT, NO PREFIX ═══
 *
 * The catalogue the doctor picks from is ICD-10-CM; WHO's table is keyed on WHO's ICD-10. A CM code
 * WHO does not have (`J45.909`) answers null here rather than borrowing its parent's ICD-11 code:
 * walking up the hierarchy would be THIS hospital producing a crosswalk WHO did not publish, which
 * is precisely what §1.2.4 reserves.
 *
 * ═══ WHAT IS RETURNED IS WHO'S, EXCEPT `release` ═══
 *
 * `code`, `title` and `uri` are WHO's cells verbatim — all three, because §1.2.3 wants the code,
 * the title and the URI wherever the classification is transmitted. `uri` is the LINEARIZATION
 * (release) URI, the identifier of the MMS entity the code names at that release. `release` is the
 * label the operator gave the load (§1.2.5: not WHO's), and it is why a reader can tell which
 * release a code came from.
 */
export type Icd11Ref = { code: string; title: string; uri: string; release: string };

/** The code as the lookup compares it. WHO writes codes upper-case and dotted, as the catalogue does. */
const keyOf = (code: string | null | undefined): string | null => {
  const k = (code ?? "").trim().toUpperCase();
  return k === "" ? null : k;
};

export async function icd11ForCodes(db: Db | Tx, codes: readonly (string | null | undefined)[]): Promise<Map<string, Icd11Ref>> {
  const wanted = [...new Set(codes.map(keyOf).filter((c): c is string => c !== null))];
  const out = new Map<string, Icd11Ref>();
  if (wanted.length === 0) return out;
  /*
    THE LATEST RELEASE, AS ONE SCALAR SUBQUERY. `release` is `YYYY-MM` (a check constraint holds it
    to that), so the greatest string is the newest release — whatever order they were loaded in.
    An empty loads table makes the subquery null and the whole read answers nothing.
  */
  const rows = await db
    .select({
      icd10Code: icd11MapRows.icd10Code, code: icd11MapRows.icd11Code, title: icd11MapRows.icd11Title,
      uri: icd11MapRows.icd11ReleaseUri, release: icd11MapRows.release,
    })
    .from(icd11MapRows)
    .where(and(
      eq(icd11MapRows.release, sql`(select max(l.release) from icd11_map_loads l)`),
      eq(icd11MapRows.mapKind, "mapped"),
      anyOfText(icd11MapRows.icd10Code, wanted),
    ));
  for (const r of rows) out.set(r.icd10Code, { code: r.code, title: r.title, uri: r.uri, release: r.release });
  return out;
}

/** Each item with `icd11` beside it — WHO's answer for its ICD-10 code, or null. One query for the lot. */
export async function withIcd11<T>(
  db: Db | Tx, items: readonly T[], codeOf: (item: T) => string | null | undefined,
): Promise<(T & { icd11: Icd11Ref | null })[]> {
  const map = await icd11ForCodes(db, items.map(codeOf));
  return items.map((item) => {
    const k = keyOf(codeOf(item));
    return { ...item, icd11: k === null ? null : map.get(k) ?? null };
  });
}
