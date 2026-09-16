# Phase — the formulary at national scale, 2026-09-15

**Lane** `formulary` (`/opt/hmis-lanes/formulary/hmis`, branch `lane/formulary`, cut from
`origin/main` @ `6c9e39d5`, 94 migrations).

This phase was opened by `docs/superpowers/plans/2026-09-15-HANDOFF-pharmacy-formulary.md`. **That
handoff is stale on its central premise and this document supersedes its §3 and §4**, for a reason
its author could not have seen: PR **#197** (`464a94a1`) was already on `main` when it was written.

---

## 1. WHAT THE HANDOFF DID NOT KNOW

#197 did two things that invert the handoff's priority order.

**It replaced the picker.** `DrugCombobox` over `/formulary/suggest` is UNWIRED — it sits in the
tree with its 9-test suite and no screen renders it (`opd-consult.tsx:338-339` says so). The live
field is `DrugField` over `/formulary/medicines/search`, and its pick **does** set `medicineId`
(`opd-consult.tsx:2445-2448`, pinned green at `opd-consult.test.tsx:1492`). So the handoff's §3 —
"a pick deliberately does not set `medicineId`, and that is the safety property of the whole slice"
— describes a component nothing renders. The property is now enforced better and structurally:
`searchMedicines`' two UNION branches both **require a composition row** (`search.ts:100-107`), so
an uncomposed product is invisible to the doctor rather than pickable-but-unchecked.

**It shipped a second loader.** `import-cds-catalogue.ts` writes the same NRCeS release's 3,283
substances straight into `formulary_salts` and 103,383 products into `formulary_medicines` —
precisely what `import-nrces-formulary.ts`'s own header (`:37-43`) argues a loader may never do. So
§4(b)'s "93,905 rows, deliberately not loaded" is no longer a plan. It is a thing that has happened,
on `hmis_cds_dev`, and it can happen on any deployment.

### The defect that discovery exposes

`listMedicines` (`masters.ts:344`) reads every row of `formulary_medicines`, then asks for the
composition with `inArray(medicineId, <every id>)`. drizzle emits **one bind parameter per value**
and the Postgres wire Bind message counts them in an **Int16**.

Reproduced read-only against `hmis_cds_dev`, issuing the exact statement shape drizzle emits:

| ids | result |
|---|---|
| 65,535 | OK |
| 65,536 | `08P01 bind message supplies 0 parameters, but prepared statement "" requires 65536` |
| 103,383 | `08P01 bind message has 37847 parameter formats but 0 parameters` — 103,383 mod 65,536 |

**It is not a slow read. It throws.** Nine callers ride it and five are on the pharmacy counter,
including `queue.ts:240` inside `getDispense`, which is the return value of *every* pharmacy
mutation. An empty `formulary_medicines` is the only reason any of them work: production holds 0
rows and `deploy.sh` runs no importer.

**Precisely what is and is not at risk.** The handoff's §2 owner action — loading the NRCeS release
into production — is **unaffected**: `import-nrces-formulary.ts` writes only `formulary_substances`,
`formulary_generics` and `formulary_generic_substances` and never touches `formulary_medicines`. The
dangerous load is the *other* one, and `import-cds-catalogue.ts` is invoked by **nothing** — no npm
script, no deploy step, no runbook, no branch. Nobody is about to trip it. Nothing warns them
either, and loading it is exactly what #197's doctor typeahead needs.

---

## 2. THE MEASURED GROUND

Every number here was measured this session, read-only, not remembered. Re-measure before trusting.

| database | salts | medicines | compositions | substances | generics | items |
|---|---|---|---|---|---|---|
| `hmis_cds_dev` | 3,283 | 103,383 | 142,759 | 0 | 0 | **0** |
| `hmis_drugsearch_dev` | 0 | 0 | 0 | 3,283 | 10,303 | **0** |
| `hmis_dev` | — | — | — | *table absent* | — | **0** |
| production | — | **0** | — | — | — | — |

