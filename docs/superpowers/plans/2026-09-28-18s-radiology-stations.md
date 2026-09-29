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
    ceremony once (runbook §14; §13 at build, renumbered when RS8a took §13).
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

**RS6 spike** (read on main `4d05ffdc`, 29 Sep, before any code):
- **(a) Dose fields and the DRL book.** `recordAcquired` takes four numbers — `doseCtdivol` (mGy),
  `doseDlp` (mGy·cm), `doseDap` (Gy·cm²), `fluoroSeconds` — plus `doseManual`; an ionising study
  must carry at least one (`dose_required`, backed by `imaging_studies_dose_ck`). The modality
  vocabulary is `xray | usg | ct | mri | mammography`, so the console asks CT for CTDIvol + DLP,
  X-ray for DAP (+ fluoro seconds when screened), mammography for DAP, and nothing for USG / MRI.
  There is **no AGD column**: a mammography unit that shows only AGD cannot be recorded as AGD
  (moved to RS12's dose SR). The DRL book (`dose_reference_levels`) is `{levels: [{study_type_code?
  | modality?, quantity: ctdivol|dlp|dap|fluoro_seconds, value, source?}]}`; `drlFor` picks study
  type first, then modality, on a quantity the examination actually measured, and the verdict is
  STORED on `radiation_dose_register` (`drl_quantity`, `drl_value`, `over_drl`). **There is no reason
  column** — nowhere to keep "why above the DRL".
- **(b) Abort and repeat.** `abortAcquisition` (reason required) sends `in_acquisition → ready`,
  releases the machine, keeps `acquisition_started_at`, raises nothing. A repeat is modelled only
  as a SECOND study row: `repeat_of_study_id` + `repeat_reason` (both or neither, CHECK) on
  `recordAcquired`, which raises `repeat_no_charge` then. **Nothing creates such a row** — no route
  and no screen — so `repeat_no_charge` has never been raised. `contrast_not_given` is raised by
  `recordAcquired` itself when `contrast_option = required` and `contrastGiven` is false (detail:
  study type + service, no reason). `acquired_unbilled` likewise; `performed_then_cancelled` by
  `cancelStudy`. The queue (`GET /radiology/bill-decisions`, resolve) is
  `radiology.bill_decisions.manage` — the desk and billing manager, **not the radiographer** (the
  performer does not decide who pays; kept).
- **(c) Room gates' evidence.** `identity_two_factor`: `{secondIdentifier: dob|uhid|wristband,
  value}` — UHID and wristband compared with the patient master's UHID, DOB with the DOB; a
  mismatch leaves the gate open (`gate_open`); never waivable, overridable with a reason.
  `laterality_confirm`: `{patientStated: left|right|bilateral|na}` — records the side on the study;
  a side that disagrees with one already recorded is refused; never overridable. Satisfy is
  `radiology.gates.satisfy` (radiographer holds it).
- **(d) Adding `imaging_protocols`.** `IMAGING_DEFINITION_KIND_VALUES` (kernel schema
  `radiology.ts`) feeds `imaging_definitions_kind_ck` through `inList`; widening it is one
  drop-and-add of the CHECK (0054 and 0062 did exactly this). `SCHEMA_BY_KIND` in `definitions.ts`
  gains the body schema; the draft / publish / active routes take the kind from the same enum, so
  they need no change. `seed:radiology` seeds only `study_types`; `pacs_settings` and
  `dose_reference_levels` are never seeded — so the house pattern is **no seeded draft** for a book
  the hospital authors.

**RS6 as built** (this PR; lane `radiology-rs6`, rebased on RS4 `5a3713b9`; one migration, `0146`):
- **T1 · the protocol book (core).** `imaging_protocols` is a governed definition kind: kernel
  `IMAGING_DEFINITION_KIND_VALUES` + `imaging_definitions_kind_ck` widened (migration
  `0146_radiology_room_console`), `imagingProtocolsBodySchema` in `definitions.ts` (per
  `study_type_code`, or a `modality` default; technique, preset, kV/mAs ranges, CT slice/pitch, MRI
  sequences, contrast phase + mL/kg + max + delay (+ agent, rate), breath-hold EN + HI (both or
  neither), paediatric weight bands; refuses no key, duplicate key, inverted range, half a script, a
  band with from ≥ to). `protocolFor` picks the study type's own, then the modality default. Drafted,
  approved and published through the SAME routes as every book; Setup → Books lists it (RS4's
  `setupBooks` iterates the kinds). **Nothing seeded, not even an empty draft** (DECIDED: the house
  seeds only `study_types`; a body needs ≥ 1 protocol, so an empty draft is not a valid body).
- **Core reads and acts** (`room.ts`, `radiology-room.controller.ts`, all `radiology.acquire`):
  `GET /radiology/studies/:id/room` (patient in hand: age/sex, active allergies, last charted OPD
  weight, the creatinine / eGFR the renal gate was satisfied with, the active protocol, the DRLs that
  apply, repeats so far; one `imaging.study` PHI row); `POST …/acquisition/repeat {reason}`
  (`recordRepeatExposure`: `in_acquisition` only; appends `imaging.exposure_repeated`; ONE
  `repeat_no_charge` per study, detail `{reason, inRoom: true}`); `GET /radiology/room/rejects?from&to`
  (repeats ÷ studies acquired per machine × technologist, reasons, log by accession, open
  `repeat_no_charge` / `contrast_not_given` decisions by kind — no money, no names).
  `acquired` gains `drlReason` (kept on the new `radiation_dose_register.drl_reason` only beside an
  over-DRL verdict; CHECK `radiation_dose_register_drl_reason_ck`) and `contrastNotGivenReason`
  (rides the `contrast_not_given` detail). `start` gains optional `bedsideSafety` (the note on the
  `in_acquisition` transition; `.strict()` still refuses `onDate`).
- **T2 · the Room console (web).** `/radiology/room` — the `room` station, header views Room console
  · Dose log · Rejects & repeats · Downtime; `?machine=&study=` in the search. Right list = the
  machine's floor list (STAT first, then on the table → ready → arrived → booked), clocks STAT > 10
  min and ready > 20 min; opening a patient checks in a booked study (no presence button);
  `RoomConsole` (`components/radiology/room-console.tsx`) Identify → Protocol → Acquire → Send with
  one docked act (Enter). Room gates (`identity_two_factor`, `laterality_confirm`) are closed at the
  console; any other open gate is shown with a link to `/radiology/prep` and the dock stays shut.
  Refusals in the server's words with the seat: `device_not_licensed` → Radiation safety,
  `device_unavailable` / `already_occupied` → Downtime, `payment_required` → desk, `not_ready` /
  `gate_open` → prep. The study page links to the console and the console's lane links back.
- **T3 · Portable round.** A bed opens `RoomConsole` in bedside mode inline; the three bedside
  radiation checks gate Start and are attested as text on the start.
- **T4 · Dose log / Rejects & repeats.** Dose log over the existing `GET /aerb/doses` (radiographer
  holds `aerb.doses.read`), machine × IST day, above-DRL list with reasons (missing reason in red).
  Rejects over the new read; resolve through the existing bill-decisions route, offered only to a
  holder of `radiology.bill_decisions.manage`.
- **T5 · Downtime.** Machine statuses from `/radiology/devices`; *Report breakdown* = RS4's
  `setSetupDeviceStatus(id, "down", reason)` (holder of `radiology.devices.manage`), answers with the
  studies to move and links the diary; a technologist is told who marks a machine down; the paper
  note (manual accession sheets, back-entry with the paper time — `acquiredAt` / E11's late entry).
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *An in-room retake is the repeat the console records* (event + one no-charge decision per
    study); the second-study repeat (`repeat_of_study_id`) stays for a recall after Send — nothing
    creates one yet (moved to RS8/RS10, below).
  - *Repeat rate = repeats ÷ studies acquired* on that machine by that technologist; an exposure
    count needs MPPS (RS12). Target under 3 % (board). Repeat reason codes: positioning, motion,
    exposure, artefact, equipment.
  - *The technologist does not resolve bill decisions* — `radiology.bill_decisions.manage` stays with
    the desk and the billing manager (18a's "the performer does not decide who pays"); the board's
    "technologist confirms a free repeat" is not built.
  - *The technologist does not mark a machine down* — RS4 made it `radiology.devices.manage`
    (radiologist); Downtime tells a technologist to call the radiologist in charge and biomedical.
  - *The bedside checklist is attested text, not a gate* — a new gate kind is the gate model's and
    the prep bay's (RS5); the server records it on the start transition, the console requires it.
  - *Weight* comes from the last OPD vitals row; the technologist may type the weight on the table
    for the volume (not stored). The contrast volume is a suggestion; the volume given is typed.
  - *DRL reason* is asked only when a typed number is above a published level; never required, never
    blocks; kept only on an over-DRL register row (a reason on an under row explains nothing).
  - *Reject log names the accession, not the patient* (QA register; no PHI needed for a rate).
- **Pins.** Radiology events 15 → 16 (`imaging.exposure_repeated`); caddyfile routes 76 → 77
  (`/radiology/room`); Setup books 5 → 6 kinds; nav + `radiologyManifest.menu` + one station row.
  No new permission, no seed-roles change, no new error code.
- **Counts.** Core: `room.test.ts` 10 (T1 4 failed against the code without the kind/schema/
  migration; the repeat, DRL-reason and contrast-reason tests failed against mutants; the bedside
  note test failed against a start that dropped it); touched suites after rebase — radiology, aerb,
  kernel schema, snapshot chain, radiology e2e, caddyfile parity, seed-radiology, seed-roles: 76
  suites / 999 tests green. Web: `radiology-room.test.tsx` 13 (the file cannot load against main),
  portable 5 (the inline-console test failed against the old screen); touched web suites 17 files /
  158 tests green. Walk: 1920/1440/1280/1024/768/390 × 11 screens, 0 page errors, 0 sideways
  overflow (`/opt/hmis-context/rs6-walk/`).
- **Moved later.** Recall-for-repeat as a second study (`repeat_of_study_id` writer) and the HOD's
  approval of a free repeat → RS10 (approvals) / RS8 (reading room recall); AGD for mammography and
  dose from MPPS / dose SR → RS12; the MRI zone and screening form, contrast record and reaction
  forms → RS5 (linked by route); the call bell on the hall display, the protocol-change request to
  the reading room and the copilot panel → RS8/RS10; a breakdown ticket to biomedical and helium /
  chiller monitoring → RS10 (equipment); IR suite → RS12; per-exposure counts → RS12 (MPPS).
- **Money/law questions the rulings do not settle.** (1) Whether an in-room repeat needs any bill
  decision at all (nothing was charged twice) — built per the brief and ruling 8, one per study;
  the owner may prefer none. (2) Mammography units that report only AGD cannot be recorded until
  RS12; AERB's register accepts it, ours does not yet.

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

#### RS7 spike (read on main `5a3713b9`, 29 Sep, before any code)
- **(a) Form F — stored vs statutory** (PCPNDT Rules r.9(4), Form F as amended 2014). Columns:
  serial/year/machine/person/study/patient, `indication_code`, `gestation_weeks`, `applicability`,
  `result_summary`, signer and verifier; three jsonb blocks (`sections`, `declaration`, `referral`)
  that 18a left free-form (the only UI wrote `sections: {F: …}`). Statutory items: **Section A** —
  centre and registration no. (from the registration), name/age/address/phone (the patient record,
  read at print), **living sons and daughters (5)**, **husband's/father's name (6)**, **referring
  doctor + registration no. or self-referral (8)**, **LMP / weeks (9)**; **Section B** (ultrasound) —
  the performing doctor (person), indication i–xxiii (11), procedure (12), **date of the woman's
  declaration (13)**, date of the procedure (the study's acquisition), result (15, the signed report),
  to whom conveyed (16), MTP indication (17); **Section C** is invasive (genetic clinic, not this
  department); **Section D** — her declaration and the doctor's. Missing as STRUCTURE: 5, 6, 8's
  referrer, 9's LMP, 13 — **all storable under named keys in `sections` jsonb**, so no statutory
  column is missing and **no migration**. Finding: `result_summary` is accepted by the API and refused
  by `pcpndt_form_f_immutable` at completion (F63's trigger) — the result is the signed report's.
- **(b) Registrations.** `POST /pcpndt/registrations`, `…/:id/machines`, `…/:id/persons`,
  `POST /pcpndt/machines|persons/:id/deactivate` — `pcpndt.registrations.manage` (in-charge);
  `GET /pcpndt/registrations` — `pcpndt.registrations.read` (radiologist, in-charge), **zero web
  callers** before RS7. Form F: `POST /pcpndt/form-f`, `…/:id/record` — `form_f.write` (radiologist);
  `…/:id/verify` — `form_f.verify` (in-charge; no role holds write+verify, `same_actor`);
  `GET /pcpndt/studies/:id/form-f` — `form_f.read` (radiologist, radiographer, in-charge; PHI row).
- **(c) One sitting.** Yes: `signReport` needs `radiology.reports.sign` and a second factor on the
  SESSION no older than the window (15 min) — the web calls `POST /auth/totp/verify` then signs. No
  SoD between who scanned and who signs (SoD exists only on the Form F: writer ≠ verifier). **Gap
  found:** the signature had no PCPNDT membership check — a radiologist registered on no certificate
  could sign an obstetric report of a scan performed on a registered machine. Closed (below).
  Also: the radiologist does not hold `radiology.gates.satisfy`, so a sonologist alone could open a
  Form F but not move the study to `ready` — the `form_f` gate takes no caller evidence (it reads
  the register), so RS7 gives that one kind its own door behind `form_f.write` (below).
- **(d) Where the sex could leak.** The report body/impression/amend reason/critical notes are read
  by the F66 lexical lockout — but its DEMOGRAPHIC tier (`male`, `female`, `boy` …) is **liftable by
  the medical superintendent**, so *"single live male foetus"* was one approval from a signed report.
  Other free text: the Form F `result_summary` (unguarded), gate waive/override reasons (coded tier
  only). DECIDED standard: a deterministic phrase check (below), refusing with a named code, never
  editing text.

#### RS7 as built (this PR; one lane, no migration)
- **T1 — the foetal-sex guard** (`pcpndt/foetal-sex.ts`, the Act's module; radiology imports it).
  Rules: a sex word beside a foetal noun with only fixed filler words between ("male foetus", "the
  foetus appears to be female", "fetal gender: male"; strictly foetal nouns on EVERY report — N9's
  pregnant trauma CT; baby/twin/genitalia only on obstetric reports); a sex stated as a value
  ("sex: M", "लिंग: पुरुष"); words with no innocent reading on an obstetric scan (boy, girl, लड़का,
  लड़की, ladka/ladki, bare male, the foetal genital anatomy and the turtle/hamburger signs). Case,
  Latin diacritics (NFKD, œ→oe) and the Devanagari nukta folded; Unicode word boundaries; a comma or
  full stop breaks a phrase ("28 y, female, single live intrauterine foetus" passes). Refusal
  `foetal_sex_disclosure` (422) on prelim, sign, amend, publish (re-reads the SIGNED text), free-text
  notes, and the Form F `result_summary`; checked BEFORE the lexical lockout; `lockoutOverride` never
  reaches it. Nothing is ever edited.
- **The Act at the signature** (`reports.ts` `assertSignerRegistered`): a `form_f_required` study is
  signed (and amended) only by a person registered on its machine's registration on the IST day —
  `person_not_registered` / `machine_not_registered`, the acquisition's own checks.
- **T2 — biometry** (`@hmis/contracts` `obstetric.ts`, pure; web copy `lib/obstetric.ts` with a
  parity test, because the web imports only types from contracts): Robinson CRL, Hadlock 1984
  BPD/HC/AC/FL, Hadlock 1985 EFW (4-parameter; 3 without BPD), composite GA (CRL when present, else
  the mean of the Hadlock ages), EDD by LMP (Naegele) and by scan, AFI bands, FHR 110–160 flag,
  1–4 foetuses. Stored in `imaging_reports.body.obstetric_biometry` (jsonb — no table); the server
  validates (`invalid_biometry`: out of range, unknown key — there is no sex field — or not an
  obstetric study) and **recomputes `derived` on every save**, discarding any caller's.
  **The declaration** (`body.pcpndt_declaration`, English + Hindi) is written by the server into
  every signed obstetric version and stripped from anything a caller sends.
- **T3 — `/radiology/usg`, Scan room** (station key `usg`, nav `pcpndt.form_f.write`, `anyOf`
  registrations.read / form_f.read for the books): right = checked-in → signed ultrasound studies on
  ultrasound machines, each with its Form F serial and state from the register; lane = the patient on
  the couch (machine, room, serial, LMP, weeks); centre = Form F (indication from the Act's list →
  open → her declaration, sons/daughters, husband's name, LMP, referral → sign) → Start scan →
  measurements with live GA/EFW/EDD → rule-built draft + the fixed declaration → save → sign (TOTP
  verify, then sign) → publish; non-obstetric: organ chips → report → sign. One next act in the dock
  (Enter). Refusals in plain words naming the machine and the person, with the seat that fixes them.
  **`POST /radiology/pcpndt/studies/:id/form-f-gate`** (`form_f.write`) closes ONLY the `form_f`
  gate from the register row and evaluates readiness (`usg-room.ts`).
- **T4 — the books.** `GET /radiology/pcpndt/register?month=` (`form_f.read`): the IST month's
  serials by serial — state (open / signed / verified / cancelled = open form on a cancelled or
  no-show study, serial kept), missing statutory fields (`pcpndt/form-f-fields.ts`), signer names,
  and the per-machine-per-year gap check; **no patient field**. `GET /radiology/pcpndt/monthly-return?month=`
  (`registrations.read`): per ultrasound machine — scans, PCPNDT scans, Form F opened/signed/verified/
  open/cancelled, scans without a signed form; discrepancies (scan without signed form, signed not
  verified, opened not scanned, signed with fields missing, serial gap); due the 5th with days left;
  CSV. Web: Form F, Registration (first caller of `GET /pcpndt/registrations`, now labelled with
  machine codes and people's names — additive fields; renewal clock at 90 days) and Monthly return
  (this/last month, copy the CSV — submission is the nodal officer's act on the state portal).
- **T5 —** `docs/runbooks/pcpndt-go-live.md` §9 (the sonologist's day, the register, the return);
  §6/§7 prose swept for the new renewal clock and the prepared return.
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *The register lists serials, not women* — the board's register shows patient names; this one does
    not (the module's written rule, `pcpndt/manifest.ts`). The name is one click away, PHI-logged.
  - *Verification does not hold the scan or the report* — the in-charge's counter-signature is a
    register act; the return lists "signed, not verified" as a discrepancy to close.
  - *`female` alone on an obstetric report* is not a foetal-sex disclosure (the new guard passes it)
    but F66's demographic tier still asks for a rephrase or the MS there — unchanged; the room's
    drafts never write the mother's sex (it is on the header).
  - *Negation is not an escape* — "the foetus is not male" is refused.
  - *Images*: the room records the acquisition as `no_pacs_images` until RS12's PACS.
  - *The list starts at check-in* — the desk checks in (the radiologist has no `radiology.checkin`);
    opening a patient in the room is "on the couch".
  - *The monthly view opens on last month up to the 5th*, this month after.
  - *Composite GA* = CRL when measured, else the arithmetic mean of the Hadlock ages (the consoles' AUA).
- **Counts.** Core: `pcpndt/foetal-sex.test.ts` 40 (true positives + false-positive guards),
  `radiology/obstetric-report.test.ts` 11 (**10 failed against the unwired code**, 1 non-regression
  guard passed), `radiology/pcpndt-books.test.ts` 6, `pcpndt/registrations.test.ts` +1 (failed
  against the old reader), `pcpndt/form-f.test.ts` +1 (failed against the old `recordFormF`),
  `reports.test.ts` A3 now expects the stronger `foetal_sex_disclosure`. Contracts
  `obstetric.test.ts` 7 (Robinson/Hadlock published-table checks). Web: `radiology-usg.test.tsx` 9
  (2 failed with `verifySecondFactor` / `closeFormFGate` removed — mutation proof),
  `lib/obstetric.test.ts` 2 (parity). After the rebase on RS6 (`583db9ff`): core touched suites
  (`modules/pcpndt`, `modules/radiology`, `radiology.e2e`, caddyfile/nav parity, roles-catalog,
  seed-roles) **50 suites / 627 tests green**; web 12 files / 117 tests; contracts 30; `vite build`
  green. Pins: caddyfile routes 77 → 78 (`/radiology/usg`, after RS6's `/radiology/room`); no new
  permission, event, template or migration.
- **Moved later / owed.** Ages of living children (Form F item 5 asks sons and daughters WITH ages;
  counts only here); Form F items 16–17 (to whom the result was conveyed, MTP indication); the
  foetal-sex phrase check on gate waive/override reasons (coded tier only today) → RS8's pre-sign
  checks; the printed report's signer block and the declaration on paper → RS8/RS9 print (the signed
  body carries `pcpndt_declaration` for it); Form G and the inspection bundle; the Rule 13 intimation
  letter; registration WRITES on screen (the in-charge still uses the API/runbook §2–§4).
- **Law questions the rulings do not settle.** (1) The server lets a scan START on an OPEN Form F
  (the gate) and refuses only the ACQUIRED mark without a recorded one; the room records before it
  starts. Whether the Act's "before the procedure" should be enforced at start is an owner/legal call
  (changing it re-orders 18a's A2 design). (2) `recordFormF` does not refuse a form missing statutory
  fields; the register and the return flag them. (3) Two-year statutory retention vs the hospital's
  five years online (ruling 6) — nothing is deleted either way.

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

**The split (29 Sep).** RS8 is the HEAVY phase, so it ships as three PRs, each with at most one
migration:
- **RS8a — the reading room, part 1:** the `report_templates` governed book with coded categories and
  their calculators; the deterministic pre-sign checks (one pipeline, a dry-run read for the screen);
  the signer block snapshotted at sign and printed (ruling 4); the reading workspace
  (`/radiology/read`: worklist with TAT clocks, report view).
- **RS8b — part 2:** co-sign for residents (`radiology_resident`, `awaiting_cosign`,
  `cosign_required`, seed-roles pins); the critical-call ladder UI (`read:critical`, first web callers
  of flag/acknowledge); the prelim and amend UI (`read:amend`).
- **RS8c — part 3:** the follow-ups tracker (`imaging_followups` + the due sweep), peer review
  (`imaging_peer_reviews`), night and outside reads (`read:tele`).

#### RS8a spike (read on main `5a3713b9`, 29 Sep, before any code)
- **(a) The report body.** `imaging_reports.body` is `jsonb`, written as `Record<string, unknown>`
  (the controller's zod is `z.record(z.string(), z.unknown())`); the impression has its own column.
  Every reader of the body takes STRING entries only — `abdm-release.ts` `sectionsOf` filters to
  non-empty strings, the report screen reads `findings` and spreads the rest. So a non-string key is
  invisible to every existing reader: **coded categories live in the body under one reserved key,
  `coded`** (`{ birads: "4A", tirads: {...}, … }`), no table and no column. The row is append-only by
  trigger (`to_jsonb(NEW) - status - published_at`), so anything added to the row is protected with no
  trigger change.
- **(b) The signer at sign.** `insertVersion` stores `signer_id`, `signed_at`, `second_factor_at` —
  an id and two instants; **no name, no qualification, no council number**. Where they live today:
  the name is `users.full_name`; a council number is `opd_doctors.registration_no` (what the lab
  report prints, 17-F) and the roster's `staff_credentials` (`nmr` / `smr`, R4 — **no route, no
  screen**: a reader without a writer); a **qualification exists nowhere general** —
  only `pcpndt_registered_persons.qualification` (sonologists) and `aerb_persons.qualification`
  (RSO). The TOTP secret has no key id (`user_totp` is keyed by user; `enabled_at` names the
  enrolment).
- **(c) Printing.** The imaging report is **not printed anywhere** today — no component, no
  `kernel/printing` renderer. The lab's A4 (`lab-report-print.tsx`, `.print-doc`, from a signed
  snapshot) is the precedent.
- **(d) TAT fields.** The worklist row carries `priority` (stat / urgent / routine), `createdAt`,
  `checkedInAt`, `scheduledAt`; the study also has `acquiredAt` and `bedsideLocation`. There is no
  source column (OPD / IPD / ER): no IPD or ER module exists. There is no claim: a draft row has no
  author column, but `imaging_image_views` records who opened the images and when.

#### RS8a as built (this PR; migration `0148_radiology_reading_room` — renumbered from 0147 at merge, RS11 took 0147)
- **T1 — the books.** Two new governed kinds, the RS6 pattern (kind CHECK widened in the one
  migration, schema in `definitions.ts`, listed in Setup → Books automatically):
  `report_templates` (key, modalities, optional `study_type_codes`, sections each with a "normal
  study" text, macros, coded categories each `required` or not; every template has an impression) and
  `report_signatories` (see T3). The coded systems and their calculators are pure functions in
  `@hmis/contracts` `imaging-coded.ts`: BI-RADS 0–6 (4A/4B/4C), ACR TI-RADS TR1–TR5 with the points
  calculator and FNA / follow-up size rules, LI-RADS LR-1…5/M/TIV, PI-RADS 1–5, O-RADS US 0–5,
  Lung-RADS, Fleischner 2017 (type × count × size × risk → interval; ≥ 3 cm is a mass), ASPECTS
  (10 regions). The web keeps a copy (`apps/web/src/lib/imaging-coded.ts`, the `eye-line.ts`
  precedent) held equal over the calculators' whole input space. Coded values live in the report
  body under `coded` (spike a) — every existing reader ignores non-string keys.
  **Nothing seeded active**; the reference set (13 templates, all eight systems) is
  `docs/runbooks/radiology-report-templates.reference.json`, a paste for the HOD, and a test holds it
  valid against the schema.
- **T2 — the checks.** `checks.ts`: ONE list, `PRE_SIGN_CHECKS`, of pure checks over a context
  `reports.ts` gathers once; run at **sign and at amend**, and as a dry run
  (`POST /radiology/studies/:id/reports/checks`, `radiology.reports.write`, writes nothing).
  Refusals, each its own code: `impression_required`, `side_conflict` (a left study whose text names
  only "right"), `sex_organ_mismatch` (whole-word organ lists; `other`/`unknown` not checked),
  `coded_category_required` (missing or not a member). Warnings, acknowledged by code
  (`acknowledgedWarnings` on sign/amend) or refused `checks_unacknowledged`: `side_mentions_both`,
  `coded_calculation_differs`, `critical_term` (a word list with NegEx-style negation inside the
  clause — "no evidence of pneumothorax, haemorrhage or free air" is not a hit, "no effusion; large
  pneumothorax" is). The signed row stores `sign_checks` (checks run, warnings, who acknowledged,
  when). The PCPNDT lockout and the order-side check (A4) stay in `assertSignable` and run first.
  **RS7's `foetal_sex_disclosure` joins the list** as another entry (keeping its code), adding any
  fact it needs to `PreSignContext`; the list is exported from `index.ts`.
- **T3 — the signer block.** `signer.ts` snapshots at every signature (sign and amend) onto the new
  `imaging_reports.signer`: name (`users.full_name`), qualification and designation (the signatories
  book), council registration (the book's entry, else the roster's live `nmr`/`smr` credential, else
  `opd_doctors.registration_no`, with the source recorded), Doctor ID (`opd_doctors.code`), and the
  signature marker: `totp_second_factor`, the factor's instant, a key id (`totp:` + a digest of the
  user and the enrolment instant; the secret is never read), SHA-256 of the signed content. Refused
  `signer_credentials_missing` (403) naming what is missing and the seat that fixes it. Census row
  `radiology_report_signatories` (G3).
- **T4 — the reading room** `/radiology/read` (station `read`, nav + manifest menu,
  `radiology.reports.write`): `GET /radiology/reading/worklist` and `GET /radiology/reading/studies/:id`.
  The list: one list, a sort control (priority · time left · modality), no filter tabs, TAT clocks,
  the derived "is reading" line; "Clocks running" collapsed. The report view: lane = question, flags,
  referrer (Doctor ID + department), priors, 12-month CT DLP; centre = Open images (the existing
  logged route), template picker (T), normal-study macro, macros, dictation placed by spoken headings,
  coded widgets with live calculators, critical category, the live checks with warning ticks; dock =
  **Sign and publish** (S / Enter) → **Publish** → **Next study**; ↑/↓ move through the list, Esc back.
  The classic `/radiology/studies/$id/report` stays, and each links to the other.
- **T5 — the print.** `GET /radiology/reports/:id/print` (`radiology.reports.read`; a draft or prelim
  answers null) and `imaging-report-print.tsx` (A4, `.print-doc`): letterhead, patient, the referrer
  as Doctor ID + department, sections in the Indian order (technique · findings · impression ·
  category · recommendation), the coded line, the signer block. No obstetric declaration yet — RS7
  owns it and has not merged.
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *Where qualification and council number live:* a governed **list of authorised signatories**
    (`report_signatories`) — NABH's own artefact for a diagnostic department, the HOD's to draft and
    the MS's to approve, with a writer today (Setup → Books). The roster credential register has no
    route or screen and no qualification key; adding one would be a reader without a writer.
  - *Refuse rather than print a gap:* a signer not on the list, or with no council number anywhere,
    is refused. **Consequence at deploy: nobody can sign an imaging report until the list is
    published** (runbook §13; census G3).
  - *The signature marker is an electronic authentication record, not a DSC* — the print says
    "electronically signed".
  - *TAT classes from what the study carries:* STAT → 30 min; urgent → ER, 60 min; bedside → IPD,
    6 h; else OPD 24 h; clock from images-in. There is no source column until IPD/ER exist.
  - *The claim is derived* from the image-view log (someone else, last hour); no claim table.
  - *Sign and publish is one act* (the norm in Indian RIS: a signed report is released); a failed
    publish leaves the dock on Publish.
  - *Sex-organ and side conflicts refuse* (the board draws them red); naming both sides and a
    calculator disagreement only warn.
  - *Amend runs the same checks and snapshots the signer* — an amendment is a signature.
- **Counts.** Core: 21 reading-room tests (12 failed against main's `reports.ts`, the 2 T1 schema
  tests failed against main's `definitions.ts`), checks 13 (the negation false-positive guard fails
  with negation disabled), calculators 16; touched core suites 85 / 1,129 green after the rebase on
  RS6. Web: reading room 8 (2 fail with the dock gates removed; all fail without the screen), web
  calculator equality 5; touched web suites 19 / 165. Pins: SPA routes 77 → 78, radiology menu +1
  (nav-parity), definition kinds 6 → 8 (setup test), radiology error codes +6, census +1 row.
- **Moved later.** Co-sign, the critical ladder UI, prelim / amend UI → **RS8b**. Follow-ups
  (`imaging_followups`, the Fleischner / TI-RADS recommendation becomes a follow-up row), peer
  review, night and outside reads → **RS8c**. Measurement against the prior (plan RS8 list) — the
  priors are in the lane; an automatic comparison needs structured measurements → RS8c. The embedded
  viewer, key images and hanging protocols → **RS12**. The obstetric declaration on print → RS7.
- **For the owner (law):** is a TOTP-authenticated signature with a content hash sufficient for a
  printed imaging report, or must the radiologist's signature be a Digital Signature Certificate
  under the IT Act, 2000 (§3/§3A)? Built as the former; the print does not claim a DSC.

#### RS8b spike (read on main `02236033`, 29 Sep, before any code)
- **(a) The resident today.** There is no resident role: `seed-roles.ts` declares `radiologist`,
  `radiographer`, `radiology_receptionist`, `pcpndt_incharge`, `radiation_safety_officer` and
  `modality_bridge`, and only `radiologist` holds `radiology.reports.sign`. Anybody who holds that
  string signs a FINAL report — there is no co-sign state (`imaging_reports.status` CHECK:
  prelim · draft · signed · amended · superseded) and `publishReport` only asks "is there a signed
  version". So today a non-consultant can sign only by being given the consultant's role.
- **(b) The critical call today.** `imaging_critical_findings` carries `category`,
  `communicated_to` (free text), `channel` (a column nothing writes), `read_back_text`,
  `communicated_at`, `acknowledged_by` (the clinician, F76), `recorded_by`, `acknowledged_at` and
  `chased_at`. `acknowledgeCritical` demands a non-empty read-back for `red` only and checks it
  against nothing but the §5(2) lockout — "noted" closes a red call. The chaser
  (`sweepCriticalChaser`, every 60 s) reads each tier's `communicate_within_min` from the active
  `critical_categories` book and, once past it, stamps `chased_at` and emits ONE
  `imaging.critical_overdue`; it never chases the same finding again and has no rung, no person,
  no second window (its own header: "the ladder is a later phase's").
- **(c) Rungs through the roster.** `modules/roster` has `whoIsOn(position, at)` (flag
  `ROSTER_RESOLVER_ENABLED`, off unless set; with the flag off or no published roster it answers
  every holder of the position's RBAC role — for `unit_head` that is every `doctor`, useless for a
  phone call). Positions: `unit_head` exists; there is **no RMO position** (nearest is
  `casualty_mo`), no HOD position, and no link from an ordering clinician to their unit. The
  treating doctor IS resolvable: `orders.ordering_clinician_id`. So **DECIDED:** the ladder's rungs
  are fixed — treating doctor (the order's clinician, by name) → unit head (roster `unit_head`) →
  duty RMO (roster `casualty_mo`, the duty medical officer who covers the wards out of hours) → HOD
  (the `medical_superintendent` role's holders, the administrative head the NABH escalation policy
  ends at). A rung names a ROLE; the screen shows who holds it today only when a PUBLISHED roster
  answers, else the role's name — never the whole `doctor` role.
- **(d) Prelim and amend.** Routes exist: `POST /radiology/studies/:id/reports/prelim`
  (`radiology.reports.write`, lockout + foetal-sex guard) and `…/amend`
  (`radiology.reports.amend`, second factor, the RS8a checks, the signer block, re-publish if v1
  was published, which notifies through `notifyIfDue`). Flag: `POST /radiology/reports/:id/critical`;
  acknowledge: `POST /radiology/criticals/:id/acknowledge` (`radiology.criticals.ack`). **Web
  callers of all four: zero** (`radiology-api.ts` and `radiology-reading-api.ts` ship none).
  Prelim is not restricted by priority anywhere.
- **(e) Law follow-up.** `startAcquisition` checks the `form_f` GATE (satisfied by an OPEN form)
  and the machine/person registration; only `recordAcquired` calls `assertFormFRecorded`. So a scan
  can start on a Form F nobody has signed. The web USG room already records the form before Start.

#### RS8b as built (this PR; lane `radiology-rs8b`; one migration, `0152_radiology_cosign_ladder`, numbered at rebase — 0149 went to RS9, 0150 to RS12, 0151 to pharmacy D4 (#399); runbook section is §16 — RS5 took §14, RS9 §15)
- **T1 — co-sign.** New role `radiology_resident` (six strings: `radiology.worklist.read`,
  `.reports.write`, `.reports.sign`, `.reports.read`, `.criticals.ack`, `.definitions.read`; no new
  permission). `signReport` by a user holding `radiology_resident` and NOT `radiologist`
  (`signsAsResident`) runs the same checks, takes the resident's second factor and inserts an
  `awaiting_cosign` version carrying a `ResidentSignature` (name, instants, content hash — no
  council number: the resident is not the signatory of record). `publishReport` refuses
  `cosign_required`. `cosignReport` (`POST …/reports/cosign`, `radiology.reports.sign` + second
  factor): only a `radiologist` (`cosign_not_consultant`), never the resident's own
  (`cosign_own_report`), under the consultant's own fresh factor; the RS8a checks run again with the
  consultant's acknowledgements; the resident's row flips to `cosigned` by compare-and-set (a second
  consultant gets `stale_state`) and a `signed` version is inserted whose signer block is the
  consultant's with `draftedBy` = the resident. Reading list: `awaiting_cosign` state, sorted to the
  top for a consultant. Migration: status CHECK widened + `imaging_reports_one_awaiting_ux`.
- **T2 — the ladder.** `imaging_critical_call_attempts` (insert-only: rung, who rung — a user or a
  typed name, outcome `no_answer` / `answered` / `read_back_ok`, recorded by, when);
  `imaging_critical_findings.ladder_rung` (0 treating doctor · 1 unit head · 2 duty RMO · 3 HOD, only
  climbs) and `chase_windows`. `recordCallAttempt` (`POST /radiology/criticals/:id/calls`,
  `radiology.criticals.ack`): compare-and-set on the rung; no answer climbs one. `acknowledgeCritical`
  now refuses a read-back that does not name the finding (`read_back_mismatch`, `readBackNamesFinding`:
  a critical term the report states, not negated, or a content word of the impression) and writes the
  closing `read_back_ok` row — the RS9 doctor read-back calls the same function and inherits it. The
  chaser escalates one rung per tier window of the `critical_categories` book (was: once), at most
  three events, each `imaging.critical_overdue` carrying `rung`. Board read
  `GET /radiology/reading/criticals` (open calls oldest first with the four rungs and who holds each
  today; the last 48 h closed).
- **T3 — Form F before the scan.** `startAcquisition` calls `assertFormFRecorded` beside the machine
  and person registration checks; the `form_f` GATE still passes on an open form (semantics kept).
  Three tests that pinned the old order (start on an open form, refuse at `acquired`) now assert the
  refusal at the start, each with a comment: `acquisition.test.ts` A2, `portable.test.ts`, the e2e
  STUDY TWO.
- **T4 — the screen.** `/radiology/read`: header views **Reading list · Critical calls (n)**
  (`?view=criticals`, no new SPA route). Resident dock **Sign for co-sign** (no publish); consultant
  opening an awaiting study sees the resident's text + checks and **Co-sign and publish**; **Issue
  prelim** on STAT/urgent with the PRELIMINARY banner (first web caller of prelim); **Amend** on a
  signed study — reason code, one-line note, corrected findings/impression, second factor (first web
  caller of amend); the print adds the drafting resident. Critical calls: one call in hand, the
  ladder, **Call** → **No answer / Answered** (Call itself records nothing), the read-back box,
  overdue banner, the 48-hour log; English + Hindi.
- **DECIDED** (standard Indian teaching-hospital answers, open to owner objection):
  - *Resident vs consultant by ROLE KEY, a user with both roles is a consultant* — "may sign, but not
    finally" cannot be said with a permission, and the workflow engine already separates on role keys.
  - *Co-signing is agreeing, not editing* — the consultant who wants different words signs their own
    version, which supersedes the resident's (NABH: the signatory owns the text they sign).
  - *A resident's red critical is raised at the resident's signature* — the ER hears of the bleed from
    whoever read it; the co-sign raises no second call.
  - *Prelim offered on STAT and ER (urgent) only, in the screen*; the server's prelim route keeps its
    existing rule (any reportable study) — narrowing it would break the classic report screen.
  - *Rungs:* treating doctor = the order's clinician; unit head = roster `unit_head`; duty RMO =
    roster `casualty_mo` (no RMO position exists); HOD = the `medical_superintendent` holders (no HOD
    position). Names shown only from a PUBLISHED roster, else the role's name (spike c).
  - *The chaser climbs one rung per tier window, three at most* (red: 15/30/45 min).
  - *The read-back is lexical and generous* (one shared finding word or the critical term), and a
    negated critical term never closes the call; red still demands a read-back, orange/yellow may be
    acknowledged without one (unchanged).
  - *A read-back is recorded against a person with an HMIS account* (F76); a callee typed by name can
    be recorded as rung, but closing needs the clinician picked — nobody is pre-chosen for them.
  - *The amendment's stored reason is in English* ("Correction of laterality: …"), whatever the
    screen's language — it is the record.
  - *Form F recorded before Start* (PCPNDT Rules: the declaration precedes the procedure).
- **Counts.** Core: `cosign.test.ts` 11 (10 fail with the co-sign branch/guards mutated out; with only
  the publish gate and own-report check removed, the 2 that pin them fail), `critical-ladder.test.ts`
  8 (5 fail with the read-back rule, the rung climb and the windowed chaser mutated out; the pure
  read-back unit and the board did not exist on main), T3 2 fail with the start-time check removed.
  Web: `radiology-reading-rs8b.test.tsx` 7 (6 fail against main's screen; the seventh is an absence
  test — "no Prelim on a routine study" — which a revert cannot fail). Touched suites: see the PR.
  Pins: roles 40 → 41 (`radiology_resident`), model pairs 427 → 433, `KNOWN_ROLE_KEYS` 42 → 43, README
  radiology table 6 → 7 columns (+ prose); distinct/held permissions unchanged (185 / 191); radiology
  error codes +4 (`cosign_required`, `cosign_not_consultant`, `cosign_own_report`,
  `read_back_mismatch`); events unchanged in number (`imaging.critical_overdue` gains optional
  `rung`); SPA routes 79 unchanged; API routes +3 (cosign, calls, criticals board).
- **Moved later.** A staff-directory picker so ANY clinician with an account can be named at the
  read-back (today: the people the ladder names) → RS10; a real HOD / RMO roster position and the
  treating doctor's unit → IPD/roster; a calendar-aware "next working day" yellow window (the book is
  minutes, ≤ 1440) and the alert text naming the rung → RS10; co-sign on the classic report screen
  (the reading room is the co-sign seat) → not planned. Follow-ups, peer review, night/outside reads →
  RS8c.
- **For the owner (law):** may a DNB/MD resident's PRELIM (unsigned by a consultant) be handed to the
  treating doctor in the ER as a quotable document? Built as the Indian teaching-hospital norm (yes,
  marked PRELIMINARY, never published to the patient). The RS8a DSC question stands.

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

**RS9 spike** (read on main `583db9ff`, 29 Sep, before any code):
- **(a) `imaging_report_delivery`** is one row per REPORT VERSION (`report_ux`), holding `first_read_at/by`
  and `unread_chased_at` only (18a-iii T5: the report row is append-only by trigger 0047, so its delivery
  is a separate, mutable object). Two writers: `reportView` (`read.ts`) stamps first read for **any**
  holder of `radiology.reports.read` who is not the signer — the radiographer holds it, so a technologist
  opening the report silences the 24 h Unread Watchman exactly as the treating doctor would; and the
  Watchman (`chasers.ts`) upserts `unread_chased_at`. Nothing records acted-upon.
- **(b) Where the treating doctor reads imaging today.** The consult's "Since then" brief
  (`lib/brief-history.ts` → `GET /radiology/reports/patient/:id`, `patient-reports.ts`) — impression,
  critical category and signed time only, and it writes **no** first read. The full report
  (`GET /radiology/reports/:id`, the one first-read writer) has one web caller, the department's own
  `radiology-report.tsx`. So in practice first read is written by the department, not the doctor. The
  critical acknowledge route (`POST /radiology/criticals/:id/acknowledge`) needs `radiology.criticals.ack`,
  which only `radiologist` holds — the doctor cannot call it; `acknowledgeCritical` already records the
  clinician who read back separately from the actor (F76). RS2's consult panel places orders only.
- **(c) The lab's hand-over.** `lab_report_deliveries` rows (channel `print | whatsapp | in_person |
  doctor_screen`, a free-text `collector_identity` required for a physical hand-over, an `approval_id` for
  an unpaid release). 17-F F8's collector type / relation columns and the patient OTP are **not built**
  ("blocked by the owner: read receipts and patient OTP need a real provider"). There is no OTP service
  for patients anywhere on main (ABHA's OTP is ABDM's, for ABHA only). Imaging reuses the SHAPE (a
  register of physical hand-overs, collector named) with typed collector columns, and defers the OTP.
- **(d) Notify.** `imaging_report_ready` already exists (18a T2) and `publishReport` already enqueues it in
  the publish transaction (`notifyIfDue`): token-only (order number, no study, no link — there is no
  patient-facing link on main, the lab's twin has none either), EN + HI, 72 h expiry, `transactional`,
  enqueued only when the invoice is settled or the report is RED critical, and a failed enqueue never
  fails the publish. Consent: `transactional` needs no opt-in; a patient's STOP suppresses every patient
  message at the pump (`opted_out`, P6), deceased suppresses. Other patient kinds on main:
  `patient_lab_report_ready`, `imaging_appointment_booked` (RS3), OPD appointment/refill families. The
  WhatsApp adapter is not on main: rows are RECORDED, never claimed sent.

**RS9 as built** (this PR; lane `radiology-rs9`; one migration, `0149_radiology_closed_loop` (renumbered from 0147 at merge; RS11 took 0147, RS8a 0148)):
- **T1 · acted upon (core).** `imaging_report_delivery` + `acted_at/by/outcome/note` (all-or-none
  CHECK, outcome from the board's five, note ≥ 4 characters). `POST /radiology/reports/:id/acted`
  (`radiology.reports.read` + the treating-doctor check in `closed-loop.ts`): the **treating doctor** is
  the order's `ordering_clinician_id` or the visit's doctor (`opd_encounters.doctor_id → opd_doctors.user_id`);
  anyone else `not_treating_doctor`, naming who can act. An act stamps the first read if empty and
  appends `imaging.report_acted_upon` (outcome code only). **`reportView` now stamps the first read only
  for the treating doctor** (spike a — a technologist's read silenced the Watchman).
- **T2 · the north star.** `GET /radiology/north-star?from&to` (`north-star.ts`, **`radiology.reports.sign`** —
  the grant only the reporting radiologist holds; the HOD is a radiologist, the desk/technologist/referrer
  are not). Per modality (from the active study-type book) × source: ordered, median + p90 (nearest rank,
  whole minutes) order → first signature, signed → first read and order → acted on the current version,
  signed-unread > 24 h, published-not-acted > 72 h, plus totals. `northStar` is exported for RS10's floor.
- **T3 · the doctor's results (web).** `components/radiology/imaging-results-inbox.tsx`, mounted by one
  line in `opd-consult.tsx` under "Nobody is in the chair". `GET /radiology/results`: current released
  versions the doctor treats, open criticals first, then unread, read-not-acted, acted (14 days).
  Open report (`GET /radiology/reports/:id` — the read that lands), Open images (existing logged
  `images/open`), Mark acted upon. **Read-back:** `POST /radiology/reports/:id/read-back` calls the
  same `acknowledgeCritical` (RS8b is not built; this is the first doctor-side caller).
- **T4 · Report hand-over (web + core).** `/radiology/reports` (station `reports`, `radiology.schedule`):
  `GET /radiology/release` (30 days, needs derived: abnormal uncollected 24 h, amended after hand-over,
  media to print / to hand, notice not recorded, not collected), `POST /radiology/studies/:id/media`,
  `POST /radiology/media/:id/printed`, `POST /radiology/reports/:id/handover` (collector typed; CHECKs repeat
  the rules). Tables `imaging_report_handovers`, `imaging_media_requests`. Events
  `imaging.report_handed_over` (collector type only) and `imaging.media_requested`.
- **T5 · patient message.** Already on main (18a T2, spike d): `imaging_report_ready` queued in the
  publish transaction, EN + HI, order number only, settled-or-RED, STOP suppresses at the pump. RS9 adds a
  pin (release.test T5) and shows the recorded state on the register; no secure link exists to add.
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *Treating doctor* = ordering clinician or the visit's doctor; a covering colleague is not (the OPD's
    D5 rule — coverage is a transfer of the visit).
  - *Only the treating doctor's read lands*; for a study with no in-house doctor (outside prescription /
    self) the **hand-over** is the first read, so the Watchman does not chase a report nobody here awaits.
  - *An amendment re-opens the loop* (acts and reads are per report version); acting on a superseded
    version is `report_superseded`, naming the current version.
  - *The doctor's read-back* goes through a treating-doctor route calling the same `acknowledgeCritical`;
    `radiology.criticals.ack` stays the radiologist's (no grant widened).
  - *No patient OTP service exists*: a relative is recorded by name, relation and ID type + last four
    characters (masked Aadhaar is lawful); the OTP is deferred and the screen says so.
  - *Film/CD*: the X-ray's first sheet is `included`; the rest name `RAD-FILM` / `RAD-CD` and are charged
    at the billing counter — the desk composes no money and links no invoice.
  - *The hand-over is the desk's* (`radiology.schedule`) — no new permission.
  - *Source*: OUT (outside prescription / self) → IPD (day-care or bedside) → ER (STAT) → OPD, until IPD
    and ER modules exist.
  - *PHI*: the inbox logs `imaging.report` and the register `imaging.worklist` per patient (existing
    surfaces; the kernel union was not widened).
- **Pins.** Migration 0147; radiology events 16 → 19; caddyfile routes 78 → 79 (`/radiology/reports`, after RS7's `/radiology/usg`);
  nav + `radiologyManifest.menu` + station row `reports`; six error codes (`not_treating_doctor`,
  `acted_note_required`, `report_superseded`, `report_not_published`, `collector_details_required`,
  `unknown_media_request`). No permission, seed-roles, notify template or kernel change.
- **Moved later.** Patient secure link + OTP + plain-words summary (provider + DPIA); the 30-minute SMS
  fallback and "abnormal unopened 24 h → call task" as an obligation/alert (RS10); follow-ups to book in
  the doctor's inbox (RS8's `imaging_followups`); the signer block on the doctor's report view (RS8a's
  print); messaging the radiologist from the report; the outside-CD desk view (RS3 left it here — still
  open, RS10/RS12); billing film/CD from the hand-over desk itself; the HOD north-star screen (RS10); the
  ward inbox (IPD).
- **Money/law questions the rulings do not settle.** (1) Is a report **held at the window until paid**
  (the board draws "held for money · released unpaid only by the billing manager")? Nothing holds it —
  18a A6 made money gate only the message; RS9 built no hold. (2) A report released unpaid gets no
  "ready" message, and nothing sends it when the bill is paid later. (3) Retention of the relative's ID
  last-four under DPDP (kept with the hand-over row, indefinitely today).

### RS9b · The patient's copy and the bill (RS9's three money questions)

**RS9b spike** (read on main `8cd13d28`, 29 Sep, before any code):
- **(a) Where the patient's copy leaves.** One writer: `handOverReport` (`release.ts`) — the report
  at the window and the printed film/CD riding with it (`mediaRequestIds`). Requesting and printing
  film are internal acts. The doctor's paths (`reportView`, `GET /radiology/results`, the consult
  brief, the read-back, the reading room's print view) are separate functions and none calls the
  desk's code. The patient message is queued only by `notifyIfDue` inside `publishReport` /
  `amendReport` (settled-or-RED); there is no patient link.
- **(b) The lab's held copy.** `interlock.ts` + `printReport`'s `approvalId`: a GRANTED approval,
  of the release type, about THIS order, spent once (a delivery row carrying it). 17-F ruling 12
  ("released unpaid ONLY by the billing manager") was **superseded 28 Sep** by the owner's credit
  ruling (#347): the type is now `lab_release_unpaid_owner`, approver **owner**. The dues row is
  untouched.
- **(c) Who is "unpaid dues at the desk".** `money.ts` `authorisationOf`: `invoice` / `daycare` /
  `payer_branch` / `stat`. Only self-pay with an invoice line can owe the desk; day-care and bedside
  compose into a running bill; payer branches are billed to the payer; STAT runs first and the bill
  follows (ruling 8).
- **(d) The settlement event.** Billing emits `payment.received { receiptId, invoiceId, patientId,
  amountPaise }` on every allocation (receipt at the counter, tender on issue, held-receipt
  settlement) and `credit_note.issued { invoiceId, … }`. Partners already consumes both by name. The
  ledger answer is `invoiceSettlement` (exported). No billing signature needs to change.

**RS9b as built** (this PR; lane `radiology-rs9b`; one migration, `0153_radiology_release_unpaid`):
- **T1 · the hold (core).** `held.ts`: `patientCopyHold` (IPD/day-care/bedside → STAT → no line →
  payer → ledger), `assertPatientCopyReleasable` (called by `handOverReport` after the collector
  checks, before any write), `requestUnpaidRelease`. Refusals in plain words with the amount and the
  bill: `report_held_for_dues` (402), `release_not_authorised` (403 — asked and pending, or refused,
  naming the owner's note), `release_not_needed` (409). `POST /radiology/reports/:id/release-unpaid`
  (`radiology.schedule`, reason ≥ 4 characters) files `imaging_release_unpaid_owner` (approver owner,
  urgent, 60 min, no act-first; subject = the study; the amount and reason in the request). The
  hand-over that follows spends the grant: `imaging_report_handovers.release_approval_id` (unique
  partial index) and `imaging.report_released_unpaid` (hand-over, report, study, approval, paise still
  due). The register row gains `hold` (amount, bill, the owner's release state) and the need
  `held_for_dues`. The doctor's read paths are untouched.
- **T2 · ready on later payment (core).** `reports.ts` `enqueueReportReady` — the one writer of
  `imaging_report_ready`, now shared by the publish path and `ready-on-payment.ts`'s consumer
  `radiology.report_ready_on_payment` on `payment.received` + `credit_note.issued`. It re-reads the
  invoice and queues only when **settled**, for the current released version of each imaging study
  on that bill; the per-version dedupe key makes it exactly once whichever path runs first. Consent
  as the publish path (the pump suppresses STOP/deceased). A failed enqueue is swallowed (A7) so the
  cursor never stalls.
- **T3 · the desk (web).** `/radiology/reports`: held rows read "Held for dues ₹N"; the in-hand
  panel names the bill, links *Collect at billing* (`/billing/dues`), says the doctor's copy is not
  held; the docked *Hand over* waits with "send the patient to billing, or ask the owner". *Ask the
  owner to release unpaid* (reason) → pending ("Asked the owner at HH:MM") → granted (dock opens, "₹N
  stays owed") or refused (the owner's note). The approvals inbox has words for the new type (EN + HI).
- **T4 · docs.** Runbook §15a (release); this section.
- **DECIDED** (open to owner objection):
  - **The owner, not the billing manager, releases a held imaging copy unpaid.** The phase brief
    said `billing_manager` "mirroring the lab's ruling 12"; that ruling was superseded on 28 Sep by
    the owner's own credit ruling (whole hospital: "nobody can issue credit except owner"), and the
    lab now asks the owner. Money rulings are the owner's; an orchestrator default cannot widen them.
    The billing manager's `approveRequest` on this type is refused by the kernel (tested).
  - **STAT is never held**, even with an unpaid line (ruling 8: the bill follows); **bedside is IPD**
    (running bill) until the IPD module exists.
  - **A study with no invoice line is not held** — the amount is unknown and the counter's
    `acquired_unbilled` decision owns it.
  - **Printing film/CD is not held**; collecting it is (it rides the hand-over).
  - **A grant is spent by one hand-over**; an amended version handed over again needs a new decision
    (the lab's M8 rule).
  - **The late message covers `credit_note.issued` too** — a correction can be what settles a bill.
  - **Retention of a relative's ID last four (money/law question 3):** part of the medical record,
    kept for the record's retention period, no separate deletion (runbook §15a).
- **Pins.** Migration `0151` (renumbered from 0150 at rebase; RS12 took 0150); radiology events 21 → 22 (RS12 took 19 → 21); approval types 23 → 24
  (`test/seed-roles.test.ts`); worker consumers + `radiology.report_ready_on_payment`
  (`seed-cursors.test.ts`, `worker-runtime.e2e.test.ts`, `worker.module.ts` — additive); web
  `APPROVAL_KINDS` + inbox words; three error codes. No permission, role, route (web) or nav change.
- **Moved later.** The owner's approval from a phone notification (the inbox is the seat today);
  holding the ABDM share of a report (ABDM releases signed reports to the patient's own PHR — the lab
  does not hold its ABDM share either; an owner question if it should); a "held 3 days → billing"
  sweep (the lab's 17-F idea — RS10's escalations); the patient secure link (still unbuilt).
- **Money/law questions the rulings do not settle.** (1) Should a report linked to the national
  health record (ABDM) be held for dues like the printed copy? (2) Should a RED critical report's
  patient message, queued unpaid today, be the only unpaid exception? Both are left as built.

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

#### RS11 spike (read on main `583db9ff`, 29 Sep, before any code)
- **(a) TLD reads today.** One route, `POST /aerb/badges/reads` (`aerb.registers.manage`), typed a
  line at a time on the Badges tab: badge, period start/end, Hp(10) and Hp(0.07) mSv, report date,
  lab ref, remarks. `recordBadgeRead` refuses a negative dose, an inverted period, a period ending
  before the badge was issued, and a second read for the same badge × period
  (`read_already_recorded`). The **investigation flag** is Hp(10) ≥ the monthly level (settings row,
  default 1 mSv) pro-rated by days worn (`investigationLevelFor`, ÷ 30.44 days); the verdict and the
  level are STORED on the row and an over-level read emits `radiation.dose_limit_warning` (nobody
  consumes it). Limits (30 / 20-avg / 100 mSv) are constants; `badgeRegister` sums per WORKER and
  flags the worst calendar year. **No import, no projection, no foetal comparison.**
- **(b) QA → `qa_blocked`.** Confirmed: `aerb/qa.ts recordQa` writes `qa_blocked` through
  `changeResourceStatus` in the same transaction as a `fail`, and a newer `pass` is the only exit
  (RS4 kept Setup out of it). **Gap: an overdue QA blocks nothing** — 18c's D4 said so on purpose;
  the calendar shows `overdue` and nothing acts. No job exists in `aerb` (manifest: "no job").
- **(c) Incidents.** None. The only neighbour is radiology's contrast-reaction register
  (`reactions.ts`). No table, route or screen records an unintended exposure or an AERB notification.
- **(d) Pregnant worker.** None. No declaration table; the board's People view marks the pregnancy
  roster gate "NOT BUILT"; 18c's runbook §8 lists "roster gates for a pregnant radiographer" as not
  turned on.

#### RS11 as built (this PR; lane `radiology-rs11`, rebased on `c3ba8525`; one migration, `0147`)
- **T1 · TLD import (core).** `aerb/tld-import.ts`, `POST /aerb/badges/import {csv, reportedOn,
  labRef, dryRun}` (`aerb.registers.manage`). Layout: badge no. · wearer name · period from · period
  to · Hp(10) mSv · Hp(0.07) mSv · remarks, headers matched tolerantly (synonyms, then shapes like
  "Name of the Radiation Worker"); dates day-first or ISO; BDL / ND / NIL / "-" / "<x" → 0.000 with
  the words kept in remarks. Per-row errors: unknown badge, badge not worn that period, period
  already on file, period repeated in the file, unparseable date/dose, period ending after the
  report date. **All-or-nothing**: a dry run previews; a confirm with any bad row is `422
  tld_import_rejected` with every row in `detail.rows`; a clean confirm writes every row through
  `recordBadgeRead` in one transaction (stored investigation verdict, `radiation.dose_limit_warning`).
  Flags per row: investigation level (1 mSv / month pro-rated), year on course for > 20 mSv
  (projection = the calendar-year Hp(10) ÷ days worn × days in year), year over 30 mSv, the foetal
  limit for a declared-pregnant wearer, a wearer name that differs from the badge book (warning).
- **T2 · Incident register (core).** `aerb_incidents` (migration 0147), `aerb/incidents.ts`,
  `GET /aerb/incidents` (`aerb.incidents.read`, NEW — RSO + radiologist), `POST /aerb/incidents`,
  `…/:id/investigate`, `…/:id/actions`, `…/:id/notify`, `…/:id/close` (`aerb.registers.manage`).
  Kinds: wrong patient, wrong study, pregnant patient, repeat over threshold, equipment malfunction,
  worker over limit, other. `INC-yy-nnn` under an advisory lock. open → investigated (root cause +
  ≥ 1 action) → closed; close refuses `incident_actions_open` / `notification_required`. PHI surface
  `aerb.incident_register` (one row per patient disclosed; confidential patients by alias). Event
  `aerb.incident_recorded` (no patient, no worker in the payload).
- **T3 · QA overdue → `qa_blocked` (core).** `qaDueList` (due = the record's `nextDueOn`, else
  performed + 2 years; counted from the latest non-failed record per machine × test);
  `sweepOverdueQa` in the worker, **hourly** (`kernel/worker/jobs.ts`, job 23), writes `qa_blocked`
  through `changeResourceStatus` as system actor `aerb-qa-overdue-sweep`, only on an `available`
  machine. `recordQa`'s pass no longer releases while another test on the machine is overdue
  (`stillOverdue`). `GET /aerb/qa/due`.
- **T4 · Pregnant worker (core).** `aerb_pregnancy_declarations` (same migration), `aerb/pregnancy.ts`,
  `GET|POST /aerb/pregnancy`, `POST /aerb/pregnancy/:id/end` (read `aerb.registers.read`, write
  `aerb.registers.manage`). Foetal dose = her Hp(10) reads after the declaration, pro-rated by days;
  compared with 1 mSv on the declaration list, on every import row and on a typed read
  (`recordBadgeRead` → `overFoetalLimit`). `activeDeclarations` exported for RS10.
- **The RSO's one list.** `GET /aerb/attention` (`attentionList`): QA failed / overdue / due, open
  incidents (red when the AERB clock ran out), workers over a statutory limit, investigation-level
  reads of the last 90 days, active pregnancy declarations. Exported for RS10's escalations.
- **T5 · Web.** Radiation safety's tabs are the station's header views (`views`), + TLD import,
  Incidents, Pregnant workers; QA gains the due list with the blocked machines; the right column is
  "Needs you" (a row opens its view); header stats. `components/radiology/radiation-safety-views.tsx`.
  Nav row gains `anyOf: ["aerb.incidents.read"]`; a holder of incidents-read without registers-read
  sees the Incidents view only. `StationShell`: `closeListOn` now also folds the header Menu (a tab
  picked from the Menu on a phone was left covering the screen — found on the walk).
- **Constants with sources** (`aerb/limits.ts`): `PREGNANT_WORKER_FOETAL_LIMIT_MSV = 1`,
  `QA_DEFAULT_INTERVAL_YEARS = 2`, `RADIATION_SAFETY_SOURCES` (30 / 20-avg / investigation level /
  foetal / QA cadence / TLD service), served on `/aerb/attention`.
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *An overdue QA blocks* (reverses 18c D4, per the brief and ruling 5): a machine operated past its
    periodic QA is outside its licence conditions; the calendar shows it 30 days ahead.
  - *The block is a worker sweep, not a booking-time check* (the house pattern — `sweepBatchExpiry`,
    the radiology chasers): a booking-time write would roll back with the booking's own refusal.
    Hourly, so a machine busy at one tick is caught at the next. Only `available` machines; `down` /
    `maintenance` / in use are someone else's status.
  - *A machine with no QA record at all is not blocked by the sweep*: the licence gate already refuses
    an unlicensed machine, and the licence is issued on the acceptance QA.
  - *AERB notification*: required for any exposure significantly above intended (the RSO's recorded
    judgement) or any worker over a limit; clock 24 h from recording; shown red, never a block.
  - *Incident read = RSO + radiologist* (`aerb.incidents.read`, new); write stays the RSO's.
  - *Pregnancy: a prompt, not a roster gate* (least invasive): the RSO list says "reassign or
    restrict"; the roster is untouched; the declaration is visible only on the RSO's register (the
    radiologist does not hold `aerb.registers.read`), and the room console names no one.
  - *Foetal dose = post-declaration Hp(10), pro-rated* (no abdomen badge modelled).
  - *Projection* compares against 20 mSv (the five-year-average annual limit); the actual year
    against 30.
  - *A worker over a limit does not open an incident automatically* (18c D9, record-only): the list
    tells the RSO to record one.
- **Pins.** Permissions 204 → 205 (declared), held 190 → 191, model pairs 425 → 427, model
  permissions 184 → 185, `aerb` 3 → 4, radiologist 16 → 17, radiation_safety_officer 3 → 4 (README
  table + prose); scheduler jobs 22 → 23 (`jobs.test`, `scheduler.test` census + spy,
  `worker-runtime.e2e`, `alerts-parity`, `docker/prod/prometheus/alerts.yml` daily leg + absent term);
  AERB events 3 → 4; AERB error codes 10 → 16; PHI surface +1 (`aerb.incident_register`). No new web
  route (caddyfile routes unchanged), no new nav row.
- **Counts.** See the PR body (fail-first per CRITICAL task: the four new core suites cannot load
  against main, and eight mutants were run — seven killed, one equivalent).
- **Moved later.** HOD escalations reading `attentionList` / `activeDeclarations` /
  `aerb.incident_recorded` → RS10; a roster gate for a declared-pregnant worker → the roster module
  (Plan 20) if the owner wants a hard stop; a correction route for a re-sent TLD line (still
  refused as "already on file"); an XLSX import (CSV only); per-test QA intervals as a governed book
  (today the RSO types `nextDueOn` per record); the board's investigation workflow for an
  over-level read (finding, worker's explanation) → a later RSO phase.
- **Money/law questions the rulings do not settle.** (1) The AERB reporting window — 24 h is DECIDED
  as prompt reporting; the owner / RSO should confirm against the current AERB directive for
  diagnostic X-ray unusual occurrences. (2) Whether an overdue QA should block at all (the brief says
  yes; 18c said no) — the owner may revert to calendar-only.

### RS12 · Real PACS, IR and teleradiology (infrastructure)
- 18b-ii per ruling 6:
  - Orthanc behind the hospital network;
  - OHIF embedded in `read:report`;
  - MPPS and dose SR from the machines (dose entry becomes a confirmation, not typing);
  - reconciliation of unmatched studies.
- The IR suite (`room:ir`): sign in, time out, fluoro and skin-dose alert, sign out.
- Night teleradiology per ruling 7: an external reporter identity, prelim, and morning over-read.
- Procurement and the deploy are owner-authorised steps.

#### RS12 spike (read on main `c3ba8525`, 29 Sep, before any code)
- **(a) What 18b built vs deferred.** Built: the MWL pull export (`mwl.ts`, `GET /radiology/mwl`,
  dcmtk dump, `modality_bridge`), the Study Instance UID minted from the study (`uid.ts`, `2.25.` +
  SHA-256 bits) and written at Send (`resolveStudyInstanceUid`, partial unique index), the viewer
  door (`views.ts` `openImages`: `image_source = pacs` + UID + an active enabled `pacs_settings` →
  view row + `imaging.image_viewed` + PHI line → URL), the offline drafter. Deferred to 18b-ii (its
  §6, verbatim): the Orthanc container, **reconciliation / `study.unmatched` and any consumer of
  `imaging.study_acquired`**, the **dose SR hook**, the Orthanc authorization bridge, **embedded
  OHIF**, tiering/offsite/restore, teleradiology, MPPS.
- **(b) `pacs_settings`** was `{viewer_url_template (https, only `{accessionNo}`/`{studyInstanceUid}`),
  enabled}`, governed like every book; nothing seeds it.
- **(c) The bridge's authentication.** The kernel has no service-account door (agents hold no
  permissions — `guards.ts`), so the bridge is a USER whose only role is `modality_bridge`
  (`radiology.mwl.read`); `lab_bridge` (`lab.results.interface`) is the same shape for a machine that
  POSTS. RS12 follows it: a new machine string `radiology.pacs.interface` on `modality_bridge`.
- **(d) "Images arrived", smallest honest design.** DECIDED: Orthanc's REST `/changes` feed
  (`StableStudy`) polled by the **bridge on the archive host**, which posts Orthanc's own study +
  statistics JSON to a bridge route; HMIS parses (the bridge stays a shell script) and matches
  **accession first, then UID, and in both cases the DICOM PatientID must equal the study's UHID**;
  everything else → `imaging_unmatched_studies`. Not a worker poller inside HMIS: HMIS never dials
  the PACS (18b D1's pull direction, mirrored), `worker.module.ts` stays untouched, and a hospital
  with no archive is a no-op by construction (nothing posts). The "PACS not configured" state is a
  census row over the book's new `archive` block. Dose: from the **Radiation Dose SR** the modality
  sends to the archive (the bridge forwards `/instances/{id}/tags?simplify` for SOP class
  `…88.67`); **not MPPS** — Orthanc has no MPPS receiver, and the dose MPPS carries is in the RDSR.
- **Found:** `/radiology/read` (RS8a, PR #393) is not on main, so T4's reading-room half cannot be
  wired here; the door it will call (`openImages`) is the same one the study console uses, and it now
  returns `viewer`. Recorded, not blocked.

#### RS12 (code) as built (this PR; lane `radiology-rs12`, rebased on RS11 `9dec14c1`; one migration, `0150_radiology_pacs_inbox` — renumbered from 0148 at merge; RS8a took 0148, RS9 0149)
- **T1 · arrivals (core).** `pacs.ts` + `radiology-pacs.controller.ts`:
  `POST /radiology/pacs/arrivals` (`radiology.pacs.interface`, 200, idempotent) takes Orthanc's
  `GET /studies/{id}` + `/statistics` as-is; `parseOrthancStudy` (pure) → `{UID, accession, PatientID,
  name, modality, StudyDate, series, instances, archive id}`, refusing a notice with no valid UID
  (`invalid_pacs_notice`). `matchVerdict` (pure): the accession's study (else the UID's), and only
  when PatientID = that patient's UHID (trimmed, case-folded) — **never a name**. Verdicts:
  match → `imaging_studies.image_source = pacs`, the archive's UID (replacing a minted/absent one),
  new additive columns `images_arrived_at`, `image_series_count`, `image_instance_count`, event
  `imaging.images_arrived` (once per study); a re-sent notice refreshes counts (greatest) and emits
  nothing; otherwise one `imaging_unmatched_studies` row per UID (UNIQUE) with a reason —
  `patient_mismatch`, `no_match`, `no_identifiers`, `uid_mismatch` (a second archive study for one
  order, or a UID the technologist TYPED that the archive contradicts), `study_closed`,
  `outside_study`, `awaiting_acquisition` (images before Send). Serialised per UID by an advisory lock.
  **At Send** (`recordAcquired`): a held `awaiting_acquisition` arrival gives the study its UID when
  none was typed and attaches itself (`via: send`, `resolved_by` NULL — the CHECK allows the machine
  only to ATTACH, never to reject); a typed UID that disagrees turns it into `uid_mismatch`.
- **T2 · dose SR (core).** `POST /radiology/pacs/dose-reports` takes the SR instance's simplified tags;
  `parseDoseSr` (pure) reads DCM 113813 DLP total (else Σ 113838), 113830 Mean CTDIvol (the highest
  acquisition), 113722 DAP total, 113730 fluoro time, 111637 AGD (the higher breast), converting
  **units read from each item** (Gy·m² → Gy·cm² ×10,000, …; an unknown unit drops the number); template
  from `ContentTemplateSequence` (10011 / 10001). Receipts in `imaging_dose_sr_receipts` (UNIQUE on
  the SR's SOP Instance UID): matched by the same accession/UID + UHID rule. Before Send → `pending`,
  and Send with **no typed dose** records the SR's numbers **through the existing `recordDose` call**
  (so `drlFor` runs; register `dose_origin = 'dose_sr'`, `dose_manual = false`) → `recorded`. After a
  typed number → `confirmed` (≤ 2 % or 0.05) or `conflict` (both values kept on the receipt; **the
  register row is never rewritten**). Non-ionising / outside → `not_applicable`; unplaced →
  `unmatched`, re-tried when the archive study is matched or attached. **AGD** added additively:
  `imaging_studies.dose_agd`, `radiation_dose_register.dose_agd`, both dose CHECKs widened, aerb
  `DOSE_QUANTITIES`/`DOSE_UNITS` (`agd`, mGy), the DRL book's `DRL_QUANTITIES` (`agd`), the
  acquisition route's body (`doseAgd`). The room read carries `doseReport` (the pending SR).
- **T3 · reconciliation (core).** `GET /radiology/pacs/inbox` (open rows with the accession's
  candidate study — name through `displayName`, one PHI line per candidate — dose conflicts, the
  unplaced-dose count, `configured`), `POST …/unmatched/:id/attach {accessionNo, reason}` and
  `…/reject {reason}` (`radiology.pacs.reconcile`, radiologist + radiographer). Attach refuses a study
  not yet sent (`not_acquired`, names the room), an outside film (`outside_study_only`), a study that
  already holds an archive study (`images_already_attached`), a UID recorded on another study
  (`duplicate_study_instance_uid`), a resolved row (`already_resolved`), a blank reason
  (`reason_required`); on success the study takes the archive's UID/counts, the row is `attached`
  with person/time/reason, event `imaging.images_reconciled`, PHI line, and the UID's unplaced dose
  reports are settled. Reject keeps the row with its reason; nothing is ever deleted.
- **T4 · web.** Rooms station gains a fifth header view **Unmatched images**
  (`/radiology/room?view=unmatched`, `screens/radiology-pacs-inbox.tsx`): right = the one list of open
  archive studies; left = the one in hand; centre = the images' identity beside the order's (a
  disagreeing UHID in red), accession + reason, **Attach** docked (Enter), Reject folded below;
  nothing in hand → the archive's state ("PACS not configured") and the dose disagreements. Room
  console: mammography asks **AGD**; a waiting dose report is shown ("From the machine's dose report
  …"), Send is open with nothing typed and sends no dose. Study console: "In the archive: 3 series,
  212 images, since 10:42" / "Not in the archive yet"; long UIDs wrap. `openImages` returns `viewer`;
  the tab opens the server's URL (OHIF's `?StudyInstanceUIDs=` when the book says `ohif`).
- **T5 · docs.** `radiology-pacs-go-live.md` rewritten for Orthanc + OHIF (sizing, ports, AE titles,
  `orthanc.json`, OHIF, the modalities' RDSR, the three bridge jobs incl. the `/changes` poller,
  retention/backup per ruling 6, the daily inbox act, acceptance, rollback). Census row
  `radiology_pacs_configured` (G3): RED until an enabled `pacs_settings` names its `archive`.
- **DECIDED** (standard Indian-corporate-hospital answer, open to owner objection):
  - *Push from the archive host, not a poller in HMIS* — HMIS never dials the PACS; no worker change.
  - *Match = accession (then UID) AND UHID; never a name*; a blank PatientID is not a match.
  - *The archive's UID replaces our minted one*; a technologist-TYPED UID the archive contradicts
    goes to a human.
  - *Reconciliation: one technologist or radiologist with a reason, audited* — no second person.
  - *Dose from the RDSR, not MPPS* (Orthanc has no MPPS SCP). CT register CTDIvol = the highest
    acquisition's; mammography AGD = the higher breast's; agreement tolerance 2 % or 0.05.
  - *A typed dose is never overwritten*; the conflict is the RSO's to review.
  - *`pacs_settings.viewer = 'ohif'` must open by `StudyInstanceUIDs`*; new tab, no embed until the
    owner's network and monitors are in (ruling 6); the book's `archive` block is optional so every
    earlier book parses.
  - *The inbox lives in the Rooms station* (the technologist knows who was on the table); the
    radiologist reaches it by the same route (the view checks the grant, not the station).
  - *Retention*: MLC never on a timer; minors until 21 when later than 5 years; nothing deleted
    automatically.
- **Pins.** Permissions: `radiology` manifest 18 → 20 (`radiology.pacs.interface`, `.pacs.reconcile`);
  `allPermissions` 205 → 207, `modelPairs` 427 → 430, `modelPermissions` 185 → 187,
  `heldPermissions` 191 → 193, V5 `declared` 205 → 207 / `held` 185 → 187 (after RS11's +1); per
  role radiologist 17 → 18, radiographer 10 → 11, modality_bridge 1 → 2; README radiology table +2 rows and the RS12
  prose paragraph. Radiology events 16 → 18. Error codes +4 (`invalid_pacs_notice`,
  `unknown_unmatched`, `not_acquired`, `images_already_attached`). Standup census +1 radiology row.
  No new route in the web router, no nav entry, caddyfile routes unchanged (a header view).
- **Counts** — see the PR body (touched suites, fail-first mutants, walk at 1920/1440/1280/1024/768/390
  in `/opt/hmis-context/rs12-walk/`).
- **Moved later.** The reading room's own "Open in OHIF" (RS8a's `/radiology/read` calls the same
  `openImages`); a per-machine RDSR/MWL capability flag on the device; an HOD escalation for inbox rows
  older than a shift (RS10's alerts spine); Orthanc-side authorization per study (the plugin that asks
  HMIS who may view) — until then the proxy's LAN-only auth is the gate.

#### RS12 — NEXT (not built): the IR suite
- **Screen** `room:ir` (a Rooms view): WHO sign-in (identity, site/side, consent, allergy, anticoagulant
  status + INR/platelets, contrast/renal gate from RS5, sedation plan, the operator and the
  anaesthetist), **time-out** (the procedure, side, the image on the monitor, antibiotics), running
  **fluoro time and cumulative air kerma / DAP** from the unit (RDSR TID 10001 already parsed here:
  113730, 113722; add 113725 Dose (RP) Total), a **skin-dose alert** at the SIR/NCRP 168 trigger
  (reference-point air kerma 3 Gy or peak skin dose 3 Gy → a documented follow-up at 2–4 weeks), and
  **sign-out** (the procedure done, specimens, devices left in, the plan).
- **Data it needs:** an `imaging_ir_checklists` row per study (three phases, each with who and when —
  the OT's `ot_case_gates` shape), the IR procedure book (a `study_types` subset with
  `interventional: true` + a consent template), the RDSR's reference-point air kerma, and a follow-up
  obligation for a skin-dose trigger (RS8's follow-ups table). Money: device/consumable billing is the
  OT's materials path — no new rule (none ruled).

#### RS12 — NEXT (not built): night teleradiology (ruling 7)
- **Identity:** a `teleradiology_reporter` role for the contracted provider's NMC-registered
  radiologists — a named user each (NMC number on the person), hospital scope, holding
  `radiology.reports.write` + a new `radiology.reports.prelim` only (never `sign`/`amend`), time-boxed
  by the kernel's temp-role grant to the night window; images via the same OHIF door (the provider
  reads over a site-to-site VPN; data stays in India, DPA under the DPDP Act).
- **Flow:** STAT/urgent studies after hours routed to the provider's worklist; a **prelim** within 30 min
  (STAT) / 60 min (urgent) — the existing prelim status, marked `provenance.reader = teleradiology`;
  the consultant's **morning over-read** signs (or amends) and logs a discrepancy grade (RS8's peer
  review table, `source = teleradiology`) for the monthly provider review.
- **Data it needs:** the provider register (name, DPA date, NMC numbers), per-study routing flag and
  TAT clocks (RS10's alerts), and the discrepancy log. Money: the provider's per-read fee is a payable
  (procurement), not a patient charge — nothing built until the owner signs the contract.

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
