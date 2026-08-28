# S2 · S6 · S7 · S8 · S9 · S10 — the remaining segments
**Date:** 2026-08-28 · **Status:** working document, not approved
**Parent:** `03-JOURNEY-SEGMENTS.md` · completes the set begun with S1, S4, S3, S5

Depth here is proportional to what is still undecided. **S2, S8 and S9 carry real design.
S6 carries one honesty problem. S7 and S10 are mostly owned elsewhere** and are recorded so
the set is complete and the seams are named.

---

## S2 · Discovery

**Exit contract:** stateless — a chosen doctor and date carried into S3.
**Channels:** all four, **public, no login.**

### The one unsolved problem: patients do not search by department

A patient types *"chest pain"*, *"pregnancy"*, *"knee"*, *"my child has fever"*. Our
`opdDepartments` is a flat master of organisational units. The counter clerk does this
translation in their head a thousand times a day and nobody has ever written it down.

The production competitor's answer is visible in their speciality list: they mix
**programmes** ("Liver Transplant", "Bone Marrow Transplant") with **service lines**
("Cardiac Care", "Gastrosciences") — precisely because neither matches an org chart.

**Recommendation — a `care_topics` table, not an ontology.** A curated list of
patient-language terms, each mapping to one or more departments, with synonyms and Hindi.
Seeded from the clerk's head — literally: sit at a registration counter for a morning and
write down what people actually say. **Do not buy or generate a medical ontology**: SNOMED
would map "chest pain" to a hundred concepts and none of them to a department.

Who owns it: **front office (Plan 22)**, not the app. It serves the counter and the call
centre identically.

| # | Scenario | Behaviour |
|---|---|---|
| S2-21 | *"chest pain"* typed at 2 a.m. | The emergency affordance outranks every search result. **If this is an emergency, come now** |
| S2-22 | A topic maps to three departments | Show all three with a one-line differentiator, never guess |
| S2-23 | A topic maps to a department with no bookable doctor | Say so and offer a callback, not an empty list |
| S2-24 | The term is a drug name, not a symptom | Out of scope. Route to a callback rather than pretending |
| S2-25 | A topic is added but never mapped | A `care_topics` row with no department is an ops defect, and a report should name it |

**The rest of S2** is catalogued in `03-JOURNEY-SEGMENTS.md` §3 and needs no further design:
availability counts are display-only, one tariff resolver serves app and counter, a
departed doctor shows an alternative rather than vanishing.

---

## S6 · Queue & call

**Exit contract:** a token and its position, legible to the display, the desk and the app.
**Owner:** Plan 07's queue engine, shipped. This segment adds only the patient's view of it.

### The honesty problem

We hold `nextToken` and `callsMade`. From those, **position** is exact and **time** is a
guess. The temptation is to show minutes, because minutes are what the patient wants.

> **Show position, not minutes.** An estimate is a promise, and a wrong one at a hospital
> is worse than no estimate: the patient who was told "20 minutes" and waited 90 has been
> lied to by an institution they are about to trust with their body.

If a time is ever shown it must be a **range that widens with distance** — "about 20–40
minutes" at position 3, nothing at all at position 15 — and it must visibly revise when an
emergency inserts, rather than silently sliding.

| # | Scenario | Behaviour |
|---|---|---|
| S6-13 | An emergency insert pushes everyone back | The app says so **as it happens**. A number that silently grows reads as a broken app |
| S6-14 | Doctor takes a break | Say it. A stalled queue with no explanation empties into the corridor and then into a grievance |
| S6-15 | Patient at position 3 goes for tea | Warn before they wander — a push at position 5, not at position 1 |
| S6-16 | Token called while the patient is paying for a lab test elsewhere in the building | **Consider a hold when a payment for the same visit is in flight.** The skip is unfair and we can know |
| S6-17 | Confidential patient on the public display | Alias, and **never** a priority change (D-37) |
| S6-18 | Display and app disagree | The display is a projection of the same state; one source, or neither is trusted |
| S6-19 | Session closes with patients still waiting | Every one of them gets a resolution — a message and a rebooking path, not a silent drop |

---

## S7 · Encounter

**Owner:** Plan 07, shipped. The app adds three touchpoints and takes nothing away.

| # | Touchpoint | Note |
|---|---|---|
| S7-07 | Patient-uploaded documents reach the doctor | **Marked patient-supplied**, never rendered as a hospital result (R-17). Provenance must be obvious at a glance in a busy clinic |
| S7-08 | Identity confirmation at the chair | Photo, name, age-to-day, UHID. The last wrong-patient defence, and the only one where a human looks at a face |
| S7-09 | e-Rx on the phone before the patient leaves the room | The moment it is signed. This is the single most-wanted thing in any patient app |

Everything else — the consult itself, danger ranges, prescribing safety, the queue's
skip and call — is shipped and this programme does not touch it.

---

## S8 · Orders & fulfilment

**Exit contract:** an order with its own payment state and its own fulfilment state.
**The insight:** an order raised mid-visit creates a **second commercial transaction inside
one visit**, and the patient is already in the building.

### The mid-visit cart

The doctor orders labs. The patient must pay before collection. They are thirty metres from
the phlebotomy room with a phone in their hand — **this is the best use of the app in the
entire product**, and it collapses a queue that today is real.

Requirements that follow: the cart must be enterable **from the encounter**, not from a
fresh search; the fee must be known at the moment of ordering; and the collection desk must
see the payment land in seconds, not at the next poll.

