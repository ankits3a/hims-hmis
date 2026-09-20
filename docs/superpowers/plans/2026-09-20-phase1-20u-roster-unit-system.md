# Phase 20-U — The roster of a teaching hospital: units, the take, the month, and the ladder that reaches a doctor

**Authored 2026-09-20 in lane `roster-units`. The owner said *"let's build"* the same day; his six
rulings are RU-1…RU-6 in `brainstorms/2026-09-20-roster-units/00-BRAINSTORM.md` §8A.**
**Screens are gated on the owner signing off the design boards (§5). The substrate is not.**

This is the second half of Plan 20. Plan 20 (`2026-09-06-phase1-20-workforce-roster.md`) stands as
authored — periods, the publication gate, `whoIsOn(role, at)` behind a flag with the static answer
as fallback — with the one amendment in §7 T1. This document adds what a **medical college** needs
and Plan 20, written to the corporate-hospital rule, did not know to ask for.

---

## 1. Why this phase, in the owner's words

*"A cutting-edge roster register module that's smooth and frictionless and lower learning curve."*
*"Always consider the edge cases, because this is India."*

Three promises follow, and every task below is answerable to them:

1. **The roster writes itself; people only handle exceptions.** The HOD sets a pattern once. Every
   month after that is *drafted by the system* from the pattern, the postings and approved leave.
   The unit's SR reads a finished draft and fixes what is flagged — she never starts from a blank grid.
2. **Every problem is a sentence with a button.** No codes, no `VIOLATION_FATIGUE_SAFETY_RULE`. *"Dr.
   Kavita is on night duty Monday and needs 12 hours' rest"* — and beside it, the fix, one tap.
3. **Nobody has to open the app to be reached, or to answer.** Tomorrow's duty arrives on WhatsApp at
   19:00. A critical alert climbs app → WhatsApp → SMS → a phone call (RU-4) and can be answered
   from whichever one it reached.

---

## 2. NMC ground — what the regulator fixes, and what it leaves to the college

Researched 2026-09-20 from the primary PDFs on nmc.org.in (gazette pages read as images, because
OCR mangles digits). **The headline: the regulator fixes far less than everybody assumes — including
Gemini's paper, and including this hospital's own shorthand.** What NMC does not fix is *configuration*,
and the rule row says so (D1).

### 2.1 What UG-MSR 2023 fixes for 150 seats — verified, primary (Gazette 16.08.2023, Sch. I B.1.2, Sch. II)

| department | beds | Prof | Assoc | Asst | SR | units *implied* |
|---|---|---|---|---|---|---|
| General Medicine | 150 | 1 | 4 | 5 | 5 | **5** |
| General Surgery (≥ 10 % paediatric surgery) | 150 | 1 | 4 | 5 | 5 | **5** |
| Paediatrics | 75 | 1 | 2 | 3 | 3 | **3** |
| Orthopaedics | 60 | 1 | 2 | 3 | 3 | **3** |
| Obstetrics & Gynaecology | 75 | 1 | 3 | 4 | 4 | **4** |
| ENT | 20 | 1 | 1 | 2 | 2 | **2** |
| Ophthalmology | 20 | 1 | 1 | 2 | 2 | **2** |
| Psychiatry | 15 | 1 | 1 | 1 | 1 | **1** |
| Dermatology | 10 | 1 | 1 | 1 | 1 | **1** |
| ICUs (aggregate; no sub-split given) | 30 | | | | | |
| **Total** | **605** | | | | | **26** |

Also fixed: OPD ≥ **1,200 a day** (8 per seat); **9 major theatres**, one minor per surgical
specialty, **2 emergency theatres 24 × 7**; bed occupancy ≥ 80 %; casualty *"managed by relevant
departments 24x7 by rotation"*; anaesthesiology 1+3+5 faculty, 4 SR; radiodiagnosis 1+1+2, 3 SR.

