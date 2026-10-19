---
issue: 890
status: approved
approved: 2026-10-04
---
# SPEC — Doctor Desk DD-1 (the unit and the ladder) — 2026-10-16

Source: `docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md` §3.2 (approved PR #481) + issue #890's notes. Lane
`doctor-desk-dd1`, stacked on DD-0 (PR #891, lane `doctor-desk-dd0`). Boards: `UnitBoard.dc.html`, `Professor.dc.html`,
`Main.dc.html` (web views only; no apps/mobile). One additive migration: `doctor_desk_moves`, `doctor_desk_acts`,
`doctor_desk_ratings`. Door stays `opd.consult` (no new permission). No model is called anywhere.

**Builds** DD-1.1 scope · 1.2 Unit board `/doctor-desk/unit` (owed full list oldest first, Nudge/Move, Your people · this
week, units side by side for HOD/MS) · 1.3 "What did you do?" on lab criticals · 1.4 Professor phone `/doctor-desk/professor`
· 1.5 SR phone `/doctor-desk/now` · 1.6 copilot status lines over #861's toggles · 1.7 work ratings + `/doctor-desk/ratings`.

**DECIDED (standard practice; none is money, procurement or law):**
1. Scope is derived, never chosen: `own` (no unit) · `member` (her items + her unit's clocks) · `unit` (head of the unit,
   officiating head included only inside the `roster_officiating` window) · `department` (an officiating `hod` row in force on
   one of the department's units, or a department-scoped grant of `roster.periods.publish` — the rule leave already uses for
   "the department head") · `hospital` (holds the `medical_superintendent` role). The highest wins.
2. Your people horizon: JR/intern = own row; SR = own + the unit's JRs/interns; head (and above) = the whole unit. Row:
   now (on duty till), open (owed rows held), visits finished this week, critical→act median. Counts of acts only.
   HOD/MS see units side by side: counts only (open, past time, critical→act median, OPD seen today) — no patient, no person.
3. Move: the unit's head (incl. officiating) or a senior resident may move an owed row to another current member. The
   source row is never edited; the Desk records who the unit now expects to act (latest move wins), appends event
   `doctor_desk.row_moved` in the same transaction, and bells the new holder (sender + kind, no patient). JR → `not_allowed_to_move`.
4. Act (D3): Seen at bedside · ECG ordered · Repeat sample sent · Treatment started · Other (+ text, required). On lab
   critical rows in DD-1 (imaging criticals keep radiology's own acknowledgement). The holder or any member of the holder's
   unit, once per critical (`already_acted`). A critical the lab closed (read back) with no act stays on the Tower and in
   Clocks as "acknowledged · no act yet" (amber) for 7 days. Critical→act = act time − call opened time.
5. Professor phone: Needs your signature = roster cover requests he may decide (the same `decideCover` route as desktop) +
   approvals awaiting him (the same `/approvals` worklist; opens the inbox card, where the note is required). Owed + Nudge,
   Handled without you (unit criticals acted by someone else, last 24 h), Rate work. Pulse (beds) absent until DD-IPD.
6. SR phone Now: ON TAKE strip + "Wrong?" (roster `raiseFlag`), week strip, NOW = my criticals with the act, TODAY = unread
   reports + unfinished visits. OPD referrals to accept and FLOW are absent (no source). Tabs Now · OPD · Unit; Beds absent.
7. Copilot: #861's server toggles (`/opd/consult/copilot-settings`) are the only store. Status line on both phones; the
   Professor's proactive line (a count, no model) shows only when proactive is ON. Clocks, nudges and criticals never read them.
8. Ratings: the work item is a unit resident's OPD visit completed today or yesterday, rated by a senior of the same unit
   (head, faculty, or SR rating a JR/intern); never self. Good / Fine / Needs rework (reason required for Needs rework).
   Once per item per rater. Seen by the rated resident (own figures + own PG logbook CSV) and the rater only.
9. My ratings page follows "my performance vs averages" (owner 2026-10-09): own counts this month and own share rated Good,
   beside the department's and the hospital's share. No other person's name, rank or figure; neutral (no colour). An
   average leaves the asker out, shows only when its pool has ≥3 OTHER rated residents and ≥10 ratings on settled days
   (up to yesterday), rounded to the nearest 5 %; own share only with ≥5 ratings (review F2, 2026-10-16).
10. No money on any of these screens. Confidential patients by alias. Restricted tests follow the lab's rule (ordering
    clinician or `orders.read.restricted`). Unit report v0 (DD-report) is NOT in DD-1.

**Done means:**
- [ ] DM1 Officiating head gets `unit` scope only inside the officiating window; outside it `member`. MS → `hospital`.
- [ ] DM2 Unit board: a JR sees only her row in Your people; SR sees JRs not faculty; head sees all. Owed list oldest first.
- [ ] DM3 Move by JR refused `not_allowed_to_move`; to a non-member refused; a move writes one row + one event + one bell,
      and the next read shows the new holder.
- [ ] DM4 Closed critical without an act stays on the Tower/Clocks marked acknowledged; recording an act removes it;
      a second act → `already_acted`; critical→act minutes equal act − open.
- [ ] DM5 Handled without you drops a restricted test the viewer did not order; a confidential patient shows by alias.
- [ ] DM6 Rating: self refused; a non-senior refused; second rating by the same rater refused; the resident's page shows
      no average below the minimum pool and never another person's name; the CSV is the resident's own rows only.
- [ ] DM7 Obligations reach a doctor with both copilot toggles OFF (owed rows and nudge unchanged).
- [ ] DM8 Money-word guard over every new payload and screen; screenshots at 390, 768, 1280 px read.
