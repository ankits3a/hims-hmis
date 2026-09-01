# SCOPE — what is left in the Registration Counter series, measured against its own acceptance demos

Written 2026-09-01 at RC-3's close, before authoring RC-4, because the measurement changed what RC-4 is. **This document exists to be ruled on, not executed.**

## Why it exists: I had RC-4 wrong, in writing

`2026-09-01-HANDOFF-registration-counter-rc4.md` says *"RC-4's entire content is deleting one of two counters"* and gates the whole phase on that ruling. **That is wrong.** The deletion is a decision RC-3's own D1 introduced; it appears nowhere in `2026-08-31-EXECUTE-PROMPT-registration-counter.md`, which is the series' authority. Measured against that prompt, the deletion is one small edit and **the remainder of the series is roughly three phases of work, not one.** A successor who trusted my handoff would have authored a one-task phase and discovered the rest by grep. The handoff is corrected to point here.

## The bar the series set itself

The EXECUTE prompt's own finish line: *"A tester, using only the app, in one sitting"* runs four demos. **"If those four run without narration, the phase series is done."** So the honest way to size what remains is to walk them.

## Demo-by-demo, measured

Commands are given so the next reader re-measures rather than trusts this table (§5.3 of RC-3's close is what happens when a rails table is not re-measured — it claimed five wired when three were).

### Demo 1 — Returning member · **1 of 6 steps built**

| step | state | evidence |
|---|---|---|
| search shows *why* it matched, never a percentage | **BUILT** (RC-3 T4) | `lib/patients-api.ts:matchReasonKeys` |
| an **in-sight agent card** offers her active membership | **NOT BUILT** | `grep -rl "agentCard\|suggestionCard" apps/web/src` → 0 |
| one click applies it and the bill reprices before billing is opened | **NOT BUILT** | no coupon/benefit input exists on any screen; the seat's only call is `reprice([])` |
| queues her to the shorter line, wait in minutes AND clock time | **HALF** — the overlay SHOWS waits (RC-3 T5); nothing queues her. The seat opens no visit | `registration-counter.tsx` has no `walkIn`/`joinQueue` call |
| takes UPI | **NOT BUILT, and deliberately so** — RC-3 F4 established the seat cannot see settlement, so it prices and does not collect | RC-3 §5.10 |
| the token flips UNPAID → PAID **on the board** | **NOT BUILT on the web** | `queue.fee_status_changed` flips both ways since RC-3 T3; `grep -rl "feeStatus\|feeSettled" apps/web/src` → 0 |

### Demo 2 — Review revisit · **BUILT** ✅

₹0 forced with the rule named, no tender buttons, confirm releases the patient. RC-3 T1/T2 plus the close's exit confirmation. This is the one demo that runs today.

### Demo 3 — Supervisor flow flip · **0 built on the web**

The locked flow pill, switching the counter to Register → Bill → Appointment, and a token that leaves the printer already PAID. RC-1 shipped `counter_sequence` and `token_lane` server-side; `grep -rl "counterSequence\|tokenLane" apps/web/src` → **0**. No pill, no switch, no bill-first path.

### Demo 4 — New walk-in · **0 built**

Four-field register on the seat (today the seat's Register-new button *navigates away* to `/registration`), a channel-partner referral attached (`attributionCode` is accepted by the server and sent by nothing), a **future appointment mid-walk-in without dropping today's session**, and *"every autonomous thing the agent did is in the footer log with a timestamp."*

**That last clause is an entire unbuilt slice.** `grep -rn "agent_ledger" apps/core/src` returns exactly one hit — a comment in `opd/events.ts:186` reading *"RC-4 owns the `agent_ledger`"*. There is no table, no writer, no reader, no footer, no log.

## What that adds up to

Build-list slice **D — the agent surface** (EXECUTE prompt) is untouched: the footer ticker and log driven by real system events, in-sight suggestion cards from rules the data already supports, the `agent_ledger` table (*"a real table, because it is the audit answer to 'what did the AI do?'"*), and the ask box's v0 seam. Slice **A**'s web half and slice **C**'s remainder are also open.

**One phase cannot carry that.** RC-1, RC-2 and RC-3 each ran five tasks at ~1.0–1.15M tokens; the remainder is three of those, and pretending otherwise would set a stop-loss that fires on scope rather than on waste (§2.95).

## PROPOSED CUT — three phases, and the owner's ruling on each

The grain follows the EXECUTE prompt's own slices, ordered so each phase's output is demonstrable on its own.

**RC-4 · The counter that finishes a patient.** The seat opens a visit, joins a queue, and shows the board's PAID stamp. Wires `join-queue`, `counter_sequence`/`token_lane` and the flow pill, `feeSettled` on `WireQueueEntryView`, and the four-field register in place of the navigate-away. **Closes demos 1 and 3.** Also carries the `/counter` deletion, which becomes a one-line edit once this seat can do what the old one does — *and that ordering is the argument for ruling it here rather than earlier: the honest moment to delete the shipped counter is when its replacement demonstrably finishes a patient, not before.*

**RC-5 · Benefits in the clerk's hands.** The coupon and referral inputs, the benefit chips that reprice in place, late attach at billing. Every rail exists server-side since RC-2 and **not one has a consumer** — this is the phase that makes the money UI real. **Closes the rest of demo 1 and half of demo 4.**

**RC-6 · The agent surface v0.** `agent_ledger` as a real table, the footer ticker and log over real events, deterministic in-sight suggestion cards, the ask-box seam without the model behind it. **Closes demo 4.** The EXECUTE prompt is explicit that *the UI contract is the product* and *"build the seam, not the model"*, and equally explicit that `counter-cockpit.html`'s fuller surface is **not** in this series.

## What the owner is being asked

1. **Is this cut right, or should the remainder be two phases, or four?** Three is my reading of the EXECUTE prompt's own slices; it is a judgement about grain, not about content.
2. **Confirm `/counter` is deleted in RC-4, once the seat can finish a patient** — or say it stays. RC-3 §6.2. Both consequences are already staged: `/counter/seat` is the only NAV row with no manifest entry, and the route-count pin's comment already says 45 → 44.
3. The two money rulings in RC-3 §6 (bundled-coupon bearer; whether a full refund un-flips the board) **gate RC-5**, not RC-4 — so they are not blocking the next phase.

## What is NOT blocked

**RC-4 as cut above needs none of the three open rulings.** Opening a visit, joining a queue, the flow pill and the PAID stamp are all rails RC-1 shipped and nothing has consumed. Authoring can begin as soon as the cut is agreed.
