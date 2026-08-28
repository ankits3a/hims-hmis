# The patient journey, segmented — channel handoffs and the edge cases in between
**Date:** 2026-08-28 · **Status:** working document, not approved
**Companions:** `00-RECORD-AND-PLAN.md` · `01-MEDANTA-TEARDOWN.md` · `02-PLAN-22A-PAYMENTS.md`

---

## 1. The mistake this document exists to prevent

It is tempting to build "the self-service flow" and "the counter flow" as two systems that
happen to share a database. **Almost no real patient completes a journey in one channel.**

> Kavita self-registers on her phone at home, browses doctors on the bus, holds a slot,
> loses signal, walks to counter 4 and pays cash, checks in at a kiosk, is called by a
> token on a display, and collects a printed report she later hands to a doctor in another
> city who scans its QR.

Six channels, one journey. Every seam in that sentence is where the bugs live.

### 1.1 The design law

> **Every segment must be completable in any channel, and the patient may switch channel
> between any two segments.**

Three corollaries, and they are not negotiable:

1. **No segment may leave state reachable only by the channel that created it.** A hold
   taken on a phone must be convertible by a cashier. A cart built at a counter must be
   payable from a phone.
2. **Every segment's exit state must be findable by phone number, UHID, or QR** — the
   three things a patient can present at a desk.
3. **The app is never the system of record for anything.** It is one channel onto the same
   state, and it must be possible to switch it off entirely without stopping the hospital
   (`01-MEDANTA-TEARDOWN.md` I1, G5).

### 1.2 Channels

| Code | Channel | Notes |
|---|---|---|
| `SELF` | Patient's own phone or browser | Web, no install |
| `KIOSK` | In-hospital kiosk (`device` in the registry) + Pine Labs POS | Unattended but physical |
| `CNTR` | A staffed counter | The fallback for everything, always |
| `CALL` | Call centre / front office phone | Plan 22 |
| `PROXY` | A relative or attendant acting for the patient | Overlays any of the above |

### 1.3 The segments

| # | Segment | Owns | Plan |
|---|---|---|---|
| **S1** | Identity & household | Getting a UHID; joining a household | 22c-T1, kernel-P |
| **S2** | Discovery | Finding a department, doctor, slot or service | 22c-T2/T3 |
| **S3** | Commitment | The hold, the patient binding, the cart | 22c-T4 |
| **S4** | Settlement | Money, in any channel or none | 22a |
| **S5** | Arrival & check-in | Getting there, proving presence | 22c-T5 |
| **S6** | Queue & call | Token, wait, being seen | Plan 07 + 22c-T5 |
| **S7** | Encounter | The consult itself | Plan 07 (shipped) |
| **S8** | Orders & fulfilment | Labs, imaging, pharmacy arising | 17, 16f, imaging |
| **S9** | Documents & results | What the patient leaves with and receives | kernel-D, 22c-T7/T8/T9 |
| **S10** | Aftercare | Follow-up, recall, revisit | 27 |

### 1.4 Handoff contracts — what each segment must leave behind

This table is the actual architecture. Everything else is detail.

| Segment | Exit artifact | Findable by | Must be legible to |
|---|---|---|---|
| S1 | A patient row + assurance stamp; optional household link | phone · UHID · QR · name+DOB | every channel, forever |
| S2 | Nothing durable — discovery is stateless | — | — |
| S3 | A **hold** + a **cart** bound to one patient | phone · UHID · QR · cart id | counter, kiosk, call centre |
| S4 | A **receipt** (or a pay-later booking with a deadline) | receipt no · UHID · booking no | counter **instantly** — this is where double collection happens |
| S5 | A **check-in** on the encounter | UHID · QR · token | queue engine, desk |
| S6 | A **token** and its position | token · UHID | display, desk, app |
| S7 | An **encounter** with orders and a prescription | visit no · UHID | pharmacy, lab, imaging, MRD |
| S8 | **Orders**, each with its own payment and fulfilment state | order no · UHID | every fulfilling department |
| S9 | **Documents**, each with a number, a QR and an access code | doc no · code · UHID | outside doctors, insurers, the patient |
| S10 | A **follow-up window** and any recall tasks | UHID | app, call centre |

