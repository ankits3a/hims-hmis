import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * PLAN 16a T1 — the formulary: the first table in this system that knows what a drug IS.
 *
 * ═══ WHY FIVE TABLES AND NOT ONE ═══
 *
 * Today `matchAllergies` (`modules/opd/prescriptions.ts`) compares two pieces of free text with
 * `includes()` in both directions, and its own doc-comment names its expiry: *"free-text on both
 * sides is the reality until a formulary lands (stage 2)"*. That matcher catches "Penicillin G"
 * from an allergy to "penicillin" and MISSES Augmentin, because nothing in the system knows that
 * Augmentin is amoxicillin + clavulanic acid and that amoxicillin is a penicillin. The gap is not
 * in the matcher; it is in the absence of these tables.
 *
 * The split follows spec §1.1 and is load-bearing in one specific way: **identity is the active
 * MOIETY, not the salt form.** "diclofenac sodium" and "diclofenac potassium" are ONE row in
 * `formulary_salts` (`diclofenac`), because a patient allergic to one is allergic to the other and
 * a duplicate-therapy check that treats them as different drugs is a check that misses a double
 * dose. Salt form and per-salt strength live on the composition join, where they describe a
 * PRODUCT rather than a substance.
 *
 * ═══ THE ORDERED PAIR, AND WHY IT IS A CHECK RATHER THAN A CONVENTION ═══
 *
 * An interaction between A and B is the same fact as one between B and A. Stored without a
 * canonical order, the table admits both rows, and then `listInteractionsAmong` returns one hit or
 * two depending on which order a curator happened to type — a severity that changes with data
 * entry. `formulary_interactions_ordered_ck` (`salt_a_id < salt_b_id`) makes the reversed duplicate
 * unstorable rather than merely discouraged, and the unique index then means what it says. T2's
 * `addInteraction` normalizes before insert; the constraint is what makes that normalization
 * checkable instead of trusted.
 *
 * ═══ THE ENUM CHECKS ARE HERE ON PURPOSE (T1 decision, recorded because the plan named the
 * values without naming the constraints) ═══
 *
 * `route_class`, `severity`, `route_scope`, `schedule_flag`, `status` and `kind` are all closed
 * value sets in the plan's own prose. The `counterparties_payee_class_ck` precedent (Plan 09)
 * makes them constraints rather than comments: a value outside the set is a value every reader
 * downstream — the check engine, the curation rollup, the admission screen — would silently treat
 * as "not systemic" or "not severe", which is the safe-looking direction and the wrong one.
 *
 * ═══ TWO COLUMNS THAT LOOK LIKE MISSING FOREIGN KEYS AND ARE NOT ═══
 *
 * `formulary_medicines.staging_id` and `formulary_staging.medicine_id` point at each other and
 * carry NO references() clause, exactly as the plan specifies them. A mutual FK pair would make
 * the two tables un-insertable without a deferred constraint, and neither direction is a
 * correctness boundary: staging is a lookup dictionary of mined rows (spec §1.1), and a mined row
 * that has been admitted is history, not a parent. The back-links exist for provenance — "which
 * scraped payload became this medicine" — and T7 stamps both in one transaction.
 */

/** The audit shape every master in this repo carries — `opd_departments`' columns, same names. */
const auditColumns = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * The ACTIVE MOIETY, canonically named. `name` is "diclofenac", never "diclofenac sodium".
 *
 * `aliases` carries spelling variants ("amoxycillin" for amoxicillin) — the resolution path in T3
 * reads them EXACTLY, never fuzzily. `drugClass` is what makes the Augmentin case work: an allergy
 * recorded as "penicillin" matches any line whose salts carry that class.
 */
