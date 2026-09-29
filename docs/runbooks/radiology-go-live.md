# Radiology go-live runbook — Plan 18a (with 18a-iii)

The imaging department: the order, the schedule, the safety gates, the acquisition and the report.

**Two companion runbooks cover the rest of the series and neither replaces this one.**
`radiology-pacs-go-live.md` is 18b and 18-S RS12 (worklist export, UIDs, the viewer door, and the Orthanc + OHIF install, arrivals, dose reports and the Unmatched-images inbox).
`radiation-safety-go-live.md` is 18c (the AERB registers) and **its §0 is a hard stop on the whole
department** — read it before you deploy, not after.

**Written 2026-09-06 from a stand-up performed on an empty database**, not from the plan documents.
Everything below was reached by being blocked by it; the walk that produced it is
`docs/superpowers/plans/reports/2026-09-06-radiology-commissioning-walk.md`.

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**`seed:radiology` does not finish the department, and the step it leaves undone is invisible until a
doctor places the first order.**

The two workflow definitions the department runs on — `imaging_study` and `imaging_gate` — are
activated by **no seed and no script**. Until §3 is performed, a placed order produces no study, the
reception and worklist screens stay empty, and nothing anywhere says why. There is no refusal to read
because there is no request: `handleOrderPlaced` runs in the worker and fails there.

> **Perform §3 before you let a clinician place an imaging order.** It is a governed ceremony that
> names **three people**, so it cannot be done at 2 a.m. by whoever is deploying.

This is the counterpart to the laboratory's §5, with one difference that matters: the lab's
definitions are change-class **C**, activated by the department's own head. Radiology's are
change-class **A** — the same weight as an OPD visit — so they need the owner, the medical
superintendent, and a third person to draft.

---

## 1. Preconditions

| # | What | Why it blocks |
|---|---|---|
| 1 | Migrations applied through `0078` | the imaging tables, 18a-iii's contrast/outside/chaser tables |
| 2 | `seed:roles` re-run | mints `radiologist`, `radiographer`, `radiology_receptionist`, `modality_bridge` |
| 3 | **Humans assigned to those roles** at hospital scope | `seed:roles` mints authority and assigns NOBODY; a role nobody holds is a screen nobody can open |
| 4 | A user holding `owner`, a **different** user holding `medical_superintendent`, and a **third** holding any role | §3 — three distinct people, not two |
| 5 | The worker process running | §8 |
| 6 | An active tariff version with imaging prices | §6 — otherwise acquisition refuses `402` |
| 7 | 18c's licence register populated | `radiation-safety-go-live.md` §2 — otherwise every ionising study refuses |

---

## 2. The seeds, in order

```
pnpm seed:roles          # exits 1 listing what is unassigned — read it, that is the census working
pnpm seed:admin
pnpm seed:radiology      # 20 services, 5 device resources, study_types v1 ACTIVE
cat roster.json | pnpm seed:staff
```

`seed:radiology` creates the twenty study types' tariff **service rows with no prices** (a phase that
invented prices would be inventing money) and five `device` resources — one X-ray, one ultrasound,
one CT, one MRI, one mammography unit. The seed does not guess at an inventory, and **a hospital
with two CTs adds the second through this script — there is no resources screen. See §5.**

It also self-publishes the `study_types` book, leaving `approval_id` NULL as the provenance — the
owner's 2026-08-31 ruling. Every LATER version goes through the medical superintendent's approval on
the publish route, which is unchanged.

**`SEED_ACTOR_ID` names the administrator performing the go-live** and the audit row records them.
Left unset, the activation row reads `seed:radiology` — honest, and implicating no human.

---

## 3. The workflow definitions — the ceremony §0 is about

`imaging_study` and `imaging_gate` are change-class **A**. Activating one takes **three distinct
people**, and the third is the part no other document mentions:

1. **A drafter** calls `createDraft` for each definition.
2. **The owner** approves it (`roleKey: "owner"`).
3. **The medical superintendent** approves it (`roleKey: "medical_superintendent"`).
4. **Someone who is not the drafter** activates it.

Two guards make the third person unavoidable, and each refuses with its own error:

- `approveDefinition` refuses `duplicate_approval` on `(definitionId, approverId)` — **per PERSON,
  not per role key**. One account holding both `owner` and `medical_superintendent` cannot supply
  both approvals.
- `activateDefinition` refuses the SoD pair `workflow_drafter_activator`. **Whoever drafted it may
  not activate it**, so the drafter must be a third person if an approver activates.

So the smallest lawful set is three: a drafter, and two approvers one of whom activates.

`registerRadiologyApprovalTypes` registers `imaging_definition_publish` (approver
`medical_superintendent`, 24-hour SLA). `seed:radiology` performs it, as a user actor. It is
idempotent — a typeKey already registered is left untouched.

**Confirm before going further.** With §3 undone, `handleOrderPlaced` cannot start an instance and no
study appears. The check is positive, not negative: place one order and see a study with an `X`
accession on `/radiology/reception`.

**On a dev or UAT stack** `npx tsx apps/core/scripts/dev-radiology-standup.ts` performs this and §6
in one step. It refuses production two ways and **files no AERB licence, deliberately**. It is not a
production path: production's activation names real people and that is the point of it.

---

## 4. Who holds what

