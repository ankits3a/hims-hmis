---
type: module-notes
title: "linen — module notes"
description: "Why and traps of the linen module: par computed from beds and their class, the append-only movement ledger, book balance from the last count, infected linen as its own pool and batch, laundry short deliveries, four-eyes condemnation, the weekly loss variance computed on read, and the linen change task IPD will raise."
resource: apps/core/src/modules/linen
tags: [linen, ipd, services]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# linen — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/linen.md`. Paths are relative to `apps/core/src/modules/linen/` unless they
start with a module name, `kernel/`, `scripts/` or `apps/`. Citations name a file and a symbol, never a line number.
Update this file in the same PR when you change a flow, an invariant or a trap below.
Spec: SPEC-ipd-companions §5, §10, §11 (kept outside the repository); issue #728, decision 0072.

## 1. Purpose
Linen for every ward: par stock from the ward's beds and their class, daily top-up from the linen store, soiled and
infected returns, laundry out and in per item, borrowing between wards, condemnation with a second person's approval,
ward counts, and the weekly loss per ward and item. No money (vendor billing is out of scope), no patient identity,
no RFID, no worker job.

## 2. Key files (owner of what)
- `packages/contracts/src/linen.ts` — the catalogue (`LINEN_STANDARD_ITEMS`), sets per bed by class
  (`LINEN_SETS_PER_BED`, `linenSetsPerBed`), every intent's zod schema, `LINEN_REFUSALS` (code + sentence + fix), wire types.
- `intents.ts` — `topUpWard`, `recordSoiled`, `recordInfected`, `sendToLaundry`, `receiveFromLaundry`,
  `borrowBetweenWards`, `requestCondemn`, `approveCondemn`, `rejectCondemn`, `recordWardCount`, `setParLevel`.
- `reads.ts` — `wardShapes` (beds by class under each ward), `bookBalances`, `wardStates` (par, on hand, short),
  `soiledPool`, `inTransit`, `weeklyVariance`, `rollingWeek`, `linenBoard`, `linenHandlerView`, `seedLinenItems`.
- `kinds.ts` — `LINEN_CHANGE_TASK` (`linen_change`, skill `general`) and `raiseLinenChange` (the IPD seam).
- `errors.ts` — `LinenError`, `linenHttpStatus`; `linen.controller.ts` — the doors; `manifest.ts` — three permissions.
- Schema `kernel/db/schema/linen.ts` — `linen_items`, `linen_par_levels`, `linen_movements` (append-only by trigger),
  `linen_laundry_batches`, `linen_variances`, `linen_condemn_requests`, `linen_ward_counts`; migration `*_linen.sql`
  (also the batch serial, the trigger and the eight seeded items).
- Web: `apps/web/src/screens/linen-board.tsx` (`/linen`, 16:9), `apps/web/src/screens/linen-handle.tsx`
  (`/linen/handle`, phone, Hindi first), `apps/web/src/lib/linen-api.ts`, styles `apps/web/src/screens/linen.css`.
- Test fixture `apps/core/test/helpers/linen.ts` — `seedLinenHospital` (three wards: general, mixed private + ICU, ICU by
  ward class) and `seedLinenItems` (truncateAll empties the seeded catalogue).

## 3. Main flows
### 3.1 Par
Computed on read, never stored: Σ over the ward's non-retired beds of sets-per-bed(class) × the item's `units_per_set`.
A bed's class is `attributes.class` on the bed (the IPD bed registry's word), else on the ward, else `general`.
DECIDED: general 3 sets, private/deluxe/suite 4, ICU/HDU/NICU/PICU 5; any other class counts as general. Theatre items
(`ot_gown`, `ot_drape`) have `units_per_set` 0, so a ward's computed par for them is 0. A row in `linen_par_levels`
overrides (`setParLevel`, `linen.manage`); `par: null` deletes it. Beds are found by walking the structural kinds under
the ward in memory with `MAX_RESOURCE_DEPTH` and a visited set; a ward nested in a ward keeps its own beds.

### 3.2 The ledger and the book balance
Every act writes one `linen_movements` row per item. On hand = the newest `linen_ward_counts` row at or before now +
movements after it: `issue_to_ward` and transfers IN add; `return_soiled`, `return_infected`, transfers OUT and
`condemn` subtract. A count re-anchors the balance item by item (`recordWardCount`). `topUpWard` without lines issues
exactly each item's shortfall (`at_par` when none); with lines each is refused above the shortfall (`above_par`).

### 3.3 Soiled room and laundry
Two pools: ordinary (`return_soiled`) and infected (`return_infected`), each less what left in a batch of its kind.
`sendToLaundry` makes ONE batch with ONE `infected` flag and refuses an item beyond its pool (`exceeds_soiled`), so
infected linen never travels in an ordinary batch and vice versa. `receiveFromLaundry` is once per batch
(`already_received`): an item short (or left out = 0) writes a `linen_variances` row and the batch ends `short`;
more than sent is refused.

### 3.4 Condemn (four eyes)
`requestCondemn` (handle) → `approveCondemn` / `rejectCondemn` (manage). The decider is never the requester
(`approver_is_requester`, and a CHECK constraint on the table). Only an approval writes the `condemn` movement.

### 3.5 Weekly loss variance (on read)
For the caller's window [from, to): `missing = opening + issued − returned − counted`, where `counted` is the last
count IN the window, `opening` the last count BEFORE it (0 if none), and issued/returned are the movements between the
two counts (issued includes borrowed in; returned = soiled + infected + borrowed out + condemned). No count in the window
→ no row (not guessed). The board uses `rollingWeek(now)` (seven IST days ending today, via `istDayWindow`).

## 4. Invariants and traps
- **The ledger is append-only** (trigger `linen_movements_append_only`). A wrong entry is corrected by a further one.
- Counts and movements at the SAME instant: a movement at exactly the count's time is counted BEFORE the count
  (`m.at > counted_at` excludes it). Tests pass distinct instants.
- Every act in one ward takes `pg_advisory_xact_lock('linen:ward:<id>')`; the soiled room takes `linen:soiled-room`;
  a borrow locks both wards in sorted order (no deadlock).
- `wardStates` runs its queries one after another, not in `Promise.all`: intents call it inside their transaction and
  one client runs one query at a time.
- Idempotency: a per-tap `idempotencyKey` makes a double tap one act (movements: kind + ward + key; counts: ward + key;
  batches: key). The phone mints a fresh key per Save.
- Never hand-write the IST offset: batch numbers use `istDayString`, windows `istDayWindow` (`ist-clock-parity`).
- **The kind registry is in-process** (tasks MAP §4): the API defines `linen_change` by loading this index; the worker
  defines it by importing `LINEN_CHANGE_TASK` into `kernel/worker/worker.module.ts` (`WORKER_TASK_KINDS`, pinned by
  `kernel/worker/task-kinds.test.ts`). The linen manifest itself stays API-only.
- No patient and no money on either screen; `raiseLinenChange` passes a patient id through to the task only.

## 5. Who calls linen
- kernel: manifests (`linenManifest`, API only). No subscription, no worker job.
- **Seam, not built: IPD admission and discharge call `raiseLinenChange(tx, { placeId: bedId, reason })`** inside their
  own transaction. This branch has no IPD admission yet, so linen subscribes to nothing. Daily linen change per policy
  is ward routine and is not raised as tasks (no worker job in this lane).
- tasks: `defineTaskKind`, `raiseTask` through `modules/tasks/index.ts`.
