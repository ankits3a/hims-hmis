# Implementation plan — patient self-service, payments, documents
**Date:** 2026-08-28 · **Status:** ready to slice into phase docs
**Gate:** all decisions locked in `06-RULINGS-LOCKED.md`. Nothing below waits on a ruling.

---

## 1. Shape

Three plans, six milestones. **The first milestone has no money in it** — that is
deliberate: it delivers most of the queue relief with none of the payment risk, and it
proves the patient actor before a rupee depends on it.

| Plan | Scope |
|---|---|
| **kernel** | Patient actor · identity versions & assurance · document chrome · the Plan 08 channel migration |
| **22c** | The patient app — auth, households, catalogue, holds, binding, journey, records, verification portal, images |
| **22a** | The payment gateway adapter (R-261), consumed later by 23 · 24 · 26 · 27 · 16f |

### 1.1 Milestones

| M | Delivers | Money? | Gated on |
|---|---|---|---|
| **M1** | **Browse · book · pay at the counter.** Public catalogue, self-registration, households, holds, binding, pay-later | **None** | — |
| **M2** | **Online payment** end to end, plus the counter-side defences | Yes | M1 |
| **M3** | **Appointment journey** — status, wayfinding, live queue position, check-in, document upload | — | M2, Plan 13 |
| **M4** | **Documents** — chrome, as-of-encounter snapshot, verification portal | — | kernel-D |
| **M5** | **Records** — lab and imaging reports, then images | — | Plan 17, O-1 |
| **M6** | **Kiosk** + Pine Labs POS | Yes | M2, O-2 |

M1 alone is a real product: fewer people in the registration line, and the ones who remain
move faster because the easy cases left.

---

## 2. Kernel track — everything else waits on this

| # | Task | Exit test |
|---|---|---|
| **K1** | **Patient actor.** `Actor` gains a fourth type. Audit every permission check, every event actor stamp, every module that assumed a logged-in staff member | A patient actor can read its own patient and nothing else; every existing suite still green |
| **K2** | **Plan 08 channel migration.** `receipts.channel` (`counter\|online\|kiosk`), `cashier_session_id` nullable, check constraint. **Audit every reader** | A counter receipt still requires a session; an online receipt cannot have one; cash-law C-2 unchanged |
| **K3** | **Document chrome.** Three-zone header, department band, footer, page x of y, document number, QR + access code, authorship block, **as-of-encounter demographics enforced in the renderer** | The same document rendered a year later, after a name and DOB amendment, is byte-identical except for the amendment annotation |
| **K4** | **Identity.** `patients.identity_assurance`, `patient_identity_versions`, `patients.administrative_gender` split from clinical sex (R-05), `patients.confidential.write` and `patients.deceased.write` split off `patients.update` (R-06) | An amendment mints a version; a Class I amendment without evidence drops assurance (S1-R3); a clerk with only `patients.update` cannot set `isConfidential` |

K1‖K2 and K3‖K4 are independent pairs and can run in parallel.

> **K1 is the riskiest task in the whole programme** — small change, large blast radius.
> Do it first, alone, with the full suite green before anything is built on it.

---

## 3. 22c — the patient app

