# Plan 17-F — the five Central Lab stations, from the approved board to code

Status: **PROPOSED, awaiting owner approval** (26 Sep 2026). No phase starts before the owner approves this plan's PR.

## Context

On 25 Sep the owner asked for "a live artifact to test the LIMS module … from order received from Emergency, from
OPD, from IPD, walk-in … close the order successfully". His priorities: user experience, speed, accuracy,
auditability, compliance, accountability, and escalation when something is not acted on in time.

He rejected a simulator and approved, station by station, a clickable 3-column app:

- **Spec:** https://claude.ai/artifact/Q55XsWxk8h4rpBK7XfhAN2, version 19, copied into
  `docs/design/2026-09-25-lims-stations/` with its seven Playwright walks. **That board is the spec.**
- **Stations:** Reception → Collection → Bench (by patient / by run) → Verify & Release → Reports (a view inside
  Reception) → Supervisor.

This plan turns the board into code in nine phases. Each phase is its own lane and its own PR.

## Owner rulings (money and law only)

Quoted as given, 25–26 Sep 2026. Industry exceptions marked DECIDED follow the owner's standing instruction.

1. **No token until billed.** Industry exceptions (DECIDED): Emergency/STAT is drawn first and billed later under the
   ordering doctor's waiver; IPD goes on the running bill; corporate, TPA and schemes go on credit against the letter.
2. **No discount at the counter.** The lab supervisor may approve **at most 10%** with a reason. More goes to the
   medical superintendent in writing.
3. **Wallet is deduct-only** at the lab. Advances are taken only at the front desk.
4. **Every phone linked to the patient receives the report.** Carve-out (law, HIV and AIDS Act 2017 s.8): HIV
   results are handed over in person only.
5. **No refund after the sample is drawn.**
6. **The lab counter never registers a patient.** A walk-in is sent to the front desk (25 Sep).
7. **No refund after the TOKEN.** A patient who refuses or leaves goes back to reception with the order held.
8. **Not fasting:** rebook free, or hold the order up to 7 days. Home-collection visit charge: **none for now**.
9. **Reflex tests:** consent is asked at Reception (optional yes/no). A reflex test is billed on its own bill; only
   that part of the patient copy is held until paid; if the patient said no, the doctor is told.
10. **A redraw caused by the hospital is always free.** It is charged to collection or transport.
    Standing instruction: "default to top-hospital standards" for any lab money question not yet ruled.
11. **Printed lab report ("medical college & hospital norms"):**
    - the signing pathologist is named in full: name, MD (Pathology), designation, Doctor ID, e-signature time, QR;
    - the referring doctor prints as Doctor ID + department (the 06 Sep ruling);
    - no auto-verification; batch signing of all-normal reports is allowed, logged per report.
12. **A held patient copy is released unpaid ONLY by the billing manager, and the dues stay on the account**
    (26 Sep). The doctor's copy is never held.
13. **The signing pathologist's council registration number stays on the printed lab report** (26 Sep, on this plan's
    PR), alongside the ruling-11 fields. This is the lab-report exception to the 06 Sep "Doctor ID only" print rule,
    which still governs the referring doctor.

**Layout rules** (owner, apply to every station): menu in the HEADER; left lane = the patient (or run, or escalation)
in hand; right = ONE list with NO filter tabs, then "Clocks running" collapsed; opening something shrinks the list to
one line and opens the copilot panel; dark colour only as a highlight, no dark panels; no button that only records
presence; the next act sits in a pinned dock and Enter runs it; nothing duplicates the right-hand list.

## What exists (survey re-checked on main `2151c451`, 26 Sep)

