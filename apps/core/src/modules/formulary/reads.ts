import { and, asc, eq, gt, sql } from "drizzle-orm";
import { escapeLike } from "../../kernel/search/text";
import { anyOfText } from "../../kernel/db/any-of";
import { CursorError, decodeCursor, finishPage, pageLimit } from "../../kernel/db/page";
import { formularyInteractions, formularyMedicineSalts, formularyMedicines, formularySalts } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { Page, PageRequest } from "../../kernel/db/page";
import type { InteractionRow, MedicineWithSalts, SaltRow } from "./masters";

/**
 * ═══ THE ID-KEYED READS: ASK FOR WHAT YOU NEED, NOT FOR THE CATALOGUE ═══
 *
 * Every caller in this repo that reached for `listMedicines` wanted a HANDFUL of medicines — the
 * ones on a dispense, on a label, on a claim — and got the whole national catalogue because that
 * was the only question the module knew how to answer. `queue.ts` did it most plainly: it loaded
 * every row and then wrote `.filter((m) => medicineIds.includes(m.id))`, an O(catalogue × lines)
 * scan to keep two of them.
 *
 * At 103,383 rows that read does not merely waste a heap — it THROWS, because drizzle's `inArray`
 * emits one bind parameter per id and the wire protocol counts them in an Int16. See
 * `kernel/db/any-of.ts` for the measured reproduction; `catalogue-scale.test.ts` is the pin.
 *
 * ═══ THESE READERS REFUSE RATHER THAN TRUNCATE ═══
 *
 * Past `MAX_IDS` they throw. They never return a short map. A cap that silently drops a dispense
 * line's medicine turns `substitution_not_allowed` into `unresolved_medicine` and blanks a brand on
 * a printed label — a wrong answer delivered quietly, which is strictly worse than a refusal a
 * caller can see. A list longer than `MAX_IDS` arriving here is a BUG in the caller, and a bug
 * should arrive as a refusal.
 *
 * The asymmetry is deliberate and it is about blame: readers serving REQUEST handlers refuse,
 * because the oversized list is a defect; a reader serving an IMPORTER would chunk internally,
 * because refusing on row 501 of a legitimate item master is hostile to an operator who did
 * nothing wrong.
 */
export const MAX_IDS = 500;

function requireBounded(ids: readonly string[], what: string): string[] {
  const wanted = [...new Set(ids)].filter((id) => id !== "");
  if (wanted.length > MAX_IDS) {
    throw new FormularyError(
      "too_many_ids",
      `${what}: asked for ${String(wanted.length)} ids at once, and ${String(MAX_IDS)} is the limit`,
      { asked: wanted.length, limit: MAX_IDS },
    );
  }
  return wanted;
}

/**
 * The named medicines, each with its composition, keyed by id. An unknown id is simply absent.
 *
 * ═══ IT DOES NOT FILTER `active`, AND THE ABSENCE IS THE DECISION ═══
 *
 * All five pharmacy callers this replaces called `listMedicines(db)` with no `activeOnly`, and they
 * were right to. A medicine DEACTIVATED after the prescription was written must still be nameable:
 * on the label the patient carries away, and inside the refusal that explains why it cannot be
 * substituted. Filtering here would blank that brand and change a precise refusal into a vague one.
 *
 * Where "active" is the actual question — may this be OFFERED, may this be SUBSTITUTED — it is
 * asked in SQL at the place that decides, which is `equivalence.ts`.
 */
export async function medicinesByIds(db: Db | Tx, ids: readonly string[]): Promise<Map<string, MedicineWithSalts>> {
  const wanted = requireBounded(ids, "medicinesByIds");
  const out = new Map<string, MedicineWithSalts>();
  if (wanted.length === 0) return out;

  const medicines = await db.select().from(formularyMedicines)
    .where(anyOfText(formularyMedicines.id, wanted));
  if (medicines.length === 0) return out;

  const composition = await db.select().from(formularyMedicineSalts)
    .where(anyOfText(formularyMedicineSalts.medicineId, medicines.map((m) => m.id)));

  const byMedicine = new Map<string, { saltId: string; strength: string | null }[]>();
  for (const row of composition) {
    const list = byMedicine.get(row.medicineId) ?? [];
    list.push({ saltId: row.saltId, strength: row.strength });
    byMedicine.set(row.medicineId, list);
  }
  for (const m of medicines) out.set(m.id, { ...m, salts: byMedicine.get(m.id) ?? [] });
  return out;
}