### 1.5 Degradation — the same question at every segment

For each segment, ask four questions. Until Plan 30, all degradation is hospital-scoped.

1. **App down** → the counter does it. Always. No exceptions.
2. **Network down at the hospital** → the downtime kit (Plan 30), paper, reserved serials,
   later backfill with `late_entry.flagged` and `occurred_at ≠ recorded_at`.
3. **Counter system down, app up** → the app keeps serving reads; writes queue or refuse
   honestly. Never a silent success.
4. **Power out** → paper, and the reconciliation afterwards is the real work.

---

## 2. S1 · Identity & household

| | |
|---|---|
| **Channels** | `SELF` `KIOSK` `CNTR` `CALL`(partial) `PROXY` |
| **Entry** | A person needs a UHID, or needs to be found |
| **Exit** | A patient row, an assurance stamp, optionally a household link |
| **Abandonment** | **No patient row until complete.** A draft keyed to the verified phone, 24 h expiry, resumable in any channel |
| **Degraded** | Counter mints on paper with a reserved serial; backfilled later |

| # | Scenario | Required behaviour |
|---|---|---|
| S1-01 | Self-registration abandoned at step 3 of 5 | No patient row. A resumable draft on the verified phone — a half-patient in the master is worse than no patient |
| S1-02 | Abandoned, then the patient walks to a counter | The clerk finds the **draft** by phone and completes it. Never starts over, never creates a second |
| S1-03 | Self-registered patient reaches a counter | Clerk sees `self_declared`, sights ID, upgrades to `id_verified`. The patient does not re-tell everything |
| S1-04 | A counter-registered patient tries to self-register | Phone match finds the existing UHID and offers it. **Minting a second here is the worst outcome in the product** |
| S1-05 | Counter-registered under a relative's phone; patient now has their own | Cannot self-link. Route to Patient-ID login or a counter, and say why |
| S1-06 | Kiosk printer fails after the record is created | The UHID exists. Show it on screen, SMS it, and make it findable at any counter by phone. Never a patient with a record they cannot prove |
| S1-07 | Patient and relative register the same person at two kiosks at once | Dedup at insert, not on the nightly sweep |
| S1-08 | Patient registers at a kiosk, then again at a counter | The clerk's screen surfaces the seconds-old record before the second is written |
| S1-09 | A relative registers from home and guesses the DOB | `self_declared`; the typo window makes it free to fix until the first artifact |
| S1-10 | Name entered in Devanagari | A transliteration field alongside is mandatory — the label printer and the counter screen must both render something |
| S1-11 | Illiterate patient at a kiosk | Fail gracefully and specifically: "please go to counter 4". Never strand them mid-flow |
| S1-12 | Patient has no phone (designed path D-34) | Counter mints a UHID with no phone. The app is simply unavailable to them, and **nothing may require it** |
| S1-13 | A 15-year-old self-registers | Age gate → counter. The counter should see the attempt as a flagged draft, not a mystery |
| S1-14 | Unconscious or unknown patient | Staff-only. Later identification is identity *assignment*, not amendment, and the trauma record stays attached |
| S1-15 | Two spouses self-register independently from one phone | They land in **one** household, not two |
| S1-16 | A patient belongs to two households and changes address | Service address is household-scoped; the identity address is patient-scoped. They are different fields |
| S1-17 | A household member dies | `deceasedAt` — unbookable, unmessageable. But the family may still need the records, so the profile is not simply erased |
| S1-18 | Registration during an outage; the patient also self-registered | Paper form + backfill collides with a live self-registration → a duplicate the reconciliation must catch |
| S1-19 | An ABHA-verified patient self-registers | ABDM demographics are authoritative; verified fields are locally read-only or they silently desync |
| S1-20 | The UHID SMS never arrives | The UHID is on screen and in the app. SMS is a convenience, never the only delivery |
| S1-21 | A staff member self-registers as a patient | They need `isConfidential`, which is not settable from a public surface → **they land in the wrong privacy class and are visible to colleagues.** Needs a self-declared confidential request routed to a counter |
| S1-22 | Patient self-registers while standing at the counter to skip the queue | Legitimate and smart. The clerk sees it appear live |
| S1-23 | A tout's number already carries 30 patients | Household cap and the implausibility flag fire before the 31st |
| S1-24 | Patient wants their name in the app to differ from the record (nickname) | No. One name, amended properly. A display alias is a privacy feature, not a preference |

