import { sql } from "drizzle-orm";
import { setupTestDb } from "../../../../test/helpers/db";
import type { ChoiceClient, ChooseInput, PredicateClient, PredicateInput } from "../../../kernel/inference/types";
import type { Db } from "../../../kernel/db/client";
import type { AliasCandidateRow } from "../../formulary";
import { proposeAlias, spellingCorrection } from "../alias-pipeline";
import type { AliasDeps, AliasProposal, MedicineAbbreviation, SpellingNeighbours } from "../alias-pipeline";
import type { LasaPair } from "../consult-guards";

/**
 * SPEC #613 item 4 — MISSPELLINGS AND ABBREVIATIONS (docs/specs/613-alias-misspelling.md).
 * One block per "Done means" id. The models are fakes that record what they were shown; D5 reads the
 * migrated table. Moiety names are real; the brand names are made up.
 */
const row = (id: string, name: string, salts: string[], over: Partial<AliasCandidateRow> = {}): AliasCandidateRow =>
  ({ id, name, form: "Oral tablet", scheduleFlag: null, generic: false, salts, ndps: false, tier: 2, similarity: 1, ...over });

const PCM650 = row("m_pcm650", "Paracetamol 650 mg oral tablet", ["paracetamol"], { generic: true });
const PANTO40 = row("m_panto40", "Pantoprazole 40 mg gastro-resistant oral tablet", ["pantoprazole"], { generic: true, form: "Gastro-resistant oral tablet" });
const AMOX500 = row("m_amox500", "Amoxicillin 500 mg oral capsule", ["amoxicillin"], { generic: true, form: "Oral capsule" });
const METFORMIN500 = row("m_met500", "Metformin hydrochloride 500 mg oral tablet", ["metformin"], { generic: true });
const TRAMADOL50 = row("m_tram50", "Tramadol hydrochloride 50 mg oral capsule", ["tramadol"], { generic: true, ndps: true });
const BY_WORD: Record<string, AliasCandidateRow[]> = {
  paracetamol: [PCM650], pantoprazole: [PANTO40], amoxicillin: [AMOX500], metformin: [METFORMIN500], tramadol: [TRAMADOL50],
};

/** The moieties a catalogue near these words holds — every near neighbour the rule must see. */
const MOIETIES = [
  "paracetamol", "pantoprazole", "lansoprazole", "amoxicillin", "oxacillin", "ampicillin", "cloxacillin",
  "glipizide", "glimepiride", "amiodarone", "amlodipine", "carbamazepine", "oxcarbazepine", "glibenclamide", "gliclazide",
  "metformin", "metronidazole", "tramadol", "trazodone", "hydrochlorothiazide", "ciprofloxacin",
];
const NEIGHBOURS: SpellingNeighbours = {
  moieties: MOIETIES,
  brands: [
    { name: "Amoxycillin (amoxicillin) 500 mg oral capsule", salts: ["amoxicillin"] }, // a brand that IS the moiety
    { name: "Zolapan (pantoprazole) 40 mg oral tablet", salts: ["pantoprazole"] },
  ],
};
const LASA: LasaPair[] = [
  { a: "glibenclamide", b: "gliclazide", reviewed: false }, { a: "glimepiride", b: "glipizide", reviewed: false },
  { a: "metformin", b: "metronidazole", reviewed: false },
  { a: "carbamazepine", b: "oxcarbazepine", reviewed: false },
];

type Seen = { choose: ChooseInput[]; predicate: PredicateInput[]; candidates: string[] };
function deps(abbreviations: MedicineAbbreviation[] = [], pool: Record<string, AliasCandidateRow[]> = BY_WORD): { deps: AliasDeps; seen: Seen } {
  const seen: Seen = { choose: [], predicate: [], candidates: [] };
  const chooser: ChoiceClient = {
    choose: (input) => { seen.choose.push(input); return Promise.resolve({ model: "jev-test", answers: { product: { choice: "c1", confidence: 0.99, probabilities: { c1: 0.99 } } } }); },
  };
  const reviewer: ChoiceClient & PredicateClient = {
    predicate: (input) => { seen.predicate.push(input); return Promise.resolve({ probability: 0.99, model: "luna-test" }); },
    choose: () => Promise.resolve({ model: "luna-test", answers: { reason: { choice: "strength_match", confidence: 0.9, probabilities: { strength_match: 0.9 } } } }),
  };
  return {
    seen,
    deps: {
      enabled: true,
      candidates: (words) => { seen.candidates.push(words); return Promise.resolve(pool[words] ?? []); },
      lasa: () => Promise.resolve(LASA),
      chooser, reviewer, chooserLine: 0.95, reviewerLine: 0.9,
      spelling: { neighbours: () => Promise.resolve(NEIGHBOURS), abbreviations: () => Promise.resolve(abbreviations) },
    },
  };
}
const ran = (p: AliasProposal): Extract<AliasProposal, { outcome: "ran" }> => {
  if (p.outcome !== "ran") throw new Error("the pipeline was off");
  return p;
};

