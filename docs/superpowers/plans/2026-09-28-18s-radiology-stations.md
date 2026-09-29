# Plan 18-S — the radiology department, from the approved board to code

Status: **APPROVED by the owner, 28 Sep 2026** ("all approved", on PR #368), including every DECIDED ruling below. Phases start in order.

## Context

On 28 Sep the owner asked for a brainstorm of the radiology module, a north star, and "every possible screen that
a radiology must have in a single artifact link". He then ruled that every decision waiting on him defaults to what
top Indian hospitals do, and that the plan follows only once the flow joins every dot.

- **Spec:** https://claude.ai/artifact/SF4wW61FajAk6hMfn2ShPw, copied into `docs/design/2026-09-28-radiology-stations/`
  with its two Playwright scripts. **That board is the spec.** Where this plan and the board disagree on what a screen
  shows or does, the board wins until the owner says otherwise.
- **North star:** *right patient, safe scan, fast read, closed loop.* The measure is **order → report acted upon**:
  the clock stops when the treating doctor records what the report changed, not when the radiologist signs.
- **Seats (stations):** Front desk · Prep & safety bay · Modality rooms · Ultrasound & PCPNDT · Reading room ·
  Radiation safety · Supervisor & HOD · Doctor's door (consult + ward) · Patient's phone · Setup.
- **The dots, proven.** `journeys.cjs` drives eleven journeys (OPD contrast CT, ER STAT with a red critical, IPD
  portable, obstetric USG with Form F, kidney override, a licence filed, an outside CD, a free repeat, a follow-up
  booked, a CT breakdown, the access log) through one shared set of stores and checks that every hand-off appears at
  the next seat. The board's numbers are in `docs/design/2026-09-28-radiology-stations/README.md`. Each journey
  becomes an e2e test in the phase that builds its last hop.

## Owner rulings

**Delegated 28 Sep:** *"Whatever requires my decision, consider the industry practices and default to what top
hospitals of India follows."* Each item below is DECIDED under that delegation and open to owner objection on this PR.

1. **Films, CDs, outside reads.**
   - The digital report and the image link are free, always.
   - An X-ray includes one film. CT, MRI and USG film costs ₹250 a sheet, printed on request.
   - A CD costs ₹300.
   - An outside second-opinion read costs ₹600 for X-ray or USG, and ₹1,500 for CT or MRI.
2. **GST.** Imaging by the hospital is exempt healthcare: SAC 9993, Notification 12/2017-CT(R) entry 74.
   - Film and CD supplied with the study are part of the same composite supply.
   - The tariff gains a GST category `investigation` at 0%, exempt. The lab uses the same category, so this is one
     ruling, not two.
   - A CA confirms the 6-digit SAC at the first filing.
3. **Contrast and premedication are included** in the CECT and contrast-MRI price. Contrast not given reverses the
   contrast component through the existing `contrast_not_given` bill decision.
4. **The printed imaging report names its signer.** It carries the signing radiologist's or sonologist's name,
   qualification, council registration number and digital signature.
   - This extends the lab report's exception (17-F rulings 11 and 13) to the 06 Sep "Doctor ID only" print rule.
   - Referring doctors stay Doctor ID + department.
5. **Radiation safety** (closes 18c R1–R4):
   - **RSO:** an AERB-certified RSO for diagnostic radiology, with a certified radiologist as alternate.
   - **Medical physicist:** not required for diagnostic X-ray or CT licensing.
   - **QA:** by an AERB-recognised QA agency at acceptance, every 2 years, and after a major repair.
   - **TLD:** from a BARC-accredited personnel-monitoring service, worn quarterly.
   - **Investigation level:** 1 mSv per month of wear (3 mSv per quarterly badge).
6. **PACS** (closes 18b R1–R3):
   - On-premise Orthanc archive with the OHIF viewer.
   - Two 3 MP diagnostic monitors per reading station; two 5 MP for mammography.
   - MWL/MPPS licences bought per modality.
   - 5 years online, then archive. MLC cases and minors are retained longer.
7. **Teleradiology** (closes O-1):
   - A contracted Indian provider with NMC-registered radiologists; data stays in India.
   - A DPA under the DPDP Act.
   - Preliminary read within 30 minutes for STAT and 60 for urgent.
   - A consultant over-reads next morning, with discrepancies logged.
8. **Money at the desk** (already ruled elsewhere, restated):
   - No counter discount; the HOD may give up to 10% with a reason. Credit is the owner's alone (ruling 28 Sep).
   - ER and STAT scans run first, and the bill follows.
   - Cancelled before the room: full refund. After the scan starts: none, except the hospital's fault.
   - A repeat for a technical reason is free.
   - TPA cashless needs pre-auth before an MRI or CT; otherwise the patient pays a deposit.
9. **Pregnancy screen before ionising work:** women aged 10–55, the same band `applicability.ts` uses for Form F.

**Layout rules** (owner, apply to every station): menu in the HEADER; left lane = the patient, study or item in hand;
right = ONE list with NO filter tabs, then "Clocks running" collapsed; opening something shrinks the list to one
line and opens the copilot panel; dark only as a highlight (the image viewer is the one dark surface); no button that
only records presence; the next act sits in a pinned dock and Enter runs it; nothing duplicates the right-hand list.

## What exists (measured on main `f9f87500`, 28 Sep)

**Core** (`apps/core/src/modules/radiology/`, 43 source files):
- **Study states.** The class-A workflow `imaging_study` (`workflow-def.ts`) runs
  scheduled → checked_in → ready → in_acquisition → acquired → reported → published. It can also end in cancelled,
  no_show or rescheduled. Only the system moves checked_in → ready (`evaluateReadiness`).
- **Ten gates** (`gates.ts`): identity, pregnancy, contrast consent, kidney function, prior contrast reaction, MRI
  safety, Form F, chaperone, side, and MLC.
  - Form F can be neither waived nor overridden.
  - Identity can be overridden but never waived.
  - Only pregnancy and chaperone can be waived.
  - The kidney gate is creatinine-only: ceiling 176.8 µmol/L, valid 30 days for OPD and 7 days for admitted
    patients.
- **Refusals at acquisition** (`acquisition.ts`): `payment_required` (`money.ts` `authorisationOf`),
  `device_not_licensed` (AERB), and PCPNDT machine registration. Dose goes to `radiation_dose_register` in the same
  transaction, with a DRL nudge that never blocks.
- **Contrast** (`contrast.ts`, `reactions.ts`): administration and reactions both have routes. A reaction writes the
  allergy that the next gate reads.
- **Reports** (`reports.ts`): draft, prelim, propose (offline drafter, technique only), sign and amend under
  `secondFactor`, then publish. ABDM release is in `abdm-release.ts`.
  - Criticals are red/orange/yellow (`flagCritical` :902, `acknowledgeCritical` :963), with read-back.
  - `chasers.ts` sweeps criticals every 60 s and unread reports at 24 h.
- **Money** (`money.ts`): `authorisationOf` accepts an invoice, payer branch, daycare or STAT authorisation. The
  bill-decisions queue covers `contrast_not_given`, `repeat_no_charge`, `performed_then_cancelled` and
  `acquired_unbilled`.
- **Placing orders:** `placeImagingOrder` (`place.ts` :187) takes clinician or external-prescription authority, and
  `consumers.ts` turns an imaging order into a study.
- **DICOM** (`mwl.ts`, `uid.ts`): an MWL pull export (empty today, because no device has an AE title), Study UID
  minting, and the viewer URL from the `pacs_settings` definition.
- **Governed definitions:** `study_types`, `pregnancy_policy`, `critical_categories`, `pacs_settings` and
  `dose_reference_levels`.
- **Related modules:**
  - AERB (`modules/aerb/`): licences, persons, QA records, dose register, TLD badges and reads.
  - PCPNDT (`modules/pcpndt/`): registrations, machines, persons, gap-free Form F serials, and Form F.

**Web** (`apps/web/src/screens/`):
- `radiology-reception.tsx`, `radiology-worklist.tsx`, `radiology-study.tsx`, `radiology-report.tsx`,
  `radiation-safety.tsx` (1,854 lines, the whole `/aerb/*` API) and `pcpndt-form-f.tsx` (not in the nav).
- API client: `lib/radiology-api.ts`.
- The lab's `StationShell` (`components/station/station-shell.tsx`, 17-F F1) is on main and is the shell to reuse.

**Seventeen acts with no screen:**
- place an order and add items;
- reschedule, no-show, cancel;
- register an outside study;
- abort an acquisition;
- record contrast, record a contrast reaction;
- link an invoice line, resolve a bill decision;
- prelim, amend;
- flag a critical, acknowledge a critical;
- every definition route;
- the device diary;
- PCPNDT registrations.

**Also missing:**
- There is no route that creates or edits a machine: `kernel/resources` exposes three GETs, and `seed:radiology` is
  the only writer. This is why MWL is empty.
- There is no tariff screen, and no `investigation` GST category.

**Roles:** `radiology_receptionist`, `radiographer`, `radiologist`, `radiation_safety_officer` and `modality_bridge`
are seeded in `scripts/seed-roles.ts` and pinned by `test/seed-roles.test.ts`.

**Migrations:** the highest on main is `0143_pharmacy_cold_chain.sql`. Every phase takes the next free number at
rebase.

## Gaps the board exposes

1. **No ordering door** (#142). 18a-iv is authored and unbuilt. The board also orders from the ward
   (portable, `bedside_location` — the 18a-iii T3 column with no writer).
2. **No machines screen.** AE titles cannot be set, so MWL stays empty and every machine in the board beyond the five
   seeded (XR-2, PX-1, DX-1, FL-1, US-2, US-3, IR-1) cannot exist.
3. **The kidney gate has no eGFR.** DECIDED (clinical, not owner): add eGFR (CKD-EPI 2021) from creatinine, age and
   sex.
   - eGFR under 30 holds iodinated contrast for the radiologist.
   - 30–44 attaches an IV-hydration instruction.
   - Metformin is held for 48 h when eGFR is under 45.
   - The creatinine ceiling stays as the fallback when no eGFR can be computed.
4. **Room gates versus prep gates.** The code treats all ten alike. The board closes identity and side at the console
   (the wristband is checked with the patient on the table) and every other gate in the prep bay. This is a UI
   routing rule; the gate model is unchanged.
5. **No follow-up tracker.** Nothing records an incidental finding's recommendation, and nothing chases it.
6. **"Acted upon" does not exist.** `imaging_report_delivery` records `first_read_at` only. The north-star clock needs
   an `acted_at` and an `acted_note`.
7. **No structured reporting categories.** `templates.ts` has seven section templates and no coded field (BI-RADS,
   TI-RADS, LI-RADS, PI-RADS, O-RADS, Fleischner, ASPECTS).
8. **No co-sign.** A junior radiologist cannot draft for a consultant's signature: there is no resident role and no
   co-sign state.
9. **No peer review, no incidents register, no TLD import, and no QA → `qa_blocked` writer.**
10. **No patient messages.** No prep instructions, no report link, no waiting-hall display for imaging.
    - The WhatsApp adapter is in `lane/whatsapp-cloud`, not on main.
    - The OPD queue display and announcer (`modules/opd/queue.ts`) are the pattern to reuse.
11. **No supervisor read model.** The HOD's floor, escalations and approvals have nowhere to come from except the
    kernel alerts, obligations and approvals spines, which radiology does not yet feed.
12. **No PACS.** 18b-ii (Orthanc, OHIF, MPPS, dose SR, reconciliation) is unbuilt; ruling 6 now decides it.

## Phases

Each phase is its own lane and PR. One migration per PR, numbered at rebase. A new test fails first against the code it
guards. Each web phase is walked in Chromium at 1920/1440/1280/1100/1024/768/390 against the board before it is called
done. Tier: **LIGHT** for every phase except RS8, which is HEAVY (a many-task module build: the reading workspace,
templates, co-sign, follow-ups and peer review).

### RS0 · Commission what exists (runbook, no code)
- `radiology-go-live.md` §0–§9, extended with this board's C0 list:
  - the five seeded machines exist in production;
  - the RSO holds the role AND has an `aerb_persons` appointment;
  - licences are filed until `GET /aerb/licences/gaps` is empty;
  - the two `imaging_*` workflow definitions are activated by three distinct humans;
  - the tariff is priced, with the `investigation` category (ruling 2);
  - the §19 PCPNDT registration is entered;
  - `pregnancy_policy` and `critical_categories` are published.
- Runs in parallel with RS1–RS3. **G-rows:** `standup-check` radiology rows all green.

### RS1 · Radiology stations on the shell (web only)
- Wrap the five screens in `StationShell` with a department station switch: Front desk, Rooms, Reading room,
  Radiation safety. No behaviour change.
- Claims: `router.tsx`.

### RS2 · The doors in: consult, ward, desk (absorbs 18a-iv T1–T4)
- **Core:**
  - The advised-lines reader (18a-iv T1).
  - `placeImagingOrder` called from the consult with clinician authority.
  - The ward order writes `bedside_location` and sets `attributes.portable` on the machine it targets (closes the
    18a-iii T3 writer gap).
- **DECIDED — this departs from 18a-iv D2, and says so.** The doctor's explicit *Send to imaging* is an ORDER, not
  advice. It lands at the desk as *to book*, and it is not billed until the desk books it. Lines only advised on the
  prescription still arrive as suggestions the desk confirms. D2's harm, billing on consultation close, cannot happen,
  because nothing bills before the desk.
- **Web:**
  - `doc:order` (inside the consult: plain-word search in English and Hindi, appropriateness hint, 30-day duplicate
    with reason, indication required, side, pregnancy, contrast and creatinine);
  - `doc:ward` (the IPD tracker, portable request, porter);
  - the desk's *Studies* step reads both.
- **Journeys:** J1 hop 1, J3 hop 1, J9 last hop.
- Claims: the OPD consult screen (coordinate with the doctor-consult lane) and `router.tsx`.

**RS2 as built** (PR #377, merged `ed7330c5`, 28 Sep): the consult panel and the desk door over one read,
`GET /radiology/advised`. The ward door is deferred to IPD; RS2b below builds its radiology half. What was built, the
DECIDED choices and the test counts are recorded once, in §8 CLOSE of
`2026-09-06-phase1-18a-iv-radiology-ordering-door.md`.

**RS1 as built** (PR #374, merged 28 Sep): three browsable stations (imaging reception, worklist, radiation
safety); the study console and the report sit inside the worklist station. `StationShell` gained a `seat` prop.

### RS2b · The portable and bedside door (built ahead of IPD)

Owner, 28 Sep: *"work on the deferred items. We will connect it later when full IPD plan is built."*
There is no IPD or ER module; nothing here creates one. PR #385, merged 4f426929.

**Built**
- **Machines that go to the bed (data).** `seed:radiology` writes `PX-1` (portable X-ray, ionising)
  and `USG-P1` (portable ultrasound), each `attributes.portable = true` — the writer 18a-iii F2 said
  was missing. Find-or-create; an active (governed) study-type book is still left alone. **No AERB
  licence is seeded:** `PX-1` is a licence gap (`/aerb/licences/gaps`, standup `radiology_devices_licensed`
  red) until the RSO files its real certificate.
- **`GET /radiology/devices`** (`radiology.worklist.read` — the one grant the receptionist and the
  technologist share; there is no either-of decorator): every bookable imaging machine with code,
  name, room (parent resource), `portable`, status, `ionising` and AERB `licensedNow` from
  `modules/aerb`'s own read. Retired and non-vocabulary devices are not listed.
- **`GET /radiology/portable/round`** (`radiology.acquire`): bedside studies booked on a portable
  machine, scheduled → in_acquisition, by place then slot; names through `displayName`; one
  `imaging.worklist` PHI row per patient.
- **Bedside at order time.** An imaging order item takes `bedsideLocation` (trimmed, 1–120, else
  `invalid_bedside_location`). Placement appends `imaging.bedside_requested` in the order's
  transaction; the `radiology.order_placed` consumer copies it onto the study. `resolveBedside` is
  unchanged, so a fixed machine refuses `device_not_portable` until the desk clears the bed.
  No migration (the event log carries it; `order_items` is the kernel's envelope).
- **Reception** books from the machine list (portable / not licensed marked) with an *At the bedside*
  field for a portable machine, and offers *Bring to the department instead* after
  `device_not_portable`.
- **`/radiology/portable`** — the *Portable round* station, grouped by ward, each row opening the
  study console, with a note that ward ordering arrives with IPD.

**The seams the IPD plan calls**
- `bedsideStudiesFor(db, actor, locationPrefix)` from `modules/radiology/index.ts` — a ward's bedside
  studies (booked or not yet booked) by whole-word, case-insensitive place prefix ("Ward 3" never
  returns "Ward 30"), in the round's row shape. No route; the IPD route owns the permission.
- `placeImagingOrder(..., { items: [{ serviceId, bedsideLocation: "Ward 3 · bed 12" }] })` — the
  ward order (also accepted on `POST /radiology/orders`).

**Left for IPD**
- The ward screen (the IPD tracker) that calls `bedsideStudiesFor` and places the ward order.
- The porter request and transport status (who takes the trolley, when it left, when it came back).
- NPO / fasting and transport-fitness status on the bedside study, shown to the technologist.
- Choosing ward and bed from the IPD bed board instead of free text (today the place is a string).

### RS3 · Front desk counter, diary, display
- **Web `desk:counter`:** Studies → Checks → Bill → Slot & slip.
  - Payers: self-pay, corporate, TPA with the pre-auth hold (ruling 8), IPD running bill, ER bill-follows.
  - Refusals `device_not_licensed`, `device_down`, `slot_taken`, `payment_required`, each with a link to the seat
    that fixes it.
- **Web `desk:schedule`:** a room × time diary over `GET …/device/:id/diary`, with reschedule, no-show and cancel
  (the routes exist, zero callers today). The downtime banner lists the studies to move.
- **Web `desk:display`:** the waiting-hall token board. First name and initial only (DPDP). Hindi and English. It
  reuses the OPD announcer.
- **Core:** cancellation raises `performed_then_cancelled` or a refund per ruling 8. The slip and prep message are
  enqueued through `kernel/notify` (recorded, not claimed sent, until the provider lands).
- **Journeys:** J1 hops 1–2, J9 last hop, J10 banner.
- Migration: none expected.

**RS3 spike** (read on main `3276ff7a`, 29 Sep, before any code):
- **(a) Money.** `authorisationOf` accepts four facts: a linked `invoice_line_id` (`invoice`), a
  `D…` encounter (`daycare`), a non-self `intendedPayer` (`payer_branch`), or `priority = stat`.
  The only writer of the invoice fact is `POST /radiology/studies/:id/invoice-line`
  (`linkInvoiceLine`: same patient, same service, one line per study) — **zero web callers**.
  Radiology composes no invoice. The existing path the desk reuses is billing's own:
  `POST /billing/invoices/preview` → `POST /billing/invoices` (tender inside; the acting user's
  open drawer; `refText` for UPI/card) → `GET /billing/invoices/:id` for the minted line id →
  link. `radiology_receptionist` already holds `billing.invoice.issue/.read`, `billing.receipt.record`,
  `billing.session.own`, `radiology.bill_decisions.manage`. Billing refuses a second charge for
  the same service on the visit (`duplicate_invoice_refused`, with the existing invoice id) — the
  desk's recovery is to link that line. No billing signature changed.
- **(b) Desk acts.** Reschedule took device + instant (+ bedside) and refused `bad_transition`
  (not scheduled/checked-in), `device_unavailable`, `modality_mismatch`, `slot_taken`,
  `device_not_portable` — **no reason**. No-show took nothing (scheduled/checked-in only) — **no
  reason**. Cancel required a reason only from `in_acquisition` (`reason_required`), refused
  `already_acquired` after images; from the machine it raises `performed_then_cancelled`. The
  device diary listed live studies per machine with no length, type or name.
- **(c) Slot conflict.** Yes: `assertSlotFree` locks the device row and refuses an overlapping
  interval (`slot_taken`, F55), with the exact-instant partial unique as the last line. No licence
  check at booking — `device_not_licensed` is refused at acquisition only.
- **(d) Hall display.** The OPD board reads `boardSnapshot` behind `opd.display.read` (held by the
  kiosk `display` role); tokens, rooms, doctors, no patient field; voice rides `queue.called`
  realtime frames. It reads OPD queue sessions, so imaging needs its own read. Imaging has no token
  of its own and no call act.

**RS3 as built** (this PR; one lane, no migration):
- **Core.** `GET /radiology/studies/:id/counter` (`counter.ts`, `radiology.schedule`): gates
  check-in will open (`deriveGateSet`, nothing opened), prep (`prep.ts`, one derivation for desk,
  slip and message), payer + `authorisationOf`, film/CD add-ons only when the tariff has
  `RAD-FILM`/`RAD-CD`. `GET /radiology/display` (`display.ts`, new `radiology.display.read`).
  Device diary widened (length, type, priority, name); worklist gains `createdAt`, `checkedInAt`.
  Reschedule / no-show / cancel **require a reason in every band** and append
  `imaging.booking_changed` (act, reason, from, to). Booking and moving queue
  `imaging_appointment_booked` through `kernel/notify` (expired by ref on move / no-show / cancel).
- **Web.** The counter's four steps with a dock (Enter) in `/radiology/reception`; `/radiology/diary`
  and `/radiology/display` as stations; `StationShell.closeListOn`.
- **DECIDED.**
  - The desk holds `radiology.checkin` — the approved board makes opening at the desk the arrival,
    and the workflow edge already named the role; check-in opens gates, satisfies none.
  - The hall token is the **accession** on the slip; first name + initial; confidential or
    restricted = token only; the board writes no PHI row (the OPD board writes none; a polling TV
    would write one per patient per poll).
  - Voice calling is **not built** on the hall board: imaging has no call act (RS6's console bell).
  - Prep derives from type flags and, for ultrasound fasting vs full bladder, the seeded code family,
    until RS4's `imaging_protocols` makes prep data. A PCPNDT study's message carries **no prep**.
  - An unlicensed ionising machine is not offered for booking at the desk (from `/radiology/devices`'
    `licensedNow`); the server still refuses only at acquisition — a booking-time refusal belongs
    with RS4's status writer.
  - The desk's time box is IST (18a's desk sent the typed time as UTC — a 5 h 30 min error, fixed).
  - Film/CD without tariff services: a note, never a desk-typed price.
- **Counts.** Core: 4 fail-first RS3 schedule tests, counter 13, display 6, notify template + queue
  4; radiology module + notify + e2e + pins green. Web: reception 16 (15 failed against the old
  screen), diary 6, display 3; 23 files / 187 tests across the touched web suites. Pins:
  seed-roles (permissions 203, pairs 424, held 189), caddyfile routes 75, radiology events 15,
  notify catalog +1.
- **Still not built, and who owns it.** Pre-authorisation record and deposit flow (Plan 46 / IPD);
  IPD running bill (IPD plan); HOD discount request as an approval (RS10); booking-time licence
  refusal and machine status writes (RS4); film/CD tariff services (RS4); voice call and "call on the
  display" bell (RS6); outside-CD desk view and the reports release register (RS9); protected ER holds
  and sedation blocks in the diary; the copilot panel at the counter; the WhatsApp sender (provider
  lane).

### RS4 · Machines, books and prices (Setup)
- **Core — coordinate: `kernel/resources` is shared.**
  - A write route for imaging devices: create, edit, AE title, status, and `portable`.
  - `setDevice` statuses `down`, `qa_blocked` and `maintenance`, with the list of booked studies returned.
- **Definitions:**
  - an editor over the existing governed routes (draft → two approvals → activation, where the activator is not the
    drafter);
  - new kinds `imaging_protocols` and `report_templates`, which carry the coded categories.
- **Tariff:** the `investigation` GST category (ruling 2), and film, CD and outside-read services (ruling 1).
  Coordinate with the tariff owner.
- **Web:** `setup:*`.
- **Journeys:** J10.
- Migration: device attributes, if not in the resource's JSON.

#### RS4 spike (measured on main `4d05ffdc`, 29 Sep)
- **(a) No kernel route is needed.** `kernel/resources/index.ts` exports the registry's write surface
  (`createResource`, `updateResource`, `moveResource`, `changeResourceStatus`), and DD14 deliberately
  ships no kernel write route: OPD rooms, lab instruments and stores already delegate into it from
  their own module routes. Radiology is the fourth caller. `kernel/**` is untouched. There is no
  `resources.manage` in `seed-roles` (DD14 says why) — so RS4 mints a MODULE permission,
  `radiology.devices.manage`.
- **(b) Status lives on `resources.status`**, vocabulary declared by radiology's `device` kind. Writers
  before RS4: `assignResource`/`releaseResource` at acquisition (`in_use` ↔ `available`), and
  `aerb/qa.ts` (`qa_blocked` on a failed QA, back to `available` on a newer passing QA — *"the ONLY exit
  from qa_blocked"*). Nothing wrote `down`, `maintenance` or `retired`.
- **(c) GST categories are DATA**: `gst_config.category` is free text, `services.category` keys it, and
  `seed:tariff` writes rows skip-if-present. `investigation` is one seed row — **no migration.**
- **(d) The governed publish**: `POST /radiology/definitions/draft` (`radiology.definitions.manage`,
  the radiologist) drafts AND files an `imaging_definition_publish` approval in one transaction; the
  medical superintendent decides it in the kernel approvals inbox (`/approvals?focus=<id>`), which
  refuses requester = approver; `POST /radiology/definitions/publish` re-checks the approval's status
  and subject. **Two distinct humans are enforced (drafter ≠ MS); the publisher may be the drafter** —
  the plan's "activator is not the drafter" is not a rule of this route. Reported, not changed (it would
  be a governance change beyond RS4). A web editor reuses both routes as-is.
- **(e) Booking-time licence refusal: a one-call add** — `aerb`'s `assertDeviceLicensed` (already
  called by `startAcquisition`) after `assertDeviceBookable` in `scheduleStudy` and `rescheduleStudy`,
  on the study type's `ionising` and the slot's IST day. `device_unavailable` for a down /
  maintenance / qa_blocked / retired machine already existed (18a T4 A2).

#### RS4 as built (this PR)
- **Machines (T1).** `modules/radiology/machines.ts` + `radiology-setup.controller.ts`:
  `GET|POST /radiology/setup/devices`, `PATCH /radiology/setup/devices/:id`,
  `POST /radiology/setup/devices/:id/status` — all `radiology.devices.manage` (granted to `radiologist`).
  AE title `^[A-Z0-9_]{1,16}$`, unique among imaging devices under a transaction advisory lock
  (`invalid_ae_title`, `duplicate_ae_title` naming the other machine). Status needs a reason
  (`reason_required`); `in_use` is not settable; out-of-service answers with the booked studies
  (scheduled / checked_in / ready). Audit = the registry's `resource.*` events + `resource_status_history`
  (reason on both). Five new codes: `invalid_ae_title`, `duplicate_ae_title`, `unknown_device`,
  `invalid_device`, `device_status_locked`.
- **Booking refusals (T2).** `scheduleStudy`/`rescheduleStudy` refuse `device_not_licensed` (aerb's
  sentence: machine code + name, the RSO remedy, no ULID); the walk-in passes an unlicensed machine over
  and, when every candidate was unlicensed, answers with that refusal.
- **Prices and GST (T3).** `seed:tariff` writes `investigation` (exempt, 0 %, SAC 9993) when absent;
  `seed:radiology` ensures `RAD-FILM`, `RAD-CD`, `RAD-2ND-XR-US`, `RAD-2ND-CT-MR` (category
  `investigation`, unpriced). The existing `RAD-` services were already `investigation` — nothing moved.
  Census row `radiology_investigation_gst` (G2).
- **Web (T4).** `/radiology/setup?view=machines|books|prices`, the `setup` station, header views.
  Books reuses the definitions routes and links the approvals inbox; Prices is read-only.
- **Migration: none.** Device attributes are the resource's jsonb.
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *Who manages machines:* the radiologist (HOD), the holder of the books — a new
    `radiology.devices.manage`, not a reuse of `definitions.manage`, so the audit names the act.
  - *A QA block is lifted only by QA*, and *retired is final*: Setup refuses to walk a machine out of
    either (fail-safe; `aerb/qa.ts` stays the one exit from `qa_blocked`). Into `qa_blocked` is allowed.
  - *Modality never changes* on a registered machine: its studies, doses and licences were recorded
    against it.
  - *Ruled prices are not activated by a seed.* A price is chargeable only through a tariff revision the
    owner approves; the four ruled prices are carried in `RADIOLOGY_RULED_SERVICES`, shown on Prices
    beside the price in force, and entered per `radiology-go-live.md` §6a.
  - *X-ray's one included film* is a desk rule (first film unbilled); no bill logic enforces it yet —
    it belongs to the phase that builds the film counter (RS9 release / hand-over).
  - *AE title stricter at the writer than the export* (A–Z 0–9 _), see `radiology-pacs-go-live.md` §2.
- **Moved out of RS4:** `imaging_protocols` → **RS6** (its first reader is the room console's Protocol
  step), `report_templates` with the coded categories → **RS8** (its reader is the reading room). Each
  needs a widened `imaging_definitions_kind_ck` — a kernel schema edit plus a migration — and a kind
  with no reader would be a book nobody reads; they ship with their consumer.
- **No census row for AE titles**: a hospital may run a CR or a portable with no worklist, so "every
  ionising machine has an AE title" would be a permanent red. Setup's *No AE title* count shows it.

### RS5 · Prep & safety bay
- **Web:**
  - `prep:bay`: every prep gate, with evidence, waive, and override-by-approval (kernel approvals);
  - `prep:mri`: the screening form, card upload and zones;
  - `prep:contrast`: the record and reaction (existing routes, first web callers);
  - `prep:consents`: reuses `ot` `consentSchema`.
- **Core:** eGFR in the kidney gate (gap 3). An override request becomes an approval row for the radiologist or HOD.
- **Journeys:** J1 prep hop, J5.

**RS5 spike** (read on main `4d05ffdc`, 29 Sep, before any code):
- **(a) Who can satisfy which gate.** Two planes, measured. The guard: `radiology.gates.satisfy`
  is held by `radiographer` ALONE (`radiology_receptionist` is denied it by name — the first
  separation). The engine: `imaging_gate` `open → satisfied` names `radiographer`, `radiologist`,
  `doctor`, `system` (F19: the narrower guard wins). One definition covers every KIND, so a role
  on that edge can satisfy all ten. Waive and override are `radiologist` on both planes. **There is
  no prep-nurse role** (`ot_nurse`/`recovery_nurse` are the theatre's). **DECIDED** (standard: a
  radiology nurse staffs the prep bay): new role `radiology_nurse` holding `radiology.worklist.read`,
  `radiology.gates.satisfy` and a new `radiology.contrast.record`, and named on the engine's satisfy
  edge; NOT `radiology.gates.override`, NOT `radiology.checkin`. The contrast routes guarded on
  `radiology.acquire` (the machine) — giving the nurse `acquire` would let her start and finish an
  acquisition, so the two contrast POSTs move to `radiology.contrast.record`, held by everyone who
  held `acquire` (radiologist, radiographer) plus the nurse.
- **(b) Evidence per kind** (`gates.ts`): identity `{secondIdentifier: dob|uhid|wristband, value}`
  compared to the patient master (wristband = the UHID); pregnancy `{declared, lmpDate?,
  hcgResultRef?, hcgResultAt?}` judged by the `pregnancy_policy` (default: a declaration alone does
  not carry an ionising study; LMP reassuring ≤ 28 days); contrast consent = `ot`'s `consentSchema`
  (procedureCode = study type, templateVersion, language, signer patient|guardian + guardianId with
  consent authority, witness required for a thumb impression, laterality, conversionCovered,
  signedAt); renal `{creatinineUmolL, sampledAt, source internal|external, ckdFlagged}`, window 30 d
  OPD / 7 d admitted; prior reaction `{radiologistId?, reason?}` — the allergy list is read by the
  gate, and a contrast allergy needs a named radiologist + reason; MRI `{implants[], pacemaker,
  clips, cochlear, metalFb, claustrophobia}` — any of the four hard ones is override-only; Form F
  takes nothing (the register is read); chaperone `{chaperoneUserId}` — an active user, not the
  actor, not the patient; side `{patientStated}`; MLC `{status registered|ruled_out, mlcNo?}`.
- **(c) Overrides today.** `POST …/gates/:kind/override` on `radiology.gates.override` + the
  engine's `radiologist` edge, reason required, lexical §5(2) check, evented. `form_f` and
  `laterality_confirm` never; `identity_two_factor` override-only (never waived). Nothing lets a
  satisfier ASK. **The kernel approvals spine carries it:** `requestApproval(tx, …)` on the caller's
  transaction with a subject (the gate), a note, an approver role, a closure SLA + ladder,
  `approval.requested`, requester ≠ approver SoD; `approveRequest`/`rejectRequest` are Db-first
  (their own transaction). Radiology already registers one type (`imaging_definition_publish`) the
  same way, so a second type is the house pattern and no local request table is needed.
- **(d) Creatinine and eGFR.** No reader existed: the lab keeps signed values in `lab_results`
  (analyte `CREA`, mg/dL, in the catalogue fixture), and `patientResultsForDoctor` is the doctor's
  (PHI-logged, clinician-gated). A small `latestVerifiedCreatinine` is added to the lab's index
  (verified, not superseded, not restricted, whole merge chain, unit-converted, draw instant from the
  specimen). eGFR CKD-EPI 2021 is computable server-side: `patients.dob` + `patients.sex` are on the
  master, `ageInYearsOn` exists (`applicability.ts`), no race term. Not computable → no DOB, a sex
  other than female/male, or under 18 (CKD-EPI is an adult equation) → the ceiling stays.

**RS5 as built** (this PR; one lane, **no migration**):
- **Core.**
  - `egfr.ts` — CKD-EPI 2021 (no race term), rounded as a lab prints it, bands on the rounded figure.
    The kidney gate (`gates.ts` `renal_function`) reads age and sex from the patient master on the
    day the gate is cleared: **< 30 → `gate_open`** (the radiologist's override), **30–44 → satisfiable
    only with `ivHydration: true`**, the instruction text stored as evidence, **< 45 → the metformin
    note stored**; no eGFR (no DOB, sex not female/male, under 18) → the 176.8 µmol/L ceiling, as
    before. Evidence now carries `egfr`, `egfrBand`, `egfrEquation` or `egfr: null` +
    `egfrNotComputed`. The gate also accepts `labResultId` — the value and draw instant are then READ
    from the lab (refused unless it is the latest signed one).
  - `modules/lab` gains `latestVerifiedCreatinine` (index export, additive): analyte `CREA`,
    verified, not superseded, not restricted, whole merge chain, mg/dL converted, draw instant from
    the specimen. `modules/opd` exports `lastActiveVitals` (additive) for the weight.
  - **The override request** (`override-requests.ts`): approval type **`imaging_gate_override`**
    (approver `radiologist`, urgent, 30 min, no act-first) registered by `seed:radiology` beside
    `imaging_definition_publish`. `POST /radiology/studies/:id/gates/:kind/override-request`
    (`radiology.gates.satisfy`, note required, one pending per gate — `override_already_requested`;
    **`form_f` and `laterality_confirm` refuse the request itself**); `GET
    /radiology/gate-override-requests` and `POST …/:approvalId/decide` (`radiology.gates.override`):
    grant → `approveRequest` then the EXISTING `overrideGate` with the reason (checked on execute:
    granted, this type, this gate; the §5(2) lexical check runs before the grant commits); refuse →
    `rejectRequest`. A grant given in the kernel `/approvals` inbox is applied by the same decide.
  - `prep-bay.ts`: `GET /radiology/prep` (checked-in studies with an open PREP gate, STAT first) and
    `GET /radiology/prep/studies/:id` (patient in hand), both `radiology.gates.satisfy`, PHI-logged.
    Room gates = `identity_two_factor`, `laterality_confirm` (Gap 4, UI routing only).
  - Evidence shapes widened (optional fields only): MRI gains `neurostimulator` and `orbitMetal`
    (both **stop the scanner**) and records welder, prosthesis, pregnancy, tattoos, prior surgery,
    weight, zone, the MR-conditional card, the sweep and the two typed signatures; the prior-reaction
    gate records `premedication[]` (drug, dose, time) beside the radiologist's named decision.
  - Two error codes: `override_already_requested` (409), `unknown_override_request` (404).
    `radiology-http.ts` maps `ApprovalError` (409/404) and `SodViolationError` (403).
- **Web.** `/radiology/prep` — the *Prep & safety bay* station (`radiology.gates.satisfy`): one list,
  *Clocks running* = requests waiting on the radiologist; lane = allergies (contrast marked), the
  lab's creatinine with eGFR and band, weight, LMP; centre = every gate as a **form** (no JSON), room
  gates "closed at the console" with no control, *Ask the radiologist to override*, *Waive* only for a
  holder of `radiology.gates.override`; the contrast record and reaction under the gates; dock = the
  one next act (Enter). The study console lost its JSON textarea (per-kind forms, and the
  radiologist's grant/refuse on a pending request); the worklist's clocks list the waiting requests
  for the radiologist. MRI screening form (T4); contrast panel (T5: agent, batch, expiry — expired
  refused before sending — weight-based volume suggestion, route, site, rate, injector, extravasation
  check) and reaction (severity, onset, signs, treatment, clinician, outcome; says it writes the
  allergy the next study's gate reads). English + Hindi (`radiology.bay.*`; `radiology.prep.*` is
  RS3's prep instructions).
- **DECIDED.**
  - **`radiology_nurse`** is a new role (the standard Indian-hospital prep-bay nurse): worklist.read,
    gates.satisfy, contrast.record; on the `imaging_gate` satisfy edge; **no override, no waiver, no
    check-in**. The `imaging_gate` definition changed, so a deployment re-runs the §3 activation
    ceremony once (runbook §12).
  - **`radiology.contrast.record`** is split off `radiology.acquire` for the two contrast POSTs, so
    the nurse who injects does not also get to start/finish acquisitions; everyone who could record
    contrast before still can.
  - The request rides **kernel approvals**, not a radiology table: the spine carries requester,
    subject, note, approver role, SLA ladder, `approval.requested` and the requester ≠ approver SoD.
    The radiologist therefore holds `approvals.requests.read`/`.decide` (the spine's invariant).
  - **A waiver stays the radiologist's act** (the server's rule since 18a): the bay shows *Waive*
    only to an override holder; the nurse's "does not apply" goes as *Ask the radiologist*, answered
    by an override carrying that reason.
  - A **positive MRI screen is not sent** (the server would store nothing): the form hands a summary
    note to *Ask the radiologist*. **No card upload** — there is no document-store route; the card's
    device, model, serial and conditions are recorded as fields.
  - **Rate, injector and the extravasation check** have no column; they are written into the
    administration's site line (≤ 120 characters) until a migration adds them.
  - The **urine pregnancy test at the bay** is recorded as the policy's `hcg_result` with a
    `bay-urine-hcg:negative:<instant>` pointer (no lab row exists for a bedside strip).
  - Weight-based volume **suggestion only**: iodinated 1 mL/kg to 100 mL; gadobutrol 0.1 mL/kg; a
    0.5 M gadolinium agent 0.2 mL/kg.
- **Counts.** Core, fail-first: eGFR gate block 4 failed on the pre-RS5 `gates.ts` (4 failed, 48
  skipped), then green; override requests 8 of 9 failed against a no-lane stub and the pre-RS5
  gate definition (the ninth — the nurse cannot override — is a regression pin that already held),
  and the never-override refusal test failed with the refusal mutated out. Touched core suites after
  rebase: **45 suites, 532 tests green** (radiology module, seed-roles, radiology e2e, seed-radiology,
  nav-parity, caddyfile-parity, lab manifest). Web: the prep-bay file failed to resolve and the new
  console test failed on the old console (the JSON textarea), then green; touched web suites **17
  files, 132 tests green**. Pins: seed-roles permissions 204 → 205, pairs 425 → 432, model
  permissions 184 → 185, held 190 → 191, roles 40 → 41, radiologist 16 → 19, radiographer 10 → 11,
  radiology manifest 18 → 19 permissions, approval types 22 → 23 (approver roles + `radiologist`),
  non-table pairs 200 → 202; caddyfile routes 76 → 77; README radiology table + `radiology_nurse`
  column and `radiology.contrast.record` row.
- **Walk.** `/opt/hmis-context/rs5-walk/` — the bay with nobody in hand, the kidney gate (eGFR 32,
  hydration), MRI screening with an asked gate, the contrast + reaction panel on the table, and the
  study console's form, at 1920/1440/1280/1024/768/390: 0 page errors, 0 sideways overflow.
- **Moved later.** Premedication timers and the earliest-scan clock, cannula and fasting records and
  the sedation pre-check (the board's "bay work"; not gates in the code) → RS6 with the room console;
  the consents register (`prep:consents` as its own view) → RS9 with the release register;
  auto-applying a grant from the kernel inbox (an `approval.granted` consumer) → RS10 with the HOD's
  approvals; columns for injection rate / injector / extravasation → the next radiology migration;
  the card photo → when a document store exists; eGFR for children (Schwartz needs height) → the
  paediatric radiology slice.

### RS6 · Modality rooms
- **Web:**
  - **From RS4:** the `imaging_protocols` definition kind (schema, CHECK widening — one migration — and
    a seeded empty draft) arrives here with its first reader, the Protocol step.
  - `room:console`: per machine, MWL-backed. Identify (room gates) → Protocol (protocol book, weight-based contrast,
    breath-hold script in Hindi and English) → Acquire (start/abort, dose entry) → Send (acquired).
  - `room:portable`, `room:dose`, `room:rejects` (bill decisions resolved through their route, first web caller),
    and `room:downtime`.
  - The IR suite screen is **deferred to RS12**.
- **Core:** repeat and contrast-not-given raise their bill decisions from the console act.
- **Journeys:** J1–J3 room hops, J6, J8, J10.

### RS7 · Ultrasound & PCPNDT
- **Web:**
  - `usg:room`: Form F first, then structured obstetric biometry (GA by CRL/FL, EFW by Hadlock, EDD), then sign in
    the room;
  - `usg:formf`;
  - `usg:register`: first web caller of `/pcpndt/registrations`;
  - `usg:monthly`: the return by the 5th, with an inspection bundle.
- **Core:** a monthly-return read model, and the PCPNDT declaration line fixed in the obstetric template.
- **Journeys:** J4.
- Migration: none expected.

### RS8 · Reading room (HEAVY)
- **Core:**
  - **Coded report fields:** BI-RADS, TI-RADS, LI-RADS, PI-RADS, O-RADS, Fleischner and ASPECTS, carried by
    `report_templates` (moved here from RS4 — the kind, its schema and its CHECK widening ship with the
    reading room that reads them). Calculators are deterministic.
  - **Pre-sign checks, deterministic:** side against the order and the dictation; sex-specific organs; critical
    terms with negation handling; measurement against the prior. The checks run before any model.
  - **Co-sign:**
    - a role `radiology_resident`, with seed-roles and the count pins;
    - a draft signed by a resident is `awaiting_cosign`, and publish refuses `cosign_required`.
  - **Follow-ups:** a new table `imaging_followups` (recommendation, due, state, new order), plus a sweep that
    chases when a follow-up is due.
  - **Peer review:** a new table `imaging_peer_reviews` (random 2–5% sample plus every discrepancy, blind).
- **Web:**
  - `read:worklist`: urgency-sorted, TAT clocks, claim lock.
  - `read:report`: the viewer pane, templates, dictation, checks, and the keys ↑ ↓ T D S.
  - `read:critical`: the ladder and read-back, over the existing routes (first web callers).
  - `read:followups`, `read:amend` (prelim and amend, first callers), `read:peer`, `read:tele`.
- **Print:** the signer block per ruling 4 (additive snapshot on `imaging_reports`).
- **Journeys:** J1–J3 and J7 reading hops, J2 critical, J9 recommendation.
- Migrations: co-sign state, follow-ups, peer reviews — **three PRs**, one migration each.
- Claims: `seed-roles` + pins.

### RS9 · Release and the closed loop
- **Core:**
  - `imaging_report_delivery` gains `acted_at`, `acted_by` and `acted_note` (gap 6);
  - `POST …/reports/:id/acted` for the treating doctor;
  - collector name, relation and OTP on hand-over (the 17-F F8 pattern);
  - film and CD lines per ruling 1.
- **Web:**
  - `desk:reports`: the release register, film/CD queue and hand-over;
  - `doc:results`: criticals first with read-back acknowledgement, then unread, then read-not-acted, then
    follow-ups to book;
  - `doc:report`;
  - `pt:*` message templates. They are written now; sending waits for the WhatsApp adapter's merge and Meta's
    approval.
- **The north-star read model:** order → acted, per modality and source.
- **Journeys:** J1 last hops, J4 release, J9 doctor hop.
- Migration: delivery columns.

### RS10 · Supervisor & HOD
- **Core:**
  - `GET radiology/supervisor/floor`: pipeline by stage with the oldest wait, rooms, readers' load, turnaround median
    and 90th percentile against target, north-star, and leakage from `acquired_unbilled`.
  - **Escalations ride the kernel obligations and alerts spines. This is not a second system.** Sources:
    - red criticals at rung ≥ 2;
    - holds over 30 minutes;
    - machines down;
    - licence gaps;
    - STAT unread over 15 minutes;
    - bill decisions older than a day.
  - Approvals are read from `kernel/approvals`.
  - The access log reads `imaging_image_views` and PHI audit.
- **Web:** `hod:floor`, `hod:escalations`, `hod:approvals`, `hod:quality` (NABH imaging indicators), `hod:equipment`,
  `hod:roster` (roster module), `hod:money` and `hod:audit`.
- **Journeys:** J2 escalation, J5, J8, J10 floor, J11.
- Claims: the alerts/notify manifests.

### RS11 · Radiation safety, completed
- **Core:**
  - TLD CSV import from the service provider's file (ruling 5);
  - an incidents register with the AERB-notification clock;
  - a failed QA sets `qa_blocked` through RS4's status writer;
  - a pregnant worker's declaration triggers the reassignment prompt.
- **Web:** tabs added to `radiation-safety.tsx`, or moved into the station per RS1.
- **Journeys:** J6.
- Migration: incidents.

### RS12 · Real PACS, IR and teleradiology (infrastructure)
- 18b-ii per ruling 6:
  - Orthanc behind the hospital network;
  - OHIF embedded in `read:report`;
  - MPPS and dose SR from the machines (dose entry becomes a confirmation, not typing);
  - reconciliation of unmatched studies.
- The IR suite (`room:ir`): sign in, time out, fluoro and skin-dose alert, sign out.
- Night teleradiology per ruling 7: an external reporter identity, prelim, and morning over-read.
- Procurement and the deploy are owner-authorised steps.

### Order

RS0 (parallel, all along) · RS1 → RS2 → RS3 ∥ RS4 → RS5 → RS6 ∥ RS7 → RS8 → RS9 → RS10 → RS11 → RS12.

RS2 before RS3 because the desk has nothing to book without a door. RS4 before RS6 because the room console needs AE
titles and statuses. RS9 before RS10 because the HOD's north-star counter reads `acted_at`.

## Rules every phase keeps

- **The stores are the spine.** Every seat reads the same rows. No station keeps a private copy of a critical call, a
  release, a follow-up, a bill decision or an approval.
- **Presence is derived.** Opening the patient at the desk on the day is check-in; opening at the console is "in the
  room". No button records a fact the system already knows.
- **Every refusal names who fixes it and links to that seat.** Refusals name rooms and people, never ULIDs (#138).
- **Copilot:** drafts only, capped at T2–T3; it never orders, signs, bills or waives. The deterministic checks run
  before any model. Nothing with inference runs on production before DPIA v0.2, so copilot drafts ship deterministic,
  or stay behind a kill switch that is off in production.
- **Acceptance of every phase** adds the census row, event or runbook section that proves it, and updates
  `radiology-go-live.md` where the stand-up changes.

## Shared files each phase will claim

- `router.tsx` — every web phase.
- `apps/core/drizzle/**` — RS4, RS8 (three), RS9, RS11.
- `scripts/seed-roles.ts` + `test/seed-roles.test.ts` — RS8.
- `kernel/resources` — RS4.
- The OPD consult screen — RS2.
- The tariff — RS4.
- The alerts/notify manifests — RS10.
- `apps/web/src/locales/*.json` — web phases.

Coordinate before editing, per CLAUDE.md.

## Open owner items

**None blocking code.** Every money, procurement and law item is DECIDED above under the 28 Sep delegation.

**Facts only the owner holds, for RS0:**
- the named RSO;
- the machines actually installed, with make, model and serial;
- the licence certificates;
- the §19 PCPNDT certificate;
- the real price list.