| role | holds | seat |
|---|---|---|
| `radiology_receptionist` | `radiology.schedule`, `radiology.orders.place`, `radiology.bill_decisions.manage` | reception — books slots, walk-ins, check-in |
| `radiographer` | `radiology.checkin`, `radiology.acquire`, `radiology.gates.satisfy`, `radiology.contrast.record`, `radiology.mwl.read` | the console |
| `radiology_nurse` (18-S RS5) | `radiology.worklist.read`, `radiology.gates.satisfy`, `radiology.contrast.record` | the prep & safety bay — see §13 |
| `radiologist` | `radiology.reports.{read,write,sign,amend}`, `radiology.gates.override`, `radiology.criticals.ack`, `radiology.definitions.manage` | reporting |
| `doctor` | `radiology.orders.place`, `radiology.reports.read` | the ward and the OPD |
| `modality_bridge` | `radiology.mwl.read` | the machine, not a human — see the PACS runbook |
| `radiation_safety_officer` | `aerb.*` | the registers — see the radiation-safety runbook |

**A radiographer cannot override a gate and cannot sign.** That is DD7 and it is deliberate: the
radiologist is the second clinical opinion on a gate the technologist raised.

**Signing needs a second factor.** `POST /radiology/studies/:id/reports/sign` refuses
`second_factor_required` on a stale session. Every radiologist enrols TOTP
(`/auth/totp/enroll` → `confirm`) **before** their first reporting session, not during it.
Since WASA M-02, enrolling needs the account password in the body (`{ "password": … }`), replacing
an enabled factor needs its CURRENT code (`{ "currentCode": … }`) — the password alone will not do —
and every code is single-use: the code that confirmed the enrolment cannot also sign, so wait for
the authenticator's next code.

---

## 5. The machines

Each `device` resource carries a `modality` attribute, and `scheduleStudy` matches a study type
against it. **The device registry row is also what an AERB licence points at**: a machine that does
not exist as a resource cannot be licensed, and therefore cannot be used for an ionising examination.
The machines must exist before you enter the certificates.

**18-S RS4 built the door: Radiology → Setup → Machines** (`/radiology/setup`, grant
`radiology.devices.manage`, held by the `radiologist`). Until RS4 there was none — `seed:radiology`
was the only writer of an imaging device and nothing could set an AE title, so `GET /radiology/mwl`
was permanently empty.

1. `seed:radiology` still seeds the standard seven (§5a). Register every other machine at Setup:
   code, the name on the door, modality, room, and whether it goes to the bedside.
2. **Set each DICOM machine's AE title** exactly as it is configured on the modality's console —
   capitals, digits and underscore, up to 16 (`CT_1`). The register refuses anything else
   (`invalid_ae_title`) and refuses a title another machine already uses (`duplicate_ae_title`,
   naming that machine). **A machine's studies appear in the modality worklist only once its AE title
   is set** (`radiology-pacs-go-live.md` §2). A machine with no worklist (a CR cassette unit) is left
   without one; it is booked and acquired by hand as before.
3. **Taking a machine out of service** — `down`, `maintenance`, `qa_blocked`, `retired` — needs a
   reason, which is kept on the machine's history and its `resource.status_changed` event. The answer
   lists every study still booked on it (scheduled / checked in / ready): the desk moves them from the
   diary (§11). New bookings on it are refused `device_unavailable` from that moment.
4. **Two statuses the register will not walk a machine out of** (`device_status_locked`): a
   `qa_blocked` machine is released only by the RSO's passing QA record (Radiation safety → QA), and a
   `retired` machine stays retired (register a returning machine under a new code). A machine's
   modality never changes: retire it and register the new one.
5. **An ionising machine with no active AERB licence is now refused at BOOKING** (`device_not_licensed`,
   naming the machine and the RSO), not first at the console with the patient on the table (18-S RS4
   T2). The console's check stays: a licence can lapse between booking and the day.

### 5a. The two portables (18-S RS2b)

`seed:radiology` creates **seven** machines: the five department machines and two that go to the
bed, each carrying `attributes.portable = true`:

| Code | Name | Modality | AERB |
|---|---|---|---|
| `PX-1` | Portable X-ray | xray (ionising) | **needs its own licence** |
| `USG-P1` | Portable ultrasound | usg | none (it needs its PCPNDT machine entry instead) |

`attributes.portable` is the only thing that lets a study be booked at a bedside — before this seed
nothing wrote it, and every bedside booking was refused `device_not_portable`. A deployment that
already ran the seed gets both machines by re-running it; the study-type book is left alone.

**PX-1 is seeded WITHOUT an AERB licence, on purpose.** A placeholder licence would be the hospital
claiming paper it does not hold. So after the seed, `PX-1` appears in `GET /aerb/licences/gaps`, on
the red *machines emitting with no licence* block of `/radiology/radiation-safety`, as **"not
licensed"** in the reception machine list, and the standup check's `radiology_devices_licensed` row
is red — **until the RSO files the portable unit's real certificate** (§7). Until then any portable
X-ray acquisition is refused `device_not_licensed`, exactly as a fixed room's would be. If the
hospital has no portable X-ray, retire the resource rather than leave it unlicensed.

---

## 6. The tariff and the GST category

`seed:radiology` creates the service rows and sets **no prices**. Enter the rate list through the
tariff routes: draft a version, set a price per imaging service, submit, approve, activate.
**Not "the tariff screens"** — `tariff/manifest.ts` is `menu: []` with the comment *"no UI this
plan"*. The routes and the grants are real and the ceremony works; the screen is Plan 08's.

