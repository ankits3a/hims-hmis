# The roster backbone — stress test, 2026-09-20

**Why it was run.** The owner, the same day: *"I am more concerned about building the top-class
backbone of the roster module, as all the modules of our HMIS — an agentic-AI hospital operating
system that uses AI agents as co-pilots to human users — are going to use it. Let's do a stress test
and then the implementation plan."*

**What was attacked.** Phase doc 20-U, the brainstorm (`00-BRAINSTORM.md`), Plan 20, and **T1 as
built** (PR #264: `roster_periods`, `roster_assignments`, the publication gate — 37 green tests, three
mutants killed). Six fresh reviewers, one lens each, read-only, told to drop what they could not
substantiate: **(C)** every consuming module · **(T)** time, concurrency, integrity, scale · **(H)** a
day in hell in an Indian teaching hospital · **(L)** law, privacy, accreditation · **(A)** the
agentic-AI backbone · **(N)** nursing and everyone who is not a doctor. 86 findings; the ones below
survived adjudication. Where reviewers disagreed, the ruling and its reason are given.

**The verdict in one paragraph.** T1's *gate* is sound and its *vocabulary is too small*. Green tests
and killed mutants proved the code does what T1 said; the stress test showed T1 said the wrong
thing in four places, each found independently by two or more lenses. **PR #264 is not merged**; it
is a draft, and its rework is tasks R1–R2 of the implementation plan. Nothing had been built on it,
the migration is unmerged, and that is exactly when this is cheap.

---

## 1. The four structural findings — each found by two or more lenses

### S1 · `role_key` is asked to be two things (C-1, N-3, H-10)
An assignment's `role_key` is a foreign key to the **RBAC** role. RBAC has `doctor`, `pharmacy`,
`anaesthetist`. It has no junior resident, no senior resident, no casualty medical officer, no staff
nurse, no security guard. Roster everybody as `doctor` and `whoIsOn("doctor", 02:14)` returns **every
doctor on any published roster in the building** — and because the resolver takes no scope, a
Medicine alert resolves to Surgery's resident if only Surgery has published October. Three
vocabularies were conflated: **cadre** (what payroll calls you), **RBAC role** (what you may do), and
**duty position** (what you answer as, tonight).
**→ ACCEPTED.** A `roster_positions` table (key, label, cadre, ladder rank, *eligible* RBAC role,
default mode, max presence hours). Assignments carry `position_key`, `department_id` and a
cover-scope. The resolver is **scoped**: `whoIsOn({ position, departmentId?, teamId?, locationId? }, at)`.

### S2 · Amending a month by copying the month loses amendments (C-3, T-1, T-5, T-15, N-2)
T1 amends a published roster by copying all of it into v2 and re-publishing. **(a) Lost update:** the
SR drafts v2 from v1; a swap drafts v3 from v1 and publishes; the SR publishes v2 — *v3's swap
silently vanishes*, no error. The evening-before holiday (D3) amends 26 unit rosters at 19:30, so
every open draft in the building becomes that trap. **(b) A same-night swap between two units can
never be published**, in either order: each new version names a person still live in the other
unit's old one. **(c) Scale:** a nurse floated from 3B to ICU at 02:00 copies ~20,000 rows and takes
one lock the whole department queues behind; ~14 M rows a year instead of ~0.7 M.
**→ ACCEPTED — the hybrid model.** Whole-period versions stay for the *bulk* acts (first publish;
re-plan the rest of a month). **Every small change is a row-level supersede inside the live period**:
a `roster_amendments` row (reason, approver, `after_the_fact`), and on each assignment `live_from`,
`live_to`, `amendment_id`, `lineage_id`. "As known at T" becomes a filter on the row. A cross-unit
swap is one transaction. A draft records `based_on_period_id` and **publish refuses a stale base.**

### S3 · The backbone was designed for doctors in units (N-1, N-5, N-6, N-7, N-8, H-10, C-2, C-4)
Nurses are the largest workforce and the design had no ward-anchored team, no shift definition, no
demand, no all-staff leave and no record of what was actually worked. Specifically:
- **No DEMAND.** Nothing says *"Ward 3B needs 4/3/2 nurses"*, so the validator cannot say "short by
  one", R-067's *"violating rosters don't publish"* has no row to be violated, R-182's third
  pharmacist has no row, and the who-is-on board's "holes" are undetectable.