describe("spec #613 — medicine aliases: misspellings and abbreviations", () => {
  describe("spec #613 D1 — a misspelt generic reaches both models corrected", () => {
    it.each([
      ["paracetmol 650", "paracetamol 650", PCM650.id],
      ["pantaprazole 40", "pantoprazole 40", PANTO40.id],
      ["amoxycillin 500", "amoxicillin 500", AMOX500.id],
    ])("%s → %s", async (typed, corrected, id) => {
      const { deps: d, seen } = deps();
      const p = ran(await proposeAlias(d, typed));
      expect(seen.choose[0]?.state).toMatchObject({ term: corrected, read_as: corrected });
      expect(seen.predicate[0]?.state).toMatchObject({ term: corrected, read_as: corrected });
      expect(p.term).toBe(typed);
      expect(p.medicineId).toBe(id);
      expect(p.state).toBe("suggestion");
    });
  });

  describe("spec #613 D2 — a word near two moieties, a look-alike target or a changed beginning is not corrected", () => {
    it.each(["glimipizide", "carbazepine", "glibenclazide", "amlodarone"])("%s", (word) => {
      expect(spellingCorrection(word, NEIGHBOURS, LASA)).toBeNull();
    });
    it("and the models are shown the word as typed", async () => {
      const { deps: d, seen } = deps([], { glimipizide: [row("m_glip5", "Glipizide 5 mg oral tablet", ["glipizide"], { tier: 0, similarity: 0.6 })] });
      await proposeAlias(d, "glimipizide 5");
      expect(seen.choose[0]?.state).toMatchObject({ term: "glimipizide 5" });
    });
  });

  describe("spec #613 D3 — controlled and look-alike refusals are unchanged", () => {
    it("a word that corrects to a controlled medicine is refused before any model call", async () => {
      const { deps: d, seen } = deps();
      const p = ran(await proposeAlias(d, "tramadl 50"));
      expect(p.refusal).toBe("controlled_drug");
      expect(seen.choose).toHaveLength(0);
      expect(seen.predicate).toHaveLength(0);
    });
    it("a misspelt term whose target is on the look-alike list is not corrected and is refused as a look-alike conflict", async () => {
      const { deps: d, seen } = deps([], { metformine: [{ ...METFORMIN500, tier: 0, similarity: 0.7 }] });
      const p = ran(await proposeAlias(d, "metformine 500"));
      expect(seen.choose[0]?.state).toMatchObject({ term: "metformine 500" });
      expect(p.refusal).toBe("lookalike_conflict");
    });
    it("not a medicine stays not a medicine: no correction, no candidates, no model", async () => {
      const { deps: d, seen } = deps();
      const p = ran(await proposeAlias(d, "bukhar"));
      expect(p.refusal).toBe("no_candidates");
      expect(p.correction).toBeNull();
      expect(seen.choose).toHaveLength(0);
    });
  });

  describe("spec #613 D4 — only a signed, active abbreviation row is used", () => {
    it("unsigned: the models see the abbreviation as typed", async () => {
      const { deps: d, seen } = deps([{ abbreviation: "amox", moiety: "amoxicillin", active: true, signed: false }], { ...BY_WORD, amox: [] });
      const p = ran(await proposeAlias(d, "amox 500"));
      expect(p.correction).toBeNull();
      expect(seen.choose).toHaveLength(0);
      expect(seen.candidates).not.toContain("amoxicillin");
    });
    it("signed: \"amox 500\" reaches the chooser as \"amoxicillin 500\"", async () => {
      const { deps: d, seen } = deps([{ abbreviation: "amox", moiety: "amoxicillin", active: true, signed: true }], { ...BY_WORD, amox: [] });
      const p = ran(await proposeAlias(d, "amox 500"));
      expect(seen.choose[0]?.state).toMatchObject({ term: "amoxicillin 500" });
      expect(p.correction).toEqual({ kind: "abbreviation", from: "amox", to: "amoxicillin" });
      expect(p.medicineId).toBe(AMOX500.id);
    });
    it("signed but switched off: not used", async () => {
      const { deps: d, seen } = deps([{ abbreviation: "amox", moiety: "amoxicillin", active: false, signed: true }], { ...BY_WORD, amox: [] });
      ran(await proposeAlias(d, "amox 500"));
      expect(seen.choose).toHaveLength(0);
    });
  });

  describe("spec #613 D5 — the shipped abbreviation list is unsigned", () => {
    let db: Db;
    let teardown: () => Promise<void>;
    beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
    afterAll(async () => { await teardown(); });

    it("ships proposed rows, none signed, and refuses a row marked signed without a signer", async () => {
      const rows = (await db.execute(sql`select abbreviation, moiety, active, reviewed_by, reviewed_at from opd_medicine_abbreviations`)).rows as { reviewed_by: string | null; reviewed_at: string | null }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.reviewed_by === null && r.reviewed_at === null)).toBe(true);
      await expect(db.execute(sql`insert into opd_medicine_abbreviations (id, abbreviation, moiety, reviewed_at) values ('t1', 'zzq', 'zzqmoiety', now())`)).rejects.toThrow();
    });
  });

  describe("spec #613 D6 — the proposal records the correction it made", () => {
    it("a spelling correction is recorded; an exact name records none", async () => {
      const a = ran(await proposeAlias(deps().deps, "paracetmol 650"));
      expect(a.correction).toEqual({ kind: "spelling", from: "paracetmol", to: "paracetamol" });
      const b = ran(await proposeAlias(deps().deps, "paracetamol 650"));
      expect(b.correction).toBeNull();
    });
  });
});
