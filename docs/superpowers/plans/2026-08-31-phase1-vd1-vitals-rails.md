# Phase VD-1 — The reading and the bench (Vitals Desk series, 1 of 3)

**Lane: LIGHT** (5 tasks, no full-module build — ruled per [EXECUTE-METHOD-V3](../EXECUTE-METHOD-V3.md) §2).
**Stop-loss: 1,720,000** = main-session `5 × 200,000` (§2.141) + task-subagent `0` (LIGHT, §2.143a) + review `240,000 × (1 + 2.0)` (§2.145). Comparable: 17b/RC-1, review pass ≈ 240k.
**Session token balance at kickoff: ~14.80M** (§2.141; deltas at every task boundary in CLOSE).
**Parallel-lane state at kickoff:** THREE sessions share this checkout. RC-1 T3 holds uncommitted edits in `opd/{queue,encounters,events,index,realtime,opd.module,opd-visits.controller}.ts`; 18a T5 holds `radiology/*`. Recorded, with the no-worktree ruling, in [`reports/2026-08-31-vitals-desk-recon.md`](reports/2026-08-31-vitals-desk-recon.md) §1. **Every test run here uses `TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_vd_scratch`, named in every commit that cites evidence (§2.137). Stage by path, never `git add -A`. Any task touching a contested OPD file waits for RC-1 T3 to commit — checked with `git status --porcelain` at the task's own start, not remembered from here.**

## 1. Why this phase

The owner signed off Bay One on 2026-08-31 (design `docs/design/2026-08-31-vitals-desk/bay-one.html`, handoff [`2026-08-31-EXECUTE-PROMPT-vitals-desk.md`](2026-08-31-EXECUTE-PROMPT-vitals-desk.md)). The seat is the OPD's throughput valve — only vitals-done patients are callable, so this bench *is* the hospital's wait time — and its last tripwire, where the class-3 walk-in who is actually a class-0 danger is found. The design thesis is **measure, don't transcribe**, and its atom is a **reading**: a value with a source, a band, a history and sometimes a second take.

The shipped server cannot hold a reading. `opd_vitals` stores one scalar per vital and nothing else — no second take, no source, no MUAC, no held value, no amendment chain — so five of the seven demo stories are unrepresentable in the database before any screen is written. The gates are worse than absent: `validateVitalsRanges` admits `weightKg` 0.3–400 and `spo2` 0–100, so **4.8 kg on a 72-year-old and an SpO₂ of 45 both become chart facts today**, silently, on the ordinary path. And the seat's own role cannot read the history the design pre-stages from (recon §3 R15).

VD-1 is the rails. VD-2 builds Bay One over them; VD-3 adds the serial seam. **No deploy anywhere in this series** — production has never left `commissioning`; code-complete plus one green full verify is the finish line.

**Owner rulings carried unmodified** — the seven of the handoff plus its eight DECIDED lines. Nothing here relitigates them; §3 records only their *mechanism*.

## 2. Spike

Each question was answered by reading this checkout at `226a775`. The answers are appended in place, per §1.

- **S1 — is the vitals→callable gate real, or ruling-only?**
  **ANSWER: REAL.** `openVisit` inserts the queue entry at `waiting_vitals` (`encounters.ts:155`); `listQueue` orders only `rows.filter(r => r.status === "waiting")` (`queue.ts:97`); `recordVitals` flips `waiting_vitals → waiting` in the same transaction as the encounter move (`vitals.ts:62`). A patient without vitals cannot be called. **Consequence: this phase must not touch that flip.**

- **S2 — can the bench's `resting` / `away` states be encounter states?**
  **ANSWER: NO, and the reason is procedural rather than aesthetic.** `opd_visit` is a **Class A** workflow definition (`workflow-def.ts`): a new state needs owner + medical-superintendent two-key approval and a definition version at go-live. The engine also gates transitions on **ROLE KEYS, not permissions** (`transitions[].roles`) — 18a's F9, confirmed here — so a bench state would additionally have to be re-granted in definition data. **They go on the queue entry (D3), where they are already invisible to the callable filter because the row stays `waiting_vitals`.**