---

## 3. S2 · Discovery

| | |
|---|---|
| **Channels** | `SELF` `KIOSK` `CNTR` `CALL` — **public, no login** |
| **Entry** | None |
| **Exit** | Stateless — a chosen doctor and date carried into S3 |
| **Abandonment** | Free. Nothing to clean up |
| **Degraded** | The counter reads the same availability from the same source |

| # | Scenario | Required behaviour |
|---|---|---|
| S2-01 | "Today 45 slots" on the app; 3 left when the patient arrives 40 minutes later | Counts are **display-only, never a promise**. The code already says so; the copy must too |
| S2-02 | Patient browses on the phone, then asks a counter | The counter sees the same availability from the same projection. Two answers is a trust failure |
| S2-03 | A call-centre agent books on behalf | Same catalogue, same rules, same fee. No agent-only pricing |
| S2-04 | Patient searches "chest pain", not "Cardiology" | A symptom→department vocabulary. The clerk does this in their head today; the app cannot |
| S2-05 | Fee in the app differs from the counter's quote | One tariff resolver for both, or trust is gone on the first visit |
| S2-06 | A doctor bookable at the counter but not online | Must never differ. **One availability truth** |
| S2-07 | A doctor who does no OPD appears in the list | Filter by schedule existence, not by `active` |
| S2-08 | "The same doctor as last time" | Prior-encounter lookup, offered prominently — it is the most common request at any desk |
| S2-09 | The patient was referred by an outside doctor | No referral object exists yet. They will type a name into a note; plan for it |
| S2-10 | Department names in Hindi and English | Search matches both, and so does the transliteration |
| S2-11 | The doctor declares leave while the patient is browsing | Stale list, clean failure at booking, and the reason shown |
| S2-12 | An emergency case is browsing OPD slots | **"If this is an emergency, come now"** must precede any booking flow, always visible |
| S2-13 | Search for a doctor who has left | Shown as unavailable with a named alternative — not silently absent |
| S2-14 | Next availability is three weeks out | Say so, and offer the department's earliest instead |
| S2-15 | Patient wants a female doctor | The gender filter, sourced from a consented published profile, never the HR record |
| S2-16 | A paediatric patient sees adult-only doctors | The age band filters **before** selection, not at binding |
| S2-17 | A doctor's public profile has no photo or bio yet | The card is still complete enough to book from |
| S2-18 | A doctor link is shared on WhatsApp and opened by a stranger | Works logged-out; leaks nothing about the sharer |
| S2-19 | Browsing at 2 a.m. for a slot today | The same-day cutoff rule is visible before they choose, not after |
| S2-20 | Zero results | A callback request, never a dead end |

---

## 4. S3 · Commitment — hold, bind, cart

| | |
|---|---|
| **Channels** | `SELF` `KIOSK` `CNTR` `CALL` `PROXY` |
| **Entry** | An identified patient + a chosen slot |
| **Exit** | A **hold** and a **cart**, bound to exactly one patient |
| **Abandonment** | Hold expires on TTL; slot returns; no debris |
| **Degraded** | The counter books directly with no hold — the hold exists to protect a gap the counter does not have |

