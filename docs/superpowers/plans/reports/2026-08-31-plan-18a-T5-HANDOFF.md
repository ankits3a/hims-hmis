# Plan 18a (Radiology & Imaging core) — HANDOFF at the T4/T5 boundary

**Written 2026-08-31 by the session that executed T2, T3 and T4, because it was running out of
context, not out of work.** Everything below is measured or quoted; nothing is remembered.

**Read this file, then the phase document's §5 T5 and its §9.2 findings. You do NOT need §0–§4 —
the design decisions are settled and this file names the ones T5 depends on.**

Phase document: `docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md`

---

## 0. THE ONE-PARAGRAPH STATE

**T1, T2, T3 and T4 are COMPLETE, PROVED and PUSHED. T5–T9 have not started.** The module places
imaging orders, applies the PCPNDT rule at placement, creates studies from `order.placed` with `X`
accessions, holds a governed study-type book, and runs a diary (schedule / reschedule / no-show /
cancel / walk-in). **A full workspace verify was observed GREEN IN ONE RUN at the T4 boundary: 322
suites / 3 153 tests, `apps/web` 61 / 374, exit 0.** Nothing is deployed; production is at 46
migrations and this phase's `0047` has never left the lane database.

**Start at T5** (check-in, the ten safety gates, screenings, override, readiness).

---

## 1. WHAT IS ON `main` — this session's commits, in order

| commit | what |
|---|---|
| `e9c425c` | **T2** — both manifests installed in `ALL_MANIFESTS` and the worker, 20 permissions, 4 roles, README's sixth table, `imaging_report_ready` |
| `5287d9c` | T2's verify record |
| `74e3079` | **T3** — `placeImagingOrder`, the DD14 applicability rule, the DD9 encounter guard, DD10b's duplicate window, the add-on, the `order.placed` consumer, first mounted controller |
| `5f21d2c` | the full verify green over T2+T3 |
| `7f448a6` | the token audit — ledger §2.146–§2.148, method §9.1 and §9.9 amended |
| `a407719` | **T4** — governed definitions, 20 study-type seeds, the diary, two controllers, `seed:radiology` |
| `620b7c1` | **OWNER RULING** — `seed:radiology` self-publishes |

Two commits in that range are **another session's** (`c0e4a2f`, `7035915`, `1a3ae37` — RC-1 counter
rails and design handoffs). That session is live in this checkout; see §6.

---

## 2. WHAT T5 MUST KNOW BEFORE IT WRITES A LINE

### 2.1 The seams T5 builds on, all measured at T4

- **`imaging_safety_screenings`** exists from T1 (`kernel/db/schema/radiology.ts`) — `ot_case_gates`
  column for column. T5 writes it; nothing does yet.
- **`imagingGateDefinition`** (`workflow-def.ts`) is the gate machine: `open → satisfied | waived |
  overridden`, all three terminal, Class A. **`radiology_receptionist` is deliberately NOT on the
  `open → satisfied` transition** — that is finding F9, and it is asserted in
  `workflow-def.test.ts`. Do not add it back.