- **S3 — do additive `opd_vitals` columns break any reader?**
  **ANSWER: NO.** Four readers exist and every one is a named-column or whole-row select over `eq(encounterId)` ordered by `recordedAt` ascending: `vitals.ts:105`, `encounters.ts:555`, `history.ts:130`, `prescriptions.ts:558`. **One trap, and it is load-bearing:** the e-Rx prints `vitals[vitals.length - 1]` (`prescriptions.ts:587`) — *the latest row*. So an amendment written as a NEW row prints correctly by construction, and a rest-and-recheck PAIR written as two rows would print only half of itself. That fact alone decides D2.

- **S4 — what can the seat's own role read?**
  **ANSWER: not the history it is designed around.** `vitals_desk` holds `opd.visits.read`, `opd.vitals.record`, `opd.queue.read`, `patients.read`, `patients.update` (`seed-roles.ts:142`); `GET /opd/patients/:id/vitals` is gated on `opd.consult` (`opd-visits.controller.ts:334`). D6 closes it.

- **S5 — next free migration number.** Journal head at authoring: `0048_counter_flow`. **Measured again immediately before and immediately after `db:generate` in T1** — two other lanes may generate first (§7 of the protocol).

- **S6 — is a child's supplied BP flagged today?**
  **ANSWER: YES.** `evaluateVitals` iterates every PRESENT ranged vital against the band's ranges, and `child_1_5` declares `sbp {min:75,max:130}`. The band correctly does not *require* BP; there is no "not routine" concept, so a paediatric cuff reading taken because the doctor asked is range-flagged like an adult's. D5.

## 3. Design decisions

- **D1 — ONE jsonb column holds the reading, and the scalars stay exactly as they are.**
  `opd_vitals.readings` carries, per vital key: `{ takes: [...], source: "typed" | "device" | "counted", held?: [...], note?: string }`. The existing scalar columns (`sbp`, `dbp`, `spo2`, …) keep holding **the operative take — the last one** — so every reader in S3, the e-Rx, the history and `evaluateVitals` are unchanged and correct without being touched. A migration that adds one jsonb column and changes no semantics is a migration that cannot break a shipped read.

- **D2 — A PAIR IS ONE ROW. AN AMENDMENT IS A NEW ROW.** This is the decision the phase turns on. Both produce "two readings", and nothing could tell them apart if both were rows.
  · A rest-and-recheck pair is **one** `opd_vitals` row whose `readings.bp.takes` holds both — *"shown as a pair, never averaged, never overwritten"* is then true by storage, not by convention, and S3's `vitals[length-1]` prints the pair whole.
  · An amendment writes a **new** row carrying `supersedes_vitals_id`, `amendment_reason`, and the predecessor's `status` flipped to `superseded` — the LIMS pattern (`schema/lab.ts:502`: *"there is no edit endpoint and there must not be one"*), inherited rather than re-derived. The field-level trail the owner ruled is the DIFF between versions, computed at read time; there is no second audit table.

- **D3 — The bench lives on the queue entry, and cannot reach the callable filter.**
  `opd_queue_entries.bench_state` (`null` | `resting` | `away`) and `recall_at`. The row stays `waiting_vitals` throughout, so S1's filter is untouched and an away patient's turn is held by the `seq` she already has — no re-queue, no code. `done` is not a bench state: it is the absence of a live entry plus a saved chart, which the bench read derives.

- **D4 — The escalation is a queue fact with a clinical fact beside it, and CANCEL only moves the queue one.**
  The contradiction is set out in recon §4 and this is its mechanism. `opd_encounters.danger_flagged` and the `vitals.danger_flagged` event keep firing on every danger reading exactly as shipped — **the clinical record is never weakened, and rule 14 is not engaged.** What the 10-second cancel reverts is `opd_queue_entries.danger`, the board fact, recorded as `escalation = 'cancelled'` with the canceller's id and clock. `recordVitals` then declines to re-raise `danger` on an entry whose escalation is `cancelled` — a named human's decision, not a silent suppression, and the doctor still receives the flag and both takes. The signed-off autonomy ladder is the authority: *"ASKS (never alone): anything that downgrades urgency."* The agent bumps; only a person un-bumps.
  **Apply-then-revert, never delayed-apply** (the handoff is explicit): the doctor sees the flash immediately, and cancel is a compensating action.
  States on the entry: `none → recheck_demanded → escalated → (cancelled | final)`. `final` is set by the expiry read, not by a timer — see D8.

