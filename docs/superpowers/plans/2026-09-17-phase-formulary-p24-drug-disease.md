# Formulary P24 — the diagnosis joins the prescription check, and the alert offers a switch

Lane `drug-disease`, branch `lane/drug-disease`, cut from `origin/main` at `e0c26b74`.

## Why this, now

Three of the four prescribing-safety axes are built and live on main:

| axis | where | shipped |
|---|---|---|
| drug × drug | `checkInteractions`, `rx-checks.ts:189` | P21, P21b — 387 pairs |
| drug × allergy | `matchAllergiesSaltAware`, `rx-checks.ts:129` | P22 — 7 class keys, 104 memberships |
| drug × drug (same class) | `checkDuplicateClass`, `rx-checks.ts:339` | P23 — PPI, ACEi, ARB, statin, NSAID |
| **drug × disease** | **missing** | **this phase** |

The fourth axis is the one that kills in an Indian OPD: propranolol written for a patient whose
chart says asthma, diclofenac for one with a gastric ulcer or CKD, metformin at eGFR nothing.

The owner supplied the book for it on 2026-09-17 (evening), built with Gemini: drug–disease
contraindications keyed on **3-character ICD-10 categories**, each row carrying severity, the
hazard mechanism, the clinical action and **a named safe alternative**.

That last column is why this phase carries two things and not one. The handoff's next item was the
**one-tap switch** — and the alternative is already in the data on both axes:

- the owner's 18-rule DDI matrix carries `suggested_switch: { substitute_for, target, sig }` on
  every rule (`/opt/hmis-context/clinical-matrix-2026-09-17b/hmis_ddi_rules.json`). **P21b imported
  the pairs and dropped that field** — `grep -rn "suggested_switch\|suggestedSwitch"` over `apps/`
  and `packages/` returns nothing;
- the new drug–disease rows carry `safe_alternatives` in the same spirit.

So one lane ships the missing axis *and* the affordance, from data already on disk.

**The point of the project.** An alert that only says *no* hands the work back to the doctor at the
moment they are busiest, and three seconds later it is dismissed. An alert that says *propranolol
is contraindicated in J45 — bronchospasm; amlodipine 5 mg instead* with a button that rewrites the
line is a colleague. Same book, opposite behaviour at the counter. That is the co-pilot.

## What exists to build on (measured in this worktree at `e0c26b74`, not remembered)

- `opd_encounter_diagnoses(encounter_id, seq, text, icd10_code)` — `kernel/db/schema/opd.ts:644`,
  migration `0087`. Indexed on `icd10_code`. **Written today** by `writeDiagnosisRows`
  (`opd/consultation.ts:98`) from the consult screen's `TagField`
  (`apps/web/src/screens/opd-consult.tsx:2105`), which suggests from
  `GET /opd/cds/complete/diagnosis` → `searchIcd10` (`modules/cds/icd10.ts:58`).
- `icd10_codes` — 97,296 rows, dotted `code` PK, `billable` false on the 23,252 **category
  headers**, which is exactly the 3-character label this book needs. Migration `0086`, importer
  `scripts/import-icd10-catalogue.ts`.
- `runRxChecks(db, patientId, lines, now, opts)` — `opd/prescriptions.ts:144`. One pipeline, three
  pure checks composed in one return literal (`:120-125`), two call sites (`precheckPrescription`,
  `issuePrescription`) and no third.
- The book pattern to copy: `modules/formulary/interaction-adoption.ts` (the rules as a typed
  constant + an `adopt*` function reporting `created / alreadyRecorded / missing / skipped`),
  `scripts/adopt-interactions.ts` (dry-run by default, `--apply`, `--resolution`, `--as`).

## What is NOT here

- `hmis_gemini_copilot.py` sends the encounter to an LLM at prescribe time. Gated: 12a runtime and
  the DPIA. This phase is the deterministic book only.
