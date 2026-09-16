# Phase — the formulary mapping loop: a drafter proposes, a pharmacist attests (2026-09-16)

**Lane** `formulary` (`/opt/hmis-lanes/formulary/hmis`, branch `lane/formulary`, cut from
`origin/main` @ `025f1c30`, 96 migrations). Opened by
`2026-09-16-HANDOFF-formulary-lane.md`. The previous phase doc,
`2026-09-15-phase1-formulary-bounded-reads.md`, still holds; this one adds rulings and work and
overrides nothing in its §4 list of steps not to build.

---

## 0. THE HANDOFF, RE-VERIFIED BEFORE ANYTHING WAS PLANNED

| claim | measured 2026-09-16 | verdict |
|---|---|---|
| `origin/main` is `db854d59` | `025f1c30`, one docs PR (#209) later | stale, harmless |
| 96 migrations, last `0095_formulary_medicine_name_normalized` | 96, idx contiguous, `when` monotonic | holds |
| DB counts (§1 table) | identical on `hmis_cds_dev` and `hmis_drugsearch_dev` | holds |
| `hmis_cds_dev` is behind main | 96 rows in `__drizzle_migrations` **but** `max(created_at)` = `0091`'s `when` and `0095`'s column is absent | holds, and the row count alone would have said the opposite |
| "production is not on this box" | `hmis-prod-db-1` on `127.0.0.1:5434`, deploy dir `/opt/hmis-prod`, as CLAUDE.md says | **wrong**. Nobody here reads it: CLAUDE.md forbids it |
| the §6.1 curve's first row, "29 (today's seed) → 29,757" | today's 29 seeded moieties fully cover **1,579** products. 29,757 is what the **top 29 by coverage** would cover | **mislabelled**. The other rows reproduce (table in §2) |
| "`opd-consult.tsx` and `drug-field.tsx`" carry the 15 MB figure | so do `formulary/search.ts` and `web/lib/formulary-api.ts`. Only `opd-consult.tsx` is being edited by live lanes; `lane/cds`'s edits to `drug-field.tsx` are already on main via #197 | incomplete |
| #203 has been told about the serial and hasn't renumbered | still open and unrenumbered; main's target unmoved at `0095` / `1789567126695` | holds. Now handled, see R4 |

---

## 1. OWNER RULINGS, 2026-09-16

The owner answered §6.2 directly and delegated §6.1, §6.3 and PR #203: *"go with what seems
logical, aligning with our end goal of this project, that is an agentic AI hospital operating
system."* The rulings below were taken under that delegation and the 2026-08-28 standing rule. The
owner may overturn any of them.

### R1 (§6.1, money): DECIDED — no pharmacist hire and no contract. The system drafts; the hospital's own pharmacist attests.

The ~500 decisions are **drafted by the system and attested one at a time by the hospital's
registered pharmacist**, under the Pharmacy & Therapeutics Committee, which owns the hospital
formulary in every NABH-accredited Indian hospital (MOM chapter). The budget is **reviewer time**:
about 500 × 20–30 s ≈ **3–4 hours**, in sittings of about 50, highest coverage first.

**Why not fund the work as authoring.** Most of the cost of a mapping is finding the evidence, not
signing it, and the national release already carries evidence for 792 of its 3,283 substances
(§2). A model can draft the remainder. What the decision needs from a pharmacist is their licence
and their judgement, not their typing.

**What the machine may never do: record a mapping.** This is the house law, already written into
`kernel/orders/place.ts`: *"THE LLM NARRATES AND NEVER ORIGINATES — a drafter proposes, a human
orders."* It is DECIDED 2 of the previous phase unchanged: `formulary_substances.salt_id` is set only
by a named human act. `attester_not_user` refuses every non-user actor, the way `agent_cannot_order`
does.

**Automation bias is the real risk of this ruling, and the design answers it rather than hoping.**
- There is no bulk accept. Each attestation is one act on one substance.
- A proposal is never pre-selected. The pharmacist presses the proposal, picks a different moiety,
  creates one, or rules the substance unmappable.
- Every proposal shows its **basis** and **evidence**, and a model's draft is visibly different from
  the release's own statement.