- **D5 — "Not routine" is a third thing beside required and optional, and it is band data.**
  `BandConfig` gains `notRoutine: VitalKey[]`. A `notRoutine` vital is not required, and when supplied it is **recorded and not range-flagged** — the doctor asked for it, the number is real, and a flag the band cannot interpret is noise that trains people to ignore flags. `child_1_5` (and `infant`) get `notRoutine: ["sbp","dbp"]`. MUAC joins `VITAL_KEYS` and both under-6 bands' `required`, with SAM/MAM/green thresholds as config (`muacBands`), not constants.

- **D6 — One new narrow permission: `opd.vitals.history.read`.**
  It gates a **pre-stage reader** — the last recorded vitals for a patient, the derived band, the carried-forward candidates — and nothing else. It is NOT `opd.consult` widened, and it is NOT `patientVitalsHistory` regranted: that reader returns every reading this person has ever had, across the merge chain, and the bay needs the last one. Granted to `vitals_desk`, `nurse`, `doctor`. The precedent is `seed-roles.ts`'s own, quoted at the `vitals_desk` block: *"a narrow grant can be widened later without anybody being locked out in the meantime, and the reverse is not true."* Its PHI surface is a new name, `opd.vitals_prestage`, for the reason `opd.rx_history` is not `opd.prescriptions`.

- **D7 — A carried-forward value is a claim about provenance, so it is stored.**
  `opd_vitals.carried_forward: string[]` names which keys were not measured today. The lock is the server's, not the screen's: a carried value **may only be written with the carried number**, and a DIFFERENT number for a carried key is refused unless `unlockReasons[key]` names one of the four preset reasons — which is then recorded in `readings[key].note` beside the old value. A lock that lives only in the client is a lock a `curl` walks through.

- **D8 — The cancel window is a CLOCK COMPARISON, never a server timer.**
  `escalated_at + 10s`. A `setTimeout` on a Node process is lost on restart and unobservable in a test; a stored instant is neither. `cancelEscalation` refuses `escalation_window_closed` past it, and the transition to `final` is what any reader derives from the same comparison. The 10-second countdown is the SCREEN's, and it is cosmetic — the server would refuse a late cancel with the countdown still painted.

- **D9 — Gate overrides are per-key and explicit on the wire.**
  `POST …/vitals` gains `overrides: { weightKg?: "confirmed_real", heightCm?: "confirmed_after_remeasure", … }`. Absent an override the gate is a 400 `vitals_gate` carrying `detail.gates[]` (key, kind, value, suggestion). The screen renders the gate card from that payload — **client-immediate, server-enforced**, one rule, one place. The RR honesty nudge is deliberately NOT a gate: the owner's DECIDED line says a suspicious instant RR gets a nudge and never a block, so it is a screen behaviour with no server counterpart, and this document says so rather than leaving its absence to be read as an oversight.

- **D10 — Events, not a ledger.** Unlock, gate override, auto-bump, cancel and amendment each become a domain event on the append-only log this module already writes to. `agent_ledger` is RC-4's and does not exist (recon §3 R13); it is a projection surface, and building a second store here would duplicate the one shared primitive the handoff forbids duplicating. **A relay note tells the RC lane which events to project.**

- **D11 — An emergency save is a declared act.** `emergency: true` on the body trims the required set to BP + pulse + SpO₂ and is stored on the row. It is not inferred from the readings: a nurse decides a patient is crashing, and a system that inferred it would sometimes be wrong in the direction of accepting a half-filled chart.

## 4. Tasks

Each task: run the cheap prefix (`pnpm typecheck && pnpm lint`) before any launch (§2.132); narrow suites while iterating; the tree is frozen once a run is launched (§9.9 rule 5); `git status --porcelain` read before any `git add`.

### T1 — CRITICAL · the reading model and the one migration
**Files:** `apps/core/src/kernel/db/schema/opd.ts`, `apps/core/drizzle/<next-free>_vitals_bay.sql` + meta (measure per S5), `apps/core/src/modules/opd/config.ts`, `apps/core/src/modules/opd/vitals-rules.ts`, `apps/core/src/modules/opd/vitals.ts`, `apps/core/src/modules/opd/vitals-rules.test.ts`, `apps/core/src/modules/opd/vitals.test.ts`.