| # | Scenario | Required behaviour |
|---|---|---|
| S3-01 | Patient holds on the app, then calls the call centre for the same slot | The agent sees **"held by this patient"**, not "taken", and can convert it |
| S3-02 | Patient holds on the phone, walks to a counter | The cashier sees the hold and converts it. Fighting your own hold is the most infuriating possible bug |
| S3-03 | Session dies; patient returns on another device | The hold is reclaimable by the same patient |
| S3-04 | Wrong family member bound, caught in the cart | "Change" **recomputes the fee** — revisit branch, age band and membership all differ within one family |
| S3-05 | Cart built on the app, paid at a counter | The cashier opens the cart by phone, UHID or QR |
| S3-06 | Cart built at a counter, patient wants to pay from their phone | A payment link. This is the single most useful counter feature in the whole design |
| S3-07 | Hold expires while the patient walks from the gate to the counter | The counter re-takes it in one action, not a re-search |
| S3-08 | **Mother and child in one visit** | One cart per patient, but **one payment across both carts** — the intent settles a set of carts, not one. Extremely common; design it in |
| S3-09 | Kiosk cart abandoned; the next patient walks up | Hard session clear. The previous patient's data on screen is a live breach every ninety seconds |
| S3-10 | The doctor's schedule changes while a slot is held | The hold survives or fails loudly. Never a booking against a slot that no longer exists |
| S3-11 | Patient holds one slot, then books a different one | The first hold releases immediately, not on TTL |
| S3-12 | Tariff changes between cart build and payment | The displayed fee binds for the life of the hold (R-14) |
| S3-13 | A proxy builds a cart for someone not in their household | Needs an explicit link or consent — otherwise anyone can book in anyone's name |
| S3-14 | Patient closes the tab at the cart | TTL release. Slot returns. Nothing left behind |
| S3-15 | Patient returns and finds their **own** expired hold | "Your hold expired" — not "slot taken", which reads as someone stole it |
| S3-16 | Cart contains a service the patient is not eligible for | Blocked at binding with the reason |
| S3-17 | Add-new-profile mid-checkout under time pressure | Dedup still runs. This is exactly when it is clicked past |
| S3-18 | Two carts for one patient with overlapping slots | Warn — a split visit is legitimate |
| S3-19 | A held slot is watched by another patient until it expires | The grid updates without a reload |
| S3-20 | One household holds five slots across five doctors | Cap concurrent holds (R-15) |

---

## 5. S4 · Settlement

The richest segment for channel mixing, and the one where mistakes cost money directly.
Full machine in `02-PLAN-22A-PAYMENTS.md`.

| | |
|---|---|
| **Channels** | `SELF` `KIOSK`(POS) `CNTR` `CALL`(link) `PROXY` — **or none** (pay-later, zero-rupee) |
| **Entry** | A cart with a computed amount |
| **Exit** | A receipt, **or** a pay-later booking with a stated deadline |
| **Abandonment** | Intent expires; hold releases on the second clock; booking survives if pay-later |
| **Degraded** | Gateway down → pay-later stays open. Counter unaffected — cash always works |

**Channel is not binary.** `counter | online | kiosk` — a Pine Labs POS is unattended but
physical, has no cashier session, and settles on its own rail.

