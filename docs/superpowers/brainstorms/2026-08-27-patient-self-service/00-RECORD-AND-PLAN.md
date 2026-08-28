# Patient self-service & document chrome — record and plan
**Date:** 2026-08-27 · **Status:** brainstorm, not approved · **Author:** session record
**Companions:** `01-MEDANTA-TEARDOWN.md` (competitor reference) · department series `2026-08-27-department-series/`
**Artifacts:** Patient App Spine · Medanta Teardown (links in §9)

---

## 0. What this document is

A record of one working session and the build plan that came out of it. It covers three
things the department series did not: **patient-initiated identity amendment**, **the
patient-facing self-service app**, and **the printed-document chrome** every module needs
and no module owns.

It is a brainstorm. Nothing here is ruled. Seventeen questions are parked in §3 awaiting
the owner, and four of them cannot be retrofitted cheaply once code exists.

---

## 1. Frame

### 1.1 What exists (read from `main`, this session)

| Surface | State |
|---|---|
| `patients` master | UHID (`<PREFIX><7-digit><Verhoeff>`), merge chain, `isConfidential`+`alias`, `sensitiveContext`, `deceasedAt`, `promotionalOptIn`, `legacyUhid`, `qrVersion` |
| `patientGuardians` | relationship, scoped authority (messages/consents/DSR/bills), validity dates, majority transition at `MAJORITY_AGE_YEARS` |
| `updatePatient` | field diff → `patient.updated` event. **No reason, no evidence, no approval, no version.** One permission (`patients.update`) gates name, DOB, sex, `isConfidential`, `alias`, `deceasedAt`, QR reissue, allergies, guardians |
| `qr.ts` | HMAC card `q1.<id>.<uhid>.<ver>.<sig>`, merge-chain following, alias on scan, `qr.signature_failed` events, `reissueQrCard` version bump |
| `opdAppointments` | booking, reschedule, cancel, no-show, `appointmentNo`; **the partial unique index on `(doctor_id, slot_start)` is the sole race arbiter**; `source` comment already reads *"self-booking arrives Plan 10"* |
| `availableSlots` / `opdDoctorSchedules` | grid computation, `roomId` → `resources` (Plan 13), leaves |
| `opdQueueSessions` | `nextToken`, `callsMade`, skip logic, E-32 interleave |
| Billing (Plan 08) | tenders `cash\|upi\|card` at a counter, CSV recon, cashier sessions + variance, `fee_unsettled` gate, new/renewal fee branch, approval-gated refunds, `feeBps`, cash-law C-2 |
| `opdConfig.letterhead` | `{ name, addressLines[] }` — **two fields**, consumed ad hoc by `prescriptions.ts` and `billing.controller.ts` |

### 1.2 What does not exist

- **A patient actor.** `Actor = { type: "user" \| "agent" \| "system" }`. `bookAppointment`
  throws `user_actor_required`; `verifyQrScan` says *"scanners are desk surfaces — user
  actors only"*. **Every step of the app is currently refused by design.** Kernel change.
- Patient OTP / PIN (the OTP in the repo is staff TOTP).
- A household model.
- Slot holds.
- Any online payment rail — no gateway, intent, webhook, idempotency key, refund-to-source.
- Lab, radiology, video consult, home care, second opinion, callback queue.
- Any shared document chrome, document number, or verification code.

### 1.3 Locked, inherited, not re-litigated

- **One hospital, one site, for ten years** (owner, this session). The entire multi-site
  dimension is deleted — no site picker, no per-site slot accordion, no per-site fee,
  one UHID prefix.
- Plan 13 registry kinds are closed at ten. Kiosk → `device`, counter/desk → `bench`
  (index §4 theme 2). **Do not request a kiosk kind.**
- Sealed-class aliasing is one library in `patients`, consumed via `patients.get`
  (index §4 theme 7). **The app implements no aliasing of its own.**
- Refund policy for prepaid instruments is policy JSON, not code; auto-refund below a
  threshold for hospital-fault, approval above, bank transfer above ₹10k
  (index §4 theme 18).
- Payment gateway is **one adapter**, Plan 22a, register R-261, consumed by 23/24/26/27/16f.
- Until Plan 30, every downtime is hospital-scoped.

---

## 2. The conversation, recorded

### 2.1 Identity amendment — "Kavita Prasad"