One migration carries **every** column this phase needs, both tables, so T3 and T4 add none:
`opd_vitals` += `muac_cm double precision`, `readings jsonb not null default '{}'::jsonb`, `context_chips jsonb not null default '[]'::jsonb`, `carried_forward jsonb not null default '[]'::jsonb`, `supersedes_vitals_id text`, `amendment_reason text`, `status text not null default 'active'`, `emergency boolean not null default false`.
`opd_queue_entries` += `bench_state text`, `recall_at timestamptz`, `escalation text not null default 'none'`, `escalated_at timestamptz`, `escalated_from_class integer`, `escalation_by text`.
Per D1/D2/D5/D11. `VITAL_KEYS` gains `muac`; `BandConfig` gains `notRoutine`; `DEFAULT_DANGER_RANGES` gains MUAC required under 6 with `muacBands`, and `notRoutine: ["sbp","dbp"]` on `infant` and `child_1_5`.

**Assertion book:**
(a) assertion — a two-take BP stores BOTH takes and the scalar columns carry the **last**; mutant — a scratch `vitals.ts` that averages the takes into the scalars; input — takes `[172,104]` then `[146,88]`; expected kill — `sbp` 159 vs 146, and `readings.bp.takes.length` 1 vs 2.
(b) assertion — a supplied under-5 BP is stored and produces NO danger flag while an under-5 SpO₂ of 88 still does; mutant — `evaluateVitals` ignoring `notRoutine`; input — a 4-year-old at 130/85 with SpO₂ 88; expected kill — flags length 2 vs 1.
(c) assertion — `missingRequired` demands MUAC under 6 and never over 6; mutant — MUAC added to the required set unconditionally; input — a 40-year-old with no MUAC; expected kill — `vitals_incomplete` vs success.
**Commit:** `feat(core): a vitals reading has takes, a source and MUAC — the pair is one row, the amendment is the next (VD-1 T1)`

### T2 — CRITICAL · the sanity gates, server-enforced
**Files:** `apps/core/src/modules/opd/vitals-rules.ts`, `apps/core/src/modules/opd/vitals.ts`, `apps/core/src/modules/opd/errors.ts`, `apps/core/src/modules/opd/config.ts`, `apps/core/src/modules/opd/vitals-gates.test.ts` (new).

Per D9. Four gates: **slipped digit** (an adult weight under the config floor, with the ×10 suggestion when it lands in a plausible adult range), **shrinking adult** (a height ≥3 cm from the carried value), **probe-error SpO₂** (below the config floor — held OUT of the scalar column and out of `dangerFlags`, recorded in `readings.spo2.held`), **carried-value lock** (D7). Thresholds are `opd_config` data, edited by clinical staff at UAT, never constants — the shipped `DEFAULT_DANGER_RANGES` precedent.

**Assertion book:**
(a) assertion — `weightKg: 4.8` on a 72-year-old is refused `vitals_gate` and lands NOTHING; with `overrides.weightKg = "confirmed_real"` it lands and is flagged hard; mutant — a scratch rules module without the digit gate; input — the Savitri body; expected kill — insert succeeds vs 400, and the row count 1 vs 0.
(b) assertion — an SpO₂ of 45 never reaches `opd_vitals.spo2` **and never reaches `dangerFlags`**, on both the typed and the device path; mutant — a gate that flags the value instead of holding it; input — 45 then 94 on re-clip; expected kill — `spo2` 45 vs 94, `readings.spo2.held` `[]` vs `[45]`.
(c) assertion — a carried height written with a different number is refused without a preset unlock reason and accepted with one, the old value kept in `readings.heightCm.note`; mutant — the lock checked only when `carried_forward` is empty; input — carried 151, typed 147, no reason; expected kill — 200 vs 400.
**Commit:** `feat(core): the four sanity gates the bay needs — 4.8 kg and 45 % SpO2 stop being chart facts (VD-1 T2)`

