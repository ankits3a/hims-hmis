import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  formularyInteractions, formularyMedicineSalts, formularyMedicines, formularySalts, formularyStaging,
} from "./index";
import type { Db } from "../client";

/**
 * PLAN 16a T1 — the five formulary tables, pinned by EXECUTION against the real migration.
 *
 * The census legs below read `information_schema` rather than the drizzle objects, and that is the
 * §2.88 discipline rather than fussiness: comparing the schema file to itself would pass for any
 * migration at all, including one that never ran. What is asserted here is what POSTGRES has.
 *
 * Every name, moiety and brand in this file is a REAL pharmacological fact used as a fixture —
 * amoxicillin IS a penicillin, Augmentin IS amoxicillin + clavulanic acid, warfarin × aspirin IS a
 * severe pair. Fixtures that lie about pharmacology would make the later check-suite tests
 * meaningless even while green.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };

/**
 * The tables this module owns, and the columns each must have. A DROP in a later migration fails here.
 *
 * TWO THINGS THIS CENSUS LEARNED THE HARD WAY, 2026-09-13, both from migration 0082:
 *
 * 1. **The loop at the bottom throws on the FIRST mismatch**, so one stale entry stops the other
 *    tables being compared at all. `formulary_salts` gained `sctid` and this map did not, and for
 *    the length of that branch the census was blind to the four tables after it — the instrument
 *    reporting a failure was also the instrument that stopped measuring. The assertion is now
 *    accumulate-then-compare, so every table is reported in one run.
 * 2. **A NEW table is invisible to a census keyed by the tables it already knows.** 0082 added
 *    `formulary_generics` and `formulary_generic_salts` and nothing here noticed, because nothing
 *    here asks the database what formulary tables EXIST. The completeness leg below does ask.
 */
const CENSUS: Record<string, string[]> = {
  formulary_salts: ["active", "aliases", "atc_code", "created_at", "created_by", "drug_class", "id", "name", "sctid", "updated_at", "updated_by"],
  formulary_medicines: ["active", "brand_name", "created_at", "created_by", "form", "id", "route_class", "schedule_flag", "staging_id", "strength_label", "updated_at", "updated_by"],
  formulary_medicine_salts: ["medicine_id", "salt_id", "strength"],
  formulary_interactions: ["active", "created_at", "created_by", "id", "note", "route_scope", "salt_a_id", "salt_b_id", "severity", "source", "updated_at", "updated_by"],
  formulary_staging: ["id", "kind", "medicine_id", "mined_at", "name", "payload", "reviewed_at", "reviewed_by", "source_url", "status"],
  formulary_generics: ["active", "composition_summary", "created_at", "created_by", "dose_form", "id", "name", "route_of_administration", "sctid", "source", "updated_at", "updated_by"],
  formulary_generic_salts: ["generic_id", "salt_id", "strength", "unit"],
};