**Web.** Five lab screens — `apps/web/src/screens/lab-desk.tsx`, `lab-collection.tsx`, `lab-bench.tsx`,
`lab-verify.tsx`, `lab-reports.tsx` — all in the greyscale `LabSeatFrame` (`lab-seat.tsx:33`). Routes at
`router.tsx:275-280` (nav) and `:1024-1098` (route objects); API client `lib/lab-api.ts`. No shared 3-column shell
exists: the pharmacy desk hand-builds one (`screens/pharmacy-desk/pharmacy-desk.tsx:436-495`, `rails.tsx`,
`desk-one/desk-one.css` `.rail`); Desk One's `SeatShell` is at `desk-one/seat-shell.tsx:53`.

**Core** (`apps/core/src/modules/lab/`, about 60 routes over 5 controllers):
- desk orders with preview; reflex consent written at the desk (`desk.ts:472`);
- labels and collection; receive/reject with the relabel witness (`accession.ts:140`);
- result entry with `absurd_value` and the second-person override `absurd_override_same_actor`
  (`results.ts:516-525`), and a rerun choice; items become `resulted` **automatically** when the last analyte has a
  value (`results.ts:1171` onward);
- verify: the verifier cannot sign their own entry, `sod_violation` (`verify.ts:465`), except the night
  single-operator window 21:00–07:00; rerun back to the bench;
- the critical-call ladder, closed only by read-back (`criticals.ts`);
- reports: versioned publish and amend (`reports.ts:587`); delivery hold for unpaid bills (`interlock.ts:65`) and
  `release_unpaid` for the billing manager; sensitive reports in person only (`reports.ts:466`);
- instrument registry with `sample_id_mode` barcode / typed_id / run_sheet / plate_map and statuses including
  `qc_locked` and `interface_down`; ingest with parking (`ingest.ts`);
- services with **no routes**: `run-sheets.ts`, `plate-maps.ts`, `inbox.ts`.

**Reusable elsewhere:** the step-up guard `secondFactor: true` (`kernel/auth/guards.ts:114`, used by radiology
sign); kernel escalation — `kernel/workflow/timers.ts` → `escalation.triggered` → alert rows
(`kernel/alerts/consumer.ts:205`) and staff notifications (`kernel/notify/consumer.ts:204`), the `duty_manager`
fallback, the roster override; the OPD queue display and voice announcer (`modules/opd/queue.ts`); billing discount
approval (`billing/invoices.ts:66`, approver role `billing_manager`).

**Roles:** `lab_reception`, `phlebotomist`, `lab_technician`, `pathologist`, `lab_bridge`, and `billing_manager` for
release unpaid — seeded in `apps/core/scripts/seed-roles.ts`, counts pinned by `test/seed-roles.test.ts`.
**Highest migration on main today: `0132_abdm_messages.sql`** — every phase takes the next free number at rebase.

## Gaps the board exposes

1. No QC module. Nothing writes `qc_locked`.
2. Critical and lab SLA breaches page nobody: `lab_sla_breaches.notified` is always false (`sweeps.ts:303`), and lab
   critical events go only to realtime.
3. No routes for run sheets, plates or the inbox; `lab.instruments.operate` is granted but guards nothing.
4. No bench review before the pathologist, and no batch completion.
5. No lab token. One order belongs to one encounter (`desk.ts:262`); "T-118" is the OPD queue token. No dedupe of a
   test ordered on two visits.
6. The lab desk has no discount: `deskOrder` calls `issueInvoice` with no discount inputs and mints line ids itself
   (`desk.ts:432-444`).
7. No patient draw flags (arm restriction, faints, bleeding risk). No fasting hold or rebook; `requiresFasting` is a
   flag only.
8. Deliveries have no counselling record and no collector relation. No WhatsApp→SMS fallback for patients. No
   delivered or read receipts: the WhatsApp and SMS adapters are console stubs (`kernel/notify/adapters.ts:55`), and
   `notification.delivered` is deliberately undefined.
9. No patient-mobile OTP service (only staff TOTP and ABHA).
10. No `lab_supervisor` role, supervisor read model or quality-week register.
11. The lab report print (`apps/web/src/components/lab-report-print.tsx:242`) prints name + council registration; no
    qualification, designation or Doctor ID. No lab renderer in `kernel/printing/render.ts`.