- **`IMAGING_GATE_KIND_VALUES`** (kernel schema) is the closed list of ten kinds.
- **The study-type body's flags drive the gate set** (DD7): `ionising`, `contrast_option`,
  `modality === 'mri'`, `pcpndt_applicable`, `chaperone_required`, `laterality_applicable`. The
  `gates` array on each seed is EMPTY on purpose — every gate the twenty types need is derivable
  from those flags, and listing them twice would be two sources of truth. `gates` is the seam for
  the non-derivable kind (an `mlc_check` on an assault protocol, 18c's QA gate).
- **`pregnancy_policy`** has a published zod schema in `definitions.ts` and NO seed yet. T5's
  evaluator reads it; **seeding it is T5's** (or a runbook step) — `seed:radiology` seeds only
  `study_types` today.
- **`requireStudyType(exec, code)`** and **`activeStudyTypes(exec)`** live in `study-types.ts`,
  which is the SINGLE owner of the book (F13 closed). `place.ts` re-exports; do not add a third
  reader.

### 2.2 The three things T5 will trip on if it does not read them first

1. **`test/helpers/radiology.ts` already builds the whole fixture** — patient, four services, the
   published book, the encounter, permissions, the Class-A governance sequence for the
   `imaging_study` definition, and one device per modality. Use `setupRadiologyFixture` and
   `placeAndCreateStudy`; do not build a fifth one.
2. **T3's 24-hour duplicate window is real.** A suite that places the same service for the same
   patient twice is refused `duplicate_recent`. `schedule.test.ts` solves it by giving each
   placement its own instant 25 hours apart (`newStudy()`); copy that rather than passing the
   duplicate override everywhere.
3. **Read a table's required columns BEFORE writing a fixture insert** (ledger §2.146):
   `awk 'NR>=<start> && NR<=<end>' <schema> | grep -E "notNull\(\)" | grep -v default`. This session
   burned four turns discovering `opd_encounters.openedBy` and `imaging_studies`' ABSENT audit
   columns from insert errors. `imaging_studies` also has
   `imaging_studies_image_source_required_ck`: setting `acquired_at` without `image_source` is
   refused.

---

## 3. THE OWNER'S RULINGS THIS PHASE CARRIES

| ruling | date | where it lives |
|---|---|---|
| **`seed:radiology` SELF-PUBLISHES** — reversing T4's recommendation | 2026-08-31 | `620b7c1`; `activateSeededDefinition` in `definitions.ts`, §9.2 |
| The grain of DD23's lab interlock stays at the ORDER GROUP (Plan 17b F45) | 2026-08-30 | `f6a8d95` — not this phase, but the same owner ruling pattern |

**On the seed ruling, the part T5 must not undo:** the seed activates with **`approval_id` NULL**,
which is what keeps a seeded activation distinguishable from a governed one for ever. It does NOT
mint a second system actor to rubber-stamp its own request. `definitions.test.ts` pins the contrast,
so a later "tidy-up" into a rubber stamp fails a test. **The governed publish route is untouched and
is still the only way a human changes the book.**

---

## 4. FINDINGS OPEN AND CLOSED

**Closed by this session:** F9 (the gate separation defect — a role the permission census could not
see, because the workflow engine gates on ROLE KEYS and never consults permissions), F13
(`study-types.ts` owns the book), F17 (this phase's own §2.144 — see below).

**Open, and each names its owner:**

- **F1** — `registerOpdEncounterResolver`'s `V` defect. **FIXED by Lane A** (`getEncounter` now
  accepts a visit number); recorded because F12 depends on it.
- **F10** — there is no `consultant` role; grants went to `doctor`. Decided, recorded, done.
- **F11 / F14** — **FIVE census files** moved by T2 and T3, none in any task's Files list. Three
  found by §2.138's list-grep; `test/seed-staff.test.ts` (derives from `ROLE_MODEL`),
  `worker-runtime.e2e.test.ts` and `seed-cursors.test.ts` (derive from `workerConsumers`) found by
  neither. **Method §9.9 rule 6 now requires a full verify at such a task's boundary.**
- **F12** — spike S2's answer flipped a third time; T3's authorised OPD export was NOT needed.
  `modules/opd/*` is untouched. **Day-care encounter status is read from the kernel schema table**
  because OT exports no status reader; a later phase adding `daycareStatusByEncounterNo` to
  `modules/ot/index.ts` should collapse it.
- **F15** — T4's schema caught T3's fixtures writing study-type bodies that could never have been
  published. **The generalisation: when a task adds a SCHEMA to data an earlier task wrote by hand,
  re-run that earlier task's suites first.**
- **F16** — the seed list came to 21 against DD13's twenty; the seeds were corrected, not the test.

---

## 5. THE VERIFY DISCIPLINE THIS PHASE PAID FOR — follow it

**A full `pnpm verify` was observed GREEN twice**: once over T2+T3 (`5f21d2c`) and once over T4. Both
took more than one attempt, and **every red was diagnosed rather than re-run until green.**

```
# launch detached, exit value to a file (AGENT-RULES 16–18)
rm -f /opt/hmis/.verify.log /opt/hmis/.verify.exit
setsid nohup sh -c 'TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch" \
  pnpm verify > /opt/hmis/.verify.log 2>&1; echo $? > /opt/hmis/.verify.exit' >/dev/null 2>&1 &

# NEVER pass -w through pnpm verify: `pnpm verify -- -w 4` puts the flag on PNPM, where -w is
# --workspace-root, not on jest.
```

**When it comes back red** (method §9.9 rule 7):

```
grep -E "^apps/core test: FAIL" .verify.log | sed -E 's/^apps\/core test: FAIL //; s/ \([0-9.]+ s\)$//' | sort -u > failed.txt
for s in "Exceeded timeout" "deadlock" "SIGKILL" "duplicate key"; do echo "$s: $(grep -ci "$s" .verify.log)"; done
# re-run the failed set ISOLATED, behind a load guard — re-running under the contention that caused
# the failure measures the contention again:
setsid nohup sh -c "until [ \$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1) -lt 5 ]; do sleep 20; done; \
  cd /opt/hmis/apps/core && TEST_DATABASE_URL='postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch' \
  npx jest \$(cat failed.txt | tr '\n' ' ') -w 2 > retry.log 2>&1; echo \$? > /opt/hmis/.retry.exit" >/dev/null 2>&1 &
```

**"None of my suites failed" is a weaker claim than "nothing I changed failed."** At the T3 boundary
two files the task had TOUCHED were in the failure set; at T4, one of the thirteen failures was this
task's OWN test (F17: a race test that rebuilt its whole fixture five times, blew the 15 s budget
under load, and whose abandoned async work then produced a `patients_pkey` collision in the NEXT
test — the fix was to remove work the assertion never needed, not to raise the timeout). **The
targeted batch ran that suite green four times; only the full verify ever saw it fail.**