- No DDInter row reaches a clinician (owner's ruling, 2026-09-17 afternoon).

## What production looks like today, measured 2026-09-17

    icd10_codes                97,296        opd_encounter_diagnoses rows            1
    of those, coded                 1        rows in the book's twelve categories     0

The catalogue is fully loaded. **One diagnosis has ever been recorded in production.** No doctor is
doing consults in HMIS yet — the 24 OPD doctors were provisioned this morning.

Two consequences, both of which shape this phase rather than stopping it:

1. **There is no calibration data, and there will be none until doctors arrive.** The share of
   diagnoses that carry a code rather than free text is unmeasurable at n=1. So the design cannot
   be tuned against observed behaviour, and must be conservative by construction — which is
   precisely why D1's two splits matter. A false-alert rate that would have been caught in a week
   of real use has to be reasoned out instead.
2. **The rails must exist before the first patient, not after.** A safety check built after doctors
   have learned to prescribe without one is a check they experience as an obstacle. Built before,
   it is simply how the screen works. This is the right time to build it, and the last cheap one.

The corollary for the wider project: four safety axes are being built for a consult screen nobody
has used yet. Whatever gets doctors actually consulting in HMIS is worth more than a fifth axis,
and that judgement belongs to the owner.

## Rulings — DECIDED under CLAUDE.md ("pick the standard Indian-corporate-hospital answer")

**D1 — the key is a code PREFIX, three characters by default and longer where three cannot see the
thing that matters.**
Diagnoses are recorded as full dotted codes (`J45.909`); the book is keyed on a prefix and matched
with `icd10_code like prefix || '%'`. The column is `icd10_prefix text` with a CHECK that it is
uppercase, 3 to 7 characters, and starts with a letter. No foreign key to `icd10_codes` — the same
law the diagnosis column already follows: a foreign standard's coverage must never become a
clinical constraint.

The owner's book keys every rule at three characters. **Measured against the real catalogue, two of
its twelve categories are too coarse and would fire on patients who are in no danger:**

- **`H40` glaucoma.** Anticholinergics threaten the *angle-closure* eye: `H40.03` anatomical narrow
  angle, `H40.06` primary angle closure, `H40.2x` primary angle-closure glaucoma (47 codes). They
  are not contraindicated in **open-angle** glaucoma — `H40.1x`, **112 codes**, and much the
  commoner disease. Keyed at `H40`, the rule cries wolf on the majority of glaucoma patients. The
  rule is split to the angle-closure prefixes.
- **`N18` chronic kidney disease.** Metformin is first-line and appropriate at `N18.1` and `N18.2`
  (stages 1 and 2). The lactic-acidosis hazard is stage 4 and beyond — `N18.4`, `N18.5`, `N18.6` —
  with care at `N18.32` (stage 3b). Keyed at `N18`, the rule would refuse metformin to a stage-1
  patient for whom it is the correct drug. Gate at stage 4+; `N18.3x` is a notice that asks for the
  eGFR; stages 1 and 2 raise nothing.

This is the difference between a co-pilot and an alarm nobody reads. A false alert costs more than
a missing one, because it teaches the doctor to clear the dialog without reading it — and then the
true alert is cleared the same way. Both splits are recorded as departures in the book, with the
owner's original three-character key beside them.

**D2 — which diagnoses count, and what each one may do.**
There is no problem list in this system: `opd_encounter_diagnoses` has no `patient_id`, no status,
no onset, no resolved-at. Building one is an MRD phase, not this one. So:

- the check reads the patient's coded diagnoses by joining `opd_encounter_diagnoses` →
  `opd_encounters(patient_id)`;
- a diagnosis coded **in this encounter, or within 365 days** may GATE (severe) — refuse with the
  existing override dialog and a typed reason, exactly as a severe interaction does today;
- a diagnosis **older than 365 days** is a soft NOTICE whatever its severity, because a code typed
  once two years ago must not force an override on every prescription a patient is ever written;
- every hit names **the date it was coded**, so the doctor judges the evidence rather than the
  system pretending to.

**D3 — severity keeps the words the system already speaks.**
The book's `RED` maps to `severe`, `AMBER` to `moderate` — the two values
`formulary_interactions_severity_ck` already pins and the consult screen already renders. A third
vocabulary on a fourth axis would be a second dialect for one idea.

**D4 — the switch suggests a moiety and a sig, never a product.**
`alternative: { label, moiety, sig }`. One tap rewrites the line's drug text and re-runs the
precheck; the doctor's own picker resolves it to a product. Choosing the *product* is a stock and
tariff decision and does not belong to a safety book.

**D6 — an alternative is re-checked against THIS patient before it is offered. The book alone may
not speak.**
Measured on the book itself, not imagined: row 2 (`I50` heart failure, non-dihydropyridine CCBs)
suggests **carvedilol**, and row 0 (`J45` asthma) lists carvedilol as a critical contraindication.
It also suggests **metoprolol succinate**, which row 4 (`I44` AV block) forbids. A patient with
heart failure and asthma — an ordinary OPD patient — would be handed carvedilol by one tap.

So the switch is not a string from a column. Before a suggestion is rendered, the alternative is
run through `runRxChecks` for this patient, with the offending line replaced, and an alternative
that raises a hit of its own **is not offered**; where every alternative in a row falls, the notice
renders with its prose action and no button. A co-pilot that hands over a second hazard in one tap
is worse than one that says nothing.

This is a property of the mechanism, not of the owner's clinical content: carvedilol is both a
beta-blocker to avoid in asthma and a cornerstone of heart failure, and the book is right twice.
The P&T committee is told; the code does not edit the claim.

**D5 — the alternative is carried by every notice kind, not only the new one.**
The field is hoisted onto the shared base of `InteractionHit` and `DuplicateHit`
(`rx-checks.ts:42,50`) and populated at the four `hits.push` literals. `isInteractionHit`
discriminates on `"severity" in hit` (`apps/web/src/lib/opd-api.ts:243`) — so nothing that would
give `DuplicateHit` a `severity` field.

## The book, measured before it is written into code

`/opt/hmis-context/icd10-contraindications-2026-09-17/hmis_icd10_drug_contraindications.json`,
extracted 2026-09-17 from the owner's Drive zip, checksummed beside it.

    rules            15          categories       12        distinct substances     57
    RED (critical)    8          RED (high risk)   6        AMBER (moderate)         1

The owner's message of 2026-09-17 tabulated 12 of these; the JSON is the authority and carries
three the message did not, including `K70` (hepatic disease × methotrexate, leflunomide and the
benzodiazepines). **The book is taken from the JSON, never from the message.**

Coverage against `hmis_formulary_prodlike`, by the same `isMoiety` predicate the adoption uses
(read-only SELECT): **52 of 57 match a moiety by name.** All five remaining are this formulary's
INN spelling, so the adoption's "waiting on a moiety" can be 0 on the first run:

| the book says | this formulary holds | note |
|---|---|---|
| dicyclomine | `dicycloverine` | INN |
| indomethacin | `indometacin` | INN |
| chlorthalidone | `chlortalidone` | the same spelling that cost P21 ten pairs |
| torsemide | `torasemide` | **and a non-moiety release image literally named `Torsemide` exists — a name match that does not also ask `isMoiety` binds the wrong row** |
| acetylsalicylic acid | `aspirin` | a synonym; both are listed in the same rule |

The mapping is written in the book module beside the rule, as a declared synonym with the reason,
not silently normalised: a future release that adds `dicyclomine` as its own row must not change
what this book means.

**D7 — the check asks about the line being written, not about what the patient already takes.**
The interaction check reads prior prescriptions; this one does not. A doctor who has just coded
`N18.4` and whose patient is already on metformin from last month is looking at a real hazard — but
they cannot act on it from the prescribing gate, because that drug is not on the prescription in
front of them. An alert nobody can act on is the kind that gets dismissed.

So the sweep of a patient's CURRENT drugs against a newly coded diagnosis is a named deferral: it
is a review card on the consult screen ("this new diagnosis conflicts with 2 of their current
medicines"), with its own place and its own moment, and it is not built here.

## Tasks

- **T1 — the book.** `modules/formulary/drug-disease-adoption.ts`: the owner's rules as a typed
  constant (`DrugDiseaseRule = { rule, icd10Category, categoryTitle, moieties[], severity,
  mechanism, action, alternative }`), plus `adoptDrugDisease(tx, actor, resolution)` reporting
  `created / alreadyRecorded / missing / skipped` like its sibling. A moiety this formulary does not
  hold is reported and skipped, never created. Test pins the count and the well-formedness of every
  row, and the departures from the source.
- **T2 — the table.** `formulary_drug_disease`, beside `formulary_interactions`
  (`schema/formulary.ts:566`). Migration `0105`, numbered at rebase, not now. Schema census
  (`kernel/db/schema/formulary.test.ts`) updated in the same commit.
- **T3 — the adoption script.** `scripts/adopt-drug-disease.ts`, dry-run first, `--apply`,
  `--resolution owner-resolution-2026-09-17-drug-disease`, `--as admin`. A stand-up gate beside
  `formulary_interactions_loaded` (`scripts/standup-check.ts:239`) so an empty book cannot go green.
- **T4 — the read.** `listDrugDiseaseFor(db, saltIds, categories)` in `modules/formulary/resolve.ts`,
  re-exported from the module's `index.ts` (lint pins that door).
- **T5 — the check.** `checkDrugDisease(lines, diagnoses, rules, now)` — pure, no db — beside its
  three siblings in `rx-checks.ts`. Wired into the one return literal in `runRxChecks`, with the
  diagnosis read added beside the allergy read. `RxCheckOutcome` and `RxPrecheckResult` each gain
  one field. The gate block mirrors `interaction_conflict`, with its own error code and override
  input.
- **T6 — the switch, on the wire.** D5's field, populated for the new axis from the book and for
  interactions from the owner's `suggested_switch` (a re-adoption that fills the column, not a
  second book).
- **T7 — the switch, on the screen.** The `rx-notices` panel (`opd-consult.tsx:2495`) grows a
  per-notice action beside today's single `Dismiss`; the override dialog rows
  (`:2874-2903`) get the same affordance, so the switch is offered where the doctor is actually
  stopped. i18n strings in both locale files.

Shipped as two PRs: T1–T5 (the axis), T6–T7 (the switch).

## Verification

- Test first, and prove the red: `git show HEAD:<path>` back, run, read why it fails.
- Mutants with written predictions before running them.
- Censuses outside the module: schema census (T2), no new role grant, no new web route.
- Browser walk at 1280 and 400 px before either PR is called done.
- Every jest and vitest run under `$L run drug-disease …`.

## What the owner owes this phase

1. `/opt/hmis-context/icd10-contraindications-2026-09-17/` — the Drive `exports/` files, above all
   `hmis_icd10_drug_contraindications.json`. Until it lands the book is transcribed from the
   owner's message of 2026-09-17 and must be diffed against the JSON before the PR is marked ready.
2. ~~The production runbook is missing the ICD-10 catalogue import.~~ **Measured and closed,
   2026-09-17:** `select count(*) from icd10_codes` on production returns **97,296**. The runbook
   omits the step, but the catalogue was loaded when the CDS work went live, so nothing is owed.
   The reasoning was right and the conclusion was wrong: a step absent from a runbook is evidence
   about the RUNBOOK, not about the database. The database was never asked until it was.
