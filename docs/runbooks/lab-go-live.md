# Laboratory go-live runbook — Plan 17 (17a + 17b)

**Status: the module is CODE-COMPLETE and NOT DEPLOYED.** Nothing in this file has been run against
production. It is the ordered list of acts that turn a shipped module into a laboratory, and every
step names who performs it and what proves it worked.

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

---

## 1. Preconditions

| # | precondition | how to check |
|---|---|---|
| 1.1 | Production is at migration `0048` or later — `0046` is the lab's thirteen tables | `docker exec hmis-prod-db-1 psql -U hmis -d hmis -c "select count(*) from drizzle.__drizzle_migrations"` |
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

1. Run `activateLabDefinitions` — it drafts and activates `lab_item` and `lab_specimen`, both
   change-class **C** (a departmental operating flow, activated by the lab's own head rather than
   by the owner-plus-MS two-key an OPD visit needs).
2. Run `registerLabApprovalTypes` — it registers `lab_release_unpaid` (approver `billing_manager`,
   urgency `urgent`, **no act-first**, 60-minute SLA) and drafts its `approval_lab_release_unpaid`
   definition. **It is idempotent**: a second run neither drafts a redundant version nor throws.
3. Confirm both: a `startInstance` against `lab_item` throws `no_active_definition` when step 1 has
   not run, and `requestApproval` throws `unknown_type` when step 2 has not. Both are the honest
   failure and both have reached production before in other modules — `patient_merge` was
   unregistered from Plan 05 until 2026-08-26 and every merge request threw the whole time.

**The activation is the owner's §10.4 act.** It is not a deploy step.

---

## 6. Benches, resources and the physical laboratory

The lab declares resource kinds (17a T2) and `lab_orderables.bench_key` is plain text the worklist
resolves. Create one `resources` row per real bench — haematology, biochemistry, serology — and set
`bench_key` on each orderable to match. **Nothing enforces the pairing**, so a typo produces a
worklist that silently omits a bench. Check by reading `GET /lab/bench/worklist` once per bench with
a live order on it.

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

**Close the window only when the last three are empty for a full week.**

---

## 10. Drills — run these before the pilot, not during it

### Drill A — a critical value at 02:00 with no pathologist logged in (02 F1 / E34)

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

## 11. The five seats — a walk-through drill (Plan 17c)

Run this once with a real person at each seat before the pilot window (§9), on one patient, in
this order. It is `test/lab.e2e.test.ts`'s "17c T6" walk done by hand; every step has a route
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
in `notifications` (it will NOT be sent until the WhatsApp template is approved — §0's owner action),
and the doctor's screen showing every result from the moment of signature.
