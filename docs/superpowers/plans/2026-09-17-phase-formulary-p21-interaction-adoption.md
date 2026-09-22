# Formulary P21 — the clinical master's drug–drug rules, adopted by resolution (2026-09-17)

**Lane** `formulary` worktree, branch `lane/p21-interactions` (stacked on P20). No migration.

## 1. WHY

The owner (2026-09-17): *"I have provided the database for that already, that database includes
dedicated datasets for clinical checks and drug-drug interactions (DDI)."* The bundle was
re-downloaded from the updated link. Its only change is a 97,296-row ICD-10 catalogue. The copy is
kept at `/opt/hmis-context/cds-bundle/` with its checksum.

## 2. WHAT THE DATASET ACTUALLY HOLDS (measured, and reported to the owner as measured)

| part | rows | usable as a clinical check? |
|---|---|---|
| `ddi_rules` | **10**, class-level ("NSAIDs × oral anticoagulants") | yes, once expanded to named moieties and checked; one rule is wrong for one of the drugs it names (§3) |
| `cyp450_interaction_matrix` | 5 | yes, the same way |
| `allergy_cross_reactivity_rules` | 6 | only through drug classes on moieties. The allergy check already works by class, but the vocabularies differ (NOT BUILT) |
| `therapeutic_subclass_groups` | 5 | duplicate-class alerts; the check today catches duplicates of one moiety, not of a class (NOT BUILT) |
| `g6pd_deficiency_rules`, `pregnancy_trimester_matrix`, `cumulative_qtc_risk_rules`, `dialysis_clearance_rules`, `lab_diagnostic_rules`, `electrolyte_hazard_rules`, `vitals_safety_rules` | 4–8 each | each needs a patient fact the record does not hold (G6PD status, pregnancy, QTc, dialysis) or a lab/vitals feed into prescribing (NOT BUILT) |
| `clinical_knowledge` | 10,303 | templated monograph text with visible errors; **not shown to clinicians** |
| `drug_faqs` | 42,819 | patient-facing FAQ text of the same quality; not used |
| `generics` / `medicines_brands` / `substances` | 10,303 / 93,905 / 3,283 | the same national release the formulary already imports (NRCeS 2026-09) |
| `icd10_catalog` | 97,296 | a diagnosis catalogue, not a prescribing check |

So a real drug-interaction book comes from 15 rules, not from a dataset of interactions. Ten
class-level rules cover a small fraction of what a licensed interaction database (for example Lexicomp or
Micromedex) holds. The hospital should still license one; this adoption is a floor.

## 3. DECISIONS

- **I-1. Adopted by a named resolution, like the substances (owner ruling 2026-09-16).**
  - A person adopts, and every pair's `source` is `resolution:<ref> (<source rule>)`.
  - A pair already recorded is never touched, because a curator's downgrade stands.
- **I-2. Expanded to named moieties, and checked before listing.** 157 pairs, 122 severe and 35
  moderate. The rule file `scripts/data/interaction-rules-2026-09-17.ts` names the source rule of
  each group, and every correction:
  - Azithromycin is left out of the macrolide–statin rule; it is not a meaningful CYP3A4 inhibitor,
    and the source's own CYP table agrees.
  - Paracetamol × isoniazid is `moderate`, not RED.
  - Diltiazem × beta-blocker is `moderate`; verapamil × beta-blocker is `severe`.
- **I-3. Severity and route.**
  - RED is `severe`: a hard warning the prescriber clears with a reason, and at the counter a
    refusal unless the prescriber cleared it.
  - AMBER is `moderate`: a notice.
  - NSAID and quinolone pairs are `systemic_only`.
