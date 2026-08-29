# Plan 22c-D — The appointment journey: check-in, live position, wayfinding, uploads

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** Three rulings were taken at write time and are recorded where they bite: **a second check-in is a success, not a conflict** (DD1, RULED — the shipped claim throws `appointment_state_conflict`, which is the right answer for a desk and the wrong one for three channels); **early check-in takes a token, and the ordering already handles it** (DD2, RULED — `orderQueue` sorts by appointment time; a 7 a.m. token 1 does not jump the queue); and **uploads live in Postgres under a hard cap until 11b rules** (DD7, DECIDED under the owner's standing rule; the number is a default). Everything else is locked in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md) §3.

**Roadmap:** Track C · milestone **M3** · the segment deep-dive is [`../brainstorms/2026-08-27-patient-self-service/09-S5-ARRIVAL.md`](../brainstorms/2026-08-27-patient-self-service/09-S5-ARRIVAL.md), and S6/S7 in `10-REMAINING-SEGMENTS.md`. **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §11.1 (entry lanes), §11.5 (the queue), §14. **Review:** [`reports/2026-08-28-patient-self-service-review.md`](reports/2026-08-28-patient-self-service-review.md) D2 (the check-in billing hook this phase *consumes*), D10, G7, G11, G12, G13. **This plan argues from those and does not restate them.**

**Slot: gated on 22c-C (there is no self-booked appointment to check into) and Plan 13 (shipped — wayfinding resolves from `resources`).** 07-IMPLEMENTATION-PLAN gates M3 on M2; that is only true of the *Prepare — pay* step. Everything else here is money-free, and **this phase may run before 22a-1** if the owner wants queue relief before online money — in which case the check-in billing hook (T2, DD3) lands here carrying 22a-1's Assertion Book rows A17–A19, and 22a-1 consumes it.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Seven tasks, one migration, no workflow definition, no approval band. **Four CRITICAL** — the check-in seam (concurrency across three channels, and the one place the walk-in path could be slowed), the live-position feed (a privacy seam: the queue topic carries other patients), the pay-later deadline exemption (money-adjacent), and uploads (PHI on arrival). The lane does not set verification depth (v3 §2).

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA; reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **690,000 tokens**

`1.5 × 2 × 229,246 = 687,738 → 690,000` — two fresh review passes at Plan 14's mean pass ([`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)), the derivation the review §5(h) recommends for a LIGHT phase: the reviewer is the only measured term, so it is not counted twice. Main-session cost unmeasurable (runbook **O3**).

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 7,500 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| `09-S5-ARRIVAL.md` | 6,583 | 1,646 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

M1 lets a patient book. This phase is the day of the visit: proving they are here, knowing where to go, knowing how long, and handing the doctor what they brought. It is where the competitor is weakest (a hard-coded "11th Floor", no queue position, a token that is a number on a wall) and where the hospital's shipped data — `nextToken`, `callsMade`, the resource tree — already answers the questions.

**The load-bearing rule** (S5 §1): a patient who has never opened the app is served exactly as before, and **the walk-in path gets not one second slower.** Every task below is additive to `openVisit`; none is a precondition for it.

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff** (AGENT-RULES §6)

| fact | value | consequence |
|---|---|---|
| migrations | **36** on disk; this phase writes the next free number at kickoff | `ls apps/core/drizzle/*.sql \| wc -l` |
| **check-in today** | `checkInAppointment` (`opd/appointments.ts:184-206`): `user_actor_required`; refuses `needs_rebooking` → `doctor_on_leave`; **any status but `booked` → `appointment_state_conflict`**; **`serviceDate ≠ today` → `appointment_not_today`**; claims `booked → checked_in` by conditional UPDATE, then `openVisitInTx` | **DD1, DD2.** Idempotency is a wrapper decision, not a wrap |
| **what check-in creates** | `openVisitInTx` (`opd/encounters.ts:57-104`): the encounter, a **V number**, the workflow instance, `getOrCreateSession`, **a token allocated immediately** (`allocateToken`), a `waiting_vitals` queue entry, `visit.opened` + `patient.checked_in` | A check-in at 7 a.m. takes token 1 (**DD2**); the session's `not_started` status does not gate it |
| `patient.checked_in` payload | `kind: "arrival"` only (`encounters.ts:101`) | Source attribution needs a payload widening (T2) |
| position | `listQueue` (`opd/queue.ts:56-98`) orders `waiting` rows with the pure `orderQueue(entries, now, { perkEveryNth }, callsMade)` (`queue-engine.ts:32`) and numbers them `i + 1` | **DD4** — the patient's position is that number for their entry, from the same function |
| realtime | WebSocket at `/ws`; OPD topics `queue:<doctorId>:<date>` (**permission `opd.queue.read`**), `display:<roomId>`, `encounter:<encounterId>` (`opd/realtime.ts:4-8`); events `queue.called`, `queue.skipped`, `patient.checked_in`, … | A patient cannot hold `opd.queue.read` and the `queue:` topic carries every patient's summary ⇒ **DD5** |
| the room | `opdDoctorSchedules.roomId → resources.id` (`schema/opd.ts:92`); `resources(kind, parentId, code, name, status)` with kinds `floor ward hall room bed theatre store bench analyzer device` (0031:30); `ancestorsOf` walks `parent_id` (`kernel/resources/registry.ts:83`) | **DD6** — wayfinding is the ancestor chain of the schedule's room, read on every view |
| session status | `not_started \| in \| out \| closed` (`opd/sessions.ts:10`) | S5-06 (*doctor late*) and S6-14 (*break*) are `out`/`not_started` with a reason the doctor's desk sets (T5) |
| skip policy | `maxSkipsBeforeLeft` in `opd_config` (`config.ts:37`) | S5 §2: the backstop for a spoofed geofence; **nothing new is built for it** |
| notify | templates carry `class` and `audience ∈ patient \| staff \| owner` (`kernel/notify/templates.ts:11-14`); patient-audience transactional templates exist | T5's messages are templates, not a new channel |
| blob precedent | `patient_photos` is `bytea`, cap 512,000 bytes in code (`schema/patients.ts:102`); **no object store exists**; the 11b storage decision is open | **DD7** |
| geofence | nothing exists — no location column, no distance helper | T2 builds the check, as evidence only (S5 §2) |
| pay-later marker | 22c-C T7 adds the `unpaid` marker and the 4-hour sweep on the appointment row | **DD8** — this phase adds only the in-building exemption |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | What is the **p95 of `openVisit`** on the desk today, and does adding a `check_in_source` write and a second conditional branch move it? | The load-bearing rule as a number. If the walk-in path moves by more than the noise, T2 is restructured |
| **S2** | Does the realtime gateway support a **per-connection topic filter with a non-permission predicate** (a patient's own appointment ids), or only permission-gated prefixes? | Decides whether DD5's `appointment:<id>` topic is a new prefix with a custom guard or a second gateway |
| **S3** | How deep is the production resource tree above an OPD room (floor → hall → room? four levels?), and do all scheduled rooms have a `floor` ancestor? | Wayfinding text is the ancestor chain; a room with no floor renders a blank line (J5's rule applies here too) |
| **S4** | How often does `perkEveryNth` / a danger class **move a waiting patient backwards** in a day, in production? | Sizes S6-13's honesty problem: if it is rare, the delta push is a message; if it is constant, position needs a range |
| **S5** | Does the patient-audience notify path have **quiet hours** that would suppress a "doctor is late" message at 7:45 a.m.? | If yes, T5's template needs the urgency class that beats them, or the message is useless |
| **S6** | Is the 22a-1 check-in billing hook (review D2) **already landed**? | If yes, T2 calls it; if no, T2 builds it here with 22a-1's A17–A19 and 22a-1 consumes it |

---

## 4. Design decisions

**DD1 — RULED: a check-in against an already-checked-in appointment is a success that returns the existing token.** Three channels can write the same fact (S5 §2); the shipped `appointment_state_conflict` on `checked_in` becomes `{ alreadyCheckedIn: true, tokenNo, sessionId }` for the *same* appointment. Every other conflict keeps its code. The desk path is unchanged: a clerk checking in a patient who self-checked in from the car park sees the token, not an error — S5-02.

**DD2 — RULED: early check-in takes a token now; the queue's own ordering makes that safe.** `orderQueue` sorts appointments by `appointmentAt`, so a token allocated at 7 a.m. for a 10:20 slot is called at 10:20, not first. S5-04's *"held until the session opens, with the reason shown"* is therefore a **display** rule — the journey shows *"checked in · your session opens at 10:00"* — not a refusal and not a holding table. One exception stands: `appointment_not_today` remains a refusal; a check-in for tomorrow is a mistake, not an early arrival.

**DD3 — The check-in billing hook is consumed here, owned by 22a-1.** Review D2: an online prepayment or a pay-later settlement is an **advance** until check-in, because `feeCovered` needs an invoice on *this encounter* and the encounter is minted by `openVisitInTx`. Inside `checkInAppointment`'s transaction, after the encounter exists, billing issues the consult invoice and allocates from the advance — through a registered hook of the `ConsultStartGuard` shape (`billing/gate.ts:10-27`), never an import. If S6 says the hook is not landed, T2 builds it with 22a-1's A17 (*`fee_unsettled` clears at check-in*), A18 (*a revisit issues no invoice*), A19 (*C-2 unchanged*) as its own rows. **A walk-in with no advance is untouched by the hook** — it returns without writing.

**DD4 — Position is `orderQueue`'s number for the patient's own entry, computed on read, never stored.** The same pure function the desk uses; the patient sees the same number the display would show if it showed numbers. **Position, not minutes** (S6 §*The honesty problem*): a range is shown only at positions ≤ 5, widening with distance, and never a single figure.

**DD5 — A patient-scoped topic, `appointment:<appointmentId>`, carrying position only.** The `queue:` topic is a staff surface and stays one. The gateway gains a topic space whose guard is *the connection's accessible patient set contains this appointment's patient* (22c-B DD2's `accessiblePatients(phone)`), and whose payload is `{ position, delta, reason }` — never another patient's id, name, or token. Position deltas carry a reason class (`emergency_insert`, `perk`, `re_entry`, `skip`) so S6-13 is honest as it happens.

**DD6 — Wayfinding is the ancestor chain of the schedule's room, resolved on every view.** `roomFor(schedule) → ancestorsOf(room)` → *"Block B · 3rd floor · Hall 2 · Room 12"*, from `resources.name`/`code` up the `parent_id` chain. **No journey row stores a room string** (S5-07, G9). A moved room is correct on the next view with no job and no cache invalidation, because there is no cache.

**DD7 — DECIDED: uploads are `bytea` rows under a hard cap, purged 90 days after the visit.** 2 MB per file, 5 files per appointment, images and PDF only, scanned (the existing untrusted-content boundary, §11.19-D-13), **marked `patient_supplied` on every read** and rendered with that provenance in the consult screen (R-17, S7-07). They are not the medical record, which is why a 90-day purge is lawful and why Postgres is acceptable *for now*: at 5 × 2 MB × a third of 2,000/day this is ≈ 6 GB/day worst case and ≈ 0.5 GB/day realistically — visible in the backup size within a week. **This is the default the owner's standing rule allows; it is tied to the pending 11b storage decision and is revisited there**, not here.

**DD8 — The pay-later exemption is `checked_in`, and only `checked_in`.** 22c-C's 4-hour sweep cancels an `unpaid` booking; S4-09 says never cancel someone standing in the corridor. The only evidence of presence the system holds is a check-in, so the sweep skips `checked_in` rows and the desk sees UNPAID on them instead. A geofence ping is not presence (S5 §2) and does not exempt.

**DD9 — Assistance and "I'm lost" are tasks, not chat.** Both raise a task into the front-office pool (the shipped task/approval worklist shape), carrying the resolved location. No new messaging surface.

---

## 4A. ROUTED TO THE OWNER

**DD7's storage default** — the owner should see the arithmetic above beside the 11b decision. It does not block kickoff.

---

## 5. Tasks

Seven. Four CRITICAL.

### T1 — Migration: `check_in_source`, `patient_uploads`, `journey_tasks` — **ROUTINE**

`opd_appointments.check_in_source text` (`desk | self | kiosk | proxy`) and `check_in_by_patient_credential text` (G2's actor id); `patient_uploads(id, appointment_id, patient_id FK, uploaded_by_credential, mime, bytes bytea, size, sha256, scanned_at, scan_verdict, removed_at, purge_after)`; the `patient.checked_in` payload gains `source`. Register `patient_uploads` in the patients truncate group (§3.12). **No room string column anywhere** (DD6).

### T2 — Check-in from three channels, idempotent, with the billing hook — **CRITICAL**

Open `checkInAppointment` to a `patient` actor **for its own accessible set only** (22c-B DD2); DD1's success-on-repeat; DD2's early check-in; the geofence check as evidence (distance from a configured point, recorded, never a refusal on its own — a failed geofence falls back to the entrance QR or the desk, S5-09); the explicit-choice rule when two appointments or two patients match (S5-08, S5-17); DD3's hook. **The desk's `openVisit` walk-in path imports nothing from this task** (S5-15).

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | Self and desk check-in on one appointment produce **one** token; the second caller gets the first's token | Keep `appointment_state_conflict` for the second → the desk re-tokens a patient who is already in (S5-02), or the app shows an error to a patient the desk just served |
| A2 | Two concurrent self check-ins: exactly one claims; the other returns the same token | Read-then-write the status → two encounters, two V numbers, one patient |
| A3 | A patient actor can check in only an appointment in its accessible set | Check `patientId` only → any phone checks in any booking by id |
| A4 | A check-in for `serviceDate ≠ today` is still refused | Drop the guard → tomorrow's patient takes today's token |
| A5 | `check_in_source` and the credential are stamped; the desk path stamps `desk` and no credential | Stamp nothing → the skip audit cannot tell a proxy check-in from a real one (S5-11) |
| A6 | With two candidate appointments the call fails with `ambiguous_check_in` listing both; it never picks | Auto-pick the earliest → the wrong doctor's queue |
| A7 | The walk-in path's query count and p95 are unchanged (S1) | Add the hook call to `openVisit` → the load-bearing rule is broken for every walk-in |
| A8 | **(DD3)** After check-in with an advance ≥ the fee, `feeCovered` is true and `advanceOf` has fallen by the fee | Allocate outside the check-in transaction → a patient stopped at the consult door with money on their account |
| A9 | **(DD3)** A `revisit` check-in issues no invoice and touches no advance | Issue anyway → charge for a free visit; refund queue at the desk |
| A10 | **(DD3)** A walk-in with no advance is untouched by the hook | Issue an unpaid invoice on every check-in → the desk's dues flow is flooded with rows the cashier already handles |

### T3 — Live position and the patient-scoped topic — **CRITICAL**

`GET /me/appointments/:id/position` → `{ position, sessionStatus, reason? }` from `orderQueue` (DD4); the `appointment:<id>` topic space (DD5); deltas with reason classes.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A11 | The patient's position equals `listQueue`'s position for the same entry at the same instant | Reimplement the sort → the app and the desk disagree (S6-18) |
| A12 | The `appointment:` payload carries no other patient's id, name, token or summary | Forward the `queue.called` payload → every subscriber sees who was called |
| A13 | A connection cannot subscribe to `appointment:<id>` outside its accessible set | Guard by prefix permission only → any logged-in phone watches any appointment |
| A14 | A backward move carries a reason class | Push the number only → S6-13's silent growth |
| A15 | No minutes figure is ever emitted; a range appears only at position ≤ 5 | Emit `etaMinutes` → the promise the honesty problem forbids |

### T4 — Wayfinding from the resource tree — **ROUTINE**

`resolveWayfinding(appointmentId)` → the ancestor chain of today's scheduled room (DD6), rendered on the journey and printable on the token slip. A room with no floor ancestor renders the chain it has (S3).

### T5 — Session signals: doctor late, break, cancelled — **ROUTINE**

The doctor's desk gains *"running late by N minutes"* and *"on a break"* as a reason on the session (`out` / `not_started` + `delay_note`); the journey shows it; a patient-audience transactional template sends it **before the slot** (S5-06, S5). A session cancelled after check-in resolves every waiting entry with a message and a rebooking path (S6-19).

### T6 — Pre-consult uploads — **CRITICAL**

Upload, list, remove-before-consult; scanning; provenance on every read (DD7); the consult screen renders them under a *patient-supplied* band and never in the results area; the purge sweep on `kernel/worker`.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A16 | Every read path returns `patient_supplied: true` and the consult screen renders under the band | Return the bytes bare → G14: an uploaded photo of an outside report is read as a hospital result |
| A17 | A file over 2 MB, a sixth file, or a non-image/PDF MIME is refused | Trust the client's MIME → an executable in the record |
| A18 | An upload is visible only to the treating team (encounter's doctor + the desk) and the uploading household | Any `opd.visits.read` holder → PHI on arrival visible hospital-wide |
| A19 | The purge sweep removes rows past `purge_after` and appends an event; it never touches the encounter | Cascade → the visit loses history it never contained |
| A20 | A removed upload is gone from every read before the consult starts, and a consult that already started keeps its copy | Hard-delete after consult start → the doctor's basis for a decision vanishes |

### T7 — The pay-later exemption, the journey routes, and the e2e — **CRITICAL**

DD8 in 22c-C's sweep (the one line, plus its test here because the evidence is here); the desk's appointment list shows UNPAID on `checked_in` rows; `GET /me/appointments/:id/journey` assembling T3–T6; the e2e: *self-books pay-later → checks in at 07:00 → sweep at deadline skips them → desk sees UNPAID → cashier settles → hook allocates → consult gate passes*.

#### Assertion Book — T7

| # | Assertion | Mutant |
|---|---|---|
| A21 | A `checked_in` unpaid booking survives the 4-hour sweep | Sweep by `unpaid` alone → S4-09: the patient in the corridor is cancelled |
| A22 | A `booked` unpaid booking past its deadline is cancelled with reason `unpaid` and the slot returns | Skip the release → a dead booking holds a live slot |
| A23 | A geofence ping without a check-in does not exempt | Treat the ping as presence → the exemption is spoofable from home |

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6 — especially S1 (the walk-in p95, before and after) and S6 (who built the hook)
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review — **and the M3 milestone close**
