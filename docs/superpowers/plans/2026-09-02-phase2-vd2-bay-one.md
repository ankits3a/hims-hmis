# Phase VD-2 — Bay One, the vitals desk (Vitals Desk series, 2 of 2)

> **APPROVED 2026-09-02 ("go ahead"), EXECUTED THE SAME DAY — see §5 CLOSE.** T0, the independent
> review VD-1 owed since `59e5943`, ran as the first task. **No owner ruling gates this phase**
> except the procurement ledger, and the bay ships around it (serial lane OFF — ruling 2 of 31-Aug).

**Lane: LIGHT** (6 tasks, one PR each, `lane/front-desk`). **This is a WIRING phase**: every rail
below exists and **not one has a web consumer** (§2). **Zero migrations. Zero new permissions**
(`vitals_desk` already holds `opd.vitals.record`, `opd.queue.read`, `opd.vitals.history.read`).
**Stop-loss: 1,470,000** per §2.95 from RC-3's measured screen-building rate (588k main ÷ 5 tasks
= 118k/task): coding `1.5 × 118k × 5` = 885,000 · recon carry 40,000 (spike paid inline) · review
**543,000** = RC-3/RC-4's actual two-pass term, **plus T0's reviewer inside it** — the review term is
where every phase since 09a found its CRITICAL; it is not a place to save. Record the token balance
at kickoff and at every task boundary (§2.141).

**Parallel-lane state at authoring:** lims, pharmacy, radiology lanes open; all append to
`router.tsx` and `locales/{en,hi}.json` — resolve tail conflicts by keeping both. Locale namespace
**`vitalsBay`** (pinned 2026-09-01); `opdVitals` belongs to the older `/opd/vitals` and is not touched.

## 1. Why this phase

VD-1 shipped six HTTP routes, five realtime names and migration `0049` for a screen that does not
exist. The signed-off design (`docs/design/2026-08-31-vitals-desk/bay-one.html`) and the seven demo
stories in `2026-08-31-EXECUTE-PROMPT-vitals-desk.md` are the contract: *"if those seven run without
narration, the phase series is done."* Today **zero of seven** run. The registration series found the
rail-with-no-consumer pattern three times; this phase starts by counting the consumers (§2) so that
every task ships a rail **with** the screen that reads it.

## 2. Spike — measured before authoring (inline, 0 subagents)

Re-run these rather than trust them (RC-3 §5.3 is what an unre-measured rails table costs).

| rail (VD-1) | server | web consumers | command |
|---|---|---|---|
| `GET /opd/bench` → `BenchRow[]` (token, seq, doctor, patient summary, benchState, recallAt, recallDue, vitalsDone, vitalsId, escalation, cancelMsRemaining) | `bench.ts:46` · `opd.queue.read` | **0** | `grep -rl "opd/bench" apps/web/src` |
| `POST /opd/visits/:id/bench-state` `{state, restMinutes, note}` | `bench.ts:170` | **0** | `grep -rl "bench-state" apps/web/src` |
| `GET /opd/visits/:id/prestage` → band, required, notRoutine, last, carryCandidates, expectedFlags | `prestage.ts:49` · `opd.vitals.history.read` | **0** | `grep -rl prestage apps/web/src` |
| `GET/POST …/escalation{,/recheck,/escalate,/cancel}` | `escalation.ts:71` | **0** | `grep -rl escalation apps/web/src` (1 hit: `alerts-bell.tsx`, unrelated) |
| `POST /opd/vitals/:vitalsId/amend` (+`reason`) | `vitals.ts:319` | **0** | `grep -rl amend apps/web/src/lib apps/web/src/screens` |
| `POST /opd/visits/:id/vitals` with `readings{takes,source,held}`, `contextChips`, `carriedForward`, `emergency`, `overrides`, `unlockReasons` | `opd-visits.controller.ts:88–128` | **0 send the detail body** — `opd-vitals.tsx` posts scalars only | `grep -n "readings\|carriedForward" apps/web/src/screens/opd-vitals.tsx` → 0 |
| realtime `vitals.recheck_demanded`, `queue.escalated`, `queue.escalation_cancelled`, `bench.state_set`, `vitals.amended` on `queue:<doctorId>:<date>` | `realtime.ts:22–29` | board subscribes to the topic (`opd-desk.tsx:297`) but **renders none of the five** | `grep -c "escalat" apps/web/src/screens/opd-desk.tsx` → 0 |
| valve pill: `waitingCount`, `waitingVitalsCount` | `GET /opd/queues/summary` | 5 screens, **none the bay** | already typed as `WireDoctorSummary` |

