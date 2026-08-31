# EXECUTE PROMPT — Vitals Desk dashboard ("Bay One"), from signed-off design to working software

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis` on the build host.

---

## Mission

Build the **Vitals Desk seat** — the bay where a patient's vitals are taken between the
registration counter and the doctor's room, signed off by the owner on 2026-08-31 — as working
software. Persona: **Sister Kavita Kisku**, GNM, Bay 01, 08:00–14:00, forty seconds per patient.
This seat is two things at once: the OPD's **throughput valve** (only vitals-done patients are
callable, so this bench IS the hospital's wait time) and its **last tripwire** (the class-3
walk-in who is actually a class-0 danger is discovered here).

The design thesis is **measure, don't transcribe** — with the owner's amendment that until the
serial devices land (days away), the **typing lane is first-class**: fast, gated, honest about
its keystroke cost. The atom of the screen is a **reading** (value + source + band + history +
sometimes a second take), rendered as a tile — never a bare form field. The form survives only
as each tile's fallback.

You are not designing. The design is decided, clickable, and archived in this repo. You are
also not coding straight from this prompt: **author phase documents per
`docs/superpowers/EXECUTE-METHOD-V3.md` first**, then execute them.

## The one demo that proves it is done

A tester, using only the app, in one sitting:

1. **Three doors, one lane.** Scans a token barcode → the patient lands in the session column,
   pre-staged (file, last vitals, band, expected flags). Then identifies the next patient by
   **typing the token number**, and a third by **typing the UHID** — all three start the
   identical session (owner ruling).
2. **The typing lane at speed.** Takes a full adult set with the keyboard only: ⏎ commits a
   field and jumps to the next, 1–8 address fields, the keystroke counter scores it. Saves →
   a **bold ✓ confirmation** names who was saved and which doctor's board they landed on, the
   bench row wears the same tick, and the patient is now callable on that doctor's queue.
3. **The escalation.** A class-3 walk-in reads 208/126 → the tile goes brick and the agent
   demands the **other arm, now** (rest is refused at danger numbers). The recheck confirms
   214/132 → the agent **bumps queue class to 0 by itself**, flashes the doctor, and a
   **10-second CANCEL countdown** runs at the desk (owner ruling); cancel restores the original
   queuing, expiry makes reversal supervisory. "Save & send NOW" works with only BP + pulse +
   SpO₂ — an emergency trims the required set.
4. **Rest-and-recheck.** An elevated-but-not-dangerous first reading against history →
   five-minute rest, the patient moves to the bench's **resting state with a visible recall
   time**, the desk clears for the next patient, the recall fires, the second reading lands —
   and **both readings go to the doctor as a pair, never averaged**.
5. **The gates.** A weight typed `4.8` on an adult is held at a slipped-digit gate; an SpO₂ of
   45 on a talking patient is held **out of the chart** until it survives a re-clip; a
   carried-forward height is **locked** and unlocks only with a preset reason, old value kept
   beside the new.
6. **Paediatrics.** A 4-year-old flips the band: MUAC becomes required (with SAM/MAM/green
   zones), BP steps out ("not routine under 5"), fever is flagged to the doctor ahead of the
   call, ranges change.
7. **Amend after save.** Taps the ✓-with-doctor bench row → the chart re-opens for amendment;
   fixing a value keeps the old one in a field-level audit trail with name and clock; the
   doctor's board refreshes on save; Esc abandons with the saved chart untouched (owner ruling).

If those seven run without narration, the phase series is done.

## Read these first, in this order

| What | Where |
|---|---|
| Mission & vision — the whole project brief | `docs/PROJECT-BRIEF-2026-08-30.md` |
| **The signed-off design (open it, walk all six bench stories)** | `docs/design/2026-08-31-vitals-desk/bay-one.html` · live: https://claude.ai/code/artifact/5e9b4ae5-7339-4a2a-9659-862a9fa10b02 |
| The identity source this seat carries | `docs/design/2026-08-31-registration-counter/desk-one.html` |
| Method — one doc per phase, LIGHT lane, stop-loss | `docs/superpowers/EXECUTE-METHOD-V3.md` |
| Rules every coding agent must hold | `docs/superpowers/AGENT-RULES.md` |
| The lessons ledger — at minimum §5 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` |
| **Before running any test or deploy** | `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` |
| **The shipped vitals screen this seat replaces or extends** | `apps/web/src/screens/opd-vitals.tsx` |
| The server authority on bands & danger flags | `apps/core/src/modules/opd/vitals-rules.ts` (and `time.ts` `ageYearsAt`) |
| The vitals requirements ruled (T5) and the queue gate (T6) | `docs/superpowers/plans/2026-08-29-EXECUTE-PROMPT-flow3-front-desk.md` |
| The cross-screen patient session that already exists | `apps/web/src/lib/patient-in-hand.tsx` |
| The sibling build lane's handoff — shared primitives live here | `docs/superpowers/plans/2026-08-31-EXECUTE-PROMPT-registration-counter.md` |
| Hindi rules | `docs/design/2026-08-29-opd-counter-flow-v2/DevanagariSpec.dc.html` |
| Palette discipline of the shipped app | `apps/web/src/styles.css` |

