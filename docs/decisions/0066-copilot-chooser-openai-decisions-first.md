---
type: decision
id: "0066"
title: "The copilot asks the OpenAI Decisions API first and TypeSafe second, and its eval set is recorded against OpenAI with no manual step"
description: "The owner ruled that the copilot's question router asks OpenAI's Decisions API first and TypeSafe only when OpenAI is unsure, and that the frozen copilot eval set is recorded against OpenAI automatically, with the label check done by the agent instead of an owner spot-check."
generated: { by: agent:claude, at: 2026-10-11 }
verified: []
status: stable
ruling: ruled
tags: [copilot, ai, eval, spend]
supersedes: []
superseded_by: []
sources:
  - { id: copilot-plan, resource: "docs/superpowers/plans/2026-10-10-copilot-PLAN.md", title: "Staff copilot plan v2, epic E0.4" }
  - { id: chooser-eval, resource: "docs/superpowers/plans/2026-10-07-chooser-evaluation.md", title: "TypeSafe vs OpenAI Decisions, 2026-10-07" }
---
# 0066 — Copilot chooser: OpenAI Decisions first

- **Date:** 2026-10-11   **Status:** Ruled
- **Area:** copilot router (`kernel/copilot/choice-route.ts`, `COPILOT_CHOOSER_ORDER` in `kernel/config.ts`), eval set
  (`kernel/copilot/acceptance/`)

## What is ruled (owner, 2026-10-11)

"I want no manual help here. Use OpenAI decision API for this."

1. **Order.** The default `COPILOT_CHOOSER_ORDER` is `openai,typesafe`: OpenAI's Decisions API is asked first, and
   TypeSafe only when OpenAI is below the 0.6 line. Triage keeps `typesafe` alone. An environment that sets the
   variable explicitly keeps what it sets.
2. **Eval recording.** The E0.4 eval set's chooser answers are recorded against OpenAI Decisions by
   `apps/core/scripts/copilot-eval-record.ts`, using the key file `HMIS_OPENAI_KEY_FILE` names. Nobody types a
   key or records by hand.
3. **No owner spot-check.** Expected labels are checked automatically. Every item where OpenAI's answer at the line
   disagrees with the label is reviewed by the agent. A label changes only when it is clearly wrong; any other
   disagreement stays in the set as a known miss outside the floor.