**The `investigation` GST category must exist**, or pricing refuses `gst_config_missing`. Every
imaging service is that category — and so is every laboratory service, so **this is one ruling for
both departments**, not two. **18-S RS4: `seed:tariff` (which `deploy.sh` runs) now writes it when
absent** — exempt, 0 %, SAC `9993`, per plan 18-S ruling 2 (Notification 12/2017-CT(R) entry 74; film
and CD given with the study are part of the same composite supply). A CA confirms the 6-digit SAC at
the first filing; a corrected row is never overwritten by a later deploy. `standup:check` row
`radiology_investigation_gst` (G2) is green when the row exists.

### 6a. Film, CD and outside reads (ruling 1, 18-S RS4)

`seed:radiology` also ensures four services in the `investigation` category, **unpriced**:

| Code | Service | Ruled price |
|---|---|---|
| `RAD-FILM` | Imaging film, per sheet | ₹250 |
| `RAD-CD` | Imaging CD | ₹300 |
| `RAD-2ND-XR-US` | Outside second-opinion read — X-ray or ultrasound | ₹600 |
| `RAD-2ND-CT-MR` | Outside second-opinion read — CT or MRI | ₹1,500 |

**Enter these four prices in the next tariff revision** (draft, set the item, submit, owner approves,
activate) — the seed does not activate a tariff version, because a price becomes chargeable only
through that approval. Setup → Prices shows each `RAD-` service with its GST category, the price in
force and, for these four, the ruled price, so the gap is visible until it is closed. **An X-ray
includes one film**: `RAD-FILM` is for further sheets and for CT, MRI and USG film on request; the
desk applies that rule — nothing on the bill enforces it yet. The digital report and the image link
are always free.

Until a version is active, `startAcquisition` on a routine self-pay study refuses **`402
payment_required`** — *"take the money, or record it as stat if this is an emergency"* (DD12a). That
is the money gate working, not a tariff bug. The cashier also needs an **open cash session** before
any invoice can be issued.

The order of the two refusals is worth knowing: **the money gate fires before the licence gate**, so
a department with no tariff will never discover its AERB problem.

---

## 7. The AERB licences

`radiation-safety-go-live.md` §2, in full, and its §0 first. In summary: from the moment 18c is
deployed, an ionising study cannot be acquired on a machine with no active licence — the refusal
names the machine and the date and points at the RSO. Ultrasound and MRI are unaffected; the gate is
keyed on the study type's `ionising` flag.

The portable X-ray (`PX-1`, §5a) is a machine in its own right and needs its own certificate.

**`GET /aerb/licences/gaps` coming back empty is the check.** So is the red *machines emitting with
no licence* block on `/radiology/radiation-safety` emptying — they read the same data.

---

## 8. The worker

`order.placed` is appended by the placement route and **dispatched by the worker process**. With no
worker running, `POST /radiology/orders` returns `201` and **no study is ever created** — the
department looks broken and the API looks healthy. If reception is empty after an order, check the
worker before anything else.

---

## 9. Verify — walk it once, deliberately

Place a real order and take it to the end. Every step below was performed on 2026-09-06 and each
number is what the route actually returns.

0. **Order it through a screen, not `curl` (18-S RS2).** Two doors, both on `radiology.orders.place`:
   - **Consult** — `/opd/consult`, Investigations tab, *Order imaging*. Advise a study (or search the
     book in the panel), type the clinical question, choose the side for a knee or a limb doppler, and
     press *Send to imaging*. The panel then reads *At the imaging desk to book*. Nothing is billed.
   - **Imaging desk** — `/radiology/reception`, *Order from a visit*: type the `V…` number. The
     doctor's advised imaging lines come back; a line the book does not name is **greyed with its
     reason** (it is not hidden), and a line already ordered says *Ordered · R…*. Type the question and
     press *Place order*. For a walk-in slip, use *Outside prescription*: search the book, type the
     referring doctor's name and registration number exactly as the slip shows (both required — the
     order is refused without them), and place. The visit's own doctor is the answerable clinician.
   - A lab test advised in the same consult never appears at the imaging door. If an imaging line you
     expect is missing, the service is neither in the study-type book nor an `investigation` in the
     tariff (or the lab catalogue claims it).
   - **Why there is no census row for this step.** 18a-iv T4 asked for a `standup-check` row that fails
     when an active book exists and no screen can order from it. "No screen" is a property of the
     CODE, and it is now closed in code and pinned by `imaging-order-panel.test.tsx` and
     `imaging-desk-door.test.tsx`. The only data a census could read here — "some active user holds
     `radiology.orders.place`" — is green on any hospital with one doctor, so it would certify nothing
     (a row green on its own emptiness). Walking this step once is the check.
1. `POST /radiology/orders` → `201`, an `R…` order number and an `X…` accession appears at reception.
2. Schedule it onto a machine → `201`. At `/radiology/reception` pick the machine from the list
   (code · name · room; *portable* and *not licensed* are marked). **For a bedside study** pick a
   portable machine (`PX-1`, `USG-P1`): an *At the bedside* field opens — type the ward and bed
   (`Ward 3 · bed 12`) and book. The study then appears on the technologist's **Portable round**
   (`/radiology/portable`, `radiology.acquire`), grouped by ward, and each row opens the study
   console. Booking a study that carries a bed onto a fixed machine is refused
   `device_not_portable` (booking with the field empty is not enough — the server keeps the place
   until it is cleared). The desk then either picks a portable machine, or presses *Bring to the
   department instead*, which rebooks with the bed explicitly cleared. Ordering
   from the ward itself arrives with the IPD plan: the core accepts `bedsideLocation` on an order
   item today (`imaging.bedside_requested`), and no screen sends it yet.
