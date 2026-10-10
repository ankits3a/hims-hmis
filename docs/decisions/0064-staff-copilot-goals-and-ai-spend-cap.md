---
type: decision
id: "0064"
title: "The staff copilot track is judged by nine measured goals, and model spend is capped at ₹5,000 a day"
description: "The owner approved goals G1–G9 of the staff copilot plan as the definition of done (usage, real acts, Hinglish understanding, speed, critical values, audit, wrong-patient acts, cost, owner digest) and set a hard daily cap of ₹5,000 on AI model spend, after which the copilot answers from its phrasebook only until midnight IST."
generated: { by: agent:claude, at: 2026-10-10 }
verified: []
status: stable
ruling: ruled
tags: [copilot, ai, goals, money, staff, mobile]
supersedes: []
superseded_by: []
sources:
  - { id: copilot-plan, resource: "docs/superpowers/plans/2026-10-10-copilot-PLAN.md", title: "Staff copilot plan v2: goals, milestones, epics" }
  - { id: copilot-roadmap, resource: "docs/superpowers/2026-10-10-ROADMAP-copilot.md", title: "Staff copilot roadmap C0–C8" }
---
# 0064 — Staff copilot goals and the AI spend cap

- **Date:** 2026-10-10   **Status:** Ruled
- **Area:** copilot (kernel/copilot, staff app, web ask boxes)

## What is ruled (owner, 2026-10-10)

1. **The goals in `plans/2026-10-10-copilot-PLAN.md` §1 (G1–G9) are the definition of done** for the staff
   copilot track, with the targets and windows written there. A goal is done when its target holds on production
   for its whole window, read by the query named in the plan's §6, dated, and shown to the owner.
2. **AI model spend is capped at ₹5,000 a day** (ruling R-4, cap part). On reaching the cap the copilot routes
   every question by its phrasebook only until midnight IST, and the Copilot health page says so. The provider
   choice for the owner's ops copilot (rest of R-4) is still open.

## Why

The owner asked that "goal is done" be defined before implementation starts. The goals were reviewed by an
independent Fable pass, which lowered two targets (G1 40%→25%, G2 200→100 acts a week on shared records) and added
G7 (no act on the wrong patient, ever) and G8 (cost cap). The ₹5,000 figure is the one proposed in the September
agentic-layer brainstorm (O-6); the owner chose it over ₹500 and ₹2,000.

## What this does not change

The copilot still runs as the asking user, the model still only routes to a tool name, every act waits for a
human tap, and no patient identifier goes to a model except under decisions 0048/0049. Rulings R-1 (drafts), R-2
(staff voice to cloud speech), R-3 (second server), R-5 (insurance module) and R-6 (DPIA signature) stay open.