/** The named moieties, keyed by id. Same bound, same refusal, same reason. */
export async function saltsByIds(db: Db | Tx, ids: readonly string[]): Promise<Map<string, SaltRow>> {
  const wanted = requireBounded(ids, "saltsByIds");
  const out = new Map<string, SaltRow>();
  if (wanted.length === 0) return out;
  const rows = await db.select().from(formularySalts).where(anyOfText(formularySalts.id, wanted));
  for (const row of rows) out.set(row.id, row);
  return out;
}

/**
 * Does this medicine id name a row? One indexed probe, no row crossing the wire.
 *
 * It exists so `modules/materials` can validate `items.formulary_medicine_id` without importing
 * `kernel/db/schema/formulary` — the module boundary the formulary's own `index.ts` states, and
 * which a direct table read goes round.
 */
export async function medicineExists(db: Db | Tx, id: string): Promise<boolean> {
  if (id === "") return false;
  const rows = await db.select({ id: formularyMedicines.id }).from(formularyMedicines)
    .where(eq(formularyMedicines.id, id)).limit(1);
  return rows.length > 0;
}

// ─────────────────────────────── the paged reads ───────────────────────────────

/**
 * A cursor naming a row that has since been DELETED must refuse, not answer an empty page.
 *
 * The tuple predicate compares against a subquery; when the cursor row is gone that subquery yields
 * no row, the comparison is NULL, and the page comes back EMPTY. A client reading an empty page as
 * "the end" would stop silently in the middle of the list and report the catalogue as shorter than
 * it is. Same argument as `decodeCursor`'s refusal: an honest 400 terminates, a plausible answer
 * does not.
 */
