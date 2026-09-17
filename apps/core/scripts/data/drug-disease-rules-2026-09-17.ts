import type { DrugDiseaseRule } from "../../src/modules/formulary";

/**
 * ═══ WHAT THE PATIENT'S DIAGNOSIS FORBIDS, AS MOIETIES AND ICD-10 PREFIXES ═══
 *
 * Source: `hmis_icd10_drug_contraindications.json` (the owner's Drive zip, 2026-09-17; sha256 in
 * `/opt/hmis-context/icd10-contraindications-2026-09-17/SHA256SUMS`). 15 rules over 12
 * three-character categories and 57 substance names.
 *
 * Every rule was checked against the standard references and against THIS formulary's own names
 * before it was listed. Where the source and the reference disagree, the rule follows the
 * reference, and the departure is written below. The source's prose is not copied: each `note` is
 * ours, in the words a doctor reads at the counter.
 *
 * Severity: the source's RED (both "CRITICAL CONTRAINDICATION" and "HIGH RISK") is `severe` — a
 * hard warning the prescriber clears with a typed reason. AMBER is `moderate`, a notice that gates
 * nothing.
 *
 * ═══ DEPARTURE 1: TWO CATEGORIES ARE SPLIT, BECAUSE THREE CHARACTERS FIRE ON THE WELL ═══
 *
 * `H40` GLAUCOMA. The source keys the anticholinergic rule at `H40`. Measured on the released
 * catalogue, `H40.1x` (open-angle glaucoma) is 112 codes and `H40.2x` (primary angle-closure) is
 * 47. Anticholinergics threaten the closable angle and are not contraindicated in open-angle
 * disease, which is the commoner illness. Keyed at `H40` this rule would fire on the majority of
 * glaucoma patients and teach the prescriber to clear it unread. It is split to `H40.03`
 * (anatomical narrow angle), `H40.06` (primary angle closure) and `H40.2` (angle-closure glaucoma).
 *
 * `N18` CHRONIC KIDNEY DISEASE. The source keys metformin at `N18`. Metformin is FIRST-LINE at
 * stages 1 and 2 and refusing it there would be wrong. The rule is graded the way the drug is
 * actually used: `severe` at `N18.4`, `N18.5` and `N18.6` (stage 4, stage 5, end-stage), and
 * `moderate` at `N18.32` (stage 3b), where the dose is capped rather than stopped. Stages 1, 2 and
 * 3a raise nothing.
 *
 * ═══ DEPARTURE 2: ONE RULE IS SPLIT BECAUSE ITS TWO DRUGS FAIL AT DIFFERENT STAGES ═══
 *
 * The source puts NSAIDs and nitrofurantoin in one `N18` rule. NSAIDs threaten renal perfusion from
 * stage 3 (`N18.3`, which covers 3a and 3b); nitrofurantoin becomes both useless and toxic below
 * eGFR 30, which is stage 4. They are two rules.
 *
 * ═══ DEPARTURE 3: ONE RULE OFFERS NO ALTERNATIVE, BECAUSE ITS OFFER WAS NOT ONE ═══
 *
 * The liver rule's `safe_alternatives` are "Lactulose Syrup, Rifaximin 550mg". Both are treatments
 * for hepatic encephalopathy, not substitutes for methotrexate, leflunomide or a benzodiazepine.
 * Offering them as a one-tap switch would replace a disease-modifying drug with a laxative. The
 * rule carries its clinical line and NO alternative, which is an ordinary state for a hazard that
 * has no safe stand-in.
 *
 * ═══ DEPARTURE 4: THE LIVER RULE ALSO COVERS CIRRHOSIS ═══
 *
 * `K70` is *alcoholic* liver disease. The mechanism the rule describes — poor clearance, fibrosis,
 * encephalopathy — is the cirrhotic liver whatever caused it, and `K74` (fibrosis and cirrhosis of
 * liver) is where most of those patients are coded. Both prefixes carry the rule.
 *
 * ═══ NAMES: FIVE OF THE SOURCE'S 57 ARE SPELT DIFFERENTLY HERE ═══
 *
 * Checked against `hmis_formulary_prodlike` with the adoption's own `isMoiety` predicate: 52 of 57
 * matched directly. The other five follow the national release, and are written out here rather
 * than normalised silently, so that a future release adding one of the source's spellings as a row
 * of its own cannot quietly change what this book means:
 *
 *     dicyclomine          -> dicycloverine      (INN)
 *     indomethacin         -> indometacin        (INN)
 *     chlorthalidone       -> chlortalidone      (INN; the same spelling that cost P21 ten pairs)
 *     torsemide            -> torasemide         (INN)
 *     acetylsalicylic acid -> aspirin            (a synonym; the source lists both in one rule)
 *
 * `torasemide` carries a trap worth naming: a NON-moiety release image spelt `Torsemide` sits
 * beside it, so a name match that does not also ask `isMoiety` binds the wrong row. The adoption
 * asks.
 *
 * ═══ ONE RULE IS DELIBERATELY NOT ROUTE-SCOPED ═══
 *
 * The NSAID rules are `systemic_only`: a diclofenac gel does not perforate an ulcer. The asthma
 * beta-blocker rule is NOT, and must not be — timolol EYE DROPS are absorbed well enough to cause
 * fatal bronchospasm in an asthmatic, which is exactly why they are in the rule.
 */

