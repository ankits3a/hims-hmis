# Plan CDS — the doctor's clinical co-pilot, from the owner's bundle

Owner brief, 2026-09-14: *"assist doctors while consulting the patient … AI co-pilot to assist as
much as it can with LOW help from LLM … automatically highlight dangers if the patient is a child,
pregnant or has an allergy … lesser friction and faster consultancy."*

Source data: `/opt/hmis-context/cds-bundle/` (out of git, SHA256SUMS beside it).

---

## §1 · WHAT THE BUNDLE ACTUALLY CONTAINS — MEASURED, NOT SUMMARISED

Three files. **File 3 is a strict subset of File 2 and is ignored.**

| file | what | verdict |
|---|---|---|
| `cds-bundle.sql` 136 MB | 30 tables, 171,112 rows | **split verdict, below** |
| `syndromes-a.json` 76 KB | all 22 rule domains + 8 syndromes | **the asset** |
| `syndromes-b.json` 29 KB | 4 of those 22 sections | redundant |

### §1.1 · The catalogue spine is real (USE IT)

    3,283   substances       SNOMED CT sctid, synonyms
   10,303   generics         sctid + hmis_code + dose form + route + strength + composition
   93,905   medicines_brands brand ↔ generic ↔ manufacturer, all sctid-keyed

10,303 distinct generic names. This maps onto `formulary_salts` / `formulary_medicines`, which
already carry `atc_code`, `aliases`, `drug_class`, brand/form/strength.

### §1.2 · The curated rules are real (USE THEM) — and they are small

~150 rows across all 22 domains, plus 8 syndromes. **The entire safety-critical corpus is 76 KB**,
which means a clinician can read every row in a PR diff. That is the whole reason to commit it to
the repo rather than import it.

### §1.3 · The per-drug knowledge is SIX TEMPLATES fanned across 10,303 drugs (DO NOT SHIP)

    clinical_knowledge   43 columns × 10,303 rows  →  6 distinct values per column
                         `storage`                 →  1 distinct value, for every drug
    drug_faqs            42,819 rows               →  27 distinct Q/A pairs
                                                      one repeated 7,830 times
    prescribing_defaults 10,303 rows               →  6-9 distinct values per column

And the fan-out is BY CLASS, so individual rows are wrong in their specifics: the **ampicillin**
monograph's ATC field reads `J01FA10 (Azithromycin) / J01MA02 (Ciprofloxacin)` and its interaction
text warns about fluoroquinolone chelation.

**RULING (owner, 2026-09-14, implicitly — "I got this database ready for ONE purpose: to assist
doctors"): none of this is imported as molecule-level knowledge.** A per-drug page that is really
class boilerplate is the most dangerous artefact we could build, because it reads as specific. If
class-level advice is wanted later it ships labelled as class-level, against the class.

---

## §2 · THE ONE DEFECT THAT COULD HURT A CHILD

Every pediatric mL figure in the bundle is **computed for a 14 kg child** and frozen into a string:

    "3.5 mL (for 14kg: 12.5 mg/kg) Every 6h SOS"      Paracetamol 250mg/5ml
    "14 mL (1 mg/kg/day for 14kg) Morning x 3 Days"   Prednisolone 5mg/5ml
    "4 mL (8 mg/kg/day for 14kg) divided BD"          Cefixime 100mg/5ml

Measured: **19 pediatric lines, 4 state a mg/kg rate, 8 name a concentration.** The rest are fixed
doses (inhaler puffs, ORS, a zinc syrup) or are not drugs at all (cold compress, "consult a
pediatric nephrologist").

**1-tapping these as shipped gives a 7 kg infant and a 25 kg child the same 14 kg dose.** The owner's
brief asks for *"automatic pediatric weight formulas"*; the bundle ships a worked example, not a
formula. So T1 normalises every regimen line into computable fields — `mgPerKg` · `maxMgPerDose` ·
`concentrationMgPerMl` · `fixedDose` · `nonDrug` — keeping the 14 kg example as provenance, and the
mL is computed from the child in the chair. **Nineteen lines. Reviewed, not regexed:** parsing a
dose out of prose at runtime is the same defect wearing an algorithm.

---

## §3 · WHAT THE OS ALREADY HAS (build on, do not rebuild)

| already shipped | where |
|---|---|
| **zero-hallucination LLM pattern** — model receives OUR rows, returns INDEXES, non-indexes dropped by construction, deterministic keyword fallback, cached | `opd/triage.ts`, `triage-cache.ts` |
| drug/salt/brand spine with ATC + aliases + drug class | `formulary_*` tables |
| DDI matrix (salt-pair, severity, source, route scope) | `formulary_interactions` |
| allergy conflict · duplicate subclass · interaction, each with typed override | `runRxChecks` |
| vitals danger bands → flags → queue escalation | `dangerRanges` config |
| staging + review before content goes live | `formulary_staging` |
| a loader convention: parse → plan → `--apply` → one transaction + import audit row | `scripts/import-lab-catalogue.ts` |

`triage.ts` is the architecture the brief asks for, already in production for department routing:
**the model never names a thing, it only picks from ours.** The co-pilot extends that seam.

---

## §4 · THE SLICES

- **T1 · the knowledge base lands.** Tables for syndromes + the 22 rule domains, each row carrying
  its own `source`. The 76 KB corpus committed as a reviewed fixture; the 19 pediatric lines
  normalised into computable dosing fields. Loader follows the `import-lab-catalogue` shape.
- **T2 · the matcher.** Chief-complaint text → ranked syndromes. Deterministic keyword rank FIRST
  (the bundle ships the keywords); `triage.ts`'s index-selection as an optional booster. Read-only.
- **T3 · the regimen builder.** Syndrome + the patient in the chair (age, weight, pregnancy,
  allergies, G6PD) → concrete lines with the mL computed. Pure, unit-tested per weight band.
- **T4 · the desk.** Chips under the chief-complaint field; tap → regimen card → 1-tap fills the Rx
  form, every line first passed through `runRxChecks`.
- **T5 · the sentinels.** Vitals / lab / pregnancy / G6PD / QTc / ACB / AMSP as 1-tap cards
  (Accept · Switch · Reject), which is the owner's "council of co-pilots" drawing.

The catalogue import (§1.1) rides T1 as its own loader, not committed.