- **I-4. Only moieties are paired.**
  - A name that is not a moiety yet (absent from the formulary, or a release entry still pending) is
    reported and skipped.
  - The adoption is re-run after the substance adoption, and it is idempotent.
  - ~~Some names are not in the national release at all (for example isoniazid, candesartan,
    amiloride, acenocoumarol, bupropion, fluvoxamine, calcium carbonate).~~ **Corrected
    2026-09-17.** That list was read off `hmis_formulary_dev`, where those substances were still
    pending, not off the release.
    - On the rehearsal database `hmis_formulary_prodlike` (the owner's decisions applied), a
      read-only query found 70 of the 72 names as moieties.
    - The two misses were spellings. "aluminum hydroxide" there is a release entry that is not a
      moiety; the moiety is "aluminium hydroxide". "calcium carbonate" does not exist; the moiety is
      "calcium". Their 10 quinolone pairs would have been skipped silently.
    - Both are fixed in the rule file, and the list test pins the spellings.
  - **After the substance adoption, a dry run that reports any missing name is a defect.** Report it;
    do not apply around it.

## 4. WHAT WAS BUILT

- `formulary/interaction-adoption.ts`: `adoptInteractions(tx, actor, resolution, rules)`.
- `scripts/adopt-interactions.ts`: `--resolution <ref> --as <curator> [--apply]`; a dry run by
  default.
- `scripts/data/interaction-rules-2026-09-17.ts`: the 157 pairs.
- **Dry run on `hmis_formulary_dev`** (substances still pending there):
  - 3 severe and 1 moderate would be created;
  - 4 are already recorded by the starter seed;
  - 149 wait on a moiety.
  - The book was still 26 pairs afterwards (rolled back).

## 5. MUTANTS (7, each with a written prediction; 7 killed as predicted)

- **I1:** a pending release entry is paired.
- **I2:** a recorded pair is overwritten.
- **I3:** a system actor may adopt.
- **I4:** the source forgets the resolution.
- **I5:** the route scope is dropped.
- **I6:** duplicate pairs are allowed.
- **I7:** azithromycin is restored to the rule list.

## 6. NOT BUILT

- **Class assignment from the allergy cross-reactivity table.** It needs the table's class names
  mapped onto the check's class vocabulary.
- **Class-duplicate alerts** (two PPIs, two statins).
- **G6PD, pregnancy and lactation, QTc, renal/dialysis, lab and vitals rules.** Each needs a
  patient fact or a feed that prescribing does not read yet.
- **The monograph and FAQ text.** It is not fit to show a clinician as it stands.

## 7. P21b — THE OWNER'S CLINICAL MATRIX, 18 RULES (2026-09-17 evening)

- **The source.** The owner re-issued `hmis_clinical_master`'s rule file (made with Gemini) as 18
  class rules. Each rule has substance lists, mechanism, action and a suggested switch. The copy
  and its sha256 are at `/opt/hmis-context/clinical-matrix-2026-09-17b/`.
- **Owner, the same evening:** *"I don't want to buy a dataset"*. The RFQ PR (#233) was closed. The
  hospital's book stays hospital-curated and adopted by resolution. DDInter stays an internal
  benchmark (ruling of the afternoon).
- **What was added.** 230 pairs (169 severe), under `clinical_matrix#DDI_0xx`. That is everything
  the ten rules above and the starter seed did not already hold:
  - edoxaban, and etoricoxib (moderate), with anticoagulants;
  - labetalol and esmolol with non-DHP CCBs;
  - potassium citrate with ACEi/ARBs;
  - lovastatin and cobicistat with CYP3A4 inhibitors;
  - digoxin with P-gp inhibitors;
  - PDE5 inhibitors with nitrates, nicorandil included;
  - methotrexate with NSAIDs (severe, as the seed rules) and with penicillins (moderate);
  - lithium with NSAIDs, thiazides and ACEi/ARBs;
  - SSRIs/SNRIs with tramadol, linezolid and MAO-B inhibitors, and dextromethorphan (moderate);
  - opioids with benzodiazepines and Z-drugs;
  - tetracyclines, and sucralfate, zinc and ferrous ascorbate, with quinolones;
  - theophylline and aminophylline with CYP1A2 inhibitors;
  - warfarin and acenocoumarol with CYP2C9 inhibitors;
  - xanthine-oxidase inhibitors with azathioprine and mercaptopurine;
  - acenocoumarol with paracetamol;
  - aspirin with P2Y12 inhibitors (moderate).
- **Departures from the matrix.** Each is written in the rule file's header and pinned by the list
  test: diltiazem and spironolactone with digoxin, penicillins with methotrexate, dextromethorphan
  and etoricoxib are `moderate`; paracetamol × isoniazid stays `moderate`.
- **The book is now 387 pairs, 291 severe.** All **138 names are moieties** on
  `hmis_formulary_prodlike` (read-only query).
- **Tests.** The list test was red against the old book (1 of 3). Mutants B1–B5 (a severity each, a
  duplicate pair, azithromycin restored) were each predicted to fail 1 test, and each did.
- **Not built: the matrix's "one-tap switch"** (for example, offer paracetamol 650 mg in place of the
  NSAID). The note already names the alternative. A structured suggestion on the consult screen is a
  CDS/OPD UI item for a later phase.
