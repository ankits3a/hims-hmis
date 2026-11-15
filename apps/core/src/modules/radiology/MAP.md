---
type: module-notes
title: "radiology — module notes"
description: "Why and traps of the imaging module: the order-to-acted-upon spine, safety gates, the desk, the scan room, the reading room, criticals, release, automation, the copilot and live lists."
resource: apps/core/src/modules/radiology
tags: [radiology, imaging]
generated: { by: agent:claude, at: 2026-11-15 }
verified: []
stale_after: 2027-02-15
---
# radiology — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/radiology.md`. Paths are relative to `apps/core/src/modules/radiology/` unless they
start with a module name, `kernel/`, `packages/` or `apps/`. Citations name a file and a symbol, never a line
number. Update this file in the same PR when you change a flow, an invariant or a trap below.
Owner rulings that bind this module: `docs/decisions/` 0015 (radiology defaults), 0003 (no consult fee on a
diagnostic visit), 0067 (free tests auto-ordered), 0098 (the 2026-11-14 programme: list access log, patient
messages, paid no-show, scanners, draft retention, autosave rows, eval retirement). Programme: #1075.

## 1. Purpose
North star (plan 18-S): "Right patient, safe scan, fast read, closed loop". The one metric is order → report
ACTED UPON by the treating doctor; signed-but-unread does not count (`north-star.ts`, `closed-loop.ts`).