**The total is 605, not 610** (the June 2023 *draft* said 615 and still circulates). Respiratory
Medicine has no row in the final table; its faculty count under Medicine (FAQ Q8).

**⚠ UG-MSR 2023 DROPPED THE UNITS TABLE.** No beds-per-unit, no units-per-department, no unit
composition. Its only sentence about units: *"unit of the teaching departments should have at least
02 (two) Junior Residents or postgraduates / M.O.s for patient care."* The **"units implied"** column
above is ours — one unit per sanctioned SR — and it reproduces the superseded MSR 2020 table
(5/5/3/3/4/2/2/1/1, plus Respiratory 1) exactly. **So U1 seeds this as a DRAFT each HOD confirms; it
is not a regulator's number and the screen must not present it as one.** (Owner, §10.2.)

Where a unit *is* still defined — and binding the day this college runs PG courses — is **PGMSR-2023**
(as amended 20.02.2026), footnote 2: the first unit headed by a Professor with one Associate and one
Associate/Assistant Professor; later units may be headed by an Associate Professor, with two other
faculty; **one SR per unit**; 20 / 30 / 40 beds per unit for 2 / 3 / 5 PG seats; *"every Unit will
perform minimum three major and six minor surgeries on operation day of the Unit"*; PG surgical
trainees in theatre *"at least two full days in a week."*

### 2.2 What NMC says about time — and the two things it does NOT say

| topic | what the text says | consequence here |
|---|---|---|
| **punch window** | **There is none.** No 09:00–09:30, no time window, no minimum hours in any NMC document. 2022 guidelines 4–7: the *college* notifies office timings; *"AEBAS is only an IT platform."* Gemini's Constraint 1 is an invention | shift and office timings are per-institution configuration |
| **AEBAS today** | face authentication on the mobile app only (fingerprint ended 01.05.2025, wall devices 01.10.2025), within **100 m** of the registered GPS point; applies to faculty, tutors, SR, JR; NMR/SMR number mandatory since 03.09.2026 | a surgeon scrubbed at 09:10 can mark attendance on his phone when he is out — the "emergency override" problem is smaller than it was |
| **75 % attendance** | UG-MSR 2023 §3.2: ≥ 75 % of working days, *excluding vacations*, for faculty and residents | a **leave-approval warning**: *"this leave would take Dr. X below 75 % for the quarter"* (`authority: nmc`, warn) — a projection from the roster, not an attendance system |
| **⚠ leave, tours, holidays in AEBAS** | notice 18.06.2024: must be entered ***in advance — no retrospective incorporation/updation is allowed*** | **new task U8b.** The roster knows every approved leave, deputation and holiday *before* it happens. It produces the daily list: *"enter these in AEBAS today."* D3's evening-before holiday is on that list the same evening — the one case where an hour's delay costs every faculty member a day |
| **resident hours** | **No binding numeric cap exists.** PGMER 2023 §5.2(ii): *"reasonable working hours… reasonable time for rest."* NMC's 2024 Task Force **recommends** ≤ 74 h a week, ≤ 24 h at a stretch, one day off. The 1992 Residency Scheme (12 h a day, 48 h a week) was, in the Task Force's own words, *"not implemented"*; a Supreme Court petition to enforce it is pending, no order | the night rule is the **institution's**, and the owner's to set (§10.3). The rule rows cite the Task Force as `recommended`. The number is one config value — and the case is pending, so it must stay one |
| **PG leave** | PGMER §5.5 + FAQ: **52 weekly offs + 20 casual + 5 academic** a year; maternity/paternity per Government rules; 80 % attendance to sit the exam; excess leave extends the course | leave kinds and balances per posting-year; weekly off is a validator rule with `authority: nmc` |
| **District Residency** | PGMER §5.2(xv): **3 months**, residential, in semester 3–5; night duties there; leave sanctioned by the DRP coordinator | every MD/MS JR leaves the parent unit for a quarter of year 2 → a `rotation` posting to an external site (I11), visible on the unit's **term-long** feasibility line |
| **interns** | CRMI 2021: 52 weeks — Community Medicine 12 · Medicine 6 · Surgery 6 · OBG 7 · Paediatrics 3 · Orthopaedics 2 · ENT 2 · Ophthalmology 2 · Psychiatry 2 · Anaesthesia 2 · Casualty 2 · Dermatology 1 · Forensic 1 · electives 4. **15 days' leave** in the year; absence beyond it is **repeated in the department where it occurred** | **the intern year writes itself**: U1 generates each batch's 52-week posting plan from this table, staggered so every unit has interns every week. An over-limit absence produces the extension posting, in the right department |
| **tenure and age** | faculty ≤ 70 years; SR ≤ 45 years and **≤ 3 years in the post** (Faculty Regulations 2025) | a posting that outlives its holder's eligibility is a finding months ahead, not on the day |
| **OPD / OT / take days per unit** | **nothing.** No NMC text fixes them | the unit cycle is wholly the college's configuration — which is why B is data |

