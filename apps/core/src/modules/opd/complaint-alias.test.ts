import { InferenceUnavailable } from "../../kernel/inference/types";
import type { ChoiceClient, ChooseInput } from "../../kernel/inference/types";
import { SAME_WORDS_RULE, proposeComplaintAlias, wordsKey } from "./complaint-alias";
import type { ComplaintAliasDeps, ComplaintAliasProposal, ComplaintConcept } from "./complaint-alias";

/**
 * #613 — complaint normalisation through the chooser, with a FAKE chooser that counts its calls.
 * Closed set = the existing concepts plus "none"; rule first, chooser last, strict line.
 */
const CONCEPTS: ComplaintConcept[] = [
  { key: "chest_pain", label: "Chest pain", terms: ["chest pain", "seene me dard"] },
  { key: "abdominal_pain", label: "Abdominal pain", terms: ["abdominal pain", "pet dard"] },
  { key: "fever", label: "Fever", terms: ["fever", "bukhar"] },
];

function fakes(over: { pick?: string; confidence?: number; probabilities?: Record<string, number>; down?: boolean; enabled?: boolean; noChooser?: boolean } = {}): { deps: ComplaintAliasDeps; calls: ChooseInput[]; asked: number } {
  const calls: ChooseInput[] = [];
  const box = { asked: 0 };
  const chooser: ChoiceClient = {
    choose: (input) => {
      calls.push(input);
      if (over.down === true) return Promise.reject(new InferenceUnavailable("timeout"));
      const pick = over.pick ?? "k2";
      const confidence = over.confidence ?? 0.97;
      return Promise.resolve({ model: "jev-test-1", answers: { concept: { choice: pick, confidence, probabilities: over.probabilities ?? { [pick]: confidence } } } });
    },
  };
  return {
    calls,
    get asked() { return box.asked; },
    deps: {
      enabled: over.enabled ?? true,
      concepts: () => { box.asked += 1; return Promise.resolve(CONCEPTS); },
      chooser: over.noChooser === true ? null : chooser,
      chooserLine: 0.95,
    },
  };
}
const ran = (p: ComplaintAliasProposal): Extract<ComplaintAliasProposal, { outcome: "ran" }> => {
  if (p.outcome !== "ran") throw new Error("off");
  return p;
};

describe("complaint normalisation through the chooser (#613)", () => {
  it("SWITCHED OFF: nothing is read and no model is asked", async () => {
    const f = fakes({ enabled: false });
    expect(await proposeComplaintAlias(f.deps, "pet me marod")).toEqual({ outcome: "off" });
    expect(f.asked).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("a phrase carrying an identifier is refused before anything is read or asked", async () => {
    const f = fakes();
    expect(ran(await proposeComplaintAlias(f.deps, "pet dard call 9876543210"))).toMatchObject({ state: "proposed", refusal: "identifier_in_term", conceptKey: null });
    expect(f.calls).toHaveLength(0);
  });

  it("RULE FIRST: a known phrasing with its words reordered is that concept, and no model is asked", async () => {
    expect(wordsKey("Pain, chest")).toBe(wordsKey("chest pain"));
    const f = fakes();
    expect(ran(await proposeComplaintAlias(f.deps, "Pain, Chest"))).toEqual({
      outcome: "ran", term: "pain, chest", state: "suggestion", conceptKey: "chest_pain", refusal: null, ruleResult: "pass", rung: "rule",
      chooser: { model: SAME_WORDS_RULE, confidence: 1 },
    });
    expect(f.calls).toHaveLength(0);
  });

  it("the chooser is asked a CLOSED set — the existing concepts and none — about the phrase alone", async () => {
    const f = fakes({ pick: "k2", confidence: 0.97 });
    const p = ran(await proposeComplaintAlias(f.deps, "pet me marod"));
    expect(p).toMatchObject({ state: "suggestion", conceptKey: "abdominal_pain", refusal: null, rung: "chooser", chooser: { model: "jev-test-1", confidence: 0.97 } });
    const q = f.calls[0]!;
    expect(q.state).toEqual({ phrase: "pet me marod" });
    expect(Object.keys(q.questions.concept!.options).sort()).toEqual(["k1", "k2", "k3", "none"]);
    expect(String(q.questions.concept!.options.k2)).toMatch(/^Abdominal pain/);
  });

  it("BELOW THE LINE nothing changes: proposed, never shown", async () => {
    expect(ran(await proposeComplaintAlias(fakes({ confidence: 0.94 }).deps, "pet me marod"))).toMatchObject({ state: "proposed", refusal: "chooser_below_line", conceptKey: "abdominal_pain" });
  });

  it("'none' is no concept", async () => {
    expect(ran(await proposeComplaintAlias(fakes({ pick: "none", confidence: 0.99 }).deps, "kal se"))).toMatchObject({ state: "proposed", refusal: "chooser_none", conceptKey: null });
  });

  it("a second concept holding more than a fifth of the belief is two targets, above the line or not", async () => {
    const f = fakes({ pick: "k2", confidence: 0.96, probabilities: { k2: 0.7, k1: 0.25, none: 0.05 } });
    expect(ran(await proposeComplaintAlias(f.deps, "pet aur seene me dard"))).toMatchObject({ state: "proposed", refusal: "multiple_targets", ruleResult: "multiple_targets" });
  });

  it("a chooser that is down, or absent, is not an answer", async () => {
    expect(ran(await proposeComplaintAlias(fakes({ down: true }).deps, "pet me marod"))).toMatchObject({ state: "proposed", refusal: "chooser_unavailable" });
    expect(ran(await proposeComplaintAlias(fakes({ noChooser: true }).deps, "pet me marod"))).toMatchObject({ state: "proposed", refusal: "chooser_unavailable" });
  });
});