Also measured: **S1 — no route resolves a token number or a UHID to a visit** (`visitsQuery` has
neither; RC-4 F7(A)). It is not needed: `BenchRow` carries `tokenNo` and `patient.uhid`, so **all
three doors resolve against the bench list the bay already holds** — a patient who is not on the
bench is not the bay's to take (the design's own line: *"check the slip, or send them to the front
desk"*). **S2 — the slip's barcode is the patient QR payload** (`token-slip.tsx:14 qrPayload`, verified
by `POST /patients/qr/verify`); a keyboard-wedge scan lands in the same input as a typed token.
**S3 — `opd_config` has no capture-lane column and must not get one**: the serial lane is a fact
about a bay's device rack, not the hospital (D4). **S4 — the web types `WireBenchRow`, `WirePreStage`,
`WireEscalation` do not exist**; each is declared in `opd-api.ts` in the PR of the task that reads it
(the `feeStatus` lesson: a rail typed by nobody is read by nobody). **S5 — to measure at T3, not
assume:** whether `recordVitals` with a danger reading itself demands the recheck or the bay must
call `escalation/recheck` first (`vitals.ts:171`, `escalation.ts:158`). **S6 — to measure at T4:** what
`amendVitals` returns — if not the `changedFields` diff, the bay computes it from the two rows.

## 3. Design decisions — DECIDED here, not escalated

- **D1 — Bay One is a NEW route, `/opd/vitals/bay`, appended; `/opd/vitals` stays untouched.**
  Deleting a shipped screen is the same class of act as RC-4 T5 and is listed with it in the lane
  scope doc. Nav row *Vitals bay* under `opd.vitals.record` in `opd/manifest.ts`. `Alt+V` keeps its
  target until the old screen goes; the bay, like the seat, claims no navigation chord.
- **D2 — Three doors, ONE input, resolved on the bench.** Scan / token / UHID all land in the same
  field; a QR payload is verified, a number matches `tokenNo`, an alphanumeric matches `patient.uhid`.
  No new server rail (S1). A miss says *not on this bench*.
- **D3 — The screen mirrors the gates; the server is the authority.** 409 `vitals_gate` /
  `carried_value_locked` / `escalation_window_closed` render as the override / unlock / too-late
  dialogs, never as errors. Client mirrors exist so the typist is stopped *before* the round trip.
- **D4 — The serial toggle is per-bay device state, OFF, no migration.** Stored in `localStorage`
  under `vitalsBay.lane`; the driver seam is a `DeviceDriver` interface with one `NullDriver`. The
  keys-vs-device score is **already on the wire** as `readings[*].source` (VD-1 D1), so telemetry is
  a count of what was saved, not a new store.