Sources (all nmc.org.in): UG-MSR 2023 gazette `…/EsC1D3C4pllbq186EDqZxfN01cHjDZdOAXAK1Bea.pdf` · PGMSR-2023
amended `whats-new/download/961` · PGMER 2023 `…/V2DvjM4NiDLYroNAyPmg0KK95sLUTMnWbjTdcDO2.pdf` and its
FAQ · CRMI 2021 `…/Lpv9Va5WsAzpQmISmwAMWmsefK2nOEroAdNZkVJC.pdf` · AEBAS circular 18.10.2022
(`download/679`), notices 18.06.2024 (`512`), 16.04.2025 (`106`), 26.09.2025 (`317`), OM 03.09.2026
(`1022`) · Task Force report 14.08.2024 (`444`) · Faculty Regulations 2025 (`70`).
**Unverified, and marked so:** any explicit NMC clause against serving two colleges (only the
"full-time" requirement was found); any NMC-prescribed vacation split; the 1992 directive's primary text.

---

## 3. Ground truth in the code — measured 2026-09-20 at `origin/main`; re-measure at kickoff

The brainstorm's §1 table stands. Added today:

| fact | measured |
|---|---|
| notify providers | **`console` only.** `adaptersFor()` in `kernel/notify/adapters.ts` has one case. No WhatsApp or SMS message has ever left this building; both channels log a line |
| notify channels | `"whatsapp" \| "sms"`. **No `push`, no `voice`.** |
| what makes the channel ladder climb | **delivery failure** (`notifications.rung`, D6). Not silence from the human |
| what an alert knows about its reader | `alerts.read_at`. **There is no acknowledged state**, and `read` is set by opening the bell |
| browser push | **none.** No service worker, no `PushManager`, no `Notification.requestPermission` anywhere in `apps/web/src`. The bell updates over the realtime socket, i.e. only in an open tab |
| theatre times, for RU-3 | `ot_cases` holds `surgeon_id`, `anaesthetist_id`, `wheel_in`, `incision`, `wheel_out` — the AEBAS evidence report can be built for theatre work **today** |
| the copilot | `kernel/copilot/catalog.ts` is a tool catalogue; roster questions register there, no new machinery |
| the Doctor Desk skeleton | the owner-approved board (`docs/design/2026-09-18-doctor-desk/Tower.dc.html`) already lists **Roster**, **Team**, **Handover**, **Teaching** under UNIT, and its right column already has *Today's Schedule* and *Unit Team (Today)* — both are readers of this phase |

---

## 4. Decisions — DECIDED (planner, under the 2026-08-28 mandate) unless marked OWNER

Brainstorm §5's design stands: **A** postings · **B** the unit calendar, materialised · **C** slots with
`mode presence|call` · **D** resolvers · a pure validator whose findings are rows · the split is a
proposal. Added or sharpened here:

