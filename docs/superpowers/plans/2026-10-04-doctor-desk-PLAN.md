# Doctor Desk — the plan: what the unit's control tower builds now, and the seams IPD, Emergency and OT owe it

**Written 2026-10-04 on lane `doctor-desk-plan`, measured at `origin/main` @ `e7df7a65` and the
roster branch `origin/lane/roster-u8` (PR chain #472 → #480, still DRAFT at writing).** Docs only;
nothing here is built. Source brainstorm: `docs/superpowers/brainstorms/2026-09-18-doctor-desk/00-BRAINSTORM.md`
(and `01-CONSULT-ENGINE.md` for the consult screen, which this plan does not re-plan).

---

## 0. How a future session uses this

> **If you are starting the IPD, Emergency or OT module:** read **§4 — your module's seam
> checklist** — *before your own brainstorm*, and carry its rows into your phase doc as tasks.
> **Your module is not done for the Doctor Desk until every row of your §4 table is green**
> (exported from your module's `index.ts`, tested, and named in your phase doc's census).
> You do **not** design the Doctor Desk screens; §3's DD-IPD / DD-ER / DD-OT phase is what the
> Doctor Desk lane builds once your rows are green. Also read §5 for the edge cases tagged with
> your module.
>
> **If you are starting the Doctor Desk itself:** begin at §3 DD-0. It is not gated on IPD, ER or OT.

**State of play (2026-10-04).** The owner approved eight boards on 2026-09-18 and parked the
brainstorm; the canvas is deleted, the boards on main are the only copy. Since then the **roster is
built** (phase R on main; U5–U9 on the DRAFT chain #472→#480, which also carries the Doctor Desk
**frame** `apps/web/src/components/doctor-desk/frame.tsx`). The **obligation spine** has alerts
acknowledgement, percent ladders, the respond clock and Web Push reach on main (T3/T1/T4) but **no
"what does this unit owe" reader**. OPD, lab, radiology, pharmacy and a **day-care OT** (Plan 15)
exist. **IPD and Emergency have zero tables** (verified: no admission/bed-occupancy/ward-stay/ER/
triage table in `apps/core/src/kernel/db/schema/`). About four-fifths of the Tower's figures are
inpatient figures, so the Doctor Desk is cut into a phase buildable today (DD-0/DD-1/DD-report v0)
and three phases each gated on one department module (DD-IPD, DD-ER, DD-OT). Owner ruling
2026-09-28 forbids designing those departments here; §4 states only what the Desk must be able to
*read* from them.

---

## 1. Owner rulings that bind, and the boards

### 1.1 Rulings (quoted, dated)

| # | date | ruling | where it bites |
|---|---|---|---|
| R1 | 2026-09-18 | "Phone is always with the doctor. **Phone for the round; desktop for OPD and the duty-doctor room.**" | Round/Beds/Main/Professor are phone boards; Tower/UnitBoard/OpdDesk desktop |
| R2 | 2026-09-18 | **First users are the SR and the JR.** The Professor glances and countersigns — "he can and he will do if we really get the flow right" — and must be able to ACT from it | SR phone (Main) before Professor phone |
| R3 | 2026-09-18 | Units run **fixed admission days and fixed OPD days** | the context line and week strip read the roster's cycle |
| R4 | 2026-09-18 | **"The dashboard is the unit's source of truth."** The agent reviews, reminds, notifies criticals, reviews KPIs and **sends the unit's report automatically** | DD-report |
| R5 | 2026-09-18 | **The first screen after login is a control tower**, not a work list | Tower is the landing route for doctors |
| R6 | 2026-09-18 | Layout follows the ChatGPT reference: **THREE COLUMNS** — left menu sidebar (hideable, toggle inside it), centre (greeting, Today's Clinical Summary, AI Brief + Start Ward Round, Needs Your Attention, Unit Overview, Quick Actions), right (the day, the team, agent activity), ask bar at the bottom. "no no no. This is bad" to anything else | Every desktop Doctor Desk screen sits in `DoctorDeskFrame` |
| R7 | 2026-09-18 (canvas comment) | **"Clocks Running" is "a CRITICAL module"** — "move this section to right sidebar": first card of the right column + a menu entry under UNIT | DD-0.6 |
| R8 | 2026-09-18 (comment) | **AI Agent Activity and Unit Team (Today) are COLLAPSED by default**; summary line carries the exception ("Pooja holds 3") | DD-0.5, DD-0.9 |
| R9 | 2026-09-18 (comment) | **Login brief lifecycle:** highlighted at login, un-highlighted after a few minutes (5 used; "Got it" does it at once), **gone from the dashboard after one hour**, then kept only in the full-page AI Briefs screen (sidebar item shows a count only) | DD-0.7 |
| R10 | 2026-09-18 (comment) | "Shortcuts" renamed **"Quick Actions"**; footer brand **CRK MEDICAL COLLEGE & HOSPITAL** | DD-0.1 |
| R11 | 2026-09-17 | Copilot: **proactive vs ask-only is each doctor's toggle; drafting prose is opt-in; both default OFF; "confirmation/submission will always be from the doctor side"** | DD-0.10; obligations are NOT governed by these toggles (D1) |
| R12 | 2026-09-23 | Top priorities: **"accuracy, speed, auditable, compliant and user experience of the dashboard"**; agentic copilot frame | §6 five-priorities table |
| R13 | 2026-09-25 | **No dark slabs** — dark ink only as a highlighter; copilot panel, Clocks Running, ask bar and answer pop-ups are LIGHT cards | every port; the boards' dark dock is re-skinned light |
| R14 | 2026-09-28 | "IPD, Emergency, Insurance/TPA, Blood Bank, Dialysis, Immunisation, Ambulance, mortuary **each will have individual brainstorm session**" | this plan specifies seams, never those modules |
| R15 | 2026-08-28 | Planning: unclear fork → the standard Indian-hospital answer, marked DECIDED; edge-case pass before the task list; only money/procurement/law are owner rulings | §5, §6, §7 |
| R16 | 2026-09-23 / 2026-10-04 (memories `verify-ui-against-the-board`, `subagent-ui-briefs-must-demand-looking`) | A board he approved **is the specification**; port 1:1 inside the approved frame; screenshot at six widths and look; "a green suite is not done" | every UI task's acceptance |

### 1.2 The approved boards (canvas links are dead — these files are the only copy)

| board | path | device | phase that ports it |
|---|---|---|---|
| Tower (board 0, first screen) | `docs/design/2026-09-18-doctor-desk/Tower.dc.html` | desktop 1440 | DD-0 (OPD-day mode), completed by DD-IPD/ER/OT |
| AI Briefs (0b) | `…/AiBriefs.dc.html` | desktop | DD-0.7 |
| SR "Now" | `…/Main.dc.html` | phone | DD-1 (OPD/roster parts), DD-IPD (ward parts) |
| Beds | `…/Beds.dc.html` | phone | DD-IPD |
| Round | `…/Round.dc.html` | phone | DD-IPD |
| Professor | `…/Professor.dc.html` | phone | DD-1 (swap/approvals/owed), DD-IPD (summaries) |
| Unit board | `…/UnitBoard.dc.html` | desktop | DD-1 + DD-report |
| OPD desk | `…/OpdDesk.dc.html` | desktop | DD-0.11 |

The roster boards (`docs/design/2026-09-20-roster/*.dc.html`) are drawn inside the Tower frame and
are already built on #472→#480. Boards are design-canvas components (`<x-dc>` + a `DCLogic`
script holding the data); every figure and name on them is invented.

---

## 2. Board element census

Status: **EXISTS** = a reader the element can call today (on main unless marked *branch*);
**PARTIAL** = rows exist but the reader, the scope (unit/doctor) or a field is missing;
**MISSING** = no table. "Unit attribution" is missing everywhere outside the roster: no clinical
row (`opd_encounters`, `ot_cases`, `orders`, lab, radiology) carries a `team_id`.

### 2.1 Tower (desktop first screen)

| # | element | data needed | source | status |
|---|---|---|---|---|
| C01 | Header context "General Medicine · Unit II" | user's clinical_unit membership now | roster `membershipsOf`, `teamMembers` (`modules/roster/index.ts`) | EXISTS |
| C02 | Pill "ON DUTY · Ward + admission day" / "ON TAKE TILL SAT 08:00" | unit on take now; today's duty windows | roster `unitOnTake`, `dutiesOf` (`calendar.ts`, `resolve.ts`) | EXISTS |
| C03 | Sidebar, 5 groups / 24 entries + counts | built screens; counts per entry | frame `MENU` has 5 entries (*branch* `frame.tsx`) | PARTIAL |
| C04 | Greeting + "Professor & Unit Head · General Medicine · Unit II" | position title | roster `roster_positions` (`masters.ts`) | EXISTS |
| C05 | "Since you left at 18:10" login brief + lifecycle | last session end; facts since; brief store | `auth_sessions.revoked_at` (`schema/auth.ts:108`); no brief table | MISSING |
| C06 | Tile: Inpatients in Unit II | census by unit | IPD | MISSING |
| C07 | Tile: Need review (by AI) | NEWS2 / deterioration flags | IPD nursing obs | MISSING |
| C08 | Tile: New admissions on your take | admissions stamped to the take unit | IPD + ER | MISSING |
| C09 | Tile: New results to review | results/reports not yet seen by the ordering doctor | `orders.ordering_clinician_id` (`schema/orders.ts:134`); `imaging_report_delivery.first_read_at` (`schema/radiology.ts:1158`); no reader by clinician | PARTIAL |
| C10 | Tile: Papers for your signature | pending countersigns | `opd_prescription_drafts` keyed by encounter (`schema/opd.ts:1143`); no countersign state in `kernel/approvals` | PARTIAL |
| C11 | AI Brief bullets + "Prepared from: Nursing · Lab · Radiology · Pharmacy · Vitals · Admissions" | overnight facts per source | lab, radiology exist; nursing, admissions do not | PARTIAL |
| C12 | Start Ward Round + "AI has prepared 19 patient briefs" | per-bed round brief | IPD | MISSING |
| C13 | Needs Your Attention · Critical | open critical values for my/unit patients, ladder position | `lab_critical_calls` (`schema/lab.ts:661`), `lab/criticals.ts openCriticalCalls`; radiology `critical-ladder.ts criticalCallBoard`; no unit/doctor scope | PARTIAL |
| C14 | Needs Your Attention · Clinical change (temp ↑, NEWS2 5→7, platelets 68k→42k) | obs trend; lab delta | lab results EXIST; inpatient obs/NEWS2 absent | PARTIAL |
| C15 | Needs Your Attention · New (admitted 02:15, 6-hour review passed) | admission + senior-review clock | IPD | MISSING |
| C16 | Needs Your Attention · Pending (CT unread; discharge summary ready; PMJAY query) | unread report; summary state; insurer query clock | radiology unread EXISTS as rows (`chasers.ts sweepUnreadWatchman`); summary = IPD; PMJAY = TPA | PARTIAL |
| C17 | Unit Overview: occupied beds 19/24, admissions 24h, discharge candidates, waiting in casualty | bed occupancy; ER waiting-for-bed | IPD, ER | MISSING |
| C18 | Bed-dot map (G-201→244: red/amber/green/hollow) | unit's beds + flag per bed | beds as `resources` kind `bed` (`schema/resources.ts:87`), unit→bed `roster_bed_allotments` (`schema/roster.ts:628`); occupancy absent | PARTIAL |
| C19 | Quick Actions: Write Note · Place Order · View Results · Discharge Summary | write paths | OPD orders + `patientResultsForDoctor` (`lab/patient-results.ts:47`) exist per patient; IPD note & summary absent | PARTIAL |
| C20 | "Unit II · Last 7 Days" health lines (critical→act 8 min; senior in 6 h; summaries in 24 h; average stay; OPD seen + median wait) | daily facts by unit | `user_day_facts` (`schema/desk.ts:35`, `kernel/desk/rollup.ts`, `registry.ts loadRange`); OPD + lab criticals computable; IPD lines absent | PARTIAL |
| C21 | **Clocks Running** (what the unit owes, who holds it, countdown, one push each) | open obligations scoped to unit members; push = nudge/reassign | `alerts` + ack (`schema/alerts.ts:38`), timers (`kernel/workflow/timers.ts`), reach (`kernel/notify/reach.ts`); **no owed-by-unit reader, no nudge** | PARTIAL |
| C22 | Today's Schedule (ward round, bedside clinic, casualty review, unit meeting) | my duties today + OPD session + theatre list + teaching | roster `dutiesOf` / `myDuties` (*branch*); OPD `queue_sessions` (`schema/opd.ts:254`); OT `listForDay` (`ot/lists.ts`); teaching timetable absent | PARTIAL |
| C23 | Unit II Team (Today): role, name, where, holds N | members, presence, open items each | roster `teamMembers`, `whoIsOn`, `officiatingAt`, `absentUserIds`; "where" = duty + last act (D9); holds = owned alerts | PARTIAL |
| C24 | AI Agent Activity (collapsed) | log of agent runs | none — copilot runs as the asking user, no agent run log | MISSING |
| C25 | Ask bar (F2) | copilot | `kernel/copilot` (catalog, router); frame wires `useCopilot` (*branch*) | EXISTS |

### 2.2 Unit board (desktop)

| # | element | data needed | source | status |
|---|---|---|---|---|
| C26 | "What Unit II owes" table: bed, what, with, age, Nudge, Move | the owed reader of C21 at full length | as C21; IPD rows (summaries, senior review, PMJAY, MLC) absent | PARTIAL |
| C27 | Your people · this week: now / open / critical→act / summaries ≤24 h / your last word | per-user facts, horizon own→SR→head | `user_day_facts` EXISTS; critical→act derivable from `lab_critical_calls`; summaries IPD; "last word" (rating) absent | PARTIAL |
| C28 | Unit report census: beds at midnight, admitted, went home, LAMA, deaths | IPD census | IPD | MISSING |
| C29 | Unit report lines (7) | facts | 3 of 7 computable now (critical→act, reports read in 4 h, OPD seen/wait); 4 need IPD | PARTIAL |
| C30 | "The one that went late" (ladder narrative) | escalation history of one event | `lab_critical_calls` + `alerts` ack columns | PARTIAL |
| C31 | Delivery: daily to head + HOD, weekly to MS, print | job + channel + printing | `kernel/notify`, `kernel/printing` exist; no report job | PARTIAL |

### 2.3 SR phone "Now" (Main)

| # | element | data needed | source | status |
|---|---|---|---|---|
| C32 | ON TAKE strip "Unit II admits till Sat 08:00" + "Wrong? Tell the desk" | take window; flag | `unitOnTake`; `raiseFlag` (*branch* `my-duties.ts`) | EXISTS (*branch* for the flag) |
| C33 | Week strip MON…SAT duties | duties per day | `dutiesOf` | EXISTS |
| C34 | NEXT · ward round · "5 changed since your 20:40 handover" | round + handover time | IPD | MISSING |
| C35 | NOW critical card: value, source, WHO HAS IT ladder, I have it, Call | critical + ladder rung + ack | `lab_critical_calls`, `alerts.ack_kind` (seen/owned/handed_over) | EXISTS |
| C36 | "What did you do?" act after ack | structured act record | only free-text `alerts.ack_note` | PARTIAL |
| C37 | NEWS2 card (RR, SpO₂, temp, by nurse at) | inpatient obs | `opd_vitals` has rr/spo2/temp but no ACVPU, no O₂ flag, OPD only (`schema/opd.ts:922`) | MISSING |
| C38 | TODAY: senior review owed / CT unread / referral to accept / summary to check | four owed kinds | CT unread rows exist; OPD internal referral exists (`opd/referral.ts`); IPD referral, review, summary absent | PARTIAL |
| C39 | FLOW · beds and money: PMJAY query due; 2 beds could go home | TPA query; discharge-ready | IPD, TPA | MISSING |
| C40 | "COPILOT · ASK-ONLY · DRAFTING OFF" | per-doctor toggles server-side | not built (no `draftProse` anywhere) | MISSING |

### 2.4 Beds and Round (phone)

| # | element | data needed | source | status |
|---|---|---|---|---|
| C41 | Beds in walk order, mark = change since *my* handover | unit beds, occupant, change since a time | IPD | MISSING |
| C42 | Sort "sickest first" | deterioration weight (NEWS2) | IPD | MISSING |
| C43 | NOT IN YOUR WARD: lodged in Surgery ward; referral not accepted | outliers; inpatient referrals | IPD | MISSING |
| C44 | "Round notes save on the phone first" | offline-tolerant writes | none in the product | MISSING |
| C45 | Round header: dx, day N, under Unit II + Prof., allergy | admission + consultant; allergy | allergies EXIST (patients); admission absent | PARTIAL |
| C46 | "Since you last saw him" — every line a sourced row | lab, micro, obs, I/O since my last note | lab/radiology EXIST; obs, I/O, note absent | PARTIAL |
| C47 | Vitals strip with NEWS2 | obs | IPD | MISSING |
| C48 | OWED ON THIS BED: meropenem day 4 needs Prof. | restricted antimicrobial approval | approvals engine (`kernel/approvals`) + pharmacy reserve gate; no inpatient MAR | PARTIAL |
| C49 | Tasks given to a named JR, landing on their list | doctor-to-doctor task | none | MISSING |
| C50 | Round note, written by the doctor, Sign | IPD progress note | IPD | MISSING |

### 2.5 Professor phone

| # | element | data needed | source | status |
|---|---|---|---|---|
| C51 | Pulse: beds, admitted since 08:00, sick, deaths | IPD census | IPD | MISSING |
| C52 | Needs your signature: discharge summary JR→SR→you; meropenem beyond day 3; duty swap | countersign chain; approval; swap | swap approve EXISTS (*branch* `swaps.ts decideCover`); antimicrobial PARTIAL; summary countersign MISSING | PARTIAL |
| C53 | "How was Pooja's summary?" → PG logbook | rating attached to work | none | MISSING |
| C54 | Owed by your unit + Nudge | C26 | as C26 | PARTIAL |
| C55 | Handled without you | acted criticals history | lab criticals + alerts ack | PARTIAL |
| C56 | Proactive copilot line | toggles + rule | C40 | MISSING |

### 2.6 OPD desk (desktop) and AI Briefs

| # | element | data needed | source | status |
|---|---|---|---|---|
| C57 | Your line: booked / seen / waiting / longest wait; queue list | doctor + day queue | `listQueue(db, actor, doctorId, serviceDate)` (`opd/queue.ts:203`, served `GET queues`) | EXISTS |
| C58 | NEXT token card: why he came (desk's words), Bay One vitals, allergy | encounter + vitals | `getEncounter`, `lastActiveVitals` (`opd/index.ts`) | EXISTS |
| C59 | Since you saw him: HbA1c, creatinine, refill adherence | labs since last visit; pharmacy dispensing | lab EXISTS; pharmacy sales by patient exist but prescriber only as text (`schema/pharmacy.ts:231`) | PARTIAL |
| C60 | He is on: your last prescription | last issued prescription | `patientTimeline` / drafts (`opd/index.ts`) | EXISTS |
| C61 | Your pace + "Dr. Priya Verma in OPD-4 has 4 waiting" | own pace; unit colleagues' queues | queue EXISTS; colleague set from roster `opdUnitsOn` (*branch* `opd-units.ts`) | PARTIAL |
| C62 | Waiting on you (OPD): unsigned visits, report for today's token, certificate asked, follow-up missed, critical for a patient gone home | doctor-scoped inbox | rows exist (drafts, delivery, results); no certificate request; no doctor-scoped reader | PARTIAL |
| C63 | FROM THE WARD strip + hall display "doctor called to the ward" | ward critical reaching an OPD doctor; queue session Out | queue session status EXISTS; ward critical needs IPD | PARTIAL |
| C64 | AI Briefs page: login/morning/round briefs, filters, sources, print | brief store | none | MISSING |

### 2.7 Census counts

| | EXISTS | PARTIAL | MISSING | total |
|---|---|---|---|---|
| all boards (C01–C64) | **10** | **30** | **24** | 64 |
| of the MISSING, gated on IPD/ER/TPA | | | 16 | |
| of the MISSING, buildable by the Doctor Desk itself (C05, C24, C40, C44, C49, C53, C56, C64 — brief store, agent log, toggles, offline, tasks, rating) | | | 8 | |

---

## 3. Phases

Order: **DD-0 → DD-1 → DD-report v0** need nothing but merged work (DD-0 needs the roster chain
#472→#480 merged, for the frame, `opdUnitsOn` and `myDuties`). **DD-IPD, DD-ER, DD-OT** each wait
on that module's §4 table being green, in whatever order the owner starts those modules. **DD-phone
round** rides on DD-IPD.

### 3.0 Rules every UI task in every phase inherits

- **Port the board 1:1** (markup sizes, IBM Plex, colours, spacing) inside `DoctorDeskFrame`.
  Where the board's data is inpatient and the phase is not, the element is **absent**, not
  stubbed with zeros (a zero "Inpatients in Unit II" is a wrong number that looks right).
- **Light cards only** (R13): the boards' dark dock, dark Clocks border and dark ask bar are
  re-skinned light with a mint/ink accent edge.
- **Six-width rule:** render in real Chromium at **1920, 1440, 1280, 1024, 768, 390**; the
  implementer READS each screenshot and compares with the board; attach them to the PR. Below
  1280 the right column becomes a drawer; below 1100 the menu collapses to a Menu button (the
  frame's existing breakpoints).
- **Data must be real in the shots** — stub-API walks are allowed (`/opt/hmis-context/roster-ux-tools`)
  but the reviewer checks the figures against the stub.
- **Hindi:** every string in `locales/en.json` and `hi.json`; refusals render from codes.
- **No LLM on the critical path of a tap.** Every brief line, owed row and tile is deterministic
  and carries its source; the copilot only answers the ask bar.
- **Module shape (DECIDED D-A):** a new leaf module `apps/core/src/modules/doctor-desk/` that
  OWNS only its own rows (briefs, nudges, unit tasks, ratings, toggles) and reads every other
  module through that module's `index.ts`. It never writes a clinical row.

### 3.1 DD-0 — the OPD-day tower (buildable now)

Unlocks: Tower in OPD-day mode for every doctor of a unit (SR/JR first, R2), the OPD desk board,
AI Briefs page. Ports: `Tower.dc.html`, `OpdDesk.dc.html`, `AiBriefs.dc.html`.

| task | what | acceptance |
|---|---|---|
| DD-0.1 | Route `/doctor-desk` (landing for users holding a clinical_unit membership, R5) in `DoctorDeskFrame`; three columns; full grouped menu showing **only built entries** (D-B); footer CRK; Quick Actions = only actions whose screen exists | landing redirect test; menu has no dead link; six widths match Tower layout |
| DD-0.2 | `doctorDesk.waitingOn(actor, at)` reader: (a) lab criticals on orders where `ordering_clinician_id` = me, open in `lab_critical_calls`; (b) imaging reports delivered with `first_read_at` null on my orders; (c) my unsigned OPD drafts / section records older than the visit day; (d) abnormal/critical result for a patient whose visit is closed (OpdDesk "Hb 6.2, she has gone home") with a "desk to call" action. New exports needed: `lab: openCriticalsForClinician`, `radiology: unreadReportsForClinician`, `opd: unsignedDraftsForDoctor` (each module's own index) | each source has a fixture test that fails before the export exists; a result read by the doctor drops off within one poll; no row without a source chip |
| DD-0.3 | Unit attribution at read time (D-C): an OPD visit belongs to the unit whose member the doctor was on the service date (`membershipsOf`), cross-checked with `opdUnitsOn(date)`; visits by a doctor with no unit show under "no unit" and are counted in a census row | two-unit department fixture; doctor moved units mid-month counts to the old unit for old days |
| DD-0.4 | Centre column, OPD mode: greeting; **Today's Clinical Summary** tiles = booked · seen · waiting/longest wait · results to review (C09) · papers to sign (C10); **Needs Your Attention** tabs All/Critical/Clinical change/New/Pending fed by DD-0.2 (Clinical change = lab delta rules only, D-D); Unit Overview = unit's OPD today (each unit doctor's queue) | tiles equal the reader's counts; tab counts equal rows; empty tab says what would appear there |
| DD-0.5 | Right column: **Clocks Running** first (R7) = DD-0.6; **Today's Schedule** = roster `myDuties` + my OPD session + my OT list rows (`listForDay` filtered by `surgeonId`/`anaesthetistId`) — teaching items absent until an academic module; **Unit Team (Today)** collapsed (R8), summary line names the exception, rows: role, name, where (duty window + last act, D9), holds N | collapsed by default; summary line shows the max-holder; officiating head shown as such |
| DD-0.6 | **Clocks Running v0** — `doctorDesk.owedByUnit(teamId, at)`: union of open `alerts` addressed to unit members (respond_overdue, imaging_chase, escalation, approval_requested) + open lab critical calls on unit doctors' orders + unsigned drafts > 24 h; each row = what, with whom, clock (due/over), one push. Push = **Nudge** (D7): writes `doctor_desk_nudges` + an alert to the holder with the sender's name, once per row per sender; or **Give to** (reassign via `acknowledgeAlert handed_over`) | nudge twice → second refused `already_nudged`; push from a non-member refused; countdown is server time; "2 past their time" equals rows with negative clock |
| DD-0.7 | Login brief + AI Briefs: table `doctor_desk_briefs` (kind login/morning/round, user, facts jsonb with per-line source ref, shown_at, seen_at, archived_at); built deterministically at first request after a session whose predecessor ended (`auth_sessions.revoked_at`, else last activity); lifecycle R9 (highlight 5 min, Got it, gone at 60 min); `/doctor-desk/briefs` page per `AiBriefs.dc.html` with filters and print; sidebar count only | lifecycle test with a fake clock at 4/6/59/61 min; every line opens its record; no brief when nothing changed ("A quiet night") |
| DD-0.8 | **OPD desk** screen ported from `OpdDesk.dc.html` for an OPD-day doctor: line, NEXT token card, since-you-saw-him, he-is-on, pace + unit colleague queues, OPD-only "Waiting on you". Keeps today's queue controls (In/Out/Closed/Not started; Call next/Skip/Start/Park — consult ruling 2026-09-23 §1.1) and opens the existing consult screen. "FROM THE WARD" strip absent until DD-IPD | Call next drives the hall display as today; pace figure equals queue facts |
| DD-0.9 | AI Agent Activity v0, collapsed: the deterministic jobs that worked for this unit (brief built, chaser fired, report sent) from an append-only `doctor_desk_agent_runs`; "View all" page | collapsed by default; "nothing failed" only when no run failed |
| DD-0.10 | Ask bar: doctor-desk `copilotTools` on the manifest — `doctor_desk.waiting_on_me`, `doctor_desk.unit_owes`, `doctor_desk.my_day` (cues en/Hinglish/Devanagari, answer keys in contracts + both locales); answers are LIGHT cards | router fixture per cue; tool runs as the asking user |
| DD-0.11 | Radiology chaser reaches the ordering clinician first: `imaging.report_unread` alert addressed to `orderingClinicianId`, with the duty-manager route (`escalationRecipients`) kept as the next rung, not removed | existing chaser tests still green; new test: ordering doctor alerted before duty manager |

### 3.2 DD-1 — the unit and the ladder (buildable now, after DD-0)

Unlocks: unit-head scope of the Tower, Unit board (OPD + roster rows), Professor phone (non-IPD
parts), SR phone non-ward parts. Ports: `UnitBoard.dc.html`, `Professor.dc.html`, `Main.dc.html`.

| task | what | acceptance |
|---|---|---|
| DD-1.1 | Scope switch D11: SR = her items, head/officiating head = unit, HOD = department's units side by side, MS = hospital; scope derived from roster position + `officiatingAt`, never chosen | officiating Asst Prof sees the head's scope only during the officiating window |
| DD-1.2 | Unit board: "What Unit II owes" full list (C26), oldest first, Nudge/Move; "Your people · this week" from `user_day_facts` (horizon own → SR sees JRs → head sees unit); figures carry context ("on take 3 nights of the last 7") | a JR sees only her row; counts are acts not screens |
| DD-1.3 | Structured act after acknowledge (D3): "What did you do?" choices (Seen at bedside, ECG ordered, Repeat sample sent, Treatment started, Other + text) stored against the alert/critical call; critical→**act** time feeds facts | unacted ack keeps the row amber; KPI uses act time |
| DD-1.4 | Professor phone: Needs your signature = roster swap approvals (*branch* `decideCover`) + approvals worklist items addressed to him (`listApprovals`); Owed + Nudge; Handled without you (criticals acted by others in his unit) | Approve on phone completes the same decision as desktop |
| DD-1.5 | SR phone "Now" (OPD/roster parts): ON TAKE strip + "Wrong?" (`raiseFlag`), week strip, NOW = criticals, TODAY = unread reports / OPD referrals to accept / unsigned; bottom tabs Now · Beds · OPD · Unit with Beds hidden until DD-IPD | 390-px shot matches Main board; Beds tab absent, not empty |
| DD-1.6 | Copilot toggles server-side (R11): `doctor_desk_copilot_settings` + `copilot.setting_changed` event; status line on the phone; proactive line on Professor phone only when proactive=ON | flipping draftProse appends an event; obligations still reach a doctor with both OFF |
| DD-1.7 | Work rating at countersign/approve (D5): Good/Fine/Needs rework + reason, attached to the work item, exported to a PG logbook CSV; never a league table | rating visible to the rated resident and her seniors only |

### 3.3 DD-report — the unit report sent automatically (v0 now, completed per module)

| task | what | acceptance |
|---|---|---|
| DD-R.1 | Template `unit_report_daily` over facts only, sent 08:00 IST (the take boundary) for the 24 h that ended, to unit head + HOD; `unit_report_weekly` Monday 08:00 to MS. **Counts only — no patient name or UHID leaves the app**; in-app + print via `kernel/printing`; WhatsApp/SMS carry a count line and a link | idempotent per unit per day (re-run sends nothing); a name in the payload fails a test |
| DD-R.2 | v0 lines: critical value → act (median, over-15 count), reports read within 4 h, OPD seen/new/median wait, owed items open at 08:00, "the one that went late" (longest ladder of the day, narrative from the alert history) | each line cites its source query; empty unit day says so |
| DD-R.3 | Lines added by DD-IPD/ER/OT when their seams land: census (midnight beds, admitted, went home, LAMA, deaths), senior review within 6 h, summaries within 24 h, PMJAY answered in time, average stay, casualty-to-bed time, theatre utilisation | added in the module's DD phase, not before |

### 3.4 DD-IPD — the ward (gated on §4.1 green)

Unlocks: Tower tiles C06–C08, AI Brief + Start Ward Round (C11–C12), Needs Your Attention New/
Clinical change/Pending summary rows, Unit Overview + bed map (C17–C18), Beds, Round, Professor
summaries, SR phone ward parts, OPD desk FROM THE WARD strip. Ports: `Beds.dc.html`,
`Round.dc.html`, the Tower's inpatient elements, the remaining `Main`/`Professor` elements.

| task | what | acceptance |
|---|---|---|
| DD-IPD.1 | Tower inpatient mode: tiles, Unit Overview, bed-dot map (red critical · amber owed · green could go home · hollow free) from `bedsOf` | figures equal `census`; bed colours equal the seam's flag |
| DD-IPD.2 | Clocks/owed rows from IPD obligations: senior review 6 h, summary 24 h, discharge-ready, inpatient referrals; push "Allot beds" calls IPD's allot act (Desk never writes the bed) | owed reader includes IPD rows; push refused without IPD permission |
| DD-IPD.3 | Beds (phone): walk order (bed order) default, sickest-first sort (NEWS2), mark = change since **my** last note/handover (D4), outliers and unaccepted referrals below | the mark is per user; outlier shown under its own unit |
| DD-IPD.4 | **Round mode**: one bed; since-you-last-saw list from `changesSince` with source per line; vitals strip with NEWS2; owed on this bed; tasks to a named JR (`doctor_desk_unit_tasks`, lands on her list, done visible to giver); round note written by the doctor, Sign; **save on phone first** (D10): IndexedDB queue with client-generated ids, idempotent replay, conflict = keep both and flag | airplane-mode walk: 5 notes offline, reconnect, all 5 land once; a note signed offline carries signing time and sync time |
| DD-IPD.5 | Professor: discharge summary countersign chain JR → SR → Prof (IPD's state machine), Read and countersign / Send back; rating (DD-1.7) attaches; countersign releases the bed (IPD event) | the Desk calls IPD's act; audit on IPD's row |
| DD-IPD.6 | Briefs: morning brief + round brief (19 patient briefs) per bed, deterministic | every line clickable to its row |

### 3.5 DD-ER — the take, from the casualty side (gated on §4.2 green)

Unlocks: "6 admissions on your take, 2 still in casualty", "Waiting in casualty", Clocks
"Casualty · 2 wait for beds", Team "where = Emergency", Schedule "Casualty review", MLC owed rows,
the night's take in the unit report.

| task | what | acceptance |
|---|---|---|
| DD-ER.1 | Tower/Professor/SR: on-take arrivals for my unit (by `take_unit_at_arrival`), triage colour, waiting-for-bed age | 07:55 arrival entered 08:10 counts to last night's unit |
| DD-ER.2 | Clocks: unit's ER calls unanswered, decided-to-admit without bed, MLC entries to countersign | each row climbs on the roster ladder |
| DD-ER.3 | Team "where": a member's open ER call/attendance sets "Emergency" (D9: last act, never location tracking) | stale after the act closes |
| DD-ER.4 | Unit report: take-night lines (arrivals, admitted, door-to-unit-doctor median, door-to-bed median, MLCs) | counts only |

### 3.6 DD-OT — theatre (gated on §4.3 green; partly buildable now)

Unlocks: Schedule "Theatre · list of N" for a surgical unit, Team "in OT" from wheel-in/out,
Clocks for pre-op fitness referrals and discharge-ready day-care cases, unit report theatre lines.
Note: a medical unit (General Medicine) mostly meets OT through **pre-op fitness referrals**; a
surgical unit's tower shows its lists.

| task | what | acceptance |
|---|---|---|
| DD-OT.1 (now) | Schedule rows from `listForDay` filtered to the user as surgeon/anaesthetist (day-care OT exists today) | a postponed case leaves the schedule |
| DD-OT.2 | Unit-scope theatre card: today's cases for the unit, state, wheel-in/out, late surgeon flags | uses the unit-stamped reader (§4.3 O1) |
| DD-OT.3 | Clocks: pre-op fitness asked of this unit (O-117 on the boards), discharge_ready SLA (exists, 120 min) for unit's day-care cases | referral accepted → row leaves |
| DD-OT.4 | Unit report: cases done, first-case on-time start, cancellations on the day with reason | counts only |

### 3.7 Phase dependency summary

| phase | gated on | first screen it changes |
|---|---|---|
| DD-0 | roster chain #472→#480 merged | Tower (OPD mode), OPD desk, AI Briefs |
| DD-1 | DD-0 | Unit board, Professor phone, SR phone |
| DD-report v0 | DD-0 (+DD-1.3 for act times) | report |
| DD-IPD | §4.1 all green | Beds, Round, Tower inpatient |
| DD-ER | §4.2 green (+ §4.1 rows I1–I3 for "to bed") | Tower take figures |
| DD-OT | §4.3 green (DD-OT.1 now) | Schedule, theatre card |

---

## 4. Seam checklists — what each future module must expose for the Doctor Desk

Every row is exported from **that module's `index.ts`** (lint-enforced import rule), has a test,
and appears in that module's phase-doc census. Reads take `(exec, actor, …)` and refuse an actor
outside the unit/department scope (no weakened guard). Times are `timestamptz`; days are IST
dates; the take day is **08:00 → 08:00 IST** (roster `unitOnTake`). "Unit" = a roster team of kind
`clinical_unit` (`team_id`). Events go through the kernel event log (`appendEvent`) under the
module's own namespace. Each module also registers a **desk provider** (`kernel/desk/registry.ts`)
so its acts land in `user_day_facts`.

### 4.0 Roster seams every module must CALL (they exist on main — do not re-implement)

| seam | use |
|---|---|
| `unitOnTake(exec, departmentId, at)` | stamp the unit for an emergency arrival **at the arrival instant**, once |
| `backupUnit(exec, departmentId, at)` | overflow when the take unit's beds are full |
| `teamMembers`, `membershipsOf`, `parentTeamOf` | consultant's unit; scope checks |
| `whoIsOn` / `onDutyNow` / `calloutList` (behind `ROSTER_RESOLVER_ENABLED`) | who to call, who is on the ward now |
| `officiatingAt` | unit head on leave → officiating head signs/countersigns |
| `escalationRecipients(exec, kind, …)` / `escalationTarget` | every ladder (JR → SR → Asst Prof → Head, D2); a new kind is a migration in `ROSTER_ESCALATION_KINDS` |
| `roster_bed_allotments` (team → bed resource, windowed) | which beds are the unit's; borrowed beds are an allotment, not a copy |
| kernel `resources` kinds `ward`, `bed` | the bed master — IPD claims the kinds, never builds a second bed table |

### 4.1 IPD (Plan 41 ADT and its nursing companion) — seam checklist

| # | seam (read / event / field) | shape the Desk needs | Desk element | green when |
|---|---|---|---|---|
| I1 | field `admissions.admitted_under_team_id` + `consultant_id` | set once at admission; emergency: `unitOnTake(dept, arrived_at)`; elective/OPD: the advising consultant's unit; a change is a **transfer row + event**, never an update | every unit-scoped figure | NOT NULL for every admission; test: 07:55 arrival, 08:10 entry → last night's unit |
| I2 | fields `arrived_at` (from ER/desk) distinct from `admitted_at` and `entered_at` | three instants | take attribution, door-to-bed | all three stored |
| I3 | `admissionsUnder(teamId, from, to)` | rows {admissionId, patient display, bed, arrivedAt, admittedAt, source ER/OPD/elective/transfer/OT-conversion, day-of-stay, working diagnosis, consultantId, flags MLC/PMJAY} | C08, C15, AI brief | exported + test |
| I4 | `census(teamId, at)` | {bedsAtMidnight, admitted, discharged, LAMA, DAMA, absconded, deaths, transfersIn, transfersOut, occupied, allotted} for the take day containing `at` | C06, C17, C28, C51, report | equals a hand-counted fixture |
| I5 | `bedsOf(teamId, at)` | per bed {resourceId, ward, label, status occupied/free/cleaning/blocked, occupant, flag critical/owed/could_go_home/none, outlier (unit patient in another ward), borrowedFrom/To team} | C18, C41, C43, Beds board colours | covers lodged patients and borrowed beds |
| I6 | events `ipd.admitted`, `ipd.transferred_bed`, `ipd.transferred_unit`, `ipd.discharge_ready_marked`, `ipd.discharged`, `ipd.lama`, `ipd.absconded`, `ipd.died` | {admissionId, teamId, at, by} | briefs, Clocks, report | in the module's event catalog |
| I7 | `dischargeCandidates(teamId)` + who marked + criteria met | list | C17, C39, "2 beds could go home" | exported |
| I8 | discharge summary lifecycle `draft → sr_checked → countersigned` (+ `sent_back`), acts `checkSummary`, `countersignSummary`, `sendBack` callable by the Desk; 24 h clock from discharge as an obligation (alert + timer) | states + acts | C10, C52, DD-IPD.5 | acts exported; countersign by `officiatingAt` holder allowed |
| I9 | senior-review rule: timer at `arrived_at + 6 h`; event `ipd.senior_review_recorded` {by, role ≥ SR, at} | obligation | C15, C38, report | timer + event exist |
| I10 | nursing observations with every NEWS2 input (RR, SpO₂ scale 1/2, supplemental O₂, temp, SBP, HR, **ACVPU**) + computed score; `news2Trend(admissionId, since)`; event `ipd.news2_escalated` at aggregate ≥5, any single 3, ≥7 | rows + trend | C07, C14, C37, C42, C47 | RCP NEWS2 table tested at every boundary |
| I11 | `intakeOutput(admissionId, since)` | totals + ml/kg/h | C46 | exported |
| I12 | `changesSince(admissionId, since)` | ordered sourced facts {fact, source module, actor, at, ref} across obs, I/O, nursing notes, meds given; the Desk merges lab/radiology itself | C46, Beds marks | every fact has a source ref |
| I13 | `lastSeenBy(admissionId, userId)` (last signed note or handover by that user) | instant | D4 marks, C34 | exported |
| I14 | progress/round note store: `writeRoundNote` accepting a **client-generated id** (idempotent) + `signedAt` vs `receivedAt` | write act | C50, DD-IPD.4 offline | replay of same id is a no-op |
| I15 | inpatient referral: `refer(admissionId, toDepartment, question, urgency)`, `accept`, `answer`; events; `referralsTo(teamId)` | rows + state | C38, C43, DD-OT.3 (pre-op fitness) | exported |
| I16 | handover: `handover(teamId, from, to, at)` record (shift handover time per user) | instant | D4, C34 | exported |
| I17 | restricted antimicrobial day count per admission (from MAR) + approval hook to the pharmacy reserve gate | days, approval state | C48, C52 | MAR read exported (pharmacy-IPD items wait for IPD per 2026-09-28) |
| I18 | MLC flag + police intimation time on the admission (from ER or ward) | fields | C16, C26 | exported |
| I19 | payer class + insurer query due time (from the TPA module, when it exists) on `admissionsUnder` | fields | C16, C39 | TPA brainstorm owns the clock; IPD carries the link |
| I20 | ward allotment act `allotBed(admissionId, bedId)` callable by a unit SR (the Desk's "Allot beds") | act | C21 push | permission named in the phase doc |
| I21 | desk provider: admissions clerked, reviews, summaries written/countersigned, notes per user per day | facts keys | C27, report | registered in `kernel/desk/registry.ts` |
| I22 | copilot tools `ipd.unit_census`, `ipd.beds_of`, `ipd.patient_changes` on the manifest | tools | ask bar | registered |

### 4.2 Emergency (Plan 40 ED core) — seam checklist

| # | seam | shape | Desk element | green when |
|---|---|---|---|---|
| E1 | `arrived_at` at the **gate/triage instant**, distinct from registration entry | instant | take attribution | stored on every ER episode |
| E2 | field `take_team_id` = `unitOnTake(dept, arrived_at)` stamped once per specialty call; `backupUnit` when take unit is full, recorded as such | team id + reason | C08, DD-ER.1 | test: 07:55/08:10 and 02:40 (still yesterday's unit) |
| E3 | triage category + time (standard Indian ED red/yellow/green — the ED brainstorm picks the scale) | enum + instant | DD-ER.1 | exported |
| E4 | `erCallsFor(teamId, from, to)` | {called at, called whom (roster), answered at, seen at, by} | Clocks, Team "Emergency", report door-to-doctor | exported |
| E5 | `waitingForBed(teamId)` | decided-to-admit at, age, bed requested | C17 "waiting in casualty", Clocks "2 wait for beds" | exported |
| E6 | event `er.handed_to_unit` {episodeId, admissionId, teamId, from, to, at} — the IPD admission row I1/I2 copies `arrived_at` from it | event | DD-ER, I2 | consumed by IPD |
| E7 | disposition events: admitted, discharged, LAMA, referred out, died, brought dead | events | report | catalogued |
| E8 | MLC register entry + police intimation instant + countersign by faculty as an obligation | rows + timer | C26 MLC rows | exported |
| E9 | the front desk's red-flag brake (`red-flags.ts` refuses booking, "walk to the emergency room") creates or expects an ER arrival — the seam with OPD | act | none on the Desk; take figures stay true | ED phase doc names it |
| E10 | desk provider + copilot tool `er.casualty_now` | facts, tool | C27, ask bar | registered |

### 4.3 OT (exists as Plan 15 day-care OT; the major/elective OT brainstorm extends it) — seam checklist

What `modules/ot` already has (`apps/core/src/modules/ot/index.ts`): `ot_cases` with `wheel_in`,
`induction`, `incision`, `closure`, `wheel_out`, `surgeon_id`, `anaesthetist_id`,
`theatre_resource_id`; `ot_lists` draft/published/superseded by date+theatre (`listForDay`,
`publishList`, `resequence`, `flagLateSurgeons`); workflow states booked → … → discharge_ready
(120 min SLA) → discharged/converted/…; events `list.published`, `surgeon.late_flagged`,
`daycare.converted_to_admission`, `daycare.discharge_ready`, …; screens `/ot/list`, `/ot/book`,
`/ot/recovery`, `/ot/cockpit/$caseId`; duty-evidence read for the roster (*branch*). It lacks:
any unit/team id, a surgeon/unit-scoped reader, wheel-in/out **events**, copilot tools, a
physician-fitness gate, inpatient (major) cases.

| # | seam | shape | Desk element | status today |
|---|---|---|---|---|
| O1 | field `ot_cases.team_id` stamped at booking = booking surgeon's clinical unit (D-E) | team id | DD-OT.2 | MISSING |
| O2 | `casesFor({teamId?, userId?}, day)` (surgeon or anaesthetist) | {caseId, seq, theatre, state, procedure, patient display, wheelIn, wheelOut, late flag} | C22, DD-OT.1/2 | PARTIAL (`listForDay` has `surgeonId`, no filter) |
| O3 | events `ot.case.wheeled_in` / `ot.case.wheeled_out` (today only columns written by `signIn`/`wheelOut`) | event | Team "in OT", report | MISSING |
| O4 | list status for the day per theatre (draft/published/superseded) | read | Schedule | EXISTS (`listForDay`) |
| O5 | gate kind `physician_fitness` satisfied by an answered inpatient/OPD referral (I15) | gate | C26 "O-117 pre-op fitness" | MISSING (gate kinds: anaesthesia_review, consents, site_marking, npo, deposit, escort, privilege, mlc) |
| O6 | `daycare.converted_to_admission` consumed by IPD → admission under the surgeon's unit (I1) | event → I1 | census | PARTIAL (event exists, IPD absent) |
| O7 | post-op return-to-ward event for inpatient cases | event | Beds marks | MISSING (major OT) |
| O8 | discharge_ready SLA rows readable per unit | read | Clocks | PARTIAL (SLA exists, no unit scope) |
| O9 | desk provider (cases done per surgeon) + copilot tool `ot.my_list` | facts, tool | C27, ask bar | MISSING |

### 4.4 Other modules the Desk reads (buildable now — DD-0 adds these exports)

| module | export to add | for |
|---|---|---|
| lab | `openCriticalsForClinician(userIds, at)`, `resultsUnseenByOrderer(userIds, since)` | C09, C13, C62 |
| radiology | `unreadReportsForClinician(userIds)`; chaser addresses ordering clinician first (DD-0.11) | C09, C16 |
| opd | export `listQueue`; `unsignedDraftsForDoctor(doctorId, before)` | C10, C57, C62 |
| pharmacy | (later) prescriber id, not only text, on dispensing rows — for refill adherence by prescriber | C59 |
| TPA (future) | `queriesDue(admissionIds)` with lapse time | C16, C39 |

---

## 5. Edge-case register

| # | case | standard answer (DECIDED unless noted) | owner phase |
|---|---|---|---|
| E01 | Post-take ward round at 08:00 | take day ends 08:00 IST; the 08:00 round's list = admissions of the take that just ended; the report for that take is sent at 08:00 | DD-IPD, DD-report |
| E02 | Patient arrived 07:55, entered 08:10 | belongs to the unit on take at **arrival** (roster OnNow board rule); entry time never decides | IPD I1/I2, ER E1/E2 |
| E03 | 02:40 at night | still yesterday's take unit (08→08) | ER E2 |
| E04 | Unit's patient lodged in another unit's ward (outlier) | stays under the admitting unit; shown under "Not in your ward"; the ward's nurses see the admitting unit | IPD I5 |
| E05 | Borrowed beds (unit full, beds allotted from another unit) | a dated `roster_bed_allotments` row; bed map shows it borrowed; returns when the patient leaves | IPD I5 |
| E06 | Take unit full | `backupUnit` (yesterday's take unit) admits; recorded as overflow with reason | ER E2 |
| E07 | Unit head on leave | `officiatingAt` holder gets the head's scope, countersigns and receives the report; report says "officiating" | DD-1.1, IPD I8 |
| E08 | Strike day / skeleton staffing | roster skeleton mode; Clocks keep running; ladder climbs faster to faculty; report notes the mode | DD-0.6, DD-report |
| E09 | A JR alone on a take night | ladder climbs on time; the report says why it climbed ("one JR alone") | DD-R.2 |
| E10 | Roster not published for next week | static role-holder fallback (Plan 20 D2); Team card says "from role list, roster not published" | DD-0.5 |
| E11 | Power/network down | hospital-scoped downtime (ROADMAP v2 §4 DECIDED); Tower shows a stale banner with "as of" time; phone round queues locally (D10); printed 08:00/20:00 duty boards exist | DD-0.1, DD-IPD.4 |
| E12 | Ward wifi drops mid-round | notes save on the phone first, replay idempotently by client id | DD-IPD.4, IPD I14 |
| E13 | Phone at 02:00 | Web Push lock-screen text = bed + class ("G-214 · critical lab"), never a name (DPDP, BYOD); quiet hours never suppress a duty obligation | DD-0.6 |
| E14 | Lost/stolen phone | session revoke from admin; no PHI cached beyond the open round queue; queue encrypted at rest in IndexedDB, cleared on logout | DD-IPD.4 |
| E15 | Shared duty-room desktop | fast user switch; idle lock 10 min; a professor never stays logged in | DD-0.1 |
| E16 | Hindi | all strings en + hi; brief and report templates in both; Devanagari cues in the ask bar | all |
| E17 | Doctor in two units / moved mid-month | unit by membership on the service date (D-C); old days stay with the old unit | DD-0.3 |
| E18 | Doctor with no unit (visiting consultant) | Tower at "own" scope only; counted in a "no unit" census row | DD-0.3 |
| E19 | Night shift crossing IST midnight | facts by take day (08→08) for unit figures, by calendar day for personal facts; labelled | DD-report |
| E20 | Critical acknowledged but nothing done | row stays amber until an act is recorded (D3) | DD-1.3 |
| E21 | Copilot toggles OFF | duty obligations still arrive (D1); only suggestions are silenced | DD-1.6 |
| E22 | Nudge spam | once per item per sender; second nudge refused | DD-0.6 |
| E23 | Discharge summary written but patient LAMA/died | summary kind changes (LAMA / death summary), separate countersign clock; MRD notified | IPD I8 |
| E24 | MLC patient | police intimation instant recorded; MLC rows never leave the app; report counts only | ER E8 |
| E25 | PMJAY query lapse | TPA owns the clock; Desk shows it under FLOW; owner of row = consultant's SR | IPD I19 |
| E26 | Cross-department referral (Ortho asks Medicine for pre-op fitness) | referral row to a unit (not a person), accepted by its on-duty SR; OT gate satisfied by the answer | IPD I15, OT O5 |
| E27 | Day-care case converted to admission | admission under surgeon's unit, `arrived_at` = case wheel-out/conversion instant | OT O6, IPD I1 |
| E28 | Death | death summary + MCCD owed; unit report counts deaths; no name | IPD I6, DD-report |
| E29 | Holiday / Sunday | no OPD day tiles; take still runs; schedule from roster holidays | DD-0.5 |
| E30 | Two consultants in one unit share a patient | consultant of record is one person; the unit is the scope | IPD I1 |
| E31 | Report job runs twice / server restarts at 08:00 | idempotent per unit-day | DD-R.1 |
| E32 | Brief generated when nothing changed | "A quiet night" line, still archived | DD-0.7 |

---

## 6. DECIDED (planner, under the 2026-08-28 mandate — the owner may overturn)

Carried from the brainstorm: **D1** obligations are deterministic and ignore copilot toggles ·
**D2** one event, one ladder JR → SR → Asst Prof → Head · **D3** the act, not the ack, ends the
loop · **D4** rounds in bed order, "changed" since that doctor's last handover · **D5** rating
attaches to work at countersign, feeds the PG logbook · **D6** figures count acts, horizon own →
SR → head → HOD, on `user_day_facts` · **D7** a nudge is from the unit head, once, with his name ·
**D8** unit report: fixed template, daily head + HOD, weekly MS, counts only · **D9** "where" =
roster + last act, never a tracked phone · **D10** round saves on the phone first · **D11** every
role's first screen is a tower at its own scope · **D12** briefs: ambient minutes, present an hour,
archived forever · lock-screen text has no name.

New in this plan:

| id | decision | why (standard practice) |
|---|---|---|
| D-A | A leaf module `modules/doctor-desk` owns briefs, nudges, unit tasks, ratings, toggles, agent-run log; reads all else via `index.ts`; writes no clinical row | keeps patients/opd/billing signatures untouched; leaf modules are safe to own alone |
| D-B | The sidebar shows only built screens; unbuilt board entries appear when their phase lands | a dead link on the owner's first screen fails R12 (UX) |
| D-C | OPD visits get their unit **at read time** from roster membership on the service date; no `team_id` column on `opd_encounters` in DD-0 | avoids a migration on a shared module; membership history is already windowed. Revisit if a read-time join is too slow (stamp then) |
| D-D | "Clinical change" in OPD mode = lab delta rules only (configured % change per analyte); NEWS2 joins with IPD | NEWS2 is an inpatient obs score; OPD Bay One vitals lack ACVPU and O₂ |
| D-E | OT cases are stamped with the booking surgeon's unit at booking (not derived later) | the unit that books the list owns the case, as in every Indian teaching hospital OT schedule |
| D-F | Admission unit is stamped from `unitOnTake` at **arrival**; elective admissions take the advising consultant's unit; a change of unit is a transfer, never an edit | auditability; medico-legal "who was on take" questions (roster plan I25) |
| D-G | Report time = 08:00 IST, the take boundary; weekly on Monday 08:00 | aligns with the post-take round and the roster's day |
| D-H | Teaching items (bedside clinic, UG batches) are absent from Today's Schedule until an academic/timetable module exists | no source; no invented rows |
| D-I | Login brief un-highlights after 5 minutes (owner wrote "view minutes", read as "few"; unconfirmed on the canvas) | as recorded 2026-09-18 |
| D-J | NEWS2 (RCP 2017) is the deterioration score; IPD computes it, the Desk only reads | the national standard most Indian corporate hospitals adopted |
| D-K | Inpatient referrals are addressed to a **unit**, accepted by its on-duty SR | matches cross-unit call practice; survives leave |

### Five priorities check (R12)

| priority | how this plan meets it |
|---|---|
| accuracy | no stubbed zeros; every figure from a named reader; unit stamped at arrival |
| speed | Tower is one aggregated read; no LLM on a tap; phone round offline-first |
| auditable | every line carries its source; nudges, ratings, acts are rows with actor + time |
| compliant | no names in report or push (DPDP); MLC handled by ER; countersign by officiating holder only |
| UX of the dashboard | boards ported 1:1 in the approved frame, six-width screenshots, light cards |

---

## 7. Open owner questions (money / procurement / law only)

None blocks DD-0 or DD-1. One law-adjacent default is recorded, not asked: lock-screen pushes carry
no patient name (DPDP, BYOD) — the owner may overturn. The PMJAY/TPA query clock (money) is the
TPA brainstorm's to bring to the owner, not this plan's.
