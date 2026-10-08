---
type: decision
id: "0055"
title: "Automatic medicine aliases use the strict line: no wrong answer in the evaluation, fewer answers"
description: "After the 296-term evaluation of the alias pipeline the owner chose the strict confidence line (chooser 0.95, reviewer 0.9) over the first default, which answered twice as many terms and got one wrong."
generated: { by: agent:claude, at: 2026-10-08 }
verified: []
status: stable
ruling: ruled
tags: [formulary, opd, doctor, learning]
supersedes: []
superseded_by: []
sources: []
---
# 0055 — Automatic medicine aliases use the strict line

- **Date:** 2026-10-08   **Status:** Ruled
- **Area:** formulary, opd, doctor

Decision [0051](0051-ai-alias-reviewer-and-fda-reference.md) said the alias pipeline is evaluated on
a held-out set before it is switched on, and that the numbers are shown to the owner first. This
record is that showing and the owner's choice.

## What was measured (2026-10-08)

296 labelled terms — brand names, spoken and Hinglish forms, generics, misspellings, abbreviations,
look-alikes, 40 terms that are not a medicine and 39 controlled medicines. Chooser: TypeSafe Jev.
Reviewer: OpenAI Decisions. Run twice.

| Line (chooser / reviewer) | Answered | Right | Wrong |
|---|---|---|---|
| 0.6 / 0.9 (the plan's first default) | 103 | 102 | 1 |
| 0.95 / 0.9 (strict) | 50 and 48 (the two passes) | all | 0, in both passes |

- The one wrong answer at 0.6: "ors" → the ORS sachet, where the label says the term is too vague to
  answer.
- No term that is not a medicine was answered, and no controlled medicine was answered, at either line.
- The two models alone agreed on 28 wrong targets; the rules in code refused 27 of them.
- The labels were written by the agent that built the set, not by a pharmacist.

## The owner's words (2026-10-08)

> "Alias strictness: Strict."

## What is ruled

1. The pipeline's default lines are **chooser 0.95, reviewer 0.9**
   (`ALIAS_CHOOSER_MIN_CONFIDENCE`, `ALIAS_REVIEWER_MIN_PROBABILITY`).
2. A missed nickname costs a doctor a few typed letters; a wrong one can put the wrong medicine in
   front of a doctor. Coverage is expected to grow through trust by use (0051), not by lowering the line.
3. Lowering either line is a new ruling, made on a new evaluation.

## Not changed

The pipeline is still switched off (`ALIAS_PIPELINE_ENABLED`), nothing in the product reads an alias
yet, and switching it on remains a separate step shown to the owner first.