describe("the formulary tables (Plan 16a T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function columnsOf(table: string): Promise<string[]> {
    const rows = (await db.execute(sql`
      select column_name as "columnName" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by column_name asc
    `)).rows as { columnName: string }[];
    return rows.map((r) => r.columnName);
  }

  /** amoxicillin + clavulanic acid, and the brand that made this phase necessary. */
  async function seedAugmentin(): Promise<void> {
    await db.insert(formularySalts).values([
      { id: "S-AMOX", name: "amoxicillin", aliases: ["amoxycillin"], drugClass: "penicillin", ...AUDIT },
      { id: "S-CLAV", name: "clavulanic acid", ...AUDIT },
    ]);
    await db.insert(formularyMedicines).values({ id: "M-AUG", brandName: "Augmentin 625", form: "tablet", ...AUDIT });
    await db.insert(formularyMedicineSalts).values([
      { medicineId: "M-AUG", saltId: "S-AMOX", strength: "500 mg" },
      { medicineId: "M-AUG", saltId: "S-CLAV", strength: "125 mg" },
    ]);
  }

  // ─────────────────────────────────── the census ───────────────────────────────────

  it("every censused table exists with exactly the columns named — ALL of them, in one run", async () => {
    // Accumulate, then compare once. A per-table `expect` inside the loop throws on the first
    // mismatch and leaves every later table unmeasured, which is how one stale entry hid four
    // tables for the length of a branch.
    const actual: Record<string, string[]> = {};
    for (const table of Object.keys(CENSUS)) actual[table] = await columnsOf(table);
    expect(actual).toEqual(CENSUS);
  });

  it("no formulary table exists that this census does not know about", async () => {
    // The leg that would have caught 0082 adding two tables in silence. A census keyed by the
    // tables it already knows cannot report one it has never heard of, so this asks Postgres.
    const rows = (await db.execute(sql`
      select table_name as "tableName" from information_schema.tables
      where table_schema = 'public' and table_name like 'formulary_%' order by table_name asc
    `)).rows as { tableName: string }[];
    expect(rows.map((r) => r.tableName).sort()).toEqual(Object.keys(CENSUS).sort());
  });

  // ─────────────────────────── identity is the moiety, case-free ───────────────────────────

  it("one moiety is one row: 'Amoxicillin' cannot join 'amoxicillin'", async () => {
    await db.insert(formularySalts).values({ id: "S1", name: "amoxicillin", ...AUDIT });
    await expect(
      db.insert(formularySalts).values({ id: "S2", name: "Amoxicillin", ...AUDIT }),
    ).rejects.toThrow(/formulary_salts_name_lower_ux/);
  });

  it("one brand is one row, case-free too", async () => {
    await db.insert(formularyMedicines).values({ id: "M1", brandName: "Augmentin 625", form: "tablet", ...AUDIT });
    await expect(
      db.insert(formularyMedicines).values({ id: "M2", brandName: "AUGMENTIN 625", form: "tablet", ...AUDIT }),
    ).rejects.toThrow(/formulary_medicines_brand_lower_ux/);
  });

  it("aliases defaults to an empty array, so a reader never has to handle null", async () => {
    await db.insert(formularySalts).values({ id: "S1", name: "paracetamol", ...AUDIT });
    const rows = await db.select().from(formularySalts);
    expect(rows[0]!.aliases).toEqual([]);
  });

  it("a composition is the join, and a fixed-dose combination is simply more than one row", async () => {
    await seedAugmentin();
    const rows = await db.select().from(formularyMedicineSalts);
    expect(rows.map((r) => r.saltId).sort()).toEqual(["S-AMOX", "S-CLAV"]);
    // The same salt twice on one medicine is a data error, not a stronger dose.
    await expect(
      db.insert(formularyMedicineSalts).values({ medicineId: "M-AUG", saltId: "S-AMOX", strength: "250 mg" }),
    ).rejects.toThrow(/formulary_medicine_salts_medicine_id_salt_id_pk/);
  });

  it("a composition cannot name a moiety the formulary does not have", async () => {
    await db.insert(formularyMedicines).values({ id: "M1", brandName: "Invented Brand", form: "tablet", ...AUDIT });
    await expect(
      db.insert(formularyMedicineSalts).values({ medicineId: "M1", saltId: "S-NOSUCH" }),
    ).rejects.toThrow(/formulary_medicine_salts_salt_id_formulary_salts_id_fk/);
  });

  // ─────────────────────── the ordered pair: A×B and B×A are ONE fact ───────────────────────

  /**
   * THE CONSTRAINT THIS TABLE EXISTS FOR. Stored unordered, the same interaction can be entered
   * twice in opposite orders, and then how many hits a prescription raises depends on which way a
   * curator typed it. The check makes the reversed row UNSTORABLE.
   */
  it("a reversed pair is refused by the ordering check, not merely discouraged", async () => {
    await db.insert(formularySalts).values([
      { id: "S-A", name: "warfarin", ...AUDIT },
      { id: "S-B", name: "aspirin", drugClass: "nsaid", ...AUDIT },
    ]);
    await expect(
      db.insert(formularyInteractions).values({
        id: "I1", saltAId: "S-B", saltBId: "S-A", // B > A — the wrong way round
        severity: "severe", note: "bleeding risk", source: "seed-2026-08", ...AUDIT,
      }),
    ).rejects.toThrow(/formulary_interactions_ordered_ck/);
  });

  it("the same pair cannot be entered twice", async () => {
    await db.insert(formularySalts).values([
      { id: "S-A", name: "warfarin", ...AUDIT },
      { id: "S-B", name: "aspirin", ...AUDIT },
    ]);
    const pair = { saltAId: "S-A", saltBId: "S-B", severity: "severe", note: "bleeding risk", source: "seed-2026-08", ...AUDIT };
    await db.insert(formularyInteractions).values({ id: "I1", ...pair });
    await expect(
      db.insert(formularyInteractions).values({ id: "I2", ...pair, note: "entered again by another curator" }),
    ).rejects.toThrow(/formulary_interactions_pair_ux/);
  });

  it("a pair with no severity the check suite understands cannot be stored", async () => {
    await db.insert(formularySalts).values([
      { id: "S-A", name: "warfarin", ...AUDIT },
      { id: "S-B", name: "aspirin", ...AUDIT },
    ]);
    await expect(
      db.insert(formularyInteractions).values({
        id: "I1", saltAId: "S-A", saltBId: "S-B",
        severity: "mild", note: "n/a", source: "seed-2026-08", ...AUDIT,
      }),
    ).rejects.toThrow(/formulary_interactions_severity_ck/);
    await expect(
      db.insert(formularyInteractions).values({
        id: "I2", saltAId: "S-A", saltBId: "S-B", routeScope: "topical_only",
        severity: "severe", note: "n/a", source: "seed-2026-08", ...AUDIT,
      }),
    ).rejects.toThrow(/formulary_interactions_route_scope_ck/);
  });

  // ─────────────────────────── the closed value sets on a medicine ───────────────────────────

  it("route class is two buckets and a schedule flag is one of four or nothing", async () => {
    await expect(
      db.insert(formularyMedicines).values({ id: "M1", brandName: "Inhaled Thing", form: "inhaler", routeClass: "inhaled", ...AUDIT }),
    ).rejects.toThrow(/formulary_medicines_route_class_ck/);
    await expect(
      db.insert(formularyMedicines).values({ id: "M2", brandName: "Mystery Schedule", form: "tablet", scheduleFlag: "Z", ...AUDIT }),
    ).rejects.toThrow(/formulary_medicines_schedule_flag_ck/);
    // null is legal — most of the formulary will be unclassified on day one.
    await db.insert(formularyMedicines).values({ id: "M3", brandName: "Unclassified Thing", form: "tablet", ...AUDIT });
    const rows = await db.select().from(formularyMedicines);
    expect({ n: rows.length, flag: rows[0]!.scheduleFlag, route: rows[0]!.routeClass })
      .toEqual({ n: 1, flag: null, route: "systemic" });
  });

  // ──────────────────────────────── staging is a dictionary ────────────────────────────────

  it("a mined row lands pending, and only the three review states are storable", async () => {
    await db.insert(formularyStaging).values({
      id: "G1", kind: "medicine", name: "Invented Mined Brand",
      payload: { salts: ["invented moiety"], form: "tablet" },
      sourceUrl: "https://example.invalid/invented", minedAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const rows = await db.select().from(formularyStaging);
    expect({ status: rows[0]!.status, reviewedBy: rows[0]!.reviewedBy, medicineId: rows[0]!.medicineId })
      .toEqual({ status: "pending", reviewedBy: null, medicineId: null });
    await expect(
      db.insert(formularyStaging).values({
        id: "G2", kind: "medicine", name: "Another", payload: {},
        sourceUrl: "https://example.invalid/another", minedAt: new Date("2026-08-26T00:00:00.000Z"),
        status: "admitted",
      }),
    ).rejects.toThrow(/formulary_staging_status_ck/);
  });

  /**
   * The back-links are TEXT in both directions, and this test is what stops a later reader
   * "fixing" that into a mutual foreign-key pair the tables could not be inserted through.
   */
  it("staging and medicine point at each other without a foreign key in either direction", async () => {
    await seedAugmentin();
    await db.insert(formularyStaging).values({
      id: "G1", kind: "medicine", name: "Augmentin 625", payload: { brand: "Augmentin 625" },
      sourceUrl: "https://example.invalid/aug", minedAt: new Date("2026-08-26T00:00:00.000Z"),
      status: "approved", reviewedBy: "pharmacist-1", reviewedAt: new Date("2026-08-26T01:00:00.000Z"),
      medicineId: "M-AUG",
    });
    await db.update(formularyMedicines).set({ stagingId: "G1", updatedBy: "t" });
    const [staged] = await db.select().from(formularyStaging);
    const [med] = await db.select().from(formularyMedicines);
    expect({ medicineId: staged!.medicineId, stagingId: med!.stagingId }).toEqual({ medicineId: "M-AUG", stagingId: "G1" });
    // A staging row may name a medicine that no longer exists — history, not a parent.
    await db.insert(formularyStaging).values({
      id: "G2", kind: "medicine", name: "Withdrawn Thing", payload: {},
      sourceUrl: "https://example.invalid/gone", minedAt: new Date("2026-08-26T00:00:00.000Z"),
      status: "approved", medicineId: "M-DELETED-LONG-AGO",
    });
    expect((await db.select().from(formularyStaging)).length).toBe(2);
  });
});