| # | Scenario | Required behaviour |
|---|---|---|
| S4-01 | App booking with pay-later → cash at a counter | Cashier finds it, takes cash, `channel=counter`, drawer normal, booking confirms instantly |
| S4-02 | Online payment abandoned → patient pays at the counter | **The counter taking money must atomically void any live intent for that cart.** Otherwise: double collection |
| S4-03 | Reverse race — cashier mid-transaction when the patient's earlier UPI lands | The cashier's screen locks against intent state and refuses with an explanation |
| S4-04 | Patient pays online while standing at the counter to skip the queue | Legitimate. Must work, and the cashier must see it land |
| S4-05 | Kiosk POS approves; the kiosk app crashes before recording | The POS has money we have no record of. Reconciled against the POS batch, not the gateway file |
| S4-06 | Kiosk POS declines but the patient is debited | Failed-but-debited **with no cashier to complain to.** The kiosk must print or show a dispute reference |
| S4-07 | Partial payment — ₹300 now at the counter, ₹200 online later | Allocations are append-only; this already works. Test it |
| S4-08 | A relative pays at the counter | Payer ≠ patient. Matters at refund |
| S4-09 | Pay-later deadline passes while the patient is in the building | Do not cancel someone standing in the corridor. The deadline is for absent patients |
| S4-10 | Counter refund requested for an online payment | Refused; refund-to-source explained. **This is an anti-fraud control, not policy pedantry** |
| S4-11 | Printed receipt wanted at a counter for an online payment | Must print, with the online channel visible on it |
| S4-12 | TPA or corporate patient | A booking with no payment, and the desk must not chase it |
| S4-13 | Free revisit | **No money requested at all** — and the counter must know too, or they will collect |
| S4-14 | Paid online, then reschedules | Money follows the booking; no refund-and-repay cycle |
| S4-15 | Advance paid online, allocated later | `receipts` already treats these as one row |
| S4-16 | Gateway down, patient at home | Pay-later. Gateway down, patient at counter: cash, entirely unaffected |
| S4-17 | Patient pays twice — once online, once at a counter | The second becomes an advance or is refused. Never silently taken |
| S4-18 | Call centre sends a payment link | Same intent machinery; the link is a channel, not a new object |
| S4-19 | Cash-law C-2 threshold reached across departments in a day | Online tenders excluded at the SQL level already. Test it, do not change it |
| S4-20 | Counter takes cash for a slot that expired thirty seconds ago | Slot-free-or-refund, but *in person* — re-take if free, and if not, offer the next slot **before** taking the money |
| S4-21 | Money taken; the doctor cancels that evening; the patient has already travelled | Auto-refund plus a human call. An automated message is not enough here |
| S4-22 | Invoice wanted in a company's name for reimbursement | Invoice-to differs from patient. A real and common request |
| S4-23 | One payment settling two family members' carts | S3-08's counterpart. The intent references a set |
| S4-24 | Patient asks to pay part now and part after the consult | The consult fee is knowable; investigations are not. Two settlements, one visit |

---

## 6. S5 · Arrival & check-in

| | |
|---|---|
| **Channels** | `SELF`(geofence) `KIOSK` `CNTR` `PROXY` |
| **Entry** | A booking, paid or with a live pay-later deadline |
| **Exit** | A check-in on the encounter |
| **Abandonment** | No check-in → no-show at session close |
| **Degraded** | Manual desk check-in on paper; backfilled |

| # | Scenario | Required behaviour |
|---|---|---|
| S5-01 | Self check-in and counter check-in both happen | Idempotent. One check-in, no duplicate token |
| S5-02 | Checks in from the car park, then queues at the desk anyway | The desk sees they are already in and does not re-token them |
| S5-03 | Arrives having never opened the app | The desk checks them in as always. **The load-bearing rule** |
| S5-04 | Arrives two hours early and checks in | Held until the session opens, with the reason shown |
| S5-05 | Arrives after their slot time | **Ruling needed:** still seen, or re-queued at the back? Recommend re-queued with the doctor's discretion |
| S5-06 | The doctor is ninety minutes late | Tell them before they leave home. This is the most common OPD complaint anywhere |
| S5-07 | The room moves while the patient is in transit | Wayfinding re-resolves from `resources` on every view |
| S5-08 | Two appointments that day; checks into the wrong one | Disambiguate by doctor and time, never auto-pick |
| S5-09 | GPS unavailable indoors | Geofence fails → fall back to a QR at the entrance or the desk. Never a dead end |
| S5-10 | Phone dead on arrival | UHID and name at the desk suffice. **The QR is a convenience, never a credential** |
| S5-11 | A relative checks in while the patient is still travelling | The geofence proves the *relative's* location. Presence is what the queue needs — this is a real gaming vector |
| S5-12 | Checks in, then leaves the building | Skip logic, exactly as for a desk check-in |
| S5-13 | Wheelchair or assistance needed | Requested at check-in, routed as a task |
| S5-14 | Goes to the wrong building or floor | Wayfinding, and a "I'm lost" affordance that raises a task |
| S5-15 | **Walk-in with no appointment** | Fully servable. The self-service layer must not degrade the walk-in path by one second |
| S5-16 | Checked in but the overnight payment failed | Do not turn them away at the door. Flag to the desk, let a human decide |
| S5-17 | Two patients on one phone, both booked; one checks in | Explicit choice, never inferred |
| S5-18 | Check-in on a session cancelled an hour ago | Refused with the rebooking path, and ideally they were told before arriving |
| S5-19 | Arrives with a kiosk slip printed three weeks ago | The slip is a pointer; the booking is the truth |
| S5-20 | Network down at the entrance | Paper check-in, reserved serials, backfilled with `late_entry.flagged` |

