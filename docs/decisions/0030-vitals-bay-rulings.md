---
type: decision
id: "0030"
title: "Vitals bay: 10-second cancel on auto-bump, serial capture off, a fast typing lane, amend after save"
description: "Vitals bay: auto-bump with a 10-second cancel, serial capture behind a toggle shipped off, a fast typing lane, and amend after save."
generated: { by: agent:claude, at: 2026-08-31 }
verified: []
status: stable
ruling: ruled
tags: [opd, vitals]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0030 — Vitals bay: 10-second cancel on auto-bump, serial capture off, a fast typing lane, amend after save

- **Date:** 2026-08-31   **Status:** Ruled
- **Area:** opd, vitals

## Decision

Owner rulings on the Bay One vitals-desk prototype:

1. **Auto-bump stands** on double-confirmed danger vitals, with a **10-second CANCEL window** at the desk; after the
   window closes, reversal is a supervisor's act.
2. **Serial-device capture is a header TOGGLE, shipped OFF** until the serial devices the owner is buying arrive.
   Until then the bay runs the typing lane.
3. **The typing lane is first-class and fast:** live input on every empty tile, Enter commits and jumps to the next
   field, the patient's "lead vital" gets auto-focus, and the sanity gates are identical in both lanes.
4. **Amend-after-save is a staff right:** a saved row re-opens; any value can be re-entered; the change is audited
   beside the old value; it works on a copy, and Esc abandons it untouched.
5. **Three doors into a session:** scan the barcode, type the token number, or type the UHID; all start the same lane.
6. **Bold save confirmation:** a green banner names who was saved or amended and to which doctor's board they went;
   the bench row wears the same bold tick.

## Why

The bay is a fast, repetitive station; danger must escalate on its own, yet a slip must be cheap to undo.

## Consequences / how to apply

- The countdown updates text only and never repaints the screen (a repaint wipes half-typed input).
- Agent DECIDED lines the owner did not contest (not rulings): recheck a danger reading on the other arm; keep pairs
  of readings, never average; no routine BP under 5 years, MUAC required; weight never spoken aloud; an emergency
  save trims the required set to BP + pulse + SpO₂; SpO₂ under 75 is held out of the chart until a re-clip confirms.
- Prototype: `docs/design/2026-08-31-vitals-desk/bay-one.html`; build prompt
  `docs/superpowers/plans/2026-08-31-EXECUTE-PROMPT-vitals-desk.md`.
- Related: 0037 (the emergency save also opens the fee gate).