| # | Scenario | Behaviour |
|---|---|---|
| S8-11 | Doctor orders; patient pays on the app in the waiting area | The cart opens from the encounter, pre-filled. No searching for what was just ordered |
| S8-12 | Patient pays at the counter instead | Identical object, other channel. The order does not know which |
| S8-13 | Order placed, never paid | Expires at **30 days**, closed with a reason (locked). An open unpaid order forever is a data-quality wound |
| S8-14 | Imaging ordered, needs its own slot on another day | A booking flow entered **from the order**, carrying it — not a fresh browse where the patient must remember what they were told |
| S8-15 | The test needs fasting or preparation | Said at **booking**, not discovered at arrival. This is the most common wasted trip in any hospital |
| S8-16 | Order raised against the wrong patient | The `entered_in_error` grammar; never deleted |
| S8-17 | Patient declines an ordered test | Closeable with a reason, not orphaned. The doctor should see the decline |
| S8-18 | Sample collected, patient leaves, result arrives later | Release rules (R-08) govern what reaches the phone |
| S8-19 | A package covers four of five ordered tests | Partial coverage: part allocation, part payable, arithmetic explicit rather than emergent |

---

## S9 · Documents & results

**Owner:** `kernel-D` (chrome) + 22c-T7/T8/T9. The most under-specified surface in the
hospital before this series, and the one with a competitor failure we can point at.

### The three deliverables

**1. The chrome.** One kernel component: three-zone header with a type-varying third zone,
department band, standard footer. **As-of-encounter demographics enforced in the renderer**,
never trusted to callers — because the competitor's own reports print one patient's age
three different ways across a single episode, and every one of those subsystems believed it
was doing the right thing.

**2. The verification portal.** Document number + QR + numeric access code, printed in the
footer. A public page, no login, rate-limited, every retrieval logged, the code revocable.
The reader is an outside doctor, an insurer or an employer — **not our patient**, which is
why it cannot sit behind our login.

**3. Images.** The differentiator. The competitor's own report says *"films… maintained for
the period of 3 months only. Kindly collect."* They hand out physical film and destroy it.
We keep the images and the patient carries them on a phone, permanently.

### What images actually cost

| Concern | Reality |
|---|---|
| PACS | **Bought, never built.** We speak DICOMweb and store references, not pixels |
| Volume | A CT or MRI study is 100–500 MB. **Terabytes per year**, and the biggest storage line the hospital will have |
| Delivery | A 300 MB study cannot stream to a phone on 4G. **Derived JPEG series for the portal; full DICOM for clinicians.** Two paths, one study |
| Viewer | OHIF or Cornerstone. **Do not hand-build a DICOM viewer** |
| Release | R-08 applies to images as to results. An unreported scan must not reach the patient before the radiologist has read it |
| Report ≠ image | Separate artifacts, separate release states. A report can release while images are still processing |

| # | Scenario | Behaviour |
|---|---|---|
| S9-13 | A report is reprinted a year later, after a name and DOB amendment | **As-of-encounter**, with the amendment annotation. The one rule the whole document programme exists for |
| S9-14 | The patient loses the paper and its code | Reissue with a new code; the old one revoked. The code is a credential and credentials rotate |
| S9-15 | An insurer retrieves with the patient's code | Works, is logged, and **the patient can see who retrieved it** |
| S9-16 | A sealed-class document | Not retrievable through the portal at all, and the refusal must not disclose that it exists |
| S9-17 | A critical value is authorised at 23:50 | Released on authorisation (R-08) — and NABL's telephone callback has already reached the ordering clinician, which is what makes that safe |
| S9-18 | Images ready before the report | Held. An unreported scan on a patient's phone is a diagnosis they will make themselves |
| S9-19 | The patient downloads and forwards to a family group | Not preventable. Watermark with the recipient; audit the download |
| S9-20 | Retention lapses on images the patient can still see a link to | The link must die with the retention, not 404 into a support ticket |

---

## S10 · Aftercare

**Owner:** Plan 27 (CRM, recalls, consent). This programme contributes the surfaces.

| # | Scenario | Behaviour |
|---|---|---|
| S10-09 | Follow-up inside the free-revisit window | The app applies the **same** resolver the counter does. Anything else charges for a free visit |
| S10-10 | An abnormal result needs chasing | **A clinician-initiated recall, not an app notification.** A push message is not how a person should learn this |
| S10-11 | A missed follow-up | Recall on the consented channel, in the patient's language, once — then a task, not a drip |
| S10-12 | The patient's number changed since the visit | Undeliverable becomes a **task**, never a silent failure. This is how patients are lost |
| S10-13 | The patient has died since the visit | `deceasedAt` is a hard stop ahead of urgency. A recall to a dead patient's family is the worst message this system could send |
| S10-14 | Repeated no-shows | Visible to the doctor; never an automated penalty |
| S10-15 | Revisit with a different doctor in the same department | The rule applies within the department (locked) |

---

## Closing note — what the whole set says

Ten segments, five channels, and one sentence that survived all of them:

> **Every segment must be completable in any channel, and the patient may switch channel
> between any two segments.**

Every genuinely hard case in this series — the cashier who cannot see a hold, the counter
that double-collects, the clerk who cannot resume an abandoned registration, the patient
whose phone died on arrival — is that rule being violated at a seam. Nothing else in the
programme is as load-bearing, and nothing else is as easy to lose one convenient shortcut
at a time.