---

## 7. S6 · Queue & call

| | |
|---|---|
| **Channels** | Display · `SELF` · desk |
| **Entry** | A check-in |
| **Exit** | Called → consult, or skipped → left |
| **Degraded** | The display and the desk run on paper tokens |

| # | Scenario | Required behaviour |
|---|---|---|
| S6-01 | "3 ahead", patient goes for tea, misses the call | Skip counter, and a warning before they wander |
| S6-02 | An emergency insert pushes everyone back | The app reflects it honestly. Silence here reads as a broken estimate |
| S6-03 | Doctor takes a break mid-session | Say so. A stalled queue with no explanation empties into the corridor |
| S6-04 | Skipped twice, third skip | `left`, per `maxSkipsBeforeLeft` |
| S6-05 | Two patients holding the same token after a session restart | Cannot happen — `nextToken` allocates atomically. Test it anyway |
| S6-06 | Display and app disagree | One source. The display is a projection, not a second truth |
| S6-07 | Checked in but the session never opened | Escalate to the desk, do not leave them watching a static number |
| S6-08 | Session closed with patients still waiting | Every one of them gets a resolution, not a silent drop |
| S6-09 | Patient asks to swap position with another | Not a feature. But the desk will do it verbally, so the model must tolerate a manual reorder with an audit |
| S6-10 | A confidential patient on the public display | Alias — and **never** a priority change (D-37) |
| S6-11 | Token called while the patient is paying for a lab test elsewhere | The skip is unfair. Consider a hold when a payment for the same visit is in flight |
| S6-12 | A wait estimate turns out badly wrong | An estimate is a promise. Show position, be cautious with minutes |

---

## 8. S7 · Encounter *(Plan 07, shipped — new touchpoints only)*

| # | Scenario | Required behaviour |
|---|---|---|
| S7-01 | Pre-consult uploads reach the doctor | Marked **patient-supplied**, never mistaken for a hospital result (R-17) |
| S7-02 | Identity confirmed at the chair | The wrong-patient hard stop. Photo and age-to-day on the consult screen |
| S7-03 | A different family member sits down than the one booked | Detected and corrected at the chair, not discovered in the bill |
| S7-04 | Doctor sees a patient with no booking | Must work. The encounter is the record, not the appointment |
| S7-05 | Diagnosis amended after the patient left | The amendment grammar; the patient's copy is reissued marked AMENDED |
| S7-06 | Patient wants everything on their phone before leaving the room | e-Rx available on the app the moment it is signed |

---

## 9. S8 · Orders & fulfilment

| | |
|---|---|
| **Channels** | Doctor raises; patient settles and schedules in any channel |
| **Exit** | An order with its own payment and fulfilment state |

| # | Scenario | Required behaviour |
|---|---|---|
| S8-01 | Labs ordered; payment needed before collection | A **new cart mid-visit** — the patient is already in the building, so this must be fast |
| S8-02 | Patient pays for labs on the app while sitting in the waiting area | The best possible use of the app. Must work from the encounter, not a fresh search |
| S8-03 | Sample collected, patient leaves, result arrives later | Release rules (R-08) govern what reaches the phone |
| S8-04 | Imaging ordered, needing its own slot on another day | A booking flow entered from an order, carrying the order with it |
| S8-05 | Prescription → pharmacy | Counter pickup or delivery, both from the same order |
| S8-06 | Order placed but never paid | It must expire or be closed. An open unpaid order forever is a data-quality wound |
| S8-07 | Order raised against the wrong patient | Correctable with the `entered_in_error` grammar, never deleted |
| S8-08 | Patient declines an ordered test | Closeable with a reason. Not orphaned |
| S8-09 | An order raised at the counter versus in the app | The same object. No channel-specific order type |
| S8-10 | A test needs fasting or preparation | Said at booking, not discovered at arrival |

