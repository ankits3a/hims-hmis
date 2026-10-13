---
type: module-notes
title: "maintenance — module notes"
description: "Why and traps of repair tickets on the task engine: a bed blocked until the ticket is closed and a nurse confirms, block-on-release for an occupied bed, the hand-unblock refusal in ipd, the repeat-fault replacement flag computed in the raise transaction, and the two boards."
resource: apps/core/src/modules/maintenance
tags: [maintenance, tasks, ipd, beds]
generated: { by: agent:claude, at: 2026-10-13 }
verified: []
stale_after: 2027-01-13
---
# maintenance — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/maintenance.md`. Paths are relative to `apps/core/src/modules/maintenance/` unless they
start with a module name, `kernel/`, `scripts/`, `packages/` or `apps/`. Citations name a file and a symbol, never a
line number. Spec: SPEC-ipd-companions §9, §10, §11 and SPEC-ipd-core §4.1 (kept outside the repository); issue #722,
decision 0072.

## 1. Purpose
Repair tickets for beds, rooms, oxygen points and fixtures. A ticket is the module's own record (place, item, tag,
category, urgency, who raised it, the bed's block); the WORK is a task on the shared engine (`modules/tasks`). A bed
with a repair ticket stays blocked until the ticket is CLOSED, and only a nurse's confirmation (the repair task's
check) closes it. A third fault on one item in 30 days flags it for replacement. A leaf: it imports `tasks` and `ipd`
only through their `index.ts`; nothing imports it except the kernel wiring.

## 2. Key files (owner of what)
- `names.ts` — the five permissions, the two skill roles (`maintenance_staff` new, `biomedical_engineer` existing),
  the fallback notice role, `MAINTENANCE_ACTOR`.
- `kinds.ts` — `defineSkill("maintenance" → maintenance_staff)`, `defineSkill("biomedical" → biomedical_engineer)`,
  kinds `repair_general` / `repair_biomedical` (accept 10 min, tap proof, verify by `ipd.beds.clean` OR
  `maintenance.confirm`, `onDone: ticketsFixedIn`, `onVerified: ticketsClosedIn`).
- `tickets.ts` — the intents: `raiseTicket`, `confirmTicket`, `cancelTicket`, `dispatchTicket`.
- `hooks.ts` — the engine hooks: task done → ticket `fixed`; task verified → ticket `closed` + bed unblocked.
- `store.ts` — `updateTicket` / `logTicketEvent` (version = event seq) and `releaseRepairBlock` (ends the bed's block
  through ipd's `unblockBedIn` when no other open ticket holds it).
- `reads.ts` — `maintenanceBoard` (open by floor, critical first, waiting-for-nurse, blocked beds, replacement flags),
  `bedTickets` (the Beds board's line), `placesForRaise` (the raise sheet's picker).
- `maintenance.controller.ts` — `GET /maintenance/board|bed-tickets|places`, `POST /maintenance/tickets`,
  `POST /maintenance/tickets/:id/confirm|cancel|dispatch`.
- Schema `kernel/db/schema/maintenance.ts` — `maintenance_tickets`, `maintenance_ticket_events` (append-only by
  trigger, migration `*_maintenance_tickets.sql`). Contracts `packages/contracts/src/maintenance.ts`.
- Web: `apps/web/src/screens/maintenance-board.tsx` (`/maintenance`, 16:9), `apps/web/src/screens/maintenance-raise.tsx` (the raise sheet,
  390 px), the repair line / Confirm repair / Report a fault in `apps/web/src/screens/ipd-beds.tsx`,
  `apps/web/src/lib/maintenance-api.ts`. Technicians work on the engine's "My tasks" (`/tasks`).
- Tests: `acceptance/repair-tickets.acceptance.test.ts` (the five done-means), `maintenance.test.ts`, fixture
  `apps/core/test/helpers/maintenance.ts` (`mkMaintenanceWorld`).

## 3. Main flows
- **Raise** (one transaction, advisory lock per place and per tag): an OPEN ticket on the same place + item + tag is
  the same fault → `reported_again`, no new ticket, no new count. Else: repeat count → flag + bell; ticket number from
  the serial; a bed is blocked through ipd's `blockBedIn` (reason maintenance, expected back now + 4/24/72 h by
  urgency) — available/cleaning → `blocked`; occupied → `pending_release` (ipd's `releaseBedOccupant` applies it);
  already blocked for maintenance → JOINED (`source: block`); blocked for another reason → not linked; reserved →
  not blocked (said in the answer). The repair task is raised with `sourceRef = maintenance-ticket:<id>` (one task per
  ticket, not the engine's 10-minute merge), priority critical→stat, due at the same instant as the expected return.
- **Fix**: the technician's Done (`completeTask`) runs `onDone` → ticket `fixed`. The bed stays blocked.
- **Confirm**: `confirmTicket` → `verifyTask` (kind's verifier list; the doer is refused `verifier_is_doer`) →
  `onVerified` → ticket `closed` (closed_by = the nurse) → `releaseRepairBlock` → `unblockBedIn` → the beds rule
  sends a bed back from maintenance to CLEANING (housekeeping raises its clean from that event).
- **Cancel** (maintenance.manage, open tickets only): ticket cancelled, its open task cancelled, the block ended.
- **Dispatch**: a repair task cancelled on the task board leaves the ticket open with no live task ("Not
  dispatched"); dispatch raises a fresh one.

## 4. Invariants and traps
- **The hand unblock is refused in ipd, not here**: `unblockBedIn` reads `maintenance_tickets` (a kernel schema table)
  for an open/fixed ticket on the live block → `repair_ticket_open` ("Close the repair ticket"). It is in the shared
  core, so every door meets it; maintenance closes or cancels its own ticket FIRST in the same transaction, then
  unblocks. Reversing that order refuses maintenance's own unblock.
- Stored states are `open | fixed | closed | cancelled`; `assigned` / `in_progress` are READ from the task, never
  copied (one truth). A task cancelled elsewhere shows as `taskId: null`.
- Repeat rule: earlier NON-CANCELLED tickets in `[now − 30 d, now)` on the same tag (when given, any place) else the
  same place + item kind; ≥ 2 → this one is flagged. Computed in the raise transaction from `now` (tests hand explicit
  instants; no job). A cancelled ticket (raised in error) never counts.
- Lock order: raise = place advisory → (ipd) room → bed → task; verify = task row → tickets → (ipd) room → bed. No cycle.
- Importing the module defines the kinds: the API imports it via `app.module.ts`; the worker imports it bare in
  `kernel/worker/worker.module.ts` (no subscription, no job, no install).
- No patient on any surface; the Beds board line carries the ticket number and state only.
- Owed (later lanes): asset register (the tag is free text), PPM schedules, vendor AMC, photos, device alarm feeds
  (the `source: device` seam with a system actor exists), a ward nurse role (today `maintenance.confirm` sits with the
  OT/recovery/radiology nurses and the duty manager; `ipd.beds.clean` holders confirm too), room/ward blocking.

## 5. Who calls maintenance
- kernel: `app.module.ts` (`MaintenanceModule`), `kernel/modules/manifests.ts`, `kernel/worker/worker.module.ts`
  (import only). The task engine calls its hooks.
- web: the maintenance board and the Beds board (repair line, Confirm repair, Report a fault).
