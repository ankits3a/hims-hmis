import { KNOWLEDGE, rulesOf, syndromeByKey } from "./knowledge";
import { rankSyndromes } from "./matcher";
import { bandFor, buildRegimen, doseFor } from "./regimen";
import type { PatientFacts } from "./regimen";

/**
 * ═══ THE CO-PILOT'S SAFETY CLAIMS, PINNED ═══
 *
 * Owner brief, 2026-09-14: assist the doctor, with LOW help from an LLM, and automatically raise
 * the danger when the patient is a child, pregnant, or allergic. The claims that matter are not
 * "it suggests something" but "it never suggests a number it cannot source", so that is what these
 * assert.
 */
const ADULT: PatientFacts = { ageYears: 34, weightKg: 62, allergies: [], pregnant: false };
const CHILD_14: PatientFacts = { ageYears: 3, weightKg: 14, allergies: [], pregnant: false };
const CHILD_7: PatientFacts = { ageYears: 1, weightKg: 7, allergies: [], pregnant: false };

describe("CDS knowledge", () => {
  it("K1: the committed corpus parses, and carries the bundle it was built from", () => {
    expect(KNOWLEDGE.syndromes).toHaveLength(8);
    expect(KNOWLEDGE.rules.length).toBeGreaterThanOrEqual(130);
    expect(KNOWLEDGE.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the domains the owner's brief names must each have arrived with rows
    for (const d of ["vitals_rules", "allergy_rules", "pregnancy_trimester_rules", "g6pd_rules", "qtc_rules", "amsp_rules"]) {
      expect(rulesOf(d).length).toBeGreaterThan(0);
    }
  });

  it("K2: every pediatric line is classified — an unclassified one must never reach a doctor", () => {
    const ped = KNOWLEDGE.syndromes.flatMap((s) => s.lines.filter((l) => l.band === "pediatric"));
    expect(ped).toHaveLength(19);
    expect(ped.filter((l) => l.dosing === null)).toEqual([]);
    // and no `derived` rate has been quietly marked reviewed — reviewed rates are `stated` ones
    for (const l of ped) {
      if (l.dosing?.kind === "derived") expect(l.dosing.reviewed).toBe(false);
    }
  });
});

describe("CDS matcher — no model in this path", () => {
  it("M1: the owner's own example ranks URI first, and says which words earned it", () => {
    const hits = rankSyndromes("Fever + Sore Throat + Dry Cough");
    expect(hits[0]!.key).toBe("SYN_URI_01");
    expect(hits[0]!.matched).toEqual(expect.arrayContaining(["fever", "sore throat", "cough"]));
    expect(hits[0]!.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("M2: it matches whole words only — 'ear pain' must not hit on 'fever'", () => {
    const hits = rankSyndromes("ear pain");
    expect(hits.map((h) => h.matched).flat().join(" ")).not.toContain("fever");
  });

  it("M3: nothing typed and nothing recognised both return nothing, rather than a guess", () => {
    expect(rankSyndromes("")).toEqual([]);
    expect(rankSyndromes("   ")).toEqual([]);
    expect(rankSyndromes("xyzzy quux")).toEqual([]);
  });

  it("M4: the order is stable across calls — a list that reshuffles cannot be tapped", () => {
    const a = rankSyndromes("burning urine fever").map((h) => h.key);
    const b = rankSyndromes("burning urine fever").map((h) => h.key);
    expect(a).toEqual(b);
  });
});

describe("CDS regimen — the dose for the child in the chair", () => {
  it("R1: the band is the bundle's own 40 kg rule, and age stands in when no weight is recorded", () => {
    expect(bandFor(ADULT)).toBe("adult");
    expect(bandFor(CHILD_14)).toBe("pediatric");
    expect(bandFor({ ageYears: 6, weightKg: null, allergies: [], pregnant: false })).toBe("pediatric");
    expect(bandFor({ ageYears: null, weightKg: null, allergies: [], pregnant: false })).toBe("adult");
    // a small adult is still an adult by age, but the bundle blocks solid tablets under 40 kg
    expect(bandFor({ ageYears: 30, weightKg: 38, allergies: [], pregnant: false })).toBe("pediatric");
  });

  /** THE DEFECT THIS MODULE EXISTS FOR: the bundle's 3.5 mL is for a 14 kg child and nobody else. */
  it("R2: a STATED mg/kg rate is computed for the actual weight — 7 kg gets half of what 14 kg gets", () => {
    const at14 = buildRegimen("SYN_URI_01", CHILD_14)!;
    const at7 = buildRegimen("SYN_URI_01", CHILD_7)!;
    const para14 = at14.lines.find((l) => l.drugLabel.startsWith("Paracetamol"))!;
    const para7 = at7.lines.find((l) => l.drugLabel.startsWith("Paracetamol"))!;

    expect(para14.dose).toMatchObject({ state: "computed", mg: 175, ml: 3.5 });
    expect(para7.dose).toMatchObject({ state: "computed", mg: 87.5, ml: 2 });
    // the bundle's own worked example is reproduced exactly at 14 kg — the arithmetic is checkable
    expect(para14.sig).toContain("3.5 mL");
  });

  it("R3: a DERIVED rate computes NOTHING until a clinician signs it, and says why", () => {
    const r = buildRegimen("SYN_URI_01", CHILD_14)!;
    const amox = r.lines.find((l) => l.drugLabel.includes("Amoxicillin"))!;
    expect(amox.dose.state).toBe("needs_review");
    expect((amox.dose as { basis: string }).basis).toContain("not yet clinically reviewed");
    // the doctor still sees the bundle's example, labelled as one
    expect((amox.dose as { example: string }).example).toContain("3.5 mL");
  });

  it("R4: a stated rate with no weight on file refuses rather than assuming one", () => {
    const noWeight: PatientFacts = { ageYears: 3, weightKg: null, allergies: [], pregnant: false };
    const r = buildRegimen("SYN_URI_01", noWeight)!;
    const para = r.lines.find((l) => l.drugLabel.startsWith("Paracetamol"))!;
    expect(para.dose.state).toBe("no_weight");
    expect(JSON.stringify(para.dose)).not.toMatch(/\bml"?:\s*\d/i);
  });

  it("R5: fixed doses and advice carry no computation at all", () => {
    const r = buildRegimen("SYN_GE_02", CHILD_14)!;
    const ors = r.lines.find((l) => l.drugLabel.includes("Oral Rehydration"))!;
    expect(ors.dose.state).toBe("fixed");
    const msk = buildRegimen("SYN_MSK_07", CHILD_14)!;
    expect(msk.lines.find((l) => l.drugLabel.includes("Cold Compress"))!.dose.state).toBe("advice_only");
  });

  it("R6: a documented penicillin allergy swaps the beta-lactam out and names the reason", () => {
    const allergic: PatientFacts = { ...ADULT, allergies: ["Penicillin"] };
    const r = buildRegimen("SYN_URI_01", allergic)!;
    const swapped = r.lines.find((l) => l.substitutedFor !== undefined)!;
    expect(swapped.substitutedFor).toContain("Amoxicillin");
    expect(swapped.drugLabel).toContain("Azithromycin");
    expect(r.appliedConditions).toContain("Penicillin");
    // and no beta-lactam survives anywhere in the built regimen
    expect(r.lines.some((l) => /amoxicillin|ampicillin|penicillin/i.test(l.drugLabel))).toBe(false);
  });

  /**
   * FOUND BY THIS TEST, ON THE FIRST DRAFT: the substitution matched the label as prose, and the
   * adult line ("Amoxicillin and Clavulanic Acid") matched while the child's ("Amoxicillin and
   * Clavulanate Syrup") did not — so the allergic CHILD kept the beta-lactam. The blocklist from
   * `allergy_rules` decides now, on word tokens, and the child is covered by the same rule as the
   * adult.
   */
  it("R7: the allergic CHILD is covered too — no beta-lactam survives, and the swap carries no computed dose", () => {
    const allergicChild: PatientFacts = { ...CHILD_14, allergies: ["penicillin"] };
    const r = buildRegimen("SYN_URI_01", allergicChild)!;
    expect(r.lines.some((l) => /amoxicillin|ampicillin|clavulan/i.test(l.drugLabel))).toBe(false);
    const swapped = r.lines.find((l) => l.substitutedFor !== undefined)!;
    expect(swapped.substitutedFor).toContain("Amoxicillin");
    expect(swapped.drugLabel).toContain("Azithromycin");
    expect(swapped.dose.state).toBe("needs_review");
  });

  /** A blocked drug with nothing to put in its place must not survive as itself. */
  it("R7b: an allergen the syndrome has no substitute for leaves a refusal, never the original drug", () => {
    const nsaid: PatientFacts = { ...ADULT, allergies: ["Ibuprofen"] };
    const r = buildRegimen("SYN_MSK_07", nsaid)!;
    const blocked = r.lines.filter((l) => l.dose.state === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    for (const l of blocked) {
      expect((l.dose as { safeAlternatives: string[] }).safeAlternatives.join(" ")).toMatch(/paracetamol/i);
      expect(l.dosing).toBeNull();
    }
  });

  it("R8: an unknown syndrome is null, never an empty regimen that looks like an answer", () => {
    expect(buildRegimen("SYN_NOPE_99", ADULT)).toBeNull();
    expect(syndromeByKey("SYN_NOPE_99")).toBeNull();
  });

  it("R9: every adult line of every syndrome builds without throwing, and none invents a millilitre", () => {
    for (const s of KNOWLEDGE.syndromes) {
      const r = buildRegimen(s.key, ADULT)!;
      expect(r.lines.length).toBeGreaterThan(0);
      for (const l of r.lines) expect(["computed", "fixed", "advice_only", "needs_review", "no_weight"]).toContain(l.dose.state);
    }
  });
});

describe("CDS dose verdicts in isolation", () => {
  it("D1: mg is rounded to 0.1 and mL to the nearest half — a carer measures with a spoon", () => {
    const v = doseFor({ kind: "stated", mgPerKg: 12.5, per: "dose", concentrationMgPerMl: 50 }, { ...CHILD_14, weightKg: 13.3 }, "x");
    expect(v).toMatchObject({ state: "computed", mg: 166.3, ml: 3.5 });
  });
});
