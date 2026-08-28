# Medanta teardown — app, documents, and the edge-case register
**Date:** 2026-08-27 · **Source:** 17 screens of `care.medanta.org` + 3 printed documents, owner-supplied
**Companion:** `00-RECORD-AND-PLAN.md`

Reference material. Medanta is a multi-site chain (Gurugram · Delhi · Lucknow · Patna ·
Indore · Ranchi · Noida); **we are one hospital for ten years** and the whole multi-site
dimension is deleted throughout.

---

## 1. The app — screen inventory

**It is a web app in Chrome. No install.** `care.medanta.org`. The thing a poster QR opens
can be the entire product.

| ID | Screen | What is on it |
|---|---|---|
| S01 | Landing, guest | Vermilion hero; **phone + ambulance icons** = the emergency affordance; "Hello, **Guest**" tappable; card straddling the hero with "Book Doctor Appointment / In-hospital or Video Consultation" + doctor/speciality search; **Book Diagnostic Services** (X-Ray MRI CT ECHO · Health Check Packages · Lab Tests); **Other Services** (Second Opinion · Medicine Delivery · Homecare); nav Home · Appointments · Records · **Login** |
| S02 | Login sheet | Dismissible bottom sheet; "+91" locked; **Get OTP** (disabled until valid) and **Login by PIN**; **"Login with Email or Patient ID"** — the second identity axis, their answer to a changed/recycled number; **"Need Help Logging in?"** human fallback |
| S03 | Home, authed | "Hello, **Mr. Ankit Kumar ⌄**" — switcher in the greeting; 4th nav flips to **Account**; **UNPAID card** (status, for-whom, doctor, site, datetime, thumbnail, Pay Now) with a carousel pill — **multiple pending items stack** |
| S04 | Appointments | Same switcher, second placement; "Upcoming Appointments" → UNPAID card; **"View Past Appointments >"**; "Find Doctors by Location" photo carousel; **"Recent Consultations" — heading with no content and no empty state**; "All Medanta Specialities" |
| S05 | All Specialities | Search + iconed list: Cardiac Care · Cancer Care · Neurosciences · Gastrosciences · Orthopaedics · Renal Care · Liver Transplant · Heart Transplant · Kidney Transplant · Paediatric BMT · BMT · Chest Surgery · Lung Transplant · Gynaecology & GynaeOncology · Paediatric Care … — **service lines and programmes, not departments** |
| S06 | Doctor list | Site picker; speciality chip with X; **Video Consult** checkbox · **Sort** · **Filter**; card = photo, name, *designation – subspecialty*, `Exp: 9+ yrs \| Fee: ₹1500`, "Next Available", 🏥 and 📹 chips, site bar "+3 More". Designations: Consultant · Associate Consultant · Associate Director · Senior Director. **Fee does not track experience** (42 yrs ₹1000, 9 yrs ₹1500, 30 yrs ₹2500) |
| S07–08 | Doctor detail | Circular photo on an orange disc; full qualification string; "Next Slot:" chips; tabs **In-Hospital \| Video**; date strip **with counts** (Today 45 Slots · Tomorrow 39 · 31 Aug'26 46 · Custom Date); per-site accordions with count + fee incl. dead "0 Slots" rows; About; **Specialization and Expertise** list |
| S09–10 | Slot grid | **Morning \| Till 12PM (17 Slots)** · **Afternoon \| 12PM–4PM (23 Slots)**; two scrollable rows at **10-minute grain** (matches our `opdConfig.slotMinutes` default); **only free slots render — 9:30 is simply absent**; selected slot fills solid; sticky CTA **Select Patient** |
| S11 | Select Patient | Radio list, initials avatars: "Mrs. Geeta Devi · ID: BP00199869 · **Self** \| 9999718547" and "Mr. Ankit Kumar · ID: MM00879787 · **Others** \| 9999718547". **Same phone, two patients — the household model confirmed.** Two UHID prefixes on one account. **Add New Profile** + Select & Proceed |
| S12–13 | Cart | Patient block with **age to the day** `51Y-3M-24D, F` + UHID + **Change**; line item with fee, boxed slot/site + edit pencil; **Pay Now / Pay Later toggle per line** + Remove; "Add More Services" (Health Checks · Lab Test · Consult · Diagnostics); summary splits **To Be Paid Now / To Be Paid Later**; CTA flips **Confirm & Pay ↔ Book Service(s)** |
| S14 | Booked | Green check, "Services(s) Booked" *(sic)*; *"Some service(s) **may** require mandatory payment to confirm the appointment"* |
| P01 | Appointment Details | **Help** link in the header; date, mode, doctor, **"Patient - Mrs. Geeta Devi (BP00199869)"**, site, **Get Directions >**; **Payment Pending** banner — *"Next Step: **complete payment to avoid hospital billing queue**"*; **"Your Appointment Journey"**: ① Prepare — Pay Now / **upload reports or documents** ② **Hospital Check-in — "within 500 metres… and skip the queue"** ③ Vitals — *Behind The Reception, 11th Floor* ④ Consultation — *Coordinator Desk No - 3, 11th Floor*; "How To Reach ?" + address |
| P02 | Pending Payment | Patient block with phone + UHID, **age string truncated** "(51Y-3M-25…"; line item; **Bill Summary**; sticky Amount Due + Pay Now. **Currency drifts** — "₹ 1500" in the cart, "Rs. 1500.00" here |
| P03 | Gateway | Different subdomain `medi.medanta.org`; page body behind the modal reads **"Please do not refresh this page…"**; **Razorpay** hosted checkout; **Available Offers** (third-party card cashback); **UPI QR on an 11:49 countdown**; Recommended UPI–Google Pay; *"I agree to **Razorpay's** Privacy Notice"* |

### 1.1 Nine app defects

| # | Defect | Why it matters |
|---|---|---|
| D1 | **"Please do not refresh this page…"** on checkout | The payment flow is not resumable. Our intent must be idempotent and re-enterable. |
| D2 | **"Some service(s) may require mandatory payment"** — after booking, without saying which | The patient cannot tell if the slot is confirmed. The rule is knowable at the toggle. |
| D3 | **No slot hold, no pay-later deadline** (only Razorpay's own 11:49 QR timer) | Unpaid bookings squat indefinitely. Mitigation is nagging. |
| D4 | **Self/Others confusion** — greeting says Ankit, cart calls Geeta "Self" | Viewing context and account ownership conflated. |
| D5 | `&amp;` / `&nbsp;` literal in the doctor bio | Double-escaped CMS rich text. |
| D6 | "₹ 1500" vs "Rs. 1500.00" on adjacent screens | Money formatting per screen instead of one helper over paise. |
| D7 | Age disambiguation string **truncated** | The one field that must never be cut. |
| D8 | "Recent Consultations" heading over nothing | Every list needs a designed zero-state. |
| D9 | Dead "0 Slots Available Today" rows; **"Services(s)"** typo shipped twice | Noise in the highest-attention part of the flow. |

### 1.2 Twelve advantages we hold

| Them | Us |
|---|---|
| Site picker, per-site accordions/fees, location carousel, two UHID prefixes | **One hospital — the dimension is deleted.** Date strip straight to slot grid. One prefix + Verhoeff |
| Hardcoded wayfinding strings ("11th Floor") | **Resolved live from `resources`** via `opdDoctorSchedules.roomId` (Plan 13) |
| Check in, then wait blind | **Live token position** — `nextToken` / `callsMade` already exist |
| Flat fee per doctor | **The revisit rule shown before payment** — Plan 08 already branches new/renewal |
| "Do not refresh" | **Resumable intent** with an idempotency key |
| Unpaid booking, indefinite | **Held slot with a stated deadline** inside the existing partial unique index |
| Self / Others | **Dependent vs consented adult** — `patientGuardians` already models it |
| No confidential class | **`isConfidential` + `alias`**, already aliasing on QR scan |
| Grid hides taken slots | **Show taken slots disabled** — the truth about how busy the doctor is |
| Razorpay's offers and privacy notice in checkout | **Our checkout, our notice** |
| Counter cannot see an online payment | **One ledger, both channels** — Plan 08 sessions/close already exist |
| No language affordance | **Hindi/English before login** — `patients.language` already drives messages |

---

## 2. The printed documents

Three documents (OPD consult note · biochemistry report · two-page MRCP), one shared chrome.

### 2.1 The chrome — copy this

- **Header, three zones + accreditation.** *A*: logo + **speciality label in red** beneath.
  *B*: patient identity — Name, UHID, Gender, DOB + age, Doctor. *C*: **varies by document
  type** — encounter block (Encounter ID / Type / Visit-Admn Date / Location / Speciality)
  on notes and imaging; **specimen block** (Ordered / Collected / Authorized / Specimen
  Type / Specimen No) on lab. *D*: **NABL mark + `MC-6925` on the lab report only** — correct.
- **Centred department band**: "Department of Laboratory Medicine - BIOCHEM" ·
  "Department of Radiology Medicine - MRI".
- **Footer, identical everywhere**: "This is a computer generated report. Signature is not
  required" · facility address · Regd. Office · **"Password to access via QR code:
  31610093"** + QR · Tel / Fax / 24×7 hot-line / **Emergency: 1068** · email · web · CIN ·
  network list · `Printed By THBPP on 28 Aug 2026 01:55 AM` · `Page 1 of 1`.
- **Per-document access credential** — QR + a distinct numeric password per document
  (31610093 / 85419073 / 68023637). Hand the paper to an outside doctor; they pull the
  verified digital original. Cheap and excellent.
- **Lab** — colour legend *"Colors Indicate: Abnormal / Borderline / Normal"* with underline
  swatches and a tinted result cell; **reference interval** printed; **methodology** printed
  (NABL requires it); **dual signature Authorized by / Performed by**; five "Please Note"
  items; and a results table whose **value column header is the date**, so one layout serves
  a single result and a longitudinal trend.
- **Radiology** — body in serif italic (reads as dictated); Procedure / Findings /
  Impression / *"please correlate clinically"*; and the **best feature in all three
  documents**, a delimited audit block:

  ```
  Exam Performed On   : 02/07/2024 19:36 By : ZAIDS   - Zaid Sarwar
  Report Prepared On  : 03/07/2024 15:53 By : RANJAN1 - Dr Ranjan Kumar
  Report Authorized On: 03/07/2024 15:53 By Radiologist : RANJAN1 - Dr Ranjan Kumar
  ```

### 2.2 Ten document defects

| # | Defect | Consequence |
|---|---|---|
| P1 | **Age at print time on the OPD note (51 y), at encounter time on lab/radiology (49 y); the handwritten sheet says 48Y** | **Three ages, one patient, one episode.** Exactly the live-vs-snapshot failure our identity work predicts. |
| P2 | OPD clinical content is **"Refer Attachment"** → a **photograph of a screen showing a handwritten page** | The EMR holds no structured consult data at all. |
| P3 | **`null`** printed twice on the attachment page | |
| P4 | **"Page 1 of 1"** on a two-page document | Pagination ignores the attachment. |
| P5 | **"Authzorized"** typo in a header label | |
| P6 | Gender "F" on two documents, "Female" on the third | |
| P7 | Radiology page 2 nearly blank — signature + one note | Orphaned authorisation block. |
| P8 | **"Test results are not valid for medico-legal purposes"** | Legally hollow — a NABL result *is* evidence — and it corrodes trust in the number above it. |
| P9 | **"biological specimen/materials may be used for educational and research purposes"** in footer small print | Not valid DPDP consent. |
| P10 | **"films… maintained for 3 months only"** buried on page 2 | A retention deadline where nobody looks. |

---

## 3. Edge-case register — 158 cases

House grammar. Themes: **ID** identity · **TM** timing/concurrency · **PF** partial
failure · **MO** money · **CL** consent/legal · **DQ** data quality · **FR** fraud ·
**PV** privacy/VIP · **LA** language/access · **SC** scale · **IN** integration · **ST** staff/ops.
**Bold** rows lose money, break identity, or harm someone.

### A · Login, OTP, session (23)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| A1 | Mistyped digit; OTP reaches a stranger | Never reveal whether a number is registered | PV |
| **A2** | **OTP bombing as harassment** | Per-number cooldown, per-device and per-day caps; SMS cost is a rate-limit input | FR |
| A3 | OTP undelivered (DND, operator, no signal) | Fallback channel + the human "Need help logging in?" path | PF |
| A4 | Resend produces two live OTPs; the first is entered | Reissue invalidates the predecessor | TM |
| A5 | OTP arrives after expiry | Explicit "expired" — never a generic wrong-code error | TM |
| A6 | OTP entered on a different device | Allowed; an SMS secret is not device-bound | ID |
| A7 | Android SMS autofill | App hash + stable format, or every login is a retype | LA |
| **A8** | **Number recycled after 90 days; a stranger inherits a family's records** | Dormancy re-verification; second factor on first login from a new device; flag a household whose history stops matching | PV |
| **A9** | **Patient changes number and is locked out** | A second identity axis (email / Patient ID). Without it they re-register and mint a duplicate | ID |
| A10 | Number ported | No effect | IN |
| A11 | Patient has no phone (designed path D-34) | Counter route stays complete | LA |
| A12 | Son on his father's number wants to split | Counter-verified detach; records never move | ID |
| A13 | PIN brute force (10,000 values) | Own throttle keyspace, per the `switch/pin` precedent | FR |
| A14 | PIN reset runs through OTP | State honestly that PIN is convenience, not a second factor against a handset holder | PV |
| A15 | Session expires mid-booking with a hold | Hold survives; reclaimed on re-login | TM |
| A16 | Public / shared device | Short idle timeout, explicit "public device", hard clear | PV |
| A17 | Two concurrent sessions | Allowed; a hold in one is visible in the other | TM |
| A18 | Guest picks a slot then logs in | Selection survives auth; returns to the exact step | DQ |
| A19 | Login sheet dismissed mid-flow | Return to the previous screen, state intact | DQ |
| A20 | Doctor link shared on WhatsApp, opened by a stranger | Works logged-out; leaks nothing about the sharer | PV |
| A21 | Logout with an unpaid booking | Booking and deadline survive; reminders continue | MO |
| A22 | Bot floods registration | Rate limits; self-registered records stamped lower-assurance | FR |
| **A23** | **A tout registers dozens of patients on his own number** | Cap per household; flag implausible households (no shared surname/address/age structure) — otherwise dedup key and message channel are poisoned for all of them | FR |

### B · Household and profiles (21)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| B1 | New number, no profiles | "Add profile" is the primary action | DQ |
| **B2** | **A counter-registered patient logs in from the same number** | Must find the existing UHID. Minting a second here is the worst outcome in the app | ID |
| B3 | Existing patient whose record carries a relative's number | Cannot self-link; route to Patient-ID login or a counter, and say so | ID |
| B4 | Two profiles named Ramesh Kumar | Age-to-day + UHID on every row. Never name alone | ID |
| **B5** | **Add-new-profile duplicates a patient in the master** | Dedup runs on self-service adds — the one channel where it can be enforced, not nudged | ID |
| **B6** | **A woman appears on her husband's and her father's phone** | **Patient↔household is many-to-many.** One-to-many forces a duplicate. Decide before code | ID |
| B7 | Profile removed | Unlink only; never deletes a patient | CL |
| **B8** | **An adult is added without their knowledge** | Adult links need that adult's OTP consent, revocable, and they are told | PV |
| B9 | A dependent turns 18 | Falls out of the guardian's view that day (`MAJORITY_AGE_YEARS`) | CL |
| B10 | A 15-year-old self-registers | Age gate to the counter (DPDP §9) | CL |
| B11 | Adult under legal guardianship (dementia, disability) | Not the majority rule; documented counter-verified override with an authority scope | CL |
| **B12** | **A deceased patient in the family list** | `deceasedAt` beats urgency: unbookable, no messages. But family may need records — not simply erased | CL |
| B13 | Confidential patient (staff, VIP) in a household | Real name to the household, `alias` on hospital surfaces | PV |
| **B14** | **A `sensitiveContext` patient's records in a family view** | Excluded entirely, and the exclusion invisible. "3 records hidden" is the disclosure the seal prevents | PV |
| B15 | Divorce / estrangement | Unlink effective on the next request, not the next login | PV |
| **B16** | **Domestic abuse — the abuser holds the phone** | Counter unlink, silent. No notification, no trace | PV |
| B17 | Profile whose patient was merged | Follow the chain; one row, canonical UHID | DQ |
| B18 | UHID re-minted; old in `legacy_uhid` | Old identifier still resolves in login and search | ID |
| B19 | A genuine joint family of 15 | Cap must not punish them; raise at a counter | DQ |
| B20 | Profile switched mid-flow | Nothing inherits it for a transaction — binding is at checkout | DQ |
| B21 | A self-registered profile never seen by staff | `self_declared`; freely self-correctable until the first clinical artifact | ID |

### C · Catalogue and search (16)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| C1 | Department with no active doctors | Hidden, not an empty result | DQ |
| C2 | Doctor active, no schedule | Excluded, or explicit "not booking online" | DQ |
| C3 | Doctor on leave across the window | "Next available 12 Sep", never a blank card | TM |
| C4 | Doctor goes inactive between browse and booking | `doctor_inactive` → clear message + re-render | TM |
| **C5** | **Doctor leaves with future appointments** | All move to `needs_rebooking` with a proactive message; if paid, automatic refund or rebooking offer | MO |
| **C6** | **Patients search by problem, not department** | A symptom/speciality vocabulary mapping to `opdDepartments`. Medanta mixes programmes and service lines for exactly this reason | LA |
| C7 | Misspelled/transliterated doctor name | Phonetic + fuzzy across scripts | LA |
| C8 | Result found but not bookable online | Shown, disabled, with the reason | DQ |
| C9 | Zero results | Offer a callback, not a dead end | LA |
| **C10** | **Fee changes between browse and checkout** | **Ruling.** Recommend: displayed fee binds for the life of the hold | MO |
| C11 | Doctor photo missing | Initials placeholder, never a broken image | DQ |
| C12 | Rich text / pasted HTML in a bio | Escaped once, tested (Medanta D5) | DQ |
| C13 | Very long name or qualification string | Truncation that never clips an identifier or fee | LA |
| C14 | Publishing photo, gender, biography | Consented published profile, never the HR record | CL |
| C15 | NMC registration number on the public profile | Shown — a trust signal, already on the e-Rx | CL |
| C16 | Catalogue indexed and shared | Public, cacheable, zero patient context | PV |

### D · Slots, holds, concurrency (20)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| D1 | Five minutes of deliberation; slot gone | `slot_taken`, clear message, fresh grid. Never substitute an adjacent slot | TM |
| D2 | Simultaneous confirm on one slot | The partial unique index is the sole arbiter — already correct | TM |
| **D3** | **Hold expires while the patient is on the payment page** | The sharpest case. The hold outlives the attempt, or the payment auto-refunds on landing | TM |
| **D4** | **Hold expired, payment succeeded — the gateway raced us** | Honour and flag the doctor's list. Refusing a paid patient at the counter is the worst outcome | MO |
| D5 | One household holds five doctors' slots | Cap concurrent holds | FR |
| **D6** | **A script holds a department's whole day** | Rate limits per household and device; payment-first for high value | FR |
| D7 | Slot in the past at confirm | `slot_in_past` | TM |
| **D8** | **Doctor declares leave after a paid booking** | `needs_rebooking` plus automatic rebooking offer or refund, within minutes | MO |
| D9 | That leave is cancelled; code restores `booked` | Tell the patient — a silent restore is worse than the cancellation | TM |
| D10 | Schedule template changes on a booked day | Bookings survive or convert; never silently orphaned | TM |
| D11 | Consulting room changes | Wayfinding re-resolves from `roomId` → `resources` | ST |
| D12 | NRI booking abroad; skewed device clock | Everything renders and stores IST, always labelled | DQ |
| D13 | Slot straddles a band boundary | Membership by start time, stated once | DQ |
| D14 | Availability counts stale by seconds | Display-only; correctness always from the insert | SC |
| D15 | Overlapping slots, different doctors | Warn, allow — split visits are legitimate | DQ |
| D16 | Same doctor twice in a day | Block, link to the existing appointment | DQ |
| D17 | Booking six months out | Stated horizon cap; beyond it, a callback | DQ |
| D18 | Slot starting in nine minutes | A cutoff rule — the desk cannot absorb a surprise | ST |
| D19 | Patient wants a hidden (taken) slot | Render taken slots disabled | LA |
| **D20** | **The 8–10 a.m. rush at 2,000 OPD/day** | A projection invalidated on booking/leave/schedule change — never a per-request fan-out | SC |

### E · Binding and cart (14)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| **E1** | **Wrong family member bound to a booking** | Binding is a dedicated step after slot choice, never inherited. Name, age-to-day, sex, UHID on the row and again in the cart | ID |
| E2 | No profile selected | CTA disabled with the reason visible | LA |
| E3 | Patient changed via "Change" after the fee was computed | Recompute — revisit branch, age band and membership differ within one family | MO |
| E4 | Adult bound to a paediatrician | Blocked at binding, not at the counter | DQ |
| E5 | Male patient bound to a gynaecology slot | Warn, do not hard-block | DQ |
| **E6** | **Bound patient is deceased** | Hard block | CL |
| E7 | Bound patient was merged | `resolvePatientId`; cart shows canonical UHID | DQ |
| E8 | "Add New Profile" mid-checkout | Dedup still runs — exactly when it is most likely clicked past | ID |
| E9 | Cart mixing two patients | **Recommend one patient per cart** | ID |
| E10 | A line becomes unavailable while the cart sits | Flagged, priced out, total recomputed before payment | TM |
| E11 | Cart abandoned with holds | Holds expire on TTL | TM |
| E12 | Last line removed | Designed empty state routing back to booking | LA |
| E13 | "Add More Services" offers an unbuilt line | Config-driven; unbuilt does not render | DQ |
| E14 | Total computed client-side | Never. Server recomputes every total and rule | FR |

### F · Payment (29) — the next working session

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| **F1** | **Failed but debited** | The largest support burden in Indian payments. A state that survives it, holds the slot, reconciles against settlement | MO |
| **F2** | **Success redirect lost — tab closed, battery died** | Idempotent resumable intent. Reopening reads true state. This is what "do not refresh" concedes | PF |
| **F3** | **Patient pays twice** | One idempotency key per intent; the second returns the first result | MO |
| F4 | Webhook before or long after the redirect | Both orderings converge; neither is the sole truth | IN |
| F5 | Webhook never arrives | Reconciliation sweep against the settlement file | IN |
| F6 | Webhooks replayed or out of order | Idempotent on the gateway's event id | IN |
| F7 | Forged webhook | Signature verified first; failure is an auditable security event | FR |
| F8 | Partial amount paid | Amount locked server-side; underpayment cannot confirm | MO |
| **F9** | **Paid, but the booking lost the race** | Automatic immediate refund, truthful message, next slot offered in the same breath | MO |
| **F10** | **Paid online, then again at the counter** | Online payment visible at the counter instantly | MO |
| **F11** | **Online receipts in a cashier's drawer variance** | They must not. Plan 08 sessions/close already exist; online reconciles separately | MO |
| F12 | Refund — hospital cancel, patient cancel, doctor leave, duplicate, overcharge | Each its own policy and approver (index §4 theme 18: policy JSON, auto below threshold for hospital-fault, approval above, bank above ₹10k) | MO |
| F13 | Refund on an online booking paid in cash | Refund follows the tender taken, not the channel that booked | MO |
| **F14** | **A son pays from his phone for his mother** | Payer ≠ patient ≠ account holder; Plan 08's refund-to-payer identity must know which is which | ID |
| F15 | Gateway down | Degraded mode: pay-later open, truth stated, booking never lost (Plan 08 precedent) | PF |
| F16 | Gateway session expires (their 11:49 QR) | Clean expiry back into our intent; retry without re-entering booking | TM |
| F17 | Gateway fees | `feeBps` exists; who bears it is stated policy | MO |
| F18 | Cash-law thresholds | Online is non-cash, already excluded from the C-2 episode in SQL. Nothing to change, everything to test | CL |
| F19 | GST supply context | `standalone` vs `composite_healthcare` correct on a self-service invoice | CL |
| **F20** | **A free-revisit patient charged online** | The revisit branch resolves **before** money is requested | MO |
| F21 | Membership or package covers the consult | Zero-rupee checkout still producing booking, invoice, allocation | MO |
| F22 | Insured / TPA patient books online | Self-pay-then-claim or pay-later to the TPA desk, stated at booking | MO |
| F23 | Amount tampered client-side | Server recomputes; mismatch voids and logs as an attack | FR |
| F24 | Money as floats | Paise integers, `assertPaise` at every boundary, one formatter | DQ |
| F25 | Third-party promo banners in checkout | A hospital taking a consult fee does not hand over a bank's cashback or a third party's privacy notice | CL |
| F26 | Chargeback weeks later | A reachable state for appointment and invoice; clinical record untouched | MO |
| **F27** | **Pay-later with no stated deadline** | A date and time at booking, and the consequence named | MO |
| F28 | Which services may be paid later | A tariff property evaluated at the toggle — control disabled with a reason, not warned about after | MO |
| F29 | `fee_unsettled` fires at the desk for an online booking | Must reflect the online payment instantly, or a paid patient is stopped at the door | MO |

### G · The appointment journey (15)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| **G1** | **Geofenced check-in spoofed from home** | Skip logic (`maxSkipsBeforeLeft`) is the backstop; check-in is not the only evidence of presence | FR |
| G2 | Check-in before the session starts | Held until off `not_started`, reason shown | TM |
| G3 | Check-in on a `needs_rebooking` appointment | Refused, rebooking offered | TM |
| G4 | Checks in then leaves | Skip counter, exactly as for a desk check-in | ST |
| **G5** | **Patient arrives having never opened the app** | The desk checks them in as always. **No path may exist only in the app** — the load-bearing rule of the product | ST |
| G6 | Phone dead or lost on arrival | UHID and name suffice; the QR is convenience, never a credential | PF |
| G7 | Doctor ninety minutes late | Say so before the patient leaves home. Medanta does not | ST |
| **G8** | **Patient wants to know the wait** | Show token position — `nextToken` / `callsMade` exist. Our clearest advantage | ST |
| G9 | Room moved after the journey rendered | Re-resolved on every view, never a stored string | ST |
| G10 | Reschedule | Fee/refund/hold consequences stated first; old slot released atomically with the new taken | MO |
| G11 | Cancel | A window and a refund rule — why "Refund and Cancellation Policy" is its own menu item | MO |
| G12 | Paid no-show | **Ruling.** `appointmentNoShow` exists; the money policy does not | MO |
| **G13** | **Wrong patient's report uploaded pre-consult** | PHI on arrival: bound to the patient, treating team only, scanned, capped, removable before the consult | PV |
| G14 | Unreadable or irrelevant upload | Provenance obvious — patient-uploaded is not a hospital record | DQ |
| G15 | First-time visitor wayfinding | Name the desk and the floor. The one Medanta idea to copy wholesale | LA |

### H · Records, privacy, law (12)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| **H1** | **A malignancy or reactive HIV result reaches the phone at 11 p.m.** | **Ruling.** Routine immediate; flagged-abnormal held for clinician release; sealed classes never | CL |
| H2 | Report ready, bill unpaid | Withholding a critical result over money is indefensible. Separate the dues nudge from release | CL |
| H3 | Minor's report visible to a guardian; minor turns 18 | Access ends that day, no gap, no announcement | CL |
| H4 | Report forwarded to a family group | Not preventable. Watermark with the recipient; audit every download | PV |
| H5 | Records on a merged loser record | Follow the chain; one continuous history | DQ |
| **H6** | **"Delete my account"** | Close app access; retain under law; state the reason; never orphan the linked family | CL |
| H7 | DPDP access request | Machine-readable export scoped by `authorityDsr` where a guardian asks | CL |
| H8 | Privacy notice changes | Versioned, re-consent on material change | CL |
| H9 | Promotional consent | Opt-in, never pre-checked, revocable. `promotionalOptIn` already defaults false | CL |
| **H10** | **An MLC patient uses the app** | The injury report stays in MRD custody. The app never amends, hides, or discloses it | CL |
| H11 | Court or police request | The legal-disclosure log — authority, section, release, approver. Never a clerk, never the app | CL |
| H12 | A curious employee views a confidential patient | Access-vs-care-relationship reporting; the app's reads join the same audit | PV |

### I · Scale, degradation, access (8)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| **I1** | **The app is down on a Monday morning** | The hospital runs unchanged. Nothing in the counter path depends on it | PF |
| I2 | 2G in a basement | Page-weight budget; the QR card renders from cache with no network | SC |
| I3 | Low-end Android, small screen | The target device, not the fallback. Test there first | LA |
| I4 | Elderly patient without reading glasses | Type scale, contrast, tap targets — or self-service only serves people who did not need it | LA |
| I5 | Hindi-first patient | Language on the first screen, before login; carried into `patients.language` | LA |
| I6 | Screen reader | Labelled controls, focus order, a slot grid navigable without sight | LA |
| I7 | Self-service reaches perhaps a third of 2,000/day | The counter path must not get one second slower. A shorter queue, not a replaced one | SC |
| I8 | Self-booked volume distorts the doctor's day | `source` gains `'self'` and `'kiosk'` — the field every KPI and fraud rule keys off | ST |

### J · Document chrome (12, new)

| # | Scenario | Required behaviour | T |
|---|---|---|---|
| **J1** | **A document is reprinted after the name or DOB was amended** | **As-of-encounter demographics** with an amendment annotation. Medanta's P1 is this failure, live | DQ |
| J2 | Age on any document | Computed at encounter date, one helper, one test. Never at print time | DQ |
| J3 | Gender/sex rendering | One formatter. Never "F" here and "Female" there | DQ |
| J4 | Pagination | `Page x of y` counts the whole artifact including attachments | DQ |
| J5 | A null or missing field | Em-dash or omitted. The string `null` never reaches paper | DQ |
| J6 | Paper handed to an outside doctor | QR + per-document access code resolves the verified digital original | IN |
| J7 | A result amended after issue | Reissue marked AMENDED with a reason class (R-018); original retained (NABL) | CL |
| J8 | Retention deadline (films, specimens) | Messaged on the notification channel, not printed in footer small print | CL |
| J9 | Research/education use of specimens | Real consent at registration, never footer small print (DPDP) | CL |
| J10 | Medico-legal disclaimers | We do not print "not valid for medico-legal purposes" on an accredited result. If issued, it stands | CL |
| J11 | A confidential patient's document | Alias via the `patients` library; statutory registers keep the real name | PV |
| J12 | Signature block orphaned to its own page | Chrome keeps the authorisation block with its content | DQ |
