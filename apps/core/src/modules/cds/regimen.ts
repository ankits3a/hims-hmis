import { rulesOf, syndromeByKey } from "./knowledge";
import type { Dosing, RegimenLine, Syndrome } from "./knowledge";

/**
 * ═══ THE DOSE FOR THE CHILD IN THE CHAIR — OR NO DOSE AT ALL ═══
 *
 * The owner's bundle ships every pediatric millilitre as a worked example FOR A 14 KG CHILD
 * (`"3.5 mL (for 14kg: 12.5 mg/kg) Every 6h SOS"`). Handing that string to a doctor treating a 7 kg
 * infant is a two-fold overdose with a tidy audit trail. So the line's dosing was classified once,
 * offline, into `stated` / `derived` / `fixed` / `non_drug` (see `scripts/build-cds-knowledge.ts`),
 * and this function is where that classification earns its keep:
 *
 *   `stated`   the bundle gives the mg/kg rate → compute for THIS child's weight.
 *   `derived`  the rate is arithmetic off one worked example and NOBODY CLINICAL HAS SIGNED IT →
 *              **compute nothing.** Show the bundle's own 14 kg example, labelled as an example,
 *              and say a dose needs review. A number on a screen is a clinical assertion; this
 *              module does not make one it cannot source.
 *   `fixed`    two puffs is two puffs at any weight.
 *   `non_drug` a cold compress has no dose and a referral is not a prescription.
 *
 * The weight itself is never guessed: no weight recorded means no pediatric computation, because
 * the one thing worse than refusing a dose is inventing the weight it was computed from.
 */
export type PatientBand = "adult" | "pediatric";

export type PatientFacts = {
  ageYears: number | null;
  weightKg: number | null;
  /** Documented allergies, as free text from the patient record — matched case-insensitively. */
  allergies: string[];
  /**
   * The allergen CLASSES of those allergies that were PICKED rather than typed
   * (`patient_allergies.allergen_class`). A class found here fires its rule by identity, so a
   * misspelt substance no longer silences the block — which is the whole reason the column exists.
   * Empty is the ordinary case for records written before the field could be picked from.
   */
  allergenClasses: string[];
  pregnant: boolean;
};

export type DoseVerdict =
  | { state: "computed"; mg: number; ml: number | null; basis: string }
  | { state: "blocked"; basis: string; safeAlternatives: string[] }
  | { state: "fixed"; basis: string }
  | { state: "advice_only"; basis: string }
  | { state: "needs_review"; basis: string; example: string }
  | { state: "no_weight"; basis: string };

export type BuiltLine = RegimenLine & { dose: DoseVerdict; substitutedFor?: string; substitutionReason?: string };

export type BuiltRegimen = {
  syndrome: { key: string; name: string; icd10: string | null };
  band: PatientBand;
  lines: BuiltLine[];
  /** Conditions from the bundle's substitution map that applied to this patient. */
  appliedConditions: string[];
};

/**
 * THE BAND IS THE BUNDLE'S OWN RULE, and the bundle draws it at weight rather than age: its vitals
 * table carries `WEIGHT < 40` as the "pediatric solid tablet block". Age is the fallback when no
 * weight is recorded — a 6-year-old with no weight on file is still a child — and an adult is what
 * remains. Both facts absent means ADULT, because that is what an OPD walk-in is unless somebody
 * says otherwise, and the caller can see that no weight was recorded.
 */
export function bandFor(p: PatientFacts): PatientBand {
  if (p.weightKg !== null) return p.weightKg < 40 ? "pediatric" : "adult";
  if (p.ageYears !== null && p.ageYears < 12) return "pediatric";
  return "adult";
}

/** Rounded to the nearest 0.5 mL: a carer measures with a 5 mL spoon or a dropper, not a pipette. */
function roundMl(ml: number): number {
  return Math.round(ml * 2) / 2;
}

export function doseFor(dosing: Dosing | null, p: PatientFacts, sig: string): DoseVerdict {
  if (dosing === null) return { state: "fixed", basis: sig };
  switch (dosing.kind) {
    case "non_drug":
      return { state: "advice_only", basis: sig };
    case "fixed":
      return { state: "fixed", basis: sig };
    case "derived":
      /* The refusal. `from` is carried so the doctor sees WHAT the example was and can judge it. */
      return {
        state: "needs_review",
        basis: `${dosing.mgPerKg} mg/kg per ${dosing.per} derived from the bundle's ${dosing.from.exampleWeightKg} kg example — not yet clinically reviewed`,
        example: sig,
      };
    case "stated": {
      if (p.weightKg === null) return { state: "no_weight", basis: `${dosing.mgPerKg} mg/kg per ${dosing.per} — record a weight to compute` };
      const mg = Math.round(dosing.mgPerKg * p.weightKg * 10) / 10;
      const ml = dosing.concentrationMgPerMl === undefined ? null : roundMl(mg / dosing.concentrationMgPerMl);
      return {
        state: "computed", mg, ml,
        basis: `${dosing.mgPerKg} mg/kg per ${dosing.per} × ${p.weightKg} kg${ml === null ? "" : ` ÷ ${dosing.concentrationMgPerMl} mg/mL`}`,
      };
    }
  }
}

