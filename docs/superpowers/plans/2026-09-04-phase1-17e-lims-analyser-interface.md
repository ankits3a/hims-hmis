# Phase 17-E — The analyser interface (LIMS series, 5 of n)

**Lane: LIGHT** (7 tasks, no new module, four migrations — EXECUTE-METHOD-V3 §2).
**Stop-loss: 2,120,000** = main-session `7 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145, the repair term).
**Lane:** `/opt/hmis-lanes/lims/hmis`, branch `lane/lims-17e` cut fresh from `origin/main`. Own test DBs `hmis_lane_lims_test*`. **One task = one PR**: commit by pathspec, push, `gh pr create`; CI is the gate; locally only the touched suites, always through `test-lock.sh`. **Migration numbers are taken at rebase, never at authoring** (CLAUDE.md).

**Status: APPROVED BY THE OWNER 2026-09-05 ("Execute 17E as necessary"). T1 EXECUTED.**

## 1. Why this phase

17a, 17b, 17c and 17d are closed and merged. The lab has five working seats, a report centre, and —
after 17d — a set of controls for the day that goes wrong. Every number in it was typed by a human.

That is the gap. `EdgeCases.dc.html` returned three plan GAPs and this is #19: **`lab_results.entry_mode`
admits `'interface'` and nothing writes it; `lab_results.analyzer_id` exists and nothing writes or
reads it; the `analyzer` resource kind is declared with seven statuses and four of them have never
been written.** The seams were cut for this phase by name, in three separate files, and left empty.

`docs/design/2026-09-01-lims-central-lab/Instruments.dc.html` is already the design for it, which is
why this phase was chosen over 17-M (the referral lab, GAP #9) — see D0. The board describes nine
machines on a real bench and, more usefully, **four different ways a machine names a sample**:

- it reads the tube's barcode (chemistry analyser, ESR),
- it takes an id typed or scanned at the machine (Z3, CLIA, immunoassay),
- it knows only a **sequence number** and needs a run sheet (EL-120 electrolytes, U120 urine strips),
- it knows only a **well** and needs a plate map (ELISA reader, 96 wells).

Those four are the phase. Everything else on the board — one block splitting into many results, a
rerun keeping both values, the instrument's clock never being trusted — falls out of them.

**The through-line is one rule the board states and this phase enforces everywhere: _never attach by
guess._** A result whose sample cannot be named is **parked**, and a human names it or discards it
with a reason. The failure this prevents is the worst one an interface can produce — a number
attached to the wrong patient, silently, at machine speed, with a signature on it.

**Finish line:** each of the four naming modes ships with a test that fails first under its mutant;
a result that cannot be named reaches a human and never a patient; and §6 records, with reasons,
what was deliberately not built.

## 2. Ground truth — measured 2026-09-04 at `a415984` (lane tip; `origin/main` at `1a752e0`)

| # | what the board needs | what the code has today | where | 17-E |
|---|---|---|---|---|
| 1 | a result that came from a machine | `entry_mode` CHECK admits `'manual', 'manual_from_printout', 'interface'` — **and the bench controller's wire enum is `z.enum(["manual","manual_from_printout"])`, so `'interface'` is unreachable by construction** | `schema/lab.ts:498`, `lab-bench.controller.ts:54` | **T3** |
| 2 | which machine produced it | `lab_results.analyzer_id` exists. **Zero writers and zero readers in the whole repository** — the column appears once, in the schema | `schema/lab.ts:482` | **T3** |
| 3 | a machine as a thing with a state | `analyzer` is in `resources_kind_ck` and in `LAB_RESOURCE_KINDS` with 7 statuses; `manifest.test.ts:96` pins the declaration. **Nothing creates an `analyzer` row**; `qc_locked`, `calibration_due`, `maintenance`, `interface_down` have never been written | `lab/kinds.ts`, `schema/resources.ts:159` | **T1, T7** |
| 4 | the machine's own test codes and units | nothing. No per-instrument code map anywhere | — | **T1** |
| 5 | the bridge authenticating as a machine | **already built**: `agents` table (`api_key_hash`, `kill_switch`), `createAgent` / `findAgentByKey`, and `guards.ts:52` already sets `req.hmisActor = { type: "agent", id }`. `lab_results.entered_by_type` CHECK already admits `'agent'` | `kernel/auth/agents.ts` | **T2 (reuse)** |
| 6 | a machine asking what to run | nothing in lab. **18b built the exact analogue for imaging** — a worklist the bridge PULLS rather than files a consumer writes (D1 in `radiology/mwl.ts`) | `radiology/mwl.ts` | **T2** |
| 7 | a run sheet (sequence → specimen) | nothing | — | **T4** |
| 8 | a plate map (well → specimen, with controls) | nothing | — | **T5** |
| 9 | a parked, unattached result | nothing. Every result today hangs off an `order_item` from the moment it exists | `results.ts` | **T3, T6** |
| 10 | a rerun keeping both values | `lab_results.rerun_of` and `supersedes_result_id` exist and are written by the manual rerun path | `results.ts:1289` | **T7** |
| 11 | the interface being down | `entry_mode = 'manual_from_printout'` **ships and works** (17d T6 put downtime on the screens) | `results.ts` | **T7 (status only)** |
| 12 | reagent stock behind a run | **`reagent` is already a material class** in `materials` — `BATCH_MANDATORY_CLASSES = ["drug","consumable_dated","reagent","implant"]`, with shelf-life and QC rules | `materials/config.ts:118` | **§6 — not built** |
| — | base | **69 migrations** on this branch (`0000`–`0068`); `origin/main` carries `0069`. **15 lab permissions**, 13 lab tables, `LAB_BENCH_TOPIC = "lab:bench"`, 5 lab screens | | **+2 permissions** |

Two measured facts that shape the design and would otherwise be guessed:

- **An analyser may not be an order-item transition actor.** `order_item_transitions.actor_type`
  rejects `'analyzer'`, and `orders.test.ts:234` asserts the rejection. So a machine does not move an
  order item; the **agent** that carries its results does, and the machine is recorded as
  `analyzer_id` beside the row. This is already the right shape and this phase does not widen it.
- **`entry_mode` is checked in two places with different vocabularies** — the DB CHECK (three values)
  and the controller's zod enum (two). That asymmetry is the seam, and T3 must widen the *route*,
  not the shared bench enum: a clerk must not be able to hand-key a result claiming it came off a
  machine. See D6.

## 3. Design decisions — DECIDED; none is money, procurement or law

- **D0 — 17-E before 17-M.** A scope call between two planned features, decided in the lane per
  CLAUDE.md rather than escalated. 17-E has a finished design board that answers the hard questions
  (how each machine names a sample); 17-M (the referral lab) has none, and its hard questions —
  which partner labs, on what commercial terms, with whose report letterhead — are exactly the
  money-and-procurement shape that *does* need the owner. 17-E can be built tonight; 17-M cannot.
- **D1 — The bridge is out of this repository; the SERVER SIDE of it is the phase.** The board's
  bridge is a small program on a bench PC talking RS-232, USB-serial and LAN. This repo ships the
  two HTTP routes it talks to and the tables behind them, and nothing else. Building a serial
  daemon here would put an untestable, un-CI-able device driver in a monorepo that has no hardware —
  18b made exactly this call for DICOM (`mwl.ts` D1) and it held.
- **D2 — CORRECTED AT T2. The bridge is a SERVICE USER with a one-permission role, not an agent.**

  *As authored, this decision said the bridge authenticates as an agent, on the strength of `agents`
  + `api_key_hash` + `kill_switch` already existing. **That is impossible and the doc was wrong.***
  `kernel/auth/guards.ts` throws `ForbiddenException("agents hold no permissions yet")` for **any**
  non-user actor before it reaches `hasPermission`, so an agent cannot pass `@RequirePermission` at
  all — the agent-permission table is a declared Plan 12 seam that has not shipped. The original D2
  was written from a fact that was read (the table exists) without checking it against the thing
  that would have to accept it.

  **18b had already solved this and the precedent is followed.** `modality_bridge` is a role holding
  exactly one permission (`radiology.mwl.read`), and its own title in `seed-roles.ts` says what it
  is: *"Modality bridge (a MACHINE account: pulls the worklist export; holds nothing else)"*. So the
  lab's bridge is `lab_bridge`, a service user whose role holds the narrow interface grants and
  nothing else.

  Two consequences worth stating rather than discovering:
  - `lab_results.entered_by_type` will read `'user'` with the bridge's user id, not `'agent'`.
    That is more precise, not less: `entry_mode = 'interface'` already says the value came off a
    machine, and `entered_by_id` says which account carried it. HOW and WHO stay separate columns.
  - The agent kill switch is not available, so **revoking the role (or the account) is the control**
    that stops a misbehaving machine. That is a real difference from what this doc first claimed and
    it belongs in the runbook.
- **D3 — A transmission is received whole and ATTACHED one result at a time.** The board: *"One
  block, many patients. One unreadable row parks that row; the other nine go on."* So ingest is two
  steps, not one — `lab_transmissions` (what arrived, from which instrument, when) and per-result
  attachment. A block is never accepted or rejected as a unit, because the ESR's ten positions are
  ten different patients and one unscanned tube must not cost the other nine their results.
- **D4 — NEVER ATTACH BY GUESS. A result that cannot be named is PARKED, and parking is a state, not
  an error.** No fuzzy matching, no nearest-sequence, no "the only unmatched tube on the bench must
  be it". A parked result is visible, nameable by a human, and discardable only with a reason. This
  is the rule the whole phase exists to enforce and no task may weaken it to make a test pass.
- **D5 — TWO CLOCKS, and ours is the one that counts.** The arrival instant is the server's;
  the instrument's own timestamp is stored beside it and is **never** read for TAT or for the
  delta check. Analyser clocks drift, are set wrong at install, and survive power cuts as 00:00.
  17a's TAT is measured from collection and must stay that way.
- **D6 — `entry_mode = 'interface'` is writable ONLY on the agent route.** The bench controller's
  enum stays `["manual","manual_from_printout"]`. A human keying a number must not be able to label
  it as machine-produced, because `interface` is what a later auto-verification phase will trust.
  The route, not the enum, is the boundary.
- **D7 — The instrument's own H/L flags are DISCARDED.** The board says it and the code already
  implies it: flags come from `lab_reference_ranges` through `resolveRange`, which knows the
  patient's sex and age. An analyser's flag knows neither. Storing both would create two answers to
  "is this abnormal" and the report would depend on which one the renderer read.
- **D8 — Codes and units are mapped PER INSTRUMENT, and an unmapped code parks the result.** Not
  "passed through as text": a U120 reporting `GLU ++` and a chemistry analyser reporting `GLUF 41`
  are different tests, and a global code table would make the mapping ambiguous the day two
  machines use the same word. Unit conversion is a stored factor, applied once, at attachment.
- **D9 — A rerun keeps BOTH values and a human chooses.** Same instrument, same analyte, same sample
  is a rerun, not a duplicate and not an amendment. Both rows live; neither is auto-superseded; the
  bench chooses which the report carries **and says why**. Auto-choosing the later value is how a
  bad second run silently overwrites a good first one.
- **D10 — A plate whose CONTROLS FAIL is rejected whole, and no patient gets a result from it.**
  The one place in this phase where a block IS all-or-nothing, and it is the opposite of D3 for a
  reason: the ESR's positions are ten independent measurements, whereas a plate's 92 patient wells
  are all computed against the same cut-off derived from that plate's controls. If the controls
  failed, the cut-off is meaningless and so is every well on it.
- **D11 — QC lockout and calibration are NOT in this phase, and `onRelease` stays `available`.**
  `kinds.ts` says "17-E owns the release rule" and this phase's answer is: the honest default holds
  until there is a QC module to unlock a machine. Writing `qc_locked` with no way to clear it would
  lock every analyser from its first run. `interface_down` **is** written here (T7) because the
  bridge can observe it; `qc_locked` and `calibration_due` need Levey–Jennings and a calibration
  schedule, which is its own phase. Recorded in §6, not silently skipped.
- **D12 — A plate reader names its sample by the WELL, and `position` is never consulted for
  identity.** DECIDED at T5. The well arrives in `sampleId`, the field whose whole meaning is "how
  the machine named this sample"; `position` stays the transmission's own ordinal and is the key the
  parked-results table is unique on. Two fields that could each answer "which well is this" is one
  answer too many, and the wrong one would report a control as a patient.
- **D13 — On a plate whose controls failed, NOTHING from that block reaches a human — not a result,
  and not an inbox row either.** DECIDED at T5, and it is the half of D10 that D10 did not say out
  loud. T6's inbox exists so somebody can NAME an unidentified number and attach it, which re-runs
  the whole attachment path; every guard on that path would let a void well through, because none of
  them knows about the plate. A parked row from a rejected plate is therefore an *invitation* to
  release the exact value the rejection refused. So parking is DEFERRED until the controls have
  spoken: the rows are collected first and written only once the plate is known to be good. The
  plate row — status, both control means, the computed cut-off, and a sentence naming the fault — is
  the whole record of the rejection, and every optical density on it is kept. **T6 must render a
  `controls_failed` plate somewhere**, because the inbox deliberately will not.
- **D14 — What a patient well REPORTS follows the catalogue, not the plate.** DECIDED at T5. A
  qualitative screen is a `coded` analyte and carries the interpretation (`Reactive` /
  `Non-Reactive`); a lab that catalogued the index as a number gets the S/CO ratio. Either way the
  other figure travels in the result's remarks with the plate, the kit lot, the well, the OD and the
  cut-off — so the number that produced the interpretation is on the record, and a report can never
  show a bare optical density, which is meaningless off its own plate and, worse, looks comparable
  across plates. The remarks are also where a first-run reactive carries its REPEAT instruction, so
  whoever verifies it sees the requirement without opening the plate.
- **D15 — A dedicated cut-off control REPLACES the kit formula when the plate carries one; blanks are
  never subtracted.** DECIDED at T5. Some kits ship a cut-off control and say to use its mean
  directly, others give a formula over the negative controls — the plate says which kit this is by
  whether the control was laid out, rather than this file preferring one house style and applying it
  to a kit whose insert says otherwise. Blank wells are recorded and deliberately not subtracted:
  whether the reader has already blanked its own readings is a property of the reader, and
  subtracting a second time would silently halve every cut-off, which makes borderline samples read
  as reactive and would never announce itself.

## 4. Tasks — one PR each, fail-first, rail + consumer together

### T1 — ROUTINE · The instruments the lab actually has
`lab_instruments` keyed on a `resources` row of kind `analyzer` (`resource_id` FK, unique): the
sample-id mode (`barcode | typed_id | run_sheet | plate_map`), the connection kind as free text (it
is documentation, not behaviour), and `active`. `lab_instrument_codes`: `(instrument_id,
instrument_code)` → `analyte_id`, `unit`, `factor` (numeric, default 1), unique on the pair.
Registering an analyser creates the resource through the kernel so the status vocabulary in
`kinds.ts` finally has an owner. **Migration** (additive, number at rebase). New permission
`lab.instruments.manage`. **Mutants:** two instruments sharing one resource row (unique must bite);
a code mapped twice on one instrument; a factor of 0 silently zeroing every value.

### T2 — ROUTINE · The machine asks what to run
`GET /lab/instruments/:id/worklist?sampleId=…`, agent-authenticated, modelled directly on 18b's
`mwl.ts` (D1 there): given a barcode, answer with the analytes this instrument is mapped for on that
specimen's open order items — and **nothing else**. No patient name, no UHID, no diagnosis: an
analyser needs a test list, and a bench PC on a flat hospital LAN is the last place to put PHI.
That withholding is the test. **Mutants:** return an analyte the instrument has no code for; answer
for a specimen that is not collected; leak the patient block; answer without the agent guard.

### T3 — CRITICAL · The block arrives, and every row finds its patient or parks
`POST /lab/instruments/:id/results`, agent-authenticated. Body is one transmission: `{ transmissionRef,
rows: [{ position, sampleId, code, value, unit, instrumentAt }] }`. `lab_transmissions` records the
arrival (server clock, D5) and `transmission_ref` is unique per instrument so a bridge retry after a
timeout is idempotent rather than a second set of results. Each row is attached INDEPENDENTLY (D3):
resolve the code through `lab_instrument_codes` (unmapped → park, D8), resolve the sample by the
instrument's mode — **barcode and typed_id are this task** (the sample id IS the specimen number) —
then write through the *existing* `writeResult` path so 17d's applicability guard and the absurd
envelope apply to machine values exactly as they do to typed ones. `entry_mode = 'interface'`,
`analyzer_id` set, `entered_by_type = 'agent'`. Anything unresolved becomes a `lab_parked_results`
row carrying the raw payload. **Migration.** **Mutants:** make one bad row reject the block (D3);
attach an unmapped code as text; trust `instrumentAt` for TAT (D5); skip the applicability guard on
the machine path; let a repeated `transmissionRef` write twice.

### T4 — CRITICAL · The run sheet, for a machine that can only count
`lab_run_sheets` + `lab_run_sheet_positions`: before loading, the bench scans each cup in order and
the sheet remembers `position → specimen`. On ingest, an instrument in `run_sheet` mode resolves
`row.position` against the open sheet for that run. **A gap in the sheet parks that position and
only that position** — it never falls through to the neighbouring cup, which is the single most
dangerous thing this phase could get wrong. A sheet is closed when its block lands, and a second
block against a closed sheet parks whole. **Migration.** **Mutants:** resolve a gap to the next
filled position; let two open sheets exist for one instrument; accept a position past the sheet's
length; reopen a closed sheet.

### T5 — CRITICAL · The plate map, and the controls that can void it
`lab_plate_maps` + `lab_plate_wells`: 96 wells, each `blank | negative_control | positive_control |
cutoff_control | patient`, patient wells carrying a specimen. On ingest, an instrument in
`plate_map` mode receives 96 optical densities; the cut-off is computed from that plate's own
controls, and **if the controls fail, the whole plate is rejected and not one patient well produces
a result (D10)** — the plate is marked `controls_failed` with the computed figures kept, so the
rejection is auditable rather than a silence. Reactive screens are flagged for repeat in duplicate
before anyone is told (board, HBsAg/HCV/HIV). **Migration.** **Mutants:** compute the cut-off from
another plate's controls; release patient wells from a failed plate; treat a control well as a
patient; let a reactive screen skip the repeat flag.

### T6 — ROUTINE · The inbox: three results waiting for a patient
The seat the board draws — Abha Rani's interface inbox. Parked results with their raw payload,
their instrument and their arrival time; **match by hand** (name the tube, which re-runs the same
attachment path so every guard applies) or **discard with a reason** (never a bare delete). The
header carries each instrument's live state. Realtime on `LAB_BENCH_TOPIC`, which already exists.
New permission `lab.instruments.operate`. **Mutants:** a hand match that bypasses the applicability
guard; a discard with an empty reason; a parked result attachable to a specimen from another day.

### T7 — ROUTINE · Reruns keep both, and a dead link is a status
Same instrument + same analyte + same sample within a run is a **rerun**: both rows kept, neither
auto-superseded, and the bench chooses which the report carries with a reason (D9). And the bridge
reports its link: an instrument that stops answering goes `interface_down` on its resource — the
first of the four unwritten statuses to get a writer — the header greys it, and the bench falls back
to `manual_from_printout`, which already ships. **Mutants:** auto-supersede the earlier value;
choose without a reason; write `interface_down` on a machine that is merely idle; let a chosen value
be changed without an audit row.

## 5. Verify

```
pnpm typecheck && pnpm lint
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run lims \
  pnpm --filter @hmis/core exec jest -w 2 src/modules/lab test/lab.e2e.test.ts
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run lims \
  pnpm --filter @hmis/web exec vitest run src/screens/lab-
