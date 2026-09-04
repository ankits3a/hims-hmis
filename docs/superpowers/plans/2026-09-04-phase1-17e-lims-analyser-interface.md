# Phase 17-E — The analyser interface (LIMS series, 5 of n)

**Lane: LIGHT** (7 tasks, no new module, four migrations — EXECUTE-METHOD-V3 §2).
**Stop-loss: 2,120,000** = main-session `7 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145, the repair term).
**Lane:** `/opt/hmis-lanes/lims/hmis`, branch `lane/lims-17e` cut fresh from `origin/main`. Own test DBs `hmis_lane_lims_test*`. **One task = one PR**: commit by pathspec, push, `gh pr create`; CI is the gate; locally only the touched suites, always through `test-lock.sh`. **Migration numbers are taken at rebase, never at authoring** (CLAUDE.md).

**Status: AUTHORED, NOT APPROVED, NOT STARTED.**

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
- **D2 — The bridge authenticates as an AGENT, using the mechanism that already exists.** No new
  auth. `agents` + `api_key_hash` + `kill_switch`, and `entered_by_type = 'agent'` on every row it
  writes. The kill switch matters more here than anywhere else in the system: it is the one control
  that stops a misbehaving machine writing results, and it is already built and already tested.
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

## 7. Owner rulings — none

Nothing here is money, procurement or law. D0 (17-E before 17-M), D11 (QC deferred) and the §6 cuts
are all standard-hospital scope calls and are marked DECIDED per CLAUDE.md.

One thing the owner will eventually need to rule on, recorded so it is not discovered late: **17-M
needs a ruling before it can be authored at all** — which partner labs, on what terms, and whose
letterhead the returned report carries. That is procurement and it is genuinely his.

## 8. CLOSE — filled at execution

*(empty — nothing has been executed)*