const rule = (
  rule_: string, prefixes: readonly (readonly [string, string])[], moieties: readonly string[],
  severity: DrugDiseaseRule["severity"], note: string,
  opts: { alternatives?: DrugDiseaseRule["alternatives"]; routeScope?: "systemic_only" | null } = {},
): DrugDiseaseRule[] => prefixes.map(([prefix, title]) => ({
  rule: rule_, prefix, title, moieties, severity, note,
  alternatives: opts.alternatives, routeScope: opts.routeScope ?? null,
}));

const NSAIDS_ORAL = [
  "ibuprofen", "diclofenac", "aceclofenac", "naproxen", "ketorolac", "piroxicam", "indometacin",
  "mefenamic acid",
] as const;
const ANTICHOLINERGICS = [
  "atropine", "dicycloverine", "hyoscine", "amitriptyline", "oxybutynin", "promethazine",
] as const;

const PARACETAMOL = [{ moiety: "paracetamol", label: "Paracetamol 650 mg" }];
const DHP_OR_ARB = [
  { moiety: "amlodipine", label: "Amlodipine 5 mg" },
  { moiety: "telmisartan", label: "Telmisartan 40 mg" },
];

/** Stage 4 and beyond: the kidney no longer clears what these rules are about. */
const CKD_FAILING = [
  ["N18.4", "Chronic kidney disease, stage 4 (severe)"],
  ["N18.5", "Chronic kidney disease, stage 5"],
  ["N18.6", "End stage renal disease"],
] as const;