/**
 * ═══ THE BLOCKLIST DECIDES, NOT THE DRUG'S NAME ═══
 *
 * The first draft matched a substitution's `substitute_for` string against the line's label, and a
 * test caught what that costs: the adult line reads *"Amoxicillin and Clavulanic Acid 625mg"* and
 * the child's reads *"Amoxicillin and Clavulanate Syrup"* — one word apart — so a penicillin-
 * allergic ADULT got azithromycin and **the allergic CHILD kept the beta-lactam.** The guard missed
 * the more vulnerable patient, which is the direction these things always fail in.
 *
 * The bundle already ships the authority: `allergy_rules` gives each allergen its `blocked_classes`
 * (Penicillin blocks Amoxicillin, Ampicillin, Amoxicillin-Clavulanic acid, Piperacillin,
 * Cloxacillin, Cephalexin, Cefadroxil) and its `safe_alternatives`. Matching is on TOKENS of five
 * letters or more, so `clavulanate` and `clavulanic` no longer have to agree — `amoxicillin` is in
 * both labels and that is what blocks the line. A short token would match across molecules
 * (`acid`), which is why the floor exists.
 */
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5);

/**
 * The allergy rules that this patient's recorded allergies trigger.
 *
 * ═══ TWO WAYS IN, AND THE CODED ONE CANNOT BE MISSPELT ═══
 *
 * BY CLASS first: an allergy the doctor PICKED carries the rule's own class name, so the rule is
 * found by identity. This is what `pencilin` needed — the token pass below cannot match it against
 * `penicillin`, and the block went silent for the life of that record.
 *
 * BY TOKEN second, exactly as before, for every row written as free text — which is every row
 * recorded before the field could be picked from, and every one a doctor still chooses to type.
 * Neither path is weakened by the other: a rule fires if EITHER finds it.
 */
function rulesForAllergies(
  allergies: string[], allergenClasses: string[] = [],
): { allergen: string; blocked: string[]; safe: string[] }[] {
  const coded = new Set(allergenClasses.map((c) => c.trim().toLowerCase()).filter((c) => c !== ""));
  const out: { allergen: string; blocked: string[]; safe: string[] }[] = [];
  for (const r of rulesOf("allergy_rules")) {
    const p = r.payload as { allergen?: string; allergen_class?: string; blocked_classes?: string[]; safe_alternatives?: string[] };
    const byClass = p.allergen_class !== undefined && coded.has(p.allergen_class.trim().toLowerCase());
    const names = tokens(`${p.allergen ?? ""} ${p.allergen_class ?? ""}`);
    const byToken = allergies.some((a) => tokens(a).some((t) => names.includes(t)));
    if (byClass || byToken) out.push({ allergen: p.allergen ?? "", blocked: p.blocked_classes ?? [], safe: p.safe_alternatives ?? [] });
  }
  return out;
}

function blockedBy(
  drugLabel: string, allergies: string[], allergenClasses: string[] = [],
): { allergen: string; safe: string[] } | null {
  const label = tokens(drugLabel);
  for (const r of rulesForAllergies(allergies, allergenClasses)) {
    if (r.blocked.some((b) => tokens(b).some((t) => label.includes(t)))) return { allergen: r.allergen, safe: r.safe };
  }
  return null;
}

/**
 * The syndrome's own substitution map supplies the REPLACEMENT when it has one for this allergen.
 * Its conditions are broader than allergies — `Penicillin Allergy` sits beside `Bradycardia HR < 55`
 * and `Hypoxemia SpO2 < 92%` — so only the allergy-shaped rows are consulted here; the rest are the
 * sentinel cards' business, because those can see the vitals.
 */
function substitutionFor(s: Syndrome, allergen: string): Syndrome["substitutions"][number] | undefined {
  const want = tokens(allergen);
  return s.substitutions.find((x) => /allerg|intoleran|aerd/i.test(x.condition) && tokens(x.condition).some((t) => want.includes(t)));
}

export function buildRegimen(syndromeKey: string, p: PatientFacts): BuiltRegimen | null {
  const s: Syndrome | null = syndromeByKey(syndromeKey);
  if (s === null) return null;
  const band = bandFor(p);
  const applied: string[] = [];

  const lines: BuiltLine[] = s.lines
    .filter((l) => l.band === band)
    .map((l): BuiltLine => {
      const block = blockedBy(l.drugLabel, p.allergies, p.allergenClasses);
      if (block === null) return { ...l, dose: doseFor(l.dosing, p, l.sig) };
      if (!applied.includes(block.allergen)) applied.push(block.allergen);
      const sub = substitutionFor(s, block.allergen);
      const swapped = sub === undefined ? null : (band === "pediatric" ? sub.drugChild : sub.drugAdult);
      /*
        NO SUBSTITUTE IN THE BUNDLE MEANS NO LINE — never the original. A blocked drug left on the
        list "for the doctor to notice" is the allergy check failing in the one way that reaches a
        patient, so the line survives only as a refusal carrying the rule's own safe alternatives.
      */
      if (swapped === null) {
        return { ...l, dosing: null, dose: { state: "blocked", basis: `${block.allergen} allergy on file — this drug is on that allergen's blocked list`, safeAlternatives: block.safe } };
      }
      /*
        A SUBSTITUTE CARRIES NO COMPUTED DOSE. Its dosing was never classified — the bundle states
        it as prose inside the substitution ("7 mL Day 1, then 3.5 mL Days 2-5") — and the whole
        point of this module is that an unclassified line does not produce a number.
      */
      return {
        ...l, drugLabel: swapped, sig: swapped, dosing: null,
        dose: { state: "needs_review", basis: `substituted for ${block.allergen} allergy${sub?.reason == null ? "" : ` — ${sub.reason}`}`, example: swapped },
        substitutedFor: l.drugLabel, substitutionReason: sub?.reason ?? undefined,
      };
    });

  return { syndrome: { key: s.key, name: s.name, icd10: s.icd10 }, band, lines, appliedConditions: applied };
}