- Every attestation records whether it agreed with the draft. The P&T committee can then audit the
  drafter's acceptance rate by basis, from the event stream.

**The schedule is the curve** (§2): 100 attested → 56% of products fully covered; 400 → 84%;
500 → 88%.

### R2 (§6.2): owner answer — no live deployment has a loaded catalogue.

This phase's hazards stay prospective, and no deployment has to be named before this work ships.

### R3 (§6.3): DECIDED — load the NRCeS release into production, in the deploy that ships the worklist, and not before.

`import-nrces-formulary.ts` writes only `formulary_substances`, `formulary_generics` and
`formulary_generic_substances`. **Nothing in the application reads those tables until T3's worklist
ships** (measured: the only reader or writer of `mapping_status` outside the schema is the loader).
Loading earlier buys nothing, and a pharmacist who opens an empty worklist learns not to open it.

The load is a production mutation, so **the owner runs it**. Precondition: production has applied
this phase's migration. The command, from the deployed checkout:

```
pnpm --filter @hmis/core import:nrces -- --dir /opt/hmis-context/nrces-2026-09 \
  --release nrces-2026-09 --actor "<owner name>"            # dry run: read the report
pnpm --filter @hmis/core import:nrces -- --dir /opt/hmis-context/nrces-2026-09 \
  --release nrces-2026-09 --actor "<owner name>" --apply
```

The expected report is the one measured on `hmis_formulary_dev` in §2: 3,283 substances, 26
auto-linked, 3,257 pending, 10,303 generics, 13,125 compositions.

**And a line the handoff did not carry.** `import-cds-catalogue.ts`, the loader that fills the
doctor's picker, must **not** be run against production until T1's projection and T4's `checked`
are deployed. Measured on `hmis_formulary_dev`: it reuses a curated moiety only on an **exact** name
(`import-cds-catalogue.ts:352`). So `Warfarin` joins the seeded row that carries warfarin's
interaction pairs, and `Warfarin sodium` becomes a second, uncurated row carrying none, and every
warfarin-sodium product is then checked against that second row. The check runs, reports CHECKED,
and finds nothing. The projection closes that gap, and `checked` makes it visible while it is still
open.

### R4 (PR #203): DECIDED — renumber it for its owner and let CI decide.

