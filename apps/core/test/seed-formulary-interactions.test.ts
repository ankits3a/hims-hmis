import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withTx } from "../src/kernel/db/client";
import { formularyInteractions, formularySalts } from "../src/kernel/db/schema";
import { updateInteraction } from "../src/modules/formulary";
import {
  SEED_CENSUS, SEED_SOURCE, formatReport, seedFormularyInteractions,
} from "../scripts/seed-formulary-interactions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 16a T9 — the starter seed.
 *
 * The test that carries the weight is the SECOND RUN. A seed that is run once at commissioning and
 * never again needs no idempotence; this one is in the deploy path, so every deployment re-runs it,
 * and the question that matters is what it does to a formulary a curator has since edited.
 */
const CURATOR: Actor = { type: "user", id: "01HCURATOR00000000000001" };

describe("seed:formulary — the severe-pair starter floor (Plan 16a T9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("seeds its census on an empty formulary, every pair severe and provenanced", async () => {
    const report = await seedFormularyInteractions(db);
    expect(report).toEqual({
      saltsCreated: SEED_CENSUS.salts, saltsExisting: 0,
      pairsCreated: SEED_CENSUS.pairs, pairsExisting: 0,
    });

    const salts = await db.select().from(formularySalts);
    const pairs = await db.select().from(formularyInteractions);
    expect(salts).toHaveLength(SEED_CENSUS.salts);
    expect(pairs).toHaveLength(SEED_CENSUS.pairs);

    // Every pair is severe, provenanced, and carries a note a doctor can act on rather than a label.
    for (const pair of pairs) {
      expect({ severity: pair.severity, source: pair.source }).toEqual({ severity: "severe", source: SEED_SOURCE });
      expect(pair.note.length).toBeGreaterThan(20);
      expect(pair.saltAId < pair.saltBId).toBe(true); // canonical ordering, by construction
    }
  });

  /**
   * THE SPOT CHECK, by name. Warfarin × aspirin is the pair every one of these tables opens with,
   * and the assertion is on the ORDERING and the PROVENANCE — the two properties that make the
   * table trustworthy — rather than on the row count, which the census above already holds.
   */
  it("a named pair is stored canonically, whichever way round the seed lists it", async () => {
    await seedFormularyInteractions(db);
    const [warfarin] = await db.select().from(formularySalts).where(eq(formularySalts.name, "warfarin"));
    const [aspirin] = await db.select().from(formularySalts).where(eq(formularySalts.name, "aspirin"));
    const [low, high] = warfarin!.id < aspirin!.id ? [warfarin!.id, aspirin!.id] : [aspirin!.id, warfarin!.id];

    const rows = await db.select().from(formularyInteractions).where(eq(formularyInteractions.saltAId, low));
    const pair = rows.find((r) => r.saltBId === high);
    expect(pair).toBeDefined();
    expect(pair!.source).toBe(SEED_SOURCE);
    expect(pair!.note).toContain("bleeding");

    // The class path's own input: aspirin is an NSAID, and that is what lets an allergy recorded
    // as "NSAID" catch it. Warfarin needs no class and is deliberately given none.
    expect(aspirin!.drugClass).toBe("nsaid");
    expect(warfarin!.drugClass).toBeNull();
  });

  it("a second run creates nothing at all", async () => {
    await seedFormularyInteractions(db);
    const second = await seedFormularyInteractions(db);
    expect(second).toEqual({
      saltsCreated: 0, saltsExisting: SEED_CENSUS.salts,
      pairsCreated: 0, pairsExisting: SEED_CENSUS.pairs,
    });
    expect(await db.select().from(formularySalts)).toHaveLength(SEED_CENSUS.salts);
    expect(await db.select().from(formularyInteractions)).toHaveLength(SEED_CENSUS.pairs);
  });

  /**
   * THE ONE THAT WOULD ACTUALLY HURT. §1.4's calibration loop exists so a curator can DOWNGRADE a
   * pair the hospital has decided is mis-graded. This seed is in the deploy path, so it runs again
   * on the next deployment — and if it "restored" the seeded severity it would undo a clinical
   * decision silently, on a Tuesday, with nobody in the room.
   */
  it("a re-run does not resurrect a severity the hospital deliberately downgraded", async () => {
    await seedFormularyInteractions(db);
    const [pair] = await db.select().from(formularyInteractions).limit(1);
    await withTx(db, (tx) => updateInteraction(tx, CURATOR, pair!.id, {
      severity: "moderate", note: "downgraded by the DTC after review",
    }));

    await seedFormularyInteractions(db);

    const [after] = await db.select().from(formularyInteractions).where(eq(formularyInteractions.id, pair!.id));
    expect({ severity: after!.severity, note: after!.note })
      .toEqual({ severity: "moderate", note: "downgraded by the DTC after review" });
  });

  it("a deactivated pair stays deactivated, for the same reason", async () => {
    await seedFormularyInteractions(db);
    const [pair] = await db.select().from(formularyInteractions).limit(1);
    await withTx(db, (tx) => updateInteraction(tx, CURATOR, pair!.id, { active: false }));

    await seedFormularyInteractions(db);

    const [after] = await db.select().from(formularyInteractions).where(eq(formularyInteractions.id, pair!.id));
    expect(after!.active).toBe(false);
  });

  it("says what it did, and says what it is NOT", async () => {
    const report = await seedFormularyInteractions(db);
    const lines = formatReport(report);
    expect(lines.join("\n")).toContain(`${String(SEED_CENSUS.pairs)} created`);
    // The operator reading a deploy transcript is told this is a floor, not a formulary.
    expect(lines.join("\n")).toContain("not a formulary");
    expect(lines.join("\n")).toContain(SEED_SOURCE);
  });
});