| # | Task | Depends | Exit test |
|---|---|---|---|
| **T1a** | Patient OTP + PIN auth, throttled per number and per device; email/UHID recovery login | K1 | OTP bombing throttled; a changed number can still reach the account |
| **T1b** | **Registration drafts** — resumable in any channel, 24 h live / 7 d readable | T1a | A clerk completes an abandoned self-registration by phone; **one** patient results |
| **T1c** | **The dedup gate** — bands, and the non-disclosure rule | T1b, K4 | A cross-phone match returns a response byte-identical to a no-match, and emits `patient.duplicate_suspected` |
| **T1d** | **Households, many-to-many**, access classes, adult consent, silent revocation | T1c | An adult is `pending` by default and their name is not shown; a minor's access ends on their 18th birthday with no job running |
| **T1e** | **Confidential request path** — provisional alias applied immediately (S1-R4) | T1d | A self-registered record flagged confidential is aliased from creation |
| **T2a** | Public catalogue — departments, specialities, search, guest browsing | K1 | Doctor pages render logged-out and leak nothing about the sharer |
| **T2b** | `doctor_public_profiles` — photo, designation, experience, gender, consult modes, age bands, bio, **consented publication** | T2a | Publication requires a consent record; escaping is pinned by a test (Medanta's live bug) |
| **T3** | **Availability projection**, invalidated on booking · leave · schedule change | T2b | A 40-doctor department renders in one query, not 280; counts are display-only |
| **T4a** | **Slot holds** — a third status inside the existing partial unique index | T3 | A hold blocks a second booker exactly as a booking does, and expires alone |
| **T4b** | **Select-Patient binding** — dedicated step, age-to-day + UHID, fee recomputed on change | T4a, T1d | Changing the bound patient recomputes the revisit branch |
| **T4c** | Cart — one patient per cart, edit, remove, empty state | T4b | |
| **T4d** | Pay-later — tariff property, **4-hour deadline**, UNPAID card | T4c | A booking inside 4 hours cannot choose pay-later |
| **T5a** | Appointment journey — status stepper, **wayfinding resolved from `resources`** | T4d, Plan 13 | Moving a room changes the journey on the next view, with no stored string |
| **T5b** | Check-in — geofence + counter + kiosk, idempotent | T5a | Self and counter check-in together produce one token |
| **T5c** | **Live queue position** from `nextToken` / `callsMade` | T5b | |
| **T5d** | Pre-consult document upload — scanned, capped, patient-supplied, treating team only | T5a | Never rendered as a hospital result |
| **T6** | Records — prescriptions, visit summaries, receipts; **release on authorisation** (R-08); sealed classes excluded invisibly | K3, T1a | A sealed record produces no count, no placeholder, no "hidden" label |
| **T7** | **Document verification portal** — public, QR + code, rate-limited, retrieval logged, code revocable | K3 | A wrong code is an auditable event; a sealed document is not retrievable |
| **T8** | Lab and imaging **reports** in Records | T6, Plan 17 | |
| **T9** | **Radiology images** — DICOMweb reference, derived JPEG series for the portal, OHIF viewer | T8, **O-1** | A 300 MB study opens on a phone without downloading 300 MB |

---

## 4. 22a — payments

| # | Task | Depends | Exit test |
|---|---|---|---|
| **A1** | = K2 | | |
| **A2** | Adapter interface + Razorpay + **fake adapter drivable into every failure mode** | — | The fake can produce every state in the golden suite |
| **A3** | `payment_intents`, the state machine, idempotency over the existing `idempotencyKeys` | A2, T4c | Suite 1–8 |
| **A4** | Webhook — **raw body preserved**, signature first, `payment_events`, out-of-order guard | A3 | Five deliveries → one receipt; a forged signature changes nothing |
| **A5** | Verify/poll sweep for stale intents | A4 | A never-delivered webhook resolves within one sweep |
| **A6** | **The success transaction** — one transaction: intent, receipt, tender, allocation, booking | A5, T4a | Suite 9–10, 15, 17 |
| **A7** | **The cart lock** — ordered `FOR UPDATE` on every money path | A6 | Two counters and a webhook race; exactly one wins, the others explain themselves |
| **A8** | **Counter intent visibility + void-to-take-cash** | A7 | A cashier cannot take cash against a `pending` intent (S4-R1) |
| **A9** | **Card-testing defences** — no arbitrary-amount endpoint, velocity limits, failure-rate alarm | A3 | An amount not derived from a cart is impossible to submit |
| **A10** | Multi-cart splits — computed once, stored; N receipts | A6 | Mother + child in one payment produce two receipts and two allocations |
| **A11** | Refunds — three rails, reason classes, policy JSON, SoD on manual, ₹50 floor, ₹10k payer check | A6 | Suite 18; an online payment cannot be cash-refunded at a desk |
| **A12** | Settlement reconciliation + orphan hook + **absence watcher** | A11 | A missing reconciliation run is itself an alarm |
| **A13** | `payment_debit_disputes` + the counter surface | A12 | A cashier finds a disputed debit by phone in one search |
| **A14** | **Concessions / waivers** — approval-gated, reason-classed, in the daily close | K2 | Nobody owns this today, and every hospital needs it from week one |
| **A15** | Degraded mode | A8 | Gateway down → pay-later open, booking intact |
| **A16** | Payment links from counter and call centre | A8 | |
| **A17** | **The golden suite**, all 20 | all | Green before a rupee moves in production |

---

## 5. Critical path

```
K1 ──► T1a ─► T1b ─► T1c ─► T1d ─► T1e
                                    │
K2 ──────────────────────┐          ├──► T4b ─► T4c ─► T4d ══ M1
                         │          │       ▲
      T2a ─► T2b ─► T3 ──┴─► T4a ───┴───────┘
                         │
                         └──► A2 ─► A3 ─► A4 ─► A5 ─► A6 ─► A7 ─► A8 ══ M2
                                      └─► A9                    └─► A10…A17

K3 ─► K4 ─► T6 ─► T7 ══ M4     T5a…T5d ══ M3     T8 ─► T9 ══ M5     kiosk ══ M6
```

**K1 is the single point of failure.** Everything patient-facing is refused until it lands.

---

## 6. Hard gates

Three, and none is negotiable.

1. **Do not open self-registration** before T1c (dedup), T1d (many-to-many households) and
   T1e (confidential request). Without the first it mints duplicates; without the second it
   *forces* them; without the third it exposes staff-as-patients.
2. **Do not open online payment** before A7 (cart lock), A8 (counter visibility) and A9
   (card testing). Without the first two you double-collect; without the third you are a
   card-testing service for organised fraud.
3. **Do not ship any printed document** before K3's as-of-encounter enforcement. Retrofitting
   a snapshot after documents exist means every historical document is already wrong.

---

## 7. Standing constraints

- **The counter path must not get one second slower.** Success is a shorter queue, not a
  replaced one. Every task above is additive to the desk, never a precondition for it.
- **No path may exist only in the app.** If the app is switched off, the hospital runs
  unchanged.
- **Every segment completable in any channel**, switchable between any two.
- Registry kinds stay closed at ten — kiosk → `device`, counter/desk → `bench`.
- Sealed-class aliasing is consumed from `patients`, never reimplemented.
- One hospital, one site. No location dimension anywhere.

---

## 8. Explicitly not in scope

Second opinion · medicine delivery (16f) · home care (24a/24b) · video consult (23) ·
health-check packages (26) · TPA/claims (46) · the call centre and PBX (22) ·
appointment optimiser (22b). Each has a plan number already; the app surfaces them as
**config-driven tiles that do not render until they exist.**

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **K1's blast radius** is larger than it looks | Do it alone, first, full suite green before anything builds on it |
| Two sessions in `/opt/hmis` corrupt each other's suites | The parallel-session protocol already in the reports directory |
| Availability projection wrong under the 8–10 a.m. rush | Load-test T3 against 2,000/day before T4 depends on it |
| A payment bug reaches production | The golden suite gates the deploy; the fake adapter makes it testable |
| Self-service duplicates outrun MRD's merge capacity | Duplicate rate is a launch metric with a rollback threshold |
| O-1 / O-2 slip | They gate M5 and M6 only. M1–M4 are unaffected |

---

## 10. Next step

Slice **M1** into a phase document — `kernel-P` (K1, K4) and `22c-T1` — following the
EXECUTE-METHOD conventions, with the task briefs pointing at AGENT-RULES rather than
restating them.
