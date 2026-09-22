# HANDOFF — the formulary lane, 2026-09-16

**Read this file and `CLAUDE.md`. Nothing else is required to start.**

---

## 0. READ THIS BEFORE YOU TRUST ANY OTHER LINE IN THIS FILE

The handoff that opened *this* session was wrong about its own central premise, and it cost real
work to discover. It described a safety property of a component that nothing rendered, and it planned
around a catalogue "deliberately not loaded" that a peer lane had already shipped a loader for. Its
author could not have known: a PR landed between the writing and the reading.

**So the first act of this lane was re-verifying the handoff, and the first act of the next one
should be re-verifying this.** Concretely, three times in this session a written number or plan was
checked and found wrong, and each time the check was cheap:

- a ruling written 3 PRs earlier had **4 of its 10 steps refuted**, two of them harmful (§4)
- a comment claiming "the curated delete is scoped to `curated`" described a scoping that never
  existed and a column no writer ever set
- a header saying "768 names collide" was measured at **825**

The pattern is not that people are careless. It is that **prose has no compiler**. Anything below
that is not a command you can re-run is a claim about 2026-09-16.

---

## 1. WHERE THINGS STAND — measured at the end of this session

| | |
|---|---|
| `origin/main` | `db854d59` |
| migrations | **96**, last `0095_formulary_medicine_name_normalized` (`when` 1789567126695) |
| this lane's PRs | **#204, #205, #206, #207, #208 — all MERGED** |
| open work owned here | **none** |
| lane | `/opt/hmis-lanes/formulary/hmis`, branch `lane/formulary`, clean, test DBs dropped |

Re-measure before trusting: `git fetch origin && git rev-parse --short origin/main`.

### Database reality, re-measured at handoff time

| database | salts | medicines | compositions | substances | items |
|---|---|---|---|---|---|
| `hmis_cds_dev` | 3,283 | 103,383 | 142,759 | **0** | **0** |
| `hmis_drugsearch_dev` | **0** | **0** | **0** | 3,283 | **0** |
| production | — | **0** (per 0094's header; NOT verified from this box) | — | — | — |

**No database has ever held both tiers.** `items` is empty everywhere. Both facts block real work
(§5) and neither is fixable in code.

---

## 2. WHAT SHIPPED, AND THE ONE SENTENCE EACH

- **#204** — `listMedicines` did `inArray(medicineId, <every id>)`; drizzle emits one bind parameter
  per value and the Postgres Bind message counts them in an **Int16**, so past 65,535 rows it
  **throws `08P01`**, taking every pharmacy mutation with it. Closed with `anyOfText` →
  `= any($1::text[])`, plus `reads.ts`, `equivalence.ts`, `pharmacy/shelf.ts`.
- **#205** — the three unbounded readers **deleted, not capped**; keyset paging (`kernel/db/page.ts`,
  four laws in its header); `GET /formulary/census`; the admin screen rebuilt.
- **#206** — the catalogue importer plans its composition and **refuses to write a partial one**;
  migration 0094 dropped `formulary_medicine_salts.source`'s default; a lint rule closing the
  formulary's table boundary.
- **#207** — three catalogue-sized reads removed, and a loader stopped from recording 3,283 clinical
  decisions by machine.
- **#208** — the phase doc, carrying §4 below.

`docs/superpowers/plans/2026-09-15-phase1-formulary-bounded-reads.md` is the phase doc. Read it
before planning anything; it carries the rulings and the refutations.

---

## 3. THE DEFECT SHAPE THIS LANE KEPT FINDING

Worth naming because it will recur: **a value computed in two places, or a promise made in one place
and enforced in another.** Five instances in one review:

- a cursor built with JS `toLowerCase()` against a Postgres `lower()` sort — they differ on `İ`
- `pageQuery` capped cursors at 512 chars while `encodeCursor` had no bound, so the server issued
  cursors it then refused
- `escapeLike` is the house rule and one new reader did not obey it
- `resolveDrugTexts` re-derived a normalized name the database could have stored
- a test holding a **hand-copied** version of a migration's UPDATE, so editing the migration left it
  green

The fix in every case was to make the two into one, and to pin it with a test that reads the *real*
artefact rather than a copy of it.

---

## 4. FOUR THINGS THAT MUST NOT BE BUILT

