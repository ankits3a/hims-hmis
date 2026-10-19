---
issue: 626
status: built
approved: 2026-10-04
---
# SPEC — Doctor Desk DD-0 (issue #626) — 2026-10-16

Source: `docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md` §3.1 (approved PR #481). Lane `doctor-desk-dd0`.
Prerequisites checked on origin/main @ 45773b3e4: frame `apps/web/src/components/doctor-desk/frame.tsx` (+ `AskBar`),
`opdUnitsOn` (`roster/opd-units.ts`), `myDuties` (`roster/my-duties.ts`), `doctorUnitsOn`, `membershipsOf`, `teamMembers`
all exported from `roster/index.ts`. Nothing missing; nothing to build first.

**What it is.** A new leaf module `doctor-desk` (D-A) and two screens in `DoctorDeskFrame`: the **Tower** at `/doctor-desk`
(OPD-day mode) and **AI Briefs** at `/doctor-desk/briefs`. One aggregated read `GET /doctor-desk/tower`; acts
`POST /doctor-desk/clocks/nudge` and `POST /doctor-desk/briefs/:id/seen`; `GET /doctor-desk/briefs`. One migration with
three tables the module owns: `doctor_desk_briefs`, `doctor_desk_nudges`, `doctor_desk_agent_runs`. It writes no clinical row.

**This lane builds** DD-0.1 (route, menu of built entries only, footer CRK, landing), 0.2 (`waitingOn` with new exports
`lab.openCriticalsForClinician`, `lab.deltaResultsForClinician`, `radiology.unreadReportsForClinician`,
`opd.openVisitsForDoctor`, `opd.doctorDayLines`), 0.3 (unit at read time via `doctorUnitsOn`), 0.4 (centre: greeting,
summary tiles, Needs Your Attention tabs, Unit Overview), 0.5 (right: Clocks first, Today's Schedule, Unit Team collapsed),
0.6 (Clocks Running v0 + Nudge), 0.7 (login brief + lifecycle + AI Briefs page with filters and print), 0.9 (agent-run log
card, collapsed). **Split to follow-up issues (DD-0b):** 0.8 OPD desk port, 0.10 the three `doctor_desk.*` copilot tools,
0.11 radiology chaser to the ordering doctor — 0.10 and 0.11 edit shared `kernel/copilot` / `kernel/alerts`.

**DECIDED (standard practice; none is money, procurement or law):**
1. No model is called in DD-0. Every brief line is a template over typed facts (plan §3.0, `kernel/desk/brief.ts` DD12).
   Prose drafting waits for the per-doctor toggle (decision 0006, DD-1.6); when it lands it goes through `kernel/inference`
   with counts only and returns nothing when no model is set.
2. Door: the existing `opd.consult` grant; no new permission (seed-roles untouched). Each act re-checks unit membership.
3. Nudge: any member of the unit (incl. officiating head) may nudge a row held by another member, once per row per sender
   (`already_nudged`); non-member `not_unit_member`; self `own_row`. The bell text names the sender and the kind, never a
   patient (GC6). "Give to" (reassign) is DD-1.2's Move.
4. "Unsigned visit" = my OPD visit from an earlier IST day still `in_consultation` / `awaiting_results`.
5. Clinical change = lab results on my orders with the lab's own delta flag, reported in the last 24 h (D-D).
6. Briefs: login briefs only (morning = DD-report job, round = DD-IPD). Built at the first Tower read 3 h or more after
   the doctor's previous Tower read ("since you left" = that read); quiet window → "A quiet spell" line, still kept.
7. Landing (R5): `/` sends a user holding `opd.consult` AND a parent clinical-unit membership today to `/doctor-desk`, once
   per browser session; the Desk home stays one click away (◆ DESK ONE).
8. Absent, not zero: inpatient tiles, bed dots, Last 7 Days, teaching and OT schedule rows, FROM THE WARD.
9. Money: no fee, paid, bypass or price field in any doctor-desk payload or screen (decision 0058).

**Done means:**
- [ ] `GET /doctor-desk/tower` for a unit doctor returns tiles equal to the readers' counts and tab counts equal to rows;
      each attention row carries a source chip and an href; a critical closed by the lab drops off on the next read.
- [ ] Two-unit fixture: a doctor moved units mid-month counts to the old unit for old days; a doctor in no unit gets
      `unit: null` and own scope only.
- [ ] Nudge twice → second refused `already_nudged`; non-member refused; one bell row per nudge, no patient name in it.
- [ ] Brief lifecycle with a fake clock: highlighted at 4 min, not at 6; on the Tower at 59 min, gone at 61; Got it
      un-highlights at once; every brief stays listed on `/doctor-desk/briefs`.
- [ ] A money-word guard test over the tower payload and both screens fails on any fee/paid word.
- [ ] Menu has no dead link; Team and Agent cards collapsed by default; screenshots at 390, 768, 1280 px read and attached.