- **D1 — The default rule set is NMC's where NMC speaks, and the institution's where it does not,
  and the rule row says which.** Every validator rule carries `authority` (`nmc | state | institution`)
  and a citation. An inspector, or a resident's association, can be shown *why* the system refused.
- **D2 — Drafting is automatic and monthly; publishing is a human act with a deadline.** On the 20th
  the system drafts next month for every unit. Unpublished by the 25th → the unit head is nudged; by
  the 28th → the HOD. **An unpublished month never leaves the building uncovered:** the resolver falls
  back to the unit *pattern* (we still know which unit is on take) and then to Plan 20's static
  answer. `standup:check` goes RED for that unit.
- **D3 — The holiday calendar is data with a same-day door.** Gazetted holidays seed yearly. **A
  holiday declared the evening before** (it happens every year) is one act by the medical
  superintendent: *"tomorrow is a holiday"* → OPD and elective-theatre windows for that date are
  withdrawn by an amendment, take and nights are untouched, everybody affected is told, OPD
  appointments are surfaced to the front desk as a list to re-book. Nothing is deleted.
- **D4 — Mass absence is a MODE, not a thousand findings.** A residents' strike, a bandh, a flood: the
  MS declares *skeleton mode* for a department or the hospital with a reason. The validator's
  ratio and rest rules drop from `block` to `warn` **for faculty and consenting staff only** (the
  12-hour rest rule for a resident who is actually working a night is never relaxed silently — the
  override is per person, named, evented), elective windows are withdrawn, and the who-is-on board
  says SKELETON in red. Leaving the mode is also an act. Every slot worked under it is stamped.
- **D5 — The roster is printable, and prints itself.** 20:00 and 08:00, per ward and for casualty,
  with phone numbers (doc 10 C1). The page is the downtime kit for "who do I call".
- **D6 — What a person sees of another person.** Anyone rostered can see *names and duties* of their
  department. **Phone numbers are shown only on the who-is-on board and only for people on duty at
  that instant**; leave *reasons* are visible to the approver alone. (DPDP: purpose limitation.)
- **D7 — A posting never grants a permission** (brainstorm §5-A), restated because the screens will
  make it tempting.
- **D8 — Teaching is a native slot kind** (RU-2). `kind = teaching`, `mode = presence`, with nullable
  `batch_ref`, `venue_resource_id`, `topic` — enough for the clash check now, and for the academic
  module to own later without a migration on a live table.
- **D9 — Fairness is shown, never enforced.** Nights, Sundays and festival days per person per term,
  beside the grid. The proposer balances them; a human may unbalance them; the numbers stay visible.
  A roster that is provably fair is the cheapest grievance procedure a college can have.
- **D10 — Hindi and English from the first screen**, per the locale files' standing rule. The WhatsApp
  and voice templates are bilingual: Hindi first, then English.

---

## 5. The screens — and the gate on them (RU-6)

**Design canvas: https://claude.ai/artifact/G4wC3BNL8Vd5Fai7EhQMZy** — four clickable boards inside the
Doctor Desk skeleton the owner approved on 2026-09-18 (same header, same menu, right-hand column).

| board | for whom | the idea |
|---|---|---|
| **Roster — the unit's month** | the unit's SR, the unit head | a month already drafted; *Before you publish* lists each problem as a sentence with a one-tap fix; publish is disabled, and says why, until the must-fix items are gone |
| **Who is on now** | casualty, front desk, duty manager, every ward | department → unit on take → the people in the building, with a call button. Three clock buttons show that **at 02:40 it is still Thursday's unit** |
| **My duties** (phone) | every resident and faculty member | today, this week, *"I can't do this"* → the system lists who **can** take it and, for everyone else, **why not**. The duty stays yours until it is approved |
| **Reaching a doctor** (phone) | everyone | RU-4 played out on one critical value: four steps, answerable from any of them, and what happens when none is |

