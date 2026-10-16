---
issue: 582
status: built
approved: 2026-10-11
---
# SPEC — copilot Hinglish eval set in CI (E0.4, decision 0064, goal G3c) — 2026-10-11 — AWAITING OWNER YES

Lane `copilot-eval` (branch lane/copilot-eval from main 6baec16b). Plan: docs/superpowers/plans/2026-10-10-copilot-PLAN.md §1 G3, §3 E0.4.

**What it builds**
1. A frozen set of ~150 masked staff questions (`<<P1>>` placeholders, no names, no UHIDs/phones), each with the tool
   that should answer it, at `apps/core/src/kernel/copilot/acceptance/eval/items-2026-10.jsonl` (one JSON per line:
   id, question, want, script, typo, source).
2. Recorded chooser answers at `apps/core/src/kernel/copilot/eval/recorded.json` (NOT locked), keyed by a hash of the
   exact request the chooser is sent, so a changed question list or changed descriptions shows up as "not recorded".
3. `apps/core/scripts/copilot-eval-record.ts` re-records against the live chooser. Runs on the dev box only, never in CI.
4. A jest test `apps/core/src/kernel/copilot/acceptance/copilot-eval.test.ts`. It runs every item through the real
   `routeQuestion` (phrasebook first, then the recorded chooser at the 0.6 line, chat model off), prints the counts and
   checks them against the floor in `acceptance/eval/floor-*.json`. No network.

**Done means** (binary; these go under `acceptance/` with the set)
1. `jest copilot-eval` runs with the network off, prints `routed right X/N (P%) · phrasebook-only Y/N · confident-wrong W`, and passes on main.
2. If phrasebook cues change so that any one item that now routes right stops routing right, the test fails and names the item.
3. If a recorded chooser answer changes so that any one item that now routes right stops routing right, the test fails and names the item.
4. If an item has no recorded answer, or a tool's description changed after recording, the test fails with "not recorded: run copilot-eval-record". The item is never quietly counted as a miss.
5. Adding a new `items-YYYY-MM.jsonl` + its recordings passes `acceptance-guard`. Editing or deleting any approved items/floor file fails it.
6. Every item's `want` is a current tool name or `none`, ids are unique, and `assertNoIdentifiers` passes on every question.
7. Typecheck, lint, `gen.mjs --check` green; CI's core job runs the test.

**Decisions (DECIDED unless the owner says otherwise)**
- D1 Size and mix: about 150 items. Every one of the 15 tools gets at least 6, `none` gets about 25 (greetings, printer,
  OPD timings, medical advice, "ignore instructions"), and about 5 questions name two patients. Each item is tagged with
  its script, so a slice can be counted. Minimum per script: Devanagari 30 (the seed has only 8), English 30,
  romanised Hindi 60. Also at least 15 with typos and at least 10 Bhojpuri or code-mixed.
- D2 Seed: the 94 questions with expected tools from `/opt/hmis-context/chooser-eval-2026-10-07/run1.json` (the "64 / 82
  copilot questions", grown to 94 with roster). About 56 new questions fill the gaps. The expected tools are written by
  the agent from each tool's description in `choice-route.ts`, and the owner/steward checks them before merge.
- D3 "Routed right" is the final route the production path takes: phrasebook, then the chooser in the default
  `COPILOT_CHOOSER_ORDER` (typesafe), at confidence 0.6. For `want: none`, the right answer is "no tool". When the
  chooser is unsure, the chat model is off, so the item counts as a miss. The phrasebook-only count is gated too, so a
  cue regression cannot hide behind the chooser.
- D4 Floor: ratchet only. Each floor is a new file `floor-YYYY-MM-DD.json` and the test uses the highest one. A new floor
  file can be added freely, but an existing one cannot be edited or deleted, so the floor can only rise. The first
  floor is the value measured at build. G3c's 90% target is reported next to it, not used as the gate.
- D5 Monthly refresh (steward = quality manager, plan §5): masked not-understood and wrong-tapped questions from the
  ledger are added as a NEW `items-YYYY-MM.jsonl`, the record script is run, and a floor file is added if the score
  rose. Approved files are never edited. To retire a bad item, its id goes in a new `retired-YYYY-MM.json`.
- D6 The set goes under `acceptance/` in the build PR itself. Adding files is free, and the owner's yes before merge is
  the approval. After merge it is locked.
- D7 The recordings stay outside `acceptance/` so that a description change in another lane can be re-recorded without
  the owner's label. Any edit to `recorded.json` shows in the PR diff.

**Measured today (no network, phrasebook at 6baec16b against the 94 seed)**: phrasebook-only 48/94 (51%; 39 hits,
5 of them wrong). Phrasebook + recorded typesafe @0.6: **86/94 (91.5%)**, 6 confident-wrong, 5 of which are phrasebook
hits. Phrasebook + recorded openai: 87/94.

**Owner questions**
1. Who signs off the ~150 expected answers before merge: you, the quality manager, or the agent's labels with your spot-check?
2. G3(c) may start under 90% on the larger set. Is it OK to ship with the floor at the measured value and report "not yet met"?

**Collisions**: lanes `copilot-dues` and `copilot-names` (both at 6baec16b) also touch kernel/copilot. This lane only
ADDS files and edits none in kernel/copilot. A lane that changes cues moves the score. A lane that changes a tool's
description (`CRITERIA`) or adds a tool must re-run `copilot-eval-record` (~150 chooser calls on the dev box, a few
paise) and add items for the new tool.
