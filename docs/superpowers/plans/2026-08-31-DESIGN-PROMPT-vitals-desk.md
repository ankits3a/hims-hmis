# DESIGN PROMPT — Vitals Desk dashboard, in depth

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis`.

---

## What we are doing

Designing the **Vitals Desk seat** — the staff dashboard where a patient's vitals are taken
between the registration counter and the doctor's room. This continues the seat-by-seat design
pass (Enquiry Counter and Registration Counter are done). Do not build the app. Do not touch
`apps/`. The output is one or two **clickable HTML prototype artifacts** the owner can walk.

**The process changed on 2026-08-31 — follow the new one, it worked.** The owner walked three
from-scratch clickable prototypes of the registration counter, left **anchored comments on
individual elements** ("keep it" / "move it"), picked a winner, and those comments became the
rulings. So: load the `artifact-design` skill, build a *working* single-file HTML prototype
(state machine, keyboard, simulated agent — not static artboards), publish it as an artifact,
and invite element-level comments. A second, wilder variant is welcome if it argues a real
alternative; do not pad with lookalikes.

## The design system — the owner has picked a base; carry it

**Desk One** won the counter bake-off and is the leading identity for every staff seat.
Open `docs/design/2026-08-31-registration-counter/desk-one.html` and lift exact values.

- Ground `#f4f7f4` green-biased paper · cards `#ffffff` · pine ink `#132420` · lines `#dfe7e1`
- Hospital green `#0e6b4e` = primary actions, applied, settled · marigold `#dd8f1c` = needs a
  human (UNPAID, heavy queue, missing data) · brick `#b23a30` reserved for danger
- **The agent speaks on dark**: anything the AI says or does sits on pine ink with mint
  `#35c48f` — machine work is never white-on-paper. No legend needed.
- Type: IBM Plex Sans (human UI) · IBM Plex Mono (digits compared digit-by-digit, section
  labels) · IBM Plex Sans Devanagari (sentences said aloud to the patient)

Elements the owner has ruled keepers, which generalize to every seat:

