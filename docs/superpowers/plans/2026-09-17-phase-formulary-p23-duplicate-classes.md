# Formulary P23 — duplicate therapy by class, from the clinical master (2026-09-17)

**Lane** `p19b-retail-returns` worktree, branch `lane/p23-duplicate-classes` (after P22). No
migration.

## 1. WHY

P21's phase doc lists *"Class-duplicate alerts (two PPIs, two statins)"* as not built, and so does
P22's §9. The owner's clinical master holds `therapeutic_subclass_groups`: five groups, each
`max_allowed_agents = 1`, each with a "duplicate therapy alert". The prescribing check caught only
the SAME moiety twice (`checkDuplicateSalt`). Pantoprazole beside omeprazole, or diclofenac beside
etoricoxib, passed in silence.

On the rehearsal database only 7 moieties carry one of these classes: the starter seed's
atorvastatin, simvastatin, enalapril, ramipril, aspirin, ibuprofen and diclofenac.

## 2. DECISIONS

- **D-1. The class is the moiety's `drug_class`, a single value.** A moiety belongs to one
  therapeutic class. That differs from P22's allergy classes, which are a list because they are
  about cross-reactivity. The keys are the starter seed's: `ppi`, `ace_inhibitor`, `arb`, `statin`
  and `nsaid`. The formulary module owns the list (`THERAPEUTIC_DUPLICATE_CLASSES`).
- **D-2. Always a notice, never a gate.** A second agent of a class, against another line or a
  current prior course, is a `DuplicateHit` with `hard: false`, `drugClass` and `with` (the other
  moiety). It reaches the doctor's notices and the pharmacist's count, and blocks nothing.
  - A planned switch between two statins or two PPIs overlaps on purpose.
  - The source's alert is advice.
  - A hard duplicate with an override would need the override's identity to carry the class
    (C5), which the consult screen does not send.
- **D-3. Quiet where the duplicate is not one.**
  - The same moiety twice is `checkDuplicateSalt`'s hit and is not repeated.
  - A topical line beside a systemic one is quiet (a diclofenac gel with an oral coxib).
  - An expired prior course is quiet.
  - **Low-dose aspirin is not flagged.** It is an antiplatelet here, and an NSAID beside it is the
    interaction book's question. It keeps `drug_class = nsaid` for the allergy path.
- **D-4. Adopted by resolution** (the owner's 2026-09-16 ruling):
  - the class is set only where none is recorded;
  - a moiety a curator put in a different class is reported, never changed;
  - a name that is not a moiety yet is reported and skipped;
  - each setting is a `salt.therapeutic_class_adopted` event naming the resolution and the group.
- **D-5. The book (`scripts/data/therapeutic-classes-2026-09-17.ts`) completes each group** from
  the national release.
  - **NSAID group:** the source lists seven non-selective agents. The book adds the coxibs and
    the preferential agents, because a coxib beside diclofenac is the duplication an Indian OPD
    makes. Flupirtine is not an NSAID.
  - **Missing spellings:** names the release does not hold as moieties are left out (candesartan
    cilexetil, olmesartan medoxomil, enalaprilat, ilaprazole).
  - **Aspirin:** not listed (D-3).

## 3. AS BUILT

- **`formulary/therapeutic-classes.ts`:** `THERAPEUTIC_DUPLICATE_CLASSES`, `adoptTherapeuticClasses`.
  Also a new event, and new exports (the surface pin is updated).
- **`opd/rx-checks.ts`:** `checkDuplicateClass`; `DuplicateHit` gains `drugClass` and `with`.
  `runRxChecks` returns both duplicate kinds in `duplicates`.
- **`scripts/adopt-therapeutic-classes.ts`** (`--resolution --as [--apply]`; a dry run by default).
- **Web.** The consult screen's notice reads "Line 1: rosuvastatin is a second statin, with
  atorvastatin" (en and hi, one class label per key).

## 4. TESTS

- **`rx-checks.test.ts` (+3, pure):**
  1. a second agent in one prescription;
  2. against a current prior, never an expired one;
  3. quiet for the same moiety, a gel beside a tablet, aspirin, and a class outside the five;
     loud for two systemic NSAIDs.
- **`therapeutic-class-adoption.test.ts` (3, DB):**
  1. sets, keeps, reports a conflict, waits for a pending entry; idempotent;
  2. refusals;
  3. the book.
- **`test/duplicate-therapy.test.ts` (1, the seam):** real moieties and medicines, real
  `runRxChecks`. Silent before the adoption, one soft class notice after it.
- **`opd-consult.test.tsx`:** the notice panel renders a class hit with its class.

## 5. MUTANTS (10, each with a written prediction; 10 killed, every count as predicted)

| # | mutant | predicted | result |
|---|---|---|---|
| D1 | `runRxChecks` does not call the class check | 1 (seam) | 1 |
| D2 | aspirin is flagged | 1 | 1 |
| D3 | a gel beside a tablet is flagged | 1 | 1 |
| D4 | an expired prior course is flagged | 1 | 1 |
| D5 | the same moiety is flagged as a class duplicate | 1 | 1 |
| D6 | an in-prescription class hit is hard | 2 (pure and seam) | 2 |
| D7 | the adoption overwrites a curator's class | 1 | 1 |
| D8 | an unknown class is accepted | 1 | 1 |
| D9 | flupirtine in the NSAID group | 1 | 1 |
| W1 | the consult screen shows a class hit as a plain duplicate | 1 | 1 |

## 6. VERIFIED (lane, 2026-09-17, rebased onto main after #231, under the test lock)

- `pnpm typecheck`: clean. eslint on the touched files: clean.
- **Core.** The modules `src/modules/{opd,formulary,pharmacy,cds}` and `src/kernel/db/schema`, plus
  these tests: `test/duplicate-therapy`, the four `test/formulary-*`, `test/drizzle-snapshot-chain`,
  `test/opd.e2e` and `test/pharmacy.e2e`. **124 suites, 1,128 tests, all green.**
- **Web, full: 125 files, 1,103 tests, all green.** The P23 assertion sits inside an existing
  consult-screen test.

## 7. OWNER'S PRODUCTION STEP (after the substance adoption; dry run first)

```bash
$P run --rm api node dist/scripts/adopt-therapeutic-classes.js \
   --resolution owner-resolution-2026-09-17-therapeutic-classes --as admin
# read it: "not a moiety here" must be 0, and "in another class" is for the pharmacist in charge; then add --apply
```

## 8. NOT BUILT

- **ACE inhibitor with ARB** (dual RAAS blockade) is not a within-class duplicate. It is an
  interaction pair the book does not hold yet. The internal benchmark lists it among the priority
  gaps for the P&T committee.
- **Hard class duplicates with an override.** See D-2.
