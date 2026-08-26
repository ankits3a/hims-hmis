import { sql } from "drizzle-orm";
import {
  boolean, check, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
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
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    // Case-insensitive uniqueness: "Amoxicillin" and "amoxicillin" are one moiety, and two rows
    // for one moiety would split every check that groups by it.
    uniqueIndex("formulary_salts_name_lower_ux").using("btree", sql`lower(${t.name})`),
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
    /** Provenance back-link, not a foreign key — see the header. */
    stagingId: text("staging_id"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("formulary_medicines_brand_lower_ux").using("btree", sql`lower(${t.brandName})`),
    check("formulary_medicines_route_class_ck", sql`${t.routeClass} in ('systemic', 'topical')`),
    check(
      "formulary_medicines_schedule_flag_ck",
      sql`${t.scheduleFlag} is null or ${t.scheduleFlag} in ('H', 'H1', 'X', 'OTC')`,
    ),
  ],
);

/** The composition join — a fixed-dose combination is simply a medicine with more than one row. */
export const formularyMedicineSalts = pgTable(
  "formulary_medicine_salts",
  {
    medicineId: text("medicine_id").notNull().references(() => formularyMedicines.id),
    saltId: text("salt_id").notNull().references(() => formularySalts.id),
    /** Per-salt strength, e.g. '500 mg' on the amoxicillin row of an Augmentin 625. */
    strength: text("strength"),
  },
  (t) => [primaryKey({ columns: [t.medicineId, t.saltId] })],
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
