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

`attestSubstance(tx, actor, substanceId, { saltId } | { newMoiety }, { proposalId?, correctionReason? })`:
- **The actor must be a person.** `attester_not_user` is checked before any read. The route also
  requires `formulary.manage`.
- **The target** must be an active **moiety** (§3.6), or this substance's **own** release entry
  ("it is its own moiety"). Another substance's entry that nobody has reviewed is refused
  (`release_image_target`): decide that substance first.
- **`newMoiety`** creates the moiety in the same transaction, through `addSalt`, so it is one act.
- **Pending versus correction.** A pending substance becomes `mapped` with no reason. A decided
  substance changes only through a correction, and a correction needs a reason
  (`substance_already_decided` / `substance_not_decided`). A row lock plus a conditional update
  keep two pharmacists from overwriting each other.
- **`substance.mapped`** records `{substanceId, sctid, saltId, fromStatus, fromSaltId,
  createdMoiety, ownEntry, proposalId, agreedWithProposal, correctionReason, projection}`.

`ruleSubstanceUnmappable(tx, actor, substanceId, { reason, correction? })` does the same for
`unmappable` (a grouper concept, an excipient, a vehicle, an organism) and emits
`substance.ruled_unmappable`. Its rows go back to the release entry.

### 3.3 Projection (W6): a derived composition row names the moiety its substance was mapped to