12. Materials has no indent flow, so tube-stock requests cannot be approved yet.

## Phases

Each phase is its own lane and PR. One migration per PR, numbered at rebase. A new test fails first against the code
it guards. Each web phase is walked in Chromium at 1920/1440/1280/1100/1024/768/390 against the board before it is
called done.

### F1 · Station shell (web only)
- Extract `apps/web/src/components/station/StationShell`:
  - header with the menu and a station switch for multi-role users;
  - 296px lane, centre, 352px right list with Clocks collapsed;
  - copilot panel that opens as the list shrinks.
- Breakpoints: drawer below 1280, Menu below 1100, station switch into the Menu at 1000.
- Built from the Desk One tokens (Paper & Pine: paper `#f4f7f4`, ink `#132420`, green `#0e6b4e`, gold `#dd8f1c`,
  red `#b23a30`, mint `#35c48f`; IBM Plex).
- Rewrap the five lab screens with **no behaviour change**.
- Claims: `router.tsx`.

### F2 · Reception counter
- Core:
  - `lab_tokens`: a daily sequence; one token joins the orders of several visits of one patient;
  - dedupe a test present on two visits: billed once, a shared line on the other visit;
  - lab discount approval (`lab/approval-types.ts`): approver `lab_supervisor`, **10% cap enforced server-side**;
  - wallet deduct-only.
- Needs an additive optional param in `billing/invoices.ts` for caller-supplied line ids. **Coordinate: shared
  module.**
- Web (`lab-desk.tsx`): the left lane lists today's visits; the centre is the visit's prescription → order stepper
  (Tests → Checks → Bill → Token) with a pinned action bar; reflex consent as an optional check.
- Migration: `lab_tokens`.

### F3 · Collection chair
- Core:
  - `lab_draw_notes`: lab-owned, keyed on patient (arm restriction, faints, bleeding risk, small veins); it stays out
    of the shared patients module;
  - refusals `arm_restricted`, `not_fasting`, `draw_not_due` (GTT);
  - a 7-day fasting HOLD that expires like the `recollection_pending` sweep; rebook with no charge;
  - token call through the OPD announcer.
- Web: "Scan the slip or search the patient"; opening a patient means they have arrived, so no Call or "in the chair"
  buttons (a bell icon calls); a scan identifies the patient and prints labels; draw rows with a tube drawing,
  barcode, printed time and filled time; reprint only with a witness.
- Migration: draw notes + hold.

### F4 · Bench, by patient and by run
- Core:
  - routes for run sheets (open / scan / start), plate maps and the parked inbox (match / discard) over the existing
    services, behind `lab.instruments.operate`;
  - DECIDED: a bench review gate (`lab_items.reviewed_by/at`). Verify lists only reviewed items. Batch
    `POST lab/bench/complete` for a run's clean patients; exceptions are refused per item (critical before read-back,
    haemolysed, big change, blast flag);
  - per-test routing to an instrument, including the backup: Curio Lab Gen 1 covers the AU480 and EL-120.
- Data (commissioning, not code): register the **Curio Lab Gen 1** — a semi-auto chemistry analyser with a built-in
  thermal printer and USB / RS-232 / LIS output — as an analyser with `sample_id_mode=run_sheet`.
- Web: By patient · By run · Instruments & QC; a "From analyser | Run on Curio | Type values" switch per test group;
  a run grid with ticks and an exceptions column; the run copilot.
- Migration: review columns.

### F5 · QC module
- Tables `lab_qc_materials` and `lab_qc_runs`.
- Westgard: 1-2s warns; 1-3s and 2-2s reject. Writes `qc_locked` / `available`.
- Release gate: `ingestResults` and `enterResult` refuse results from a locked analyser. No override. Unlock only on
  a passing run.
- Levey-Jennings read model, and a look-back list of samples run before the failure.
- Web: the Instruments & QC view.
- Migration.

