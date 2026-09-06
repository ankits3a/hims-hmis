# Laboratory go-live runbook — Plan 17 (17a + 17b)

**Status, corrected 2026-09-06 (11i T6 / D10): THE MODULE IS DEPLOYED AND THE LABORATORY IS NOT
OPEN.** Those are different sentences and the difference is the whole of this file. `lab_*` has been
on production since migration `0046`; five controllers serve; four screens are in the nav. What has
never happened is any of the acts below — so a clerk who reaches `/lab/desk` today gets a working
screen and an empty catalogue, and until 11i T1 they would have got `no_active_definition` on the
first order they placed.

The old line here read *"CODE-COMPLETE and NOT DEPLOYED"*, which was true when it was written and
became false at the deploy that carried `0046`. A status line records a MOMENT; this one is dated.

It is the ordered list of acts that turn a shipped module into a laboratory, and every step names
who performs it and what proves it worked.

**Read [`../superpowers/plans/reports/2026-08-30-plan-17-gate-report.md`](../superpowers/plans/reports/2026-08-30-plan-17-gate-report.md)
first.** It says what is proven by execution, what is proven by reading, and what is not proven at
all. This runbook assumes you have read that list and are proceeding anyway.

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**GRANT THE ROLES, NOT ONLY THE PERMISSIONS.** A login holding all fifteen `lab.*` permissions and
none of the four lab ROLE KEYS reaches every route and then cannot draw blood:
`ordered → awaiting_collection` is a workflow transition, and `kernel/workflow/instances.ts` checks
the definition's declared **roles** against `user_roles` — permissions are not consulted at all.

The refusal is a 403 reading *"transition ordered→awaiting_collection allows roles: lab_reception,
lab_technician, phlebotomist"*, which is honest and completely baffling to somebody who has just
granted fifteen permissions. **It was found by `lab.e2e.test.ts` and by nothing else in the phase**
(§9.2 F39); 243 service-level tests were green because their fixtures build users with real roles.

The four role keys are `lab_reception`, `lab_technician`, `phlebotomist`, `pathologist`.

**AND THEY ARE FOUR HUMANS, NOT ONE LOGIN PASSED AROUND** (11i §2b row 19). DD11 refuses a
self-verify by comparing the person who keyed a result with the person signing it — so a bench that
shares one account has a control the system believes in and nobody exercises. Nothing in the build
can detect a shared login; this sentence is the only place it is refused, which is why it is here
rather than assumed.

---

## 1. Preconditions

| # | precondition | how to check |
|---|---|---|
| 1.1 | Production carries the lab's tables. `0046` is the thirteen of them; the catch-up deploy of September 2026 takes production from **56** applied migrations to **78** (`docs/runbooks/catch-up-deploy-2026-09.md`). Read the count, never remember it | `docker exec hmis-prod-db-1 psql -U hmis -d hmis -qAt -c "select count(*) from drizzle.__drizzle_migrations"` |
| 1.2 | `hmis-prod` is serving and the SPA loads | the smoke check the deploy runbook already carries |
| 1.3 | A SECOND administrator exists | production has had exactly one full admin since commissioning; the laboratory adds four roles and a signing act, and one pair of hands cannot hold all of it |
| 1.4 | The owner has the catalogue spreadsheet ready | §4 — nothing below can be tested without real orderables |

**1.3 is a blocker and not a nicety.** DD11's separation of duties is the module's central control;
a deployment with one human who holds every role satisfies none of it, and night mode (§7) is a
relaxation of a control that must exist before it can be relaxed.

---

## 2. The department and the pathologist of record

The lab's walk-in rides a `V` visit (DD15 / spike S2), and `openVisitInTx` requires a department AND
an active doctor in it. **Neither exists in production today** — spike S5 measured twelve
`opd_departments` and no `LAB`.