3. Check in → `201`, and the open gates come back named.
4. Satisfy each gate. **The evidence IS the body**, not nested: identity is
   `{"secondIdentifier":"uhid","value":"U…"}`, pregnancy is `{"declared":true,"lmpDate":"…"}`.
5. Bill it, then link the line — `POST /radiology/studies/:id/invoice-line` takes an **existing**
   `invoiceLineId`. Billing prices it; radiology only links it.
6. Start acquisition. **On an ionising study with no certificate on file this is where you meet
   `403 device_not_licensed`** — see it once, on purpose.
7. File the certificate at `/radiology/radiation-safety`, then start again → `201 in_acquisition`.
8. Record acquired **with a dose** — an ionising study carries at least one of CTDIvol, DLP or DAP.
9. Draft, sign (second factor), publish → the report shows `v2 — signed · published`.

---

## 10. Drills — before the pilot, not during it

**Drill A — the machine with no paper.** Try a CT on an unlicensed unit and read the refusal aloud.
It names the machine by its code and says who lifts it. Everyone on the floor should have met it once
before a patient is on the table.

**Drill B — a critical finding at 02:00.** Publish a report marked `red` and confirm the
acknowledgement lands. 18a-iii's chasers escalate an unacknowledged critical and an unread report;
they write a mark and raise an alert and **they never close a finding or mark a report read** — a
human does.

**Drill C — the outside film.** Register a study done elsewhere. It records the centre, the date and
how the images arrived, it is never billed as a performed study, and no dose is logged against it.

## 11. The imaging front desk — counter, diary, hall display (18-S RS3)

**Who.** `radiology_receptionist` now also holds `radiology.checkin` and `radiology.display.read`
(`seed:roles`). The hall TV logs in as the kiosk `display` account, which holds `opd.display.read`
and `radiology.display.read` and nothing else. Re-run `seed:roles` after deploy; it only adds.

**Before the first patient.**
1. The receptionist opens their **cash drawer** (`/billing/session`). With no open drawer the
   counter offers no tender at all — that is billing's rule for every receipt, cash or not.
2. UPI needs the UTR and card needs the approval code, typed at the Bill step.
3. Film (`RAD-FILM`, ₹250 a sheet) and CD (`RAD-CD`, ₹300) appear as add-ons only once the tariff
   carries services with exactly those codes (ruling 1; RS4 owns adding them). Until then the Bill
   step shows a note.
4. Open `/radiology/display` on the hall TV under the `display` account and leave it; it polls every
   15 s and has no controls.

**The counter (`/radiology/reception`).** Open a patient from the right-hand list, or find a visit
and press *Work this visit at the counter*. Opening a patient **on the day of the slot checks their
booked studies in** — there is no check-in button. Then:
- **Studies** — the visit's studies at the desk (to book, booked, checked in).
- **Checks** — the safety checks the prep bay will open and what to tell the patient (English and
  Hindi). The desk records nothing here; a check is cleared only in the prep bay or the room.
- **Bill** — self-pay is collected here: one invoice through billing, then the line is linked to
  the study (that link is what lets the room start the scan). STAT: nothing collected, the bill
  follows. TPA / PM-JAY / corporate: billed to the payer; for a cashless MRI or CT confirm the
  pre-authorisation with the TPA desk (the system has no pre-auth record yet), else a deposit at the
  billing counter. **No discount at the counter** (HOD up to 10%); **no credit** (owner only). If the
  service was already billed on the visit, the desk links that line instead of billing twice.