export const DRUG_DISEASE_RULES_2026_09_17: readonly DrugDiseaseRule[] = [
  ...rule("icd10_contraindications#0", [["J45", "Asthma"]],
    ["propranolol", "timolol", "sotalol", "nadolol", "carvedilol", "labetalol"], "severe",
    "A non-selective beta-blocker can trigger severe bronchospasm in asthma — timolol eye drops included. Use amlodipine or telmisartan for blood pressure.",
    { alternatives: DHP_OR_ARB }),

  ...rule("icd10_contraindications#1", [["J45", "Asthma"]],
    ["aspirin", ...NSAIDS_ORAL], "severe",
    "Aspirin and other NSAIDs set off severe bronchospasm in aspirin-sensitive asthma — use paracetamol.",
    { alternatives: PARACETAMOL, routeScope: "systemic_only" }),

  ...rule("icd10_contraindications#2", [["I50", "Heart failure"]],
    ["verapamil", "diltiazem"], "severe",
    "Verapamil and diltiazem depress the failing ventricle and can precipitate cardiogenic shock — avoid in heart failure with reduced ejection fraction.",
    {
      alternatives: [
        { moiety: "carvedilol", label: "Carvedilol 6.25 mg" },
        { moiety: "metoprolol", label: "Metoprolol succinate 25 mg" },
      ],
    }),

  ...rule("icd10_contraindications#3", [["I50", "Heart failure"]],
    ["etoricoxib", ...NSAIDS_ORAL], "severe",
    "NSAIDs hold salt and water in heart failure and blunt the diuretic — use paracetamol.",
    { alternatives: PARACETAMOL, routeScope: "systemic_only" }),

  ...rule("icd10_contraindications#4", [["I44", "Atrioventricular and left bundle-branch block"]],
    ["verapamil", "diltiazem", "metoprolol", "atenolol", "propranolol", "bisoprolol", "digoxin", "amiodarone"],
    "severe",
    "These slow AV conduction further — in second- or third-degree block they can stop the heart. Avoid unless the patient is paced.",
    { alternatives: DHP_OR_ARB }),

  ...rule("icd10_contraindications#5", [["K25", "Gastric ulcer"], ["K26", "Duodenal ulcer"]],
    ["aspirin", ...NSAIDS_ORAL], "severe",
    "An NSAID on a peptic ulcer risks perforation and bleeding — use paracetamol, and cover with pantoprazole if an NSAID cannot be avoided.",
    { alternatives: PARACETAMOL, routeScope: "systemic_only" }),

  ...rule("icd10_contraindications#7a", CKD_FAILING, ["metformin"], "severe",
    "Metformin accumulates below eGFR 30 and can cause fatal lactic acidosis — stop it. Linagliptin needs no dose change in kidney disease.",
    { alternatives: [{ moiety: "linagliptin", label: "Linagliptin 5 mg" }] }),

  ...rule("icd10_contraindications#7b", [["N18.32", "Chronic kidney disease, stage 3b"]],
    ["metformin"], "moderate",
    "At stage 3b metformin is capped at 1 g a day and stopped if the eGFR falls further — check the eGFR before repeating.",
    { alternatives: [{ moiety: "linagliptin", label: "Linagliptin 5 mg" }] }),

  ...rule("icd10_contraindications#8a",
    [["N18.3", "Chronic kidney disease, stage 3 (moderate)"], ...CKD_FAILING],
    [...NSAIDS_ORAL], "severe",
    "NSAIDs cut renal blood flow and can tip moderate kidney disease into acute injury — use paracetamol.",
    { alternatives: PARACETAMOL, routeScope: "systemic_only" }),

  ...rule("icd10_contraindications#8b", CKD_FAILING, ["nitrofurantoin"], "severe",
    "Nitrofurantoin needs filtration to reach the bladder — below eGFR 30 it does not treat the infection and its metabolites accumulate. Use fosfomycin.",
    { alternatives: [{ moiety: "fosfomycin", label: "Fosfomycin 3 g sachet" }] }),

  ...rule("icd10_contraindications#9", [
    ["H40.03", "Anatomical narrow angle"],
    ["H40.06", "Primary angle closure without glaucoma damage"],
    ["H40.2", "Primary angle-closure glaucoma"],
  ], [...ANTICHOLINERGICS, "ephedrine", "pseudoephedrine"], "severe",
    "An anticholinergic or a sympathomimetic widens the pupil and can close a narrow angle — acute glaucoma blinds within hours. Open-angle glaucoma is not at this risk.",
    { alternatives: [{ moiety: "mebeverine", label: "Mebeverine 135 mg" }] }),

  ...rule("icd10_contraindications#10", [["N40", "Benign prostatic hyperplasia"]],
    ["dicycloverine", "oxybutynin", "amitriptyline", "hydroxyzine", "promethazine", "pseudoephedrine", "phenylephrine"],
    "severe",
    "Anticholinergics and alpha-agonists tip an enlarged prostate into acute retention — avoid, or tell the patient to report difficulty passing urine.",
    { alternatives: [{ moiety: "cetirizine", label: "Cetirizine 10 mg" }] }),

  ...rule("icd10_contraindications#11", [["G40", "Epilepsy and recurrent seizures"]],
    ["tramadol", "bupropion", "clozapine", "theophylline", "chlorpromazine"], "severe",
    "These lower the seizure threshold and can break through control in epilepsy — use paracetamol for pain; gabapentin is safe.",
    {
      alternatives: [
        { moiety: "paracetamol", label: "Paracetamol 650 mg" },
        { moiety: "gabapentin", label: "Gabapentin 300 mg" },
      ],
    }),

  ...rule("icd10_contraindications#12", [["G70", "Myasthenia gravis and other myoneural disorders"]],
    ["gentamicin", "amikacin", "tobramycin", "ciprofloxacin", "levofloxacin", "moxifloxacin"], "severe",
    "Aminoglycosides and quinolones block neuromuscular transmission — in myasthenia gravis they can precipitate a respiratory crisis.",
    {
      alternatives: [
        { moiety: "amoxicillin", label: "Amoxicillin-clavulanic acid 625 mg" },
        { moiety: "cefuroxime", label: "Cefuroxime 500 mg" },
      ],
    }),

  ...rule("icd10_contraindications#13",
    [["K70", "Alcoholic liver disease"], ["K74", "Fibrosis and cirrhosis of liver"]],
    ["methotrexate", "leflunomide", "diazepam", "lorazepam", "alprazolam"], "severe",
    "A scarred liver clears these poorly — methotrexate and leflunomide drive the fibrosis on, and a benzodiazepine can precipitate encephalopathy."),

  ...rule("icd10_contraindications#14", [["M10", "Gout"]],
    ["hydrochlorothiazide", "chlortalidone", "indapamide", "furosemide", "torasemide"], "moderate",
    "Thiazide and loop diuretics raise urate and can set off an attack of gout — losartan lowers urate and treats the blood pressure.",
    { alternatives: [{ moiety: "losartan", label: "Losartan 50 mg" }] }),
];
