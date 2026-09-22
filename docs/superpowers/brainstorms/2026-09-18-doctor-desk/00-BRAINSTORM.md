# Doctor Desk — the doctor's first screen, the round, and the unit head's view

**Brainstorm, 2026-09-18. PARKED by the owner the same day: "save into roadmap, I will work on it
later." Nothing here authorises a code change, a migration or a plan.** Measured at `origin/main` @
`37b9191d`, 2026-09-18 UTC. Roadmap entry: `docs/superpowers/2026-09-06-ROADMAP-v2.md` §9.

- **Canvas (clickable, eight boards):** https://claude.ai/artifact/CLz51nKRoUsah3ywJHCeTN — private
  to the owner. His anchored comments on it are the ruling channel, as they were for Desk One.
- **Sources as of the park:** `docs/design/2026-09-18-doctor-desk/` (eight `.dc.html` boards +
  `canvas.json`). They are design-canvas components, not standalone pages: they render on the
  canvas, not from a file browser. They are here so the design survives the canvas.
- **Where it started:** a ChatGPT mockup the owner brought ("Doctor Desk", a professor's dashboard)
  and its written reasoning. The reasoning was mostly right; §2 says what happened to the screen.

The setting the owner gave: a medical college and hospital. A department has **units**; a unit is
one Professor (head), one Associate Professor, one Assistant Professor, Senior Residents, Junior
Residents; units are assigned duties by roster. The institute's name on the owner's own edit of
the canvas is **CRK Medical College & Hospital**.

---

## 1. What the owner ruled (2026-09-18)

In conversation:

1. **The phone is always with the doctor. Phone for the round; desktop for OPD and the duty-doctor
   room.**
2. **First users are the Senior Resident and the Junior Resident.** The Professor gets a
   glance-and-countersign view — *and must be able to act from it* ("he can and he will do if we
   really get the flow right").
3. **Units run fixed admission days and fixed OPD days.** The week's rhythm is part of the context.
4. **The dashboard is the unit's source of truth.** The unit head rates and pushes his people from
   it. The dashboard agent reviews work, reminds, notifies criticals, reviews KPIs and **sends the
   unit's report automatically**. Every user's copilot handles approvals, confirmations, reporting.
5. **The first screen after login is a control tower** — the professor in his cabin watches the unit
   from screen one and moves to other screens to work. (My first cut gave him work lists instead;
   he called it a miss.)
6. **The dashboard's layout follows the reference image: THREE COLUMNS.** Left = the menu sidebar,
   hideable with an open/close toggle. Centre = greeting, Today's Clinical Summary, AI Brief with
   Start Ward Round, Needs Your Attention, Unit Overview, Quick Actions. Right = the day, the team,
   agent activity. Ask bar along the bottom. My alternative (top tabs, no sidebar, a bed map in the
   centre) was rejected outright: *"no no no. This is bad."*

By comment on the canvas:

7. **"Clocks Running" is a critical module** — what the unit owes, who holds it, by when, one push
   button each. It was the one piece of the rejected tower he singled out to keep. **It lives in
   the right column, first card.**
8. **"AI Agent Activity" is collapsed by default.** A click shows a little; the full log is behind
   "View all". **"Unit II Team (Today)" the same.** Reference cards are one line until asked.
9. **The login brief ("Since you left at …") has a lifecycle.** Its own section; **highlighted at
   login; un-highlighted after a few minutes; gone from the dashboard after an hour, and from then
   on kept only in the full-page AI Briefs screen — not in the sidebar's AI Briefs item.**
10. He renamed "Shortcuts" to **"Quick Actions"** and moved the menu toggle inside the sidebar.

**The lesson for whoever picks this up:** when the owner brings a reference and calls it the
starting point, keep its skeleton and improve the content inside it. I argued the sidebar, the KPI
tiles and the agent rail away in round one and then designed without them; he wanted that pattern
all along. See also the memory `departing-from-an-approved-design`.

---

## 2. The boards

| # | board | what it is |
|---|---|---|
| 0 | `Tower.dc.html` | **The first screen.** Unit head's desktop dashboard on the three-column pattern. Working: sidebar toggle, attention tabs, Clocks Running push buttons, team and agent cards opening, the login brief's three states (Tweaks → "Since you left") |
| 0b | `AiBriefs.dc.html` | AI Briefs, full page — where the login brief goes after its hour. Login / morning / round briefs, filters, a detail pane with every line's source |
| 1 | `Main.dc.html` | SR's phone at 08:18, "Waiting on you": NOW / TODAY / FLOW. Acknowledge a critical → the ladder stops → *"what did you do?"* |
| 2 | `Beds.dc.html` | The unit's beds on the phone, in the order she walks them; "sickest first" as the other sort; outliers and referrals below |
| 3 | `Round.dc.html` | Round mode, one bed: what changed since *she* last saw him, every line with its source; tasks given to a named JR; a note she writes herself |
| 4 | `Professor.dc.html` | Unit head's phone: three signatures, what his unit owes with a Nudge, "handled without you" |
| 5 | `UnitBoard.dc.html` | Desktop: what the unit owes and who owes it; his people this week; the unit report nobody typed |
| 6 | `OpdDesk.dc.html` | An OPD day at the desktop: the line is the screen; the ward reaches her through one strip |

Every name, bed and figure on the boards is invented.

---

## 3. Planner decisions taken in the design — DECIDED, the owner may overturn

Under the 2026-08-28 standing mandate (pick the standard Indian-teaching-hospital answer, mark it,
keep going).

- **D1 — "Needs Your Attention" and "Waiting on you" are deterministic.** Lab critical thresholds,
  a vitals score (NEWS2), the unread-report chaser, the 6-hour senior-review rule on a new
  admission. They must be excellent with both copilot toggles OFF (owner ruling 2026-09-17: proactive
  and draft-prose are per-doctor and default off). **The toggles govern copilot *suggestions*, never
  duty obligations:** a critical value, an escalation rung or a senior's nudge reaches a doctor whose
  proactive toggle is off.
- **D2 — one event, one ladder: JR → SR → Assistant Professor → Unit Head, timed.** This is Plan
  20's escalation ladder landing in an inbox. Every row says who has it now and when it climbs.
- **D3 — acknowledging is not the end state; the ACT is.** After "I have it" the card asks "what did
  you do?". Otherwise residents tap to stop a timer and the KPI measures tapping. The unit report's
  figure is lab → *act*, not lab → tap.
- **D4 — rounds are walked in bed order,** and "changed" means changed since **that doctor's** last
  handover, not since midnight.
- **D5 — rating attaches to a piece of WORK, at countersign, and feeds the PG logbook** — not a
  league table. It is what makes the resident want it.
- **D6 — figures count acts, never screens, and carry their context** ("on take 3 nights of the last
  7"). Horizon as ruled for staff reports: own row → SR sees her JRs → unit head sees the unit →
  HOD the department. Reuse `user_day_facts` (Plan 07c); do not build a second counting machine.
- **D7 — a nudge is a message FROM THE UNIT HEAD, once, with his name on it.** Machine reminders are
  the ladder; they are not the same thing and must not look the same.
- **D8 — the unit report is a fixed template over facts:** daily to the unit head and HOD, weekly to
  the Medical Superintendent, **counts only — no patient name leaves the app.**
- **D9 — "where they are" is the roster plus the doctor's last act, never a tracked phone.**
- **D10 — round mode saves on the phone first.** Ward wifi drops. This is the first offline-tolerant
  seat in the product and is real engineering cost.
- **D11 — every role's first screen is a tower at its own scope:** SR = her beds, unit head = the
  unit, HOD = the department's units side by side, MS = the hospital. One design, four scopes.
- **D12 — the brief grammar generalises:** *ambient for minutes, present for an hour, archived
  forever.* Any agent-prepared summary can follow it.

**Left for the owner — law-adjacent, blocks nothing:** a lock-screen push on a doctor's own phone
reads "G-214 · critical lab", never a name (DPDP, BYOD). Default taken: no name.

**Unconfirmed:** the login brief un-highlights after **5 minutes** — the owner wrote "view minutes",
read as "few". A "Got it" button does it at once.

---

## 4. What this needs that does not exist — measured 2026-09-18 at `37b9191d`

| need | state | how to check |
|---|---|---|
| IPD: wards, beds, admissions | **absent** — 0 tables | `grep -rhn 'pgTable(' apps/core/src/kernel/db/schema \| grep -ciE '"(ipd_\|wards?\|beds?\|admissions?)'` → 0; `ls apps/core/src/modules` has no `ipd` |
| The unit as an entity; **a patient admitted under a UNIT + consultant, not under a doctor** | **absent** | same grep for `clinical_units?` → 0. This is the one data-model decision the dashboard imposes on Plan 41 |
| Roster, duty, on-call, escalation resolver | **authored, not built** | `docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md` exists; no `roster`/`shifts` table |
| A doctor-scoped "waiting on me" reader | **absent** — the rows exist, the reader does not | `modules/radiology/chasers.ts` stamps `unread_chased_at` and emits an event with no inbox to land in |
| Per-user per-day facts, the nightly rollup, CSV | **built (07c)** | `grep -rn user_day_facts apps/core/src/kernel/db/schema` |
| The copilot kernel (one brain, module-declared tools, runs as the asking user) | **built** | `ls apps/core/src/kernel/copilot` |
| The OPD consult screen | **built** | `apps/web/src/screens/opd-consult.tsx` |
| Nursing vitals on a ward, NEWS2 | **absent** (OPD vitals only — Bay One) | — |
| Offline-tolerant writes on a phone | **absent** | — |

So roughly four-fifths of the canvas sits behind ROADMAP v2 §4's IPD gate (41 ADT + 20 roster).

---

## 5. The cut, when it is picked up

- **DD-0 — the OPD doctor's home. NOT gated; buildable on today's main.** The three-column shell
  (sidebar + toggle, centre, right), today's line from the existing OPD queue, a **doctor-scoped
  "waiting on me" reader** (unread radiology reports, lab criticals, unsigned consult drafts), the
  login brief with its lifecycle, AI Briefs as a page, the ask bar on the copilot kernel. It is
  version zero of the same screen — the ward cards attach when IPD lands — and it gives the
  radiology chaser the inbox it has been emitting into since 18a. Production has 24 doctors and one
  diagnosis row (2026-09-17): the seat is empty, and this is the screen that makes it worth opening.
- **DD-1 — the unit and the ladder.** After Plan 20: unit entity, duty context line ("ON TAKE"),
  the week strip, Clocks Running on the real escalation ladder, the Nudge.
- **DD-2 — the ward.** After Plan 41 (and 42a for nursing vitals): beds, the round on the phone,
  "changed since your handover", tasks given to a named JR, save-on-phone-first.
- **DD-3 — the unit head.** Signatures (summary JR → SR → Professor, restricted antimicrobials, duty
  swaps), the unit board, people figures on `user_day_facts`, the automatic unit report, work ratings
  into the PG logbook.

**Edge cases to carry into any phase doc (the 2026-08-28 rule — do the pass before the doc):**
unit admission day and the post-admission round · patients lodged in another ward · cross-department
referral calls · MLC flags and the police intimation · PMJAY pre-auth queries with a lapse time ·
discharge-summary backlog and MRD · LAMA and death summaries · a JR alone on a take night (the ladder
must climb, and the report must say *why* it climbed) · the roster not published for next week (Plan
20 D2: the static answer is a fallback, not an error) · a shared duty-room desktop (fast user switch;
a professor must not stay logged in) · a night shift crossing IST midnight (Plan 20 D7).