**No screen task (U5) starts until the owner has commented on or approved these boards.** His
comments on the canvas are the ruling channel, as for Desk One and Bay One. The substrate tasks
(T1–T3, U1–U4, L1–L2) do not wait.

---

## 6. The ladder that reaches a person — RU-4

Two ladders exist and they are different axes. Confusing them is how a potassium of 6.8 waits
eight minutes for one person's phone to finish ringing.

- **The ROLE ladder — who.** Ward JR → unit SR → faculty on call → unit head → HOD → duty manager.
  Exists today (`kernel/workflow/timers.ts`), resolves by role; Plan 20 makes it resolve by *duty*.
- **The CHANNEL ladder — how, per person.** RU-4: app notification → WhatsApp → SMS → automated
  call. Today this axis climbs on *delivery failure*. RU-4 makes it climb on **no acknowledgement.**

**DECIDED:**

- **L-D1 — The two ladders run on independent clocks.** A critical alert starts person 1's channel
  ladder at T+0 and **tells the next role at T+5 min regardless** of where person 1's channels have
  got to. An acknowledgement by *anyone* on the role ladder stops *everybody's* channel ladder.
- **L-D2 — Severity sets the pace, and most alerts never ring a phone.** `critical`: 2 min a step,
  all four steps. `urgent`: 10 min a step, stops at SMS unless the role ladder has also run out.
  `routine`: the app only, ever. A ladder that calls people about routine things is switched off by
  its users within a week, and then it is not there for the potassium.
- **L-D3 — "Acknowledged" is a new state, distinct from "read".** `alerts.acknowledged_at`,
  `acknowledged_via` (`app | whatsapp | sms | voice | on_behalf`). Opening the bell is not an answer.
- **L-D4 — An answer is possible from every step.** A button in the app; a quick-reply button in
  WhatsApp; *reply 1* to the SMS; *press 1* on the call. Each is an inbound webhook that resolves to
  the same `acknowledgeAlert()`. **A second option exists everywhere: "I can't — pass it on"**, which
  jumps the role ladder at once instead of burning the remaining minutes.