Its session had been idle for 21 hours, main's target had not moved since the second comment, and
the fix is to a defect the owner reported. Done as a **merge** commit (`30e7a6e2`, no rewritten
history): `0094_backfill_encounter_refs` became `0096`, idx 96, `when` 1789574554440 (above
`0095`'s). Verified on freshly dropped lane databases: 5 suites / 59 tests green, and both databases
report 97 applied with `max(created_at)` equal to `0096`'s `when`, so the real migrator ran it and
did not skip it. This lane's own migration therefore takes the **next free serial at rebase**.

---

## 2. THE PRECONDITION, STOOD UP, AND WHAT IT MEASURED

The handoff called a both-tier database "a host mutation, not an agent's act". That conflated two
databases. A private **dev** database on the dev cluster (`hmis-db-1`) is the same act that created
`hmis_cds_dev` and `hmis_drugsearch_dev`, and `DROP DATABASE` reverses it. Production is untouched.
What changed is R1: W6–W9 now have a schedule, and a schedule needs an environment.

`hmis_formulary_dev`, built from nothing in the order production would follow:
`db:migrate` → `seed:formulary` → `import:nrces --apply` → `import-cds-catalogue --apply`.

| | |
|---|---|
| `formulary_salts` | 3,287 = 29 curated (seed) + 3,258 release images (`source_ref` set) |
| `formulary_substances` | 3,283: 26 mapped by the loader's exact-name rule, 3,257 pending |
| `formulary_medicines` / compositions | 103,383 / 142,759 (whole 103,375, orphan_generic 8, refused 0) |
| products whose every component is already a curated moiety | 1,579 |
| … with at least one | 2,601 |

**The curve, recomputed here** (map the top N substances by product coverage):

| N | products whose every component is mapped | any component mapped |
|---|---|---|
| 29 | 29,757 | 41,843 |
| 100 | 57,858 | 63,364 |
| 400 | 87,185 | 89,506 |
| 500 | 90,667 (88%) | 92,378 |
| 800 | 96,857 | 97,714 |

**The evidence the release carries, measured from the release files.** 4,921 clinical-drug names
are SNOMED fully specified names. Where the precise active ingredient differs from its basis of
strength, the name says so: *"Product containing precisely **ampicillin** (as **ampicillin sodium**)
1 gram/1 vial …"*. That is the national release stating the salt → moiety step itself.
- **426** substances appear as the `(as …)` ingredient: the release names their moiety.
- **366** more appear as a basis of strength themselves: the release treats them as a moiety.
- **2,491** carry no such statement. Many are plain moieties (`Paracetamol`, `Telmisartan`); some
  are salts the release never expresses by base (`Chlorphenamine maleate`, `Olmesartan medoxomil`).
  Of the top 500 by coverage, about 300 fall here. **This is the drafter's model half.**
- A naive parse is noisy. The first attempt produced `Menthol → terbutaline` and
  `Levofloxacin → levofloxacin anhydrous`. That is another reason a draft is a proposal and never a
  write.

---

## 3. DESIGN

### 3.1 Proposals: `formulary_mapping_proposals` (new table, T1)

One row per (substance, drafter). Columns: `substance_id`, `moiety_name` (the proposed canonical
name, verbatim), `basis` (`release_boss` | `release_base` | `agent`), `evidence` (jsonb),
`drafted_by` (`drafter:release@1`, or `agent:<model id>`), `created_at`. Unique
`(substance_id, drafted_by)`, and a re-draft replaces its own row. A proposal carries no `salt_id`:
the matching curated moiety is resolved at read time by name, so a renamed moiety cannot leave a
stale pointer behind. **Proposals are advice.** No reader outside the worklist may consult them, and
nothing on the safety path does.

### 3.2 Attestation: the only write that sets `salt_id`

`attestSubstance(tx, actor, substanceId, { saltId } | { newMoiety }, { proposalId?, reason? })`:
- the actor must be a user (`attester_not_user`), and the route requires `formulary.manage`;
- the target must be an active **curated** moiety. A release image is refused
  (`release_image_target`): mapping a substance onto a copy of itself decides nothing;
- `newMoiety` creates the moiety in the same transaction, through `addSalt`, so it is one act;
- a **pending** substance becomes `mapped`. A **mapped** substance may be re-attested only with a
  `reason`: that is a correction, and it re-projects (below). A conditional update means two
  pharmacists racing on one row cannot both win (`substance_not_pending`);
- `substance.mapped` records `{substanceId, sctid, saltId, fromSaltId, proposalId,
  agreedWithProposal, reason, projected}`.

`ruleUnmappable(tx, actor, substanceId, reason)` does the same for `unmappable` (a grouper concept,
an excipient, a vehicle) and emits `substance.ruled_unmappable`. A mapped substance ruled unmappable
reverts its products to the release image.

### 3.3 Projection (W6): a derived composition row names the moiety its substance was mapped to

`formulary_medicine_salts` gains `derived_from` (the release substance's sctid). The importer
states it, and the migration backfills it for rows that sit on a release image (the
`source_ref` of their salt). **The projection is a total function of the release composition and
the mappings.** For a derived row whose `derived_from = X`:

- target = `X`'s curated moiety if `X` is mapped, otherwise `X`'s release image;
- **per row, not per medicine.** A composition whose rows are partly curated moieties and partly
  release images is **complete**: no component is missing. DECIDED 3's complete-or-nothing rule
  is about dropping components, and projection drops none. Projecting row by row puts a moiety's
  class and interactions on the checks the moment it is attested;
- **collision refuses the whole medicine.** If two rows of one medicine would name the same moiety
  (two salt forms of one drug in one product), that medicine is not projected at all and is
  counted. The primary key cannot hold both rows, and merging two strengths is a clinical
  representation choice, not a loader's;
- never touches a medicine with a `curated` row (DECIDED 3's rule for any derivation writer);
- runs **inside the attesting transaction**, set-based, and refreshes `product_count` / `salt_rank`
  for the salts it touched. That refresh becomes a single formulary function shared with the
  importer, so the two can no longer disagree about how the rank is computed.

A correction is therefore just a re-projection of the rows `derived_from` that substance. The
release image is never deleted (W10 stays refused), so any projection can be reverted.

### 3.4 `checked` (W9)

`searchMedicines` returns `checked: boolean`: true when no component is a release image. The
doctor's picker marks an unchecked product as *"not yet reviewed by pharmacy"*. **What this phase
does not do:** change the prescribing checks' verdict for a line that has release-image salts. That
is DECIDED 2(a) of the previous phase: the owner is told, not asked. Until it ships, such a line's
allergy check matches text against the release name, and its interaction check finds nothing
because release images carry no pairs.

### 3.5 The drafter (T2)

`scripts/draft-substance-mappings.ts [--agent-file <json>] [--apply]`. It is a planner and a
dry run first, as the loaders are:
- **release half:** parses the stored generic names (`formulary_generics.name`) for `precisely X
  (as Y)`, taking X as the last clause before `(as`. It rejects any X carrying a strength, drops a
  trailing hydrate word (`anhydrous`, `monohydrate`, …) and records that it did. Several distinct
  X values for one Y is a conflict, and it carries all of them as evidence rather than choosing;
- **model half:** `--agent-file` ingests `{model, draftedAt, items: [{sctid, moietyName,
  rationale}]}`, which is written by an agent outside the server (Plan 12a still owns
  `InferenceClient.complete`, so the server makes no model call here). A `rationale` is required.
  An unknown `sctid` is refused and named.

---

## 4. EDGE CASES

| # | case | answer |
|---|---|---|
| E1 | target is a release image | refused, `release_image_target` |
| E2 | two components of one product map to one moiety | that product is not projected; counted in the attest result and in census |
| E3 | product has a `curated` row | never projected |
| E4 | component ruled unmappable | its row stays on the release image; the product stays unchecked |
| E5 | two pharmacists attest one substance | conditional update; the second gets `substance_not_pending` |
| E6 | wrong mapping | re-attest with a reason: re-projects its rows; the event carries `fromSaltId` |
| E7 | target moiety inactive | refused, `unknown_salt` (an inactive moiety cannot be newly used) |
| E8 | substance with no release image (the loader reused a curated row by name) | mapping still recorded; nothing to project |
| E9 | an agent actor calls attest | refused, `attester_not_user`, before any read |
| E10 | a medicine loaded before this migration (`derived_from` null on a curated-reuse row) | already names a curated moiety; the projection ignores it |
| E11 | a release-only database (no cds load) | worklist coverage is 0 everywhere and ordering falls back to name; attest still works |
| E12 | a proposal names a moiety that doesn't exist yet | the worklist offers "create *X* and map", one act |

---

## 5. TASKS

Each task is a PR, and this lane has one migration in total (T1). Serial taken at rebase.

- **T1: proposals, attestation, projection (backend).** Migration: `formulary_mapping_proposals`,
  `formulary_medicine_salts.derived_from` + backfill. `attest`/`unmappable`/worklist in a new
  `mapping.ts`; the shared rank refresh; importer states `derived_from`; routes under
  `formulary.manage`; census gains substance counts. Tests: the actor gate, E1–E12, a projection
  pin that reads the real migration's backfill, and mutants.
- **T2: the drafter** (`draft-substance-mappings.ts`, release half + agent-file ingest).
  Measured partition printed on dry run.
- **T3: the worklist screen** (in `formulary-admin`): one substance at a time, evidence
  visible, three acts, keyboard-first, no bulk accept.
- **T4: `checked` in the picker** (W9): `searchMedicines` + `DrugField` chip.
- **T5: residuals.** The 51 colliding normalized brands, the raw-SQL read in `cds/allergens.ts`,
  and the 15 MB prose in the three files no live lane is editing.
- **T6 (owner): the drafting run.** An agent drafts the top ~300 substances with no release
  evidence into an agent file, and the owner or pharmacist runs `--apply`. Then R3's load, then
  the attestation sittings.

**Not in this phase:** the prescribing checks' verdict for release-image lines (§3.4); the
retro-scan of prescriptions issued before a projection (a named deferral since 16a, and
`substance.mapped` is what makes it buildable); drug classes and interaction pairs for the newly
curated moieties (the P&T committee's, and the RFQ's).