async function requireCursorRow(db: Db, table: string, id: string): Promise<void> {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where id = ${id}`,
  );
  if (Number(r.rows[0]?.n ?? 0) === 0) {
    throw new CursorError("that cursor points at a row that is no longer there — start the list again");
  }
}

/**
 * ═══ THESE REPLACED `listMedicines` / `listSalts` / `listInteractions`, WHICH WERE DELETED ═══
 *
 * Not capped — DELETED. A capped `listMedicines(db, { limit })` leaves "give me the catalogue"
 * spellable, and the next caller spells it and gets a silently short answer, which on these tables
 * is worse than the crash it replaced: `import-item-master.ts` would emit `unknown_medicine_brand`
 * for every drug past the cap and produce a wrong item-master bridge nobody could see.
 *
 * So the question is gone from the interface and each reader's NAME carries its bound. Paging obeys
 * the four laws in `kernel/db/page.ts`; every one of these fetches `limit + 1` and lets `finishPage`
 * decide whether there is more.
 */

/**
 * A page of medicines with their composition, ordered by brand name.
 *
 * THE ORDER OF THE TWO STATEMENTS IS THE WHOLE FIX. `listMedicines` read every medicine row and
 * THEN asked for the composition of all of them, which is the `inArray` over 103,383 ids that
 * throws. This reads at most `limit + 1` medicine rows first, and asks for the composition of
 * exactly those.
 *
 * `activeOnly` filters in SQL, not in JS. The old function filtered after the read, which is why
 * it transferred every inactive row to answer "the active ones" — and after a LIMIT, filtering in
 * JS would return fewer rows than asked for and report a full page as a short one.
 */
export async function pageMedicines(
  db: Db, opts: { activeOnly?: boolean } & PageRequest = {},
): Promise<Page<MedicineWithSalts>> {
  const limit = pageLimit(opts.limit);
  const afterId = decodeCursor(opts.cursor);
  /**
   * THE SORT EXPRESSION IS EVALUATED BY ONE ENGINE. The cursor names a ROW; the predicate reads that
   * row's own `(lower(brand_name), id)` back in SQL and compares tuples. Nothing lowercases anything
   * in TypeScript, so Postgres `lower()` and JS `toLowerCase()` cannot disagree — which they do, on
   * `İ` among others (LAW 1).
   */
  const where = [
    ...(opts.activeOnly === true ? [eq(formularyMedicines.active, true)] : []),
    ...(afterId === null ? [] : [sql`(lower(${formularyMedicines.brandName}), ${formularyMedicines.id}) > (
      select lower(c.brand_name), c.id from formulary_medicines c where c.id = ${afterId}
    )`]),
  ];
  if (afterId !== null) await requireCursorRow(db, "formulary_medicines", afterId);
  const rows = await db.select().from(formularyMedicines)
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(sql`lower(${formularyMedicines.brandName}) asc`, asc(formularyMedicines.id))
    .limit(limit + 1);

  const page = finishPage(rows, limit, (r) => r.id);
  if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };

  const composition = await db.select().from(formularyMedicineSalts)
    .where(anyOfText(formularyMedicineSalts.medicineId, page.items.map((m) => m.id)));
  const byMedicine = new Map<string, { saltId: string; strength: string | null }[]>();
  for (const row of composition) {
    const list = byMedicine.get(row.medicineId) ?? [];
    list.push({ saltId: row.saltId, strength: row.strength });
    byMedicine.set(row.medicineId, list);
  }
  return {
    items: page.items.map((m) => ({ ...m, salts: byMedicine.get(m.id) ?? [] })),
    nextCursor: page.nextCursor,
  };
}

/**
 * A page of moieties, ordered by name, optionally narrowed by a substring of that name.
 *
 * `q` matches the NAME ONLY and rides `formulary_salts_name_trgm_idx`. DECIDED: not aliases. This
 * feeds a picker, where a human confirms what they chose; aliases exist for RESOLUTION, where
 * nobody is looking. A picker that offers "amoxycillin" and "amoxicillin" as two rows invites the
 * duplicate this module spent a migration de-duplicating.
 */
export async function pageSalts(
  db: Db, opts: { activeOnly?: boolean; q?: string } & PageRequest = {},
): Promise<Page<SaltRow>> {
  const limit = pageLimit(opts.limit);
  const afterId = decodeCursor(opts.cursor);
  const q = (opts.q ?? "").trim().toLowerCase();

  /**
   * `%` AND `_` ARE THE PHARMACIST'S CHARACTERS, NOT THE PATTERN'S. `escapeLike` is the house rule
   * — `kernel/search/text.ts` exists for it and `suggest.ts` obeys it. Without it a search for `a%`
   * runs `like '%a%%'` and answers with every moiety containing an `a`, which the picker then
   * presents as if it were the answer to what was typed.
   */
  const needle = `%${escapeLike(q)}%`;

  if (q !== "" && afterId !== null) {
    /**
     * A SEARCH IS RANKED, AND A RANKED ORDER IS NOT A KEYSET. Refused rather than served wrongly:
     * paging a relevance order with a `(name, id)` cursor would skip and repeat rows silently. The
     * only caller is a typeahead, which takes one page and never asks for a second.
     */
    throw new CursorError("a moiety search cannot be paged — narrow the search instead");
  }
  if (afterId !== null) await requireCursorRow(db, "formulary_salts", afterId);

  const where = [
    ...(opts.activeOnly === true ? [eq(formularySalts.active, true)] : []),
    ...(afterId === null ? [] : [sql`(lower(${formularySalts.name}), ${formularySalts.id}) > (
      select lower(c.name), c.id from formulary_salts c where c.id = ${afterId}
    )`]),
    ...(q === "" ? [] : [sql`lower(${formularySalts.name}) like ${needle}`]),
  ];
  const rows = await db.select().from(formularySalts)
    .where(where.length === 0 ? undefined : and(...where))
    /**
     * EXACT FIRST, THEN PREFIX, THEN ANYWHERE. Alphabetical alone made a real moiety UNREACHABLE:
     * measured on the loaded catalogue, "sodium" matches 180 active moieties and 130 of them sort
     * before the one actually named `Sodium`, so a 20-row picker could never show it — and no
     * substring of "sodium" did any better. A search must be able to find the thing it names.
     */
    .orderBy(
      ...(q === "" ? [] : [sql`case when lower(${formularySalts.name}) = ${q} then 0
                                    when lower(${formularySalts.name}) like ${`${escapeLike(q)}%`} then 1
                                    else 2 end`]),
      sql`lower(${formularySalts.name}) asc`,
      asc(formularySalts.id),
    )
    .limit(limit + 1);
  return finishPage(rows, limit, (r) => r.id);
}

/**
 * A page of interaction pairs, ordered by id.
 *
 * Ordered by ID and not by severity, which is what `listInteractions` did: severity is not unique,
 * so it cannot be a keyset cursor (LAW 1), and a list that silently repeats or skips rows is worse
 * than one that is not sorted the way a curator would like. `saltIds` narrows to pairs touching any
 * of the given moieties.
 */
export async function pageInteractions(
  db: Db, opts: { activeOnly?: boolean; saltIds?: readonly string[] } & PageRequest = {},
): Promise<Page<InteractionRow>> {
  const limit = pageLimit(opts.limit);
  const after = decodeCursor(opts.cursor);
  const salts = opts.saltIds === undefined ? undefined : requireBounded(opts.saltIds, "pageInteractions");
  if (salts !== undefined && salts.length === 0) return { items: [], nextCursor: null };
  if (after !== null) await requireCursorRow(db, "formulary_interactions", after);
  const where = [
    ...(opts.activeOnly === true ? [eq(formularyInteractions.active, true)] : []),
    ...(after === null ? [] : [gt(formularyInteractions.id, after)]),
    ...(salts === undefined ? [] : [sql`(${anyOfText(formularyInteractions.saltAId, salts)} or ${anyOfText(formularyInteractions.saltBId, salts)})`]),
  ];
  const rows = await db.select().from(formularyInteractions)
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(asc(formularyInteractions.id))
    .limit(limit + 1);
  return finishPage(rows, limit, (r) => r.id);
}

/** How many moieties there are. A count, not a page length — the two are different questions. */
export async function countSalts(db: Db | Tx, opts: { activeOnly?: boolean } = {}): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(formularySalts)
    .where(opts.activeOnly === true ? eq(formularySalts.active, true) : undefined);
  return rows[0]?.n ?? 0;
}

export type CatalogueCensus = {
  salts: number; activeSalts: number;
  medicines: number; activeMedicines: number;
  compositionRows: number;
  /** Active medicines with NO composition row — the ones no safety check can reason about. */
  uncomposedActiveMedicines: number;
  interactions: number; activeInteractions: number;
};

/**
 * The size of the catalogue, in ONE statement of scalar subqueries, with no row crossing the wire.
 *
 * WHY IT EXISTS. Keyset paging gives no total — that is the price of not paying for `offset` — so a
 * screen that wants to say "103,383 medicines" has to ask. It used to get that number by fetching
 * all 103,383 rows and taking `.length`, which is the defect this whole PR is about, wearing the
 * clothes of a harmless statistic.
 *
 * `uncomposedActiveMedicines` is the number the module has never had a reader for and most needs:
 * an active product with no composition is one the interaction, allergy and substitution checks
 * cannot reason about, and it is invisible in every list that shows names.
 */
export async function catalogueCensus(db: Db): Promise<CatalogueCensus> {
  const rows = await db.execute<CatalogueCensus>(sql`
    select (select count(*)::int from formulary_salts)                        as "salts",
           (select count(*)::int from formulary_salts where active)           as "activeSalts",
           (select count(*)::int from formulary_medicines)                    as "medicines",
           (select count(*)::int from formulary_medicines where active)       as "activeMedicines",
           (select count(*)::int from formulary_medicine_salts)               as "compositionRows",
           (select count(*)::int from formulary_medicines m
             where m.active
               and not exists (select 1 from formulary_medicine_salts l
                                where l.medicine_id = m.id))                  as "uncomposedActiveMedicines",
           (select count(*)::int from formulary_interactions)                 as "interactions",
           (select count(*)::int from formulary_interactions where active)    as "activeInteractions"
  `);
  const row = rows.rows[0];
  if (row === undefined) throw new Error("catalogueCensus returned no row");
  return row;
}

/**
 * Brand name (lowercased) -> medicine id, for the names asked about.
 *
 * ═══ THIS ONE CHUNKS RATHER THAN REFUSING, AND THE ASYMMETRY IS ABOUT BLAME ═══
 *
 * The id-keyed readers above refuse past `MAX_IDS` because an oversized id list is a defect in the
 * CALLER. This serves IMPORTERS — an item master, a demo seed — where the list is however many
 * drugs the hospital actually buys. Refusing on row 501 of a legitimate file is hostile to an
 * operator who did nothing wrong, so it chunks internally. Both are bounded; only the blame differs.
 */
export async function medicineIdsByBrandNames(
  db: Db | Tx, names: readonly string[],
): Promise<Map<string, string>> {
  return byLowercasedName(db, names, async (chunk) =>
    (await db.select({ id: formularyMedicines.id, name: formularyMedicines.brandName })
      .from(formularyMedicines)
      .where(sql`lower(${formularyMedicines.brandName}) = any(${sql.param(chunk)}::text[])`)));
}

/** Moiety name (lowercased) -> salt id. Same chunking, same reason. */
export async function saltIdsByNames(db: Db | Tx, names: readonly string[]): Promise<Map<string, string>> {
  return byLowercasedName(db, names, async (chunk) =>
    (await db.select({ id: formularySalts.id, name: formularySalts.name })
      .from(formularySalts)
      .where(sql`lower(${formularySalts.name}) = any(${sql.param(chunk)}::text[])`)));
}

/** One statement per `CHUNK` names; `anyOfText` would carry them all, but a huge array is still a
 *  huge value to buffer, and the importers that call these have no latency budget worth defending. */
const CHUNK = 1000;

async function byLowercasedName(
  db: Db | Tx,
  names: readonly string[],
  fetch: (chunk: string[]) => Promise<{ id: string; name: string }[]>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => n !== "");
  const out = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    for (const row of await fetch(wanted.slice(i, i + CHUNK))) out.set(row.name.toLowerCase(), row.id);
  }
  return out;
}