### T3 — CRITICAL · the escalation state machine and the compensating cancel
**Files:** `apps/core/src/modules/opd/escalation.ts` (new), `apps/core/src/modules/opd/vitals.ts`, `apps/core/src/modules/opd/events.ts`, **`apps/core/src/modules/opd/realtime.ts`**, `apps/core/src/modules/opd/escalation.test.ts` (new), `apps/core/src/modules/opd/escalation.concurrency.test.ts` (new).
> **PLAN DEFECT, FOUND AND FIXED AT T2's CLOSE RATHER THAN SILENTLY WORKED AROUND (AGENT-RULES §3).** `realtime.ts` was listed under T5 and belongs here. The doctor-board FLASH is the substance of this task — *"the doctor must see the flash immediately"* is the handoff's own words and the reason D4 chose apply-then-revert — and an event that is not in `OPD_REALTIME_NAMES` reaches no board. Splitting the write from its publication across two tasks would have left T3 provably incomplete while looking done. §3.1's rule, in the direction it is usually read backwards: a task's Files list must name every file its acceptance criteria touch.

Per D4/D8/D10. `demandRecheck` / `escalate` / `cancelEscalation`, each appending its event. `escalate` sets `danger = true` and stamps `escalated_from_class`; `cancelEscalation` restores it, inside the window only.

**Assertion book:**
(a) assertion — ONE danger reading sets `escalation = 'recheck_demanded'` and does **not** touch `danger` or the class; a second sets `escalated`, `danger = true`, class 0; mutant — an escalation that bumps on the first reading; input — 208/126 alone; expected kill — `danger` true vs false and `classOf` 0 vs 3.
(b) assertion — cancel inside the window restores the prior class **and a later `recordVitals` carrying the same danger flags does not re-raise `danger`**, while `encounters.danger_flagged` and the `vitals.danger_flagged` event still fire; mutant — `recordVitals` unchanged from shipped (the honest specimen: the code as it stands today); input — escalate, cancel, then save the pair; expected kill — `entry.danger` true vs false with `encounter.dangerFlagged` true in BOTH, which is the property that proves nothing clinical was weakened.
(c) assertion — a cancel one millisecond past `escalated_at + 10s` is refused `escalation_window_closed` and the class stands; mutant — a window compared with `>=` against a timer variable; input — a fake clock at +10.001 s; expected kill — 200 vs 409.
(d) assertion — two concurrent cancels produce ONE revert and one loser code; mutant — a cancel without the row lock; input — two parallel calls; expected kill — two `escalation.cancelled` events vs one.
**Commit:** `feat(core): the danger protocol — recheck demanded, double-confirm bumps, ten seconds to cancel (VD-1 T3)`

### T4 — CRITICAL · the bench, the recall, and the pre-stage reader
**Files:** `apps/core/src/modules/opd/bench.ts` (new), `apps/core/src/modules/opd/prestage.ts` (new), `apps/core/src/modules/opd/manifest.ts`, `apps/core/scripts/seed-roles.ts`, `apps/core/src/kernel/phi/audit.ts`, `apps/core/src/modules/opd/bench.test.ts` (new), `apps/core/src/modules/opd/prestage.test.ts` (new), **plus every census the manifest and role moves touch.** Run BOTH §2.138 greps at directory-and-glob scope — `grep -rn "opd.counter.flow.manage" apps/core --include=*.ts` for the places that NAME a sibling, `grep -rn "opdManifest\|ALL_MANIFESTS" apps/core --include=*.ts` for the places that COUNT — and expect the full verify to find the derived ones anyway (§9.9 rule 6: **this task owes a FULL verify at its boundary**).

Per D3/D6/D7. Bench states with `recall_at`; the valve numbers read from the existing `queues/summary` (recon §2.4) and are not recomputed here. `prestage` returns last vitals, derived band, carried-forward candidates and expected flags under `opd.vitals.history.read`, PHI-logged as `opd.vitals_prestage`.