- **D5 — The countdown is cosmetic and never repaints the tiles.** `cancelMsRemaining` comes from the
  server on every bench read; the tick updates one text node (ruling 1's parenthesis).
- **D6 — Amend works on a COPY.** The saved chart is fetched, edited in a copy, and posted with a
  reason; Escape discards the copy and nothing else. The diff shown is the server's if S6 returns
  it, else computed from the two rows and asserted equal to `changedFields`' contract.
- **D7 — A `notice` flag renders as a notice.** A paediatric fever reaches the doctor ahead of the
  call and never bricks the tile (VD-1 F1). The test uses `38.4`, not `37.2`.
- **D8 — Two patients in every assembly test.** RC-3's lesson: a component proves nothing about the
  screen that mounts it; every task's closing assertion drives the ASSEMBLED bay through two people.
- **D9 — Inside the alias layer.** The bay carries `data-seat="vitals-bay"` and a block in
  `styles.css` beside `[data-seat="registration-counter"]` sharing its tokens; Radix portals escape
  the layer (RC-3 §7) and the bay uses none for anything the nurse reads.

## 4. Tasks — one PR each, rail + consumer together

### T0 — CRITICAL · the review VD-1 is owed
One fresh read-only reviewer (§9.7 brief), pointed **first at the escalation seam** (where cancel
meets the save path) **and the gate-override paths**, then at `bench.ts`/`prestage.ts`. Verdicts land
as findings; each fix is its own commit inside the task whose file it touches, or a T0 remediation
PR if none. **Done when:** the findings list is in this doc's CLOSE and every CRITICAL/MAJOR has a
commit or a written reason.

### T1 — CRITICAL · identity and the bench (story 1)
Route, nav row, `vitalsBay` keys (en + hi, parity pinned by `lib/i18n.test.ts`), the alias block
(D9), `WireBenchRow` + `fetchBench` (poll 5 s + `useRealtime` on the bench's doctor topics), the
valve pill from `queues/summary`, the one-input three-door identify (D2), and pre-stage on identify
(`WirePreStage`, `fetchPreStage`) into the session column. Caddyfile pin +1 **taken at rebase**.
**Done when:** two patients enter by three doors, each pre-staged, and clearing the desk carries
nothing to the next (revert pair on the clear, and the test must go red — RC-4 R21).

### T2 — CRITICAL · the capture core (stories 2, 5, 6)
Tiles, the typing lane (⏎ commits and jumps, `1`–`8` address a field, lead-vital autofocus, key
counter), band from pre-stage (required / notRoutine / MUAC zones / BP not routine under 5),
carried-forward height locked with the preset unlock reasons, the four gate mirrors with the 409
override dialog, context chips, emergency save trimming to BP + pulse + SpO₂, `POST …/vitals` with
the full detail body, and the **bold ✓** naming who was saved and which doctor's board — the bench
row wears the same tick. The serial toggle (D4), shipped OFF. **Done when:** an adult set is taken
by keyboard only; a 4.8 kg adult and a 45 % SpO₂ are held; a 4-year-old flips the band; `38.4` on a
child reaches the doctor as a notice; two patients, no bleed.

### T3 — CRITICAL · escalation and rest-and-recheck (stories 3, 4)
Answer S5 first and record it. Danger reading → brick tile → other-arm recheck demanded (rest refused
at danger numbers) → confirm → `escalate` → class 0, the 10-second cancel (D5), `cancel` inside the
window and the 409 past it. Rest-and-recheck: `bench-state resting` with `restMinutes`, the recall
time lit on the bench, `recallDue` rows that cannot be walked past, `away` holding a turn, both
takes posted as a pair in `readings.bp.takes`. **The doctor-board flash** is one change in
`opd-desk.tsx`: render `queue.escalated` / `queue.escalation_cancelled` on the topic it already
holds. **Done when:** 208/126 → 214/132 bumps to class 0 and cancel within 10 s restores the class;
an elevated reading rests, recalls and lands as a pair; `Save & send NOW` saves three vitals.

### T4 — ROUTINE · amend after save (story 7)
✓ row → chart re-opens on a copy (D6) → `POST /opd/vitals/:id/amend` with reason → field-level
diff beside the old value with name and clock → board refreshes on `vitals.amended`; Escape abandons
untouched. **Done when:** an amended weight shows both values and the doctor's board re-read; an
abandoned amendment leaves the row byte-identical.

### T5 — ROUTINE · the seven stories as ONE assembly, and the contract pass
One vitest file drives the assembled bay through all seven stories in order with two patients
(D8) — the assertion the wiring lessons owe (§5A.3). Then the instrument that found VD-1's F1:
**read the EXECUTE prompt's rulings and stories clause by clause against the shipped screen**
(handoff §7) and log each clause as met / not met with a line. **Done when:** the file runs alone
green first, then in the full web suite; every clause has a verdict.

## 5. Verify, per task and at close

```
pnpm typecheck && pnpm lint
pnpm --filter @hmis/web exec vitest run src/screens/vitals-bay.test.tsx src/lib/i18n.test.ts src/lib/keyboard.test.tsx
pnpm --filter @hmis/core exec jest -w 2 src/modules/opd/bench src/modules/opd/escalation src/modules/opd/vitals src/modules/opd/prestage   # only if T0 touches core
```
A new test file runs **alone** before joining a batch. `tools/lane.sh status` before any full core
run; never alongside another lane's. CI is the full-suite instrument. Close: method §5A only — two
review passes (pass 2 briefed at the fixes), the revert on every guard, counts pasted not remembered.

## 5. CLOSE — 2026-09-02, code-complete, NOT deployed

**Tip: PR #15 (`lane/front-desk-vd2-t5`), the stack's merge unit.** T0–T5 done; both review
passes run and remediated (§5.5, §5.6); code-complete, NOT deployed. Task PRs #8 (T1) · #9 (T0) · #10 (T2) · #12 (T3) · #14 (T4) stay as the per-task
record; three went DIRTY on the seat census after 17c T1/T2 merged and #15 carries main merged in.

### 5.1 T0 — the review VD-1 owed (one fresh reviewer, 138k tokens): 0 CRITICAL, 6 MAJOR, 6 MINOR

| # | finding | fix (`edad1f5`) | revert pair |
|---|---|---|---|
| F1 | amend skipped the carried lock and gated against the row being replaced | `carryIn` + `checkCarriedLock` on amend; gates against `lastActiveVitalsBefore` | R4, R5 red |
| F2 | amend: a NOTICE set `dangerFlagged`, a revealed DANGER moved nothing | the record path's rule on amend: dangers move the board + `vitals.danger_flagged`; notices do not | R6 red |
| F3 | a carried key with no number wrote NULL under carried provenance | the server carries the predecessor's number in; nothing to carry from → `carried_value_locked` | R7 red |
| F4 | the same body twice was a "double confirm" | the recheck's reading rides its event; a replayed escalate is refused | R11 red |
| F5 | cancel un-bumped a CHARTED danger, reporting `restoredClass: 0` | `danger` stays exactly when `escalatedFromClass === 0` | R12 red |
| F6 | `vitals_desk` could record a confidential patient's chart and not amend it | amend reads the encounter as record does | R8 red |
| MINOR | bench state never cleared by a save · `emergency` dropped on amend · `ageYearsAt` in UTC | fixed | R9, R10, R13 red |

**Not fixed, recorded:** the cancelled-entry predicate suppresses a LATER new danger on the same
entry (D4 says `cancelled` is terminal; the state table or the code is wrong — RC-6/VD-3); the
carried lock is opt-in (omit `carriedForward` and any height inside 3 cm passes); `GET
…/escalation` has no read gate (an existence oracle under `opd.vitals.record`); `setBenchState`
accepts non-`waiting_vitals` entries.

### 5.2 The contract pass — the owner's nine rulings against the shipped screen

| ruling | verdict |
|---|---|
| 1 auto-bump with 10-s cancel; one reading only demands | **met** (T3; T0/F4 makes "double" mean two readings) |
| 2 serial toggle shipped OFF, gates identical in both lanes | **met** (D4; the device lane commits through the same `commit`) |
| 3 ⏎ commits and jumps, 1–8 address, lead-vital autofocus, no click-before-type | **met after T5** — 1–8 was NOT built until the pass |
| 4 amend from the bench row, old value in the trail with name+clock, abandon untouched | **met** (T4) |
| 5 three doors, identical lane | **met** (T1) |
| 6 bold ✓ naming who and which board; tick on the row | **met** (T2; row state `done`) |
| 7 Desk One identity | **partly**: alias-layer colours yes; **Plex type trio NOT in the alias layer** (RC-3's block carries colours only); **footer agent bar, F2, log, in-sight cards = RC-6**, not built; Ctrl+K is the global palette; Esc discipline met; bench rail always on screen met; tiles not a form met |
| 8 pairs never averaged · BP not routine <5 · MUAC required <6 · weight never spoken · emergency = BP+pulse+SpO₂ · sub-75 SpO₂ held · RR nudge + 15-s counter · rest for elevated maybes only | **met after T5** — the RR nudge was NOT built until the pass; "weight never spoken" is a bay-side practice the screen cannot enforce; the patient display is untouched |
| 9 English leads staff screens, Hindi to the patient, dates `31-Aug-2026` | **met after T5** for dates; the say-this Hindi lines are the agent surface (RC-6) |

### 5.3 Evidence at close, before the review passes

| instrument | result |
|---|---|
| web full `vitest run` | **74 files / 546 tests, exit 0** (T1 69/511 · T2 70/522 · T3 71/529 · T4 72/534 · T5 74/546); **after pass 1's remediation 74 / 554** |
| core `jest -w 2` on `hmis_lane_front_desk` (T0): vitals, vitals-gates, escalation(+concurrency), time, bench, prestage, opd.e2e, opd-lifecycle.e2e | **10 suites / 90 tests, exit 0** |
| `pnpm typecheck` · eslint over every touched file | exit 0 · clean |
| locale parity en/hi | `lib/i18n.test.ts` green in every run |
| revert pairs | **R1–R40**: 36 red on first run; **R2 could not fail through Escape** (RC-4 R26's shape — a sibling-release test now drives the road, red); **R28 equivalent** (replaced by a fake-timer countdown test + R28', red); **R33, R34 equivalent on the assembly** (recorded, guards kept) |
| assembly-render ratio (§5A.3) | every screen test mounts the whole bay; the seven-story file drives it end to end with five patients |
| migrations · permissions · hub exports | 0 · 0 · 0 |

### 5.4 Cost
Session balance at kickoff (docs PRs done) 14,918k · T1 done 14,913k · T0 done 14,859k · T2 done
14,798k · T3 done 14,749k · T4 done 14,725k · T5 done 14,682k. **Coding T0–T5 ≈ 236k of the 885k term**
(the measured seams in the phase doc's spike table did that, as RC-4's handoff did for T2+T4).
Reviewers: T0 138k · pass 1 A 217k + B 175k · pass 2 below. Session balance after the pass-1 remediation 14,570k; **phase total so far ≈ 350k main + 530k reviewers ≈ 880k of 1,470,000 (60%)**.

### 5.5 Pass 1 — two fresh reviewers over the green tree: 3 CRITICAL, 11 MAJOR — for the fifth phase running

**Every CRITICAL was in the assembly or at the permission boundary, none in a component.**

| # | finding | fix (`4c3bfe0`) | revert pair |
|---|---|---|---|
| **C1** (B) | the bay mirrored its band and gates from `GET /opd/config` = `opd.masters.read`, which `vitals_desk` does not hold: every mirror and the whole other-arm protocol were silently unreachable **for the one role that works the bench** | the limits travel WITH the pre-stage (`ranges`, `noticeRanges`, `gates`, `muacBands`); the doctor filter is built from the bench (no `GET /opd/departments`); the tests answer 403 to both masters routes | R53 red |
| **C2** (A) | `restOffer` survived `clearDesk`: A's elevated BP offered as B's rest and held under B's encounter | cleared with the desk and on every take | R41 **equivalent** (`take()` clears it too) |
| **C3** (A) | a hypoxic patient could never be charted, never reached the protocol, could not be sent NOW — the probe hold had no confirm | "It is real" charts the value with `overrides.spo2`, offers it to the protocol, the holds stay in the log | R42b red |
| M1 (A+B) | amend posted nine flat scalars: the active row lost the pair, held values, device source, notes; a carried key could not be unlocked; a gate dead-ended | `amendedReadings` (operative take replaced, the rest kept), notes/chips/carried keys ride along, a changed carried key asks a preset reason, a gate is confirmed, a stale copy refused | R48 R49 R50 red |
| M2 (B) | T0/F6 unreachable from the screen: the amend read went through `listVitals` = the confidential gate | `GET /opd/vitals/:id` under `opd.vitals.record`, gated as the amend is, PHI-logged | R57 red |
| M3 (B) | a sealed four-year-old was captured on the ADULT tile set (pre-stage refused) | the pre-stage answers the BAND with the history sealed | R52 red |
| M4 (A+B) | "double-confirmed" across different vitals; a calm second arm left `recheck_demanded` for the rest of the day; the replay guard bypassed by any changed vital | same vital re-measured; a calm arm WITHDRAWS (`none`, `vitals.recheck_withdrawn`); replay judged on the demanded vitals | R54 R55 R56 red |
| M5 (B) | a recheck accepted after a named human's cancel | the screen asks the nurse to re-run; the server stays permissive (recorded) | R45 red |
| M6 (A) | the session header printed a restricted patient's UHID | masked | R43 red |
| M7 (A) | a save in flight was not guarded: a late landing cleared the next patient | a save holds the desk; a landing after the desk moved on clears nothing | R46 red |
| M8 (A) | a chip un-clicked posted as NO | asked (yes/no) or not asked | R47 red |
| M9 (A) | the held first take is one tab's `sessionStorage` | **NOT FIXED** — server truth needs a column on the entry (the bench note lives only in the event); VD-3, a migration | — |
| minor | flash follows the picker · held-only `takes: []` · "other arm" for a thermometer · second arm typed before the demand answers | fixed / fixed / fixed / `protocol.busy` guard | R51 red |

**The instrument that found the most:** reviewer B read the ROUTES' permissions against the ROLE. Nothing in 40 revert pairs and 546 green tests could see C1, because every test stubs the config route and no test logs in as the role.

**Assertions pass 1 named as in-band under both behaviours, now replaced:** the calm-arm test asserted only "no escalate call"; the rest test never asserted the offer absent under the next patient; the amend test seeded `readings: {}`; the restricted test checked the UHID only on the bench row; the chip test clicked once.

### 5.6 Pass 2 — briefed at the fixes (one fresh reviewer, 181k): 9 CORRECT, 3 INCOMPLETE, ONE WRONG road

**The WRONG one was in pass 1's fix for the calm arm:** routing EVERY ranged take to `escalate`
while the other arm was demanded made a thermometer take answer *"that is the first reading
again"* — the server's own replay rule, painted red under the wrong tile. A defect the shipped code
did not have. Now only the DEMANDED tile's next take, or a danger on another vital, is the other arm.

| # | pass-2 finding | fix (this commit) | revert pair |
|---|---|---|---|
| F1 MAJOR (WRONG) | every ranged take posted as the confirm while demanded | only `demandedKey` or a danger take confirms; a calm undemanded take is a take | R58 red |
| F2 MAJOR | the chart a confirmed 68 % SpO₂ produces could not be amended (the hold re-held it, `vitals_incomplete`) | the server gates only what CHANGED on an amendment: a value the prior row charted carries an `unchanged_on_amend` override | R63 red |
| F3 MAJOR | a different vital refused with no exit: the bench said "other arm" for the rest of the visit | a new vital WITHDRAWS the old demand and is demanded itself (two events, state stays `recheck_demanded`, the new flags on record) | R61 red |
| F4 MAJOR | after "it is real" the probe hold was OFF for every later take — a slip to 40 charted | the hold judges every NEW take; the confirmed value alone is exempt | R59 red |
| F5 MINOR | a demanded key OMITTED from the confirm made a copied cuff reading "new" | an omitted demanded key counts as unchanged | R62 red |
| F6 MINOR | a genuine other arm identical on every demanded vital is refused | **DECIDED: fails closed, a third take clears it** | — |
| F8 MINOR | the landing guard compared a click-time closure with its own row | reads the current in-hand through a ref | (guarded by `saving`, no test can reach it) |
| F9 MINOR | dead chart invalidation | prefix invalidation | — |
| F10 MINOR | `demandedKey`/`calmed` reset on a refetch | reset with the PATIENT, the view with the patient AND the answer | R60 red (the first cut reset neither, and two suites went red) |
| F7 / F11 | the amend-open log's `sealed` reads `restricted`, not `isConfidential`; the amend header claimed overrides ride along | recorded (§7), comment corrected |

**Assertions pass 2 named in-band, and the honest answer:** the rest-offer "no bench-state call"
lines cannot discriminate (nobody presses rest under either code) — the discriminating line is
`rest-offer` absent under the next patient, which is asserted; the saving test's `session-empty`
is in-band, the take-refusal line is the kill; the amend fixture's `heightCm: { takes: [] }` is a
stub shape no real row produces.

### 5.7 Evidence after both passes

| instrument | result |
|---|---|
| web full `vitest run` | **74 files / 555 tests, exit 0** |
| core `jest -w 2`: prestage, escalation(+concurrency), vitals, vitals-gates, bench, realtime, opd.e2e | **9 suites / 84 tests, exit 0** |
| `pnpm lint` · `pnpm typecheck` | 0 errors (2 warnings in other lanes' kernel tests) · exit 0 |
| revert pairs, whole phase | **R1–R63**: 57 red on first run; R2 re-cut and red; R28 replaced (R28' red); R33, R34, R41 equivalent on the assembly; R42 label-only |
| review cost | T0 138k · pass 1 392k · pass 2 181k = **711k** against the 543k term (31% over — a third reviewer was needed by C1 alone) |
| migrations · permissions · hub exports | 0 · 0 · 0 (one new OPD route, `GET /opd/vitals/:id`, under an existing permission) |

**No pass 3.** Pass 2's four MAJORs are fixed with their roads as tests and six new revert pairs;
the method's two passes are run. What a third pass would look at is recorded: F1's road (a calm
take on an undemanded tile) is the seam where the two remediations met.

## 7. Findings deliberately NOT fixed in this phase — each verified, each with its reason

1. **The held first take is the bay's, not the server's** (pass 1 M9). A recall at another bay or after a closed tab lands the second reading alone; the first reading survives only in the `bench.state_set` event's note. Server truth needs `held_reading` on `opd_queue_entries` — a migration, VD-3.
2. **The cancelled-entry predicate** (T0 MINOR): `recordVitals` never sets board danger on an entry whose escalation is `cancelled`, so a LATER new danger on the same entry moves nothing unless the nurse re-runs the protocol (which the bay now offers). D4 says `cancelled` is terminal; the state table or the code is wrong.
3. **The carried lock is opt-in** (T0 MINOR): omit `carriedForward` and any height inside 3 cm passes. The bay always declares its carries.
4. **`GET /opd/visits/:id/escalation` has no read gate** (T0 MINOR): an existence oracle under `opd.vitals.record`.
5. **`setBenchState` accepts non-`waiting_vitals` entries** (T0 MINOR).
6. **Desk One's type trio is not in the alias layer** (contract ruling 7): RC-3's block carries colours only; a decision for the seat series, not this bay.
7. **The agent surface** (footer bar, F2, log, in-sight cards, say-this Hindi lines) is RC-6's.

## 6. OWNER ITEMS
1. **Procurement** — the serial-device ledger (₹70,960/bay serial vs ₹16,110 manual); the bay ships with the lane OFF and the driver seam stubbed.
2. **Deletion of `/opd/vitals`** now that the seven stories run — in the lane scope doc beside RC-4 T5. Recommended: delete, one edit, route pin −1.
3. **Merge order** — PR #15 (`lane/front-desk-vd2-t5`) is the stack's merge unit; #8/#9/#10/#12/#14 are the per-task record and conflict with main on the seat census.