---

## 10. S9 · Documents & results

| | |
|---|---|
| **Channels** | Print · `SELF` · the public verification page |
| **Exit** | Documents with a number, a QR and an access code |

| # | Scenario | Required behaviour |
|---|---|---|
| S9-01 | e-Rx wanted on the phone and printed | Both, from one render, through the kernel chrome |
| S9-02 | Report ready, bill unpaid | **Do not withhold a critical result over money.** Separate the dues nudge from release |
| S9-03 | Result classes released differently | R-08: routine immediate, flagged-abnormal held for clinician release, sealed never |
| S9-04 | A printed report handed to a doctor in another city | QR + access code → the verified digital original. Public page, no login, rate-limited |
| S9-05 | Images available; the patient is on 2G | Derived JPEG series for viewing; full DICOM on request. Two paths, one study |
| S9-06 | A report is amended after release | Reissued marked AMENDED with a reason class; the original retained (NABL) |
| S9-07 | A document reprinted after a name amendment | **As-of-encounter demographics.** Medanta prints one patient's age three ways across one episode |
| S9-08 | Patient loses the paper and its access code | Reissue with a new code; the old one revoked |
| S9-09 | A confidential patient's document | Alias on public surfaces; statutory registers keep the real name |
| S9-10 | Patient forwards a report to a family group | Not preventable. Watermark with the recipient; audit every download |
| S9-11 | An employer or insurer uses the patient's code | Works, is logged, and the patient can see who retrieved it |
| S9-12 | Film and image retention | Medanta destroys film at 90 days. Ours is an owner decision with a rupee figure, bounded below by R-009 |

---

## 11. S10 · Aftercare

| # | Scenario | Required behaviour |
|---|---|---|
| S10-01 | Follow-up inside the free-revisit window | No fee, and the app applies the same rule the counter does |
| S10-02 | A missed follow-up | Recall task, on the consented channel, in the patient's language |
| S10-03 | An abnormal result needs chasing | **A clinician-initiated recall, not an app notification.** A push message is not how someone learns this |
| S10-04 | Revisit with a different doctor in the same department | **Ruling needed:** does the revisit rule apply? Recommend yes, within the department |
| S10-05 | The patient's number changed since the visit | Recall undeliverable → a task, not a silent failure |
| S10-06 | The patient has died since the visit | `deceasedAt` is a hard stop on every recall, ahead of urgency |
| S10-07 | Repeated no-shows on follow-ups | Visible to the doctor; never an automated penalty |
| S10-08 | A chronic-condition revisit versus a new complaint with the same doctor | Different fee branches. The patient cannot be expected to know which |

---

## 12. What this changes in the plan

| Finding | Consequence |
|---|---|
| **`channel` is `counter \| online \| kiosk`**, not binary (S4-05/06) | Widens 22a's T1 migration. A POS batch is a third reconciliation rail |
| **One payment must settle several carts** (S3-08, S4-23) | The intent references a *set* of carts. Cheap now, structural later |
| **A counter payment must atomically void a live intent** (S4-02/03) | A 22a T-task that did not exist. It is the double-collection defence |
| **Counter needs "send a payment link"** (S3-06) | The most useful counter feature in the design, and it is nearly free once 22a exists |
| **Registration drafts must be resumable across channels** (S1-01/02) | A draft table in 22c-T1 — not a patient row |
| **Self-registered staff land in the wrong privacy class** (S1-21) | A confidential-request path routed to a counter |
| **The geofence proves the relative's location** (S5-11) | Check-in is evidence, not proof. The skip logic remains the real backstop |

**Six new rulings** join the register: S5-05 late arrival · S10-04 revisit across doctors ·
image retention period · order expiry · manual queue reorder · whether a proxy may build a
cart for someone outside their household.
