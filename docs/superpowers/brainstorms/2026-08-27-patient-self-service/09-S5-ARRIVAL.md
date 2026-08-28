# S5 · Arrival & check-in — segment deep-dive
**Date:** 2026-08-28 · **Status:** working document, not approved
**Plan:** 22c-T5 (milestone M3) · **Parent:** `03-JOURNEY-SEGMENTS.md` §6

---

## 1. Scope

From *"the patient is on their way"* to *"the queue knows they are here."*

**Exit contract.** A check-in on the encounter, findable by UHID · QR · token, legible to
the queue engine and to any desk.

**The load-bearing rule of the whole product lives in this segment:** a patient who has
never opened the app arrives and is served exactly as before. Nothing here may become a
precondition for care.

---

## 2. Check-in is evidence, not proof

A geofenced self check-in proves that **a phone** was near the hospital. It does not prove
the patient is in the building — the relative holding the phone may be, or the patient may
have checked in from the car park and driven away.

Two consequences, and they settle most of the segment's design:

1. **Check-in never replaces presence.** The queue engine's skip logic
   (`maxSkipsBeforeLeft`) remains the real backstop, exactly as it is for a desk check-in.
   A spoofed geofence costs the spoofer their own skips.
2. **Check-in is therefore idempotent and multi-source.** Self, kiosk and desk all write
   the same fact. Two of them writing it is not a conflict.

---

## 3. Channel variants

| | `SELF` | `KIOSK` | `CNTR` | `PROXY` |
|---|:--:|:--:|:--:|:--:|
| Check in | geofenced | ✅ | ✅ | ✅ (records who) |
| Check in with no booking (walk-in) | — | — | ✅ | — |
| Check in when GPS fails | fallback QR at the entrance | ✅ | ✅ | ✅ |
| Request assistance | ✅ | ✅ | ✅ | ✅ |
| See wait position | ✅ | ✅ | ✅ | — |

**The walk-in row is the one that matters.** It is counter-only, it is a large fraction of
a 2,000/day OPD, and every task in this segment must leave it untouched.

---

## 4. What the journey shows, and where it comes from

The stepper is only as good as its sources, and each one already exists:

| Step | Source | Note |
|---|---|---|
| Prepare — pay, upload | S4 + `patient_uploads` | Uploads are patient-supplied, never a hospital result (R-17) |
| Check in | this segment | Geofence, kiosk or desk |
| Vitals — *where* | `opdDoctorSchedules.roomId` → `resources` (Plan 13) | **Resolved live, never a stored string** |
| Consultation — *where* | same | The competitor hardcodes "11th Floor"; ours corrects itself when a room moves |
| Position in queue | `opdQueueSessions.nextToken` / `callsMade` | The thing no competitor shows |

---

## 5. Edge cases, expanded

Extends `03-JOURNEY-SEGMENTS.md` §6.

### 5.1 Check-in mechanics

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S5-01 | Self and counter check-in both happen | Idempotent — one check-in, one token | Two writes → one token |
| S5-09 | GPS unavailable indoors | Falls back to a QR at the entrance or the desk | A failed geofence never dead-ends |
| S5-11 | A relative checks in while the patient is still travelling | Recorded as proxy; the skip logic remains the backstop | Proxy check-in is distinguishable in the audit |
| S5-21 | Geofence spoofed from home | Costs the spoofer their own skips | No special anti-spoof machinery; the queue already handles absence |
| S5-04 | Arrives two hours early | Held until the session opens, with the reason shown | Check-in before `opdQueueSessions` opens is accepted and queued, not refused |
| S5-05 | Arrives after their slot | **15-minute grace, then re-queued at the back**, doctor may override (locked) | Grace boundary tested on both sides |
| S5-08 | Two appointments that day, checks into one | Explicit choice, never inferred | Ambiguous check-in prompts; it never auto-picks |
| S5-17 | Two patients on one phone, both booked | Explicit choice | Same |
| S5-18 | Session cancelled an hour ago | Refused with the rebooking path — and ideally they were told before travelling | Cancellation notifies at cancel time, not arrival |
| S5-22 | Check-in against a `held` (unconverted) row | Refused — a hold is not a booking | Only `booked` accepts check-in |

### 5.2 The paths that must not degrade

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| **S5-15** | **Walk-in, no appointment** | Fully servable, unchanged | The desk's walk-in path imports nothing from the app module |
| S5-03 | Arrives never having opened the app | Desk checks them in as always | Same |
| S5-10 | Phone dead on arrival | UHID and name suffice — **the QR is a convenience, never a credential** | Check-in by UHID alone succeeds |
| S5-19 | Presents a kiosk slip printed three weeks ago | The slip is a pointer; the booking is the truth | A stale slip resolves to current state |
| S5-20 | Network down at the entrance | Paper check-in, reserved serials, backfilled with `late_entry.flagged` | Backfill sets `occurred_at ≠ recorded_at` |
| S5-16 | Payment failed overnight; patient is at the door | Flag to the desk; a human decides. **Do not turn them away** | A failed payment never auto-refuses check-in |

### 5.3 The building

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S5-07 | Room moves while the patient is in transit | Journey re-resolves from `resources` on every view | No stored room string anywhere in the journey |
| S5-14 | Patient is lost in the building | An "I'm lost" affordance raising a task, not just a map | The task routes to a real pool |
| S5-13 | Wheelchair or assistance needed | Requested at check-in, routed as a task | |
| S5-06 | Doctor is ninety minutes late | Said in the app **before** they leave home | Session delay propagates to the patient surface |
| S5-23 | Confidential patient arrives | Alias on every display; **never** a priority change (D-37) | Display shows alias; queue order is unaffected |
| S5-24 | Patient checks in, then leaves the building | Skip logic, exactly as for a desk check-in | No special case |

---

## 6. What this segment must expose

| Consumer | Operation |
|---|---|
| S6 queue | `checkIn(encounterId, source, actor)` — idempotent, source-tagged |
| S4 | Whether a booking is settled, for the desk's "do not turn them away" decision |
| Journey UI | `resolveWayfinding(scheduleId)` → live room from `resources` |
| Ops | Proxy and source attribution on every check-in, for the skip audit |

---

## 7. Rulings

Locked: S5-05 (15-minute grace, then re-queue, doctor override) · R-16 (show queue
position) · R-17 (uploads are patient-supplied) · manual queue reorder allowed with a
reason and an audit. **Nothing in S5 is open.**
