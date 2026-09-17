import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { DRUG_DISEASE_RULES_2026_09_17 } from "../../../scripts/data/drug-disease-rules-2026-09-17";
import { withTx } from "../../kernel/db/client";
import { formularyDrugDisease, formularySalts, formularySubstances } from "../../kernel/db/schema";
import { adoptDrugDisease } from "./drug-disease-adoption";
import { addSalt } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DrugDiseaseRule } from "./drug-disease-adoption";

/**
 * ═══ FORMULARY P24 — WHAT THE PATIENT'S DIAGNOSIS FORBIDS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p24-drug-disease.md`.
 */
const CURATOR: Actor = { type: "user", id: "01HCURATOR0000000000000001" };
const RESOLUTION = "owner-resolution-2026-09-17-drug-disease";

const rowsOf = (book: readonly DrugDiseaseRule[]) =>
  book.flatMap((r) => r.moieties.map((m) => ({ moiety: m.toLowerCase(), prefix: r.prefix, severity: r.severity })));

/** Does any rule in the book reach this diagnosis code? The check's own question, asked here. */
const reaches = (book: readonly DrugDiseaseRule[], code: string) =>
  book.filter((r) => code.startsWith(r.prefix)).map((r) => r.rule);

describe("the 2026-09-17 drug-disease book", () => {
  const book = DRUG_DISEASE_RULES_2026_09_17;

  it("is well formed: 27 rules over 19 prefixes, 148 moiety rows, and no row written twice", () => {
    expect(book).toHaveLength(27);
    expect(new Set(book.map((r) => r.prefix)).size).toBe(19);
    expect(new Set(book.map((r) => r.rule)).size).toBe(16);

    const rows = rowsOf(book);
    expect(rows).toHaveLength(148);
    expect(rows.filter((r) => r.severity === "severe")).toHaveLength(142);
    expect(rows.filter((r) => r.severity === "moderate")).toHaveLength(6);
    expect(new Set(rows.map((r) => r.moiety)).size).toBe(56);
    expect(new Set(rows.map((r) => `${r.moiety}|${r.prefix}`)).size).toBe(rows.length);

    for (const r of book) {
      expect(r.prefix).toMatch(/^[A-Z][A-Z0-9]{2}([.][A-Z0-9]{1,3})?$/);
      expect(r.title.trim()).not.toBe("");
      expect(r.note.trim()).not.toBe("");
      expect(r.moieties.length).toBeGreaterThan(0);
    }
  });

  it("never offers a drug that the same rule forbids", () => {
    for (const r of book) {
      const forbidden = new Set(r.moieties.map((m) => m.toLowerCase()));
      for (const a of r.alternatives ?? []) expect(forbidden.has(a.moiety.toLowerCase())).toBe(false);
    }
  });

  /**
   * The two splits of D1. These are the reason the book is not keyed the way its source is, so they
   * are asserted on the CODES a doctor actually assigns, not on the shape of the prefix strings.
   */
  it("leaves open-angle glaucoma alone and still catches the closable angle", () => {
    expect(reaches(book, "H40.11")).toEqual([]); // primary open-angle glaucoma — anticholinergics are safe
    expect(reaches(book, "H40.10")).toEqual([]);
    expect(reaches(book, "H40.9")).toEqual([]); // unspecified glaucoma: not evidence of a narrow angle
    expect(reaches(book, "H40.21")).toEqual(["icd10_contraindications#9"]); // acute angle-closure
    expect(reaches(book, "H40.031")).toEqual(["icd10_contraindications#9"]); // anatomical narrow angle
  });

  it("lets metformin through at CKD stages 1 and 2, caps it at 3b, and stops it at stage 4", () => {
    const metforminAt = (code: string) =>
      book.filter((r) => code.startsWith(r.prefix) && r.moieties.includes("metformin"))
        .map((r) => r.severity);
    expect(metforminAt("N18.1")).toEqual([]);
    expect(metforminAt("N18.2")).toEqual([]);
    expect(metforminAt("N18.31")).toEqual([]); // stage 3a — the dose is not capped yet
    expect(metforminAt("N18.32")).toEqual(["moderate"]);
    expect(metforminAt("N18.4")).toEqual(["severe"]);
    expect(metforminAt("N18.6")).toEqual(["severe"]);
    // And the NSAID rule is graded differently, from stage 3 — the departure that split rule #8.
    expect(reaches(book, "N18.31")).toEqual(["icd10_contraindications#8a"]);
  });

  it("offers nothing for the cirrhotic liver, because a laxative does not replace methotrexate", () => {
    const liver = book.filter((r) => r.rule === "icd10_contraindications#13");
    expect(liver.map((r) => r.prefix).sort()).toEqual(["K70", "K74"]);
    for (const r of liver) expect(r.alternatives ?? []).toEqual([]);
  });

  it("carries the asthma beta-blocker rule at every route, because timolol drops reach the lung", () => {
    const asthmaBeta = book.find((r) => r.prefix === "J45" && r.moieties.includes("timolol"));
    expect(asthmaBeta?.routeScope ?? null).toBeNull();
    // while the NSAID rules are route-scoped: a gel does not perforate an ulcer
    const ulcer = book.find((r) => r.prefix === "K25");
    expect(ulcer?.routeScope).toBe("systemic_only");
  });

  it("spells every name the way the national release does", () => {
    const names = new Set(rowsOf(book).map((r) => r.moiety));
    for (const theirs of ["dicyclomine", "indomethacin", "chlorthalidone", "torsemide", "acetylsalicylic acid"]) {
      expect(names.has(theirs)).toBe(false);
    }
    for (const ours of ["dicycloverine", "indometacin", "chlortalidone", "torasemide", "aspirin"]) {
      expect(names.has(ours)).toBe(true);
    }
  });
});

