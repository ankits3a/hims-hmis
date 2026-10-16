---
issue: 595
status: approved
approved: 2026-10-12
---
# SPEC — Lab critical results climb a ladder (E3.2, #595) — 2026-10-12 — APPROVED by owner 2026-10-12 ("go ahead")

**What:** A lab critical result that nobody reads back is chased automatically. It no longer waits for the technologist to remember.

**How (lean):** Copy the radiology critical chaser that is already live, instead of first building the full escalation layer (E3.1, #594).
- E3.1 stays open as its own later work. Nothing here blocks it.
- Radiology code reused: modules/radiology/chasers.ts and critical-ladder.ts.

**Rules (DECIDED; standard corporate-hospital practice, not money or law):**
1. Owner of the critical: the ordering doctor. The response clock starts when the critical is flagged (`opened_at`).
2. The ladder: ordering doctor → unit head (roster `unit_head`) → duty RMO → HOD.
   - With no answer, it climbs one rung every 15 minutes.
   - It only climbs; it never goes back down.
3. Each rung gets an alert on the web and a phone push.
   - The push carries no patient text: "Critical lab result waiting".
   - The alert opens the existing critical-call screen.
4. A read-back (the existing `acknowledgeCritical`, number must match) stops the chase at any rung.
5. Quick-entry criticals stay outside the ladder (decision 0061 unchanged).
6. The G5 query (`closed_at − opened_at`, median and p95 per week) becomes a saved report. It runs read-only on production.

**Done means:**
1. Each new critical has an owner, a clock and rung 0.
2. On a fixture clock: unanswered at 15 minutes it moves to the unit head; at 30 minutes to the duty RMO.
3. A read-back at rung 1 stops the chase; no further alerts.
4. A push holds no patient name, UHID or value.
5. The G5 query runs on production and prints the median and p95.

**Cost:** one migration (rung + last-chase columns on `lab_critical_calls`), one escalation kind `lab.critical_overdue`, one worker sweep. No phone app release is needed, because push already exists.
