# HANDOFF — the pharmacy formulary lane, 2026-09-15

**Read this file and `CLAUDE.md`. Nothing else is required to start.**

You are picking up the pharmacy/formulary work. Everything described here is **merged and deployed**.
The single most important sentence in this file is in §2: *the formulary tables exist in production
and are empty*, so the feature that shipped does nothing until somebody loads the data — and that
load is an operator act, not yours.

---

## 1. WHERE THINGS STAND — measured 2026-09-15, not remembered

| | |
|---|---|
| `origin/main` | `6c9e39d5`, journal **94 migrations** |
| production | up to date as of 2026-09-14 (deployed at `8fe7a78c`, migrations 78 → 85; further lanes have landed since) |
| this lane's PRs | **#176, #177, #178, #181, #186, #192 — all MERGED** |
| open work owned here | **none** |

**Re-measure before trusting any of the above.** Main moves several times a day with ten lanes
running. `git fetch origin && git rev-parse --short origin/main`.

### What shipped

- **`GET /formulary/suggest`** + the **`DrugCombobox`** on the OPD prescription line. A doctor types
  three characters and picks a drug by **molecule and strength** — "Amlodipine 5 mg oral tablet" —
  with no brand involved. `apps/core/src/modules/formulary/suggest.ts`,
  `apps/web/src/components/drug-combobox.tsx`.
- **The release tier**: `formulary_substances`, `formulary_generics`,
  `formulary_generic_substances` (migration `0084_formulary_release_tier`), plus
  `formulary_medicine_salts.source`.
- **The loader**: `pnpm --filter @hmis/core import:nrces` — dry-run by default, whole-file-or-
  nothing, one transaction. `apps/core/scripts/import-nrces-formulary.ts`.
