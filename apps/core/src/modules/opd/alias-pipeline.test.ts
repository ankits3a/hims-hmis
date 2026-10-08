import { InferenceUnavailable } from "../../kernel/inference/types";
import type { ChoiceClient, ChooseInput, PredicateClient, PredicateInput } from "../../kernel/inference/types";
import type { AliasCandidateRow } from "../formulary";
import {
  compositionKey, controlledBy, editDistance, formClassOf, headOf, isControlled, proposeAlias, readTerm, shownCandidates, spokenNumber, strengthAgrees, strengthsInName, trustByUse,
} from "./alias-pipeline";
import type { AliasDeps, AliasProposal, AliasReasonCode } from "./alias-pipeline";
import type { LasaPair } from "./consult-guards";

/**
 * DECISION 0051 / PLAN §7a — the automatic medicine-alias pipeline, with FAKE models. No test here
 * touches a network or a database: the catalogue rows are handed in, and each fake counts its calls.
 */
const row = (id: string, name: string, over: Partial<AliasCandidateRow> = {}): AliasCandidateRow => {
  const form = /injection/.test(name) ? "Powder for solution for injection" : /suspension/.test(name) ? "Oral suspension" : "Oral tablet";
  return { id, name, form, scheduleFlag: "H", generic: false, salts: [], ndps: false, tier: 2, similarity: 1, ...over };
};
const PAN40 = row("m_pan40", "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", { salts: ["pantoprazole"] });
const PAN20 = row("m_pan20", "Pan (pantoprazole sodium) 20 mg gastro-resistant oral tablet", { salts: ["pantoprazole"] });
const PAN40_INJ = row("m_pan40i", "Pan (pantoprazole sodium) 40 mg/1 vial powder for solution for injection", { salts: ["pantoprazole"] });
const DOLO650 = row("m_dolo650", "Dolo (paracetamol) 650 mg oral tablet", { salts: ["paracetamol"], scheduleFlag: null });
const AUG625 = row("m_aug625", "Augmentin DUO (amoxicillin and clavulanate potassium) 500 mg + 125 mg oral tablet", { salts: ["amoxicillin", "clavulanic acid"], scheduleFlag: null, tier: 1 });
const AUG1G = row("m_aug1g", "Augmentin DUO (amoxicillin and clavulanate potassium) 875 mg + 125 mg oral tablet", { salts: ["amoxicillin", "clavulanic acid"], scheduleFlag: null, tier: 1 });
const ALPRAX = row("m_alprax", "Alprax (alprazolam) 500 mcg oral tablet", { salts: ["alprazolam"], scheduleFlag: "H1" });
const KETAMINE = row("m_ket", "Ketamine 50 mg/mL solution for injection", { salts: ["ketamine"], scheduleFlag: "X", generic: true });
const MORPHINE = row("m_mor", "Morphine sulfate 10 mg oral tablet", { salts: ["morphine"], scheduleFlag: null, generic: true });
const TRAMADOL = row("m_tram", "Somethingol (tramadol hydrochloride) 50 mg oral capsule", { salts: ["tramadol"], scheduleFlag: null, ndps: true });
const GLYCOMET = row("m_gly", "Glycomet (metformin hydrochloride) 500 mg oral tablet", { salts: ["metformin"] });
const METFORMIN = row("m_met", "Metformin hydrochloride 500 mg oral tablet", { salts: ["metformin"], generic: true });
const METRONIDAZOLE = row("m_metro", "Metronidazole 500 mg oral tablet", { salts: ["metronidazole"], generic: true, tier: 0, similarity: 0.5 });
const CELIN = row("m_celin", "Celin (ascorbic acid) 500 mg oral tablet", { salts: ["ascorbic acid"], tier: 0, similarity: 0.6 });
const CELIB = row("m_celib", "Celib (celecoxib) 500 mg oral capsule", { salts: ["celecoxib"], tier: 0, similarity: 0.6 });