- **L-D5 — Nothing clinical leaves the building in a message.** WhatsApp, SMS and the voice script
  carry **ward, bed and the kind of alert — never a name, a UHID or a value that identifies.** (The
  copilot's masker and `triage-sends-unmasked-complaint` are the precedent; DPDP is the reason.)
- **L-D6 — Known-busy people are skipped, not waited for.** A surgeon whose `ot_cases.wheel_in` is set
  and `wheel_out` is not, or anyone a Code Blue has marked as responding, is passed over at T+0 and
  the theatre's circulating nurse station gets the alert instead.
- **L-D7 — Adapters first, providers when the owner buys them.** `push` (Web Push: a service worker
  and VAPID keys — works with the tab closed as long as Chrome is running) is built and live in this
  phase. `whatsapp`, `sms` and `voice` get real adapter seams, inbound webhooks and a `console`
  implementation each; the day a provider account exists it is one adapter and one config value.
  **§10 lists the three purchases.**
- **L-D8 — The phone number is the person's to confirm.** `users.phone` exists. It is verified by a
  one-time code before the ladder will use it, the person sees which number is on file on *My duties*,
  and a number unverified for someone going on a take night is a **finding on the roster** — found on
  the 20th of the month, not at 02:14.

---

## 7. Tasks — one PR each, fail-first, rail + consumer together

### Plan 20, as authored, with one amendment
**T1 (amended)** `roster_periods`, `roster_assignments` — plus, nullable, now: `mode`, `unit_id`,
`location_resource_id`, `kind` (`duty | teaching`), `batch_ref`, `topic`, `swap_of_id`, `source`.
Exclusion constraint: presence × presence per user. **T2–T7 unchanged**; T3's ground truth is
re-measured (six call sites, not three; the materials pair stays static).

### 20-U — the unit system
- **U1 · CRITICAL · Units and postings.** `clinical_units`, `unit_postings` (one parent posting per
  person; one head per unit), `unit_bed_allotments`. Seeded from §2's table **as a draft the HOD
  confirms** — never silently. CSV import validated whole before the first write. **The intern
  year is generated, not typed** (§2.2: CRMI's 52-week table, staggered per batch; an over-limit
  absence yields the extension posting in the department where it occurred). Tenure/age expiry
  (SR ≤ 3 y and ≤ 45; faculty ≤ 70) is computed onto the posting. Admin screen is a plain list; it is
  not one of the gated boards.
- **U2 · CRITICAL · The unit calendar.** `unit_cycles`, `unit_cycle_entries`, `roster_holidays`,
  materialised `unit_duty_windows`; the take-overlap exclusion constraint; the no-gap publish gate;
  `unitOnTake(dept, at)`, `backupUnit(dept, at)`, `unitTeam(unit, at)`; the pattern fallback of D2.
- **U3 · CRITICAL · The validator.** Pure; findings as rows; rules as data with `authority` (D1);
  template feasibility at cycle authoring; skeleton mode (D4). The `nmc` rule rows from §2: a unit
  with fewer than two JR-grade postings; a unit without an SR; weekly off; PG surgical trainees'
  two theatre days; the 75 % projection at leave approval; posting past tenure or age.
- **U4 · ROUTINE · The proposer.** Split rules as data per unit; monthly auto-draft on the 20th (one
  scheduler job — the census goes from thirteen to fourteen, named in the PR); fairness counters (D9).
- **U5 · ROUTINE · The three screens** — *gated on §5.* Roster, Who is on now, My duties. en + hi.
- **U6 · ROUTINE · Swaps and covers**, including cross-unit (HOD approves) and the *"nobody can, and
  here is why"* answer.
- **U7 · ROUTINE · OPD reads the unit calendar — read-only.** The front desk sees which unit and
  which doctors hold today's OPD; the OPD day report (#257) gains the unit. **The queue model is not
  touched** (a session is a doctor-day; changing that is its own phase on a module every lane imports).
- **U8 · ROUTINE · The duty-evidence report (RU-3).** Per person per day: rostered duty, and what the
  record shows they were doing (theatre wheel-in/out today; labour room, casualty and rounds as those
  modules arrive). A4, letterhead, QR, through the server-side printing rail. It **states facts and
  draws no conclusion** — it never says "present".
- **U8b · ROUTINE · The AEBAS to-do list (§2.2).** Every approved leave, deputation, tour and holiday
  not yet marked *entered in AEBAS*, due-dated the day before it starts, for the college's AEBAS nodal
  officer; one tap marks it entered. RED on `standup:check` when anything is due today and unentered.
  **HMIS still never talks to AEBAS.**
- **U9 · ROUTINE · Copilot tools.** `roster.who_is_on`, `roster.my_duties`, `roster.unit_on_take`,
  `roster.ask_cover` — read tools for everyone; the one acting tool only drafts a request the human
  confirms. English and Hinglish phrasebook rows.

### 20-L — the ladder (kernel: `alerts`, `notify` — files that belong to everyone; coordinate)
- **L1 · CRITICAL · Acknowledgement.** The column pair, `acknowledgeAlert()`, the app's *I'm on it* /
  *pass it on*, the role ladder stopping on ack. Fail-first: today an alert "read" by opening the bell
  stops nothing and nothing can stop it.
- **L2 · CRITICAL · The channel ladder climbs on silence.** Severity pacing (L-D2), independent clocks
  (L-D1), busy-skip (L-D6). `push` and `voice` join the channel vocabulary.
- **L3 · ROUTINE · Web Push.** Service worker, VAPID, the permission prompt asked *at the moment a
  person first goes on a roster*, not at login.
- **L4 · ROUTINE · Inbound answers.** WhatsApp quick-reply, SMS reply, DTMF — three webhooks, one
  function; signature-verified; idempotent; an answer from an unknown number is logged and ignored.
- **L5 · ROUTINE · Phone verification and the unverified-number finding (L-D8).**
- **L6 · ROUTINE · The 19:00 "tomorrow" message** and the publish notification.

**Order:** T1 → U1 → U2 → T2/T3 → U3 → U4 → L1 → L2 → L3 → (boards signed) U5 → U6 → U7 → U8 → U9 →
L4–L6 as providers arrive. Migrations are one per PR and numbered at rebase time.

---

## 8. Edge-case register — *"because this is India"* (RU-5)

Brainstorm §9's E1–E22 stand and are this phase's tests. Added:

| # | case | expected |
|---|---|---|
| **The calendar** | | |
| I1 | the state declares tomorrow a holiday at 19:30 | D3: one act; OPD + elective withdrawn for the date; take and nights untouched; affected staff told; booked OPD patients listed for the front desk |
| I2 | a festival the roster did not know (a local one; Eid moved by the moon) | the same door; and the holiday row records who declared it |
| I3 | Diwali week: everyone asks for the same nights off | leave requests are first-come *within a fairness view* — the approver sees who worked last Diwali (D9). The system never auto-refuses |
| I4 | half-day Saturday; OPD registration closes 12:00, doctors sit till the line ends | windows carry `registration_closes_at` separately from `ends_at`; nobody is "off" while patients wait |
| **People** | | |
| I5 | a residents' strike, called for tomorrow 08:00 | D4 skeleton mode; faculty slots proposed onto take; elective withdrawn; board shows SKELETON |
| I6 | bandh / curfew / flood: the day team cannot arrive, the night team cannot leave | "held over" is an act by the SR: the night slot is extended, rest is re-computed from the **real** end, and the hours ledger shows it. The system does not pretend the shift ended at 08:00 |
| I7 | a JR absconds or resigns mid-month | posting closed from a date → every later slot becomes a finding at once; the proposer re-drafts the remainder; nothing in the past changes |
| I8 | election duty / census duty / court summons / VIP camp duty pulls staff for 3 days | a leave *kind* `deputation` — counts as duty for the person's record, as absence for the roster |
| I9 | faculty away as external examiner, or at a conference | `academic_leave`; the unit's head-ship does not move unless an acting head is posted (E14) |
| I10 | maternity leave (26 weeks) for an SR; her post cannot be refilled | long absences show on the unit's feasibility line for the **whole term**, not month by month |
| I11 | PG on the 3-month District Residency Programme | a `rotation` posting to an external site: off every internal roster and ladder for its dates; returns automatically |
| I12 | the same doctor appears on two units' rosters (a shared SR, a small department) | one parent posting only (constraint); the second unit borrows by a cover, which the validator sees |
| I13 | a woman resident rostered alone on a night in an isolated block | a rule row (`institution` authority): night slots in flagged locations need two people or a security check-in. Warn, never silent |
| I14 | Ramzan: fasting residents ask to avoid long afternoon theatre lists | a *preference*, recorded per person per period; the proposer honours it when it costs nobody else a rule |
| **Phones** | | |
| I15 | phone switched off at night · dead battery · no signal in the basement OT | the ladder is time-driven, not delivery-driven: no ack in 2 min is no ack, whatever the reason; the role ladder moves |
| I16 | no smartphone, or no data pack | SMS and voice exist for exactly this; *My duties* also prints |
| I17 | WhatsApp is on a different number from calls; two SIMs | two fields, both verified (L-D8) |
| I18 | one phone shared by a couple who are both residents | the ack asks for the last 2 digits of the staff code on SMS/voice when a number is on file for two users |
| I19 | DND / TRAI blocking | service-category DLT templates are not blocked by DND; the templates are registered before go-live (§10). A blocked send is a delivery failure → next step immediately, not after the wait |
| I20 | the number on file is three years old and belongs to a stranger | L-D8 verification; and L-D5 means the stranger learned a ward and a bed, never a patient |
| I21 | the doctor answers "I'm on it" and then does nothing | the ack stops the *reach* ladder only. The *act* clock (doc 10 §3.2) keeps running and escalates on its own |
| I22 | the ladder rings a person who is in fact on leave, because leave was approved on paper | leave approved outside the system is the failure; the who-is-on board's "this is wrong" button lets any nurse flag a wrong name, which pages the duty manager |
| **Inspection and dispute** | | |
| I23 | NMC surprise inspection: "show me who is on duty in Surgery, now, and last Tuesday" | the board for *now*; for last Tuesday the **published version as it stood that day**, with amendments listed — never today's edit of history |
| I24 | "you never told me I was on duty" | publish and every amendment record per-person delivery and first-open; the 19:00 message is evidence too |
| I25 | a medico-legal case two years on: who was the SR on take at 03:10 on a given night? | `unitTeam(unit, at)` over retained rows (8 y); plus who *acknowledged* what, from L1 |
| I26 | a roster back-dated to look compliant | published periods are append-only and versioned; an amendment to the past is allowed (truth matters) but is stamped `after_the_fact` and listed in I23's view |
| **The building** | | |
| I27 | power cut + network down at shift change | D5 paper, ≤ 12 h old; acknowledgements made on paper are back-filled with `occurred_at` claims |
| I28 | the server clock, the DB (UTC) and the wall (IST) | every resolver takes an instant; every *day* shown to a human is an IST day computed at the edge. The 03:00 test (E1) runs with the DB in UTC — it is, measured |
| I29 | a new 5-unit department is sanctioned mid-year; a unit is split after an inspection | cycles are versioned with an `effective_from`; the old version's windows stand until that instant (E15, E17) |

---

## 9. Out of scope — named so nobody infers them

Attendance and AEBAS itself (R-071; U8 produces evidence, not attendance) · payroll, duty allowances
· automatic reassignment of any person, automatic hold of any theatre (Plan 20 D4) · optimisation
beyond the proposer's simple balance · **the academic timetable module** (RU-2 says we build it; D8
makes room for it; it is its own phase) · unit-based OPD registration (U7 note) · nursing rosters —
**the substrate is all-staff and nurses can be rostered on it from T1, but the nursing screens and
ratio rules (R-067) are their own design pass** · permissions from postings (D7).