**Assertion book:**
(a) assertion — a `resting` entry is invisible to `listQueue`'s callable ordering and keeps its `seq`, and the same is true of `away`; mutant — a bench state written as an entry `status`; input — one resting and one waiting entry; expected kill — ordered length 2 vs 1, and the callable set containing a patient with no vitals.
(b) assertion — an actor holding `opd.vitals.record` but NOT `opd.consult` reaches `prestage` and is still refused `patientVitalsHistory`; mutant — the reader gated on `opd.visits.read`; input — a `front_office` actor; expected kill — 200 vs 403.
(c) assertion — `prestage` on a confidential patient answers exactly as it answers for an unknown one; mutant — a distinct refusal code; input — a sealed patient's id; expected kill — `patient_not_found` vs `forbidden`.
**Commit:** `feat(core): the bench — resting, away and the recall, with a pre-stage reader the bay's own role may use (VD-1 T4)`

### T5 — ROUTINE · the HTTP surface VD-2 and RC-4 consume
**Files:** `apps/core/src/modules/opd/opd-visits.controller.ts`, `apps/core/src/modules/opd/opd-queue.controller.ts`, `apps/core/src/modules/opd/index.ts`, `apps/core/src/modules/opd/realtime.ts`, `apps/web/src/lib/opd-api.ts` (wire types only), `apps/core/src/modules/opd/vitals-http.test.ts` (new). **Contested files — confirm RC-1 T3/T5 state before starting.**

The routes: `GET /opd/bench`, `POST /opd/visits/:id/bench-state`, `GET /opd/visits/:id/prestage`, `POST /opd/visits/:id/escalation/recheck`, `POST /opd/visits/:id/escalation/cancel`, `POST /opd/visits/:id/vitals/amend`, and `overrides` / `emergency` / `readings` on the existing vitals body. Realtime: the escalation topics ride the existing `queue:{doctorId}:{serviceDate}` convention, hint-not-correctness (D6 of 07b), never a new mechanism.
**The zod boundary is the point of this task, not an afterthought** — RC-1 T1's whole existence is a field the controller's schema silently stripped. Every new body field is declared, and the test drives the **controller schema path**, not the service.
**Commit:** `feat(core): the bay's HTTP surface — bench, prestage, escalation and amend (VD-1 T5)`

**Verify economy (§9.9):** T1+T2 batch into one full verify at T2's boundary (T1 carries the migration, so its boundary is not optional — but T2 touches only files T1 already moved, and the batched run is the shape to copy). T3 batches its narrow suites. **T4 owes a FULL verify at its boundary** (manifest + role census). T5 batches into the phase-end full verify. A red full verify is diagnosed, never re-run (§9.9 rule 7): extract the failing set, re-run it isolated at `-w 2`, queued behind `loadavg < 5`.

## 5. CLOSE

*(appended as the phase runs)*

### T1 — DONE, `962f3be`

Migration **`0049_vitals_bay`** taken; journal head measured `0048_counter_flow` immediately
before generating and `0049_vitals_bay` immediately after (S5 answered), and the generated SQL
contained only this task's fourteen ALTERs with nothing of either parallel lane swept in.
**`0050` is free** and the RC lane has been told so.

**Mutants (rule 21) — three built, three DIED**, each quoted expected vs received:

| | mutation | discriminating input | received vs expected |
|---|---|---|---|
| A | `readingsToInput` averages the takes | takes `[172,104]` then `[146,88]` | sbp 159 / dbp 96 / pulse 83 **vs** 146 / 88 / 80 |
| B | `evaluateVitals` ignores `notRoutine` | a 4-year-old at 131/86 | 2 flags **vs** 0 |
| C | MUAC required in every band | a 40-year-old with no MUAC | `"muacCm"` present in the missing list |

**One existing test changed, and its COUNT is the evidence (§9.8 rule 1):** exactly one — the
paediatric leg — because MUAC became required under six. The fixture gained a green-zone `13.4`
rather than the assertion being relaxed, so the pulse assertion beside it still asserts pulse.
A count of one, in the one band the rule moved, is what a correctly-scoped change looks like.

**One census finding, from the §2.138 LIST grep** (`grep -rn "VITAL_KEYS" apps --include=*.ts
--include=*.tsx`): `apps/web/src/lib/opd-api.ts`'s `WireDangerFlag` was a closed union without
`muacCm`, so the server could emit a flag the wire type forbade. Widened in the same task that
made the server able to send it. The SIBLING grep (`tempC`) additionally surfaced
`rx-print.test.tsx`'s vitals fixture, which the `WireVitals` widening broke and which is fixed in
the same commit — **neither would have been found by reading this task's Files list**, which is
§9.9 rule 6's point arriving one task earlier than expected.