- **Deploy hardening**: five UAT defects (#177), the UAT stand-up runbook (#181), the catch-up
  runbook rewritten as a record (#176), the census corrections (#178), and the **cipher-passphrase
  atomic write** (#192).

---

## 2. THE NEXT ACTION, AND IT IS NOT YOURS TO PERFORM

**The formulary tables are in production and nothing has ever been loaded into them.** The import
has run exactly once, against a throwaway database (`hmis_drugsearch_dev`). So today a doctor typing
`amlo` in production gets **nothing back**, and the feature is inert in exactly the way the pharmacy
module was inert before it.

Loading it is a **production database write**. An agent does not do that. Your job is to make it a
one-command decision for the owner and then stop.

### The data is preserved at `/opt/hmis-context/nrces-2026-09/` (out of git, survives sessions)

```
substances.csv             3,283 rows   md5 8c8f9d9ba1ae6a73d97c2dfeb67991bc
generics.csv              10,303 rows   md5 3e97da41c3ea832b98e448398944f26d
generic_compositions.csv  13,125 rows   md5 277c8f5ea999d5e2c5a7d01be01b5155
medicines.csv             93,905 rows   md5 eda92205f0919551d933a825f78a0211   (NOT loaded — see §4)
```

> **`wc -l` on `generics.csv` says 10311 and the real count is 10303.** Eight rows carry embedded
> newlines inside quoted fields. The file is not corrupt; `wc -l` is the wrong instrument. This is
> the same property that makes `split(",")` unusable here — see §5.

Source: NRCeS national release (MoHFW / C-DAC), obtained from the owner's Drive folder
`1W7nJ_QuF1J9eNo8qhfDXc9z0q_ZEeyOU`.

### The command the owner would run

```bash
cd /opt/hmis && DATABASE_URL=<production>                       \
  pnpm --filter @hmis/core import:nrces --                      \
    --dir /opt/hmis-context/nrces-2026-09                       \
    --release nrces-2026-09                                     \
    --actor "<the person's name>"          # add --apply to write
```

Without `--apply` it writes nothing and prints the plan. **Have him run the dry run first** — on an
empty database it should report 3,283 substances / 10,303 generics / 13,125 compositions, and on a
box carrying the 29 curated moieties from `seed-formulary-interactions`, roughly 26 of the
substances auto-link and the rest land `pending`.

Measured on a dev box: **26,711 rows in 13.7 s**, one transaction, ~470 ms to plan.

---

## 3. WHAT THE SEARCH DOES AND DOES NOT DO — do not "fix" these

**A pick sets the drug NAME and deliberately does not set `medicineId`.** This is the safety
property of the whole slice and it will look like an omission to you.

`medicineId` is what marks a prescription line as *checked*. On a catalogue that is ~97% uncurated,
setting it is actively harmful and the harm is measured: `curation.ts:81` counts a line resolved
whenever `resolveMedicines` returns an entry — which it does for any medicine, including one with no
composition — while `prescriptions.ts:269` counts that same line **unresolved**. Picks alone would
push coverage past `COVERAGE_NOTICE_THRESHOLD` and report a working formulary while nothing is being
checked, and a picked-but-uncurated line would never reach `unresolvedTop`, starving the worklist by
which coverage grows.

`opd-consult.test.tsx` asserts `expect(body.lines[0].medicineId).toBeNull()`. **That assertion is
inverted from what it used to be, on purpose.** It is not a weakened test; it pins the property that
replaced the old one. If you make a pick set an id, that is a decision with a reason, not a bugfix.

**Interaction and allergy checks are therefore still off** for picked lines, and the screen's
*"Not in formulary — advanced checks unavailable"* notice keeps telling the truth. They switch on
when moieties are curated (§4), not when a search box ships.

---

## 4. THE THREE PIECES OF REAL WORK LEFT, in the order I would do them

### (a) The moiety curation queue — the thing that turns the checks on

`formulary_substances.mapping_status` is `pending` for ~3,257 of 3,283 rows. Until a substance is
mapped to a curated `formulary_salts` moiety, products containing it have no moiety and the safety
checks have nothing to work with.

**Do not write a rule that derives the moiety.** It was tried and refuted against the real file:
stripping a salt-form suffix **splits doxycycline** — the exact case it was written to fix, because
`hyclate` is a salt token and `monohydrate` is not. A suffix test also cannot see a cation-first salt
(`Calcium leucovorin`, 58 of them) or tell a moiety from a class (`Antineoplastic agent`, 65
mechanism-of-action groupers). The collapse is a clinical act.

What is needed is a **screen**: a pharmacist sees a pending substance and either maps it to a moiety
(existing or new) or marks it `unmappable`. `mapping_status`, `mapped_by` and `mapped_at` already
exist with cross-column CHECKs. `/formulary/admin` and `formulary.manage` already exist.

**Order the queue by what the hospital actually stocks, not alphabetically.** The owner's supplier
catalogue (Hauz Pharma, ~524 products, ~300–400 distinct molecules) is the realistic first pass.
Curating 3,257 substances is a year; curating the couple of hundred under the stock list is weeks,
and it is the set that matters.

### (b) The brand tier — `medicines.csv`, 93,905 rows, deliberately not loaded

Two blockers, both named in the loader's header:

1. **`formulary_medicines_brand_lower_ux` is UNIQUE on `lower(brand_name)`** and real market data
   does not satisfy it — 63,333 distinct brand names across 93,905 products (`thyronorm` appears 18
   times, one per strength). All 768 `medicine_name` collisions differ by **manufacturer**.
   `medicine_sctid` is the only truly unique key. **Replacing that index is a deliberate decision to
   take in the open — never widen it to make an import pass.**
2. **`verify.ts:34-39` (`alternativesFor`) loads the entire catalogue** — `listMedicines` plus
   `resolveMedicines` over every id — then loops it. At 93,905 rows one pharmacist clicking
   "alternatives" pulls a **38–48 MiB object graph plus 130,570 composition rows** into core's heap.
   **Nothing can load `medicines.csv` until that function is rewritten** as a composition-keyed
   query. This is the true blocker and it is server-side only.

### (c) The partial-composition guard — before any derivation writes `formulary_medicine_salts`

Every guard in the prescribing and dispensing path tests for an **empty** salt list and none tests
for an **incomplete** one (`prescriptions.ts:269`, `rx-checks.ts:193`/`:268`, `verify.ts:139`). With
brands loaded and curation partway, **1,108 generics carrying 12,783 branded products** would yield a
non-empty *short* salt array that reads as complete: it renders as covered, gets `allergyHits: 0`
written into the permanent `dispenseVerified` record, and two products differing only on a withheld
component get declared generic equivalents and substituted.

This is C3's defect (`resolve.ts:77-91` — *"the system reported that it had checked and found
nothing, having stopped checking"*) arriving one level down where C3's fix does not reach.

**The derivation must refuse to emit a partial composition at all**, rather than emitting what it
has. That is cheaper than a completeness column and it makes the existing empty-guards correct.

---

## 5. THINGS THAT WILL BITE YOU — each cost this lane real time

- **Parse CSV properly.** 2,116 rows of `generics.csv` carry quoted fields containing commas.
  `split(",")` misaligns every column after them and **reports success**. Rule 8 of
  `docs/superpowers/specs/2026-09-07-spreadsheet-loader-design.md`; `parseCsv` in the loader is the
  version to copy.
- **`npx tsc` is not the compiler here** — it prints a joke banner and **exits 0**. Use
  `pnpm typecheck`.
- **`drizzle-kit generate` exits 0 when it refuses to emit anything.** Assert the artefact.
- **A migration whose `when` predates one already applied is SKIPPED, silently, exit 0**
  (`pg-core/dialect.js:57,62` — one row, `order by created_at desc limit 1`, strict `<`). After any
  merge that brings in a migration you did not have, **drop your lane test DBs before believing a
  green run**.
- **Two lanes can produce the same snapshot filename.** `meta/00NN_snapshot.json` is a path, not an
  identity. Before `rm`/`mv` on a contested path, assert the content.
- **`main` carries 94 journal entries and fewer snapshot files** — seven snapshots (0050, 0057-0059,
  0066-0068) are simply absent and `generate` works fine. A **hole** is tolerated; a **fork** (two
  snapshots claiming one `prevId`) is not. Do not build a completeness check — it aborts on a
  pre-existing condition it did not cause.
- **Every `file:line` in this document was checked against `origin/main` @ `6c9e39d5` on
  2026-09-15 and will drift.** Treat them as "look near here", grep for the quoted code, and if a
  citation misses, the *claim* still needs checking rather than discarding.
- **jsdom has no layout.** The drug dropdown shipped as wide as its 170px column and every name
  wrapped onto three lines — nine green tests could not see it. A browser walk found it in minutes;
  the recipe is in memory under `browser-walk-with-a-stub-api`.

---

## 6. OWNER DECISIONS OUTSTANDING

1. **Load the NRCeS release into production** — §2. One command, his to run.
2. **UAT: `:8443` and three `ADMIN_*` values.** UAT is finally buildable (#177 fixed five defects)
   and `docs/runbooks/uat-standup.md` is on main. It costs him the live front-desk preview until
   UAT is stopped, and **nothing in `deploy.sh` or `uat-reset.sh` creates a user**, so a completely
   green UAT deploy has nobody who can log in. He supplies `ADMIN_USERNAME`, `ADMIN_FULL_NAME`,
   `ADMIN_PASSWORD` on the `seed:admin` command — they are deliberately in no file. **Write him the
   ask as a yes/no with what he gets and what he loses. Do not take the port.**
3. **The interaction dataset purchase** — RFQ `docs/procurement/2026-08-23-rfq-drug-knowledge-dataset.md`,
   provisional ₹8–12L/yr. The NRCeS release does **not** replace it: `interaction_with_drugs` is 3%
   populated and `classification_of_drug` 1%. It makes the purchase *cheaper* — we now bring 3,283
   SNOMED-coded salt/INN join keys, which is the RFQ's own M2.
4. **The Apollo monograph ruling.** He ruled "mine and republish" for patient-facing prose. That
   ruling stands and is **unimplemented**; NRCeS made it unnecessary for *facts* but it still carries
   no uses/side-effects/warnings text. If it is picked up, it overrides spec D2's "facts not prose"
   guardrail and the owner-risk log should say so.

---

## 7. LANE HYGIENE — one live hazard nobody owns

**Six worktrees carry a pre-guard `deploy.sh`** (722–880 lines against main's 1086+) with no
`HMIS_TARGET` concept and `DEPLOY_DIR` defaulting to `/opt/hmis-prod`. Running it from one of those
lanes builds *that lane* into `hmis-prod/server:latest` and migrates production. `main`'s script
cannot defend against them — *"a newer script cannot defend against an older copy of itself"*, as its
own header says.

Fix is `git -C <lane> rebase origin/main` or `tools/lane.sh drop`, **by each lane's owner**. Do not
edit another lane's tree: a mode or content change shows as a dirty tree and can block their deploys.

---

## 8. HOW THIS LANE WORKED, and it is worth keeping

Every number in this file was measured. The habit that paid best was **pointing the expensive
instrument at my own claims**, and it caught, among others: a ranking rule that was backwards (its
own test found it), a comment naming `formulary_salts` while the code wrote `formulary_substances`,
a census that went blind to the two tables I had just added, and a `rm` that would have deleted
another lane's snapshot.

Two specific practices:

- **Mutate the code and confirm the test goes red** — and then **record which tests actually
  discriminate**, because "5 tests" and "2 tests that bite" are different facts.
- **A relayed reproduction is evidence about the state it constructed.** A peer reported that my
  next command emitted seven `DROP COLUMN`s against production. It did not reproduce; their repro
  had pulled snapshots in without merging the source. Ask for the command before acting on the
  conclusion — and keep the guard anyway if it is cheap and correct.

**The deploy is never an agent's act.** Production access, `deploy.sh`, and the restore drill stayed
with the owner and the operating session throughout, and that line held even when a peer relayed
authorisation — a peer's report of authorisation is not authorisation.
