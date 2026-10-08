import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { loadConfig } from "../../kernel/config";
import { cdsAliases, formularyMedicineSalts, formularyMedicines, formularySalts, opdLasaPairs } from "../../kernel/db/schema";
import { aliasCandidatePool, normalizeDrugName } from "../formulary";
import type { Db } from "../../kernel/db/client";
import type { AliasProposal } from "./alias-pipeline";
import { aliasDepsFrom, saveAliasProposal } from "./alias-store";

/**
 * DECISION 0051 — the alias pipeline's two database edges: the candidate pool it reads from the
 * formulary, and the `cds_aliases` row it writes. No model is called: with the switch off no client
 * is even built.
 */
const cfg = (over: Record<string, string> = {}) => loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!, ...over });
const NOW = new Date("2026-10-08T06:00:00.000Z");

describe("the alias pipeline's database edges", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  async function salt(id: string, name: string, ndpsClass: string | null = null): Promise<void> {
    await db.insert(formularySalts).values({ id, name, nameNormalized: name.toLowerCase(), ndpsClass, createdBy: "t", updatedBy: "t" } as never);
  }
  async function medicine(id: string, brand: string, form: string, salts: string[], over: { scheduleFlag?: string; code?: string; active?: boolean } = {}): Promise<void> {
    await db.insert(formularyMedicines).values({
      id, brandName: brand, nameNormalized: normalizeDrugName(brand), form, strengthLabel: null, scheduleFlag: over.scheduleFlag ?? null,
      code: over.code ?? null, active: over.active ?? true, createdBy: "t", updatedBy: "t",
    } as never);
    for (const saltId of salts) await db.insert(formularyMedicineSalts).values({ medicineId: id, saltId, source: "curated" } as never);
  }
  async function catalogue(): Promise<void> {
    await salt("s_panto", "Pantoprazole");
    await salt("s_domp", "Domperidone");
    await salt("s_tram", "tramadol", "psychotropic");
    await medicine("m_pan40", "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", ["s_panto"], { scheduleFlag: "H" });
    await medicine("m_pan20", "Pan (pantoprazole sodium) 20 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", ["s_panto"], { scheduleFlag: "H" });
    await medicine("m_pand", "Pan-D (domperidone and pantoprazole) 30 mg + 40 mg oral capsule", "Oral capsule", ["s_panto", "s_domp"], { scheduleFlag: "H" });
    await medicine("m_gen40", "Pantoprazole (as pantoprazole sodium) 40 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", ["s_panto"], { scheduleFlag: "H", code: "D8300" });
    await medicine("m_old", "Pan (pantoprazole sodium) 80 mg oral tablet", "Oral tablet", ["s_panto"], { active: false });
    await medicine("m_tram", "Tramazac (tramadol hydrochloride) 50 mg oral capsule", "Oral capsule", ["s_tram"], { scheduleFlag: "H1" });
  }

  describe("aliasCandidatePool (formulary)", () => {
    it("puts a row that prints the term's strength first, the one NAMED so before the merely near, and never an inactive row", async () => {
      await catalogue();
      const pool = await aliasCandidatePool(db, "pan", ["40"]);
      const ids = pool.map((r) => r.id);
      expect(ids[0]).toBe("m_pan40");
      // Every row printing "40 mg" comes before the Pan that does not, exact name or not.
      expect(ids.indexOf("m_pan20")).toBeGreaterThan(Math.max(ids.indexOf("m_pand"), ids.indexOf("m_gen40")));
      expect((await aliasCandidatePool(db, "pan")).map((r) => r.id).slice(0, 2).sort()).toEqual(["m_pan20", "m_pan40"]);
      expect(pool.find((r) => r.id === "m_pan40")).toMatchObject({ tier: 2, generic: false, salts: ["pantoprazole"], ndps: false, scheduleFlag: "H", form: "Gastro-resistant oral tablet" });
      expect(pool.map((r) => r.id)).not.toContain("m_old");
      // A name that merely starts like the term is near, not exact.
      expect(pool.find((r) => r.id === "m_gen40")?.tier).toBe(0);
    });

    it("finds a misspelt name by trigram, says which rows are generics, and carries the NDPS class", async () => {
      await catalogue();
      const pool = await aliasCandidatePool(db, "pantaprazol", ["40"]);
      expect(pool[0]).toMatchObject({ id: "m_gen40", generic: true, tier: 0 });
      expect(pool.map((r) => r.id)).toEqual(expect.arrayContaining(["m_pan40", "m_pan20", "m_pand"]));
      expect((await aliasCandidatePool(db, "tramazac"))[0]).toMatchObject({ id: "m_tram", ndps: true, scheduleFlag: "H1", salts: ["tramadol"] });
      expect((await aliasCandidatePool(db, "pan-d"))[0]).toMatchObject({ id: "m_pand", tier: 2, salts: ["domperidone", "pantoprazole"] });
    });

    it("has nothing for one letter, for no match, or for a LIKE wildcard typed as a name", async () => {
      await catalogue();
      expect(await aliasCandidatePool(db, "p")).toEqual([]);
      expect(await aliasCandidatePool(db, "zzqqxx")).toEqual([]);
      expect((await aliasCandidatePool(db, "%%")).length).toBe(0);
    });
  });

  describe("the kill switch (ALIAS_PIPELINE_ENABLED)", () => {
    it("is OFF by default, and off builds no model client even when both keys are set", () => {
      expect(cfg().aliases).toEqual({ enabled: false, chooserOrder: ["typesafe"], chooserLine: 0.95, reviewerLine: 0.9, perRun: 40, perDay: 300 });
      const off = aliasDepsFrom(db, cfg({ TRIAGE_TYPESAFE_API_KEY: "k", HMIS_OPENAI_KEY_FILE: "/nonexistent" }));
      expect(off).toMatchObject({ enabled: false, chooser: null, reviewer: null });
    });

    it("on, it runs with the configured lines and the chooser the order names", () => {
      const on = aliasDepsFrom(db, cfg({ ALIAS_PIPELINE_ENABLED: "true", TRIAGE_TYPESAFE_API_KEY: "k", ALIAS_CHOOSER_MIN_CONFIDENCE: "0.7", ALIAS_REVIEWER_MIN_PROBABILITY: "0.95" }));
      expect(on).toMatchObject({ enabled: true, chooserLine: 0.7, reviewerLine: 0.95, reviewer: null });
      expect(on.chooser).not.toBeNull();
    });

    it("reads the look-alike pairs through its own door", async () => {
      await db.insert(opdLasaPairs).values({ id: "l1", nameA: "metformin", nameB: "metronidazole" });
      const deps = aliasDepsFrom(db, cfg({ ALIAS_PIPELINE_ENABLED: "true" }));
      expect(await deps.lasa()).toEqual([{ a: "metformin", b: "metronidazole", reviewed: false }]);
    });
  });

  describe("saveAliasProposal", () => {
    const base = { outcome: "ran" as const, term: "pan forty", lasaGuard: false, shown: [] };
    const suggestion: AliasProposal = {
      ...base, state: "suggestion", medicineId: "m_pan40", refusal: null, ruleResult: "pass",
      chooser: { model: "jev-1.13.0", confidence: 0.91 }, reviewer: { model: "gpt-6-luna", answer: "yes", probability: 0.97, reasonCode: "brand_nickname" },
    };
    const refused: AliasProposal = {
      ...base, state: "proposed", medicineId: "m_pan40", refusal: "reviewer_unsure", ruleResult: "pass",
      chooser: { model: "jev-1.13.0", confidence: 0.91 }, reviewer: { model: "gpt-6-luna", answer: "unsure", probability: 0.6, reasonCode: "ambiguous_form" },
    };

    it("writes nothing when the pipeline was off", async () => {
      expect(await saveAliasProposal(db, { outcome: "off" }, NOW)).toBe("off");
      expect(await db.select().from(cdsAliases)).toEqual([]);
    });

    it("writes one row per term: the models' numbers and closed codes, no patient and no visit", async () => {
      expect(await saveAliasProposal(db, refused, NOW)).toBe("saved");
      const later = new Date(NOW.getTime() + 60_000);
      expect(await saveAliasProposal(db, suggestion, later)).toBe("saved");
      const rows = await db.select().from(cdsAliases);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "medicine", term: "pan forty", medicineId: "m_pan40", state: "suggestion", chooserName: "jev-1.13.0", chooserConfidence: 0.91,
        reviewerName: "gpt-6-luna", reviewerAnswer: "yes", reviewerProbability: 0.97, reasonCode: "brand_nickname", ruleResult: "pass", refusal: null,
        lasaGuard: false, distinctDoctors: 0, taps: 0, createdAt: NOW, updatedAt: later, auditedAt: later, undoneBy: null, undoneAt: null,
      });
      expect(Object.keys(rows[0] ?? {}).filter((k) => /patient|encounter|visit|uhid/i.test(k))).toEqual([]);
    });

    it("never re-learns what the owner undid, and never overwrites a row that is live", async () => {
      await saveAliasProposal(db, suggestion, NOW);
      expect(await saveAliasProposal(db, refused, NOW)).toBe("kept");
      await db.update(cdsAliases).set({ state: "undone", undoneBy: "u_owner", undoneAt: NOW }).where(eq(cdsAliases.term, "pan forty"));
      expect(await saveAliasProposal(db, suggestion, NOW)).toBe("kept");
      expect((await db.select().from(cdsAliases))[0]).toMatchObject({ state: "undone", undoneBy: "u_owner" });
    });

    it("the table itself refuses a row that could be SHOWN without a reviewer's yes and a clean rule check", async () => {
      const bad = { id: "a1", kind: "medicine", term: "pan forty", medicineId: "m_pan40", ruleResult: "pass", createdAt: NOW, updatedAt: NOW };
      await expect(db.insert(cdsAliases).values({ ...bad, state: "suggestion", reviewerAnswer: "unsure" })).rejects.toThrow();
      await expect(db.insert(cdsAliases).values({ ...bad, state: "suggestion", reviewerAnswer: "yes", ruleResult: "controlled_drug" })).rejects.toThrow();
      await expect(db.insert(cdsAliases).values({ ...bad, state: "trusted", reviewerAnswer: "yes", medicineId: null })).rejects.toThrow();
      await expect(db.insert(cdsAliases).values({ ...bad, state: "undone", reviewerAnswer: "yes" })).rejects.toThrow();
      await expect(db.insert(cdsAliases).values({ ...bad, state: "suggestion", reviewerAnswer: "yes", term: "Pan Forty" })).rejects.toThrow();
      await db.insert(cdsAliases).values({ ...bad, state: "suggestion", reviewerAnswer: "yes" });
    });
  });
});