### T2 — DONE (pending the full verify below)

The four gates, server-enforced, with the order that makes them work: **hold → lock → gate →
completeness.** The hold runs first because a held SpO₂ must be able to turn a complete submission
into an incomplete one — which is precisely the owner's ruling (*"lives in the log, not the
chart"*), and is impossible if completeness runs first.

**Mutants — three built, three DIED:**

| | mutation | discriminating input | received vs expected |
|---|---|---|---|
| A | the slipped-digit gate is absent | 4.8 kg at age 72 | `[]` **vs** one `slipped_digit` gate suggesting 48 |
| B | the probe gate FLAGS instead of HOLDING | takes `[45, 94]` | `takes [45, 94]` **vs** `[94]` |
| C | the carried lock inverted (`carriedForward.length > 0` skips) | carried 151, supplied 147 | `[]` **vs** one locked key |

**Mutant A had to be rewritten once, and the reason is rule 21's own caveat.** The first version
disabled the gate's condition with `false &&`, which destroyed TypeScript's narrowing of `wt` and
died at `TS18049` — *a mutant that dies at typecheck proves nothing*. The honest mutation removes
the gate's BLOCK, leaving the surrounding code compiling, and that one died on the assertion.

**Deliberately NOT built: an RR gate.** The owner's DECIDED line is that a suspiciously instant RR
gets a nudge and never a block; the honest instrument is the 15-second counter, and the server
cannot see a keystroke clock in any case. Recorded in `vitals-rules.ts` beside the gates so a
later reader finds a decision rather than a gap.

### F1 — A BILL-FIRST WALK-IN 500s THE VITALS DESK. Reported by the RC-1 lane's close reviewer; fixed here because the file is this lane's.

Not this phase's defect, squarely this phase's file, and verified on three legs before a line was
written rather than taken on the reporter's word:

