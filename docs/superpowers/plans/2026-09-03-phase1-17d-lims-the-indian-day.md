# Phase 17d — The day the lab actually has (LIMS series, 4 of n)

**Lane: LIGHT** (7 tasks, no new module, one migration — EXECUTE-METHOD-V3 §2).
**Stop-loss: 2,120,000** = main-session `7 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145, the repair term).
**Lane:** `/opt/hmis-lanes/lims/hmis`, branch `lane/lims-17d` cut fresh from `origin/main` at `81aadf7` (the old `lane/lims` was 15 pre-squash commits already in main, 34 behind — abandoned, not rebased). Own test DBs `hmis_lane_lims_test*`. **One task = one PR**: commit by pathspec, push, `gh pr create`, `gh pr merge --squash --auto`; CI is the gate; locally only the touched suites; `tools/lane.sh status` before any full run.

## 1. Why this phase

17a, 17b and 17c are closed, green and undeployed: the five seats exist, one barcode runs through
them, and one patient walks the whole way in `lab.e2e.test.ts`. What has never been asked of them is
whether they survive a *day* — the smudged label, the swapped tube, the potassium at 21:10 with the
ordering doctor's phone off, the outside prescription, the hour the internet is down.

The design series asked exactly that. `docs/design/2026-09-01-lims-central-lab/EdgeCases.dc.html`
runs **26 things that happen in an Indian laboratory** against the five shipped seats and returns a
verdict on each: **14 HOLD, 9 need a screen change, 3 are plan gaps.** This phase is the CHANGE
column — the nine — minus the two the code has since answered and the one that belongs to another
lane. The three GAPs (referral lab, camp/bulk, analyser interface) stay named and out of scope.

The through-line of the nine is one sentence: **the seats are correct for the work that goes right,
and silent about the work that goes wrong.** A tube swapped at the chair produces a pregnancy
hormone on a man and the bench accepts it, because the absurd envelope reads the *number* and never
the *patient*. A smudged label is re-typed by one person with nobody watching. A critical value gives
the technician one phone number and no second rung. That is the shape of all seven tasks.

**Finish line:** each of the nine verdicts is either shipped with a test that fails first under its
mutant, or recorded in §6 with the reason it is somebody else's. No deploy (prod at 46 migrations,
one administrator — 17b §9.9 unchanged).

## 2. Ground truth — measured 2026-09-03 at `81aadf7`

| # | edge case (design board) | what the code has today | where | 17d |
|---|---|---|---|---|
| 1 | **#15** a man's tube reports a pregnancy hormone | `outsideAbsurdEnvelope` reads the NUMBER only; `resolveRange` reads sex/age but only to *pick a range*, and a sexless analyte silently footnotes `"reference range: unspecified sex"` | `results.ts:279`, `ranges.ts:82` | **T1** |
| 2 | **#12** smudged label re-typed at the bench | `receiveSpecimen` accepts a typed `S` number with no witness; the only witnessed act in the module is the absurd override | `accession.ts`, `results.ts:281` | **T2** |
| 3 | **#17** critical at 21:10, one number to dial | `lab_critical_calls.attempts` is append-only `{at,by,contact,outcome}` and closes only on read-back — **but `contact` is free text, nothing names the next rung and nothing bounds the time** | `criticals.ts:37` | **T3** |
| 4 | **#4** the ordering doctor is outside the hospital | order requires a clinician (`requiresClinician`); **no `referredBy` anywhere in the repository** | `desk.ts` | **T4** |
| 5 | **17c §8.9 may-carry** a second lab walk-in the same day | `openLabWalkinInTx` has no same-day guard; 17c closed the client path only | `opd/encounters.ts` | **T4** |
| 6 | **#18** the doctor wants numbers before the signature | `listResultsForEncounter` is **verified-only** by design (`reports.ts:969`), consumed by `opd-consult.tsx:1235` | | **T5** |
| 7 | **#20** the internet is down for an hour | `downtimeKitSerial` is carried at accession and `/ops/downtime-kit` generates the serials — **no lab screen shows the mode, so the paper register is a habit, not a surface** | `accession.ts:50` | **T6** |
| 8 | **#25** the patient reads Hindi only | `nameHi` prints for the panel and the analyte; **column headings, flag words and the notes are English** | `lab-report-print.tsx:69,88` | **T7** |
| 9 | **17c §8.9 may-carry** an amendment after a release | the one-use `lab.release_unpaid` approval is spent; v2 is published with no re-hold | `reports.ts` | **T7** |
| — | **#1** one mobile, three patients | `deskFind` matches on `mobile` and returns **hits the clerk confirms by name** (`matchedOn: "mobile"`, `desk.ts:648,827`) — the lab half HOLDS; the registration half is the front-desk lane's | | §6 |
| — | **#3** walk-in, outside Rx, no UHID | **shipped in 17c T1** — `EMPTY_REGISTER` + `walkIn` register-in-place at the reception seat | `lab-desk.tsx:47` | done |
| — | base | 59 migrations (next free **0059**, taken at rebase), 4 lab roles, 15 lab permissions, `lab` locale section, 5 lab screens (3223 lines), `data-seat="lab"` Desk One alias layer | | **0 new roles** |

## 3. Design decisions — DECIDED; none is money, procurement or law

- **D1 — Applicability is a property of the ANALYTE, not of the range book.** A beta-hCG has a
  female range and *no* male range; the range book expresses that as an absent row, and an absent
  row today yields a footnote, not a refusal. So `lab_analytes` gains `applies_to_sex`,
  `applies_min_age_days`, `applies_max_age_days` (all nullable = applies to everyone). This is the
  only migration in the phase.
- **D2 — An impossible value is REFUSED at entry with a second pair of hands, exactly like the
  absurd envelope.** Not silently parked: a parked number is a number somebody eventually clicks
  past. The precedent is `absurdOverride` and it is followed to the letter — a *different* holder of
  `lab.results.enter`, named, or the value does not reach `lab_results`.
- **D3 — The refusal writes before it throws.** `lab.tube_swap_suspected` names the specimen *and
  every sibling tube collected from the same order group within the same minute*, appended on its
  own transaction (`printLabels`'s F20 shape) so the rollback cannot take the audit record with it.
  A near-miss nobody logged is a near-miss nobody learns from, and the swap is the *point* of the
  rule: the man's tube and the woman's went to the analyser in the wrong order.
- **D4 — The call ladder is three named rungs, not a free-text list.** `ordering_clinician` →
  `duty_officer` → `patient_or_attendant`, each attempt tagged with the rung it was made on, and the
  bench screen offers the next rung once the current one has been tried. Free-text `contact` stays
  (a ward extension is not an entity); the *rung* is the enum. **Nothing in the ladder is a hard
  block** — a technician holding a potassium of 6.8 is never refused a phone call by software.
- **D5 — The time limit is advisory and visible, never enforcing.** The bench shows the elapsed
  minutes against a 15-minute target per rung (NABL's own language is "immediately"; 15 minutes is
  the standard Indian corporate-hospital SOP). It colours; it does not refuse.
- **D6 — The doctor's unverified read is a SEPARATE, opt-in reader, not a widened one.**
  `listResultsForEncounter` keeps its verified-only contract — three files' headers make a promise
  about it, and 22c-A's C1 is what widening a shared reader costs. The new reader is
  `listProvisionalResultsForEncounter`, every row carries `verified: false`, and the consult screen
  prints the word **PROVISIONAL · not yet verified** on each one.
- **D7 — Downtime mode is READ from `ops`, never set by the lab.** The lab screens subscribe to the
  ops mode the hospital already has; a second switch is a second truth.
- **D8 — The Hindi patient copy is the SAME document with a language toggle, not a second
  template.** One `LabReportPrint`, `lang: "en" | "hi"`, headings and flag words from the locale
  files. The doctor's copy stays English (NABL convention, design board #25).
- **D9 — An amendment after a release re-holds the report.** The approval was spent on version 1;
  version 2 is a new document and is held by the same interlock until it is settled or approved
  again. The alternative — one approval covering every future version — is how a released report
  becomes a permanent bypass.

## 4. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · The value that is impossible for this patient
`lab_analytes.applies_to_sex` / `applies_min_age_days` / `applies_max_age_days` (migration 0059,
additive, nullable). `assertApplicableToPatient` in `results.ts` runs **before** the absurd envelope
(it is a cheaper and graver refusal), reads the patient's `administrative_gender` and age in days at
collection through `ranges.ts`'s existing `ageInDaysIst`, and throws `analyte_not_applicable` (422)
unless `impossibleOverride: {by}` names a second holder. On the refusal path, and on its own
transaction first, `lab.tube_swap_suspected` names this specimen and every sibling specimen of the
order group collected within ±60 s. Bench screen: the refusal renders the two tube numbers and the
second-enterer field. **Mutants:** drop the sex check; drop the age check; let the enterer override
themselves; append the event on the caller's transaction (must lose the row).

### T2 — CRITICAL · The re-label is a witnessed act
A specimen received by a **typed** `S` number rather than a scan is a re-label: `receiveSpecimen`
takes `entryMode: "scan" | "typed"` and, when typed, requires `witnessedBy` naming a second holder
of `lab.collection.operate` or `lab.results.enter` (not the receiver). `lab.specimen_relabelled`
records both names and the reason. Bench screen: typing an `S` number opens the witness field
inline; scanning never does. **Mutants:** accept a typed number with no witness; accept the receiver
as their own witness.

### T3 — ROUTINE · The ladder is named, and the clock is visible
`lab_critical_calls.attempts[].rung: "ordering_clinician" | "duty_officer" | "patient_or_attendant"`
(the column is jsonb — no migration). `criticalsForBench` returns, per open call, the rungs tried,
the rung to try next, and the minutes since the result was flagged. Bench screen: the ladder as
three rows, each with its contact and its outcome, the next rung offered, elapsed minutes against
the 15-minute target (D5 — colour only). Read-back still closes it and nothing else does.
**Mutants:** offer a rung already spoken to; let a rung close the call without a read-back.

### T4 — ROUTINE · The reception seat: an outside referrer, and one walk-in a day
`referredBy: {name, qualification?, clinic?}` on the desk order, stored on the order, printed on the
report as **Referred by** and shown on the doctor's-screen column as `outside`. The order still
carries the hospital clinician who is accountable for it; `referredBy` never replaces them.
Second: `openLabWalkinInTx` refuses a second open lab walk-in for the same patient and IST day
(`lab_walkin_already_open`, 409) — 17c §8.9's may-carry, server-side this time, with the client
re-find kept. **Mutants:** let `referredBy` stand in for the clinician; allow the second walk-in.

### T5 — ROUTINE · The doctor sees the unverified, and it says so
`listProvisionalResultsForEncounter` (new reader, `lab.results.read`, D6): every resulted-but-unverified
value for the encounter, each row `verified: false`, each carrying the enterer and the entry time.
`GET /lab/results/encounter/:encounterNo/provisional`. `opd-consult.tsx` renders them in their own
block under the verified ones, every row stamped **PROVISIONAL · not yet verified**, and never
mixes the two lists. **Mutants:** return a verified row from the provisional reader; drop the stamp.

### T6 — ROUTINE · Downtime is visible at the chair and the bench
The collection and bench seats read the ops mode (D7) and, when downtime is on, the seat frame wears
a banner naming it, the label surface offers the downtime-kit serial field it already accepts at
accession, and the reconciliation note tells the operator what the paper register must carry.
No new state, no new switch. **Mutants:** show the banner when the mode is normal; hide the serial
field while downtime is on.

### T7 — ROUTINE · The patient's copy speaks Hindi; an amendment re-holds
`LabReportPrint` takes `lang: "en" | "hi"`; in `hi` the column headings, the flag words
(**उच्च** / **निम्न** / **गंभीर**) and the standing notes come from `hi.json`, while analyte names
print as they already do (`nameEn` with `nameHi` beside it) and the numbers, units and ranges are
untouched. The report centre offers the toggle on the patient copy only; the doctor's copy is
English (D8). Second: `amendReport` after a release re-holds version 2 under the interlock (D9),
with the spent approval recorded as spent and a fresh one required. **Mutants:** translate a value;
let v2 inherit v1's release.

## 5. Verify

Per task: `pnpm typecheck && pnpm lint`, then the touched suites only —
`pnpm --filter @hmis/core exec jest -w 2 src/modules/lab test/lab.e2e.test.ts` and
`pnpm --filter @hmis/web exec vitest run src/screens/lab-` — with counts pasted into §8.
The full core suite belongs to CI; run it locally only when `tools/lane.sh status` shows no other
runner. Every new test is run **red under its mutant first**, and the mutant is named in §8.

## 6. Out of scope — named so nobody infers them

- **GAP #9 — the referral lab.** `sent_out` is a declared state with no writer, no partner lab, no
  dispatch manifest and no returned-report import. **Plan 17-M**, unauthored.
- **GAP #10 — camp and corporate bulk.** No roster import, no pre-printed barcode sheets, no batch
  registration. Its own slice; the ELISA plate map on the instruments board is its bench half.
- **GAP #19 — the analyser interface and reagent stock.** `entry_mode` admits `interface` and
  nothing writes it; the four analyser statuses are declared and written by nobody; there is no
  reagent stock and no "your report will be tomorrow at 10:00" message. **Plan 17-E**, unauthored,
  and `docs/design/2026-09-01-lims-central-lab/Instruments.dc.html` is its design.
- **#1's registration half** — "this phone belongs to" at registration is `apps/web`'s counter, the
  front-desk lane's file. The lab half holds today (§2).
- **The supervisor board** (`Supervisor.dc.html`, `Week.dc.html`) — the owner redirected the design
  from scoreboards to seats on 2026-09-01. Not this phase.
- **Deploy.** Prod is at 46 migrations and has one administrator; 17a–17d all wait on that.

## 7. Owner rulings — none

Every decision in §3 is a standard Indian corporate-hospital answer, marked DECIDED per the owner's
standing rule. Nothing here is money, procurement or law. The one open design ruling recorded in
memory — *"do the back-office boards adopt Desk One or stay greyscale"* — **does not gate this
phase**: the five seats already wear Desk One through `data-seat="lab"` (17c T1), and 17d touches no
board that does not.

## 8. CLOSE — filled at execution

### 8.0 Kickoff — §2 re-measured (2026-09-03)

`origin/main` at `81aadf7`; 59 migrations, next free **0059**. The old `lane/lims` branch was 15
pre-squash 17c commits already in main and 34 behind, so the lane was cut fresh from `origin/main`
as `lane/lims-17d` rather than merged or rebased (§CLAUDE.md: never rewrite pushed history).

**Two of §2's rows were already answered and are struck from the phase:**
- **#3, walk-in with no UHID — SHIPPED in 17c T1.** `lab-desk.tsx` carries `EMPTY_REGISTER` and the
  four-field register-in-place; the memory note saying otherwise was stale.
- **#1's lab half — HOLDS.** `deskFind` matches on `mobile` and returns hits the clerk confirms by
  NAME (`matchedOn`, `desk.ts:648`). Only the registration half is open, and it is another lane's.

Also struck: the recorded open ruling *"do the back-office boards adopt Desk One or stay greyscale"*
does not gate this phase — the five seats already wear Desk One via `data-seat="lab"` (17c T1).

### 8.1 T1 — The value that is impossible for this patient (executed 2026-09-03)

**Migration 0059** adds `lab_analytes.applies_to_sex` / `applies_min_age_days` /
`applies_max_age_days` and `lab_results.impossible_overridden_by`, all nullable, plus two CHECKs.
NULL = applies to everybody, so the migration changes no behaviour on its own.

- **`applicabilityBreach` (ranges.ts)** — pure, and the two silences are deliberate and tested: a
  patient of `other`/`unknown` gender is never refused by the sex rule, and a patient with no
  recorded DOB is never refused by the age rule. Both would withhold a result over a registration
  default, and neither is evidence of a swap.
- **`enterResult` flipped to `Db`-FIRST.** Its old header said it was `Tx`-first *because "every
  refusal here writes nothing"* — 17d makes one refusal a suspected tube swap, so that stopped being
  true. It now matches `printLabels` and `verifyResult` exactly (F20/F27, met a third time).
- **`lab.tube_swap_suspected`** is appended on its OWN transaction and names every SIBLING tube of
  the order group drawn within ±60 s — the other half of the swap, by barcode. Routed onto
  `lab:bench` (`LAB_REALTIME_NAMES` 16 → 17).
- **The refusal is a second pair of hands, not a rejection**, and `impossibleOverride` is SEPARATE
  from `absurdOverride` (D2): a beta-hCG genuinely is ordered for men as a germ-cell tumour marker,
  and a decimal-point waiver must not be able to excuse a swapped tube.
- **The catalogue was curated, not just the mechanism shipped** (17c's rail-without-a-consumer rule):
  `UPT` is declared female-only and `PSA` male-only in `lab-catalogue.json`. That made
  `verify.concurrency.test.ts`'s A2 round refuse its UPT leg on the male fixture patient — the rule
  working — so the round swapped `UPT` for `ESR`, the remaining analyte-disjoint priced orderable.
- **Two guards were obeyed rather than weakened.** The bench payload census refused `flaggedBy`
  (it matches `/flag/`); the field was renamed `raisedBy`. The 403 and event censuses were re-pinned
  with the new codes and the 23rd event, not relaxed.
- **Carried, unasked:** `lab.test.ts` minted `specimenNo` from `Math.random()` over 90 values for a
  UNIQUE column and collided with itself ~1 run in 90 (it failed the radiology lane's doc-only CI run
  33617478294). Replaced with a per-suite counter.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | drop the `male`/`female` guard on the sex rule | `other`/`unknown`/null refused — 1 failed |
| 2 | inclusive upper age bound (`days > max`) | the 29th day applicable — 1 failed |
| 3 | append the swap flag on the caller's `tx` | **events 1 → 0**, 2 failed — the F20 shape, proved |
| 4 | web: the vouch rides `absurdOverride` | `impossibleOverride` undefined — 1 failed |
| 5 | web: banner without the barcodes | the tube numbers absent from the alert — 1 failed |

**Evidence (2026-09-03, lane `lims`, no peer runner — `tools/lane.sh status` clean):**
`pnpm typecheck` 0 errors; `pnpm lint` 0 errors (2 pre-existing warnings in `kernel/`).
Core lab surface — `src/modules/lab` + `schema/lab.test.ts` + `seed-lab-catalogue.test.ts` +
`test/lab.e2e.test.ts`: **27 suites, 241 tests, all passing** (then 26/26 after the two schema
constraint tests landed). Web — `src/screens/lab-*` + `src/lib`: **14 files, 90 tests, all passing**,
i18n parity included.

### 8.2 T2 — The re-label is a witnessed act (executed 2026-09-03)

Design board EdgeCases #12: *"Label smudged in the ice box; the bench scanner cannot read it."*

- **Typing the number stays ALLOWED.** A laboratory that refused the tube would be discarding a
  patient's blood over a printer. What it may not be is SILENT: `identifiedBy: "typed"` requires
  `relabel: {witnessedBy, reason}`, refused on 02 H1's exact terms — a second person, never the
  receiver, holding `lab.accession.operate` — and a blank reason is not a reason.
- **`lab.specimen_relabelled` is its own fact**, on the SAME transaction, and the contrast with T1 is
  written down: T1's event rides a REFUSAL and must outlive the rollback; this one rides a SUCCESS
  and must vanish with it. A re-label recorded for a tube that was never received is a false record.
  Routed on `lab:bench` (`LAB_REALTIME_NAMES` 17 → 18; events 23 → 24).
- **REQUIRED on the wire, defaulted in the service, and the asymmetry is deliberate and PINNED.**
  The service cannot observe whether a barcode was scanned or keyed; only the screen can. So
  `receiveBody` requires `identifiedBy` and `accession.test.ts` asserts the schema refuses a body
  without it — otherwise the service's `"scan"` default would be a hole a forgotten field walks
  through (results.ts's M3, one act over). The default exists only so 23 internal fixtures that
  genuinely scan need not be rewritten.
- The bench screen declares it by CHECKBOX, not by keystroke timing: a heuristic that decided this
  from typing speed is a control a fast typist switches off by accident.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | the receiver may witness their own re-label | 1 failed |
| 2 | a blank reason counts as a reason | 1 failed |
| 3 | no `lab.specimen_relabelled` written | 1 failed |
| 4 | web: Receive enabled with no witness/reason | 1 failed |
| 5 | web: the screen always claims `"scan"` | 1 failed |

**Found by the change, not by a reviewer:** `lab.e2e.test.ts` drove three receives through the real
route and got 400s — the required field working from the one surface a person comes through. Fixed
in the e2e, and the pre-existing web D7 test's exact-body pin was widened to say `identifiedBy: "scan"`
rather than relaxed to `toMatchObject`.

**Evidence (2026-09-03):** typecheck 0; lint **0 errors**. Core lab surface **27 suites, 246 tests
green**. Web `src/screens/lab-*` + `src/lib` **14 files, 91 tests green**.

### 8.3 T3 — The ladder is named, and the clock is visible (executed 2026-09-03)

Design board EdgeCases #17: *"Potassium 6.8 at 21:10; OPD over, ordering doctor's phone off."*
The call opened itself and every attempt was logged — and the technologist was left dialling ONE
number with nothing saying who to try next. An escalation path that lives in a technologist's head
at 21:10 is an escalation path the hospital does not have.

- **`RUNGS` is an enum in escalation order; `contact` stays free text.** A ward extension is not an
  entity, but "the ordering clinician" and "the duty medical officer" are roles a hospital can be
  held to. No migration — `attempts` is already jsonb.
- **Only SPEAKING to somebody retires their rung.** Three unanswered rings, an engaged tone and a
  message with a ward clerk leave the ladder pointing at the same doctor — 02 §3.6's attempt/
  acknowledgement distinction, read one level up. `nextRung` returns `null` when every rung has been
  spoken to and the call is still open, which is a real state (the read-back is not keyed yet).
- **A pre-17d attempt carries no rung and must not retire one by accident** — `rung` is optional in
  the TYPE (rows written before this phase have none, and a reader that assumed one would be
  inventing history) and REQUIRED on the wire (nothing new lands without it). Tested both ways.
- **D5 — the 15-minute target is advisory and PROVEN to be.** `minutesOpen`/`targetMinutes` colour
  the panel and gate nothing; a test drives a call five hours past its target and it still accepts
  every rung and still closes. A technologist holding a potassium of 6.8 is never told by software
  that they may not make a phone call.
- The bench draws all three rungs always — including the untried ones — with what came of each, and
  the rung control **defaults to `nextRung`**, so re-dialling the phone that is already off is a
  deliberate choice rather than the path of least resistance.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | any attempt retires the rung | 2 failed |
| 2 | `minutesOpen` fixed at 0 | 1 failed |
| 3 | web: the rung control defaults to the FIRST rung | 1 failed |
| 4 | web: the ladder shows only rungs already tried | 1 failed |

**Evidence (2026-09-03):** typecheck 0; lint **0 errors**. Core lab **27 suites, 249 tests green**.
Web `src/screens/lab-*` + `src/lib` **14 files, 92 tests green**.

### 8.5 T5 — The doctor sees the unverified, and it says so (executed 2026-09-04)

Design board EdgeCases #18: *"Doctor wants the numbers by phone before the pathologist signs."*
A constant and legitimate request in an Indian hospital; the honest answer is to show the numbers
with the word on them rather than to pretend they do not exist.

- **A SECOND reader on a SECOND route, never a flag on the first (D6).**
  `listResultsForEncounter`'s verified-only contract is stated in three files' headers, and 22c-A's
  C1 is what widening a shared reader costs — every existing caller silently acquires the new
  behaviour, and the one that matters is the consult screen, which puts values in front of a
  prescriber. `GET /lab/results/encounter/:encounterNo/provisional`, same permission: this is not a
  MORE privileged fact, it is a less finished one, and a second grant would send clinicians back to
  telephoning the bench.
- **`verified: false` is a literal on every row**, carrying no information on purpose: a shape that
  merely omitted `verifiedAt` would be one careless spread from looking like the signed kind.
- **Superseded rows are excluded** — a re-keyed value replaces its predecessor; a doctor reading
  every attempt would be reading the laboratory's working-out rather than its answer.
- **Its own PHI surface**, `lab.results.provisional` (kernel `phi/audit.ts`, additive union member):
  "the prescriber saw a provisional value at 21:40" and "saw a signed report" are materially
  different disclosures, and it is the one an audit asks about after a clinical incident.
- The consult panel renders them **below** the signed list, never interleaved, stamped on **every
  row** rather than once on the heading — a heading scrolls off and a row does not. A failed
  provisional query renders **nothing**, not an empty state (C1: a failed query is not a clinical
  negative).

**A MUTANT SURVIVED, and it was a finding, not a formality.** `!= 'verified'` in place of
`= 'unverified'` passed every assertion, because nothing in the fixture — or in the product — ever
writes an `autoverified` row (auto-verification shipped with zero rules, 17b DD8). The two filters
are indistinguishable on today's data and would diverge the day the first rule is switched on. A
test now writes that row directly and pins the distinction; the mutant dies.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | `!= 'verified'` instead of `= 'unverified'` | **survived first; killed by the new autoverified test** |
| 2 | the superseded are not excluded | 1 failed |
| 3 | the provisional read logs under `lab.results` | 1 failed |
| 4 | web: the two lists merged | 1 failed |
| 5 | web: the stamp on the heading only | 1 failed |
| 6 | web: a failed query renders an empty block | 2 failed |

**Found, NOT taken:** `listResultsForEncounter` filters `= 'verified'`, so an **autoverified** row
would be invisible to the doctor entirely. Nothing is autoverified today. Fixing it means widening
the shared reader, which is exactly what D6 forbids — it belongs to the phase that switches
auto-verification on.

**New coverage, not widened:** `opd-consult.test.tsx` mocks no lab route, so the laboratory panel
had no test at all. `LabResultsPanel` is now exported and `lab-consult-panel.test.tsx` covers it.

**Evidence (2026-09-04):** typecheck 0; lint **0 errors**. Core lab **27 suites, 254 tests green**.
Web `src/screens/lab-*` + the full `opd-consult` suite + `src/lib`: **16 files, 119 tests green**.

### 8.6 T6 — Downtime is visible at the chair and the bench (executed 2026-09-04)

Design board EdgeCases #20: *"Server or internet down for an hour."* `ModeBanner` already tells the
whole building the hospital is on paper, so that was never the gap. The board's complaint is
sharper: **the paper register and the later reconciliation are a habit rather than a screen.**

- **A RAIL WITH NO CONSUMER, found and consumed.** `labelSource: "downtime_kit"` and
  `downtimeKitSerial` have been accepted by `printLabels` AND `receive` since 17a T5 (E20 / 02 C3)
  and were offered by **no screen at all** — 17c's pattern, a fourth time. The chair now writes the
  kit serial and the bench maps it to the tube at accession.
- **D7 — the lab READS the mode and never sets one.** A second switch would be a second truth: a
  lab that declared its own downtime would disagree with the duty manager within the hour and the
  reconciliation afterwards would have two registers to believe. `/ops/mode` mints no read
  permission precisely so every screen may make this read.
- `useDowntime` and `DowntimeNotice` are shared by both seats, so the chair and the bench say the
  **same thing about the same kit** — a reconciliation that reads two different instructions is the
  failure this is written to prevent.
- **The chair's Record button waits for the serial; the bench's Receive does NOT.** A tube drawn
  before the outage still wears its printed label, and demanding a kit serial for it would stop the
  bench working on the tubes that are fine — the opposite of what a downtime screen is for.
- The right-patient scan is untouched: downtime relaxes the LABEL's source, never the check that
  the tube belongs to the person in the chair (DD10 / E1).

**A SECOND MUTANT SURVIVED, and this one would have shipped.** `mode !== "normal"` in place of
`mode === "downtime"` passed every test, because they exercised only the two ends. There are FIVE
modes and **production has never left `commissioning`** (17b §9.9) — under that mutant the kit field
and the paper-register notice would be permanent furniture on both seats from the day the lab went
live, read as an instruction. `degraded` is the sharper half: the hospital is struggling, the
printer is fine, and a kit serial demanded then is a phlebotomist inventing one. Three modes are
pinned now and the mutant dies.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | any non-`normal` mode counts as downtime | **survived first; killed by the three-mode test** |
| 2 | the downtime UI is always on | 2 failed |
| 3 | the chair prints with no kit serial | 1 failed |

**Evidence (2026-09-04):** typecheck 0; lint **0 errors**. Web-only change (no core file touched):
**the FULL web suite, 83 files / 673 tests green.**

### 8.7 T7 — The patient's copy speaks Hindi; an amendment re-holds (executed 2026-09-04)

**The Hindi copy (design board EdgeCases #25).** The SMS and WhatsApp text were already bilingual;
the paper was not. `LabReportPrint` takes `lang: "en" | "hi"` and binds `i18n.getFixedT("hi")` —
never `changeLanguage`, which would repaint the whole SPA behind the clerk who pressed print.

- **What changes is the FURNITURE and nothing else**: column headings, flag words
  (**गंभीर निम्न** / **उच्च** / **निम्न** — already in `hi.json`, the exact words the board named),
  the standing notes. **No value, unit or reference interval is translated.** A report whose numbers
  moved with a toggle would be two different documents under one signature, and that is the one
  thing this feature must not do. The test asserts `41`, `mg/dL` and `70 – 99` are identical either
  way, and a mutant that ran the value through the translator dies on it.
- **Per REPORT, at the counter**, defaulting to English: the same screen prints the patient's Hindi
  copy and the ward's English one, and NABL convention keeps the doctor's copy English (D8).

**The amendment re-hold (D9) — 17c §8.9 carried it as a worry; it is ALREADY the behaviour, so it
is PINNED rather than built.** Two independent things prevent v2 walking out on v1's decision, and
neither was written for this case: `deliveryAllowed` holds no memory of a release (it recomputes
from the order group's balance every call), and the approval is spent by its delivery row. A
behaviour nobody tested is a behaviour the next refactor removes, and this one is money leaving the
building — so the test exists though the code does not change. A mutant on the spent-approval guard
kills it.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | the approval is not spent by its delivery row | 1 failed |
| 2 | web: the `lang` toggle is ignored | the test failed |
| 3 | web: the VALUE is run through the translator | the test failed |

**A CROSS-LANE COST, CAUGHT AND PAID BY ME.** The first cut added two report-centre renders and the
full web suite began failing `vitals-bay-stories.test.tsx` — the FRONT-DESK lane's file — with
`Test timed out in 5000ms`. It was not a flake and I proved it: the clean tree passed 83/83 twice,
mine failed twice at 5046 ms, and the story test alone takes 2745 ms against a 5 s budget. The web
suite shares one worker, so my extra mount spent a peer's wall-clock. Folded the two Hindi tests
into one render rather than edit another lane's file: suite back to green and **7 s faster**
(49.56 s → 42.94 s). **Worth telling the front-desk lane: that test sits at 55% of its timeout
before anybody else adds a file.**

**Evidence (2026-09-04):** typecheck 0; lint **0 errors**. Core lab **27 suites, 255 tests green**.
**Full web suite 83 files / 674 tests green** (run clean-tree first to attribute the failure).

### 8.4 T4 — The outside referrer (ALREADY SHIPPED), and one walk-in a day (executed 2026-09-04)

**§2's row for edge case #4 WAS WRONG, and this is the correction.** It said *"no `referredBy`
anywhere in the repository"* — true of the literal identifier and false about the capability. The
concept ships end to end under a different name and has since 17c T1:

| the board asked for | where it already lives |
|---|---|
| "referred by" as a named outside doctor | `orders.authority = 'external_prescription'` with `external_referrer_id` / `referrer_name`, held by a CHECK constraint (`orders_authority_ck`) |
| on the reception seat | `lab-desk.tsx:549` — a `referrerName` field the clerk fills, sent by `deskWalkinOrder` |
| the report goes to the patient only | true by construction: an outside doctor has no login and no channel. Nothing pushes to them because there is nowhere to push |
| the doctor's-screen column reads "outside" | **no such column exists** on any screen — there is nothing to label. Not built, and recorded rather than invented |

The lesson is the measurement, not the code: **grepping for the name a design document uses finds
the name, not the capability.** The board was written 2026-09-01 and 17c shipped 2026-09-02; two of
the board's nine CHANGEs (#3 and #4) were answered by 17c before this phase read them.

**So T4's only real work was 17c §8.9's may-carry: one open lab walk-in per patient per day, on the
server.** 17c closed the ordinary browser path (the seat re-finds by the minted visit); what the
browser cannot close is a SECOND CLERK, a reloaded tab or a retried request. Two `V` numbers for one
attendance is two encounters the report, the queue and every departmental count then disagree about.

- **Scoped to the LAB door, never to `openVisitInTx`.** A general same-day guard would change every
  department: OPD legitimately opens a second visit the same day, and 07d's re-entry exists because
  one visit can be resumed. The laboratory is the case where a second visit is always a mistake — a
  walk-in is one draw, and tests remembered on the way out are an ADD-ON (DD9).
- The refusal **names the open visit** (`detail.visitNo`) so the seat can re-find rather than guess,
  and answers **409** — the caller's correct response is to re-read, not to fix its body.
- `completed` and `abandoned` release it: the patient who left without giving a sample must not be
  locked out until midnight.

**A MUTANT SURVIVED, on the claim I had said was "asserted by construction".** Dropping the
DEPARTMENT filter passed every test, because no test gave the patient a visit anywhere else. Without
it the guard reads *"any open visit today"* — a patient seen in General Medicine at 10:00 could not
give blood at 15:00, which is a worse failure than the duplicate it prevents. Construction was not
evidence; there is a test now.

**Mutants, each applied and each red, then reverted:**

| # | mutant | killed by |
|---|---|---|
| 1 | the guard forgets the DATE | 1 failed |
| 2 | a COMPLETED visit still blocks | 1 failed |
| 3 | the guard forgets the DEPARTMENT | **survived first; killed by the new cross-department test** |

**A pre-existing test changed meaning and was repaired, not deleted.** `desk.test.ts` A2 asserts
*"a refused order opens no visit"* by re-attempting on the same patient — who by that line already
has today's walk-in open, so the new guard refused first and the assertion would have measured the
guard rather than the rollback. It attempts on `otherPatientId` now, with the reason written in.

**Evidence (2026-09-04):** typecheck 0; lint **0 errors**. **Full OPD + lab surface: 63 suites, 552
tests green** — the whole hub, because this task touched one.