- **No all-staff leave.** The validator "reads approved leave"; the only leave table is
  `opd_doctor_leaves`, keyed on an OPD doctor. A JR, an intern, a nurse cannot have a row. And RU-2
  ("we will build the full suite") removed the HR SaaS that R-071 had given leave to.
- **`opd_departments` is the only department table** — twelve OPD departments. The CRMI intern year
  posts to Community Medicine, Anaesthesia, Casualty, Forensic Medicine; none exists as a row.
- **No actuals.** The reliever does not come and the evening nurse stays the night (daily, in every
  hospital): the plan still names the absent nurse, and "who held 3B at 03:10" is wrong.
**→ ACCEPTED.** The vocabulary is generalised — **team, membership, position, shift definition,
requirement, slot, amendment, actual, absence, credential** — so that doctors-in-units and
nurses-in-wards are two instances of one model (§3). A kernel `org_departments` master is added
*beside* `opd_departments`, never instead of it.

### S4 · The owner's night rule is infeasible if nights are staffed unit by unit (H-main, H-2)
Twelve-hour nights, twelve hours' rest, one night in three: a unit with three JRs has one on night,
one resting, **one** for ward, OPD and theatre — and nobody on that one's weekly off. NMC's floor is
two JRs a unit. The feasibility line would be red for ~24 of 26 units on day one. What AIIMS, PGIMER,
CMC, KEM and the state colleges actually do: **the take unit works its emergency day; night cover
for every other unit's wards is POOLED at department level** (one JR a floor across five Medicine
units, one SR for the department); true shifts exist only in casualty, ICU, labour room, anaesthesia
and nursing; small departments take nights as call from the hostel. **Pooling is what makes the
owner's rule workable** — Medicine's fifteen JRs with two on at night is about one night in seven —
**and T1 could not represent it**: a slot carried one `unit_id`, and the ladder "that unit's JR on
presence" finds nobody at 02:00 for four units in five.
**→ ACCEPTED, and DECIDED under the owner's instruction *"follow the standard protocol followed in
other top teaching hospitals"*:** the shipped default is **department-pooled 12-hour nights + the
take unit's own team**; the 24-hour-duty pattern ships as a *template a HOD may choose*, with its
hours-per-week shown beside it (24 h at 1-in-3 ≈ 81 h a week, over the Task Force's 74). A slot gains
a **cover scope** (`team | department | location | hospital`) and the night resolver looks
location-and-pool first.

---

## 2. The rest, adjudicated

| # | finding | ruling |
|---|---|---|
| T-2 | two **published** periods of one scope may overlap (1–31 Oct and 15 Oct–15 Nov): uniqueness keys on the exact start instant | **ACCEPTED** — `EXCLUDE` on `(site, scope, tstzrange)` where published; period bounds must be IST midnights |
| T-7 | `published_at` comes from a caller-supplied clock — back-datable, and can precede a lock wait | **ACCEPTED** — stamped by the database inside the transaction; `CHECK superseded_at >= published_at` |
| T-8 | concurrent publishes return a raw 23505 or a deadlock 40P01, or the wrong sentence | **ACCEPTED** — one advisory transaction lock; publishes are rare, serialise them |
| T-3 | "no published roster covering the instant ⇒ static fallback" is undefined per position — either a silent outage or a gap hidden for ever | **ACCEPTED** — a period **declares the positions it answers for**; fallback only for an undeclared position |
| T-4 · C-9 | the resolver's btree walks every past month for ever (past rows stay effective) | **ACCEPTED** — gist on `(position, tstzrange)`; DB caps on window length; bounded look-back |
| T-9 · A-7 | sentences for humans carry UTC ISO strings (a 20:00 IST night reads `14:30Z`); codes are overloaded (`invalid_window` ×6); English only | **ACCEPTED** — one code per cause, `params` with `{utc, ist}` instants, the sentence rendered from `roster.refusal.<code>` in en + hi; the server's fallback sentence is in IST |
| A-1 · A-2 | **every non-user actor is refused**, yet the plan's own monthly auto-draft runs as `system`; `source` is caller-supplied and forgeable; a copy re-stamps every row with the copier | **ACCEPTED** — a `rosterActPolicy(actor, act)` matrix (§4); `source` derived from the actor; provenance columns preserved through copies; machine writes never touch a draft a human has edited |
| A-3 · L-11 | the HOD reads the draft at 10:00, a cell changes at 10:04, he publishes at 10:05 | **ACCEPTED** — publish takes the **content hash** the human reviewed; the same SHA-256 is stored per published version (BSA s.63 evidentiary hygiene) |
| A-6 | no what-if: an agent asked "who can cover?" must re-implement the rules | **ACCEPTED** — `simulate(base, deltas[]) → findings, candidates, excluded[{user, ruleCode, authority}]`, no writes |
| A-9 · C-8 | two period-level events force every consumer to diff two months | **ACCEPTED** — per-person `roster.duty_changed`, hole opened/closed, take handover, posting started/ended, rule overridden, mode entered/left. **Ids, codes and instants only; a test forbids free-text payload fields** |
| A-4 · L-13 | staff names and phone numbers are personal data too; the copilot's masker knows *patients* | **ACCEPTED** — before any roster copilot tool: a staff-name dictionary; tools never return phones, leave kinds, notes. **"Why can't she cover?" answers *unavailable*, never *on maternity leave*** (board 3 shows a leave reason — it is corrected when U5 is built) |
| H-4 · H-8 | no 2nd/3rd on call; the ladder only climbs **vertically** and rings one dead phone on two rungs (on-call faculty = unit head); `wheel_in` is never typed live at 02:00 so busy-skip misses the scrubbed SR | **ACCEPTED** — `call_tier`; a **lateral rung** (2nd on call → backup team's SR → department emergency SR) before unit head; rung de-duplication; a one-tap "scrubbed / busy" anyone can set; the theatre's **extension** as a contact; a kernel **busy-provider registry** so `kernel/alerts` never reads `ot_cases` (C-10) |
| H-1 · H-2 | intern changeover: names unknown on the 20th, no logins on the 1st; a day-one JR-1 counts as "JR presence" on a take night | **ACCEPTED** — **vacant position slots** (no user yet); membership judged at slot START; a **supernumerary** flag (interns never satisfy a requirement — CRMI); dated **rule profiles** per department ("lean period", approved once) instead of forty per-person overrides |
| H-7 | the only Professor takes three weeks' leave; "one head per unit" forces closing his headship, falsifying the NMC record; every HOD approval stalls | **ACCEPTED** — a separate **officiating** record, and dated **delegation** of approval authority (unit head, HOD, MS) |
| H-5 | holiday declared 19:30; D3 auto-withdraws tomorrow's theatre; 14 patients are fasting and the HOD wants to operate | **ACCEPTED** — the holiday door is **two-step**: the MS picks a pattern; each surgical HOD confirms proceed/cancel by a deadline; messages go after. An ad-hoc holiday **never advances** the Sunday/holiday overlay sequence |
| H-3 | a nine-day strike: residents are rostered-and-absent, not on leave; the ladder still starts at a JR who is on the pavement | **ACCEPTED** — skeleton mode v2: a bulk *abstaining* absence kind (not "leave" — it carries no-work-no-pay and course-extension consequences), the ladder starts at the **first staffed rung**, the mode **expires daily** with one-tap renewal, withdrawals are a per-department checklist |
| H-6 | the NMC assessor wants the **monthly department duty roster in the customary format**, HOD-signed, and today's unit-wise position statement | **ACCEPTED** — both prints join the inspection pack; a board answering from the pattern fallback says **"UNPUBLISHED — pattern"** and never attributes a duty to a named person no human published (L-11) |
| H-9 | "arrival instant" is gameable (held till 08:05; dumped at 07:55); readmissions, accepted referrals and polytrauma do not follow the take | **ACCEPTED as wording now, built in Plan 41** — `unitOnTake` **proposes**; the admission carries a reason (take · old case · accepted referral · transfer · faculty request), the instant is the server's casualty-registration stamp, co-managing units exist |
| T-10/11/12/14 | the pattern fallback can disagree with materialised windows; the no-gap gate runs only at publish and cannot see period seams; E6 makes one- and two-unit departments un-authorable; E1 passes even if the anchor is cast in UTC | **ACCEPTED** — one pure `expandCycle()` for both paths; take windows materialise on a **rolling 90 days** when the cycle is published; `overlay_index` persisted; the gap check is a **continuous invariant** and a `standup:check` row; E6 blocks only at ≥ 3 units; the tests are **07:59 and 08:00** |
| C-5 | `opd_doctor_schedules` (per doctor, per weekday) and a rolling unit cycle become two answers on one front-desk screen; OPD has no holiday concept, so bookings continue onto a declared holiday | **ACCEPTED** — U7 grows: schedule rows for unit departments are *generated from* the calendar; booking checks `roster_holidays` |
| C-6 | the resolver would ring people on approved leave, deactivated, or whose posting closed | **ACCEPTED** — the contract is *slots − approved absence − inactive − closed membership*; an empty rung moves on at once |
| C-7 | consumers need more than instant look-ups | **ACCEPTED** — `whoIsAt(location, at)`, `dutiesOf(user, from, to)`, `teamMembers(team, at)` (the treating team is the *membership*, not tonight's slots), `asKnownAt(T)`, `calloutList(at)` |
| L-1 · N-9 · L-10 | nothing ties duty to **registration validity, credentials or statutory named persons** (NABH HRM.11/12; PCPNDT registered person; AERB RSO) | **ACCEPTED** — `staff_credentials`; a requirement may name a credential; statutory persons come through a **provider registry** (roster still reaches into no module). Full privileging is its own later module; the *interface* is here |
| L-3 · L-8 | "weekly off, `authority: nmc`" overstates PGMER ("subject to exigencies of work"); nurses and technicians **are employees** and the Labour Codes have been in force since 21.11.2025 — yet T1 lets them be rostered with no statutory rule seeded | **ACCEPTED** — `authority` widens to `nmc · nmc_recommended · central_law · central_directive · court · accreditation · state · institution`; weekly off is *warn with a reason*; **non-doctor rostering stays switched off until the employee rule rows exist** (N-series gate) |
| L-9 | I13's "woman alone at night" rule is gender-keyed — a discrimination claim waiting | **ACCEPTED** — it is **location-based**: a flagged location needs two people or a security check-in, whoever they are |
| L-4 | the AEBAS "duty-evidence report" can read as manufactured attendance; NMC allows no retrospective updating, and now cross-reads HMIS against AEBAS | **ACCEPTED as framing (RU-3 stands)** — it is a **clinical activity extract**: per person, on request, every generation logged, each source record's `created_at` printed and late entries flagged, **rostered days with no activity shown too**, signed by the MS, the word "present" nowhere on it |
| L-7 | "service DLT templates are not blocked by DND" is half right; **robo-calls need advance notice to the access provider and the healthcare caller-ID route is unsettled** | **ACCEPTED — for the owner before buying the voice provider** (§5) |
| N-12 · T-13 | the 36-hour cap is global and lives only in code | **ACCEPTED** — DB checks (presence ≤ 36 h, any window ≤ 35 days); the position carries its own cap (a nurse: 14 h); **a planned slot over 24 h is a block; what actually happened — a flood, a hold-over — is an ACTUAL and is never refused** |

### Rejected, or deferred with a reason
| # | proposal | ruling |
|---|---|---|
| N-3b | **duty-scoped permissions** — the published roster writes a `temp_role_grants` row that expires at shift end ("the night in-charge is floor supervisor for the night") | **REJECTED for this plan; D7 stands.** Reviewer C argued the opposite — *keep the roster out of authorisation entirely* — and is right for a backbone: a roster defect would become a privilege escalation, silently, at 20:00. It is a good feature and a separate, owner-and-security decision on a roster that has first proved itself |
| A-1b | an `agent_grants` table | **DEFERRED** — it is a `kernel/auth` design. Until it exists **agents act only through the asking user's copilot, as drafts a human confirms**; named `system` jobs get the draft acts |
| A-12 · C-8b | a materialised `roster_now` table for 1,500 copilots | **REJECTED for now** — the rows are already materialised; slot-level events are the invalidation signal. Measure first |
| N-15 | outsourced housekeeping and security have no `users` row | **OWNER FACT, later** — agency headcount against a requirement, or no-login users. Money and procurement |
| L-6 | "retained 8 years" has no stated basis; obstetric and paediatric claims surface up to ~21 years later | **COUNSEL** — retention becomes per table with an `authority`; phones nulled at exit + N days; leave reasons purged early. The numbers are the lawyer's (§5) |

**Two of our own §2 citations did not survive the legal reviewer's second look** — the AEBAS office
memorandum of 03.09.2026 and the PGMSR amendment of 20.02.2026 could not be re-confirmed. They are
marked *unverified* in the phase doc; nothing in the design rests on either.

---

## 3. The vocabulary after the stress test

| concept | entity | doctors in units | nurses in wards |
|---|---|---|---|
| department | `org_departments` (kernel; links to `opd_departments` where one exists) | Orthopaedics | Nursing |
| location | `resources` (exists) | OPD room, theatre, casualty | ward, ICU hall, counter |
| team | `roster_teams` | `clinical_unit` ORTHO-U2 | `ward_team` 3B · `pool` float |
| membership | `roster_team_memberships` (+ `roster_officiating`, `roster_delegations`) | parent / rotation, grade, supernumerary | parent / float, grade, pattern offset |
| position | `roster_positions` | ward JR, unit SR, faculty on call, CMO | staff nurse, ward in-charge, night supervisor |
| shift definition | `roster_shift_defs` | take 08→08, OPD, night 20→08 | M, E, N, G |
| requirement | `roster_requirements` | a take window: ≥ 1 SR + 1 JR present, 1 faculty on call | 4 / 3 / 2; ICU 1:1; ≥ 1 ventilator-trained |
| period | `roster_periods` | October, ORTHO-U2 | October, Ward 3B |
| slot | `roster_assignments` | as T1, + position, cover scope, call tier, vacancy, lineage | the same table |
| amendment | `roster_amendments` | a swap, a cover | a float, a double duty |
| actual | `roster_actuals` | theatre times feed it | the shift muster, by exception |
| absence | `staff_absences` | PG 20 CL + 5 academic; projects into OPD leave | CL, EL, maternity, comp-off, night-off |
| credential | `staff_credentials` | council registration, SR tenure | council registration, ventilator, NRP |
| calendar | `roster_cycles`, `roster_holidays`, `roster_duty_windows` | OPD / OT / ward / take by unit | — |

**What of T1 survives unchanged:** the draft → published → superseded gate and its atomic takeover;
windows, never days; presence versus call; the `EXCLUDE` constraint and the sentence that names the
person; the schema-level tests that write underneath the domain code. **Its tests are ported, not
discarded.**

---

## 4. Who may do what — the matrix the policy function enforces

| act | user with the grant | the user's copilot | agent | named `system` job |
|---|---|---|---|---|
| read "who is on", own duties, what-if, explain | yes | yes | yes, scoped | yes |
| draft a **machine-origin** period and its slots | yes | — | later (needs agent grants) | **yes** |
| edit a draft a human has touched | yes | — | **never** | **never** |
| propose a cover / swap / split | yes | drafts; the human confirms | later | yes |
| accept a warning, override a rule | yes (HOD / delegate) | **never** | **never** | **never** |
| **publish**, amend, approve a swap or a leave | yes | **never** | **never** | **never** |
| declare a holiday or skeleton mode | MS / delegate | **never** | **never** | **never** |
| acknowledge or pass on an alert | yes — own; `on_behalf` names the human who did it | **never** | **never** | **never** |
| raise a nag about a hole | yes | — | ≤ *urgent*, rate-limited, killable | per the ladder's pacing |

Every machine write records actor type, actor id and run id; every human confirmation records who and
the content hash reviewed. `never` is enforced in one function, and an **absence test enumerates every
exported acting function against this table.**

---

## 5. For the owner — what the stress test moved onto your desk

1. **Nothing blocks the backbone.** R1–R9 of the implementation plan need no ruling.
2. **Before you buy the voice-call provider:** automated calls to staff sit in unsettled telecom
   regulation (robo-call notice to the operator; no caller-ID series yet allotted to healthcare).
   Ask the provider how they would carry *hospital-to-own-staff critical alerts* lawfully. WhatsApp
   and SMS are straightforward (opt-in captured when a phone is verified; DLT service templates).
3. **Five questions for the hospital's lawyer** — none urgent for the backbone, all needed before
   the ladder rings a phone or a nurse is rostered: (i) are JRs, SRs and interns *employees* or
   *students* in this State; (ii) which resident-hours regime to adopt — the Supreme Court hears
   *United Doctors Front* on 27.10.2026, NMC has reportedly told it enforcement is the State's and
   the hospital's, and our own hours ledger is discoverable; (iii) the retention schedule, table by
   table; (iv) whether the telecom rules treat staff alerts as commercial communication, and what
   the WhatsApp and LLM processor contracts must say; (v) who signs the clinical activity extract
   and what use of it before NMC is proper.
4. **Which State?** Every `state` rule row is a placeholder until you say.