describe("adopting drug-disease rules by resolution (P24)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const salt = (name: string) => withTx(db, (tx) => addSalt(tx, CURATOR, { name })).then((r) => r.saltId);
  const adopt = (rules: readonly DrugDiseaseRule[], actor: Actor = CURATOR) =>
    withTx(db, (tx) => adoptDrugDisease(tx, actor, RESOLUTION, rules));
  const rule = (over: Partial<DrugDiseaseRule> = {}): DrugDiseaseRule => ({
    rule: "icd10_contraindications#0", prefix: "J45", title: "Asthma", moieties: ["propranolol"],
    severity: "severe", note: "Bronchospasm — avoid.", ...over,
  });

  it("writes a row per moiety under the resolution, and waits for a name that is not a moiety yet", async () => {
    await salt("propranolol");
    await salt("Timolol");
    // A release entry nobody has decided is not a moiety, so no rule may point at it yet.
    const nadolol = newId();
    await db.insert(formularySalts).values({ id: nadolol, name: "Nadolol", sourceRef: "SCT-NAD", createdBy: CURATOR.id, updatedBy: CURATOR.id });
    await db.insert(formularySubstances).values({ id: newId(), sctid: "SCT-NAD", name: "Nadolol", mappingStatus: "pending", source: "nrces-2026-09", createdBy: CURATOR.id, updatedBy: CURATOR.id });

    const report = await adopt([rule({ moieties: ["propranolol", "timolol", "nadolol", "sotalol"] })]);

    expect(report).toEqual({
      resolution: RESOLUTION, created: { severe: 2, moderate: 0 }, alreadyRecorded: 0, skipped: 2,
      missing: [{ name: "nadolol", rows: 1 }, { name: "sotalol", rows: 1 }], alternativesUnknown: [],
    });
    const rows = await db.select().from(formularyDrugDisease);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.source).toBe(`resolution:${RESOLUTION} (icd10_contraindications#0)`);
    expect(rows[0]?.icd10Title).toBe("Asthma");
  });

  it("is idempotent, and never touches a row already recorded", async () => {
    await salt("propranolol");
    await adopt([rule()]);
    const first = await db.select().from(formularyDrugDisease);

    const again = await adopt([rule({ severity: "moderate", note: "A softened line." })]);

    expect(again.alreadyRecorded).toBe(1);
    expect(again.created).toEqual({ severe: 0, moderate: 0 });
    const rows = await db.select().from(formularyDrugDisease);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("severe"); // the resolution did not overwrite what was there
    expect(rows[0]?.id).toBe(first[0]?.id);
  });

  it("keeps the offers that resolve, and reports the one that cannot", async () => {
    await salt("propranolol");
    await salt("amlodipine");

    const report = await adopt([rule({
      alternatives: [
        { moiety: "amlodipine", label: "Amlodipine 5 mg" },
        { moiety: "telmisartan", label: "Telmisartan 40 mg" },
      ],
    })]);

    expect(report.alternativesUnknown).toEqual(["telmisartan"]);
    const rows = await db.select().from(formularyDrugDisease);
    // A button that could never resolve is not stored: the doctor taps nothing that does nothing.
    expect(rows[0]?.alternatives).toEqual([{ moiety: "amlodipine", label: "Amlodipine 5 mg" }]);
  });

  it("refuses an actor who may not attest, and a rule the column would refuse anyway", async () => {
    await salt("propranolol");
    await expect(adopt([rule()], { type: "agent", id: "agent:claude" })).rejects.toThrow(/attester_not_user|may not decide/);
    await expect(adopt([rule({ prefix: "J4" })])).rejects.toThrow(/not an ICD-10 code prefix/);
    await expect(adopt([rule({ prefix: "j45" })])).rejects.toThrow(/not an ICD-10 code prefix/);
    await expect(adopt([rule({ note: "   " })])).rejects.toThrow(/has no note/);
    await expect(adopt([rule({ moieties: ["propranolol", "Propranolol"] })])).rejects.toThrow(/appears twice/);
    await expect(adopt([rule({
      alternatives: [{ moiety: "propranolol", label: "Propranolol 40 mg" }],
    })])).rejects.toThrow(/which the same rule forbids/);
    expect(await db.select().from(formularyDrugDisease)).toHaveLength(0);
  });
});
