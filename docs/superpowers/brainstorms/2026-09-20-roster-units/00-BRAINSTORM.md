# The roster, and the unit system of a teaching hospital — brainstorm

**2026-09-20 · lane `roster-units` · FOR THE OWNER'S READING. Nothing here is built.**

The owner brought a specification written by Gemini — *"Unit-Based Roster & Rotation Engine"* — and
asked for a brainstorm before implementation, with leave to discard it. This document reviews it
against what this repository already holds, keeps what is right in it, and proposes the change to
make **before** anybody builds.

**The verdict in four lines.**

1. **Keep its central idea; discard its schema and its build plan.** The idea — a teaching hospital
   runs on *clinical units* with an OPD day, an OT day and a 24-hour admission ("turn") day — is
   true, it is how every Indian medical college works, and **it is missing from our own design.**
2. **It was written as if nothing existed.** We have a merged roster plan (Plan 20, PR #150), a
   90 KB duty-doctor brainstorm (department series doc 10), and live tables for users, doctors,
   departments, leave, rooms and beds. Gemini's paper duplicates five of them and contradicts three
   decisions already made.
3. **Its one endpoint gives the wrong answer for eight hours of every day** (§3, defect 1), and its
   own weekly table breaks its own rest rule (§3, defect 3). Both are design defects, not typos.
4. **The right change is an amendment, not a replacement:** Plan 20 stays as authored and gains a
   second half — **20-U, the unit system** — built on the same tables. §5 is that design; §7 is the
   build order; §8 is the four things only the owner can answer.

---

## 1. Ground truth — measured today at `origin/main` (`dbf15bef`)

| fact | measured |
|---|---|
| a roster plan exists | **Plan 20**, `plans/2026-09-06-phase1-20-workforce-roster.md`, merged as a FOR-APPROVAL doc, **not executed**. Seven tasks: periods + publication gate, a flagged resolver `whoIsOn(role, at)` with the static answer as fallback, CSV import, escalation destination as a row, coverage proposals a human approves |
| a duty-doctor design exists | **department series doc 10** — on-duty resolution, escalation ladder, handover, rounds, night-rest rules, 60+ edge cases. It sketches `roster_periods`, `roster_slots`, `roster_validation_findings` and a Plan 21 `duty-doctors` on top |
| rulings already on the register | **R-071** HMIS authors and publishes the roster; the HR SaaS owns attendance and payroll · **R-067** staffing ratios are roster gates, a violating roster does not publish, a breach never blocks an admission · doc 10 §3.9: post-night rest **≥ 12 h**, hard block, HOD override evented |
| people | `users` (every member of staff, `staff_code` EMP-nnnn, **`phone` already a column**), `role_assignments` (scope `hospital \| floor \| department`, `scope_id` *"opaque code until org masters exist"*) |
| doctors | `opd_doctors` (1:1 with a user, `code` DR-nnnn, `registration_no` **nullable**, one `department_id`) · `opd_doctor_schedules` (per **doctor**, per weekday, a room) · `opd_doctor_leaves` |
| departments | **`opd_departments` is the only department table.** The token *number series* is already per department per day (`opd_department_tokens`), but a **queue session is a DOCTOR-day** (`opd_queue_sessions`) — the desk still seats every patient with a named doctor |
| places | `resources` — kinds `floor, ward, hall, room, bed, theatre, store, bench, analyzer, device`. **There is no `unit` kind**, though doc 10 writes `unit_id → resources` as if there were |
| consumers of "who is on" today | `usersHoldingRole` — **Plan 20 measured 3 runtime files on 6 Sept; today there are 6.** New since: `kernel/desk/staff.controller.ts`, `modules/materials/counts.ts`, `modules/materials/transfers.ts`. (The materials pair ask *who is a custodian* — a question about the roll, not the shift, and should stay static. Re-measure at kickoff, as the plan says.) |
| IPD, admissions, ED | **none.** No module, no table. Plan 41 (ADT) and Plan 40 (ED) are unauthored, behind the IPD gate — and Plan 20 live is one of that gate's conditions |
| units, postings, turn days, teaching | **zero hits** in `apps/`. The word "unit" in our docs means a *ward*. |

**The last row is the finding.** Every document we have was written to the standing rule *"decide
as an Indian corporate hospital would."* A corporate hospital has consultants and wards. On
2026-09-06 the owner said *"as a medical institution with college"* — and a college hospital is
organised differently at the root. Gemini's paper is wrong in most of its particulars and right
about that.

---

## 2. What Gemini got right — and we did not have

**A clinical unit is a TEAM, not a place.** A professor-led firm — faculty, senior residents, junior
residents, interns — with beds allotted to it and *days* that belong to it. Doc 10 models a "unit" as
a ward in the resource registry; that cannot express any of the following, all of which are ordinary
in a teaching hospital:

- **The patient belongs to the unit that was on take when they arrived**, and stays that unit's
  patient until discharge — through three shift changes a day, whoever is rostered. *"Under
  Surgery Unit II"* is what the case sheet, the round, the discharge summary and the NMC inspection
  all say. Doc 10's resolver starts from a *primary consultant*; in a college the primary is a unit.
- **The week belongs to units.** Monday is Unit I's OPD, Unit II's theatre, Unit III's ward-and-
  teaching day. Our `opd_doctor_schedules` is per doctor per weekday — it cannot say *"whoever Unit I
  sends"*, which is how a college OPD table is actually staffed.
- **The intra-unit split.** On OPD day the unit never goes to OPD whole: somebody holds the ward,
  somebody carries the call. That is the unit's own daily decision, made by its SR, and it is the
  part of rostering that today lives on a whiteboard.
- **Postings move.** Interns rotate every 15–30 days, PG residents through allied departments
  monthly, a JR-1 becomes a JR-2 every year. Who was in which unit *on a given date* is a logbook
  fact, an NMC fact and a medico-legal fact.

Also right, and already ours: rest after a night duty, audited swaps, a backup unit for surge.

---

## 3. What is wrong with it — nineteen findings, the seven that matter first

**1 · Its only endpoint is wrong from midnight to 08:00 — every night.** The turn runs 08:00 → 08:00.
The paper's query is `roster_date = CURRENT_DATE AND is_turn_day`. At 03:00 on Tuesday that returns
**Tuesday's** unit; the unit on take is still **Monday's**, for five more hours. A road-traffic
admission at 03:00 is booked under a unit that is asleep at home. (And `CURRENT_DATE` on this server
is UTC, so between 00:00 and 05:30 IST it returns *yesterday* — which makes the answer accidentally
right for part of the night and is exactly the kind of bug that survives testing.) **Plan 20 D7
already ruled this: a shift is a WINDOW, not a day; the resolver takes an instant and never asks what
day it is.** Every date defect this repository has shipped has been a day-boundary defect.

**2 · Nothing enforces the one invariant that matters.** *At every instant, each admitting department
has exactly one unit on take.* `is_turn_day` is a boolean on each unit's row: two units can both be
true, or none can, and the database accepts either. The right shape makes overlap **unrepresentable**
(a Postgres exclusion constraint on the department's take windows) and makes a **gap** a finding that
blocks publication.

**3 · Its own weekly table breaks its own rest rule.** Unit 1 is on 24-hour take Monday and in
elective theatre Tuesday 08:30. Whoever held Monday night is — by the paper's Constraint 2 — barred
until 17:00. With three residents a unit needs one for the night, loses that one the next morning,
and must still staff a theatre, a ward and a call. **The template is infeasible for a small unit and
the paper never notices**, because it validates one assignment at a time. The validator has to read
the *template* and say, at authoring: *"this pattern needs at least N residents per unit; Unit III
has two."*

**4 · A week is the wrong cycle.** The paper itself lists departments with 2 and 5 units. Five units
do not tile six working days; real rotas roll (*Unit I today, II tomorrow…*) and drift through the
week. And the Sunday rule `(week_number % units) + 1` **jumps at every New Year** (ISO week 52/53 →
1) and can hand Sunday to the unit that just did Saturday — 48 hours straight. The general form is a
**cycle of N days anchored on a date**; "weekly" is merely N = 7.

**5 · It builds a second staff register.** `staff_profiles` with names and mobile numbers beside our
`users`; `departments` beside `opd_departments`; `nmc_registration_number UNIQUE NOT NULL` — which
**refuses every intern** (provisional registration, often pending), every nurse, technician,
pharmacist and duty manager. Our roster is for **all staff** (R-071; R-182 makes the third
pharmacist a roster gate), and the escalations that need it *today* are the duty manager, the on-call
radiologist, the anaesthetist and the lab's critical ladder. Gemini's design can answer none of them.

**6 · "Double booking" rejects the normal case.** A consultant on 24-hour call who also sits in OPD
is not double-booked; that is what on-call *means*. The paper's overlap check refuses it. Two kinds
of duty exist — **presence** (you are physically at a station) and **call** (you are reachable) —
and only presence × presence is a clash.

**7 · No draft, no publication, and `ON DELETE CASCADE`.** A half-typed roster starts answering *"who
do I call"* the moment a row lands (Plan 20 D3 forbids exactly this), and deleting a department
deletes years of duty history that labour law and NABH want kept for eight.

**The remaining twelve, briefly.**

| # | finding |
|---|---|
| 8 | `current_unit_id` is a mutable pointer; "history is logged" appears in prose and in no table. Postings must be **dated rows** |
| 9 | `unit_head_id` is a circular FK. Headship is a dated posting with a role, and *one head per unit at a time* is a constraint |
| 10 | designation is a Postgres ENUM on the person. JR-1 → JR-2 is an annual event; tutors, demonstrators, DNB trainees, non-academic SRs and every non-doctor have no value. Grade is a **fact on the posting**, text + check, as this repo does everywhere |
| 11 | rest is **8 h** in the code, **until 17:00** (9 h) in the prose, and **12 h** in our doc 10. One number, as rule data: 12 h |
| 12 | the validator is per-assignment middleware: it never re-runs on a swap, a leave or a template change, and two concurrent requests both pass its check-then-insert. Validation is a **pure function over the whole draft**, run at publish and at every amendment; the hard invariants are database constraints |
| 13 | `POST_DUTY_OFF` and `LEAVE` are stored *activities of a unit*. A unit does not take leave, and post-duty-off is **derived** from the night slot — stored, it drifts. Leave is read from `opd_doctor_leaves` |
| 14 | a swap names one allocation. A swap is **two** slots exchanged; a cover is one given away. Nothing checks the acceptor's grade, posting or the rest rule on *their* adjoining days, nor who may approve |
| 15 | "generates a 30-day month". Months are 28–31 days; a period is `[from, to)` |
| 16 | **AEBAS punch overrides.** Attendance is out of scope by ruling (R-071, Plan 20 §6). And AEBAS is NMC's system — this HMIS cannot override a punch in it and must not pretend to. What we *can* do is prove a professor was scrubbed at 09:10 (§8, Q2) |
| 17 | **Code Yellow auto-recall and auto-HOLD of theatres.** Plan 20 D4: *the system proposes, a human approves — no automatic reassignment, ever.* The trigger belongs to the ED/disaster plan (40). The roster's honest contribution is one published fact: *who is the backup unit right now* |
| 18 | beds: two `bed_count` integers and no link. Beds live in `resources`; allotment to a unit is a dated mapping. **And whose patient it is comes from the admission, never from the bed** — a full ward boards Unit II's patient in Unit III's bed every week |
| 19 | UUIDs, PG enums, Python pseudocode, FastAPI, `/api/v1/`. This repo is ULID text ids, text + check vocabularies, drizzle, NestJS, zod contracts. Cosmetic — but it means none of the SQL is usable as written |

**And the paper's blind spot: build order.** Its first deliverable is `current-turn-unit` "used by
Casualty for routing admissions". We have no casualty module, no admission and no bed board. It
would ship an endpoint with no caller while the six call sites that page every duty manager in the
building at 02:00 stay exactly as they are.

---

## 4. The reframe — four questions, four different rates of change

A roster is one word for four questions. They change at different speeds, different people answer
them, and Gemini's schema tangles them (`staff_profiles.current_unit_id`, `is_turn_day`).

| | the question | who answers | changes | today |
|---|---|---|---|---|
| **A** | **Who belongs where?** postings: user ↔ unit, grade, dates | HOD / dean's office | monthly, yearly | nothing |
| **B** | **What does each unit do, when?** OPD / OT / ward / **take** / backup | HOD, once; then it rolls | per term | nothing |
| **C** | **Which person is where, when?** the slot | unit SR, nursing in-charge, duty manager | weekly, daily | Plan 20 T1 (unbuilt) |
| **D** | **Who do I tell, right now?** | the *system*, from A + B + C | every call | `usersHoldingRole` — everyone on the roll |

Plan 20 is **C and D**. Gemini's real contribution is **A and B**. Nothing has to be thrown away on
either side: A and B are new tables beside Plan 20's, and D gains one more resolver.

---

## 5. The proposed design — DECIDED unless marked otherwise

Module: `roster`, kernel-adjacent, app-and-worker — Plan 20 D1, unchanged. Ids, audit columns,
vocabularies and events follow the house style.

### A · Units and postings

- **`clinical_units`** — `department_id` (→ `opd_departments.id`, plain text), `code` (`SURG-U2`),
  `name`, `sanctioned_beds`, `valid_from/to`. **A team, not a `resources` kind.** A department with
  no units (anaesthesia, radiology, pathology, nursing) simply has no rows here and rosters at
  department level — units are optional, so a corporate-style department and a college-style one
  live in the same module.
- **`unit_postings`** — `user_id`, `unit_id`, `grade` (professor … intern; text + check, extensible),
  `role_in_unit` (`head | faculty | senior_resident | junior_resident | intern`), `[from, to)`,
  `kind` (`parent | rotation`), `source` (`manual | import`). Two exclusion constraints: **one parent
  posting per person at a time; one head per unit at a time.** A rotation (a surgery JR doing a
  month in ICU) overlays the parent posting and wins for its dates. JR-1 → JR-2 is a new row.
- **`unit_bed_allotments`** — `unit_id`, `resource_id` (a bed or ward), `[from, to)`. Used for the NMC
  return and for default placement. **Never used to decide whose patient it is.**
- **DECIDED: postings' system of record is HMIS.** A posting decides who is paged and, later, who may
  open a chart; the academic side *reads* it. (§6.)
- **DECIDED: a posting grants no permission in this phase.** Tempting — "posted to Unit II ⇒ sees
  Unit II's patients" — and it would make a CSV import a privilege-escalation path. Named as a seam
  for the IPD cluster's treating-team rule; not built here.

### B · The unit calendar

- **`unit_cycles`** — per department: `cycle_days` (any N), `anchor_date`, `version`,
  `draft | published | superseded` (the tariff-version shape again).
- **`unit_cycle_entries`** — `day_index`, `unit_id`, `activity` (`opd | elective_ot | ward_teaching |
  take | backup`), `start_minute`, `duration_minutes`. **Sundays and gazetted holidays are an overlay
  sequence with its own anchor** — never a week-number formula.
- **`unit_duty_windows`** — the cycle **materialised at publish** into real `[starts_at, ends_at)`
  instants per period. Nothing computes a rotation at read time, so the 03:00 answer is a row, not
  arithmetic. **Exclusion constraint:** within one department, `take` windows cannot overlap.
  **Publish gate:** no gap in `take` coverage across the period, for every department marked
  *admitting*.
- **Resolver `unitOnTake(departmentId, at)`** and **`backupUnit(departmentId, at)`** — instant in,
  unit out, same flag-and-fallback discipline as `whoIsOn`. The caller always supplies the instant
  (Plan 20 spike 1): a resolver with its own clock is how a building gets two answers.
- A one-off change (Unit II takes Unit IV's Diwali turn) is an **amendment to published windows** —
  new rows, old rows superseded, never edited; approved by the HOD.

### C · Slots — Plan 20 T1, with three columns it did not have

`roster_assignments` as authored (user, role key, window), plus **`mode`** (`presence | call`),
**`unit_id`** (nullable) and **`location_resource_id`** (nullable: the OPD room, the ward, the
theatre). Exclusion constraint on **presence × presence** per user; call may overlap anything.

**The intra-unit split is a PROPOSAL, never an assignment** — Plan 20 D4 extended. For each unit
window the proposer reads a small rule set held as data (*OPD day: head + one faculty + one SR + one
JR to the OPD rooms; one JR + one intern hold the ward; one SR carries the call*) and the unit's
current postings minus leave and post-night rest, and drafts slots. The unit's SR edits and submits;
the head or HOD publishes. Gemini hard-codes this split inside the generator; as data it survives
the first department that does it differently, which will be the second one.

### The validator — a pure function over a whole draft, findings as rows

`block | warn`, every accepted warning carries who and why (`roster_validation_findings`, doc 10).
Rules are data with institutional defaults:

- presence overlap · slot during approved leave · slot in a unit the person is not posted to (warn)
- **post-night rest ≥ 12 h before any presence slot** — block; HOD override, evented
- ≤ 1 night in 3 for PG residents · one weekly off · max 12 h scheduled + 1 h handover
- every `take` window has at least one SR-grade and one JR-grade **presence** slot and one faculty
  **call** slot — block
- R-067 ratios where the department declares them
- **template feasibility, at cycle authoring:** given the unit's headcount by grade, can this cycle be
  staffed without breaking the rules above? Reported *before* anybody drafts a month of it (defect 3).

It runs at publish, at every swap and amendment, and when leave is approved into a published period
— that last one raises a coverage gap to the unit head; it does not silently unpublish anything.

### Swaps and covers

Request → the counterpart accepts → the validator re-runs over **both** people's adjoining windows →
unit head approves (HOD if across units) → new slots with `swap_of_slot_id`, the old ones superseded.
A **cover** is the one-sided form. The 19:50 WhatsApp swap that nobody entered (doc 10 B3) is met by
Plan 21's unrostered check-in, not by pretending people will always ask first.

### D · What the building asks

`whoIsOn(role, at)` (Plan 20 T2) · `unitOnTake(dept, at)` · `backupUnit(dept, at)` ·
`unitTeam(unit, at)` — the people on a unit's slots at that instant, in ladder order. Doc 10's
`resolveDoctor(patient, need, at)` then reads, for a college department: **admitting unit → that
unit's JR on presence → its SR → its faculty on call → unit head → HOD → duty manager**, the duty
manager remaining the rung that is never removed.

---

## 6. "Academic and Hospital" — where the line goes

The owner's phrase names two systems. DECIDED, planner, overturnable:

- **The teaching timetable is not ours** — batches, topics, lecture halls, student attendance, the
  CBME logbook itself. That is a college ERP's work (buy, not build — the same ruling as HR/payroll).
- **Faculty teaching commitments come IN as busy-windows.** A professor timetabled for an 08:00
  lecture cannot be first surgeon at 08:30, and only a roster that can see both will say so. They
  import as `presence` slots with `source = academic` (CSV first; an API when an ERP exists) and are
  read-only here.
- **Postings and the unit calendar go OUT.** The academic side needs *which unit has OPD / theatre /
  ward-teaching on which day* to post a UG batch for clinics, and *who was posted where, when* for
  intern and PG logbooks. One read-only export. Doc 10 F10 already has teaching-round attendance by
  badge scan; that feeds the same export.
- **Students are not staff.** A UG student gets no slot and no login from this module.

---

## 7. Build order — the change to make before implementation

1. **Plan 20 T1–T7 as authored**, with two amendments: T1's table gains `mode`, `unit_id`,
   `location_resource_id` now (nullable columns are free today; a retrofit onto a live table is a
   migration and a census change later); and the ground truth is re-measured — three call sites have
   become six, of which the materials pair should stay static.
   *This alone fixes the 02:00 problem for the duty manager, the radiologist on call, the
   anaesthetist and the lab ladder — the consumers that exist.*
2. **20-U1 · units and postings** — tables, the two exclusion constraints, CSV import validated whole
   before the first write, an admin screen. No resolver.
3. **20-U2 · the unit calendar** — cycles, materialised windows, the overlap constraint and the
   no-gap gate, `unitOnTake` / `backupUnit` behind the flag. **The fail-first tests are Gemini's
   defects:** the 03:00 instant; two units on take refused by the database; a five-unit cycle across
   a New Year; Sunday never following that unit's own Saturday.
4. **20-U3 · the validator's unit rules**, template feasibility first.
5. **20-U4 · the split proposer** and the unit SR's screen. *This is the screen the hospital will
   actually live in, and it deserves a design board before a build* — a month grid per unit, the
   findings beside it, publish as a deliberate act.
6. **20-U5 · the first consumer that exists today: OPD — read-only first.** The unit calendar can
   tell the front desk *"Medicine OPD today is Unit I: these four doctors, these rooms"*, and the OPD
   day report (#257) can carry the unit. It proves B and C in production months before IPD exists.
   **What it must NOT do in this step is change how a patient is queued:** a queue session is a
   doctor-day and `opd_doctor_schedules` is per doctor; letting the desk register to *"Unit I,
   whoever is at the table"* is a change to the `opd` module's session model — a module nearly every
   lane imports — and is its own phase doc, written after the read-only step has run for a month.
7. **20-U6 · swaps and covers.**
8. **Later, in their own plans:** Plan 41 (ADT) stamps `admitting_unit_id` on the admission from
   `unitOnTake(dept, arrival instant)` — the instant of **arrival**, not of data entry, or the 07:55
   arrival typed at 08:10 goes to the wrong unit. Plan 40 (ED) routes by it and owns Code Yellow.
   Plan 21 (duty-doctors) builds check-in, handover and rounds on the slots.

**Not built, by decision:** attendance, AEBAS, payroll (R-071) · automatic recall, automatic theatre
hold, automatic reassignment of anybody (D4) · optimisation / auto-generated "fair" rosters (spec
§11.19-E fix 7 defers it; a proposer that a human edits is enough until the hospital has rosters
worth optimising) · permissions from postings.

---

## 8. For the owner — four questions; none blocks steps 1–3

1. **Procurement — is a college ERP bought or chosen?** It decides whether teaching commitments
   arrive by CSV or API. *Default: CSV, and nothing waits for it.*
2. **Law — AEBAS.** HMIS will not touch attendance. Do you want a **duty-evidence report** — *"Dr X:
   theatre record shows scrubbed 08:52–11:20"* — for faculty to attach to a regularisation request?
   It is cheap once OT and labour-room records exist; it is also a document the hospital hands a
   regulator, so it is yours to rule. *Default: not built.* (The 09:00–09:30 punch window in
   Gemini's paper is unverified; whatever NMC's current rule is, it is an attendance rule.)
3. **Law — staff phone numbers.** Plan 20 §7 left open whether an on-call person's number lives
   here. Measured today: **`users.phone` already exists.** The open question is therefore narrower —
   may the *escalation ladder* use it to telephone or SMS someone, and for how long is it retained
   after they leave (DPDP)? *Default: in-app alerts only, as now.*
4. **Facts only you hold.** Per department: how many units are sanctioned *today*, and at what stage
   is the college (LoP, first batch, PG seats)? It changes no table — units are data — but it decides
   which department is 20-U's pilot. *Suggested pilot: the department with the fewest units and a
   daily OPD — a two-unit department exercises every rule and can be checked by eye.*

---

## 8A. RULED by the owner, 2026-09-20 — this section overrides §6 and §8 where they differ

| # | ruling | what it changes |
|---|---|---|
| **RU-1** | *"This is a medical college & hospital. A teaching hospital, so we need to follow NMC guidelines."* **150 MBBS seats**; units are sanctioned in every department today per the NMC norm for that intake | the unit system is not an option layered on a corporate model — it is the model. The NMC unit table for 150 seats becomes **seed data** for `clinical_units` (phase doc 20-U §2), and NMC's rules (PGMER duty hours and leave, CRMI intern rotation, AEBAS) become the validator's default rule set |
| **RU-2** | *"ERP is not bought yet, we will build the full suite by our own."* | **§6's first bullet is REVERSED.** The teaching timetable is ours to build, later, as its own module. Consequence for the roster now: a teaching commitment is a **native slot kind**, not an import from somebody else's system — `source = academic` stays, the CSV door stays as the interim, and the slot table must be able to carry a batch, a venue and a topic reference without a migration when the academic module arrives. Students remain not-staff |
| **RU-3** | **The AEBAS duty-evidence report: YES.** | a task in 20-U. Read-only over records that already exist (theatre case times, roster slots, later labour room and ED). HMIS still never writes to, overrides or imitates AEBAS — it produces the paper a faculty member attaches to a regularisation request |
| **RU-4** | **The escalation ladder, per person:** app notification (the mobile app later; **Chrome's notification system for now**) → not acted on → **WhatsApp** → not acted on → **SMS** → not acted on → **automated phone call** | answers §8 Q3: the ladder **may** use `users.phone`. It also defines something the kernel does not have: today `notifications.rung` climbs WhatsApp → SMS on **delivery failure**, and `alerts` records `read_at` only. The owner's ladder climbs on **no ACTION** — so an alert needs an *acknowledged* state, an ack must be possible **from every channel** (tap, WhatsApp button, SMS reply, keypress on the call), and a voice adapter must exist. Phase doc 20-U §6 |
| **RU-5** | *"Always consider the edge cases, because this is India."* | the edge-case register is a first-class section of every roster phase doc, and it names the Indian ones — a holiday declared the evening before, a residents' strike, a bandh, election duty, an NMC surprise inspection, a phone that is switched off, shared, or has no data |
| **RU-6** | *"Cutting-edge … smooth and frictionless and lower learning curve."* | the roster screens get a **design board the owner signs off before any screen is built** (the Desk One / Bay One method). The substrate — tables, resolvers, validator — needs no board and starts now |

## 9. Edge-case register — what the phase doc's tests must name

| # | case | expected |
|---|---|---|
| E1 | admission at 03:00 Tuesday | unit on take is **Monday's** |
| E2 | arrival 07:55, entered 08:10 | unit by **arrival** instant; both instants stored |
| E3 | two units on take for one department, same instant | the database refuses the row |
| E4 | published period with a 4-hour take gap | publication blocked, the gap named |
| E5 | 5-unit cycle across 31 Dec → 1 Jan | sequence continues; nobody repeats, nobody is skipped |
| E6 | Sunday overlay lands on the unit that held Saturday | validator blocks at cycle authoring |
| E7 | unit with 2 JRs on a cycle that needs 3 | feasibility finding before any month is drafted |
| E8 | consultant on 24 h call + OPD 09:00–14:00 | allowed (call × presence) |
| E9 | JR night 20:00–08:00, then 09:00 OPD | blocked; HOD override evented with reason |
| E10 | swap makes the *acceptor* break the rest rule two days later | swap refused, the rule named |
| E11 | leave approved into a published period | roster stays published; coverage gap raised to the unit head |
| E12 | intern posting ends mid-period | their later slots become findings; the proposer stops offering them |
| E13 | surgery JR on a month's ICU rotation | resolves on ICU's roster, **not** their parent unit's ladder |
| E14 | unit head on leave | acting head is a dated posting; the ladder uses it; one head at a time still holds |
| E15 | unit dissolved / merged (NMC re-sanction) | `valid_to` set; history and that unit's in-patients keep resolving |
| E16 | flag on, nothing published for next week | static fallback, and `standup:check` RED (Plan 20 T7) |
| E17 | cycle republished mid-period (v2) | windows already begun finish on v1 (doc 10 B7) |
| E18 | Unit II's patient boarded in Unit III's bed | the ladder follows the **admission's** unit |
| E19 | professor's 08:00 lecture (imported) vs 08:30 first case | presence × presence finding |
| E20 | department with no units (radiology) | rosters at department level; `unitOnTake` answers *no units*, not an error |
| E21 | intern with no registration number; a nurse; a pharmacist | all rosterable — the roster keys on `users`, never on a council number |
| E22 | night slot crossing IST midnight, and the month boundary | one slot, one window; a period is `[from, to)` in instants |

---

## 10. What this document changes

- **Plan 20** gains §5-C's three columns in T1 and a re-measured ground truth; otherwise stands.
- **A new phase doc, "20-U — the unit system"**, is authored from §5–§9 once the owner has read this.
- **Doc 10 (duty-doctors, Plan 21)** owes one correction when next opened: its "unit" is a ward; in
  this hospital a unit is a team, and its ladder starts at the admitting unit.
- **Gemini's specification is not carried forward as a build input.** Its domain picture (§2) is; its
  schema, endpoint, pseudocode and handoff prompt are not.
