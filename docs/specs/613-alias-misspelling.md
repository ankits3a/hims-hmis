---
issue: 613
status: built
approved: 2026-10-23
---
# SPEC — Medicine aliases: misspellings and abbreviations (#613 item 4)

Status: BUILT 2026-10-23 (see "As built"). APPROVED 2026-10-23. Draft of 2026-10-15 (lane alias-ndps-normalise, PR #873). The strict line
(chooser 0.95, reviewer 0.9, decision 0055) is NOT lowered. The pipeline stays switched off
(`ALIAS_PIPELINE_ENABLED`); switching it on is a separate step.

## Measured (strict run, 2026-10-08)

- Misspellings: 2 of 38 answered. Abbreviations: 0 of the 5 that have a right answer (20 of 25 are labelled
  "too vague").
- In every misspelling item the right product WAS among the five shown; the chooser refused (`chooser_none` or
  below 0.95) because it was shown the misspelt word ("paracetmol 650").

## The owner's answers (2026-10-23)

1. Correct the spelling by rule before the models, keeping the strict line: **yes**.
2. The abbreviation list is signed by the pharmacist (the same reviewer as #639), and an unsigned row is unused
   until it is signed: **yes**.
3. One paid evaluation through the outside APIs (about $0.02) once built: **yes, once**.

## Build

1. **Spelling corrected by rule, before any model.** The term's name is one word of letters. It is corrected to
   moiety `m` only when all of these hold:
   - the word is not itself a moiety name, nor the called name of a brand of a different moiety;
   - `m` is the ONLY moiety within the look-alike distance of the word (two edits from seven letters, one from
     four to six, decision 0051's interim line);
   - no other moiety, and no brand of a different moiety, is within `d + 1` edits, where `d` is the word's
     distance to `m`;
   - `m` is not on the look-alike list (`opd_lasa_pairs`);
   - the correction keeps the word's first three letters.
   The chooser and the reviewer are shown the corrected term ("paracetmol 650" → "paracetamol 650"), and the
   candidates for the corrected word are added to the pool. Every rule still runs on the term as typed, and the
   alias row is still keyed on the term as typed.
2. **Abbreviation list, pharmacist-signed** (`opd_medicine_abbreviations`, like `opd_lasa_pairs`): one row maps
   an abbreviation to one moiety (hctz → hydrochlorothiazide, amox → amoxicillin, cipro → ciprofloxacin). Only a
   row that is active AND signed is used. That is the opposite of the look-alike list, which warns while
   unreviewed, because a list that answers must be stricter than one that only warns. It ships with proposed
   rows, all unsigned. A person with `opd.masters.manage` signs or switches a row off
   (`GET`/`PUT /opd/consult/abbreviations`); a machine actor cannot.
3. Controlled medicines are still refused first, for the typed word and the corrected one.

## Done means

- **D1** "paracetmol 650", "pantaprazole 40" and "amoxycillin 500" reach the chooser and the reviewer corrected
  ("paracetamol 650", "pantoprazole 40", "amoxicillin 500"); the proposal is still the term as typed.
- **D2** "glimipizide 5" and "carbazepine 200" (two moieties near), "glibenclazide 5" (its moiety is on the
  look-alike list) and "amlodarone 5" (the correction would change the first three letters) are NOT corrected.
- **D3** No change for not-a-medicine and controlled items: a word that corrects to a controlled medicine is
  refused before any model call, and `lookalike_conflict` still refuses a misspelt term whose target is on the
  look-alike list.
- **D4** An unsigned abbreviation row is never used; a signed one is ("amox 500" reaches the chooser as
  "amoxicillin 500"); a switched-off signed row is not used.
- **D5** The shipped abbreviation rows are all unsigned, and the table refuses a row marked signed without a
  signer.
- **D6** The proposal records the correction it made (`correction: { kind, from, to }`, or null), so the
  evaluation can count what the correction changed.

## Before anything is switched on

One new evaluation run (outside APIs, about $0.02), shown to the owner: 0 wrong at 0.95 / 0.9, and the
misspelling and abbreviation answered counts. The held-out set's labels are not changed, and the abbreviation
rows in the evaluated catalogue are as shipped (unsigned), so abbreviations are measured as the owner will
first see them.

## As built (2026-10-23)

- **Departure from the draft's wording, DECIDED:** the draft said "no other moiety or brand within distance + 1".
  Read as the look-alike distance + 1, it refuses its own D1 examples ("pantaprazole" has lansoprazole three
  edits away; "amoxycillin" has oxacillin, ampicillin and cloxacillin). So the rival radius is `d + 1` (the
  distance to the corrected moiety), and the kept first three letters are what refuse "amlodarone". A brand
  whose moieties include the target is not a rival ("Amoxycillin (amoxicillin)" is a brand of amoxicillin).
- **Stricter than the draft, DECIDED:** the rules run on the term as typed over the pool of BOTH searches (the
  typed word's and the corrected word's), so the other strengths and combinations of the target are seen.
  A word that corrects to a controlled product is refused like the correctly spelt word.
- The list's screen is not built: rows are signed through `PUT /opd/consult/abbreviations/:id`
  (`opd.masters.manage`, a person only). Seven proposed rows ship unsigned (amox, azithro, cipro, doxy, hctz,
  metro, pcm); error-prone abbreviations (MTX, ASA, HCT, MS) are left out.
- **The one paid evaluation (2026-10-23, 296 terms, chooser 0.95 / reviewer 0.9, staging catalogue copy):**
  43 answered, 43 right, **0 wrong**. Misspellings: 2 of 38 answered (unchanged). Abbreviations: 0 of 25 (no
  row is signed yet). The rule corrected 14 misspelt terms, every one to the right moiety, and no term of any
  other category. None of the 14 became an answer: the chooser still said none or stayed below 0.95 on the
  corrected word (eleven), two were refused as controlled because the corrected generic also appears in a
  controlled combination, and one ("levothyroxin 50 mcg", right before) is now refused as a look-alike
  conflict because the wider pool shows a levothyroxine + liothyronine combination. So the misspelling was
  not the main reason for the refusals: the correctly spelt generics answer 2 of 26 as well. Cost: the
  reviewer used 140,456 input tokens, $0.014 at OpenAI's published price; the chooser used 139,998 input tokens.