## 2. The spine, stage by stage (owner of what)
- **Order.** `place.ts` `placeImagingOrder` is the one door (consult and desk; `modules/ordering/seam.ts`
  calls it). A side-applicable study needs `laterality` on the ORDER ITEM (`kernel/db/schema/orders.ts`
  `order_items.laterality`, #1080); missing side → `laterality_required`. `consumers.ts` `handleOrderPlaced`
  creates the study and accession and copies the side (`na` when none). Imaging on the patient's own request
  stays refused (`selfOrderable: false`).
- **Walk-in.** `opd/encounters.ts` `openImagingWalkinInTx`: a `V` visit of type `imaging`, department `RAD`,
  under the radiologist of record (shared `doctorOfRecordInTx` with the lab opener); `desk.ts`
  `placeWalkInOrder` opens it and orders under `external_prescription` in one transaction (#1079).
- **Desk.** `desk.ts`: `arriveAtDesk` (checks in today's studies, one refusal does not stop the others),
  `collectAtDesk` (retry-safe with an `Idempotency-Key`; issues through billing's `issueInvoice`, links each
  line; adopts a standing invoice that already covers the studies instead of charging twice; refuses
  `price_changed` when billing's price differs), `walkInNow`, `proposeSlot` (`schedule.ts` `proposeFreeSlot`:
  available machine of the modality, AERB-licensed if ionising, 15-minute grid, 7 days), `deskVisitsToday`.
- **Booking.** `schedule.ts`; `queueAppointmentMessage` runs `readiness-forecast.ts` `forecastAtBooking` on
  book and move (#1084): creatinine missing/stale, radiologist review, pregnancy screen due. The forecast writes
  no gate; a blocker appends `imaging.readiness_forecast` and bells the ordering doctor.
- **Gates.** `checkin.ts` derives the gate set; `gates.ts` `computeSatisfaction` decides each. Kidney gate
  reads the lab's signed creatinine and recomputes eGFR; `renalValidityDays` is the ONE window rule (gate, prep
  bay, forecast). `NEVER_OVERRIDABLE_KINDS`: Form F and side confirmation. Identity needs two identifiers AND
  `nameStated: true` (#1080). Consent schema and fasting constants come from `kernel/consent` (#1086).
- **Scan room.** `room.ts` `RoomView` (incl. `recordedContrast` from the prep bay's register, #1076);
  `acquisition.ts` `startAcquisition` / `recordAcquired` (AERB licence and dose, Form F asserted; stamps the
  reading pool; `imaging.study_acquired` carries the chosen `protocol`). `definitions.ts` `suggestProtocol`
  matches `indication_cues` (#1084). Console steps: Identify, Acquire, Send.
- **Reading.** `reading.ts` `readingWorklist(…, {view})` ("mine" = my pools + assigned + unpooled; "all"),
  `presenceOf`, `CLAIM_WINDOW_MS`; `reading-claim.ts` `claimReading`, `assignReader`. Authoring in
  `report-authoring.ts` (`autosaveDraft`, `AUTOSAVE_VERSION_MINUTES`, `comparablePrior`, `proposeDraft` with the
  numbers check), signature in `report-signature.ts` (sign, co-sign, amend, publish, `enqueueReportReady`),
  criticals in `criticals.ts`. `drafter.ts` drafts technique and comparison only, with `DraftSource` per
  section; findings and impression are never drafted.
- **Criticals.** `critical-ladder.ts` (treating doctor → unit head → duty RMO → HOD; closed only by a read-back
  naming the finding; `checks.ts` `foldDevanagari` lets a Devanagari read-back match), `chasers.ts`.
- **Release.** `release.ts` `releaseRegister`, `releaseSearch`, `handoverPrintView` (the desk prints the
  current released copy; refuses a copy held for dues), `mediaQueue`; `held.ts` `patientCopyHolds` (batched).
- **Closed loop.** `closed-loop.ts` `visitDoctorUserId` / `treatingDoctorIs`: the ONE study → visit-doctor join
  (`waiting.ts`, `release.ts` use it). `study-source.ts` `studySource`: the ONE "where did this study come
  from" (walk_in, daycare, ipd, opd); metrics and the north star both call it.

## 3. Automation (ladder L0 shows … L4 acts silently, audited)
- `automation-actor.ts` `AUTOMATION_ACTOR` writes every automated act; `assertNotAutomation` refuses it at
  every clinical act (gate satisfy/waive/override, sign, co-sign, amend, critical acknowledge, ordering).
  The refusal is explicit in each act and is load-bearing: never remove it.
- `morning-sweep.ts` `runMorningSweep` rides the EXISTING 08:00 IST radiology job in `kernel/worker/jobs.ts`
  (no new job). `automation.ts`: `runOnce` (one `imaging_automation_runs` row per kind and day),
  `switchAutomation` (`imaging_automation_settings`, reason required), `sweepNoShows`, `sendPatientReminders`
  (OFF until the templates are approved, #1088), `noShowsToRebook`. `digest.ts` `sendHodDigest` (counts and
  minutes only, no names), `completeness.ts` `registerCompleteness` (Form F, dose rows, DRL reasons).
- Paid no-show: `money.ts` `carryNoShowInvoice` (from `handleOrderPlaced`) moves the original invoice line to
  the rebooked study within 30 days; never an automatic refund.
- Switches for the readiness forecast, protocol suggestion and follow-up prompt are owed (#1108).

## 4. Copilot and live lists
- `copilot-intents.ts` (14 intents, cue-routed only, no chooser `menu`), `copilot-tools.ts` (reads + one
  draft), `copilot-acts.ts` (book, move/no-show, mark acted, film/CD; propose → confirm per spec 580). Never a
  tool: order, sign, co-sign, amend, gates, criticals, hand-over, unpaid release, money. The masker knows the
  accession shape (`kernel/copilot/mask.ts`). A screen's patient in hand is prefixed to the question until the
  ask route takes a subject (#1106).
- `realtime.ts`: topic space `imaging` (gated by `radiology.worklist.read`), topics `imaging:floor`,
  `imaging:read`, `imaging:release`; `RADIOLOGY_REALTIME_NAMES`. Web `apps/web/src/lib/radiology-live.ts` `useImagingLive`
  refetches list queries only; polling stays as the fallback; a new order is read again after 4 s (#1098).

## 4b. Stations (web, #1087)
- The station switch (`apps/web/src/screens/radiology-station.tsx`) has 9 stations: desk, reports (hand-over),
  prep, room, read, usg, safety, setup, hod. Each person sees only the ones their grants open.
- Five old addresses redirect and have no menu row: diary (Desk header view), portable (Rooms header view),
  worklist (to Reading for a reporter, Rooms for a radiographer, Prep for a nurse, Desk for the desk), and the
  legacy study and report pages (the same study in Rooms or Reading). The hall display keeps its menu row for
  the kiosk role; Desk links to it.
- Prep-bay override requests are decided in the reading room's "Override asks" view (the existing decide route).
  Direct gate override without a request had its only UI on the legacy study page (#1109).

## 5. Traps
- **Access log.** List readers write via `kernel/phi/audit.ts` `recordPhiAccessMany`, one row per reader,
  patient and surface per `PHI_LIST_WINDOW_MINUTES` (30); opening one record logs every time (`read.ts`
  `openStudy` is the shared study door). Do not route a single-record read through the window.
- **`imaging_reports` is append-only** (trigger `imaging_reports_forbid_mutation`), narrowed once (migration
  0235, ruling 0098 §6): only an autosaved, provenance-free draft's own text may change, by its author, within
  10 minutes. Any new mutable column needs a conscious trigger change in its own migration.
- **Migrations land in journal order AND `when` order.** drizzle skips any migration whose `when` is not later
  than the last applied; a renumbered migration re-runs on a DB that applied it under its old tag. Regenerate on
  main's journal, keep the SQL, restore the overwritten snapshot, then drop the lane's test DBs.
- **No consult fee on walk-in kinds**: `billing/charge-rules.ts` `NO_CONSULT_FEE_VISIT_KINDS` (lab, imaging,
  pharmacy). Other kinds keep the fee rule until ruled. The lab desk skips imaging visits (#1103 owes pharmacy).
- **Acceptance fixtures** that satisfy identity must send `nameStated: true`; agents cannot edit an acceptance
  file, the owner can.
- **CI flakes seen**: `lab/catalogue.test.ts` whole-catalogue seed (now 60 s), `test/perf-opd-queue.test.ts`
  wall-clock budget on a busy runner. Re-run; never loosen a budget.

## 6. Seams
Solid: ordering door, lab creatinine, AERB, PCPNDT, ABDM (`abdm-release.ts`). Billing: rules solid, desk
sequence now server-side. Thin: doctor results inbox (one web mount), IPD/portable (no `ipd` on main), the phone
app and auto-order do not send the side yet (#1091). PACS: built, not commissioned (#645).