- **Slot & slip** — pick a machine of the study's kind and a time (IST), or *Now · walk in* (books
  the first free machine and checks the patient in). A machine without an AERB licence cannot be
  picked. The slip shows the accession (the patient's token on the hall board) and the prep; the
  appointment message is **queued, not sent** (the WhatsApp provider is not connected).

**The diary (`/radiology/diary`).** Every machine × the chosen day. Click a booking to move it,
mark a no-show or cancel it — **each needs a reason** (the server refuses without one, and records
it on `imaging.booking_changed`). A down or unlicensed machine with bookings gets a red banner
listing the patients to move. Cancelled before the room: the refund goes through the billing
office's refund request; the desk does not refund.

**Verify once.** Book a study, see the block on the diary, open the patient on the day (checked
in, the token appears under NEXT on the hall TV as `X… Firstname I.`), move it with a reason
(`imaging.booking_changed` row; the old `imaging_appointment_booked` outbox row goes `expired`, a
new one `queued`).

## 12. The modality rooms — console, portable, dose log, rejects, downtime (18-S RS6)

**Who.** `radiographer` (and `radiologist`) — `radiology.acquire`. Nothing new in `seed:roles`.
Opening a booked patient checks them in, so the radiographer's existing `radiology.checkin` is used.

**Before the first patient: the protocol book.** The HOD writes the `imaging_protocols` book under
Setup → Books (`/radiology/setup?view=books`); the medical superintendent approves it in the
approvals inbox, then it is published — the same route as every other book. **Nothing is seeded**:
until the HOD publishes, the console says *"No protocol book is published yet"* and the technologist
works from the radiologist's instruction. One protocol per study-type code (`study_type_code`), or a
department default per modality (`modality`); the study type's own wins. Each protocol carries:
- `name`, `technique` (the radiologist's words), optional `preset` (the machine's stored protocol);
- `kv` / `mas` ranges; CT `ct: {slice_mm, pitch}`; MRI `sequences`;
- `contrast: {phase, ml_per_kg, max_ml, delay_s, agent?, rate_ml_s?}` — the console suggests
  `ml_per_kg × weight`, capped at `max_ml` (a suggestion; the volume given is typed);
- `breath_hold: {en, hi}` — both or neither, read aloud from the console;
- `paediatric: {bands: [{from_kg, to_kg, kv?, mas?, ml_per_kg?, note?}]}` — a child is dosed by
  weight band; a weight outside every band is a question for the radiologist.

Example body: `{"protocols":[{"study_type_code":"CT-ABDO-CONTRAST","name":"CECT abdomen, portal
venous","technique":"Supine, arms up …","kv":{"min":100,"max":120},"ct":{"slice_mm":5,"pitch":0.98},
"contrast":{"phase":"portal_venous","ml_per_kg":1.5,"max_ml":100,"delay_s":70},"breath_hold":{"en":
"Breathe in… hold","hi":"साँस अंदर… रोकिए"}}]}`.

**The console (`/radiology/room`).** Pick the machine at the top; the right list is that machine's
day (STAT first, then on the table → ready → arrived → booked), with *Clocks running* for a STAT
waiting over 10 minutes and a ready patient over 20. **Opening a patient means they are on the
table** — a booked study is checked in by that act; there is no presence button. Then:
1. **Identify** — the patient says name and age in their own words (tick), then the second
   identifier: scan the wristband, or the UHID said / on the slip, or the date of birth. The server
   compares it with the patient master; a mismatch leaves the gate open — stop. For a study with a
   side, the patient points; there is no override for the side. Any other open gate belongs to the
   **prep bay** (`/radiology/prep`): the console shows it, links there, and will not go on.
2. **Protocol** — the card, the contrast volume for the weight (the charted weight is filled in;
   type the weight on the table), and the breath-hold words in English or Hindi.
3. **Acquire** — *Start*. A refusal is shown in the server's words with the seat that fixes it:
   no AERB licence → Radiation safety → Licences; machine down or busy → Downtime; not paid → the
   imaging front desk; a prep gate → the prep bay. Once on the table: type the dose from the console
   (CT: CTDIvol and DLP; X-ray: DAP, and fluoroscopy seconds when screened; mammography: DAP). **A
   number above the hospital DRL asks for a reason and never blocks** — the reason is kept on the
   dose register beside the verdict. Contrast: given (agent, volume) or *not given*; a study booked
   **with** contrast and scanned plain sends the contrast reversal to the bill-decisions queue with
   the reason typed here (ruling 3). **Repeat** records a retaken exposure with its reason code —
   positioning, patient motion, exposure too low/high, artefact, equipment fault — and raises one
   *repeat · no charge* bill decision per study (ruling 8: a technical repeat is free). **Abort**
   (with a reason) sends the study back to *ready*; nothing is billed for the abort.
4. **Send** — PACS (the Study UID is pre-filled from the worklist) or *no DICOM images*. The study
   leaves the list and appears on the reading worklist.

The study page (`/radiology/studies/:id`) is still there — the lane links to it, and it links back
to the console.

**Portable round (`/radiology/portable`).** Opening a bed opens the same console in bedside mode.
Before *Start* the technologist ticks the bedside radiation checks — everyone else 2 m away; lead
apron and thyroid shield on anyone who must stay; no pregnant staff, visitor or patient in the bay.
They are attested as text on the start (the study's history shows who, when, and the checks).

**Dose log.** The day's dose register for the machine, with the DRL verdict and the reason for
every above-DRL study; a missing reason is shown in red for the RSO's review.

**Rejects & repeats.** Last seven days: repeats per study acquired, per machine and technologist,
against a target under 3 %; reasons; the repeat log (accession, never the name). The *repeat · no
charge* and *contrast not given* decisions are listed; **resolving one is the desk's or the billing
manager's act** (`radiology.bill_decisions.manage`), never the technologist's.

**Downtime.** Every machine's status. *Report a breakdown* is the radiologist in charge's act
(`radiology.devices.manage`, Setup's status write with a reason); it answers with the booked
patients to move — move them in the imaging diary. A technologist sees who to tell instead.
**When HMIS itself is down:** each room keeps pre-numbered manual accession sheets (name, UHID,
study, side, dose, technologist, time); scan on paper, hand the sheet to the desk, and back-enter
each study when HMIS returns — the entry takes the paper time and is marked late (`acquiredAt`,
E11). No other downtime mechanism exists yet.

**Verify once.** Publish a one-protocol book; open a ready CT on the console — the card and the
volume show; identify; start; type a DLP above the DRL with a reason; record one repeat; send.
Expect: one `radiation_dose_register` row with `over_drl = true` and `drl_reason` set; one
`imaging.exposure_repeated` event; one open `repeat_no_charge` decision; the study on the reading
worklist; the repeat on *Rejects & repeats*.
## 13. The reading room — templates, signatories, checks, the signer on print (18-S RS8a)

**Who.** The reading room (`/radiology/read`) is for holders of `radiology.reports.write` (the
`radiologist`). Signing still needs `radiology.reports.sign` and a fresh second factor. No new
permission; nothing to re-seed.

**Before the first signature — two books, both drafted by the HOD, approved by the medical
superintendent** (Radiology → Setup → Books; the same draft → approval → publish every book uses):
1. **Report signatories (`report_signatories`) — REQUIRED.** Ruling 4: the printed report carries
   the signer's name, qualification, council registration number and electronic signature. Until
   this list is published **every signature is refused `signer_credentials_missing`**, naming what is
   missing (census row `radiology_report_signatories`, G3). One entry per radiologist or sonologist:
   ```json
   { "signatories": [
     { "user_id": "<the radiologist's user id>", "qualification": "MBBS, MD (Radiodiagnosis)",
       "designation": "Consultant Radiologist", "council_reg_no": "Jharkhand State Medical Council · 2014/1187" }
   ] }
   ```
   `council_reg_no` may be left out when the person's number is already on record — the roster's
   `nmr` / `smr` credential, else their OPD doctor record (`opd_doctors.registration_no`) is read. A
   person on neither is refused, naming the council number.
2. **Report templates (`report_templates`) — optional, recommended.** Structured templates: sections
   with a "normal study" text, named phrases (macros), and coded categories (BI-RADS, ACR TI-RADS,
   LI-RADS, PI-RADS, O-RADS US, Lung-RADS, Fleischner 2017, ASPECTS), each `required` or not. A
   reference set covering all eight systems is in `docs/runbooks/radiology-report-templates.reference.json`
   — **clinical content, the HOD's to read and change** before pasting it into the Books editor;
   nothing is published by a seed. Without this book a study gets the built-in section skeleton.
   A template names `modalities` and optionally `study_type_codes` (a type-named template is offered
   first).

**The checks before a signature** (the same rules run as the screen's live card, at Sign and at
Amend — no model):

| Code | Level | What it catches | Fix |
|---|---|---|---|
| `impression_required` | refuse | empty impression | write it |
| `side_conflict` | refuse | a left study whose report names only "right" (or the reverse) | correct the side in the text |
| `side_mentions_both` | warn | the report names both sides | re-read each word; tick |
| `sex_organ_mismatch` | refuse | uterus / ovary / endometrium on a male registration, prostate / testis / scrotum on a female | correct the text, or the patient's registration at the front desk |
| `coded_category_required` | refuse | a template's required category (e.g. BI-RADS) missing, or not a category of its system | choose one |
| `coded_calculation_differs` | warn | the category disagrees with the recorded calculator inputs (TI-RADS points, ASPECTS regions) | tick if you grade it differently on purpose |
| `critical_term` | warn | pneumothorax, intracranial / subdural / extradural haemorrhage, aortic dissection, pulmonary embolism, free air, ectopic pregnancy, torsion, cord compression, acute infarct … — **not negated** ("no pneumothorax" is not a hit) — with no critical category chosen | flag red / orange / yellow, or tick that it is not critical for this patient |

A warning is signed only when ticked, and the tick is stored on the signed version
(`imaging_reports.sign_checks`: which checks ran, each warning, who acknowledged, when). The PCPNDT
lexical lockout and the order-side check (`laterality_mismatch`) still run first, unchanged.

**The signature.** The dock's act is **Sign and publish**: it saves the text as a draft, signs it
(the authenticator code is asked in the dock only when the session's second factor is stale — the
code verifies the SESSION, it never travels with the report), then publishes. The signed version
stores the signer block (`imaging_reports.signer`): name, qualification, designation, council
number and where it was read from, Doctor ID, the second factor's instant, the authenticator's key
id, and a SHA-256 of the signed content. **It is an electronic authentication record, not a Digital
Signature Certificate**; the print says "electronically signed".

**The print** (Reading room → a signed study → Print preview; `GET /radiology/reports/:id/print`):
the letterhead, patient, the referring doctor as **Doctor ID + department only**, the sections,
the impression, the coded line ("BI-RADS 4A — …"), and the signer block. A draft or prelim never
prints. A report signed before RS8a prints "signer details were not recorded at signing".

**The worklist.** One list, sorted (priority · time left · modality), never filtered. Clocks: STAT
30 min, urgent (the ER's and wards' priority) 60 min, a bedside study (IPD) 6 h, otherwise OPD
24 h — from when the images are in. "Dr X is reading" is derived from the image-view log (someone
else opened the images in the last hour); there is no claim button.

**Verify once.** Publish the signatories book naming one radiologist. As that radiologist open a
study at `/radiology/read`, type "Large right pneumothorax." with an empty impression: the card
shows `impression_required` (red) and `critical_term` (amber), the dock is dead. Write an impression,
tick the warning, Sign and publish. Open Print preview: the name, qualification and council number
are on it, the referrer is a Doctor ID. `select signer, sign_checks from imaging_reports where
status = 'signed' order by created_at desc limit 1` shows both blocks.

---

## 14. The prep & safety bay — gates, eGFR, contrast and the override request (18-S RS5)

**Who.** `seed:roles` adds the role **`radiology_nurse`** (the bay's nurse) and one permission,
`radiology.contrast.record` (radiologist, radiographer, radiology nurse). Assign the bay's nurse
**`radiology_nurse` at hospital scope**; she satisfies prep gates, records contrast and reactions,
and **cannot override or waive** — she asks the radiologist. The radiologist now also holds
`approvals.requests.read` / `.decide`. Re-run `seed:roles` after deploy; it only adds.

**The workflow definition must be re-activated.** The `imaging_gate` definition now names
`radiology_nurse` on `open → satisfied`. A deployment that activated the earlier version keeps
refusing the nurse (`role_denied`) until the new version is drafted, approved by the owner and the
MS, and activated by a third person — the §3 ceremony, once. Gates opened before re-activation stay
pinned to the old version; a check-in after it gets the new one.

**The approval type.** `seed:radiology` registers `imaging_gate_override` (approver `radiologist`,
urgent, 30 minutes) next to `imaging_definition_publish`. Re-run it after deploy; an existing type is
left alone. **Confirm:** `select type_key from approval_types where type_key = 'imaging_gate_override'`.

**The kidney rule (plan Gap 3, DECIDED clinical standard).** The kidney gate computes an **eGFR
(CKD-EPI 2021)** from the creatinine, the patient's age and sex (from the patient master, never
typed):
- **eGFR under 30** — the gate cannot be satisfied; the radiologist overrides with a reason, or not.
- **30–44** — satisfiable only when the nurse confirms the **IV hydration** instruction is on the
  plan (0.9% saline 1 mL/kg/h, 6 h before and 6 h after); the instruction is stored in the evidence.
- **under 45** — the metformin note (hold 48 h, restart after renal function is rechecked) is stored.
- **No eGFR** (no date of birth, sex not female/male, under 18) — the old ceiling decides:
  creatinine above 176.8 µmol/L (2.0 mg/dL) is the radiologist's override.
The bay reads the lab's **latest signed serum creatinine (analyte `CREA`)** and sends it by pointer;
an outside paper report is typed and flagged `external`. The window is unchanged (30 days OPD,
7 days admitted or CKD).

**The bay (`/radiology/prep`).** The right list is every checked-in study with an open prep gate,
STAT first. Identity and side are closed by the technologist at the console and show "closed at the
console". Each other gate is a form (no JSON anywhere): the second identifier compared with the
record; the pregnancy declaration, LMP or a bay urine test; the bilingual contrast consent with a
witness; the creatinine; the premedication and the radiologist who decided a prior reaction; the MRI
screening form; the Form F register check; the chaperone; the MLC number. When the last gate closes
the study becomes **ready** by itself and leaves the list.

**Ask the radiologist.** Any open gate except Form F and side offers *Ask the radiologist to
override* with a note. It becomes an approval in the radiologist's queue — the worklist's *Clocks
running* lists it, and the study console shows it with **Grant and override** / **Refuse** and a
required reason. A grant runs the ordinary override (same event, same record). A grant given in the
kernel's `/approvals` inbox does **not** override by itself: open the study console and grant there
to apply it.

**MRI screening.** A *yes* to pacemaker/ICD, cochlear implant, aneurysm clip, neurostimulator/pump,
metal fragments or metal in the eye cannot satisfy the gate; the form records the MR-conditional
card's device/model/serial (there is no photo upload yet) and hands the finding to *Ask the
radiologist*.

**Contrast and reaction.** Recorded in the bay's patient view once the study is on the table
(`in_acquisition` onwards; the study console links there). An expired vial is refused. Rate,
injector and the extravasation check are written into the site line (no columns yet). A reaction
adds "`<agent>` (contrast media)" to the patient's allergy list, and the **next** contrast study's
prior-reaction gate stops on it.

**Verify once.** Check in a contrast CT for an 80-year-old woman with a signed creatinine of
1.8 mg/dL: the bay shows eGFR 28 "held for the radiologist"; *Ask the radiologist*; the radiologist
grants with a reason on the study console; the gate reads *overridden*, the approval *granted*.

---

## 15. Release, hand-over and the closed loop (18-S RS9)

**Migration `0147_radiology_closed_loop`** (additive): `imaging_report_delivery` gains `acted_at`,
`acted_by`, `acted_outcome`, `acted_note`; two new tables, `imaging_report_handovers` and
`imaging_media_requests`. No permission, role or seed changes — re-running `seed:roles` is not
needed for this section.

**Release.** Unchanged: the radiologist publishes from the report (`POST …/reports/publish`). The
patient's *report ready* message (`imaging_report_ready`, English + Hindi, order number only — never
the study) is **queued, not sent** at release when the bill is settled or the report is RED; a
patient who said STOP is suppressed at send time. There is no patient link and no OTP service yet.

**The doctor's side (the consult, between patients).** The doctor's *Imaging results* list sits
under "Nobody is in the chair" in `/opd/consult`:
- red/orange criticals not yet read back come first — *Read back and acknowledge* records the
  doctor's own read-back on the same critical row the reading room uses;
- then unread (chased at 24 h), then read-not-acted, then acted (kept 14 days);
- *Open report* is the read that lands — **only the treating doctor's opening stamps the first
  read** (the ordering clinician, or the doctor of the visit). A technologist or another doctor
  opening it no longer silences the 24-hour Unread Watchman;
- *Mark acted upon* — one of *changed treatment / referred / follow-up booked / discussed with
  patient / no change needed* plus one line (4+ characters). **This stops the north-star clock.**
  An amended report re-opens the loop: the doctor acts again on the new version.
- A doctor who is not treating the patient is refused by name (`not_treating_doctor`).

**The imaging desk (`/radiology/reports`, *Report hand-over*).** `radiology.schedule` (the
receptionist). One register, last 30 days, rows that need the desk first:
abnormal and not collected in 24 h (call the patient) → amended after hand-over → film/CD to print →
film/CD to hand → no patient notice recorded → not collected. Open a row, say who is collecting:
- **Patient** — check name and age against the slip or UHID + phone;
- **Relative** — name, relation, and the ID they show (type + **last four** characters only). There
  is no OTP to the patient's phone yet; the ID record stands in until an OTP provider exists;
- **Ward staff** — name (the film goes into the patient's file);
- **Courier** — name, on the patient's written request, sealed envelope.
For an outside-prescription study (no doctor in the hospital), the hand-over is recorded as the
report's first read.

**Film and CD (ruling 1).** *Ask for film* / *Ask for a CD* records the request. An X-ray's **first**
film sheet is included (no charge); every other sheet and every CD is **charged at the billing
counter** under `RAD-FILM` / `RAD-CD` (§6a — the desk screen composes no money and links no invoice).
*Mark printed* when it comes off the printer; tick *Hand over with the report* at the hand-over.

**The north star (`GET /radiology/north-star?from=YYYY-MM-DD&to=YYYY-MM-DD`, radiologist / HOD).**
Per modality × source (OPD / IPD / ER / OUT): studies ordered, median and 90th-percentile minutes
order → signed, signed → first read, order → acted, signed-unread > 24 h, published-not-acted > 72 h.
Source until IPD/ER modules exist: outside prescription or self → OUT; day-care or bedside → IPD;
STAT → ER; else OPD. The HOD screen that shows it is RS10.

**Verify once.** Publish a report on a study ordered by a doctor user; open it as that doctor from
the consult → `imaging_report_delivery.first_read_by` is the doctor. Mark it acted upon →
`acted_*` set, one `imaging.report_acted_upon` event (outcome only, never the line). At the desk,
ask for a film on an X-ray (first sheet `included = true`), mark printed, hand over to a relative →
one `imaging_report_handovers` row, one `imaging.report_handed_over` event (collector type only),
the media row carries the hand-over id. `GET /radiology/north-star` shows the study with an
order → acted time.

## 16. The Supervisor & HOD station (18-S RS10)

**No migration, no new permission, no seed-roles change.** The station is `/radiology/hod` (menu
*Supervisor & HOD*), reached by `radiology.definitions.manage` — the department head's books grant,
held by `radiologist` only (a resident does not hold it). Eight header views: Floor · Escalated ·
Approvals · Quality · Equipment · Roster · Money · Access log.

**Step 1 — switch the escalations on (once per deployment).** Re-run the radiology seed:

```
pnpm seed:radiology      # idempotent: what exists is left alone (§2)
```

It now also activates eight class-C workflow definitions, `imaging_esc_stat_unread`,
`_held_study`, `_red_critical`, `_machine_down`, `_licence_gap`, `_bill_decision_stale`,
`_abnormal_unopened`, `_unmatched_pacs` (class C needs no governance approval — the approval-flow precedent). Until they
are active the station still LISTS each cause but tells nobody, and says so in a gold banner
("Escalations are not switched on for …"). Check: `select def_key from workflow_definitions where
def_key like 'imaging_esc_%' and status = 'active'` → eight rows.

**Step 2 — the worker job.** `sweepImagingEscalations` runs every minute in the worker (job 24;
Prometheus leg 1a + an `absent()` term). Each cycle: a cause with no open obligation → start one; an
obligation whose cause cleared → `resolved`, timers cancelled. Nothing else writes these instances.

| Cause | Raised when | First told (rung 0, 1 %) | Budget → medical superintendent | Closed by |
|---|---|---|---|---|
| STAT unread | STAT, images in > 15 min, no prelim or signed report | radiologists | 15 min | a prelim or signature |
| Held at a gate | checked in > 30 min with a gate open | radiologists | 30 min | the gates closed / study moves on |
| Red critical | red, not read back, past the `critical_categories` red window (no book: once the chaser marked it) | radiologists | 15 min | the read-back |
| Machine out of service | `down` or `qa_blocked` | radiologists | 60 min | back to `available` |
| Licence gap | no AERB licence covering today AND a study booked on the machine | RSO (50 %: radiologists) | 60 min | licence filed / bookings moved |
| Bill decision stale | open > 24 h | billing manager | 4 h → radiologists | resolved at the desk |
| Abnormal unopened | a critical-category report released > 24 h, first read not stamped | radiologists | 60 min | the treating doctor opens it (or the hand-over, for an outside study) |
| Unmatched images | an archive study (RS12 inbox) open > 24 h | technologists | 4 h → radiologists | attached or rejected in *Unmatched images* |

Who "radiologists" are is the roster's answer: a `roster_escalation_targets` row for
`workflow.timer_rung` narrows it to whoever is on; without one it is every holder of the role. Nobody
holding a rung → the duty managers → the owners (the spine's own fallback).

**Acting on one (the HOD).** Escalated view → the item in hand → *Seen*, *Take it on* (15 min – 4 h),
or *Hand over to* a named person. These are the kernel alert acts: seen / take-it-on stop the
reminder clock, never the ladder; hand-over stops nothing. The docked act (Enter) opens the seat
that fixes the cause. The escalation closes itself at the next sweep after the seat's act.

**Approvals.** Pending `imaging_gate_override` requests are granted or refused here with a reason
(the same route as the study console). **A grant made in the hospital's `/approvals` inbox now
applies the override by itself** (the worker's `radiology.approval_granted` consumer): no second
press at radiology. A never-override kind (Form F, the side) stays refused; a reason containing a
PCPNDT term is not applied — the gate stays open and the bay sees it. `imaging_definition_publish`
is the medical superintendent's (link to the inbox). Bill decisions are listed read-only — the desk
and billing manager resolve them.

**Verify once.** (1) Mark a machine `down` in Setup → within a minute the HOD's Escalated view shows
it, and every radiologist's bell has an *Escalation: imaging_esc_machine_down · open · rung 0*
alert; put the machine back → the row goes at the next minute. (2) File an override request from the
prep bay, grant it from `/approvals` → the gate is overridden without opening radiology.
(3) Open any study's images → the Access log shows who, their role, the patient and the accession.