1. The **minimized footer agent bar** — ticker + ask box (F2) + pull-up log.
2. **In-sight agent cards** at the point of decision — never in a sidebar ("because of
   placement often will get missed").
3. **Ctrl+K** command palette and a live workload pill in the header.
4. An **identify-first opening** (the counter's search-first; here it becomes scan-first).
5. The session column: the patient in hand lives on screen until Esc; nothing bleeds into the
   next person.

Diverge only where this seat's physical reality demands it, and flag every divergence.

## The owner's standing rulings — carry, do not relitigate

English leads staff screens; Hindi leads anything the patient holds or is told (Devanagari
`line-height 1.55`, western digits, never machine-transliterate a name). Dates `31-Aug-2026`.
When something is open, pick the most defensible Indian-corporate-hospital answer, mark it
DECIDED with one line, and keep moving — stop only for money, procurement, or law. The owner
wants **hardware costs in INR**: this seat touches devices, so include a small procurement
table (BP monitor, SpO₂, weighing scale, height rod, thermometer, barcode scanner — with a
serial-connected vs. manual-entry column) and flag it as an owner decision.

## Read this before designing anything

| What | Where |
|---|---|
| The won counter design — the identity source | `docs/design/2026-08-31-registration-counter/desk-one.html` |
| The agentic-vision variant — autonomy ladder (ASKS / SUGGESTS / DID-with-undo), say-this box, zero-typing thesis | `docs/design/2026-08-31-registration-counter/counter-cockpit.html` |
| **What exists today** — the shipped vitals screen | `apps/web/src/screens/opd-vitals.tsx` |
| The vitals artboard from the earlier OPD pass | `docs/design/2026-08-29-opd-counter-flow-v2/VitalsDesk.dc.html` |
| The vitals requirements already ruled (T5) and the queue gate (T6) | `docs/superpowers/plans/2026-08-29-EXECUTE-PROMPT-flow3-front-desk.md` |
| Hindi rules | `docs/design/2026-08-29-opd-counter-flow-v2/DevanagariSpec.dc.html` |
| Shipped palette discipline | `apps/web/src/styles.css` |
| Mission & vision | `docs/PROJECT-BRIEF-2026-08-30.md` |

## What is known about this seat

A vitals screen **already exists and is deployed** (`opd-vitals.tsx`, 07-series) — this is a
redesign with the agentic OS ambition, not a blank page. Settled facts to keep:

- **Barcode scan pulls the patient in** — the token slip's barcode is the identifier.
- **Carried-forward values are locked**: height comes greyed from the last visit and unlocks
  only when a reason is picked from a preset list; the old value stays beside the new one.
- **Vitals gate the doctor queue**: only vitals-done patients are callable. This seat is the
  valve on the whole OPD flow — its throughput *is* the hospital's wait time.
- The priority ladder `opd.queueClass` 0–4 exists server-side; **vitals is where a class-3
  walk-in is discovered to be a class-0 danger.**

Invent the persona (a vitals attendant/GNM nurse; give them a name and a shift) and design for
their real day: one attendant, a bench of waiting patients, a blood-pressure cuff, and forty
seconds per person.

## The questions this seat must answer — the meat

Work these through in the prototype; most matter more than the form itself:

- **The escalation.** BP 210/130 on a walk-in with a class-3 token. What turns red, who is
  told, how fast, and what does the attendant *say*? This is the seat's most important moment —
  design it first, not last. (Autonomy ladder: what may the agent DO alone — bump queueClass?
  — versus ASK?)
- **Zero-typing again.** The counter's thesis was "confirm, don't type." Here it is "measure,
  don't transcribe": serial/BLE device capture with manual entry as the fallback, and the
  keystroke counter proving it. What does the screen look like while the cuff inflates?
- **The trend in sight.** 158/98 means one thing alone and another next to June's 132/84. Show
  the delta at the point of capture — in sight, not a tab. When does the agent suggest a
  five-minute-rest recheck, and how does the recheck protocol work on screen?
- **Sanity gates.** A height 4 cm shorter than last year on an adult, a weight typed with a
  slipped digit, SpO₂ 45 on a talking patient — catch the transcription error *before* it
  becomes a chart fact.
- **Context questions worth one tap** — "BP medicine taken this morning?", fasting status when
  a sugar draw is owed — captured as chips, because the doctor's first question shouldn't be
  answerable by the corridor.
- **Children.** Different ranges, different cuff, weight-for-age; MUAC? Where does paediatric
  reality change the screen, not just the limits table?
- **Dignity.** Weight is never announced across the room; what does the screen do to help the
  attendant *not* say it? The say-this box pattern (Hindi + one personal detail) carries here:
  "बाबा, पाँच मिनट बैठिए, फिर दोबारा लेंगे।"
- **The bench.** The attendant's own queue: who is next, who was sent to rest-and-recheck, who
  bolted to the toilet — and what the agent pre-stages (last vitals, expected flags) while a
  patient walks over.
- **Failure modes.** Scanner dead, device unpaired, a patient with no slip. The counter's rule
  was graceful, self-announcing fallbacks — match it.
- **What the agent logs.** Every carried-forward unlock, every override of a sanity gate, every
  auto-bump — timestamped in the footer log, undoable where reversible.

## How the owner works

They comment directly on the published artifact, anchored to elements — treat each comment as a
ruling and keep a running keep-list. If an `artifact-changed` or comment notification arrives,
**read it before republishing** or you will clobber their input. Expect strong, specific,
correct feedback about physical reality — cuffs, cables, ink, what a nurse will actually do at
patient forty of sixty. When they push back, they are usually right about the constraint; check
whether they are also right about the fix before agreeing.

## Start here

Read `opd-vitals.tsx` and the two counter design files, then come back with what you think this
seat is actually for, where the shipped screen falls short of the agentic-OS bar, and the one
or two questions that would change the design — **before** you build. Then build the clickable
prototype and publish it.
