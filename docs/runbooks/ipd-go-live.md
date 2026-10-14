# IPD go-live: rehearsal, cutover and ward-by-ward rollout

Epic E3.4 (#732) and E4.5 (#737). Plan: `docs/superpowers/plans/2026-10-12-ipd-PLAN.md`, sections M3 and M4.

The owner's rule (2026-10-13): **IPD does not go to production until every other module is built.** Until then
everything below happens on staging only. Run this page in order on the day; nothing in it needs a developer.

**Who does what on this page**

| Person | Does |
|---|---|
| Owner | approves the rate card and the admission workflow, says "go" or "stop" |
| Medical superintendent (MS) | approves the admission workflow, signs off each ward |
| IT person | runs the commands (the check script, the three loads) |
| Nursing superintendent | picks the pilot ward, runs training, marks the incumbent beds with the ward in-charges |
| Billing manager | checks the rate card, runs the bill desk on day one |

Every command on this page that contains `<something>` must have that part replaced before it is run. The angle
brackets are there on purpose: if one is pasted as written, the shell refuses it.

## 1. The readiness check: one command, one answer

The check reads the database and prints one line per item: **PASS**, **FAIL** (with the fix on the next line) or
**WARN** (with the fix; it never blocks). The last line says **READY** or **NOT READY**. It never writes anything:
it runs inside a read-only transaction, so the database refuses any write.

On staging (the IT person, on the staging box):

```bash
docker exec hmis-uat-api-1 node dist/scripts/ipd-golive-check.js
```

On production (the IT person, on the production server, inside the production api container):

```bash
node dist/scripts/ipd-golive-check.js
```

Exit code 0 means READY. Exit code 1 means at least one FAIL.

| Item | PASS means | If it FAILs |
|---|---|---|
| `admission_workflow_active` | the `ipd_admission` workflow is active | §4: MS and owner approve, owner activates |
| `approval_types_registered` | all five IPD approval types exist (ICU admission, non-covered line, deposit waiver, discharge with dues, bill void) | §3.3 |
| `approvers_held` | each approver role (medical superintendent, billing manager) has an active person | Admin → Users |
| `rate_card_complete` | the tariff in force prices room, nursing and visit for every rated bed class | §3.2 |
| `ipd_services_on` | every priced `IPD_*` service is switched on | Billing office → Prices → Services |
| `beds_loaded` | the bed list is in the system | §3.1 |
| `beds_consistent` | no bed is in an impossible state (occupied with nobody, blocked with no block, a hold on an occupied bed, and so on) | IT reads the bed codes it lists; each is fixed by the matching act on the Beds board, never by editing the database |
| `role_held:*` | at least one active person holds each role: admission desk, ward nurse, nursing supervisor, dietician, kitchen, IPD bill desk (cashier), billing manager, pharmacist, MS | Admin → Users |
| `pharm_opd_store` | the PHARM-OPD store exists (wards draw medicines from it) | every deploy creates it; if it FAILs, call IT |
| `no_test_patient_admitted` | no open admission belongs to a test or sample patient (a name with test, sample, demo, dummy, uat or trial, or a 900000xxxx phone) | discharge or cancel each one listed |
| `copilot_model` (WARN) | the copilot model is set up | optional: without it the ward shows the plain timeline |
| `notify_templates` (WARN) | IPD messages can be sent | optional at go-live: the daily totals message and the family OTP wait for approved templates (#761) |

The hospital-wide census (`standup-check.js ipd`) carries the same items as rows, so the two can never disagree.

## 2. Rehearsal week on staging (the M3 gate)

One week, with the real staff who will work the first day, on staging (`https://stagehmis.crkmch.com`). The goal is
that on cutover day nothing is being done for the first time.

**Day 1: set up, exactly as on cutover day**

1. IT runs the check (§1). Expect NOT READY. Copy the output into §12, row 1.
2. Do §3 (data loads) and §4 (approvals) in order, as written. Use the real bed list and the real incumbent tariff
   export. Staging also has a sample rate card (`stage-ipd-setup`); replace it with the real one for the rehearsal.
3. IT runs the check again. Every FAIL left must have a named person and a date. Repeat until READY. Copy the READY
   output into §12, row 2.

**Days 2 to 5: run the scripts with real staff.** Each one is done once by the person who will do it for real, with
someone watching who writes down every place they got stuck (§12, defects log).

| # | Script | Who |
|---|---|---|
| R1 | Planned admission from OPD advice: request, deposit, bed, band printed | admission desk, cashier |
| R2 | Emergency admission, deposit later, ICU approval asked and given | admission desk, MS |
| R3 | Scheme (PM-JAY) and TPA admission with a line marked not covered | admission desk, billing manager |
| R4 | Transfer to another ward with handover; the receiving nurse accepts | two ward nurses |
| R5 | Class change (upgrade) with consent, effective next noon | admission desk |
| R6 | Deposit runs low: the 75 % and 90 % alerts reach the bill desk, never a doctor | cashier, billing manager |
| R7 | Normal discharge: fit declared, departments confirm, final bill, gate pass scanned | doctor, nurse, cashier, security |
| R8 | Discharge with unpaid dues: approved, recorded, the patient leaves | billing manager |
| R9 | LAMA, absconded and death, one each; the mortuary register | duty manager, nurse |
| R10 | Downtime: two admissions on paper, then back-filled when the system is back | admission desk |
| R11 | Incumbent bed: marked occupied, then released by a tap after the old system discharges the patient | ward in-charge |
| R12 | Bed turnover: discharge, housekeeping cleans, bed back to available | housekeeping |

**Day 6: the gate.** The M3 gate passes when: every script above ran once; zero issued items without a bill line;
every discharge closed; the check says READY. The owner reads §12 and says "OK for production" or not.

**Day 7: clean up.** Discharge or cancel every rehearsal admission. The check item `no_test_patient_admitted` must
PASS on staging before the same people go to production.

## 3. The data loads (cutover day, in this order)

Each load is a dry run first. The dry run prints what it would do and writes nothing. Only after a person has read
the dry run is the same command run again with `--apply`.

### 3.1 Load the bed list

The bed list is one CSV row per bed (floor, ward, room, bed code, class, gender rule, isolation, ICU, equipment). The
planning file is `apps/core/scripts/data/ipd-bed-layout.planning.csv`; the nursing superintendent confirms it against
the wards first. `--by` is the login of an administrator who holds user management.

```bash
node dist/scripts/load-bed-layout.js --file <path to beds.csv> --by <administrator login>
node dist/scripts/load-bed-layout.js --file <path to beds.csv> --by <administrator login> --apply
```

One bad row refuses the whole file and lists every problem by row number. Running it twice writes nothing the
second time. It never deletes or moves a bed.

### 3.2 Import the incumbent tariff and put it in force

The billing manager exports the old system's IPD tariff as a CSV with columns `incumbent_code, incumbent_name,
bed_class, component, rate_rupees`. A line that is not a per-day rate by class (for example a procedure package)
has `bed_class` and `component` left blank; it is printed back as "unmapped", never dropped.

```bash
node dist/scripts/import-ipd-tariff.js <path to tariff.csv> --by <billing login>
node dist/scripts/import-ipd-tariff.js <path to tariff.csv> --by <billing login> --apply
```

`--apply` writes a **draft** tariff version only. Then, on screen:

1. Billing office → Prices → IPD rate card: the billing manager checks every class has room, nursing and visit.
2. Submit the draft. The owner approves it. The owner activates it.
3. Billing office → Prices → Services: switch on every `IPD_*` service (the importer creates them switched off).

### 3.3 Register the IPD approval types and draft the admission workflow

One command, run once on go-live day (#798). Without `--confirm` it only prints what it would do and writes nothing:

```bash
node dist/scripts/ipd-golive-setup.js
node dist/scripts/ipd-golive-setup.js --confirm
```

It registers the five IPD approval types and creates the `ipd_admission` workflow as a **draft**. It never approves
or activates anything, imports no tariff and gives nobody a role; the approvals are §4. Running it again only says
"already". It is not part of any deploy: it runs only when IT runs it. (On staging, `stage-ipd-setup` does the same
two steps through the same code.)

### 3.4 Mark the incumbent beds

Patients already in a bed on cutover day stay in the old system until they leave. Their beds show as
"occupied — incumbent" on the Beds board, so nobody admits onto them.

On cutover night, each ward in-charge writes down every bed that still has an old-system patient: the bed code, and
for a twin-sharing room the patient's sex (M or F). The nursing superintendent collects the lists into one text file,
one bed per line, for example `F05-ORT-M-B12` or `F05-ORT-T-R3-B1,F`. `--by` is a login that may manage beds.

```bash
node dist/scripts/mark-incumbent-beds.js --file <path to incumbent-beds.txt> --by <bed manager login>
node dist/scripts/mark-incumbent-beds.js --file <path to incumbent-beds.txt> --by <bed manager login> --apply
```

When the old system discharges one of these patients, the ward taps the bed on the Beds board and releases it. Zero
incumbent beds left is goal G1's second half.

## 4. The approvals clicks

On Admin → Workflows, find `ipd_admission`:

1. The medical superintendent approves.
2. The owner approves.
3. The owner activates. (The person who drafted it cannot activate it; the system enforces this.)

The rate card is approved and activated in §3.2. Nothing else needs a click.

## 5. Cutover day: the order

The date is the owner's. Pick a weekday, outside OPD hours for the first steps (a deploy restarts the server for
about a minute).

| When | What | Who |
|---|---|---|
| Day before, evening | The IPD code is merged and deployed (§11). IT runs the check: expect FAIL only on data items | IT |
| Day before, evening | §3.1 bed list, §3.2 tariff import and approval, §3.3 `ipd-golive-setup --confirm` | IT, billing manager, owner |
| Day before, evening | §4 approvals clicks | MS, owner |
| Cutover night, 23:00 | Ward in-charges list incumbent beds; §3.4 dry run, then apply | nursing superintendent, IT |
| Cutover night, 23:45 | IT runs the check. **Only READY goes ahead.** A FAIL is fixed now or the owner postpones | IT, owner |
| 00:00 | **Switch-on.** From this minute every new admission is made in HMIS. The old system takes no new admission | admission desk |
| 00:00 onward | The first admission is made in HMIS and its band printed. The war room (§6) watches it end to end | admission desk, war room |
| 06:00 | Nightly charges posted for the first night; the billing manager checks the bill desk | billing manager |
| 09:00 | First morning: rounds, discharges and transfers run in HMIS. The old system only discharges its own patients | all wards |

Switch-on is a decision, not a button: the workflow is already active from §4. From 00:00 the admission desk stops
using the old system for new patients.

## 6. The first ward and the first 48 hours (war room)

The admission, bed, bill, transfer and discharge screens go live for **every ward at once** at switch-on. A patient's
stay is never split between two systems. Nursing notes and the eMAR (the medicine chart) come later, ward by ward
(§8).

For the first 48 hours a war room is staffed around the clock: one person from IT, the billing manager (day) or the
duty manager (night), and the nursing superintendent on call. They keep a log in §12 (war-room log), one line per
event: time, ward, what happened, who fixed it, how. They also run the check every 12 hours.

**Stop and call the owner when:** an admission cannot be made in HMIS and the downtime paper kit is needed for more
than 30 minutes; a bill is wrong by any amount the billing manager cannot explain; a patient is placed in a bed that
was not free.

After 48 hours the owner reads the war-room log and decides: continue, or roll back (§7).

## 7. Rollback

**Before switch-on**: nothing to undo. Stop, fix, pick a new date. The data loaded in §3 stays; it does no harm.

**After switch-on** (DECIDED, standard practice: a live stay never moves between systems):

1. The admission desk goes back to the old system for **new** admissions, from a time the owner names.
2. Patients already admitted in HMIS finish their stay in HMIS: transfers, bills and discharges stay in HMIS.
3. If HMIS itself is down, every ward uses the downtime paper kit. When it is back, the desk back-fills the paper
   admissions (Admit → downtime back-fill) and the bill desk checks each deposit.
4. The code is **not** rolled back by IT on their own. The database changes are additive and stay. Taking code back
   is the owner's decision with IT, and IT never drops a table.

## 8. Ward-by-ward rollout of the clinical record (E4.5)

After cutover, nursing, rounds and the eMAR go live one ward at a time, in this order:

1. **Pilot:** one adult general ward, chosen by the nursing superintendent (good in-charge, steady census).
2. The other adult general wards, one at a time.
3. Private and semi-private wards.
4. Obstetrics and paediatrics (MEOWS and PEWS scores).
5. HDU.
6. **ICU last**, after the bedside device feeds work.

A ward goes live only when the ward before it has passed its go signals (§10) for two weeks. Each ward's date and its
two-week record go in §12.

## 9. Training checklist by role

Each person does each task once on staging, unaided, while a trainer watches. The trainer ticks it in the ward's
training sheet. Nobody works the live ward until their list is ticked.

| Role | Must do once, unaided |
|---|---|
| Admission desk (front office) | request to admission with deposit; emergency admission; scheme / TPA admission; print and reprint a band; downtime back-fill |
| Ward nurse | admission assessment within 1 hour; vitals (typed and on the phone); intake and output; scan wristband and label and give a dose; hold or refuse a dose with a reason; shift handover; accept a transfer; night mode |
| Nursing supervisor | read the nurse station; answer an early-warning alert; second-nurse PIN for a high-alert drug; narcotic register count |
| Doctor (consultant / resident) | sign a round (S/O/A/P); resident draft and consultant co-sign; place a drug order and a lab order; declare fit for discharge; answer an early-warning alert within 30 minutes |
| Pharmacist | verify an inpatient order; issue to the ward with patient labels; take a return |
| Cashier (IPD bill desk) | take a deposit; read the bill desk exceptions; run a final bill and settle it |
| Billing manager | approve a non-covered line, a deposit waiver, dues at discharge, a bill void |
| Dietician / kitchen | the meal list for the next round; an NPO patient drops off it; a transfer after printing |
| Housekeeping / porters | clean a bed from the task list; a terminal clean; a patient move |
| Duty manager | overflow bed; LAMA, abscond and death records; mortuary register |
| Medical superintendent | ICU admission approval; workflow approval; read the goal ledger |

## 10. Go and no-go signals per ward

Read from the goal ledger (`node dist/scripts/ipd-goal-ledger.js --days 14`), per ward, at the end of the two weeks.

**Go** to the next ward when all of these hold for the live ward:

- G6(a): at least 98 % of doses given with both the wristband and the label scanned.
- G6(b): no wrong-patient or wrong-drug dose. Ever.
- G7: at least 95 % of early-warning alerts answered by a doctor within 30 minutes.
- Five nurses did scan-and-give, vitals and handover first time, unaided, while observed (pilot ward only).
- No paper medicine chart in use on the ward.

**No-go** (stop the rollout, fix, and run the two weeks again) on any of these:

- any wrong-patient or wrong-drug dose;
- G6(a) under 98 % or G7 under 95 % for the two weeks;
- nurses keeping a parallel paper chart;
- the ward in-charge or the MS says no.

## 11. Merging the IPD code to production: migration numbers

The IPD work sits in about 30 pull requests, each built on the ones before it. Each adds at most one database
migration, and migration numbers must be unique and in order on `main`. **The numbers in each PR today are
provisional**: each PR takes the next free number at the moment it merges.

Rules:

- Merge **one PR at a time, in the order below**. Never two at once.
- `lane/ipd-stage` (#776) is the staging integration and is **never** merged.
- Every merge is a production deploy. The owner says yes to each, outside OPD hours.

For each PR, in its own lane (`/opt/hmis-lanes/<lane>/hmis`):

```bash
git fetch origin && git merge origin/main
python3 tools/renumber-lane-migrations.py            # report: what it would rename
python3 tools/renumber-lane-migrations.py --apply    # rename the files and rewrite the journal
git diff --diff-filter=A --name-only origin/main HEAD -- apps/core/drizzle/   # must list only this PR's own migration
```

Then drop the lane's test databases (the script prints how), typecheck, commit, push, wait for CI to go green,
stage it, and merge only on the owner's yes. The next PR in the list starts only after this one is on `main`.

| Order | PR | Lane | Its own migration |
|---|---|---|---|
| 1 | #745 | ipd-intents | none |
| 2 | #746 | ipd-goals | none |
| 3 | #747 | ipd-tasks | `tasks_engine` |
| 4 | #748 | ipd-beds | `ipd_beds` |
| 5 | #750 | ipd-housekeeping | `task_source_ref` |
| 6 | #749 | ipd-bmw | `bmw` |
| 7 | #752 | ipd-linen | `linen` |
| 8 | #754 | ipd-maintenance | `maintenance_tickets` |
| 9 | #751 | ipd-admit | `ipd_admit` |
| 10 | #755 | ipd-passes | `passes` |
| 11 | #757 | ipd-transport | `transport_requests` |
| 12 | #756 | ipd-charges | `ipd_charges` |
| 13 | #758 | ipd-payer | `ipd_payer` |
| 14 | #759 | ipd-transfer | `ipd_transfer` |
| 15 | #762 | ipd-discharge | `ipd_discharge` |
| 16 | #760 | ipd-billdesk | `ipd_billdesk` |
| 17 | #764 | ipd-family | `ipd_family` |
| 18 | #767 | ipd-flow | `ipd_bed_flow` |
| 19 | #775 | ipd-suppbill | `ipd_suppbill` |
| 20 | #782 | ipd-nursing | `ipd_nursing` |
| 21 | #783 | ipd-diet | `diet` |
| 22 | #786 | ipd-rounds | `ipd_rounds` |
| 23 | #788 | ipd-orderbill | `ipd_orderbill` |
| 24 | #790 | ipd-emar | `ipd_emar` |
| 25 | #791 | ipd-drugbill | `ipd_drugbill` |
| 26 | #793 | ipd-copilot | `ipd_copilot` |
| 27 | #795 | ipd-allergycard | none |
| 28 | #796 | ipd-ipcounter | none |
| 29 | #797 | ipd-narcotic | `ipd_narcotic_register` |
| 30 | this runbook's PR | ipd-cutover | none |

The order is the one `lane/ipd-stage` already runs on staging (its migrations 0205 to 0229), so production gets the
same sequence staging has tested. A PR opened after this list was written joins it at the end, in the order it was
staged. After the last merge, the check (§1) is run on production; the data items FAIL until cutover day, and that is
expected.

## 12. Executed — rehearsal and cutover log

Nothing on this page has been run yet. Each row gets a date and initials when it is done. The M3 gate reads this
section.

| # | Act | Who | Done (date / initials) | What was seen |
|---|---|---|---|---|
| 1 | Rehearsal day 1: first check output (NOT READY) pasted below | IT | | |
| 2 | Rehearsal: check READY on staging | IT | | |
| 3 | Rehearsal scripts R1–R12 each run once (§2) | staff | | |
| 4 | Rehearsal: zero issued items without a bill line; every discharge closed | billing manager | | |
| 5 | Owner "OK for production" after the rehearsal | owner | | |
| 6 | Dry run of `ipd-golive-setup` read (§3.3); nothing written | IT | | |
| 7 | All IPD PRs merged in the §11 order | IT | | |
| 8 | Cutover: bed list loaded (§3.1) | IT | | count = |
| 9 | Cutover: tariff imported, approved, activated; IPD services on (§3.2) | billing manager, owner | | version = |
| 10 | Cutover: approval types and workflow draft (§3.3) | IT | | |
| 11 | Cutover: workflow approved by MS and owner, activated by owner (§4) | MS, owner | | |
| 12 | Cutover: incumbent beds marked (§3.4) | nursing superintendent | | count = |
| 13 | Cutover: check READY at 23:45 | IT | | |
| 14 | Switch-on; first HMIS admission | admission desk | | IP number = |
| 15 | 48-hour war room closed; owner decision | owner | | |
| 16 | Pilot ward live (§8) | nursing superintendent | | ward = |
| 17 | Pilot ward two-week go signals (§10) | MS | | G6a = , G7 = |

**War-room log** — first 48 hours:

| Time | Ward | What happened | Who fixed it | How |
|---|---|---|---|---|

**Ward rollout record:**

| Ward | Go-live date | Two weeks ended | G6(a) | G6(b) | G7 | Go / no-go | Signed (MS) |
|---|---|---|---|---|---|---|---|

**Defects log** — anything seen that this page does not predict:

| # | What happened | What was expected | Raised as |
|---|---|---|---|
