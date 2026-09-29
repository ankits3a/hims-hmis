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

### RS5 · Prep & safety bay
- **Web:**
  - `prep:bay`: every prep gate, with evidence, waive, and override-by-approval (kernel approvals);
  - `prep:mri`: the screening form, card upload and zones;
  - `prep:contrast`: the record and reaction (existing routes, first web callers);
  - `prep:consents`: reuses `ot` `consentSchema`.
- **Core:** eGFR in the kidney gate (gap 3). An override request becomes an approval row for the radiologist or HOD.
- **Journeys:** J1 prep hop, J5.

### RS6 · Modality rooms
- **Web:**
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
    `report_templates` (RS4). Calculators are deterministic.
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
