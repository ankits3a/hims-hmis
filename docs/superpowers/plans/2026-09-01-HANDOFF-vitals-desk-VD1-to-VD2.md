# HANDOFF — Vitals Desk ("Bay One"): VD-1 is done, VD-2 is not started

**Written 2026-09-01 by the VD-1 executing session, at its context limit.**
Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis`.

---

## 0. Read these, in this order, before touching anything

| # | what | where |
|---|---|---|
| 1 | **This file, to the end.** | you are here |
| 2 | The phase document + its CLOSE (findings, decisions, evidence) | `docs/superpowers/plans/2026-08-31-phase1-vd1-vitals-rails.md` |
| 3 | The recon that opened the series — what was already wired vs ruling-only | `docs/superpowers/plans/reports/2026-08-31-vitals-desk-recon.md` |
| 4 | The owner's brief for the whole seat, incl. the **seven demo stories** that are the contract | `docs/superpowers/plans/2026-08-31-EXECUTE-PROMPT-vitals-desk.md` |
| 5 | **The signed-off design — open it and walk all six bench stories** | `docs/design/2026-08-31-vitals-desk/bay-one.html` |
| 6 | Rules every coding agent holds | `docs/superpowers/AGENT-RULES.md` |
| 7 | Method — one doc per phase, LIGHT lane, stop-loss, §9.9's verify economy | `docs/superpowers/EXECUTE-METHOD-V3.md` |
| 8 | The ledger — **cite BY NUMBER, never point an agent at the file** (§9.1 rule 1) | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` §2.152–§2.155 |

**Do NOT re-derive the recon.** §3 of it lists what was ruling-only and is now built.

---

## 1. State in one paragraph

**VD-1 (the server rails) is CODE-COMPLETE, pushed, and green.** Six commits, fifteen mutants built
and dead, migration `0049_vitals_bay` applied. **VD-2 (Bay One, the screen) has NOT been started.**
Two things are outstanding and **both are the owner's to authorise**: the phase's **independent
review**, and **starting VD-2**. Nothing is deployed — production has never left `commissioning`
and the owner holds every deploy.

### Proved at handoff time, not remembered (method §9.6)

§9.6 orders a handoff's budget: **typecheck, then the narrowest suite, then the prose** — because
*"green as of `<suite>`, exit value read from a file"* is worth several pages about intent, and
because **uncompiled, unrun code is UNKNOWN code however confident its description.** Both were run
against the CURRENT `main` (`8f3dbcb`), after three other lanes had advanced it:

```
pnpm typecheck                                    exit 0   (whole workspace)
VD-1's seven own suites, hmis_vd_scratch:
  vitals · vitals-rules · vitals-gates · escalation · escalation.concurrency · bench · prestage
                          7 suites / 53 tests passed, EXIT 0
```

Migration `0049_vitals_bay` present; `escalation.ts`, `bench.ts`, `prestage.ts`, `vitals.ts`,
`vitals-rules.ts` all on HEAD. **So VD-1 is not merely committed, it still works on the tree you
will inherit.**

## 2. What shipped, commit by commit

| commit | task |
|---|---|
| `962f3be` | **T1** — the reading model: `readings` jsonb (takes + source + held), MUAC, `notRoutine`, emergency set, carried-forward. Migration `0049_vitals_bay`, 14 additive columns |
| `41a04b2` | **T2** — the four sanity gates, server-enforced; **plus the bill-first `unknown_queue_entry` guard** (RC-1's close reviewer found it; the mutant was `962f3be`'s own code) |
| `4974a48` | **T3** — the danger protocol: `none → recheck_demanded → escalated → cancelled`, the 10-second compensating cancel |
| `10b37d0` | **T4 + T5** — bench states + recall, the pre-stage reader + `opd.vitals.history.read`, the six HTTP routes, `amendVitals` |
| `a50e68a` | the twelve census pins one permission moves (see §6 — this one left `main` red) |
| `59e5943` | **F1** — a paediatric fever reached nobody; flags gain a `severity` the queue does not obey |

## 3. The design decisions VD-2 must not relitigate

All are in the phase doc §3 with full reasoning. The five that constrain the screen:

- **D1/D2 — a rest-and-recheck PAIR is ONE row with two takes; an AMENDMENT is the NEXT row**
  naming its predecessor. Both produce "two readings" and nothing could tell them apart otherwise.
  The scalar columns carry the **operative (last) take**, so every shipped reader stays correct.