type Fakes = { deps: AliasDeps; calls: { candidates: number; choose: ChooseInput[]; predicate: PredicateInput[]; reason: ChooseInput[] } };
function fakes(pool: AliasCandidateRow[], over: {
  pick?: string; confidence?: number; probabilities?: Record<string, number>; chooserModel?: string; chooserDown?: boolean;
  probability?: number; reason?: AliasReasonCode; reviewerModel?: string; reviewerDown?: boolean;
  enabled?: boolean; lasa?: LasaPair[];
} = {}): Fakes {
  const calls: Fakes["calls"] = { candidates: 0, choose: [], predicate: [], reason: [] };
  const pick = over.pick ?? "c1";
  const chooser: ChoiceClient = {
    choose: (input) => {
      calls.choose.push(input);
      if (over.chooserDown === true) return Promise.reject(new InferenceUnavailable("timeout"));
      const confidence = over.confidence ?? 0.95;
      return Promise.resolve({ model: over.chooserModel ?? "jev-test-1", answers: { product: { choice: pick, confidence, probabilities: over.probabilities ?? { [pick]: confidence } } } });
    },
  };
  const reviewer: ChoiceClient & PredicateClient = {
    predicate: (input) => {
      calls.predicate.push(input);
      if (over.reviewerDown === true) return Promise.reject(new InferenceUnavailable("provider_failed"));
      return Promise.resolve({ probability: over.probability ?? 0.99, model: over.reviewerModel ?? "luna-test-1" });
    },
    choose: (input) => {
      calls.reason.push(input);
      const choice = over.reason ?? "brand_nickname";
      return Promise.resolve({ model: over.reviewerModel ?? "luna-test-1", answers: { reason: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } } });
    },
  };
  return {
    calls,
    deps: {
      enabled: over.enabled ?? true,
      candidates: () => { calls.candidates += 1; return Promise.resolve(pool); },
      lasa: () => Promise.resolve(over.lasa ?? []),
      chooser, reviewer, chooserLine: 0.6, reviewerLine: 0.9,
    },
  };
}
const ran = (p: AliasProposal): Extract<AliasProposal, { outcome: "ran" }> => {
  if (p.outcome !== "ran") throw new Error("the pipeline was off");
  return p;
};