`formulary_medicine_salts` gains `derived_from` (the release substance's sctid). The importer
states it, and the migration backfills it for rows that sit on a release image (the
`source_ref` of their salt). **The projection is a total function of the release composition and
the mappings.** For a derived row whose `derived_from = X`:

- **Target:** `X`'s moiety if `X` is mapped, otherwise `X`'s release entry, otherwise the row stays
  where it is (E8).
- **Per row, not per medicine.** A composition whose rows are partly moieties and partly release
  entries is **complete**: no component is missing. DECIDED 3's complete-or-nothing rule is about
  dropping components, and projection drops none. Projecting row by row puts a moiety's class and
  interactions on the checks the moment it is attested.
- **A collision leaves the whole medicine alone.** If two rows of one medicine would name the same
  moiety (Calcium Sandoz: glubionate + lactobionate), that medicine is not projected and is
  counted.
- **A medicine with any `curated` row** is never touched.
- **One statement, inside the attesting transaction, scoped to the decided substance.** It
  refreshes `product_count` / `salt_rank` through `refreshRankSignals`, which the importer now
  shares. The importer calls `projectSubstances("all")` after a load, so a product loaded after its
  substance was decided is placed too.

A correction is a re-projection of the rows `derived_from` that substance. The release entry is
never deleted (W10 stays refused), so any projection can be reverted.

### 3.4 `reviewed` (W9)

`searchMedicines` returns **`reviewed`**, true when every component is a moiety (§3.6). It is named
`reviewed`, not the handoff's `checked`: a curated moiety with no class and no pairs is reviewed,
but nothing has been checked against it either. The doctor's field says *"not yet reviewed by
pharmacy"* beside such a product. An absent flag (an older server) shows nothing. The census counts
`unreviewedActiveMedicines`.

**What this phase does not do:** change the prescribing checks' verdict for a line with an
unreviewed component. That is DECIDED 2(a) of the previous phase: the owner is told, not asked.

### 3.5 The drafter (T2), as built

`scripts/draft-substance-mappings.ts [--apply] [--agent-file f] [--export-undrafted f --top n]`.
It writes drafts only, labelled by drafter, and has no actor.
- **Release half.** Reads "BASE (as INGREDIENT)" in both of the release's grammars: the SNOMED
  FSN, and the shorter trade form "Amlodipine (as amlodipine besylate) 5 mg".
  - A statement counts only if its ingredient is one of that generic's own substances **and**
    shares a name stem with the base. The release misaligns some components itself: generic
    1621000189106 says "Menthol (as guaifenesin)".
  - Where statements disagree, the majority wins and the dissent is carried with counts. A
    hydrate word is dropped and recorded.
  - `release_base` covers only substances the release names **as a base**. Strength stated as a
    salt is not evidence of being a moiety.
  - Measured: 2,359 statements, 53 dropped as misaligned, 569 `release_boss` (15 contested), 474
    `release_base`.
- **Model half.** `--export-undrafted` writes the pending substances nobody has drafted,
  most-used first. `--agent-file` takes a model's drafts back: `{model, release, items: [{sctid,
  moietyName, rationale}]}`, strict. An unknown sctid refuses the whole file. The server makes no
  model call; Plan 12a owns `kernel/inference`.

### 3.6 What makes a salt row a moiety, and why the data forced a second clause

`formulary_salts` is unique on `lower(name)`, and the importer's release entry `Paracetamol` (4,866
products) already holds that name. So **a curated `paracetamol` cannot be created**, and the same
is true of most base substances. The design therefore says a row is a moiety when it is curated
(`source_ref is null`) **or** some mapped substance points at it. That is one predicate,
`modules/formulary/moiety.ts`, and the target check, `reviewed`, the census and the moiety picker
all use it. "It is its own moiety" moves no rows and renames nothing. Ruling it otherwise later
makes the entry unreviewed again.

### 3.7 Two seam defects the build found, both fixed before merge

- **A decision silenced an allergy check that was firing.** An allergy is stored as text, and
  "Amoxicillin trihydrate" resolves by exact name to the release entry. After the decision moved
  the product to `amoxicillin`, all three allergy layers missed. Proven red through the real
  `runRxChecks`: the warning fired before the decision and not after. **Fixed:** wherever a mapped
  entry is named (a text, or a medicine composed by hand from the entry), the moiety it was mapped
  to is named beside it, as a union and never a swap.
- **An ambiguous brand chose a product.** 51 normalized names collide, `resolveDrugTexts` kept the
  last row, and `pharmacy/claim.ts` dispensed it for a free-typed line; 6 of the 51 differ in
  strength, form or route. **DECIDED (DD2 + FD-35):** a shared name resolves to the union of the
  products' moieties, to no product, and to systemic if any of them is.

---

## 4. EDGE CASES

| # | case | answer |
|---|---|---|
| E1 | target is ANOTHER substance's unreviewed release entry | refused, `release_image_target`: decide that substance first |
| E1b | target is this substance's own release entry | accepted: "it is its own moiety"; no rows move |
| E2 | two components of one product map to one moiety | that product is not projected; counted in the decision's `projection` |
| E3 | product has any `curated` row | never projected |
| E4 | substance ruled unmappable | its rows go back to the release entry; the product is unreviewed |
| E5 | two pharmacists decide one substance | row lock + conditional update; the second gets `substance_already_decided` |
| E6 | wrong decision | a correction with a reason; rows re-project; the event carries `fromSaltId` |
| E7 | target moiety inactive | refused, `unknown_salt` |
| E8 | substance with no release entry (the importer reused a curated row by name) | decision recorded; nothing to project |
| E9 | an agent, system or patient actor | refused, `attester_not_user`, before any read |
| E10 | a derived row on a curated-reuse moiety, loaded before this migration | `derived_from` null; already names a moiety; left alone |
| E11 | a release-only database (no cds load) | coverage 0 everywhere; `ownEntryId` null; decisions still work |
| E12 | a draft names a moiety that doesn't exist | "create *X* and map", one act |
| E13 | a draft names a moiety already held by a release entry | `existingState` says which kind; the screen offers the right act |
| E14 | an allergy text names a mapped release entry | resolves to the entry **and** its moiety (§3.7) |
| E15 | a brand name two products share | union of moieties, no product, systemic if any (§3.7) |

---

## 5. TASKS, AND WHERE EACH ONE IS

- **T1 + T2 + the §3.7 fixes: MERGED as #210** (`c03080ed`, migration `0097`). Green on both CI
  runs.
- **T3 + T4 (web) + residuals: the web PR** (branch `lane/formulary-web`). It carries the worklist
  screen, the census figures, the `DrugField` chip, `suggestMoieties` with the source-text
  boundary scan, and the drafter's reversal rule.
- **T5 residuals: all done except `opd-consult.tsx`'s prose.** That file is still being edited by
  live lanes.
- **T6: the drafting run is DONE and stored out of git.** It lives at
  `/opt/hmis-context/nrces-2026-09-drafts/`: 474 model drafts (md5
  `433339d9f17adc93a81d662dbdcb4976`), 26 deliberate skips with reasons, and a README naming the
  model's ten least-certain drafts. It applied cleanly to `hmis_formulary_dev`.

### 5.1 What a browser walk on the real release found (all fixed on the web branch)

A walk as a pharmacist (`pharma.demo` holding `pharmacy`) against `hmis_formulary_dev`, with both
tiers and 1,517 drafts loaded. "Paracetamol is its own moiety" moved 0 rows and took the unreviewed
count from 1,01,796 to 1,00,583. The walk found five things no test had covered:

1. **A salt was offered as "its own moiety"** beside the release's statement that the moiety is
   clavulanic acid. The shortcut is now withheld while a draft disagrees, and sits behind a question
   with the salt-form caution.
2. **The release states a pair both ways**, 38 to 1 for clavulanate. The minority draft made
   clavulanic acid "be" clavulanate potassium, and the two cards each sent the pharmacist to the
   other. The drafter now keeps the majority direction (2 reversed statements in the whole release)
   and withdraws its own stale drafts on a full re-run.
3. **"Decide that substance first"** gave no way to reach it. It now has a "Find X" button.
4. **Copy.** The own-moiety label used the draft's lowercase spelling, and "0 product rows moved"
   was noise.
5. **Layout.** The worklist sat above the stocking flow's name search; it is now below it.

### 5.2 Owner's deploy order, once the web PR is merged

1. Deploy. Production applies `0096` (#203) and `0097` (this phase).
2. `import:nrces --apply` (R3, command in §1).
3. `draft-substance-mappings --apply`.
4. `draft-substance-mappings --agent-file /opt/hmis-context/nrces-2026-09-drafts/agent-drafts-claude-opus-5.json --apply`.
5. The pharmacist's sittings of about 50 on `/formulary/admin`. The curve in §2 is the schedule.
6. `import-cds-catalogue --apply`, only once this phase is deployed. It projects every decision
   already made, so step 5 may straddle it.

Also give a person the `pharmacy` role: `formulary.manage` is its grant (16a DD10).

**Not in this phase:**
- the prescribing checks' verdict for unreviewed lines (§3.4);
- the retro-scan of prescriptions issued before a projection (a named deferral since 16a;
  `substance.mapped` plus `derived_from` make it buildable);
- drug classes and interaction pairs for newly attested moieties (the P&T committee's, and the
  RFQ's);
- `activeSalts()` still reads the whole moiety table on every free-text resolution (a PR-A residual,
  bounded at 3,287 rows).