- **D3 — the bench lives on the queue entry** (`bench_state`, `recall_at`), the row stays
  `waiting_vitals`, and the turn is the `seq` it already has. `recallDue` is DERIVED on every read.
- **D4 — cancel moves the BOARD and never the CHART.** `encounters.danger_flagged` and
  `vitals.danger_flagged` fire on every danger reading and nothing can unset them; cancel reverts
  `queue_entries.danger` only, and only for a named human inside ten seconds.
- **D8 — the cancel window is `escalated_at + 10s`, a stored instant compared against the clock.**
  Never a server timer. **The countdown is the SCREEN's and is cosmetic** — the server refuses a
  late cancel with the countdown still painted.
- **F1 — flag `severity`**: `danger` moves the queue, `notice` reaches the doctor and does not.
  A paediatric fever (≥38 °C under 13) is a `notice`. **Rendering a notice as a danger on the
  screen would undo the whole point.**

## 4. The server surface VD-2 consumes

```
POST /opd/visits/:id/vitals            opd.vitals.record   + readings, contextChips,
                                                             carriedForward, emergency,
                                                             overrides, unlockReasons
POST /opd/vitals/:vitalsId/amend       opd.vitals.record   + reason
GET  /opd/bench                        opd.queue.read      ?departmentId &doctorId &serviceDate
POST /opd/visits/:id/bench-state       opd.vitals.record   { state, restMinutes, note }
GET  /opd/visits/:id/prestage          opd.vitals.history.read
GET  /opd/visits/:id/escalation        opd.vitals.record
POST /opd/visits/:id/escalation/recheck    opd.vitals.record  (the reading; server judges it)
POST /opd/visits/:id/escalation/escalate   opd.vitals.record  (requires recheck_demanded)
POST /opd/visits/:id/escalation/cancel     opd.vitals.record  (inside 10 s, else 409)
```

**Status contract the screen must honour:** `vitals_gate`, `carried_value_locked` and
`escalation_window_closed` answer **409**, carrying `detail.gates[]` / `detail.locked[]` — they are
CLINICAL REFUSALS the seat renders as an override dialog, not malformed requests. `409` also on
`escalation_state_conflict`; `400` on `vitals_incomplete` and `invalid_bench_state`; `404` on
`unknown_*`.

Realtime names already registered (they route on `queue:<doctorId>:<serviceDate>`):
`vitals.recheck_demanded`, `queue.escalated`, `queue.escalation_cancelled`, `bench.state_set`,
`vitals.amended`.

## 5. VD-2 — what is left to build

The seven demo stories in the handoff (§0 row 4) are the contract. **Six of the seven are screen
work; the rails for all of them exist.** From the original build list:

- **A · Identity & the bench** — three doors (barcode = keyboard wedge into the same field as a
  typed token/UHID; no separate scanner stack), the always-on bench rail with `waiting · resting
  (recall) · away · in-hand · done`, the valve pill (`GET /opd/queues/summary` already returns
  `waitingCount` + `waitingVitalsCount` — no new server work), the bold-✓ save confirmation.
- **B · The capture core** — tiles not a form; the typing lane (⏎ commits and jumps, 1–8 address
  fields, per-patient lead-vital autofocus, keystroke counter); client-immediate mirrors of the
  gates whose authority is the server.
- **C · Escalation UI** — the brick tile, the demanded other-arm recheck, the 10-second countdown
  (cosmetic — see D8), the doctor-board flash.
- **D · Amend** — re-open from a ✓ bench row, render the field-level diff, Esc abandons untouched.
- **E · The serial seam** — the lane toggle as config, a device-driver interface **stub**, and
  keystrokes-vs-device-reads telemetry. **The real drivers are a later phase; build the seam.**

**The procurement ledger (₹70,960/bay serial vs ₹16,110 manual) is the owner's and stops for them.**

## 6. Live hazards — read before your first commit

