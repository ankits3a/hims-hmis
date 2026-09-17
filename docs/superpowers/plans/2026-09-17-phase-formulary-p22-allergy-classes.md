# Formulary P22 — the clinical master's allergy classes, on the prescribing check (2026-09-17)

**Lane** `p19b-retail-returns` worktree, branch `lane/p22-allergy-classes`. Migration **0104**
(additive: `formulary_salts.allergy_classes jsonb not null default '[]'`).

## 1. WHY

The handoff's third item: *"Allergy class assignment from the clinical master's cross-reactivity
table. Its class names must be mapped onto the check's vocabulary first."* Measured before building,
on the rehearsal database `hmis_formulary_prodlike` (the owner's substance decisions applied):

- **2,164 of 2,178 moieties carry no `drug_class`.** The 14 that do come from the starter seed.
  Amoxicillin has none, so an allergy recorded as "penicillin" raised no class warning on any
  amoxicillin product.
- **The doctor's allergen picker** (`cds/allergens.ts`, merged with the CDS lane) records the bundle's
  class name, "Penicillins / Beta-Lactams", as both the substance and `allergenClass`. The
  prescribing check (`opd/rx-checks.ts`) compared the text with a moiety's name or `drug_class`, and
  never read `allergenClass`. **A picked class allergy never raised the hard warning.** The CDS
  co-pilot's regimen suggestions did honour it, so the two engines disagreed.
- **The seed's class keys never matched typed words either.** `ace_inhibitor` is not
  `normalizeDrugName("ACE inhibitor")`, and `nsaid` is not "NSAIDs".

## 2. WHAT THE CLINICAL MASTER HOLDS

`allergy_cross_reactivity_rules`, 6 rows: penicillins/beta-lactams, sulfonamides, NSAIDs (AERD),
opioids, ester local anaesthetics, statins. Each row has an allergen, "blocked molecules", a
severity, a reaction and safe alternatives. Three rows over-reach against standard references (§3).

## 3. DECISIONS

- **A-1. One key per class, and a moiety may belong to several.** `allergy-vocabulary.ts` holds the
  keys: `penicillin`, `sulfonamide_antibiotic`, `nsaid`, `opioid_morphinan`,
  `ester_local_anaesthetic`, `statin` and `cephalosporin`.
  - A class is about cross-reactivity, not therapy, so it is a list on the moiety
    (`allergy_classes`) beside the therapeutic `drug_class`. Cefalexin is a cephalosporin, and it
    also sits in the penicillin class.
- **A-2. An allergy reaches a class in two ways.**
  - By the class the doctor **picked**: the bundle name, compared normalised.
  - By its **whole typed text** being the class: "Sulpha drugs", "NSAIDs", "beta-lactam", "opiates".
  - A phrase that merely contains a class word ("penicillin rash as a child") is not guessed at. The
    patients module's rule is that the picker makes that judgement explicit.
- **A-3. Memberships are adopted by a named resolution** (the owner's 2026-09-16 ruling, as for P21).
  - A class is **added** to a moiety. Nothing a curator recorded is removed.
  - A name that is not a moiety yet is reported and skipped.
  - Each addition is a `salt.allergy_classes_adopted` event naming the resolution and the rule.
  - Idempotent.
- **A-4. Corrections to the reference.** The book `scripts/data/allergy-classes-2026-09-17.ts` names
  each one:
  - **#1 Penicillins.** Keeps cephalexin (spelled cefalexin) and cefadroxil for their
    aminopenicillin side chain. Adds cefaclor and cefprozil for the same reason. Later-generation
    cephalosporins are not members.
  - **#2 Sulfonamides.** Furosemide, hydrochlorothiazide and celecoxib are **not** members: they are
    non-antibiotic sulfonamides with no meaningful cross-reactivity (Strom et al., NEJM 2003).
    Dapsone is left out.
  - **#3 NSAIDs (AERD).** Non-selective COX inhibitors only. Selective and preferential COX-2
    inhibitors are the alternative offered to an AERD patient, so they are not members.
  - **#4 Opioids.** The key is `opioid_morphinan`, covering the phenanthrenes. Fentanyl, pethidine
    and tramadol, which the reference listed, are the standard alternatives from other structural
    classes, so they are not members.
  - **#5 Esters.** Adds oxybuprocaine. Cocaine and the amides are left out.
  - **#6 Statins.** Adopted, although the reaction is an intolerance, because a doctor who records
    "Statins" means to be told.
- **A-5. A seventh class, `cephalosporin`,** is the hospital's own. Every Indian hospital allergy
  list carries it and doctors type it. The picker does not offer it (it lists the bundle's six).
- **A-6. A curator can edit a moiety's classes** through `PATCH /formulary/salts/:id`
  (`allergyClasses`). `updateSalt` refuses a key the check does not know (`invalid_allergy_class`).
- **A-7. The CDS co-pilot's own block lists are unchanged.** `cds/knowledge.json` still lists
  furosemide under sulfa and fentanyl under opioids. Its suggestions are therefore more cautious
  than the prescribing check. That is the safe direction for a suggestion, and it is left to the P&T
  committee (the internal benchmark report, `/opt/hmis-context/ddinter-benchmark-2026-09-17/REPORT.md`,
  carries the committee's other open items).

## 4. AS BUILT

- **Schema and migration.** `formulary_salts.allergy_classes`, migration 0104.
- **Formulary module.**
  - `allergy-vocabulary.ts` (pure): `ALLERGY_CLASSES`, `allergyClassKeys`,
    `requireAllergyClasses`.
  - `allergy-classes.ts`: `adoptAllergyClasses`.
  - `SaltRef.allergyClasses` is carried by every resolution path: a moiety name, a medicine's
    composition, and a mapped release entry's moiety.
  - `updateSalt` and the salt PATCH route accept `allergyClasses`.
  - New event `salt.allergy_classes_adopted` and error `invalid_allergy_class`.
- **OPD.** `matchAllergiesSaltAware` reads the picked class and the moiety's classes, and
  `runRxChecks` passes `allergenClass`. The walk-in retail counter and paper dispenses use the same
  check, so a picked class now refuses a walk-in sale too.
- **Script.** `scripts/adopt-allergy-classes.ts` (`--resolution --as [--apply]`; a dry run by
  default).
- **Web.** No change. A curator screen for classes is not built (§9).

## 5. TESTS (written first)

- **`rx-checks.test.ts` (+4, pure).**
  - A picked class warns on its members, cefalexin included, and not on cefuroxime.
  - Typed class words: 8 spellings.
  - The over-reaches stay silent: furosemide, fentanyl, etoricoxib.
  - A phrase, or an unknown picked class, matches nothing.

  Run against the old check: **2 of 21 failed**, the picked-class and typed-words tests, as
  predicted. The other two are absence tests; the book test guards them.
- **`allergy-class-adoption.test.ts` (4, DB).**
  1. Adds a class and keeps the curator's; a pending entry waits; the class reaches `resolveDrugTexts`;
     a re-run adds only the newly decided moiety.
  2. Refusals: a system actor, no resolution, an unknown key, a duplicate name, no rule, and a
     curator's typo.
  3. The book's corrections are pinned.
  4. The vocabulary.
- **`test/formulary-mapping-safety.test.ts` (+1, the seam).** A real patient with a picked class and
  the doctor's own words ("Penicillin (rash, 2019)"), real `runRxChecks`. Silent before the adoption;
  both products (derived and hand-composed) warn after it.
- **`formulary/index.test.ts`.** The surface gains `ALLERGY_CLASSES`, `adoptAllergyClasses` and
  `allergyClassKeys`.

## 6. MUTANTS (14, each with a written prediction; 13 killed, 1 predicted survivor)

| # | mutant | predicted | result |
|---|---|---|---|
| A1 | `runRxChecks` drops `allergenClass` | 1 (seam) | 1 |
| A2 | the check ignores `allergyClasses` | 3 | 3 |
| A3 | the picked class is not read | 2 | 2 |
| A4 | class words matched as substrings | 3 | **2**: before adoption no moiety has a class, so wider keys change nothing there |
| A5 | adoption replaces a curator's classes | 1 | 1 |
| A6 | a pending release entry gets a class | 1 | 1 |
| A7 | the first actor check removed | 0 (the write refuses a system actor again) | 0 |
| A8 | a curator may record an unknown class | 1 | 1 |
| A9 | furosemide back in the sulfa class | 1 | 1 |
| A10 | fentanyl back in the opioid class | 1 | 1 |
| A11 | a mapped entry's moiety loses its classes | 1 (seam, hand-composed) | 1 |
| A12 | a composition's moieties lose their classes | 1 (seam, derived) | 1 |
| A13 | a moiety named by text loses its classes | 1 | 1 |
| A14 | a re-run does not count what is already recorded | 1 | 1 |

## 7. VERIFIED (lane, 2026-09-17, under the test lock)

- `pnpm typecheck`: clean. eslint on the touched files: clean.
- `drizzle-kit generate`: exactly one statement, the new column.
- Core: `src/modules/{opd,cds,pharmacy,patients,formulary}`, `test/formulary*`,
  `test/drizzle-snapshot-chain`, `test/migrate-watermark`, `test/import*`,
  `test/draft-substance-mappings`, `test/seed-roles` and the two OPD end-to-end tests give
  **122 suites, 1,137 tests, all green**.
- **The book holds 104 memberships over 100 distinct moieties.** Cefalexin, cefadroxil, cefaclor and
  cefprozil are each in two classes. **All 100 are moieties** on `hmis_formulary_prodlike`
  (read-only query, 2026-09-17).

## 8. OWNER'S PRODUCTION STEP (after the substance adoption; dry run first)

```bash
$P run --rm api node dist/scripts/adopt-allergy-classes.js \
   --resolution owner-resolution-2026-09-17-allergy-classes --as admin
# read it: "not a moiety here" must be 0 after the substance adoption; then add --apply
```

## 9. NOT BUILT

- **A curator screen for allergy classes.** The API accepts them; the formulary admin screen does
  not show them yet.
- **Aligning the CDS co-pilot's block lists** (`cds/knowledge.json`) with the corrections (A-7).
  That is for the P&T committee.
- **Graded cross-sensitivity** (for example "caution" rather than a hard warning for a
  same-side-chain cephalosporin). The check has one allergy severity: a hard warning the prescriber
  clears with a reason.
- **Therapeutic duplicate classes** (two PPIs, two statins), from `therapeutic_subclass_groups`.