The 2026-09-15 "two-loader fork" ruling (in this session's transcripts) is **half refuted**. If a
future plan cites it, check against this list first.

- **W5** — *"one writer per table; the loader stops writing `formulary_salts`"*. Contradicted by
  main: #206 put the opposite decision into `kernel/db/schema/formulary.ts` — *"`source` EXISTS
  BECAUSE TWO WRITERS SHARE THIS TABLE"*. And it **empties the doctor's picker with no end date**:
  simulated on the real catalogue restricted to the 29 curated moieties, `amox` → 0 hits, `para` →
  0, `crocin` → 0, against 4,130 / 4,988 / 7 today.
- **W7** — `resolveMedicines` returning `salts: []` for a product with an unmapped substance.
  **Reinstates C3**, an independent reviewer's CRITICAL, argued at `resolve.ts:163-166` and pinned at
  `resolve.test.ts:151-176`. Measured blast radius: **98.5% of products**.
- **W10** — dropping `formulary_salts.source_ref`. That column is the only thing distinguishing a
  release-image moiety from a curated one, which is exactly what #207's loader guard depends on.
- **W4's `source_kind`** duplicates 0094's chosen discriminator (`created_by = 'cds-import'`);
  **W4's substance trigram** is unnecessary (measured: 1.76 ms seq scan over 3,283 rows).

---

## 5. WHAT IS LEFT, AND WHY IT IS NOT CODE

**W6 (the derivation), W8 (the pharmacist's promotion loop), W9 (`searchMedicines` gains `checked`)
are blocked on a precondition, not on work.** No database holds both tiers, so a derivation emits
nothing on either that exists. Standing one up is a host mutation; an agent does not do those.

And even with the environment, the loop has nothing to promote until §6.1 is answered.

### Named residuals, none urgent

- `resolveDrugTexts`' `byBrand` silently keeps the **last** of 51 colliding normalized brand names.
  Measured: **0** of those 51 differ in composition; **6** differ in strength/form/route. Real, narrow.
- `modules/cds/allergens.ts` reads `formulary_salts` in **raw SQL** — invisible to #206's lint rule,
  which says so in its own comment. A green lint is not an enforced boundary here.
- `opd-consult.tsx` and `drug-field.tsx` still carry an unreproducible "15 MB" payload figure. The
  measured values are **57.3 MiB** full shape / **37.0 MiB** trimmed; the correction and its method
  are in `formulary.controller.ts`. Four live lanes are mid-edit on the first file, so taking a prose
  fix there costs them a conflict for no functional gain.
- `hmis_cds_dev` and `hmis_drugsearch_dev` are both **behind main and unrepairable by
  `drizzle-kit migrate`** — drop and rebuild before trusting any figure taken on them.

---

## 6. OWNER DECISIONS — THE FIRST ONE GATES EVERYTHING DOWNSTREAM

1. **Will the hospital fund a pharmacist to make ~500 clinical mapping decisions, and when?** Every
   one of the 3,283 rows in `formulary_salts` was written by `cds-import`; after stripping a trailing
   " (substance)" wrapper the two name sets match 3,283/3,283 both ways. The curated vocabulary the
   two-tier design rests on **does not exist yet** — it is the release, verbatim, with 437 salt-form
   names, zero drug classes and zero interaction pairs. The measured curve **is** the delivery
   schedule:

   | mapped | products covered, of 103,383 |
   |---|---|
   | 29 (today's seed) | 29,757 — 28.8% |
   | 100 | 57,858 |
   | 400 | 87,187 — 84% |
   | 800 | 96,857 — 94% |

   Until this is funded, W5–W9 have no end date and nothing downstream should be cut into tasks.

2. **Is there any live deployment with a loaded catalogue?** Production is not on this box. If none
   exists, most of this phase's urgency was precautionary. If one exists, it must be named before
   anything here deploys.

3. **Load the NRCeS release into production** — unchanged, and **safe**:
   `import-nrces-formulary.ts` writes only the release tier and never touches `formulary_medicines`.
   Command and md5s in `docs/superpowers/plans/2026-09-15-HANDOFF-pharmacy-formulary.md` §2.

4. **UAT on `:8443`** and the three `ADMIN_*` values — unchanged.

5. **The interaction dataset purchase** (RFQ, ₹8–12L/yr) — unchanged. Note `formulary_interactions`
   is empty and the release carries no pairs, which is part of why §6.1 matters.

---

## 7. THINGS THAT WILL BITE YOU

- **Migration serials: `idx` is contiguous, the `tag` is a filename, and they are not the same
  thing.** Jumping a serial to dodge another lane's PR puts a hole in `idx` and CI catches it.
  Take the next free serial **at rebase**; let whoever merges second renumber. Both invariants are
  pinned by `test/drizzle-snapshot-chain.test.ts` — run it, because a local module-scoped run will
  not.
- **A `when` that dips is a migration skipped silently, exit 0**, on every database including a
  fresh one. Renumbering must bump `when` too. PR **#203** is currently in exactly this position and
  has been told (two comments, the second correcting the first).
- **`drizzle-kit generate` emits `ADD COLUMN … NOT NULL` with no default**, which fails on a table
  with rows. Rewrite as add-nullable → backfill → constrain, and never regenerate afterwards: the
  generator reproduces a schema diff and would silently delete the backfill.
- **`tsc` does not compile `apps/core/scripts/`** unless something under `src` or `test` imports it.
  Ten scripts are imported by a test; the rest are invisible to the compiler. And **tsc is blind to
  raw SQL** — sweep `grep -rn "insert into <table>"` separately.
- **An agent cannot `gh run rerun` here** (fine-grained PAT), and branch protection has
  `enforce_admins: true` on all four checks — so a red CI cannot be merged past by anyone. A new
  commit is the only lever an agent has.
- **CI runs every commit twice.** A failure in both runs is real; a failure in one is a flake. The
  15 s hook ceiling is a documented class — see `docs/superpowers/plans/reports/flake-census-2026-09-12.md`
  §0, which already names three unrelated setup paths blowing it under load.
- **The test mutex is real and not in CLAUDE.md**: `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run <lane> <cmd>`.
  `lane.sh status` reports FREE while it is held.
- A full local `jest` run was **OOM-killed** with nine sessions on the box. Run the suites your
  change reaches and let CI be the gate; that is what CLAUDE.md says and it is correct.

---

## 8. THE METHOD THAT PAID, IN THREE LINES

**Point the expensive instrument at your own claim.** Every number in this file that survives is one
a command reproduces. The ones that did not survive were all plausible.

**Mutate, and predict the failure before you run it.** 23 mutants this session. Two of them found
**missing tests rather than bad code** — the bound that was the whole point of a PR had no test, and
a drift test exercised the TypeScript half while never touching the SQL half. A mutant that reddens
the case you did *not* predict is telling you something.

**An empty result is evidence about the search.** A grep found "no lint errors" when eslint was
actually crashing; a check of which lanes edit a file returned 44 false hits because `git diff main
<branch>` flags every branch merely *behind*. When a measurement comes back clean, ask what it would
have looked like if it were broken.