**Three coding lanes share this checkout** (`/opt/hmis`): VD (this one), RC-3 (registration
counter, session `hmis-62`), 18a (radiology, session `hmis-d9`). There is no isolation except your
scratchpad. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` is the protocol
and is short.

1. **`git commit` commits the INDEX; a PATHSPEC commits the WORKING TREE — and neither protects you
   from a peer's uncommitted edits to a file you name.** (§2.152 + its amendment.) This lane broke
   that rule ninety minutes after writing it: `a50e68a` swept the RC-2 lane's edits to
   `seed-roles.test.ts` and the STAT looked right. **Run `git status --porcelain -- <path>` per path
   IMMEDIATELY before committing, and grep your added lines for peer-owned tokens.**
2. **A permission moves TWELVE censuses**, seven of them bare integers in
   `test/seed-roles.test.ts` — a file you will have already edited. **Grep tells you where to edit;
   only the run tells you what you broke** (§2.155). If VD-2 mints a permission, budget a full core
   pass at that task's boundary and do not defer it.
3. **`apps/web/src/locales/{en,hi}.json` is a census too.** `lib/i18n.test.ts` flattens both to
   dotted key paths and `toEqual`s them, so a key added to English alone fails loudly. **VD-2 will
   add a large block here and RC-3 is editing the same files** — agreed protocol: announce your
   top-level namespace, and check `git status --porcelain -- apps/web/src/locales/` before
   committing either.
4. **The test slot.** One jest run on the box at a time; ask the other lanes before a full pass and
   say when you are off. **Never run `pnpm verify`** — it starts core's jest and web's vitest
   concurrently and OOM-kills on this 15.6 GB box. Two sequential commands, exit value read from
   each. `maxWorkers: 2` is now pinned in `apps/core/jest.config.cjs` (owner ruling, §2.151).
5. **Never `pgrep -f` / `pkill -f` with a pattern your own command line contains.** This lane did it
   three times in one day — once killing its own shell, once matching every session on the box, and
   once parking a guard for 7½ hours on `until [ $(pgrep -c -f jest-worker) -eq 0 ]`, which counts
   itself and can never reach zero. Use `ps -eo cmd | grep -c '[j]est-worker'`, or kill by PID.
6. **A new test file runs ALONE before it joins any batch.** This lane put a never-executed suite
   into a batch and cost a peer lane an hour. Cheap, and non-negotiable.

## 7. The instrument that found the most, per minute spent

**Read the signed-off contract clause by clause against the shipped code.** It found F1 — a
paediatric fever that reached nobody — behind fifteen dead mutants and 3,327 green tests, in about
ten minutes. The 18a lane used the same technique the same day and found two defects behind 343
green tests and thirty dead mutants.

**Why the tests could not see it, and this is the durable half:** every assertion touching
paediatric temperature used `37.2`, which is in band under the right rule and the wrong one alike.
**An assertion that cannot distinguish the two behaviours is not a test of them.** When VD-2 closes,
do this pass before declaring anything done.

## 8. What is owed, and by whom

- **The independent review of VD-1 — OWNER-AUTHORISED, NOT RUN.** The executing session may not
  spawn agents unless the owner asks. Every phase on this project since 09a has had its reviewers
  find a CRITICAL or MAJOR over an already-green tree (16a: three CRITICAL patient-safety defects
  behind eleven green verifies and fourteen dead mutants). **Point it first at the escalation seam
  — where cancel meets the save path — and the gate-override paths.**
- **VD-2 — not started, awaiting the owner's word.**
- **Nothing else.** VD-1's own evidence is discharged; the phase doc's CLOSE carries the numbers.

## 9. Two corrections this lane owes the record, so you do not inherit them as fact

- The relay note `reports/2026-09-01-radiology-five-suites-red-on-main.md` was **written by this
  lane and has since been CORRECTED by the 18a lane** — the cause was a calendar bomb in a test
  helper (`placedAt` unset, so real wall clock vs fictional `now`), fixed at `f449f70`. **Read the
  CORRECTION section, not the body.** Its surviving hypothesis was wrong.
- That report claimed two failing cases collided with "the same order `R2608310001`". **They did
  not.** `truncateAll` uses `restart identity`, so every test's first order is `R2608310001` — two
  different orders sharing a number. **An identifier that restarts is not an identity**, and this
  lane read a coincidence as a join.

## 10. First move for the new session

1. `git pull --rebase origin main`, then `git log --oneline -5` — other lanes commit constantly.
2. Read §0's list. Walk the prototype.
3. Ask the owner which of §8's two open items to start. **Do not start VD-2 without that word** —
   the review is the cheaper thing to do first, because VD-2 is built directly on the escalation
   seam and the gate paths.