**No database anywhere has ever held both tiers at once**, and `items` is empty on every dev
database on this box. That second fact matters more than it looks: it means "order the curation
queue by what the hospital stocks" (handoff §4a) has **no input in any form** — there is no Hauz
Pharma file anywhere on the box (a box-wide `find` returns nothing; the `~524 products` figure is
unverifiable here, and NRCeS's own Hauz rows number 70), and no `items` rows either.

Other measured corrections to the handoff:

- **`130,570`** is a REAL number that has been mislabelled, not an invented one — worth saying,
  because I nearly published "it has no source". Computed from the release files it is exactly the
  product x substance INCIDENCE count (sum over substances of the branded products naming them).
  The handoff uses it where the LOADED table's row count belongs, and that is **142,759**, measured
  on `formulary_medicine_salts` and cited five times in the repo. Two real quantities, one name.
- **`1,108 generics / 12,783 branded products`** exists only as prose at
  `import-nrces-formulary.ts:87-88` and nothing in the repo recomputes it. I tried: reconstructing
  its premise (generics with at least one moiety mapped and at least one not, under the 29 seeded
  moieties) gives 131 generics / 5,381 brands, and my reconstruction is itself approximate — it
  auto-links 16 substances by exact name where the importer measures 26. So the figure is neither
  confirmed nor refuted, and it should not be used to size work. What IS measured, by me, from the
  release files: **2,164 multi-component generics carrying 29,095 brands** are structurally capable
  of a short composition. That is larger than the prose figure, so the hazard is understated.
- The handoff says `wc -l generics.csv` reports 10311; the file says **10312**. The "8 embedded
  newlines" half is right; the total is off by one. All four md5s match byte-for-byte.
- **`formulary_medicine_salts.source`** is `not null default 'curated'` with ZERO writers that set
  it, so all 142,759 release-derived rows on `hmis_cds_dev` read `'curated'`. The schema comment at
  `formulary.ts:190` claims in the present tense that "the curated delete is scoped to `curated`";
  `masters.ts:247` is unscoped. The column cannot distinguish its two writers even in principle.

---

## 3. WHAT SHIPPED IN THIS PHASE — PR-A, `b60032a4`

**The bind ceiling, closed.** No migration, no shared file, no new route, no new permission — so no
coordination cost against the nine other live lanes.

- `kernel/db/any-of.ts` — `anyOfText(col, values)` → `= any($1::text[])`. One bind parameter for any
  length; measured at 103,383 ids: 1 parameter, 153 ms. The measurement lives in the header because
  the next author to write `inArray` over a caller's list will not rediscover it. The idiom was
  already house precedent (`dispatcher.ts:162`, `tail.ts:86`, `replay.ts:84`) with no home.
- `formulary/reads.ts` — `medicinesByIds`, `saltsByIds`, `medicineExists`, `MAX_IDS = 500`. They
  **refuse** past the bound with a typed `too_many_ids` rather than truncating, because a short map
  silently drops a dispense line's medicine and blanks a brand on a printed label. They deliberately
  **do not filter `active`**: a medicine deactivated after the prescription was written must still
  be nameable on the label and inside the refusal.
- `formulary/equivalence.ts` — generic equivalence as **one** SQL set-equality predicate over a
  caller-named universe. It had been written twice in JS, once for what the substitution dropdown
  OFFERS and once for what the dispensing gate ACCEPTS, with nothing asserting the two agreed.
  `isEquivalentMedicine` is now literally `equivalentMedicines(from, {among:[to]}).length === 1`.
- `pharmacy/shelf.ts` — the counter's universe is its own shelf (hundreds), never the nation.
- `materials/ledger.ts` — `availableQtyByItem` answers the stock question for a whole list in one
  statement; `availableQty` becomes its one-item caller, so the `max(0, onHand − reserved − frozen)`
  reduction stays in exactly one place.
- The five counter sites plus `sale-items.ts` converted.

`catalogue-scale.test.ts` seeds 70,000 medicines and was **RED against `6c9e39d5`** with
`bind message has 4464 parameter formats but 0 parameters` (70,000 mod 65,536 = 4,464). Green here.
30 suites / 298 tests green across pharmacy, formulary and materials.

### Known and deliberate residuals of PR-A

- `GET /formulary/medicines` (`formulary.controller.ts:196`) and the two import scripts still call
  `listMedicines`. They no longer **throw**, but they still pull the whole table into a heap and, for
  the route, onto the wire. Bounding that needs paging and a screen change — PR-B.
- `resolveDrugTexts` (`resolve.ts:189-210`) still reads every active medicine on every prescription
  issue and every `claimDispense`. **It does not throw** (it takes no id list), but it is slow at
  scale, and it carries a separate live defect recorded in §5.
- `activeSalts` (`resolve.ts:66-72`) still reads the whole `formulary_salts` table including the
  `aliases` jsonb, now on one caller instead of two.

---

## 4. THE THREE RULINGS — DECIDED

Three independent judge panels, each reading the code before ruling. None produced an owner ask;
none is money, procurement or law. Full designs are in this session's workflow transcripts
(`wf_55ae5dac-3fb`).

### DECIDED 1 — bounded reads: delete the unbounded question, do not cap it

The module's read surface answers *these ids*, *this equivalence*, *does this exist* — not "give me
the catalogue". `listMedicines` / `listSalts` / `listInteractions` **leave** `masters.ts` and
`index.ts` rather than gaining a `limit`, because a capped function leaves "give me everything"
spellable and the next caller spells it — and a silent cap is worse than the crash it replaces
(`import-item-master.ts` would emit `unknown_medicine_brand` for every drug past row 500). A frozen
export-surface test pins that they do not come back. Cursors are keyset, forward-only, over-fetch by
one; `decodeCursor` **throws** rather than falling back to page one, because a client silently
restarted at page one pages for ever.

REFUSED here, with reasons: a denormalised `equivalence_key` column (a third un-maintained
denormalisation on the table whose `source` column is this phase's own cautionary instance, buying
~16 ms), and `name_normalized` (it changes resolution behaviour on the safety path for ~102 rows —
correct, but a decision about drug resolution, not about bounded reads, and bundling it buries it).

### DECIDED 2 — the loader fork: both tiers live, one writer per table, two typed links

`formulary_salts` goes back to being the **curated moiety vocabulary** and no loader may insert into
it again. The release tier keeps the national vocabulary with its SNOMED join keys. Two one-way
links: `formulary_substances.salt_id` (release substance → curated moiety, set only by a named human
act) and a new `formulary_medicines.generic_id` (branded product → clinical drug, set only by the
loader). `formulary_medicine_salts` becomes a projection written complete-or-not-at-all.

`formulary_medicines_brand_lower_ux` is **NOT dropped, NOT widened and NOT redefined** — widening a
uniqueness guard to make an import pass is the one thing CLAUDE.md forbids outright, and
`masters.test.ts:85-91` is the test that would have to be weakened to do it. The forked dev
databases are dropped and reloaded rather than repaired: production is empty and a dev database is
reloadable.

**Two things the owner should be TOLD, not asked.** (a) On the day a catalogue is loaded, nearly
every prescribed line will read "advanced checks unavailable" and coverage will fall from ~100% to
~0%. That is not a regression — today those same lines are reported as CHECKED against 3,283
unreviewed release names carrying zero interaction pairs and null drug classes. This makes an
existing silence audible, and whoever sees it first will read it as a break. (b) The curation
worklist is a new surface for the `pharmacy` role, which has **no human holders today**. The
mechanism ships and sits idle until somebody with `formulary.manage` works the list.

### DECIDED 3 — partial composition: refuse at the writer, and make provenance a compile error

The derivation must **refuse to emit a partial composition at all** rather than emitting what it
has, which makes the six existing empty-guards correct with no new completeness field. Applied to
the one real writer that already ships: `import-cds-catalogue.ts:214-217` currently does
`if (saltId !== undefined) links.push(...)` — it silently drops any component whose substance ref
does not resolve, with no count and no refusal, bypassing `addMedicine`'s empty guard. It becomes a
partition (whole / `partial_refs` / `dangling_refs` / `no_refs` / `orphan_generic`) printed
identically on a dry run and an apply, with a drop-rate fuse whose override is an explicit
`--accept-drop-rate` flag the report echoes — a fuse whose only override is editing the constant is
a fuse that gets widened silently.

`formulary_medicine_salts.source` **loses its default** and becomes a field every writer states, so
an unprovenanced write is a *compile* error. All five writers are drizzle builder inserts and zero
are raw SQL, so `$inferInsert` plus `tsc` names every site — the one precondition that makes
removing a default safe rather than a runtime landmine. Migration backfills the 142,759 release rows
to `'derived'` off the exact discriminator `formulary_medicines.created_by = 'cds-import'`.

The curated delete at `masters.ts:247` **stays unscoped** (`updateMedicine` is a whole-composition
replace) and the schema comment is corrected to match the code, carrying forward the rule the first
derivation writer will be held to: *a derivation may write only where the medicine has no `curated`
row, and may delete only its own `derived` rows.*

---

## 5. ORDERED WORK REMAINING

Each item is independently committable. Serials are taken **at rebase**, not now (`_journal.json`
holds 94 entries; next free is 0094, and free is not the same as reachable — see PR #149).

**PR-B — the surface.** No migration. Touches `apps/web/src/locales/*.json`, which is on the
coordinate-before-editing list. Keyset paging in `kernel/db/page.ts` + `packages/contracts`;
`pageMedicines` / `pageSalts` / `pageInteractions` / `countSalts` / `catalogueCensus` /
`medicineIdsByBrandNames`; delete `listMedicines` / `listSalts` / `listInteractions`; the frozen
export-surface test; three routes gain `?limit=&cursor=`; `formulary-admin.tsx` stops fetching the
catalogue and the whole salt table on mount.

**PR-C — the lint rule.** `no-restricted-syntax` on `ImportSpecifier[imported.name=/^formulary[A-Z]/]`
so a module cannot go round the formulary to its tables. Note: the path-based form
(`no-restricted-imports` on `**/kernel/db/schema/formulary`) **matches nothing** — everyone imports
the barrel; 339 barrel imports, 0 direct-path imports, verified. Prove it bites before landing it.

**PR-D — the partial-composition guard and the `source` column.** DECIDED 3. One migration.
`updateMedicine`'s empty-composition refusal ships first and alone; it is red against `6c9e39d5`
today.

**PR-E onward — the fork.** DECIDED 2, in the order the ruling gives: `equivalents` (done in PR-A),
`resolve.ts` cleanups, migration A (`generic_id`, `source_kind`, `formulary_substances.product_count`
+ trigram index), one-writer refactor of the loaders, the `bridge.ts` derivation, the read-side
completeness guard, the promotion loop (`pendingSubstances` / `mapSubstance` with **alias
inheritance** / `markUnmappable`), `searchMedicines`' `checked` flag, then migration B dropping
`formulary_salts.source_ref` as the standing guard that makes the fork unrepeatable.

**Then, and only then, the curation queue screen** (handoff §4a). It cannot be ordered "by what the
hospital stocks" — there is no such data on any database — so it is ordered by **branded-product
count**, which is sharply concentrated and available. Computed from the release files this session
with a quoted-CSV-aware parser: the top 200 substances carry **107,026 of 130,570 product
incidences (82.0%)**, against **40.7%** for the same cut by generic count — so ordering by products
concentrates the work and ordering by generics does not. **1,756 of the 3,283** substances have zero
branded products and **647** appear in no composition at all, so roughly half the queue is
deferrable on measured grounds rather than on a guess.

A precondition nobody states: whether a substance arrives `pending` depends on the 29 curated
moieties existing BEFORE the import. `deploy-parity.test.ts:387` puts `seed-formulary-interactions`
in the deploy script list, so a real deployment auto-links ~26 and the queue is ~3,257; a lane that
rebuilds a dev database in the other order gets 0 linked and 3,283 pending. Measured on
`hmis_drugsearch_dev`, which is the only database where the release importer has actually run:
`pending | 3283`, and `formulary_salts` there is empty.

---

## 6. LIVE DEFECTS FOUND AND NOT YET FIXED

Recorded so the next session does not rediscover them.

1. **`resolveDrugTexts` silently drops a colliding brand.** It builds `byBrand` as
   `new Map(medicines.map((m) => [normalizeDrugName(m.brandName), m]))`, which keeps the LAST of any
   colliding pair with no diagnostic. Measured on the loaded catalogue with the REAL
   `normalizeDrugName` (lowercase, strip `.,()-/`, collapse whitespace): 103,383 active rows,
   103,332 distinct keys, **51 collisions** — `Ab-Xone` and `Abxone`, `A-Pan` and `Apan`, and so on.

   **The blast radius is smaller than it looks, and measuring it is the point.** Of those 51 keys,
   **0** have members that differ in COMPOSITION — so no free-typed line today carries another
   brand's moieties into the allergy or interaction checks, which is what I first wrote down and
   then had to correct. **6** have members differing in strength label, form or route class, and
   `resolveDrugTexts` reports the winner's `routeClass`, which `systemic_only` interaction pairs
   read. So: a real silent-drop defect, a real but narrow wrong-answer today, and a hazard that
   grows with the next catalogue. A UNIQUE index will not build over that column; the fix is a
   decision about resolution, not an index.
2. **Coverage and the safety path still disagree about the same line, in opposite directions.**
   `curation.ts:80-82` counts a line resolved on the mere presence of an entry;
   `prescriptions.ts:269` counts the same line unresolved when its salts are empty. C3's fix landed
   on the safety side only. A free-typed line matching one of the 8 uncomposed actives is counted
   both ways. Nothing tests the empty-salts branch on either side.
3. **`opd/complaints.ts:124` and `:202`** build `array[$1, $2, …]::text[]` — the same defect wearing
   the fix's syntax, one bind parameter per element. The lists are small today.
4. **`masters.ts:247` + the `source` comment** — see DECIDED 3. Live, not prospective: on
   `hmis_cds_dev` one pharmacist PATCH deletes a whole release-derived composition and the column
   that was supposed to prevent it reads `'curated'` for all 142,759 rows.

---

## 7. METHOD NOTES WORTH KEEPING

- **The handoff's own instruction paid off and should be repeated.** It said every `file:line` would
  drift and that a missed citation means the *claim* still needs checking. Four of its citations had
  drifted (`prescriptions.ts` is in `modules/opd/`, not `modules/formulary/`; `rx-checks.ts:268` is
  the accessor, the guard is `:269`) and every underlying claim held. Nothing would have been gained
  by discarding them.
- **A number written in prose is a moment, not a state.** `130,570` and `1,108 / 12,783` both
  survived into a handoff, a design and two agent reports without any command reproducing them. The
  test is not whether a number is plausible; it is whether something on disk recomputes it.
- **Both loaders had run, on different databases, never together** — and every static reader
  reported "I could not query a database" as an open question. The fork looked theoretical until
  somebody ran `select count(*)`. Where a design turns on which of two things is true, the database
  is usually cheaper to ask than the code is to re-read.
