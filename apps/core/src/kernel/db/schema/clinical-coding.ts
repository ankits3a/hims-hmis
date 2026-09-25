import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ICD-10 — THE DIAGNOSIS CATALOGUE THE DOCTOR PICKS FROM AND MRD CODES FROM
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14, asked for the diagnosis field to suggest from a real catalogue and supplied
 * one: the ICD-10-CM tabular list, appended to the clinical bundle. Until now the consult screen
 * had a free-text `diagnosis` box and a bare `icd10Code` input beside it, both typed from memory.
 *
 * ═══ WHAT IS IN IT, MEASURED BEFORE A LINE OF THIS WAS WRITTEN ═══
 *
 *     rows                      97,296        distinct codes            97,296
 *     distinct short_desc       96,507        billable (assignable)     74,044  (76.1%)
 *     chapters                      22        category headers          23,252
 *
 * 96,507 distinct descriptions over 97,296 rows is the number that mattered. The same bundle's
 * per-drug tables are six template strings fanned out over 10,303 rows, so the first question asked
 * of any new table in it is whether the content is real. Here it is.
 *
 * ═══ TWO CHAPTERS ARE TWO THIRDS OF THE BOOK, AND NEITHER IS AN OPD DIAGNOSIS ═══
 *
 *     Chapter 19  Injury, poisoning and external causes (S00-T88)   53,944   55.4%
 *     Chapter 20  External causes of morbidity (V00-Y99)            10,573   10.9%
 *
 * Chapter 19 is that size because ICD-10-CM gives almost every injury a seventh character for
 * initial / subsequent / sequela encounter, so one fracture is three or more codes. Chapter 20 is
 * not a diagnosis at all — it records how the injury happened, and is only ever a supplementary
 * code. A doctor typing `fract` into a ranked-by-similarity box would get a screenful of neither.
 * `chapterNo` is stored so the search can rank on it. Only chapter 20 is ranked down in the end:
 * a first draft demoted chapter 19 as well and `fract` then returned "Fracture of skull due to
 * birth injury" and three dental-filling codes, because burying the chapter buried the fractures
 * too. Chapter 19 is large, not wrong. The order is set in `icd10.ts`, in one visible ORDER BY.
 *
 * ═══ `code` IS THE PRIMARY KEY, AND NOTHING REFERENCES IT ═══
 *
 * The code is the identity — it is what a claim, a register and a discharge summary all carry, and
 * a surrogate id would only be a second name for it. But no table FOREIGN KEYS to this one, and
 * that is deliberate: the same law as the drug field. A doctor may record a diagnosis this
 * catalogue has never heard of, and a reference table that could refuse one would make a foreign
 * standard's coverage into a clinical constraint.
 *
 * `billable` says whether a code may be ASSIGNED. A category header ("A01 Typhoid and paratyphoid
 * fevers") exists to group its children and is invalid on a claim; its children ("A01.00 Typhoid
 * fever, unspecified") are what a desk picks. Stored rather than filtered at import so that an MRD
 * screen can walk the hierarchy later; the doctor's typeahead offers only the assignable ones.
 */
export const icd10Codes = pgTable(
  "icd10_codes",
  {
    /** Dotted, as written on every document: `A01.00`, `J06.9`. */
    code: text("code").primaryKey(),
    /** Undotted, as claim files and older registers carry it: `A0100`. */
    rawCode: text("raw_code").notNull(),
    /** The tabular-list position. The book's own order, and the only hierarchy signal it ships. */
    orderNumber: integer("order_number").notNull(),
    /** False for a category header, which may group children but may never be assigned. */
    billable: boolean("billable").notNull(),
    shortDescription: text("short_description").notNull(),
    /** Equal to `shortDescription` on 42,293 rows and longer on the rest; both are kept as released. */
    longDescription: text("long_description").notNull(),
    /** 1-22, parsed from the chapter label at import — see the header on why 19 and 20 matter. */
    chapterNo: integer("chapter_no").notNull(),
    chapterName: text("chapter_name").notNull(),
    /**
     * ═══ HOW GENERAL THIS CODE IS — THE RANKING SIGNAL, COMPUTED ONCE AT IMPORT ═══
     *
     * A denormalised signal for the same reason `formulary_salts.product_count` is one: the drug
     * field measured that deriving its ranking per keystroke cost two seconds, and a column read
     * costs nothing. `generalityOf` in `scripts/import-icd10-catalogue.ts` is the whole definition.
     *
     * It exists because ICD-10 sorted on text similarity answers the wrong question. Measured on
     * the real catalogue before this column existed: `diabet` returned **Diabetes insipidus** (a
     * rare pituitary disorder) above type 2 diabetes; `hyperten` returned Hypertensive urgency and
     * did not reach **I10 Essential (primary) hypertension** in ten rows; `asthma` put "Other
     * asthma" above "Unspecified asthma, uncomplicated". Every one of those is the same failure —
     * a short, rare, specific name beating the general code an OPD actually assigns.
     *
     * So the catalogue is ranked by GENERALITY and then by the book's own tabular order, and what
     * an outpatient desk writes floats up without anyone hand-listing a single diagnosis.
     */
    generality: integer("generality").notNull().default(0),
  },
  (t) => [
    /*
      The typeahead matches inside the description — a doctor types `typh`, not `A01`. Without a
      trigram index that is a sequential scan of 97,296 rows on every keystroke, which is the exact
      cost the drug field measured at 800 ms and had to engineer away.
    */
    index("icd10_codes_desc_trgm_idx").using("gin", sql`lower(${t.shortDescription}) gin_trgm_ops`),
    /** Typing a code is the other half: `J06` must reach `J06.9` by prefix, off the index. */
    index("icd10_codes_code_lower_idx").using("btree", sql`lower(${t.code})`),
    index("icd10_codes_billable_idx").on(t.billable),
  ],
);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ICD-11 — WHO'S ICD-10 → ICD-11 TABLE, HELD BESIDE THE CATALOGUE AND NEVER WRITTEN INTO A RECORD
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHO publishes the ICD-10 → ICD-11 mapping tables with each ICD-11 release (2026-01 here). This is
 * the PLUMBING for the one-to-one file (`10To11MapToOneCategory.txt`): a table to hold it, a loader
 * that records every load, and a read that shows the ICD-11 code beside the ICD-10 one on screen.
 *
 * ═══ NO WHO DATA SHIPS WITH THIS, AND NOTHING LOADS IT ═══
 *
 * WHO's ICD-11 licence §1.2.4 puts "mapping or producing crosswalks" under a separate written
 * agreement, and the owner has not ruled on it. So no row of WHO's file is in the repository, no
 * migration or seed loads one, and deploy does not run the loader. Until someone runs
 * `pnpm --filter @hmis/core icd11:load` by hand, both tables are empty and every read answers null.
 *
 * ═══ ICD-10 STAYS THE CODE ═══
 *
 * `opd_encounter_diagnoses.icd10_code` is what the doctor picked and what a claim carries. Nothing
 * here is a foreign key from it or to it, and nothing ICD-11 is ever written to a diagnosis: the
 * ICD-11 code is looked up at READ time from the latest loaded release, so a new release changes
 * what the screen shows and never what the record says.
 *
 * ═══ WHO'S STRINGS ARE KEPT AS RELEASED; OURS ARE NAMED AS OURS (§1.2.3, §1.2.5) ═══
 *
 * Every `icd10_*` / `icd11_*` column is a cell of WHO's file, stored byte for byte — an empty cell
 * is stored as '' rather than null, because '' is what WHO wrote. The licence requires the code,
 * the title AND the URI wherever the classification is stored or transmitted, so all three are here.
 * `release` and `map_kind` did NOT come from WHO: `release` is the label the operator gave the load,
 * and `map_kind` is derived by `cds/icd11-map.ts` from WHO's cells (see there). They carry no
 * `icd` prefix so that no reader mistakes them for WHO's.
 */
export const icd11MapLoads = pgTable(
  "icd11_map_loads",
  {
    id: text("id").primaryKey(),
    /*
      ONE LOAD PER FILE AND ONE PER RELEASE. The loader checks both first so it can say which; the
      UNIQUE constraints are what hold under a race. They are constraints rather than indexes
      because `icd11_map_rows.release` is a foreign key to this column.
    */
    /** The ICD-11 release the file belongs to, `YYYY-MM` (`2026-01`), as the operator named it. */
    release: text("release").notNull().unique("icd11_map_loads_release_uq"),
    /** The file's basename as loaded — `10To11MapToOneCategory.txt`. */
    sourceFile: text("source_file").notNull(),
    /** Of the file's BYTES, before any decoding: the same file loaded twice has the same sha. */
    sha256: text("sha256").notNull().unique("icd11_map_loads_sha256_uq"),
    rowCount: integer("row_count").notNull(),
    /** Who ran the loader. A CLI has no session, so it is the name given on the command line. */
    loadedBy: text("loaded_by").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("icd11_map_loads_release_ck", sql`${t.release} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("icd11_map_loads_row_count_ck", sql`${t.rowCount} > 0`),
  ],
);

export const icd11MapRows = pgTable(
  "icd11_map_rows",
  {
    /** Not WHO's: the load this row came in with, and the key the read path picks the latest by. */
    release: text("release").notNull().references(() => icd11MapLoads.release),
    /** WHO's `icd10Code`, dotted as WHO writes it (`A00.0`); a block is a range (`A00-A09`). */
    icd10Code: text("icd10_code").notNull(),
    icd10Title: text("icd10_title").notNull(),
    /**
     * WHO's `icd11Code` — FREE TEXT, not a code shape. It may be empty (the target is a block,
     * which bears no code), or combined: `&` joins a stem to an extension code and `/` a cluster.
     */
    icd11Code: text("icd11_code").notNull(),
    icd11Title: text("icd11_title").notNull(),
    icd11Chapter: text("icd11_chapter").notNull(),
    /** WHO's `11ClassKind`: `category` or `block` ('' on a No Mapping row). */
    icd11ClassKind: text("icd11_class_kind").notNull(),
    /** WHO's `Linearization (releaseURI)` — the MMS entity at this release; '' on a No Mapping row. */
    icd11ReleaseUri: text("icd11_release_uri").notNull(),
    /** WHO's `ICD-11 FoundationURI`, verbatim — which is the literal `No Mapping` on those rows. */
    icd11FoundationUri: text("icd11_foundation_uri").notNull(),
    /** Not WHO's: derived at parse time from WHO's cells — see `mapKindOf` in `cds/icd11-map.ts`. */
    mapKind: text("map_kind").notNull(),
  },
  (t) => [
    /* WHO's one-to-one file names each ICD-10 code once; a second row for a code is a different file. */
    primaryKey({ columns: [t.release, t.icd10Code] }),
    check("icd11_map_rows_map_kind_ck", sql`${t.mapKind} in ('mapped', 'no_mapping', 'grouping')`),
  ],
);