describe("the medicine-alias pipeline (decision 0051)", () => {
  describe("reading a term", () => {
    it("writes a spoken strength as the number on the label", () => {
      expect(spokenNumber(["forty"])).toBe(40);
      expect(spokenNumber(["six", "fifty"])).toBe(650);
      expect(spokenNumber(["six", "two", "five"])).toBe(625);
      expect(spokenNumber(["twenty", "five"])).toBe(25);
      expect(spokenNumber(["two", "fifty"])).toBe(250);
      expect(spokenNumber(["five", "hundred"])).toBe(500);
      expect(spokenNumber(["one", "thousand", "two", "hundred"])).toBe(1200);
      expect(spokenNumber(["sade", "chhe", "sau"])).toBe(650);
      expect(spokenNumber(["dhai", "sau"])).toBe(250);
      expect(spokenNumber(["paanch", "sau"])).toBe(500);
      expect(spokenNumber(["chalis"])).toBe(40);
      expect(spokenNumber(["point", "five"])).toBe(0.5);
      expect(spokenNumber(["one", "point", "two"])).toBe(1.2);
    });

    it("splits a term into the name, the strengths and the form it names", () => {
      expect(readTerm("Pan  Forty")).toEqual({ words: "pan", numbers: [{ value: 40, unit: "bare" }], form: null, digits: "pan 40" });
      expect(readTerm("dolo six fifty")).toMatchObject({ words: "dolo", numbers: [{ value: 650, unit: "bare" }], digits: "dolo 650" });
      expect(readTerm("augmentin six two five")).toMatchObject({ words: "augmentin", numbers: [{ value: 625, unit: "bare" }] });
      expect(readTerm("thyronorm 50mcg")).toMatchObject({ words: "thyronorm", numbers: [{ value: 0.05, unit: "mg" }] });
      expect(readTerm("monocef 1 gm inj")).toMatchObject({ words: "monocef", numbers: [{ value: 1000, unit: "mg" }], form: "injection" });
      expect(readTerm("calpol 250 syp")).toMatchObject({ words: "calpol", numbers: [{ value: 250, unit: "bare" }], form: "oral_liquid" });
      expect(readTerm("d3 60k")).toMatchObject({ words: "d3", numbers: [{ value: 60000, unit: "bare" }] });
      expect(readTerm("zerodol sp")).toMatchObject({ words: "zerodol sp", numbers: [], form: null });
    });

    it("reads the strengths a catalogue name prints, and never a denominator", () => {
      expect(strengthsInName(AUG625.name)).toEqual([{ value: 500, unit: "mg" }, { value: 125, unit: "mg" }]);
      expect(strengthsInName("Calpol (paracetamol) 250 mg/5 mL oral suspension")).toEqual([{ value: 250, unit: "mg" }]);
      expect(strengthsInName("Dolo (paracetamol) 1 g/100 ml solution for infusion")).toEqual([{ value: 1000, unit: "mg" }]);
      expect(strengthsInName("Alprazolam 250 microgram oral tablet")).toEqual([{ value: 0.25, unit: "mg" }]);
      expect(strengthsInName("Colecalciferol 60000 IU oral capsule")).toEqual([{ value: 60000, unit: "iu" }]);
    });

    it("holds a term's strength to the target's: each number a component, or one number their sum", () => {
      expect(strengthAgrees(readTerm("pan 40").numbers, PAN40.name)).toBe(true);
      expect(strengthAgrees(readTerm("pan 20").numbers, PAN40.name)).toBe(false);
      expect(strengthAgrees(readTerm("augmentin 625").numbers, AUG625.name)).toBe(true);
      expect(strengthAgrees(readTerm("augmentin 625").numbers, AUG1G.name)).toBe(false);
      expect(strengthAgrees(readTerm("augmentin 1 gm").numbers, AUG1G.name)).toBe(true);
      expect(strengthAgrees(readTerm("alprax 0.5").numbers, ALPRAX.name)).toBe(true);
      expect(strengthAgrees(readTerm("alprax 0.25").numbers, ALPRAX.name)).toBe(false);
      expect(strengthAgrees(readTerm("pan").numbers, PAN40.name)).toBeNull();
    });

    it("knows a name, a form class, a composition and a distance", () => {
      expect(headOf(PAN40.name)).toBe("pan");
      expect(headOf(MORPHINE.name)).toBe("morphine sulfate");
      expect(headOf(AUG625.name)).toBe("augmentin duo");
      expect(formClassOf("Powder for solution for injection")).toBe("injection");
      expect(formClassOf("Gastro-resistant oral tablet")).toBe("oral_solid");
      expect(formClassOf("Oral suspension")).toBe("oral_liquid");
      expect(formClassOf("Prolonged-release oral tablet")).toBe("oral_solid_mr");
      expect(compositionKey(PAN40)).toBe("pantoprazole|40mg|oral_solid");
      expect(compositionKey(PAN40)).not.toBe(compositionKey(PAN40_INJ));
      expect(editDistance("celin", "celib")).toBe(1);
      expect(editDistance("metformin", "metronidazole")).toBe(4);
    });

    it("shows a chooser one row per product, the strength the term names first", () => {
      const twin = row("m_pantop40", "Pantop (pantoprazole sodium) 40 mg gastro-resistant oral tablet", { salts: ["pantoprazole"], tier: 0, similarity: 0.7 });
      const shown = shownCandidates(readTerm("pan 40"), [PAN20, PAN40_INJ, twin, PAN40]);
      expect(shown.map((r) => r.id)).toEqual(["m_pan40i", "m_pan40", "m_pan20"]);
    });
  });

  describe("proposeAlias", () => {
    it("says 'suggestion' when chooser and reviewer agree above their lines and every rule passes", async () => {
      const f = fakes([PAN40, PAN20], { pick: "c1" });
      const p = ran(await proposeAlias(f.deps, "Pan Forty"));
      expect(p).toMatchObject({ term: "pan forty", state: "suggestion", medicineId: "m_pan40", refusal: null, ruleResult: "pass" });
      expect(p.chooser).toEqual({ model: "jev-test-1", confidence: 0.95 });
      expect(p.reviewer).toEqual({ model: "luna-test-1", answer: "yes", probability: 0.99, reasonCode: "brand_nickname" });
      // The whole of what the chooser was told about the doctor's words: the term and its digits.
      expect(f.calls.choose[0]?.state).toEqual({ term: "pan forty", read_as: "pan 40" });
      expect(Object.keys(f.calls.choose[0]?.questions.product?.options ?? {})).toEqual(["c1", "c2", "none"]);
      expect(Object.keys(f.calls.predicate[0]?.state ?? {})).toEqual(["term", "read_as", "product", "other_candidates"]);
    });

    it("SWITCHED OFF: no catalogue read, no model call, nothing to save", async () => {
      const f = fakes([PAN40], { enabled: false });
      expect(await proposeAlias(f.deps, "pan forty")).toEqual({ outcome: "off" });
      expect(f.calls).toEqual({ candidates: 0, choose: [], predicate: [], reason: [] });
    });

    it.each(["pan 40 9876543210", "u12345013 pan 40", "pan forty v2609150001", "dolo 650 for 4455667"])("REFUSES a term carrying an identifier, before anything is read or sent (%s)", async (term) => {
      const f = fakes([PAN40]);
      expect(ran(await proposeAlias(f.deps, term))).toMatchObject({ state: "proposed", refusal: "identifier_in_term", medicineId: null });
      expect(f.calls).toEqual({ candidates: 0, choose: [], predicate: [], reason: [] });
    });

    it("a reviewer that DISAGREES never yields a suggestion, however sure the chooser is", async () => {
      const p = ran(await proposeAlias(fakes([PAN40, PAN20], { confidence: 0.99, probability: 0.04 }).deps, "pan 40"));
      expect(p).toMatchObject({ state: "proposed", refusal: "reviewer_no", medicineId: "m_pan40" });
      expect(p.reviewer?.answer).toBe("no");
    });

    it.each([0.5, 0.8, 0.899])("a reviewer that is UNSURE (%p) never yields a suggestion", async (probability) => {
      const p = ran(await proposeAlias(fakes([PAN40, PAN20], { probability }).deps, "pan 40"));
      expect(p).toMatchObject({ state: "proposed", refusal: "reviewer_unsure" });
    });

    it("a reviewer that says yes but names a refusing reason has contradicted itself: unsure", async () => {
      const p = ran(await proposeAlias(fakes([PAN40, PAN20], { probability: 0.97, reason: "ambiguous_form" }).deps, "pan 40"));
      expect(p).toMatchObject({ state: "proposed", refusal: "reviewer_unsure" });
      expect(p.reviewer).toMatchObject({ answer: "unsure", reasonCode: "ambiguous_form" });
    });

    it("a chooser below its line, or one that says none, never yields a suggestion", async () => {
      expect(ran(await proposeAlias(fakes([PAN40, PAN20], { confidence: 0.59 }).deps, "pan 40"))).toMatchObject({ state: "proposed", refusal: "chooser_below_line" });
      const none = fakes([PAN40, PAN20], { pick: "none" });
      expect(ran(await proposeAlias(none.deps, "pan 40"))).toMatchObject({ state: "proposed", refusal: "chooser_none", medicineId: null });
      expect(none.calls.predicate).toHaveLength(0);
    });

    it("a STRENGTH written in the term that is not the target's refuses, with both models certain", async () => {
      // The chooser is shown the 20 first (it agrees with the term) and picks the 40 anyway.
      const p = ran(await proposeAlias(fakes([PAN40, PAN20], { pick: "c2", confidence: 0.99, probability: 0.99 }).deps, "pan 20"));
      expect(p.shown.map((r) => r.id)).toEqual(["m_pan20", "m_pan40"]);
      expect(p).toMatchObject({ state: "proposed", medicineId: "m_pan40", refusal: "strength_mismatch", ruleResult: "strength_mismatch" });
    });

    it("a combination's strength said as its sum is the target's strength", async () => {
      const p = ran(await proposeAlias(fakes([AUG625, AUG1G]).deps, "augmentin six two five"));
      expect(p).toMatchObject({ state: "suggestion", medicineId: "m_aug625" });
    });

    it("a term that names NO strength is refused when the medicine comes in more than one", async () => {
      expect(ran(await proposeAlias(fakes([PAN40, PAN20]).deps, "pan"))).toMatchObject({ state: "proposed", refusal: "strength_unstated" });
      expect(ran(await proposeAlias(fakes([DOLO650]).deps, "dolo"))).toMatchObject({ state: "suggestion" });
    });

    it("a form the term names that is not the target's refuses", async () => {
      const p = ran(await proposeAlias(fakes([PAN40, PAN40_INJ], { pick: "c2" }).deps, "pan 40 inj"));
      expect(p.shown.map((r) => r.id)).toEqual(["m_pan40i", "m_pan40"]);
      expect(p).toMatchObject({ state: "proposed", medicineId: "m_pan40", refusal: "form_mismatch" });
    });

    it.each([
      ["Schedule H1", ALPRAX, "alprax 0.5"],
      ["Schedule X", KETAMINE, "ketamine 50"],
      ["an NDPS class on a moiety", TRAMADOL, "somethingol 50"],
      ["a controlled NAME the flags missed", MORPHINE, "morphine 10"],
    ])("NEVER a controlled medicine — %s — with both models certain", async (_why, target, term) => {
      expect(isControlled(target)).toBe(true);
      const p = ran(await proposeAlias(fakes([target], { confidence: 1, probability: 1 }).deps, term));
      expect(p).toMatchObject({ state: "proposed", medicineId: target.id, refusal: "controlled_drug", ruleResult: "controlled_drug" });
    });

    it("says WHICH net caught a controlled medicine: the flag, the stored class, the cited NDPS list, then the name", () => {
      expect(controlledBy(ALPRAX)).toBe("schedule");
      expect(controlledBy(TRAMADOL)).toBe("ndps_class");
      // Morphine is on the formulary's cited NDPS list; the staging catalogue gives it no flag and no class.
      expect(controlledBy(MORPHINE)).toBe("ndps_list");
      expect(controlledBy(row("m_feb", "Febrex (fentanyl citrate) 50 mcg injection", { salts: [], scheduleFlag: null }))).toBe("ndps_list");
      // A benzodiazepine is not on that list (its Schedule entry was not read at source): the name is the last net.
      expect(controlledBy(row("m_clz", "Clonotril (clonazepam) 0.5 mg oral tablet", { salts: ["clonazepam"], scheduleFlag: null }))).toBe("name");
      expect(controlledBy(PAN40)).toBeNull();
    });

    it("the second-tap flag is for a DIFFERENT medicine with a near name, not the same brand's combination", async () => {
      const ALLEGRA = row("m_all", "Allegra (fexofenadine) 120 mg oral tablet", { salts: ["fexofenadine"] });
      const ALLEGRA_M = row("m_allm", "Allegra M (fexofenadine and montelukast) 120 mg + 10 mg oral tablet", { salts: ["fexofenadine", "montelukast"], tier: 1 });
      const ALLERT = row("m_alt", "Allegro (almotriptan) 120 mg oral tablet", { salts: ["almotriptan"], tier: 0, similarity: 0.7 });
      expect(ran(await proposeAlias(fakes([ALLEGRA, ALLEGRA_M]).deps, "allegra 120"))).toMatchObject({ state: "suggestion", medicineId: "m_all", lasaGuard: false });
      expect(ran(await proposeAlias(fakes([ALLEGRA, ALLEGRA_M, ALLERT]).deps, "allegra 120"))).toMatchObject({ state: "suggestion", medicineId: "m_all", lasaGuard: true });
    });

    it("a second product holding more than a fifth of the chooser's belief is a second target", async () => {
      const p = ran(await proposeAlias(fakes([PAN40, PAN40_INJ], { pick: "c1", confidence: 0.7, probabilities: { c1: 0.7, c2: 0.28, none: 0.02 } }).deps, "pan 40"));
      expect(p).toMatchObject({ state: "proposed", refusal: "multiple_targets" });
    });

    it("a misspelt name as near another medicine as its target is a look-alike conflict", async () => {
      const p = ran(await proposeAlias(fakes([CELIN, CELIB], { pick: "c1" }).deps, "celim 500"));
      expect(p).toMatchObject({ state: "proposed", medicineId: "m_celin", refusal: "lookalike_conflict" });
    });

    it("a look-alike PAIR: a misspelling is refused, an exact name passes flagged for the second tap", async () => {
      const lasa: LasaPair[] = [{ a: "metformin", b: "metronidazole", reviewed: false }];
      const wrong = ran(await proposeAlias(fakes([METFORMIN, METRONIDAZOLE], { lasa }).deps, "metformn 500"));
      expect(wrong).toMatchObject({ state: "proposed", refusal: "lookalike_conflict" });
      const exact = ran(await proposeAlias(fakes([GLYCOMET, METRONIDAZOLE], { lasa }).deps, "glycomet five hundred"));
      expect(exact).toMatchObject({ state: "suggestion", medicineId: "m_gly", lasaGuard: true });
      expect(ran(await proposeAlias(fakes([PAN40, PAN20], { lasa }).deps, "pan 40")).lasaGuard).toBe(false);
    });

    it("two models agreeing means two DIFFERENT models", async () => {
      const p = ran(await proposeAlias(fakes([PAN40, PAN20], { chooserModel: "gpt-6-luna", reviewerModel: "gpt-6-luna" }).deps, "pan 40"));
      expect(p).toMatchObject({ state: "proposed", refusal: "same_model" });
    });

    it("a model that is down is a 'proposed' row with the reason, never a throw and never a suggestion", async () => {
      expect(ran(await proposeAlias(fakes([PAN40], { chooserDown: true }).deps, "pan 40"))).toMatchObject({ state: "proposed", refusal: "chooser_unavailable" });
      expect(ran(await proposeAlias(fakes([PAN40], { reviewerDown: true }).deps, "pan 40"))).toMatchObject({ state: "proposed", refusal: "reviewer_unavailable", medicineId: "m_pan40" });
      const noReviewer = fakes([PAN40]);
      expect(ran(await proposeAlias({ ...noReviewer.deps, reviewer: null }, "pan 40"))).toMatchObject({ state: "proposed", refusal: "reviewer_unavailable" });
      expect(ran(await proposeAlias({ ...noReviewer.deps, chooser: null }, "pan 40"))).toMatchObject({ state: "proposed", refusal: "chooser_unavailable" });
      expect(ran(await proposeAlias(fakes([]).deps, "zzzz"))).toMatchObject({ state: "proposed", refusal: "no_candidates" });
    });
  });

  describe("trust by use (decision 0050) — pure, no caller yet", () => {
    const ok = { distinctDoctors: 3, tapsByTarget: { m_pan40: 10 }, editedToAnotherMoiety: 0, controlled: false };
    it("is earned at three doctors and ten taps on one composition", () => {
      expect(trustByUse(ok)).toEqual({ trusted: true, why: "earned" });
      expect(trustByUse({ ...ok, distinctDoctors: 2 })).toEqual({ trusted: false, why: "few_doctors" });
      expect(trustByUse({ ...ok, tapsByTarget: { m_pan40: 9 } })).toEqual({ trusted: false, why: "few_taps" });
      expect(trustByUse({ ...ok, editedToAnotherMoiety: 1 })).toEqual({ trusted: false, why: "composition_disagreement" });
      expect(trustByUse({ ...ok, controlled: true })).toEqual({ trusted: false, why: "controlled_drug" });
    });
    it("a TWO-TARGET term is never trusted, however much it is used", () => {
      expect(trustByUse({ ...ok, distinctDoctors: 40, tapsByTarget: { m_pan40: 700, m_pan20: 300 } })).toEqual({ trusted: false, why: "second_target" });
      expect(trustByUse({ ...ok, tapsByTarget: { m_pan40: 79, m_pan20: 21 } })).toEqual({ trusted: false, why: "second_target" });
      // A fifth exactly is not "more than a fifth".
      expect(trustByUse({ ...ok, tapsByTarget: { m_pan40: 80, m_pan20: 20 } })).toEqual({ trusted: true, why: "earned" });
    });
  });
});