1. Create the department: code `LAB`, name `Laboratory`, `active = true`.
2. Create the pathologist of record as an `opd_doctors` row **in that department**, with the real
   `registration_no` (the NMC/state council number that will print on every report's signatory block)
   and `user_id` pointing at their login.
3. Confirm `doctor.department_id = LAB.id` — `openVisitInTx` validates the pair, and a doctor in the
   wrong department fails the FIRST walk-in rather than at seed time.

> **The registration number is a legal fact, not a display string.** It is what makes a laboratory
> report a document a court will read. Get it from the certificate, not from memory.

**The back-book** (11i §2b row 2). The hospital's existing paper patients arrive at the desk with an
old file number. Key it into the patient's **legacy UHID** field (`patients.legacy_uhid`, D-43) at
registration, so the paper file and the new record can be reconciled later by somebody who was not
there. The bulk loader for the back-book is a later phase (11k) — until it exists, this is one field
typed by the person holding the file.

---

## 3. Roles, permissions and the three kernel grants

### 3.1 The fifteen the module declares

`lab.orders.place`, `lab.catalogue.read`, `lab.catalogue.manage`, `lab.desk.operate`,
`lab.collection.operate`, `lab.accession.operate`, `lab.results.enter`, `lab.results.verify`,
`lab.results.read`, `lab.reports.publish`, `lab.reports.print`, `lab.reports.amend`,
`lab.reports.release_unpaid`, `lab.criticals.close`, `lab.worklist.read`.

### 3.2 Who holds what

| role | holds | does NOT hold, deliberately |
|---|---|---|
| `lab_reception` | `desk.operate`, `orders.place`, `catalogue.read`, `worklist.read`, `reports.print`, `results.read` | anything that signs. A counter clerk hands reports over all day and could never have signed one. |
| `phlebotomist` | `collection.operate`, `catalogue.read`, `worklist.read` | `results.enter`. Drawing blood is not keying a number. |
| `lab_technician` | `accession.operate`, `collection.operate`, `results.enter`, `criticals.close`, `worklist.read`, `catalogue.read`, `results.read` | `results.verify`. **This is DD11 and it is the whole control.** |
| `pathologist` | everything above plus `results.verify`, `reports.publish`, `reports.amend`, `catalogue.manage` | `reports.release_unpaid` — see below. |

**`lab.reports.release_unpaid` is granted to `billing_manager` and to NOBODY in the laboratory.**
The decision to hand over a report against an unpaid bill is a decision to carry a receivable, and
it belongs to the money office. A pathologist holding it would be the person under pressure from
the patient at the counter deciding the hospital's credit policy.

### 3.3 The three kernel grants the lab roles also need

`orders.place`, `orders.read`, `orders.cancel` — the envelope's own permissions, held IN ADDITION
to `lab.orders.place` (phase 0 DD6). A lab role without `orders.place` places nothing.

### 3.4 The billing grant DD6 makes unavoidable (17a §9.2 F2)

`billing.credit.extend` to `pathologist`, `lab_technician` and `lab_reception`. `issueInvoice`
refuses an invoice with a remainder and no credit block, AND requires the ACTOR to hold this
permission — so every reflex, add-on and walk-in line the laboratory raises on credit needs it.
`billing.credit_note.issue` is needed by whoever cancels a lab test (DD7's refund).

### 3.5 And the roles themselves — §0

Assign the four ROLE KEYS at `hospital` scope to the humans. Read §0 again if you are tempted to
skip this because the permissions are already granted.

---

## 4. The catalogue

**The golden catalogue in `test/fixtures/lab-catalogue.json` is a TEST fixture and must not be
seeded into production.** It has 130 analytes and 64 orderables chosen to make a test suite
executable; the hospital's catalogue is the owner's data.

1. Take the owner's spreadsheet: for each test — the lab's own code, the English and Hindi names,
   the discipline, the specimen type and container, the routine (and STAT) turnaround in minutes,
   the bench, and the analytes it reports.
2. For each ANALYTE — the code, the names, the result type, the unit, the decimals, the absurd
   envelope, the critical band, the delta rule, and the formula if it is calculated.
3. For each analyte — the REFERENCE BANDS, with `source` naming where the range came from. NABL asks.
4. Load through `POST /lab/catalogue/analytes` then `POST /lab/catalogue/orderables` — in that order,
   because an orderable naming an analyte that does not exist is refused `unknown_analyte` by name.
5. **Every orderable needs a TARIFF price** in the active version. An unpriced orderable fails at the
   DESK with `tariff_item_missing` in front of a patient, not at seed time.

**Three refusals you will meet and should:**

- `foetal_sex_refused` — an investigation that reports foetal sex cannot be catalogued. PCPNDT Act
  1994. It is not a configuration option, and the database refuses it independently.
- `catalogue_invalid` on a formula analyte — the expression is parsed at upsert, which is the only
  moment a bad formula is cheap to refuse.
- `unknown_analyte` — named, not counted, so you can find the three that are missing.

**Reflex rules ship INACTIVE and stay inactive until the owner decides.** A reflex is an order the
system places and the patient pays for.

---

## 5. The workflow definitions and the approval type

**NOTHING TO DO HERE ANY MORE. THE DEPLOY DOES IT** — 11i T1, and this section is the correction
D10 names.

`seed:lab` runs on every deploy, after `seed-pharmacy` and before `seed-roles`, and it:

1. activates `lab_item` and `lab_specimen`, both change-class **C** — a departmental operating flow,
   which is precisely why a deploy may establish it. Class A and B definitions are never established
   by a deploy (11i D2; `seed-ot`'s DD6 is the boundary);
2. registers `lab_release_unpaid` (approver `billing_manager`, urgency `urgent`, **no act-first**,
   60-minute SLA) and drafts its `approval_lab_release_unpaid` definition.

It is idempotent: a second run neither drafts a redundant version nor throws.

**Verify it, do not perform it:**

    standup:check lab

Expect `ok` on `lab_definitions_active` and `lab_approval_type_registered`. The deploy's
configuration gate (`check-config-present`) also refuses outright if either definition is inactive,
so a deploy that reached the end established them.

> **What this section said before, and why it was wrong.** It read *"the activation is the owner's
> §10.4 act. It is not a deploy step."* That predates Plan 11g / DD2 reaching the lab — *the deploy
> establishes the rows its own modules throw without* — and the cost of the old sentence is
> measurable: the lab was deployed on production from `0046` and could not take a single order,
> because `activateLabDefinitions` had exactly one caller in the tree and it was a test helper.

---

## 6. Benches, resources and the physical laboratory

The lab declares resource kinds (17a T2) and `lab_orderables.bench_key` is plain text the worklist
resolves. Create one `resources` row per real bench — haematology, biochemistry, serology — and set
`bench_key` on each orderable to match. **Nothing enforces the pairing**, so a typo produces a
worklist that silently omits a bench. Check by reading `GET /lab/bench/worklist` once per bench with
a live order on it.

**THE PRINTERS, AND THERE IS NO REGISTRY OF THEM** (11i §2b row 14). Three devices sit at three
seats: the label printer at collection, the A4 report printer at the report centre, the receipt
printer at the counter. `print_jobs` exists (server-side printing, ruled 2026-09-04) and label
printing is browser-driven; **no table names a destination**, so the census reports this row as
`NOT MODELLED` and points here rather than pretending.

The artefact is a record, not a row: **one test print per device per seat**, written into the
`## Executed on UAT` section below with the date and the person who watched it come out. A seat
whose printer was never proved is a seat that discovers it with a patient waiting.

---

## 7. Night mode, and what it actually is

DD11 permits a single operator to release their own result when nobody else is available. **In this
build that is derived from the IST clock — 21:00 to 07:00 — and not from a per-deployment flag**
(§9.2 F34): the `single_operator_night_mode` field DD11 describes does not exist on the workflow
definition, and `workflow-def.ts` was frozen for this phase.

What that means operationally:

- Between 21:00 and 07:00 IST a pathologist who keys a result may sign it, and the row is stamped
  `pathologist_review_pending = true`. **The printed report says PROVISIONAL.**
- Those rows are the morning queue. Somebody must work it, and this build ships no screen filter for
  it — read `lab_results` where `pathologist_review_pending` is true.
- Between 07:00 and 21:00 the same act is refused `sod_violation` and the refusal is EVENTED
  (`lab.sod_violation_blocked`). NABL asks how often the single-operator path was used; that event
  is the count.
- **A technologist cannot use night mode**, because `resulted → verified` declares `pathologist`
  and the workflow engine checks the role. Night mode is for the solo pathologist on duty.

17-E is the phase that adds the real per-deployment switch.

---

## 8. The paper downtime path (02 C3 / C4)

When the label printer is down:

1. Use the pre-printed downtime kit. Post the label with `labelSource: "downtime_kit"` and the kit's
   `downtimeKitSerial`. The schema refuses a printer label carrying a serial and a downtime label
   carrying none, in both directions.
2. The kit serial is mapped to the tube AT ACCESSION, so the bench can reconcile paper to system.
3. When the core itself is down, results are keyed afterwards with
   `entryMode: "manual_from_printout"` — a distinct value, so a later audit can tell a keyed
   printout from a keyed reading.

**There is no downtime path for the SIGNATURE.** A result entered from a printout is still verified
by a second pair of hands through the system.

---

## 9. The pilot window

Run the laboratory as a SECONDARY system for the agreed window: every test goes through both the
existing process and this one, and the paper record remains authoritative until the window closes.

**Harvest, per day of the pilot:**

| what | why |
|---|---|
| every `lab.sod_violation_blocked` | how often one pair of hands tried to sign its own number |
| every `lab.report_print_blocked` | whether the interlock is firing on real bills or on data problems |
| every `lab.tube_mismatch_flagged` | the near-misses. A count of zero here is a claim, not a result |
| every open `lab_critical_calls` row at 07:00 | calls that did not close on a read-back overnight |
| `absurd_overridden_by` on any result | who vouched for a value outside the envelope |
| every orderable that met `tariff_item_missing` | the catalogue's own gaps, found at a counter |
| **merges per day** (`patient_merge` approvals raised) | 11i §2b row 4 — a paper-parallel pilot MINTS duplicates: the same person walks in twice and the desk, unsure, registers again. The approval type is registered by the deploy; the count is what says whether the desk needs a better search or the pilot needs a rule |

**Close the window only when the last three are empty for a full week.**

---

## 10. Drills — run these before the pilot, not during it

### Drill A — a critical value at 02:00 with no pathologist logged in (02 F1 / E34)

> **RUN IT AFTER 21:00 IST, OR RECORD IT AS NOT PERFORMED, DATED** (11i §2b row 18, DECIDED). Night
> mode is derived from the IST clock (§7) and there is no per-deployment switch to fake it. A drill
> "performed" at 14:00 by pretending is a drill nobody ran; the honest entry in the section below is
> *not performed on <date>, no night window available*, and it stays on the list.
>
> **And the number the bench rings is not in the system** (§2b row 6). `lab_critical_calls` records
> the call; `opd_doctors` has no phone column and `kernel/notify` has console adapters only. The
> artefact is a **printed call list at the bench, refreshed weekly**, and this drill is where it is
> checked: the person doing step 4 must be able to reach a clinician from paper on the bench.

1. Order a potassium, draw it, receive it.
2. As the technologist, key **6.8**.
3. **Expected:** the entry succeeds, a `lab_critical_calls` row opens IMMEDIATELY, and
   `lab.result_critical_flagged` is emitted — **before any verification**. The bench screen says a
   call has been opened.
4. Record three failed attempts. **The call stays open.** Record a read-back. **It closes.**
5. **What this proves:** the 15-minute clinical need is the telephone call, not the signature. A
   build that opened the call at verification would ring nobody at 02:00.

### Drill B — a rejected tube on a patient who has gone home

1. Order, label, draw, receive.
2. Reject the tube as `haemolysed`, attributable to `collection`.
3. **Expected:** a NEW specimen with its own `S` number, the item at `recollection_pending`, the old
   links inactive, **and no invoice**. The patient is not billed twice because the lab dropped the tube.
4. Leave it. After seven days the non-return sweep cancels the item and issues the credit note.
5. **What this proves:** DD7 on the path a patient never sees.

### Drill C — the printer is down

1. Put the label printer out of action.
2. Print a label with `labelSource: "downtime_kit"` and a kit serial.
3. Receive it, quoting the same serial.
4. **Expected:** the tube carries `label_source = 'downtime_kit'` and its serial, and the chain
   proceeds unchanged.
5. **What this proves:** a laboratory that stops when a printer stops is a laboratory on paper.

### Drill D — the hospital's internet drops for fifteen minutes with a patient at the desk

New in 11i (§2b row 16). The server is remote; the desk PCs reach it over the hospital's link, and
that link goes down. Nothing in this build has ever been watched through that, and the downtime kit
(§8) answers the LABEL printer failing, which is a different failure.

1. Start a registration at the front desk, with a real person in front of you.
2. **Pull the desk PC's network cable** (or drop its wi-fi) mid-form.
3. Wait fifteen minutes. Try to continue. **Record exactly what the screen did** — did it say
   anything, did it keep the fields, did it offer anything to write down.
4. Reconnect. Finish the registration. **Record whether the work survived.**
5. **What this proves, or fails to prove:** whether a fifteen-minute outage costs the desk one
   patient's typing or a morning's. Whatever it does is the answer; if it is bad, that is a defect
   logged against the front desk, not something to work around at the counter.

---

## 11. What this build does NOT do

Stated here so nobody discovers it at a counter:

- **No analyzer interface.** Every number is keyed. `entry_mode = 'interface'` does not exist (17-E).
- **No auto-verification.** The engine ships with zero rules and a `system` actor is refused at
  verify outright.
- **No QC, no reagent lots, no cultures, no send-outs, no histology** (17-E, 17-M, 17-H).
- **No LOINC.** The column exists and is null.
- **No PDF renderer.** The report prints from the browser.
- **No patient-app access to results** (22c-F).
- **No KPI registry.** 02 §8's KPI lines are NOT registered anywhere, because Plan 21's registry does
  not exist. The pilot harvest in §9 is the manual substitute.
- **The `lab_item` machine has no `resulted → cancelled` or `verified → cancelled` edge** (§9.2 F37).
  A test withdrawn after its number is keyed cancels on the ENVELOPE and the lab instance is left
  where it stands. Nothing reads it — every worklist and sweep keys off the envelope — but a phase
  that may edit `workflow-def.ts` should add the two edges.

---

## 12. Rollback

The module mounts five controllers and installs one manifest. To take it out of service without a
migration:

1. Remove `LabModule` from `app.module.ts` and deploy. Every `/lab/*` route 404s; the SPA's four
   links disappear with the permissions.
2. **Do not drop the tables.** `lab_results` and `lab_reports` are a medical record and
   `lab_reports` is immutable by trigger. A laboratory that ran for a day has produced documents a
   patient may hold.
3. The catalogue, the definitions and the approval type are data and stay.

## 13. The five seats — a walk-through drill (Plan 17c)

> **This section was numbered 11 and so was "What this build does NOT do".** Two sections with one
> number is a runbook that cannot be cited: 11i §2b row 7 pointed at "§11" and could have meant
> either. Renumbered to 13 by 11i T6 / D10; nothing in it changed.

Run this once with a real person at each seat before the pilot window (§9), on one patient — **and
on the four more that 11i §2b names below** — in this order.

**BEFORE STEP 1: OPEN THE CASHIER SESSION** (§2b row 13). The lab counter takes money, and
`recordReceipt` refuses without an open drawer session. A walk-through that skips this discovers it
at the first patient who pays cash.

**THE PEOPLE THIS WALK MUST CARRY**, beyond the one patient the original drill named — each is a
row of 11i §2b and each is a real Indian day, not an edge case:

| # | who | why the walk must include them |
|---|---|---|
| 1 | a patient with **one name and no surname** | §2b row 1. The desk accepts it or it does not, and no census has ever asked |
| 2 | a patient with **no mobile number** | §2b row 1. Half a walk-in queue has none |
| 3 | a **family sharing one mobile** across UHIDs | §2b row 1. Five records, one number, and the search must not merge them |
| 4 | a **minor with a guardian**, consent read aloud once | §2b row 12. DPDP: the consent text on the screen is the hospital's, and somebody has to hear it said |
| 5 | **one seat run in Hindi** | §2b row 21. `hi.json` covers the shell and the front desk; every untranslated string you meet is a defect to log, not to shrug at |

A refusal on any of rows 1–3 is a **defect logged against registration (FD-25)**, never something to
work around by inventing a surname or a phone number.

 It is `test/lab.e2e.test.ts`'s "17c T6" walk done by hand; every step has a route
behind it that the walk exercises, so a step that fails here is a configuration fault, not code.

1. **Reception (`/lab/reports` is NOT this seat — `/lab/desk` is).** Scan the front-desk token or
   type it (`T-118`), or the UHID, or the name. A token resolves to ONE visit; a name to candidates
   you confirm by sex, age and UHID. The Rx lines the doctor advised are already on the screen.
   Untick "billed here" on any line the patient is not paying for now: it rides on credit and the
   report is HELD until settled. A patient with no visit today goes through the walk-in door — the
   `V` visit opens under the pathologist of record (§2). A patient with no record at all: "Register
   a new patient", four fields. **Save — send to collection.**
2. **Collection (`/lab/collection`).** The patient is on the queue with the token before any label
   exists. Scan the wristband (the field is empty on purpose — never pre-filled), **Print labels**:
   one label per tube in order of draw. Fill each tube and scan ITS barcode into ITS row; a scan of
   another tube's number is refused on the screen. **Drawn — N tubes to the lab** lights when all
   are scanned. A ward tube labelled on the ward is drawn here too, and says the bench will re-check.
3. **Bench (`/lab/bench`).** Scan the tube: it resolves against what is on the bench, then against
   what has arrived; anything else is "not drawn here today". A tube drawn without a wristband scan
   needs a NAMED re-checker before **Receive** (which starts the TAT clock). Key every analyte; a
   value outside the absurd envelope needs a second named enterer; a critical opens the call by
   itself. **Save & complete** posts one record per value.
4. **Verify (`/lab/verify`).** Criticals and STAT first. Each result sits against its range, the
   last SIGNED previous value and the delta, and the clock against its target. **Sign N results**
   is N signatures; a result you keyed yourself is refused (DD11). **Publish report.**
5. **Report centre (`/lab/reports`).** The register shows the day's reports and how each went out:
   notice queued/sent, HELD with the amount, in person only. Find the patient by UHID or mobile;
   a HELD report shows the amount and no page — the print lights the moment billing settles it, or
   **Ask the billing manager to release** (an approval about the order, DD6) and release with the
   granted id. Record the collector's name and relation. **Print & hand over.**

Expected at the end: one delivery row, one `phi_access_log` row per counter read, the ready notice
in `notifications`, and the doctor's screen showing every result from the moment of signature.

**AND THE NOTICE MUST BE FOUND QUEUED AND NOT SENT** (11i §2b row 7) — asserted, not assumed.
`kernel/notify` has console adapters only: there is no provider, no TRAI DLT sender-id or template
registration, and no approved WhatsApp template. **No patient message leaves this building.** Read
the `notifications` row and confirm its state is queued; if anything says it was delivered, that is
a finding and the pilot does not start until it is understood. The census reports this row as
`NOT MODELLED` and points here.

---

## 14. Executed on UAT — **NOT YET RUN**

**This section is the phase's gate.** 11i closes when this is performed and dated, not when a test
suite is green: everything above is a claim about what would happen, and only this is a record of
what did. Written empty on 2026-09-06 by 11i T6; fill it in as you go, and leave the rows you could
not do as *not performed*, dated, with the reason. **A step performed and not recorded is a step
nobody can check.**

### 14.0 Standing UAT up first

UAT is the same build as production, in its own compose project, on this box (11i T3). It needs
`/opt/hmis-uat/` with its own `.env` carrying the usual keys plus three of its own:

    HMIS_UAT_SITE=<this box's IP>
    HMIS_UAT_BASIC_AUTH_HASH=<docker run --rm caddy:2-alpine caddy hash-password --plaintext '…'>
    HMIS_SYNTHETIC_DATA_OK=1
    HMIS_ENVIRONMENT_LABEL=UAT

Then, through the test mutex (a docker build is a builder, and this box runs other people's suites):

    /opt/hmis-lanes/.orchestrator/bin/test-lock.sh run commissioning \
      bash -c 'HMIS_TARGET=uat bash /opt/hmis/docker/prod/deploy.sh'

**Expected:** `8/8`, and the edge gate answering `https://<ip>:8443/api/health` with JSON and
`/admin/users` with a 401 behind basic auth. **Avoid 22:00–23:00 UTC on a Saturday** — production's
weekly restore drill owns that hour and the two compete for this box.

`8443` is held by the front-desk preview stack until somebody stops it (`docker stop
hmis-preview-caddy`). The AERB demo bench on `:8444` must **stay** until the catch-up deploy's step
2c has used it.

### 14.1 The rows to fill

| # | act | what you saw | when |
|---|---|---|---|
| 1 | `HMIS_TARGET=uat deploy.sh` → 8/8 and the edge gate | | |
| 2 | the environment banner is on the LOGIN screen, and the tab icon changed | | |
| 3 | `standup:check lab` — every RED row, copied | | |
| 4 | `seed:lab-catalogue` (behind the synthetic-data door) | | |
| 5 | four accounts created at `/admin/users`, on the real screen — `lab_reception`, `phlebotomist`, `lab_technician`, `pathologist`, at HOSPITAL scope, **four humans** (§0) | | |
| 6 | a SECOND administrator (§1.3) | | |
| 7 | `LAB` department + pathologist of record with a real `registration_no` (§2) | | |
| 8 | `seed:lab-demo` (both doors) | | |
| 9 | `standup:check lab` — **green** | | |
| 10 | §13 walk-through, seat 1: **three registrations** — one name only, no mobile, a family-shared mobile (§2b row 1) | | |
| 11 | §13 walk-through, seat 1: **a minor with a guardian**, consent read aloud (§2b row 12) | | |
| 12 | §13 walk-through: **one seat run in Hindi**, every untranslated string logged (§2b row 21) | | |
| 13 | §13 walk-through, seats 2–5, on one patient, end to end | | |
| 14 | the ready notice found **queued and NOT sent** (§2b row 7) | | |
| 15 | **one test print per device per seat** — label, A4, receipt (§6, §2b row 14) | | |
| 16 | drill A, after 21:00 IST — or *not performed*, dated (§2b row 18) | | |
| 17 | drill B | | |
| 18 | drill C | | |
| 19 | **drill D** — the network pulled mid-registration (§2b row 16) | | |
| 20 | the cashier session opened before seat 1 (§2b row 13) | | |

### 14.2 Defects found

A step that could not be performed as written is a **defect**, recorded here and fixed in the
runbook or in the code — never narrated around. List them with the row number they came from.

| row | what could not be done as written | where it was fixed |
|---|---|---|
| | | |