1. `encounters.ts`'s `join === "defer"` branch opens the visit and stops — `{ queueEntry: null,
   tokenNo: null, sessionId: null }`. A `registered` encounter with **zero** queue entries became
   reachable over HTTP the moment RC-1 T3 landed.
2. `listVisits` selects `from(opdEncounters)` with **no queue join at all**, so that visit appears
   on the vitals worklist exactly like every other registered patient.
3. `vitals.ts`'s `latestEntryWhere` asserted `entries[0]!` and immediately read `entry.sessionId`.

**The mutant is the shipped code of `962f3be` itself** — `git show` into a scratch module, one
symbol renamed — and it died with the defect quoted verbatim:

```
Expected: { "code": "unknown_queue_entry" }
Received: [TypeError: Cannot read properties of undefined (reading 'sessionId')]
```

That single run is both rule 21's kill and §2.4's fail-first, and it is the cheapest honest red
available: the wrong implementation needed no invention, because it was in `git`.

**Two guards, not one.** The pre-flight refuses before the transaction opens (the behaviour a
person at the bay sees); `latestEntryWhere` throws the same refusal where the invariant is
actually relied on, so a future caller arriving by another route gets a domain answer rather than
a TypeError. A non-null assertion justified by a guard forty lines away is a comment, not a check.

**Refusing is the answer; recording-and-catching-up is not.** `recordVitals`'s contract IS the
`waiting_vitals → waiting` flip, which is the gate deciding who the doctor may call. A bill-first
patient with no token would end up with vitals on the chart and still not callable — the gate
silently un-applied to exactly the patients whose flow is unusual.

> **LEDGER CANDIDATE, and it is a cross-lane instrument gap.** §2.138's two greps find a census by
> NAME or by LIST. **Neither can find a NON-NULL ASSERTION that a cardinality change has just
> falsified.** `entries[0]!` contains no identifier belonging to the thing that changed; no grep
> for `join`, `defer`, `walkIn` or `openVisit` reaches it. The instrument that WOULD is a grep for
> the affected TABLE's accessor beside an index-and-assert — `grep -rn "opdQueueEntries" apps/core
> --include=*.ts | grep -E "\[0\]!|\[0\]\."` — and the obligation belongs to the lane that
> RELAXES the cardinality (always-one → zero-or-one), because it is the only lane that knows the
> invariant moved. It was found here by a human-shaped close review, which is the expensive way.

### F2 — a filter whose stated purpose was already impossible (self-caught, this lane's own)

`lastActiveVitals` shipped its first version with `lt(recordedAt, now)`, added to exclude "the row
being written". **That row does not exist yet** — the read happens before the insert — so the
clause excluded nothing it was meant to, while excluding every reading recorded at the same
instant: under a pinned test clock that is the entire history, and in production it is a genuine
same-minute re-measure. Caught by T1's own carry-forward test going red against T2's lock. The
`status = 'active'` filter was always the one doing the work.

**And the fixture lesson beside it (§9.8 rule 3):** T1's carry-forward test carried a height for a
patient with NO previous reading, and T2's lock refused it — correctly. `carriedForward` is a
PROVENANCE CLAIM shown to a doctor; against an empty history it is a fiction. The fixture gained
the first visit it was always implying, plus a new leg asserting the refusal, rather than the
invariant being relaxed to fit it.

### The T1+T2 full verify — RED, DIAGNOSED, NOT RE-RUN (§9.9 rule 7)

`pnpm verify` on `hmis_vd_scratch`, launched detached with the exit value read from a file:
**exit 1**, six failures — and none of them is in this phase's diff or in any file it touches.

| | failure | mechanism |
|---|---|---|
| `lab/results.test.ts` | *"A jest worker process (pid=**3037126**) was terminated by another process: signal=SIGKILL"* | **OOM** |
| `ot/gates.test.ts` | same, **pid=3037134** | **OOM** |
| 4 web screens (`lab-bench`, `materials-vendors`, `ops-downtime-kit`, `staff-reports`) | *"Test timed out in 5000ms"* — inside FILES that took **92–94 seconds each** | starvation |

**The kernel names the two workers, so this is measured rather than inferred:**

```
[Mon Aug 31 20:49:47 2026] Out of memory: Killed process 3037126 (node) anon-rss:930960kB
[Mon Aug 31 20:52:27 2026] Out of memory: Killed process 3037134 (node) anon-rss:1159728kB
```

Both inside the run's window (launched 20:47). A test that is SIGKILLed by the operating system
has not failed an assertion — it has not finished one. And a 5-second timeout inside a 94-second
file, with `collect 755.88s` and `environment 457.90s` in the same summary, is the same fact from
the other side: `pnpm verify` runs core's jest and web's vitest CONCURRENTLY on a box with 15 GB
of RAM, ~8 GB already resident, and ten Claude sessions on it. The kernel log also shows three
earlier OOM kills at 19:49–19:55, before this lane's run existed.

**So the failing set is re-run ISOLATED at `-w 2`, queued behind `loadavg < 5`, and core and web
are run SEQUENTIALLY rather than concurrently** — re-running the whole verify under the
contention that caused the failure would only measure the contention again, which is rule 20
pointed at your own instrument.

**RESULT: `CORE EXIT: 0`, `WEB EXIT: 0` — all six green, at `loadavg 4.74` on entry.**
`ot/gates.test.ts` 71 s and `lab/results.test.ts` 79 s, both passing; and the four web files that
"timed out in 5000 ms" inside 92–94-second files came back in **643–948 milliseconds**. A
hundredfold. The tree that went red was byte-identical to the tree that went green; only the box
changed — §9.9 rule 7's own specimen, reproduced.

**Parallel-lane disclosure (rule 20):** the RC-1 lane was running its own jest on
`hmis_rc_scratch` during T1's targeted batch. A different database, so the FK/truncate contention
mode does not apply, and no interference was observed. RC-1 T3–T5 landed at `61e6c96` before T2
began, and the two lanes exchanged three coordination messages — including a zod-4 trap this lane
introduced and fixed (`.default({})` vs `.prefault({})` on an object whose fields carry their own
defaults) which blocked BOTH lanes' jest for about six minutes. **That is this phase's first
ledger candidate**: the cheap prefix (§2.132) was run AFTER the first jest launch rather than
before it, and running it before would have cost sixty seconds and cost the other lane nothing.