## The owner's design rulings — carry these, do not relitigate

All from the Bay One review, 2026-08-31, implemented and visible in the archived prototype
(its **design schema** overlay lists every RULED and DECIDED line):

1. **The auto-bump stands.** On a *double-confirmed* danger reading the agent changes queue
   class to 0 by itself — with a **10-second cancel window at the desk**; cancel restores the
   original queuing; after the window closes, reversal is supervisory. One danger reading only
   *demands* a recheck (other arm, now). The agent never downgrades urgency alone.
2. **Serial-device capture is a toggle, shipped OFF.** The owner is procuring serial devices
   (landing within days of 31-Aug). Until they land the bay runs the **typing lane**; the
   header toggle flips lanes and every sanity gate is identical in both.
3. **The typing lane must be fast**: ⏎ commits and jumps to the next empty field, 1–8 address
   fields, per-patient lead-vital autofocus, no click-before-type.
4. **Amend-after-save is a staff right.** A saved chart re-opens from its bench row; every
   changed field keeps its old value in the trail with name and clock; abandoning leaves the
   saved chart untouched.
5. **Three doors into the session**: scan the barcode, or type the token number, or type the
   UHID — identical lane, no second-class path.
6. **A save is confirmed by a bold ✓** — a banner naming who went to which doctor's board, and
   the same tick on the bench row.