```
Full core belongs to CI. Never run it locally while a peer holds the box — and **every** run goes
through the mutex, not around it.

**Every task's test must fail first against the code it guards**, and the mutant is named in the
task. A phase whose tests were written after the code proves the code compiles, not that it is right.

## 6. Out of scope — named so nobody infers them

- **Reagent stock and consumption.** `materials` already carries `reagent` as a batch-mandatory
  class with shelf-life and QC rules (§2 #12), so the missing piece is *consumption* — a run
  decrementing a batch — and that is a change in the `materials` module, which another lane holds.
  Naming it here so 17-E is not blamed for the hole: it belongs to whoever owns materials next.
- **QC lockout, calibration schedules, Levey–Jennings.** D11. `qc_locked` and `calibration_due` keep
  no writer and `onRelease` stays `available`. A lockout with no unlock is worse than none.
- **Auto-verification of machine results.** `verification_status` admits `'autoverified'` and
  nothing writes it; 17b shipped auto-verification with zero rules. Machine-entered results make
  auto-verification *possible* for the first time, which is precisely why it should not ride along
  in the same phase as the code that first produces them. It also carries the known defect recorded
  in 17d's close: `listResultsForEncounter` filters `= 'verified'`, so an autoverified row would be
  invisible to the doctor entirely. **That reader must be fixed by the phase that switches
  auto-verification on** — not before, since widening a shared reader is what 22c-A's C1 cost.
- **The serial/LAN bridge itself.** D1.
- **Referral lab (GAP #9) and camp/corporate bulk (GAP #10).** Still unauthored. `sent_out` remains
  a declared order state with no writer.

## 7. Owner rulings

**None were needed for 17-E itself** — D0 (17-E before 17-M), D11 (QC deferred) and the §6 cuts are
standard-hospital scope calls, marked DECIDED per CLAUDE.md. The owner approved execution on
2026-09-05.

**17-M IS NOW UNBLOCKED.** The ruling this doc said would be needed before 17-M could be authored at
all — which partner labs, on what terms, whose letterhead — was given on 2026-09-05:

> *"CRK MEDICAL COLLEGE & HOSPITAL Letter head. Use synthetic data as partner labs and terms. I will
> test the operating system on synthetic data."*

So: the returned report carries the **CRK Medical College & Hospital** letterhead, and the partner
labs and their commercial terms are **synthetic fixtures** rather than real contracts, because the
owner is exercising the system on synthetic data first. That removes the procurement blocker, and
17-M becomes an ordinary authoring task whenever this phase clears.

## 8. CLOSE — filled at execution

### 8.1 T1 — The instruments the lab actually has (executed 2026-09-05)

Migration **0070** — `lab_instruments` + `lab_instrument_codes`, additive, no existing table
touched. **The first migration generated after the snapshot re-baseline (#81), and it came out with
7 statements, all its own** — against the 26 foreign ones the stale baseline would have re-emitted.

- The machine is a kernel `resources` row of kind `analyzer`, which `kinds.ts` declared in Plan 17
  T2 and said 17-E would be the first to write. `registerInstrument` is that writer: one transaction
  creating the resource and the lab's row together.
- `sample_id_mode` is the design compressed into a column — `barcode | typed_id | run_sheet |
  plate_map`, the four ways the board's nine machines name a sample. Every later task branches on it
  and on nothing else about the hardware.
- `connection` is documentation. Nothing reads it (D1: the bridge is out of this repository), and a
  column the server branched on would be a lie about where that decision is made.
- Codes map **per instrument**, never globally: `GLU` is a serum glucose on the chemistry analyser
  and a urine strip pad on the U120.
- New permission `lab.instruments.manage`, granted to `pathologist` — the bench's machines are the
  lab head's estate for the same reason the range book is. **The bridge never holds it**: it
  authenticates as an agent, and the actor TYPE is checked before the permission so an agent gets
  `user_actor_required` rather than a misleading "this user lacks the grant".

**Mutants, all three proved by measurement rather than by reading.** A probe dropped the three
guards and re-ran the writes: a second instrument row on one machine, a `sample_id_mode` of
`telepathy`, and a factor of `0` were **all accepted** — 4 instrument rows written where there
should be 2. With the guards in place each is refused by name.

The factor check is the one worth naming: a factor of zero does not fail, it reports every value on
that channel as **0**, and a potassium of zero on a live patient is a plausible number no absurd
envelope catches.

**The census tax was NINE places, not the five the notes claimed**: the lab manifest's permission
list and its count-in-prose, the error-code union, the error STATUS map, the error-owner census,
`ALL_MANIFESTS`' per-module count, the role model's per-role grant map, the README's lab permission
table, the README-parity derived base, and the V5 database census **twice** (first run and second).

**Evidence:** 29 suites / 263 tests exit 0 (lab + lab e2e + seed-roles), typecheck 0, lint 0.



### 8.5 T5 — The plate map, and the controls that can void it (executed 2026-09-05)

Migration **0073** — `lab_plate_maps` + `lab_plate_wells`, additive, no existing table touched.
Built on `lane/lims-17e-t5-clean`, cut fresh from `origin/main` with the parked schema
(`beed060`) cherry-picked rather than the stale T4 base merged.

- **The kit defines the arithmetic; the tables only store and apply it.** `cutoff_multiplier`,
  `cutoff_offset`, `min_pc_nc_ratio` and `max_nc_od` come off the kit insert at lay-out. A cut-off
  formula hard-coded here would be this software quietly overruling a regulated document, and NABL
  asks which kit and which lot — the plate carries both.
- **`evaluatePlateControls` is PURE and takes only readings from the plate being evaluated.** There
  is no parameter through which another plate's controls, a cached figure or yesterday's number
  could reach it. That is the shape of the guard, not a comment about it.
- **The biconditional is a database CHECK**: `specimen_id` non-null exactly for `patient` wells.
- One open plate per reader (partial unique index), one well per specimen, a rejected plate NAMES
  its reason, and every computed OD is kept on a failed plate.

**Four decisions taken and recorded in §3 as D12–D15.** D13 is the one a later task must not
undo: on a controls-failed plate NOTHING parks either, so **T6 must render a rejected plate from
`lab_plate_maps`, because the inbox deliberately will not show one.**

**One defect the plan did not name, found by asking what else could move the cut-off.** A well
transmitted TWICE in one block silently drags the negative-control mean, and the cut-off every
patient well is measured against moves with it, in a direction nothing reports. Neither reading is
used now. It is the same shape as the four mandated mutants and nobody had written it down.

**The four naming modes had grown four copies of "attach a machine value or say why it parked."**
They are one closure in `ingest.ts` now, collapsed BEFORE T5's arm was added rather than after —
four copies is four places a later task can loosen one guard on one path. T3's and T4's merged
suites are what proved the collapse did not change their behaviour.

**MUTANTS — six applied, six killed, each mutation OBSERVED rather than assumed.**

| mutant | result |
|---|---|
| the cut-off computed from something other than this plate's controls | KILLED — 4 failed / 11 passed |
| patient wells released off a plate whose controls failed (D10 defeated) | KILLED — 1 failed / 14 passed |
| the service lets a control well carry a tube | KILLED — 1 failed / 14 passed |
| the DB biconditional `lab_plate_wells_specimen_ck` dropped | KILLED — 1 failed / 14 passed |
| a reactive screen skips the repeat-in-duplicate flag | KILLED — 1 failed / 14 passed |
| a doubled well keeps its FIRST reading | KILLED — 1 failed / 14 passed |

**TWO METHOD FINDINGS, and the second is worth more than the feature.**

- **A mutant must be PROVED PRESENT before its survival means anything.** The constraint mutant
  first "survived". It had never been applied: the lane's worker databases persist between runs and
  drizzle applies migrations by timestamp, so editing an already-applied migration FILE is not a
  lever on a live schema. Measured afterwards, `lab_plate_wells_specimen_ck` was still present in
  both worker DBs. Reporting that survival would have been a fabricated finding about our own test,
  sourced from an experiment that never ran. The harness now drops the constraint with `ALTER TABLE`
  against both worker DBs and prints the constraint list before and after. **A survivor is a claim
  about the test only if the mutation was real; otherwise it is a claim about the harness.**
- **"The test throws, so the guard works" is unsound whenever more than one layer could throw.**
  Chasing that survivor found a real defect underneath: the test inserted `specimenId: newId()` into
  a column with an FK to `lab_specimens`, so the row was refused by the **foreign key** and not by
  the biconditional the test is named for — it would have stayed green with the CHECK deleted. A row
  can be refused by a type, a NOT NULL, an FK, a unique index, a CHECK or a trigger, and the cheapest
  fires first. The test now uses a REAL tube and asserts `.toThrow(/lab_plate_wells_specimen_ck/)`,
  naming the constraint it is about. It also asserts the half no foreign key could ever cover — a
  `patient` well with a NULL specimen, which nothing but the biconditional can refuse. **Enumerate
  what the invariant forbids before choosing the mutant: there were two forbidden things, not one.**

**Evidence:** 34 suites / 296 tests exit 0 (`src/modules/lab` + `test/lab.e2e.test.ts`), typecheck 0,
lint 0 (2 pre-existing warnings in files this task does not touch). Migration serial 0073 verified
free against `origin/main` and every remote branch at push time.
