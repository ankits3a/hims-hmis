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