7. **Desk One identity carried whole** (paper `#f4f7f4`, pine `#132420`, green `#0e6b4e`,
   marigold `#dd8f1c`, brick `#b23a30` for danger only, agent voice mint-on-pine, Plex trio,
   footer agent bar + F2 + log, Ctrl+K, session column, Esc discipline, in-sight agent cards).
   Three flagged divergences are part of the sign-off: **the bench rail is always on screen**
   (rest timers die in drawers), **tiles not a form**, and the single agent-acts-alone case (#1).
8. **DECIDED lines carried from the prototype** (uncontested): pairs of readings are kept,
   never averaged or overwritten · BP not routine under 5, MUAC required under 5 · weight is
   never spoken across the room and the patient display never shows numbers · an emergency save
   requires only BP + pulse + SpO₂ · a sub-75 SpO₂ lives in the log, not the chart, until it
   survives a re-clip · a suspiciously instant RR gets a nudge and a 15-second counter, never a
   block · rest-and-recheck is for elevated maybes only.
9. Standing seat-pass rulings: English leads staff screens, Hindi (Devanagari, `line-height
   1.55`, western digits) leads anything said to or held by the patient · dates `31-Aug-2026`.

**Two decisions to surface, not make silently:**
- **The procurement ledger** (₹ devices overlay in the prototype: serial lane ≈ ₹70,960/bay vs
  manual ≈ ₹16,110) is the owner's; the devices are ordered but model/vendor confirmation and
  the driver integration scope stop for the owner when real hardware arrives.
- **Theming**: the RC lane already ruled the mechanism (**alias layer** over the shipped
  variables — see `registration-counter-build` memory / RC phase docs). Reuse that layer;
  do not invent a second mechanism for this seat.

## Ground truth — already built; verify, then reuse, never rebuild

Measure everything; remember nothing. As of 2026-08-31 these exist — confirm each before authoring:

- **`opd-vitals.tsx` is deployed** (07-series): registered-visits worklist, band-aware required
  fields (client mirror of `vitals-rules.ts`; **the server is authoritative** — 400
  `vitals_incomplete` is rendered, never swallowed), danger flags returned by
  `POST /opd/visits/:id/vitals`, allergy quick-capture, restricted-record 404 → alias + adult
  band fallback, auto-advance on save. This seat **extends or replaces it — decide which in the
  phase doc.**
- **Vitals gate the doctor queue** (flow3 T5/T6): only vitals-done patients are callable —
  verify the exact status transitions before touching them. The **priority ladder
  `opd.queueClass` 0–4 is computed server-side**; the escalation (#1) writes it through a real
  route with the 10-s cancel semantics — design compensating-action semantics in the phase doc
  (apply-then-revert beats delayed-apply: the doctor must see the flash immediately).
- **Carried-forward locks**: the T5 ruling says height carries greyed and unlocks only with a
  preset reason — **check whether that shipped or is ruling-only** (the deployed screen resets
  the form empty). Build or wire accordingly.
- **`usePatientInHand`** exists; the session column renders it, it is not a new store.
- **PHI read logging (`0038`) and audited amendment patterns** exist from 07a — the
  amend-after-save trail (#4) extends that machinery, never forks it.
- **Realtime**: queue topics + 15 s poll pattern in the shipped screen; the bench rail and the
  bold-✓/callable flip ride the same hint-not-correctness convention (D6).
- **The agent surface**: the RC lane is building the footer bar, ticker, ask box, and the
  `agent_ledger` table — **shared primitives, one implementation**. Check that lane's progress
  first; consume, don't duplicate. Every unlock, gate override, auto-bump, cancel, and
  amendment lands in that ledger with a timestamp.

## What is genuinely new — the build list to cut into phases

Cut into 3–5 phase docs by the method; suggested grain below. Where a call is open, pick the
most defensible Indian-corporate-hospital answer, mark it DECIDED with one line, and keep
moving. Stop only for money, procurement, or law.

**A · Identity & the bench.** The three-door identify (barcode = keyboard-wedge input — same
field as the typed token/UHID, it just arrives faster; no separate scanner stack in v0), the
bench worklist with states (`waiting · resting(recall_at) · away(turn held) · in-hand · done`),
pre-staging on identify, the valve pill (bench depth vs callable count), the bold-✓ save
confirmation, the session column.

**B · The capture core.** The **reading model**: value + source (`typed | device | counted`) +
takes-as-pairs (never averaged — likely a child table or JSON takes column on the vitals row),
MUAC as a first-class vital, band-aware required sets extended (child < 6: MUAC required, BP
not-routine; emergency: trimmed set), the typing-lane keyboard mechanics, the sanity gates
(slipped digit, shrinking adult, probe-error SpO₂ held out of chart, RR honesty nudge) —
**client-immediate, server-enforced**, and the carried-forward lock with preset unlock reasons.
Context chips (BP-med-taken, fasting, just-climbed-stairs) riding the encounter to the doctor.

**C · Escalation & recheck.** The danger protocol as a state machine on the visit: one danger
reading → `recheck_demanded` (other arm); double-confirm → auto `queueClass=0` with the 10-s
cancel (compensating revert, both actions in `agent_ledger`), doctor-board flash seam, escort
note; rest-and-recheck as a queue-entry state (`resting`, `recall_at`) with recall surfacing on
the bench — not in anyone's memory.

**D · Amend & audit.** Re-open a saved chart from the bench, field-level amendment trail (old
value, actor, clock), doctor's board refresh on amended save, abandon-untouched semantics.

**E · The serial seam.** The lane toggle as config, a device-driver interface stub (the real
serial/BLE drivers are a later phase when hardware lands — build the seam, not the driver),
keystrokes-vs-device-reads telemetry per patient (the honest score the owner saw), and the
procurement stop.

## Discipline

- **Two coding lanes are now live** (RC build + this). They must never share this checkout
  (`2026-08-29` collision) — worktrees per the protocol doc, and coordinate on the shared
  primitives named above (theming alias layer, `agent_ledger`, patient-in-hand) instead of
  building them twice.
- `pnpm verify` green in one run is the bar; prove the test DB after the fact if in doubt.
- **Do not deploy.** Production has never left `commissioning`; the owner holds the deploy.
  Code-complete + verified is this series' finish line.
- Close every open item on a phase before the next; name the owner's rulings in the close
  report. Feature-complete with an unnamed open judgment call is not closed.

## Start here

Read the brief, then **walk the archived prototype** — all six bench stories: Sunita
(trend/rest/chips), Ganesh (escalation + cancel), Aarav (paediatric), Savitri (gates + locked
carry-forward + dignity), Ramdev (rest recall), Salma (turn held), plus an amend on any ✓ row —
then the ground-truth files. Come back with the phase cut (A–E above is a suggestion, not a
ruling), what you found already wired vs. ruling-only on the shipped vitals screen, the RC
lane's state on the shared primitives, and the one or two decisions that need the owner —
**before** you author phase one.
