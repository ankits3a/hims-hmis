# Phase VD-2 — Bay One, the vitals desk (Vitals Desk series, 2 of 2)

> **AUTHORED 2026-09-02, NOT APPROVED.** Owner-approving this doc also authorises T0, the
> independent review VD-1 has owed since `59e5943` (handoff §8). **No owner ruling gates this phase**
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

## 6. Owner items (none block the phase)
1. **Procurement** — the serial-device ledger (₹70,960/bay serial vs ₹16,110 manual); the bay ships
   with the lane OFF and the seam stubbed. Nothing here needs the devices.
2. **Deletion of `/opd/vitals`** once T5's seven stories run — listed in the lane scope doc beside
   RC-4 T5. Recommended default: delete, one edit, route pin −1.