---

## 10. For the owner — purchases and facts

1. **Three purchases stand between RU-4 and a ringing phone** (procurement): a WhatsApp Business API
   provider; an SMS gateway with the hospital's **DLT entity and templates registered** (TRAI — this
   has a lead time of days to weeks, and nothing can be sent without it); an automated-voice/IVR
   provider. Until each exists its step logs to the console and the ladder moves on. **Step 1 (Chrome
   notifications) needs nothing bought and ships in L3.**
2. **Confirm the units, department by department.** You said units are sanctioned in every
   department as per the 150-seat norm. §2.1 found that the *current* norm (UG-MSR 2023) no longer
   carries a units table — the familiar 5/5/3/3/4/2/2/1/1 is MSR 2020's, and matches one unit per
   sanctioned SR. If that is your hospital's structure, one "yes" seeds U1; if any department differs
   (Respiratory Medicine as its own unit is the usual one), name it.
3. **One policy number: the night** (law-adjacent, and yours). NMC sets **no** binding cap (§2.2).
   The default built here: nights of 12 hours, **12 hours' rest after**, at most one night in three,
   one weekly off — inside the Task Force's recommended 74 h / 24 h ceiling and close to the 1992
   norm the Supreme Court is being asked to enforce. If the college runs 24-hour resident duties, say
   so: it is one value, and the feasibility line will show what each choice costs in residents per unit.
4. **Office timings** for faculty (the college notifies them; AEBAS only records) — needed for U8's
   report to say anything about a morning.

---

## 11. CLOSE — filled at execution