### F6 · Escalation to people
- Role `lab_supervisor`: seed-roles, the count pins, roster mapping.
- Critical calls: the supervisor at 15 min, the pathologist at 30, via `escalation.triggered`.
- `sweepLabSla` breaches go the same way and set `notified`.
- Unacted after +15 min → the head of department.
- Claims: `kernel/alerts` and `notify` manifests, `seed-roles`.

### F7 · Verify & Release
- Signing uses `secondFactor: true` (DECIDED: this is the board's "PIN every 15 min").
- Batch-sign all-normal reports, audited per report.
- Partial report → amendment v2. Send back for rerun (exists).
- IDSP notifiable register (an L-form draft; the supervisor sends it).
- Print per rulings 11 and 13: add qualification, designation and Doctor ID to the `reports.ts:118` signatory snapshot
  (additive) and to `lab-report-print.tsx`, keeping the council registration number it already prints; the referring
  doctor as Doctor ID.
- Web: `lab-verify.tsx`.
- Migration.

### F8 · Reports inside Reception
- Web: `lab-reports.tsx` becomes Reception's Reports view:
  - one register sorted by what needs action;
  - hand-over with a collector type (patient / relative with name + relation / ward / courier);
  - HIV: a counselling record first, then the patient alone with ID, in a sealed envelope;
  - release unpaid by the billing manager only.
- Core:
  - collector relation and counselling columns on `lab_report_deliveries`;
  - patient notice: WhatsApp, then SMS at 30 min (the `kernel/notify/reach.ts` pattern);
  - sweeps: abnormal and unopened for 24 h → call task; held 3 days → billing; in person 7 days → counsellor.
- **Blocked by the owner:** read receipts and patient OTP need a real provider (see open items).
- Migration.

### F9 · Supervisor station
- `GET lab/supervisor/floor`: pipeline by stage with oldest wait, bench load, instruments, turnaround median and 90th
  percentile, rejections by cause, counters.
- Escalation inbox with `POST …/escalations/:id/act` (do / page / take over / accept with a reason), each act
  audited.
- Approvals: discount, bench open/close, downtime.
- Quality-week register and CSV (NABL 112; EQAS shown as a gap).
- Web: `lab-supervisor.tsx`.
- Deferred: tube-stock requests (gap 12).
- Migration.

### Order

F1 → F2 ∥ F3 ∥ F4 (F2 holds the billing claim) → F5 → F6 → F7 → F8 → F9 (needs F2, F5, F6).

## What the roadmap-v3 handoff adds (reviewed 26 Sep)

Source: `docs/superpowers/2026-09-21-HANDOFF-roadmap-v3.md` and its brainstorm materials, both on `lane/roadmap-v3`,
not on main. Nothing there supersedes ROADMAP v2 until it merges. Every fact below was re-measured on main
`219e2376` before it was written here.

### S · The lab's stand-up runs beside 17-F, not after it

- **The S-gate has never happened.** `docs/runbooks/lab-go-live.md` "Executed on UAT — **NOT YET RUN**" (§14). This
  is ROADMAP v2's first Track S milestone, and v2 §0c.5 says new lab series work waits for the lab's pilot (G6).
  17-F does not wait for it. Instead, the stand-up runs in parallel, on the screens as they are (F1 included), so
  that each 17-F phase lands into a lab that is actually rehearsing.
- **"Done" for the lab is the gate ladder, not a green suite:**
  - G1–G4 = `standup:check lab` shows zero RED rows;
  - G5 = a dated section titled "Executed on UAT" in the runbook (matched by TITLE text, never by number, and
    never while it says "NOT YET RUN");
  - G6 = the pilot harvest's last three rows empty for 7 days, and read;
  - G7 = the CA-signed tariff.
- **G5 run by an agent on UAT is a rehearsal (G5-a).** G5 proper needs the department head (the pathologist of
  record) present.
- **UAT never receives real patient or legacy data.** The rehearsal uses the golden fixture
  (`apps/core/test/fixtures/lab-catalogue.json`) or a synthetic sample. The owner's catalogue is loaded with
  `import:lab-catalogue` (dry-run first) on production only.
- **What blocks G3/G4 today is owner input, not code** (see open owner items): the catalogue spreadsheet, the
  pathologist of record, and the four role holders.

### Per-phase additions

- **Every phase:**
  - Acceptance adds the census row, event or runbook section that proves it (roadmap rule: "a query, an event, a
    census row … or a dated runbook section").
  - Each phase's CLOSE lands as a status-board row citing an artefact (merged SHA, file on main), never a task id.
  - Each phase updates `lab-go-live.md` where it changes the stand-up. §13 (the five-seat walk-through) is rewritten
    by F1's successor phases as the stations change.
- **Before naming anything new, name what already occupies the name** (handoff rule 3). Examples:
  `seed-lab-catalogue.ts` sits beside `import-lab-catalogue.ts`, and the four role keys live in
  `standup-check.ts:123` `LAB_ROLE_KEYS`. Seams are cited by the signature that carries the property
  (for example `issueInvoice(exec, actor, input, now)` for F2), not by the HTTP route.
- **F2:**
  - The discount approval type needs its own census row, beside G2 `lab_approval_type_registered`.
  - The roadmap proposes a lab export `unbilledOrdersFor(day)` (a daily unbilled check; **not on main**). If F2
    builds it, an order held under ruling 1's exceptions (STAT waiver, IPD running bill, credit) must appear in
    it; there is no orphan-charge scan for the lab today.
- **F3:**
  - Label printing goes through the `print_jobs` outbox (`kernel/db/schema/printing.ts`). A lab-label job kind
    does not exist yet; the roadmap names it `lab_label`.
  - Closes the census row `lab_printer_destinations` (G3, NOT MODELLED today: "there is no printer destination
    registry"). Minimum: a per-seat printer record, plus a census row that reads it.
- **F5:**
  - QC is not in the roadmap at all. The roadmap waits on "17-E T7's real instrument" (the owner's analyser
    inventory).
  - F5 is pilot-critical, not a feature: NABL / ISO 15189 needs QC before real patients.
  - Add a census row `lab_qc_material_per_analyser` (G3). An analyser with no QC material cannot be released.
- **F6:**
  - **Build on what exists; do not write a second escalation system.** Use:
    - the obligation spine (`kernel/obligations/consumer.ts`: an alert acknowledged `seen` or `owned` stops the
      respond clock, `handed_over` does not);
    - the kernel ladder (rung → `duty_manager` → `owner`, `escalation.triggered{fallbackExhausted}`);
    - the roster (`modules/roster/resolve.ts`, "one named human").
  - `lab_supervisor` is a ROLE KEY that the roster resolves. Because `kernel/workflow/instances.ts` checks declared
    roles against `user_roles`, it joins `LAB_ROLE_KEYS` and gets a G4 `lab_role_held_lab_supervisor` row.
  - **Two ladders, kept apart:**
    - the critical-call ladder (`criticals.ts` `RUNGS`: ordering clinician → duty officer → patient or attendant)
      is WHO THE BENCH PHONES;
    - F6's escalation is WHO IS PAGED WHEN THE CALL IS NOT CLOSED.
  - The roadmap records that the critical ladder "resolves no role" today; F6 makes each rung resolve to a named
    person through the roster.
  - Closes the census row `lab_critical_call_list` (G3, NOT MODELLED: "`opd_doctors` has NO phone column"). Minimum:
    the rung's contact is read from the roster / staff record, and the printed bench call list is generated, not
    hand-kept.
  - Night criticals follow the existing R-014 and the runbook's Drill A ("a critical value at 02:00 with no
    pathologist logged in").
  - One limit to carry: the kernel SLA "cannot express a per-priority SLA" (roadmap F18). `sweepLabSla` holds STAT
    separately. Do not paper over this in F6; name it.
- **F7:**
  - Keep the existing lab rulings (`plans/2026-08-29-phase1-17-lims-core.md`, DD11–DD13): R-022 auto-verification
    ships disabled, R-014 night release, R-018 amendment wording (a new version, never an edit, reissued as
    AMENDED), R-020 templates only.
  - The doctor's copy stays English (NABL convention). The roadmap proposes a Hindi patient copy through a per-copy
    `lang` parameter; the lab report has no such parameter on main.
  - `lab.sod_violation_blocked` and `lab.report_print_blocked` exist (`modules/lab/events.ts`). The roadmap would
    list them as protocol-gate events for the 100% audit pillar (`PROTOCOL_GATE_EVENTS`, **not on main**).
    Batch-sign must emit them per report, the same as single signing.
  - Batch-sign must never sign a sensitive (HIV) or a critical report in the batch.
- **F8:**
  - Closes, in part, the census row `lab_report_ready_notice` (G3, NOT MODELLED: "NO PATIENT MESSAGE LEAVES THE
    BUILDING").
  - The row stays NOT MODELLED until the owner attaches the WhatsApp/SMS provider. The build queues and records;
    it does not claim sent.
- **F9:**
  - The escalation inbox is the alerts inbox with the spine's seen / owned / handed-over acts. Do / page / take
    over / accept-with-reason write those acts; they are not a new table.
  - Approvals are read from the approvals spine (`kernel/approvals/worklist.ts` `listApprovals`), not a lab-only
    list.
  - The roadmap proposes a daily fact sheet (`ops_fact_sheets`, **not on main**) whose sections include open
    critical calls and the lab harvest. F9's floor read model is built so that sheet can reuse it.
- **Copilot (all stations):**
  - Clinical agents are capped at T2–T3: they draft and a human signs.
  - An agent can never place an order.
  - Every automation keeps a manual path.
  - **Nothing with inference runs on production before DPIA v0.2** (counsel;
    `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` is v0.1). So the board's copilot drafts (reflex
    suggestion, report comment, IDSP L-form, run summary, bench move) ship as DETERMINISTIC drafts built from rules
    and data, or ship behind a kill switch and stay off in production until v0.2.
- **Later, not 17-F:** the consult room as a sixth ordering seat (17c-ii, `lab_specimens.room_id`) and microbiology
  (17-M). Both wait for the lab's G6 per ROADMAP v2.

## DECIDED (open to owner objection)

- a bench review gate before the pathologist;
- TOTP step-up (`secondFactor`) = the signing PIN;
- draw notes are lab-owned, not on the shared patient record;
- the Curio Lab Gen 1 on a run sheet;
- the referring doctor prints as Doctor ID + department;
- no auto-verification.

## Open owner items (money / procurement / law only)

- **Facts only the owner holds, blocking the lab's G3/G4** (from the roadmap owner's list, still open on main 26 Sep):
  - the lab catalogue spreadsheet (the loader `import:lab-catalogue` is merged; template
    `docs/runbooks/lab-catalogue-template.md`);
  - the pathologist of record;
  - the four named holders of `lab_reception`, `phlebotomist`, `lab_technician` and `pathologist`;
  - the analyser inventory (the Curio Lab Gen 1 is known; the rest is owed).
- **Law:** DPIA v0.2 (counsel) gates every copilot that uses inference on production.

- **Procurement:** (owner, 26 Sep: "I will attach later") the WhatsApp/SMS provider (a BSP with delivery and read webhooks). It blocks read receipts, SMS
  fallback delivery, and the OTP for a relative collecting.
- ~~**Law:** does the council registration number stay on the printed lab report?~~ Ruled 26 Sep: it stays
  (ruling 13).

## Shared files each phase will claim

`router.tsx` (F1 and every web phase), `billing/invoices.ts` (F2), `apps/core/drizzle/**` (F2–F9, one each),
`scripts/seed-roles.ts` + `test/seed-roles.test.ts` (F6), `kernel/alerts` / `kernel/notify` manifests (F6),
`apps/web/src/locales/*.json` (web phases). Coordinate before editing, per CLAUDE.md.
