---
type: decision
id: "0069"
title: "Staff file their own leave; a copilot act confirmed by the person's own tap is the person's act; a refusal's reason never rides a notice"
description: "The owner ruled that every member of staff can ask for leave on My leave (web and phone) and from the copilot chat, that the department's roster publishers decide it, that a copilot proposal the person confirms with their own tap runs as that person's direct act, and that the reason for a refusal is shown on My leave and in chat but never in a bell row or phone notice."
generated: { by: agent:claude, at: 2026-10-11 }
verified: []
status: stable
ruling: ruled
tags: [roster, leave, copilot, privacy]
supersedes: []
superseded_by: []
sources:
  - { id: copilot-plan, resource: "docs/superpowers/plans/2026-10-10-copilot-PLAN.md", title: "Staff copilot plan v2, epic E2.2" }
---
# 0069 — Staff leave, and copilot acts the person confirms

- **Date:** 2026-10-11   **Status:** Ruled
- **Area:** roster (`modules/roster/leave.ts`, `absences.ts`, `policy.ts`), copilot E0.2 (`kernel/copilot/act.ts`)

## What is ruled (owner, 2026-10-11, answering the E2.2 spec questions)

1. **Build leave fully.** Until now nobody could ask for leave: `requestAbsence` had no caller. A person files their
   own leave (CL, EL, ML, comp off) on My leave, web and phone, and sees its status; the holders of
   `roster.periods.publish` for their department (or hospital-wide) approve or refuse it. The requester never decides
   their own.
2. **"Confirm = own act."** The roster matrix keeps `request_absence` and `request_cover` at `never` for the copilot
   *itself*. A proposal the copilot shows and the person confirms with their own tap (E0.2) runs as that person,
   `via: "direct"`, exactly as the same tap on the screen. The chat card never carries a leave reason, so no reason
   reaches a model; a reason is typed only on the leave screen.
3. **Refusal reason.** A refusal needs a reason. The person's bell row and phone say only "not approved"; the reason
   is read on My leave (Waiting for me shows the count and opens it) and when the person asks the copilot.
4. **Cover and swap from chat**, through the same `requestCover` the My duties screen calls.

## DECIDED by the agent (owner's delegation: not money, procurement or law)

- Kinds a person files themselves: CL, EL, ML, comp off. Maternity, deputation, academic and the rest stay a manager's
  entry. No leave balance is checked: the hospital holds no balance data.
- A leave waits in the department of the person's parent unit at its first day, else of the one department-scoped
  role they hold; none or two → hospital-wide publishers only.
- One request is at most 90 days and starts within 180 days; past days are a manager's entry.