**The question.** A patient registers, finds her details misspelled, and wants them changed.
She may be genuine, or she may be a criminal who has realised the record can be traced.

**The reframe.** One sentence at the counter is three different requests: **correction**
(the record never matched reality), **change** (reality moved — marriage, transition, new
phone), **concealment** (the record is accurate and that is the problem). They look
identical on screen and need different machinery.

**The resolution — and this is the load-bearing idea of the whole session:**

> **The master record says who you are. The document says who you were.
> Amending the first never touches the second.**

Concealment dies on that law without anyone judging motive. Kavita amends freely; her
27 Aug visit remains, forever, a visit by the person the record named that day, findable
by that name. Genuine Kavita is not interrogated. Criminal Kavita gains nothing. **We
never have to tell them apart, so we can never be wrong about it.**

**Why this is urgent, not theoretical.** Nothing in the repo snapshots the name — no
`patient_name` column on any table, no name-at-issue field on visits, bills or reports.
Every historical document renders `patients.name` by live join. So a single
`PATCH /patients/:id {name}` **retroactively rewrites her name on every prescription,
bill and report she has ever had.** §2.5 shows Medanta demonstrating this failure in
production.

**Field classes** (currently all on one permission):

| Class | Fields | Gate |
|---|---|---|
| I identity-bearing | name, DOB, sex, guardian name, ABHA/ID link | Versioned. Reason class + evidence + second person. Forces QR reissue. |
| II contact | phone, altPhone, address, language | Cheap — but phone is both dedup key and message channel: OTP the new, notify the old. |
| III clinical-adjacent | blood group, allergies | The `entered_in_error` grammar allergies already use; blood group should join it. |
| IV privacy/admin | `isConfidential`, `alias`, `sensitiveContext`, `deceasedAt` | Each its own permission. Today all ride `patients.update`. |

**The typo window.** Before any artifact exists (no prescription, bill, barcoded specimen,
claim or printed card) and inside the same registration session, a fix is a free in-place
edit — evented, no version, no approval. Most real cases die here, cheaply. This matters
more than it sounds: **at 2,000 OPD/day, if amendment is slower than re-registration,
staff will create duplicates instead**, and a duplicate is an identity break with no audit
trail at all.

### 2.2 Self-registration and the household

**Three decisions that shape everything.**

1. **OTP verifies a phone, not a person.** A self-registered record is genuinely
   lower-assurance. Make it a column: `identity_assurance ∈ self_declared |
   staff_verified | id_verified | abha_verified`. Self-registration mints a **real UHID**
   (a UHID is a key, not a credential — withholding it breaks the QR-at-the-desk flow)
   stamped `self_declared`. First counter contact upgrades it. Anything with legal or
   financial weight beyond the consult fee — claim, certificate, admission, MLC —
   requires an upgrade first.

   This is also the **best available fix for §2.1**: a `self_declared` record is freely
   self-correctable until the first clinical artifact exists, because nobody vouched for
   it. And the patient types their own name, so the Kavita/Kavitha/कविता transliteration
   damage never happens at source.

2. **One phone is a household, not a person.** The mainstream Indian case, not an edge
   case. Model **phone → household → patients**, never phone → patient. This turns the
   biggest duplicate risk into the best duplicate *control*: self-service is the one
   channel where the dedup check can be **forced** — a clerk can click past a nudge, a
   form field cannot.

3. **The QR is an identifier, not a credential.** HMAC-signed so it cannot be forged, but
   a screenshot is a perfect copy. Keep the static QR for *retrieval* at a staffed counter
   (staff still read the name back); for anything the patient drives, use a short-lived
   rotating code from their authenticated session.

### 2.3 The four-tab IA

Owner sketched Home / Appointments / Records / Account with full menus. It proved
**convergent with Medanta's production IA nearly field-for-field** — independently
arrived at. Treated as settled; the argument moved to structure.

Six structural changes agreed:

1. **One global switcher**, not two — later refined by §2.4 into switcher-for-viewing plus
   bind-at-checkout.
2. **Scope line drawn**: household-scoped (login, PIN, family profiles, addresses,
   notification prefs, account closure, policies, callbacks, language) vs patient-scoped
   (appointments, booking, activity, records, bills, QR card, inbox). **The profile chip
   appears on patient-scoped screens only** — which is why Account needs no chip: its
   hero *is* the switcher.