export const formularySalts = pgTable(
  "formulary_salts",
  {
    id: text("id").primaryKey(), // ULID via newId()
    name: text("name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    drugClass: text("drug_class"),
    atcCode: text("atc_code"),
    /** The bundle's `substance_sctid` — see `formulary_medicines.source_ref`. */
    sourceRef: text("source_ref"),
    /**
     * ═══ HOW MANY PRODUCTS THE MARKET MAKES OF THIS MOIETY — THE TYPEAHEAD'S RANKING SIGNAL ═══
     *
     * Measured, and it is why this column exists rather than a query: ranking `amox` by trigram
     * similarity put **Amoxapine** (an antidepressant, 14 products) above **Amoxicillin** (3,830),
     * because the shorter word scores higher. A doctor typing three letters means the molecule the
     * market is built around. Computing it per keystroke costs 2 SECONDS over 142,759 composition
     * rows; stored, it is free.
     *
     * DERIVED AND OWNED BY THE IMPORT — refreshed whenever the catalogue is loaded, never edited by
     * hand. It is a popularity proxy and nothing more: it must never decide what is SAFE, only what
     * is offered first.
     */
    productCount: integer("product_count").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    // Case-insensitive uniqueness: "Amoxicillin" and "amoxicillin" are one moiety, and two rows
    // for one moiety would split every check that groups by it.
    uniqueIndex("formulary_salts_name_lower_ux").using("btree", sql`lower(${t.name})`),
    /**
     * THERE IS DELIBERATELY NO `sctid` ON THIS TABLE, AND AN EARLIER CUT OF THIS WORK PUT ONE HERE.
     *
     * A curated moiety is reached from MANY release substances - `doxycycline` from Doxycycline
     * hyclate, monohydrate, calcium and hydrochloride - so there is no single concept id to store,
     * and a UNIQUE index on one made the intended many-to-one shape unstorable for all 568 such
     * groups. The concept id belongs to `formulary_substances`, which is the tier that has one
     * each. The link is `formulary_substances.salt_id`, in that direction only: two paths to one
     * fact is how the two drift.
     */
    /** The same trigram instrument for the moiety: a doctor searching `amox` must reach the salt. */
    index("formulary_salts_name_trgm_idx").using("gin", sql`lower(${t.name}) gin_trgm_ops`),
    /**
     * ONE RELEASE IMAGE PER RELEASE SUBSTANCE. This does not contradict the paragraph above.
     * `source_ref` is set only on a RELEASE IMAGE, the importer's verbatim copy of one substance,
     * which is one-to-one with that substance by construction. A curated moiety carries null here,
     * so the many-to-one shape is untouched. Measured on `hmis_formulary_dev`: 3,258 images and
     * 3,258 distinct refs. The projection in `modules/formulary/mapping.ts` joins on this column to
     * find where an unmapped row goes back to, and a second image would silently double every row
     * it moves.
     */
    uniqueIndex("formulary_salts_source_ref_ux").on(t.sourceRef).where(sql`${t.sourceRef} is not null`),
  ],
);

/**
 * The BRAND — what a doctor types and a pharmacist stocks. Composition lives on the join below;
 * this row deliberately knows nothing about which moieties it contains.
 */
export const formularyMedicines = pgTable(
  "formulary_medicines",
  {
    id: text("id").primaryKey(), // ULID via newId()
    brandName: text("brand_name").notNull(),
    form: text("form").notNull(), // 'tablet' | 'syrup' | 'injection' | 'gel' … open by design
    /** 'systemic' | 'topical' — DD7's two buckets. Route-awareness with no per-route ontology. */
    routeClass: text("route_class").notNull().default("systemic"),
    strengthLabel: text("strength_label"),
    /** 'H' | 'H1' | 'X' | 'OTC' — the Drugs and Cosmetics Rules schedule, null when unclassified. */
    scheduleFlag: text("schedule_flag"),
    /**
     * ═══ THE HOSPITAL'S OWN CATALOGUE CODE (owner's bundle, 2026-09-14) — `D0230` ═══
     *
     * What the doctor's autocomplete shows beside the name and what a storekeeper reads off a
     * shelf. It is the bundle's `hmis_code`, and it is NOT an identity: only the 10,303 generics
     * carry one, a branded row does not, and nothing here may assume it is present or unique.
     */
    code: text("code"),
    /**
     * ═══ THE BRAND NAME AS `normalizeDrugName` SEES IT, STORED ═══
     *
     * `resolveDrugTexts` names this column as its own extension point, in as many words: "a stored
     * normalized column ... filled by the SAME function, so there is still one normalizer and the
     * WHERE clause reads a column rather than re-deriving a value." This is that column.
     *
     * It is filled by the TypeScript `normalizeDrugName` at every write site — NOT by a generated
     * SQL expression. That is the whole point: a `GENERATED ALWAYS AS (regexp_replace(...))` column
     * would make a second normalizer permanent and authoritative, and §2.54's objection is that two
     * copies of one fact drift. One function fills it; the only SQL copy is the one-shot backfill in
     * the migration, and a test holds the two to one answer over an adversarial corpus.
     *
     * THE INDEX IS NOT UNIQUE, and the extension point's own wording ("with a unique index") is
     * wrong about that — measured on the loaded national catalogue, 103,383 brand names collapse to
     * 103,332 normalized keys, so 51 groups collide (`Ab-Xone` and `Abxone`, `A-Pan` and `Apan`).
     * A unique index will not build. Same shape and same reason as
     * `formulary_generics_name_norm_idx`, where 774 groups collide.
     */
    nameNormalized: text("name_normalized").notNull(),
    /**
     * ═══ THE TYPEAHEAD'S SORT KEY, DENORMALISED ONTO THE PRODUCT ═══
     *
     * The largest `product_count` among this row's moieties. It belongs here rather than being
     * joined at query time for one measured reason: ranking through a correlated subquery over
     * 142,759 composition rows costs **800 ms per keystroke**, and as a plain column read it costs
     * nothing. Set by the catalogue import, beside the count it is derived from.
     *
     * A popularity proxy, never a safety signal — it decides what is offered FIRST and nothing else.
     */
    saltRank: integer("salt_rank").notNull().default(0),
    /**
     * WHERE THIS ROW CAME FROM, so a re-import updates rather than duplicates: the SNOMED CT
     * concept id from the owner's bundle (`generic_sctid` or `medicine_sctid`). Null on every row
     * a human entered through the masters screen, which is the honest answer for those.
     */
    sourceRef: text("source_ref"),
    /** Provenance back-link, not a foreign key — see the header. */
    stagingId: text("staging_id"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("formulary_medicines_brand_lower_ux").using("btree", sql`lower(${t.brandName})`),
    /*
      THE DOCTOR TYPES `par` AND MEANS A WORD THAT STARTS `par`, but they also type `clav` and mean
      Augmentin — so the picker matches anywhere in the name, and an anywhere-match cannot use the
      btree above. `gin_trgm_ops` is the same instrument migration 0021 installed for patient names
      and 0024 for UHIDs, now over a catalogue of a hundred thousand rows where it stops being a
      nicety: a leading-wildcard LIKE across that table is a sequential scan on every keystroke.
    */
    index("formulary_medicines_brand_trgm_idx").using("gin", sql`lower(${t.brandName}) gin_trgm_ops`),
    index("formulary_medicines_code_idx").using("btree", sql`lower(${t.code})`),
    /* The free-text resolver's lane: `resolveDrugTexts` asks for a SET of normalized names. */
    index("formulary_medicines_name_norm_idx").using("btree", t.nameNormalized),
    check("formulary_medicines_route_class_ck", sql`${t.routeClass} in ('systemic', 'topical')`),
    check(
      "formulary_medicines_schedule_flag_ck",
      sql`${t.scheduleFlag} is null or ${t.scheduleFlag} in ('H', 'H1', 'X', 'OTC')`,
    ),
  ],
);

/**
 * The composition join - a fixed-dose combination is simply a medicine with more than one row.
 *
 * === `source` EXISTS BECAUSE TWO WRITERS SHARE THIS TABLE ===
 *
 * A pharmacist writes here through `addMedicine`/`updateMedicine`, and the catalogue importer
 * writes here too. `updateMedicine` does an unconditional `delete ... where medicine_id = $1`
 * before re-inserting. Without provenance those two overwrite each other in both directions and
 * neither can tell which rows were its own, so a pharmacist's correction would vanish on the next
 * import run, silently. Every row therefore says where it came from.
 *
 * === WHAT THIS COMMENT USED TO CLAIM, AND WHY THE CORRECTION IS THE INTERESTING PART ===
 *
 * It said, in the present tense, "the curated delete is scoped to `curated`". It never was:
 * `updateMedicine`'s delete is unscoped. And the column could not have told the two apart even if
 * it were, because `source` carried a DEFAULT and no writer ever set it — measured on the loaded
 * catalogue, all 142,759 release-derived rows read `'curated'`. A column nobody writes, described
 * by a comment nobody could check, is worse than no column: it reads as a guarantee.
 *
 * So: the DEFAULT IS GONE and every writer states its own provenance. An unprovenanced insert is
 * now a COMPILE error rather than a silently mislabelled row — `$inferInsert` makes the field
 * required and `tsc` names every site, which is only safe because all five writers are drizzle
 * builder inserts and none is raw SQL.
 *
 * === THE RULE THE FIRST DERIVATION WRITER IS HELD TO ===
 *
 * The curated delete STAYS UNSCOPED, because `updateMedicine` is a whole-composition replace: a
 * pharmacist who submits a composition is stating the whole of it, and leaving derived rows behind
 * would silently merge their statement with the importer's. What a derivation may do is narrower:
 *
 *   A DERIVATION MAY WRITE ONLY WHERE THE MEDICINE HAS NO `curated` ROW,
 *   AND MAY DELETE ONLY ITS OWN `derived` ROWS.
 *
 * The write half matters as much as the delete half: scoping only the delete leaves a derivation
 * free to add a moiety beside a pharmacist's and produce a composition neither of them stated.
 *
 * === THE DERIVATION NOW EXISTS, AND `derived_from` IS WHAT MAKES IT A PROJECTION ===
 *
 * `modules/formulary/mapping.ts` is that derivation, and it keeps both halves of the rule. A
 * derived row names the RELEASE SUBSTANCE it came from (`derived_from`, the SNOMED CT id), so the
 * moiety it points at is a function of two things: that substance, and whatever the pharmacist
 * mapped it to. It points at the curated moiety when the substance is mapped, and back at the
 * release image otherwise. Keyed on the substance rather than on the salt it points at today, a
 * correction or an "unmappable" ruling can find its rows again after they have moved. The release
 * image is never deleted, so every projection can be reverted.
 */
export const formularyMedicineSalts = pgTable(
  "formulary_medicine_salts",
  {
    medicineId: text("medicine_id").notNull().references(() => formularyMedicines.id),
    saltId: text("salt_id").notNull().references(() => formularySalts.id),
    /** Per-salt strength, e.g. '500 mg' on the amoxicillin row of an Augmentin 625. */
    strength: text("strength"),
    /**
     * 'curated' (a pharmacist typed it) or 'derived' (the release produced it). NO DEFAULT, on
     * purpose — see the header. It means WHO LAST ASSERTED THIS ROW, not who first created it.
     */
    source: text("source").notNull(),
    /**
     * The release substance (`formulary_substances.sctid`) a DERIVED row was produced from. Null on
     * every curated row, by constraint: a pharmacist's statement is not derived from anything.
     *
     * NULL ON SOME DERIVED ROWS TOO, and that is disclosed rather than backfilled by guesswork. The
     * catalogue importer reuses an existing moiety when the release names one exactly
     * (`Paracetamol` onto the seeded `Paracetamol`), and rows written that way before this column
     * existed carry no record of which substance they came from. They already name a curated
     * moiety, so no projection ever needs to move them.
     */
    derivedFrom: text("derived_from"),
  },
  (t) => [
    primaryKey({ columns: [t.medicineId, t.saltId] }),
    check("formulary_medicine_salts_source_ck", sql`${t.source} in ('curated', 'derived')`),
    check(
      "formulary_medicine_salts_curated_underived_ck",
      sql`${t.source} = 'derived' or ${t.derivedFrom} is null`,
    ),
    /* A mapping decision re-projects exactly the rows derived from one substance: this is that lookup. */
    index("formulary_medicine_salts_derived_from_idx").on(t.derivedFrom),
    /*
      THE PRIMARY KEY LEADS WITH `medicine_id`, so "which products contain this moiety" — the
      direction the drug typeahead asks in — had no index at all and scanned all 142,759 rows on
      every keystroke. Measured in the plan, not guessed: `Seq Scan on formulary_medicine_salts
      (rows=142759)` inside the hash join.
    */
    index("formulary_medicine_salts_salt_idx").on(t.saltId),
  ],
);

/**
 * THE RELEASE, AS RELEASED - and the tier that exists because the release is not a moiety list.
 *
 * === WHY THIS TABLE EXISTS AT ALL ===
 *
 * `formulary_salts` is the ACTIVE MOIETY: "diclofenac", never "diclofenac sodium", because a
 * patient allergic to one salt form is allergic to the other. The NRCeS national release does not
 * work that way. Measured over its 3,283 substances on 2026-09-13: **1,006 (30%) are named as a
 * salt form**, and 73 moieties would split across two or more rows - doxycycline across four.
 *
 * Loading that list straight into `formulary_salts` would have produced a moiety table that is
 * really a salt-form table, in which an allergy to Doxycycline hyclate does not match Doxycycline
 * monohydrate, and in which warfarin exists twice: once curated carrying 5 interaction pairs, and
 * once from the release carrying none. Both failures are silent and both leave every test green.
 *
 * === AND WHY NO RULE COLLAPSES THEM ===
 *
 * The obvious rule - "strip a known salt-form suffix, or withhold if you see one" - was tried and
 * refuted against the real file. It SPLITS DOXYCYCLINE, the case it was written to fix: `hyclate`
 * is a salt token and `monohydrate` is not, so one is withheld and the other silently becomes a
 * second moiety (75 names are in that hydrate class). Worse, a suffix test cannot see a salt
 * written cation-first - `Calcium leucovorin`, `Sodium fusidate`, `Procaine penicillin G` (58 of
 * them) - and it cannot tell a moiety from a CLASS: `Antineoplastic agent`, `Tricyclic
 * antidepressant` and 63 other mechanism-of-action groupers would each become a "moiety" that
 * matches no allergy. `Diclofenac diethylammonium` would auto-create a third diclofenac row, and
 * that row sits on 64 medicines in the release.
 *
 * So the collapse is a CLINICAL act, performed once per substance by a pharmacist, and this table
 * is where the release waits for it. The loader invents nothing; it imports what was published.
 */
export const formularySubstances = pgTable(
  "formulary_substances",
  {
    id: text("id").primaryKey(), // ULID via newId()
    /** SNOMED CT concept id. One per row here, which is what `formulary_salts` cannot promise. */
    sctid: text("sctid").notNull(),
    /** Exactly as released, salt form and all: "Warfarin sodium", "Ipoveratril hydrochloride". */
    name: text("name").notNull(),
    /** The release's pipe-delimited synonym list, split. Read EXACTLY, never fuzzily. */
    synonyms: jsonb("synonyms").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /**
     * THE CURATED MOIETY, or null. Many substances point at one moiety; that is the whole design,
     * so this is deliberately NOT unique.
     */
    saltId: text("salt_id").references(() => formularySalts.id),
    /**
     * WHY `salt_id IS NULL` IS NOT ENOUGH ON ITS OWN. Null means two different things - "no human
     * has looked at this yet" and "a human looked and ruled it unmappable" (a grouper concept, an
     * excipient, a vehicle). Without this column the second kind is re-presented to the pharmacist
     * for ever, which is how a worklist becomes a screen nobody opens.
     */
    mappingStatus: text("mapping_status").notNull().default("pending"),
    mappedBy: text("mapped_by"),
    mappedAt: timestamp("mapped_at", { withTimezone: true }),
    /** Which national release put this row here. */
    source: text("source").notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("formulary_substances_sctid_ux").on(t.sctid),
    uniqueIndex("formulary_substances_name_lower_ux").using("btree", sql`lower(${t.name})`),
    // The moiety search lane. `substance_name` is the ONE tier that behaves raw: its worst
    // three-character prefix returns 57 rows, against 1,837 for brands and 4,985 for raw generics.
    // NOT unique: many substances resolve to one moiety.
    index("formulary_substances_salt_idx").on(t.saltId),
    check(
      "formulary_substances_mapping_status_ck",
      sql`${t.mappingStatus} in ('pending', 'mapped', 'unmappable')`,
    ),
    // A mapped row must name a moiety; a pending one must not pretend to have been decided.
    check(
      "formulary_substances_mapped_has_salt_ck",
      sql`(${t.mappingStatus} = 'mapped') = (${t.saltId} is not null)`,
    ),
    // Every decided row records who decided and when; a pending one records neither.
    check(
      "formulary_substances_decided_audit_ck",
      sql`(${t.mappingStatus} = 'pending') = (${t.mappedBy} is null and ${t.mappedAt} is null)`,
    ),
  ],
);

/**
 * THE CLINICAL DRUG — the tier between a moiety and a branded product, and the tier this schema
 * did not have.
 *
 * ═══ WHY IT HAD TO BE ADDED RATHER THAN FOLDED INTO `formulary_medicines` ═══
 *
 * SNOMED CT's drug model is three levels: SUBSTANCE (amlodipine) -> CLINICAL DRUG ("amlodipine
 * 5 mg oral tablet") -> BRANDED PRODUCT ("Amlopres 5 mg tablet, Cipla"). This schema had two, and
 * the missing middle is where several things live that nothing else can express:
 *
 *   - GENERIC SUBSTITUTION. "give the patient any amlodipine 5 mg tablet" is a statement about
 *     this tier. With only brands, substitution has to be re-derived from composition every time,
 *     and two products that are clinically interchangeable are related by nothing.
 *   - COMPOSITION ONCE, NOT PER BRAND. The NRCeS release carries 10,303 clinical drugs against
 *     93,905 branded products. Composition belongs to the clinical drug; holding it per brand
 *     would store the same fact ~9 times and let the copies drift.
 *   - DOSE FORM AND ROUTE as released, not as re-typed. 174 dose forms and 58 routes, and several
 *     routes are compound ("Intramuscular route; Intravenous route; Subcutaneous route").
 *
 * ═══ `formulary_medicine_salts` IS NOT REPLACED, AND THAT IS DELIBERATE ═══
 *
 * `resolve.ts` reads the medicine->salt join directly for every interaction and allergy check.
 * Re-pointing it at this tier would rewrite the checking path in the same change that loads a
 * catalogue, so instead the loader DERIVES `formulary_medicine_salts` by expanding
 * medicine -> generic -> substances. Every existing check keeps working untouched, and the
 * derived rows are what they always were: the moieties a product contains.
 *
 * ═══ WHAT THIS TABLE DOES NOT CARRY, MEASURED RATHER THAN ASSUMED ═══
 *
 * The release's clinical columns are mostly empty, and carrying a column that is 97% blank beside
 * a table named `formulary_interactions` would invite a reader to mistake it for the interaction
 * dataset. Fill rates over its 10,303 rows, measured 2026-09-13:
 * `interaction_with_drugs` 3% · `classification_of_drug` 1% · `indications` 23% ·
 * `contraindications` 23% · `drug_type` 22% · `source` 18%. None is carried here. The computable
 * interaction and allergy-class content is the ONE PURCHASE of the 2026-08-23 RFQ, and a 3%-full
 * prose column must not be allowed to look like it arrived early.
 */
export const formularyGenerics = pgTable(
  "formulary_generics",
  {
    id: text("id").primaryKey(), // ULID via newId()
    /** SNOMED CT concept id. NOT NULL here: a generic exists in this table only by import. */
    sctid: text("sctid").notNull(),
    name: text("name").notNull(),
    /**
     * THE NAME A PRESCRIBER READS AND SEARCHES, and the reason it is stored rather than computed.
     *
     * 4,921 of the release's 10,303 clinical-drug names are SNOMED FULLY SPECIFIED NAMES: they
     * begin "Product containing precisely " and end " (clinical drug)". Left raw they are unusable
     * as a search key AND unreadable on screen - every one of them shares the prefix `produ`, so a
     * five-character search still returns 2,357 rows, and the doctor is shown a sentence about
     * products instead of a drug.
     *
     * This strips ONLY that known wrapper. It is not a rewrite and it invents nothing: `name` keeps
     * the release's string verbatim beside it, so the transformation is always checkable. Computing
     * it at read time instead would put a function call on the left of every WHERE clause, which no
     * index can help.
     */
    nameNormalized: text("name_normalized").notNull(),
    /** As released — "Oral tablet", "Eye drops". 174 distinct values; not an enum, by design. */
    doseForm: text("dose_form").notNull(),
    /** As released, and sometimes compound: "Intravenous route; Intramuscular route". */
    routeOfAdministration: text("route_of_administration").notNull(),
    /** The release's own human-readable composition line, kept verbatim for display and audit. */
    compositionSummary: text("composition_summary"),
    /**
     * WHICH RELEASE PUT THIS ROW HERE — the provenance the spreadsheet-loader design note lists as
     * its one still-open defect (§"The four things", #4). A catalogue row nobody can attribute is
     * a row nobody can re-import, diff or retire when the next national release lands.
     */
    source: text("source").notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("formulary_generics_sctid_ux").on(t.sctid),
    // The prescriber's search lane. Not unique: two generics may normalise to one string (774
    // groups do), which is why the list must always render dose form beside the name - it resolves
    // 97.7% of those collisions.
    index("formulary_generics_name_norm_idx").using("btree", sql`lower(${t.nameNormalized})`),
  ],
);

/**
 * THE COMPOSITION, held once per clinical drug, KEYED ON THE RELEASE'S OWN SUBSTANCE.
 *
 * `generic_compositions.csv` arrives already normalised - 13,125 rows against 10,303 generics -
 * and it references `substance_sctid`. Keying this table on the SUBSTANCE rather than on the
 * curated moiety is what makes it a faithful copy of the release: it can be loaded before a single
 * curation decision has been taken, it is idempotent across releases, and re-running it can never
 * lose a row.
 *
 * The earlier cut keyed it on `salt_id`, and that silently lost rows: a generic containing two
 * salt forms of one moiety collapses to a single primary key, so `onConflictDoNothing` dropped the
 * second - picking which strength survived by row order, in silence.
 *
 * `strength` and `unit` are kept AS RELEASED ("5/1", "milligram/Tablet") rather than parsed into a
 * number and a unit. Parsing is a lossy judgement about 174 dose forms made at import time by
 * something that cannot ask; the ratio form is what the release asserts, and a later task that
 * needs arithmetic can parse it with the original still present to check against.
 */
export const formularyGenericSubstances = pgTable(
  "formulary_generic_substances",
  {
    genericId: text("generic_id").notNull().references(() => formularyGenerics.id),
    substanceId: text("substance_id").notNull().references(() => formularySubstances.id),
    strength: text("strength"),
    unit: text("unit"),
  },
  (t) => [
    primaryKey({ columns: [t.genericId, t.substanceId] }),
    /*
      The key leads with the GENERIC, and the mapping worklist asks the other way round: "which
      clinical drugs contain this substance", for up to fifty substances on every page.
    */
    index("formulary_generic_substances_substance_idx").on(t.substanceId),
  ],
);

/** What a proposal rests on. Shown to the pharmacist verbatim; never read by any check. */
export type MappingProposalEvidence = {
  /** `release_boss`: the clinical drugs whose names state "precisely X (as <this substance>)". */
  generics?: { sctid: string; name: string }[];
  /** Other X values the release states for the same substance. The drafter keeps them all rather than choosing. */
  alternatives?: string[];
  /** A hydrate word the drafter removed from the release's X ("levofloxacin anhydrous" → "levofloxacin"). */
  droppedWord?: string;
  /** `agent`: the model that drafted it, and why. */
  model?: string;
  rationale?: string;
};

/**
 * ═══ A DRAFT OF A MAPPING — ADVICE TO A PHARMACIST, AND NOTHING READS IT BUT THE WORKLIST ═══
 *
 * Owner ruling R1 (`docs/superpowers/plans/2026-09-16-phase2-formulary-mapping-loop.md`): the
 * ~500 substance → moiety decisions are DRAFTED by the system and ATTESTED one at a time by the
 * hospital's pharmacist. This table holds the drafts. It is deliberately not the decision: the
 * decision is `formulary_substances.salt_id`, and the only writer of that column is a named human
 * act (`attestSubstance`, which refuses every non-user actor). The house law is
 * `kernel/orders/place.ts`'s: a drafter proposes, a human orders.
 *
 * `moiety_name` is a NAME, not a `salt_id`. The matching curated moiety is resolved when the
 * worklist is read, so renaming a moiety cannot leave a draft pointing at the old one, and a draft
 * can name a moiety that does not exist yet ("create clavulanic acid and map it").
 *
 * One row per (substance, drafter): a re-run of a drafter replaces its own draft and never
 * anybody else's.
 */
export const formularyMappingProposals = pgTable(
  "formulary_mapping_proposals",
  {
    id: text("id").primaryKey(), // ULID via newId()
    substanceId: text("substance_id").notNull().references(() => formularySubstances.id),
    moietyName: text("moiety_name").notNull(),
    /**
     * `release_boss` — the release names this substance's basis of strength ("precisely X (as Y)").
     * `release_base` — the release uses this substance itself as a basis of strength.
     * `agent`        — a model drafted it; `evidence.model` and `evidence.rationale` say which and why.
     */
    basis: text("basis").notNull(),
    evidence: jsonb("evidence").$type<MappingProposalEvidence>().notNull(),
    /** `drafter:release@1`, or `agent:<model id>`. Part of the row's identity. */
    draftedBy: text("drafted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("formulary_mapping_proposals_substance_drafter_ux").on(t.substanceId, t.draftedBy),
    check(
      "formulary_mapping_proposals_basis_ck",
      sql`${t.basis} in ('release_boss', 'release_base', 'agent')`,
    ),
    check("formulary_mapping_proposals_moiety_name_ck", sql`length(btrim(${t.moietyName})) > 0`),
  ],
);

/** MOIETY-level interaction pairs. Ordered, unique, provenanced, optionally route-scoped. */
export const formularyInteractions = pgTable(
  "formulary_interactions",
  {
    id: text("id").primaryKey(), // ULID via newId()
    saltAId: text("salt_a_id").notNull().references(() => formularySalts.id),
    saltBId: text("salt_b_id").notNull().references(() => formularySalts.id),
    /** 'severe' → hard warning with an override reason. 'moderate' → a soft notice, never a gate. */
    severity: text("severity").notNull(),
    /** One clinical line. This text IS the alert a doctor reads, so it is notNull. */
    note: text("note").notNull(),
    /** Where the pair came from — 'seed-2026-08', a dataset name, a curator's ruling. */
    source: text("source").notNull(),
    /** 'systemic_only' or null (all routes) — DD7's noise control for gels and drops. */
    routeScope: text("route_scope"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("formulary_interactions_pair_ux").on(t.saltAId, t.saltBId),
    check("formulary_interactions_ordered_ck", sql`${t.saltAId} < ${t.saltBId}`),
    check("formulary_interactions_severity_ck", sql`${t.severity} in ('severe', 'moderate')`),
    check(
      "formulary_interactions_route_scope_ck",
      sql`${t.routeScope} is null or ${t.routeScope} = 'systemic_only'`,
    ),
  ],
);

/**
 * MINED ROWS, AND NOTHING ELSE READS THEM. Spec §1.1's isolation law: a pending row is invisible
 * to every resolution path (T3 asserts it by fixture), because seed is never authority — a scraped
 * composition reaches a live table only when a pharmacist admits it, one item at a time.
 */
export const formularyStaging = pgTable(
  "formulary_staging",
  {
    id: text("id").primaryKey(), // ULID via newId()
    kind: text("kind").notNull(), // 'medicine' today; 'salt' and 'interaction' are the extension points
    name: text("name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    sourceUrl: text("source_url").notNull(),
    minedAt: timestamp("mined_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** The medicine this row became on admission. Provenance back-link, not a foreign key. */
    medicineId: text("medicine_id"),
  },
  (t) => [
    check("formulary_staging_kind_ck", sql`${t.kind} in ('medicine')`),
    check("formulary_staging_status_ck", sql`${t.status} in ('pending', 'approved', 'rejected')`),
  ],
);