`.verify.log`, `.verify.exit` and `.retry.exit` are **SCRATCH** — `rm -f` before any `git add`.

---

## 6. THE CHECKOUT IS SHARED — read this before committing

Another session is executing **phase RC-1 (counter rails)** in `/opt/hmis` right now. Its commits in
this range are `c0e4a2f`, `7035915`, `1a3ae37`. Its untracked trees are:

```
docs/design/2026-08-29-opd-counter-flow/          docs/design/2026-08-30-enquiry-counter/
docs/design/2026-08-29-opd-counter-flow-v2/       docs/design/2026-08-30-registration-desk/
docs/superpowers/plans/2026-08-29-EXECUTE-PROMPT-flow3-front-desk.md
docs/superpowers/plans/2026-08-30-DESIGN-PROMPT-enquiry-counter.md
```

**Never stage them.** Read `git status --porcelain` before every `git add`, stage by explicit path,
and `git pull --rebase origin main` before writing. See memory
`concurrent-sessions-shared-testdb` and `parallel-lane-collision-2026-08-29`.

**The lane database is `hmis_lane_b_scratch`** (`setupTestDb` appends `_<JEST_WORKER_ID>`). Name it
in every commit message that cites a count (§2.137). It is deliberately NOT dropped.

---

## 7. T5, IN THE PHASE DOCUMENT'S OWN WORDS

`### T5 — Check-in, the gates, screenings, override, readiness — CRITICAL`

**Files:** `checkin.ts` (`checkIn` — opens the gate set from the active `study_types` body and the
patient), `gates.ts` (`gateState`, `studyGates`, `satisfyGate`, `waiveGate`, `overrideGate`,
`evaluateReadiness` — `ot/gates.ts` transcribed, with per-kind evidence schemas),
`radiology-study.controller.ts`; tests `checkin.test.ts`, `gates.test.ts`,
`gates.concurrency.test.ts`.

**Seven assertions (A1–A7)** are in the phase document; the two with the sharpest mutants:

- **A2** — `waiveGate('form_f')` and `overrideGate('form_f')` are refused `not_overridable` **BEFORE
  any definition or role is consulted** (the refusal must happen with an empty definition table).
  N2: *no emergency bypass exists.*
- **A6** — `evaluateReadiness` is true iff EVERY opened gate is terminal-and-not-open, and
  `identity_two_factor` cannot be `waived`.

**T5 is CRITICAL, so mutants are owed** (AGENT-RULES §3). **Note against this session's interest:
T2, T3 and T4 built NO standalone mutant files** — mutant-shaped assertions were written inline
instead. That deviation is recorded in `token-baselines.json` and is the close review's to judge.

---

## 8. THE ONE SENTENCE THIS SESSION WOULD LEAVE YOU WITH

**The full workspace verify is not a formality at this phase's task boundaries — it is the only
instrument that has found anything.** It found `seed-staff.test.ts` at T2, and at T4 it found a
defect in the very test this session had written to prove the slot race. Both were invisible to a
targeted batch that ran green every time.