3. **Track Requests + Orders → one "Activity"** with Active/Past. Same question at two ages.
4. **Records governed by release rules**, not a raw list (§3 R-08).
5. **Family Profiles split** into *dependent* (full access) and *linked adult*
   (that adult's own OTP consent, revocable, they are told).
6. **"Delete Account" → "Close app account"** and every unbuilt service config-flagged
   rather than stubbed.

Five additions: UHID QR card (offline-capable), Emergency (one tap), Help/call the
hospital, language toggle **before** login, bills & dues.

### 2.4 Medanta teardown — the app

17 screens of `care.medanta.org`. Full inventory in `01-MEDANTA-TEARDOWN.md`. The
findings that changed our design:

- **It is a web app in Chrome, no install.** The thing a poster QR opens can be the entire
  product. Validates the owner's premise directly.
- **Guest browsing.** Entire catalogue, all doctors, all slots, no login. Auth demanded
  only at patient binding. Doctor pages are public, shareable URLs.
- **Patient binding happens at checkout, not as global context — and this beats what we
  proposed.** The header switcher sets *viewing* context; a dedicated "Select Patient"
  sheet after slot choice sets the *transaction subject*. You cannot drift into a
  wrong-profile booking because you never inherit one. **Adopt over the global-inherit
  model.** Disambiguation detail worth copying: age to the day — `51Y-3M-24D, F`.
- **Pay Now / Pay Later is a toggle per line item**, with the summary split
  To Be Paid Now / To Be Paid Later and the CTA changing Confirm & Pay ↔ Book Service(s).
  So **payment-required is a property of the service, not a global rule** — which drops
  cleanly into our tariff layer.
- **The UNPAID card** pinned to Home and Appointments is their recovery mechanism, with
  the framing *"complete payment to avoid hospital billing queue"* — queue-avoidance, not
  compliance. Right register for our nudge.
- **The Appointment Journey** (best idea in the product): a four-step physical itinerary —
  pay/upload → geofenced check-in *"within 500 metres… and skip the queue"* → vitals
  *"Behind The Reception, 11th Floor"* → consultation *"Coordinator Desk No - 3"*.
  Also introduces **pre-consult document upload**, which neither of us had listed.
- **Razorpay**, on a separate subdomain, UPI QR on an 11:49 countdown — and the page body
  behind the modal reads **"Please do not refresh this page…"**. A confession that the
  payment flow is not resumable.

Their nine shipped defects and our twelve advantages are tabulated in the teardown.
The advantages that matter most: wayfinding resolved live from the `resources` registry
(theirs is hardcoded strings), **live queue token position** (we have `nextToken` /
`callsMade`; they show nothing), and the **revisit rule shown before payment** (they show
a flat fee, guaranteeing counter refunds).

### 2.5 Medanta teardown — the printed documents

Three documents: an OPD consult note, a biochemistry report, a two-page MRCP report.
All share one chrome.

**The chrome — worth copying wholesale:**

- **Header, three zones.** *A*: logo + speciality label in red beneath it. *B*: patient
  identity (Name, UHID, Gender, DOB + age, Doctor). *C*: **varies by document type** —
  encounter block (Encounter ID / Type / Visit Date / Location / Speciality) on notes and
  imaging, specimen block (Ordered / Collected / Authorized / Specimen Type / Specimen No)
  on lab. *D*: accreditation mark — NABL logo + `MC-6925` — **on the lab report only**,
  correctly.
- **A centred department band**: "Department of Laboratory Medicine - BIOCHEM",
  "Department of Radiology Medicine - MRI".
- **Footer, identical everywhere**: computer-generated notice · facility address · regd.
  office · **"Password to access via QR code: 31610093"** + a QR · tel/fax/24×7 hotline ·
  **Emergency: 1068** · email · web · CIN · network list · `Printed By THBPP on 28 Aug
  2026 01:55 AM` · `Page 1 of 1`.
- **Per-document access credential.** Every document carries a QR *and* a distinct numeric
  password (31610093 / 85419073 / 68023637). Hand the paper to another doctor and they can
  pull the verified digital original. Excellent, and cheap.
- **Lab specifics:** colour legend "Colors Indicate: Abnormal / Borderline / Normal" with
  underline swatches and a tinted result cell; reference interval printed; methodology
  printed (NABL requires it); dual signature **Authorized by / Performed by**; and a
  results table whose **value column header is the date** — so the same layout serves one
  result and a longitudinal trend.
- **Radiology specifics:** body set in serif italic (reads as dictated); Procedure /
  Findings / Impression / *"please correlate clinically"*; and the **best single feature
  in all three documents** — a delimited audit block:

  ```
  Exam Performed On  : 02/07/2024 19:36 By : ZAIDS   - Zaid Sarwar
  Report Prepared On : 03/07/2024 15:53 By : RANJAN1 - Dr Ranjan Kumar
  Report Authorized On: 03/07/2024 15:53 By Radiologist : RANJAN1 - Dr Ranjan Kumar
  ```

  Three timestamps, three named actors with system usernames, printed where the patient
  and any downstream doctor can read them.

**Their document defects:**

| # | Defect | Consequence |
|---|---|---|
| P1 | **Age computed at print time on the OPD note (51 y) but at encounter time on lab/radiology (49 y).** The handwritten sheet says 48Y. **Three ages, one patient, one episode.** | This is exactly §2.1's failure, live. Different subsystems, different behaviour, no rule. |
| P2 | OPD clinical content is the words **"Refer Attachment"**, and the attachment is a **photograph of a screen showing a handwritten page** | The EMR holds no structured consult data. A flagship chain's OPD record is a phone photo. |
| P3 | The word **`null`** printed twice on the attachment page | |
| P4 | **"Page 1 of 1"** on a two-page document | Pagination counts the structured doc only. |
| P5 | **"Authzorized"** typo in a header label | |
| P6 | Gender renders **"F"** on two documents and **"Female"** on the third | |
| P7 | Radiology page 2 is a near-blank page carrying only a signature and a note | |
| P8 | **"Test results are not valid for medico-legal purposes"** | Legally hollow — a NABL result *is* evidence — and it corrodes patient trust in the number above it. |
| P9 | **"The biological specimen/materials may be used for educational and research purposes"** in footer small print | Not valid DPDP consent. Research use of identifiable specimens needs actual consent. |
| P10 | **"films… maintained for 3 months only. Kindly collect"** buried on page 2 | A retention deadline printed where nobody looks. Should be messaged. |

---

## 3. Rulings held (nothing written to the register yet)

**Identity amendment (§2.1)**

- **R-01** As-of-issue vs current demographics on documents. *Recommend:* as-of-issue,
  with a "current name" annotation on reprints. **Load-bearing — everything follows.**
- **R-02** Who approves a Class I amendment once an artifact exists? *Recommend:*
  registration supervisor / MRD second click, **not** the owner-approval kernel — owner-gating
  pushes staff into creating duplicates.
- **R-03** Evidence mandatory, or reason-only, for a first correction inside 24 h?
  *Recommend:* reason-only inside the typo window, evidence mandatory after.
- **R-04** Former names searchable by whom? *Recommend:* **matched but not shown** —
  search finds on the old name; seeing it needs a permission.
- **R-05** Split administrative gender from clinical sex? *Recommend:* yes — cheap now,
  near-impossible after a year of encounters. Transgender Persons Act 2019 / NALSA give a
  right to change the marker; lab reference ranges, dosing and ward allocation need the
  clinical value. One column cannot serve both.
- **R-06** Move `isConfidential` and `deceasedAt` off `patients.update`? *Recommend:* yes, both.
- **R-07** Proactive notification of an amendment? *Recommend:* no, except statutory MLC
  context and a payer with a claim in flight.

**Patient app (§2.3–2.4)**

- **R-08** Which results reach the phone without a clinician? *Recommend:* routine
  immediate; flagged-abnormal held for clinician release; sealed classes never.
- **R-09** Adult family access default. *Recommend:* consent-required for every adult;
  dependents full access; unlink immediate and, in an abuse case, silent.
- **R-10** What does "delete my account" delete? *Recommend:* app access only; retain the
  clinical record under law; state the reason on the screen.
- **R-11** Recycled phone numbers. *Recommend:* dormancy re-verification; second factor on
  first login from a new device; flag households whose history stops matching.
- **R-12** Which services may be booked pay-later, and by what deadline? *Recommend:* a
  property of the service in the tariff, absolute deadline shown at booking. Consult yes;
  packages and diagnostics no.
- **R-13** Paid no-show — refunded, credited, or forfeited? *Recommend:* credited to the
  next visit within a window.
- **R-14** Which fee binds when the tariff changes mid-flow? *Recommend:* the displayed
  fee, for the life of the hold.
- **R-15** Concurrent slot holds per household? *Recommend:* cap at two.
- **R-16** Show live queue position? *Recommend:* yes — the clearest advantage over
  Medanta, and the data already exists.
- **R-17** Do patient-uploaded documents enter the medical record? *Recommend:* no —
  visible to the treating team, marked patient-supplied, never mistaken for a result.

**Four cannot be retrofitted cheaply and must be settled before code:**
**B6** patient↔household is many-to-many (a married woman appears on both her husband's
and her father's phone; model it one-to-many and you force a duplicate UHID) ·
**D3** does the slot hold outlive the payment attempt ·
**F1/F2** the payment intent must be idempotent and resumable ·
**R-14/C10** which fee binds.

---

## 4. Data model sketch

**Kernel**

- `Actor` gains a fourth type. Blast radius: every permission check, every event actor
  stamp, every module that assumed a logged-in staff member. Small change, large surface —
  plan it first and carefully.
- `patient_identity_versions` — append-only; every issued artifact stores the
  `identity_version_id` current at issue. Former names indexed for search (R-04).
- `patients.identity_assurance` — the four-value ladder (§2.2).
- Document chrome component (§6).

**Patient app (new module)**

- `households` · `household_members` (**many-to-many** to `patients`, link class
  `dependent | adult_consented`, consent record, revocation)
- `patient_sessions` (OTP, PIN, device, dormancy)
- `appointment_holds` — **a third status inside the existing partial unique index**, so a
  hold blocks exactly like a booking and expires alone
- `service_addresses` — household-scoped, typed; **never** the identity address
- `payment_intents` (Plan 22a) — idempotency key, gateway ref, state machine, webhook log
- `doctor_public_profiles` — photo, designation, experience, gender, consult modes, age
  bands, bio; **consented publication**, not a projection of the HR record
- `availability_projection` — invalidated on booking / leave / schedule change

**Extended**

- `opdAppointments.source` += `'self' | 'kiosk'` (the comment already anticipates it)
- `opdDoctors` — the six missing card fields move to `doctor_public_profiles`
- tariff — `payment_required` per service (R-12)

---

## 5. Edge-case register

**158 cases across nine surfaces** live in `01-MEDANTA-TEARDOWN.md` §4, in the house
grammar (theme codes ID/TM/PF/MO/CL/DQ/FR/PV/LA/SC/IN/ST). Summary:

| Surface | Cases | Sharpest |
|---|---|---|
| A Login, OTP, session | 23 | A8 recycled number · A9 changed number strands the account · A23 tout registers dozens on his own number |
| B Household & profiles | 21 | B2 counter-registered patient must be found, not re-minted · B6 many-to-many · B14 sealed records invisible without the absence showing · B16 abuse |
| C Catalogue & search | 16 | C5 doctor leaves with future bookings · C6 patients search by problem, not department · C10 fee changes mid-flow |
| D Slots, holds, concurrency | 20 | D3 hold expires on the payment page · D4 paid after expiry · D6 scalping · D20 the 8–10 a.m. rush |
| E Binding & cart | 14 | E1 wrong family member · E6 deceased · E9 one patient per cart |
| F Payment | 29 | F1 failed-but-debited · F2 lost redirect · F10 double collection at the counter · F20 free revisit charged |
| G Appointment journey | 15 | G1 spoofed geofence · G5 **no path may exist only in the app** · G8 live token · G13 wrong patient's upload |
| H Records, privacy, law | 12 | H1 result release · H6 deletion · H10 MLC |
| I Scale & access | 8 | I1 app down, hospital unaffected · I7 counter path never slower |

**Document-chrome additions (new this session, not yet in the register):**

| # | Scenario | Required behaviour |
|---|---|---|
| DOC-1 | A document is reprinted after the patient's name or DOB was amended | Renders **as-of-encounter** demographics with an amendment annotation (R-01). Medanta's P1 is this failure. |
| DOC-2 | Age on a document | Computed at **encounter date**, one helper, one test. Never at print time. |
| DOC-3 | Gender/sex rendering | One formatter. Never "F" on one document and "Female" on the next. |
| DOC-4 | Pagination | `Page x of y` counts the whole artifact including attachments. |
| DOC-5 | A null or missing field | Renders as an em-dash or is omitted. The string `null` never reaches paper. |
| DOC-6 | A document is handed to an outside doctor | QR + per-document access code resolves the verified digital original. |
| DOC-7 | A result is amended after issue | Reissue marked AMENDED with a reason class (R-018 from the series); original retained (NABL). |
| DOC-8 | Retention deadline (films, specimens) | Messaged on the notification channel, not printed in footer small print. |
| DOC-9 | Research/education use of specimens | Real consent at registration, never footer small print (DPDP). |
| DOC-10 | Medico-legal disclaimers | We do not print "not valid for medico-legal purposes" on an accredited result. If it is issued, it stands. |
| DOC-11 | A confidential patient's document | Alias on every public surface via the `patients` library; statutory registers keep the real name (index §4 theme 7). |
| DOC-12 | Signature block orphaned to its own page | Chrome keeps the authorisation block with its content. |

---

## 5A. Scope decision — full Medanta parity, plus three things they do not do

**Owner, this session: we want everything Medanta offers.** This section is the checklist,
so nothing is dropped by omission later. Nothing below is optional scope; what varies is
only *when* each lands.

### 5A.1 Parity — every capability observed on their surfaces

| # | Capability | Plan |
|---|---|---|
| 1 | Guest browsing of the entire catalogue, no login | 22c-T2 |
| 2 | Mobile + OTP login · **PIN login** · **email / Patient-ID login** · "Need help logging in?" | 22c-T1 |
| 3 | Household profiles, add new profile, switch profile | 22c-T1 |
| 4 | Doctor / speciality search box | 22c-T2 |
| 5 | All specialities list with search | 22c-T2 |
| 6 | Doctor list with **Video Consult toggle · Sort · Filter** (age group, consult mode, availability window, doctor gender) | 22c-T2 |
| 7 | Doctor detail — photo, full qualification string, experience, next-slot chips, **In-Hospital / Video tabs**, date strip **with per-day slot counts**, banded slot grid (Morning / Afternoon / Evening) with counts, About, **Specialization & Expertise** | 22c-T2, T3 |
| 8 | **Select Patient at checkout** with age-to-the-day and UHID | 22c-T4 |
| 9 | Cart — multi-service, **Add More Services** (Health Checks · Lab Test · Consult · Diagnostics), edit slot, remove line | 22c-T4 |
| 10 | **Pay Now / Pay Later toggle per line** + split payment summary | 22c-T4, 22a |
| 11 | Online payment — UPI QR, UPI intent, cards, netbanking, wallets | 22a |
| 12 | **UNPAID / pending-payment card** pinned to Home and Appointments | 22c-T4 |
| 13 | Appointment Details page with **Help** and **Get Directions** | 22c-T5 |
| 14 | **Appointment Journey** stepper — prepare → check-in → vitals → consultation, each naming its room | 22c-T5 |
| 15 | **Geofenced self check-in** ("within N metres… and skip the queue") | 22c-T5 |
| 16 | **Pre-consult document upload** | 22c-T5 |
| 17 | Past appointments | 22c-T2 |
| 18 | **Records** — lab, radiology, OPD notes, others | 22c-T6 |
| 19 | **Book diagnostic services** — X-Ray / MRI / CT / ECHO · Health Check Packages · Lab Tests | after 17 / imaging |
| 20 | **Second Opinion** | later plan |
| 21 | **Medicine Delivery** | 16f |
| 22 | **Homecare Services** (ICU · Nurse · Physio · Vaccination · Equipment · Doctor visit · Diagnostics · Attendant at home) | 24a / 24b |
| 23 | Emergency + call icons, always in the header | 22c-T2 |
| 24 | Account menu — notifications, activity, family profiles, addresses, close account, T&C, privacy, **refund & cancellation policy**, reset PIN, logout | 22c-T1 |
| 25 | **Printed document chrome** — three-zone header, department band, standard footer | kernel-D |
| 26 | **QR + per-document numeric password → verified digital original** | kernel-D |
| 27 | Request a call back | 22 (front office) |

### 5A.2 Three things Medanta does **not** do, and we will

| # | Capability | Why it beats them |
|---|---|---|
| **B1** | **Radiology images in the portal.** Their own report says *"Hospital policy mandates the films records to be maintained for the period of 3 months only. Kindly collect the films before this period."* They hand out **physical film** and destroy it at 90 days. The patient owns their images with us, permanently, on their phone. | The single largest patient-visible differentiator available to us. |
| **B2** | **Live queue position** from `nextToken` / `callsMade`. They geofence a check-in and then tell you nothing. | The one thing a waiting patient actually wants. |
| **B3** | **Wayfinding resolved live** from the `resources` registry, and the **revisit fee rule shown before payment**. Theirs are hardcoded floor strings and a flat fee. | Correct on the day a room moves; no refund at the desk for a free revisit. |

### 5A.3 The document verification portal (capability 26) — first-class, not a footnote

Every issued document carries a **document number, a QR, and a distinct numeric access
code** printed in the footer. Scanning the QR opens a public page; entering the code
returns the **verified digital original**.

Design notes:

- **Public surface, no login** (`@Public()`), because the reader is an outside doctor,
  an insurer, or an employer — not our patient.
- The code is a printed shared secret, which is correct: the paper *is* the credential.
  Rate-limit by code and by IP; a wrong code is an auditable event, exactly as
  `qr.signature_failed` already is.
- Returns the document **as issued** — as-of-encounter demographics, the amendment
  annotation if any, and the authorship block. Never the live record.
- A retrieval is logged with what was retrieved and when. The patient can see who pulled
  their document, and can **revoke a code** if the paper is lost.
- Sealed-class documents (`sensitiveContext`) are **not** retrievable this way.
- Deceased, merged and amended states all resolve correctly through the same chain the
  QR card already follows.

### 5A.4 Images and results in the portal (capability 18 + B1) — the real cost

Lab reports are a rendering problem. **Radiology images are an infrastructure problem**,
and this is the largest new commitment in the whole scope.

| Concern | What it means |
|---|---|
| **PACS** | Bought, never built. The modalities speak DICOM to it; we speak **DICOMweb** (QIDO-RS / WADO-RS / STOW-RS) to the PACS. Our system stores the *reference*, not the pixels. |
| **Volume** | A CT or MRI study is 100–500 MB. At even modest imaging volume this is **terabytes per year** — the biggest storage line item the hospital will have. Feeds directly into the pending 11b hybrid/on-prem storage decision. |
| **Patient delivery** | A 300 MB study cannot be streamed to a phone on 4G. The portal serves **lossy JPEG/derived series** for patient viewing; full-fidelity DICOM stays for clinicians and for download-on-request. Two paths, one study. |
| **Viewer** | Open-source DICOM web viewers exist (OHIF / Cornerstone). Do **not** hand-build a viewer. |
| **Retention** | Their 90-day film policy is a cost decision, not a legal one. Ours is set by the retention schedule (register R-009) and by what the storage budget supports — **an owner decision with a rupee figure attached**, not an engineering default. |
| **Release rules** | R-08 applies to images exactly as to results. An unreported scan must not reach the patient before the radiologist has read it. |
| **Report ≠ image** | The radiologist's report and the image series are separate artifacts with separate release states. A report can be released while images are still being processed. |

**Recommendation:** ship **reports first** (rendering, cheap, immediate) and **images
second**, gated on the PACS choice and the storage decision. Do not let the image
infrastructure hold the reports hostage.

---

## 6. Document chrome — a cross-cutting gap the series missed

**The gap.** `opdConfig.letterhead` is `{ name, addressLines[] }`, consumed ad hoc by
`prescriptions.ts` and `billing.controller.ts`. There is no document number, no
verification code, no shared header/footer, and no rule about which demographics a
document renders. Every module that will ever print — e-Rx, invoice, lab report, imaging
report, certificate, discharge summary, statutory register — currently has to invent it.

The series has two adjacent entries but neither covers this: index §4 theme 17 allocates
*certified statutory prints with hash footers* to Plan 28a, and R-018 covers *amendment
wording*. Everyday clinical document chrome is unowned.

**Proposal — a kernel `documents` component**, built once and consumed by every module:

1. **Chrome renderer** — three-zone header with a **type-varying Zone C**, department
   band, standard footer (facility, regd. office, emergency number, CIN, printed-by,
   page x of y).
2. **Demographic snapshot at issue** — the R-01 rule enforced in one place rather than
   trusted to each caller. This is the single most valuable thing the component does.
3. **Document number + verification code + QR** — Medanta's per-document access credential.
4. **Accreditation slot** — NABL mark on lab output only, driven by the issuing department.
5. **Authorship block** — performed / prepared / authorized, timestamped and named,
   copied from Medanta's radiology block, which is the best pattern in their whole set.
6. **Amendment grammar** — reissue marked AMENDED, original retained.

This is small, kernel-adjacent, and unblocks a lot. **Recommend it lands early** — before
lab (17) and imaging, which are the modules that will otherwise each invent their own.

---

## 7. Plan sketch

Numbering reconciled against `00-INDEX-AND-SYNTHESIS.md` §3. **22 / 22a / 22b are taken**
(front office at scale / payment adapter R-261 / appointment optimiser). The
patient-facing app is not allocated anywhere in the series — proposing **22c**.

| Plan | Scope | Depends on | Notes |
|---|---|---|---|
| **kernel-D** | `documents` chrome component (§6) | — | Small. Recommend before 17. Unblocks every printing module. |
| **kernel-P** | Patient actor type; `identity_assurance`; `patient_identity_versions` | — | The gating change. Every step of 22c is refused until it lands. |
| **22c-T1** | OTP + PIN auth, households (**many-to-many**), profile management, consent model | kernel-P, Plan 10 notifications | R-09, R-11 must be ruled first |
| **22c-T2** | Public catalogue — departments, doctor public profiles, slot browsing, guest mode | 22c-T1 | Needs `doctor_public_profiles` + consented publication |
| **22c-T3** | Availability projection | 22c-T2 | Architecture, not UI. D20. |
| **22c-T4** | Slot holds, Select-Patient binding, cart | 22c-T3 | R-14, R-15. **D3 must be ruled.** |
| **22a** | Payment gateway adapter — intent, idempotency, webhooks + polling, settlement into the T+1 recon, refund reverse-to-source | 22c-T4, Plan 08 | R-261. **The next working session.** |
| **22c-T5** | Appointment journey — status, wayfinding from `resources`, live token position, document upload | 22c-T4, Plan 13 | R-16, R-17 |
| **22c-T6** | Records tab under release rules | 22c-T1, kernel-D | **Blocked on R-08.** Ships with prescriptions + summaries + receipts only until lab/imaging exist |
| **22c-T7** | Document verification portal — public QR + code lookup (§5A.3) | kernel-D | Small, high patient value, no login |
| **22c-T8** | Lab + imaging **reports** in Records | 22c-T6, Plan 17 | Rendering only |
| **22c-T9** | **Radiology images** — DICOMweb reference, derived series, web viewer (§5A.4) | 22c-T8, PACS chosen, 11b storage decision | **B1 — the differentiator.** Largest infra commitment in the scope |
| **22-K** | Kiosk (`device` in the registry) + Pine Labs POS | 22a | Last. Hardware, procurement, paper jams. |

**Sequencing rationale.** kernel-P and 22c-T1→T4 deliver a browsable, bookable public
surface **with no money in it**. Payment is where the real complexity is. The kiosk is
last because a paper jam at 9 a.m. becomes an operational problem, and because 22a must
be proven on the web before hardware depends on it.

**The load-bearing constraint, restated:** self-service reaches perhaps a third of a
2,000/day OPD. **The counter path must not get one second slower to make the app work.**
Success is a shorter queue, not a replaced one — and nothing may exist only in the app.

---

## 8. Open questions

1. **Plan number for 22c** — needs ratification against the index, which the owner has not
   yet ratified in full (§3 of the index is itself pending).
2. **Pine Labs integration mode** — cloud API vs local ECR link, and whether it gives a
   callback. Procurement question, blocks 22-K design.
3. **Which gateway** — Razorpay / PhonePe PG / Cashfree. R-261 leaves it open.
4. **Symptom→department vocabulary** (C6). Nobody owns it. Front office (22) or the app?
5. **Does the app get its own DPIA addendum**, or ride 28d's DPDP programme?
6. Whether `doctor_public_profiles` publication consent needs a signed doctor agreement.
7. **Which PACS**, and on-prem vs hybrid storage — blocks 22c-T9 and carries the largest
   rupee figure in this scope. Ties to the pending 11b decision.
8. **Image retention period** — Medanta destroys film at 90 days. Ours is an owner decision
   with a storage cost attached, bounded below by register R-009.
9. Whether a document access code can be revoked by the patient, or only reissued.

---

## 9. Artifacts

- **Patient App Spine** — four-tab IA, scope line, flows, schema grading
- **Medanta Teardown** — 17 screens, 9 app defects, 12 advantages, 158-case register

Links live in the session; regenerate with `/artifacts` if lost.
