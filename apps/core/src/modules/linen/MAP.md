---
type: module-notes
title: "linen — module notes"
description: "Why and traps of the linen module: par computed from beds and their class, the append-only movement ledger, book balance from the last count, infected linen as its own pool and batch, laundry short deliveries, four-eyes condemnation, the weekly loss variance computed on read, the linen change task IPD will raise, and (LD-1) signed rounds, sealed bags, holds, the in-house plant, quality check, CSSD and the bed-ready gate."
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
LD-1 laundry floor: `docs/specs/978-laundry-floor.md` (#978), decision 0087; acceptance `acceptance/laundry-floor-978.acceptance.test.ts`.

## 1. Purpose
Linen for every ward: par stock from the ward's beds and their class, daily top-up from the linen store, soiled and
infected returns, laundry out and in per item, borrowing between wards, condemnation with a second person's approval,
ward counts, and the weekly loss per ward and item. No money (vendor billing is out of scope), no patient identity.
LD-1 (#978) adds the laundry floor: signed pickup and delivery rounds, sealed bags, MLC/chemotherapy/radioactive holds,
the in-house plant (machines, cycles, the disinfection rule), quality check, theatre sets to CSSD, mending, and a bed
that is ready only when it is made. Piece identity (`linen_pieces`, `piece_id`) exists and is empty until tags arrive;
the vendor's per-piece money, recovery, uniforms, chemicals and licences are LD-2 (#979).

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
  ward class) and `seedLinenItems` (truncateAll empties the seeded catalogue); `mkLinenStaff` (LD-1: real users with
  PINs, an RSO appointment, a theatre and a newborn ward).
- LD-1 (#978): `floor.ts` — `openRound`, `sealBag`, `signPickup`, `signDelivery`, `signerOf`, `weighBag`,
  `soiledRoomView`, `sealedBags`, `wardBeds`; `holds.ts` — `placeHold`, `releaseHold`, `requireNotHeld`, `wardOfBed`,
  `releaseExpiredHolds`; `plant.ts` — machines, `startCycle`, `finishCycle`, `releaseBatch`, `routeToVendor`,
  `recordQc`, `handToCssd`, `mendReturn`, `plantView`; `gate.ts` — `bedReadyGate`, `releaseLinenWaits`,
  `bedsWaitingForLinen`, `shelfShort`, `rushDemand`; `clock.ts` — `runLinenClock`, `dueSlots`. Seams it reads:
  `ipd/linen-seam.ts` (`plannedDischargeBeds`, `mlcOccupiedBeds`), `ot/linen-seam.ts` (`theatreCasesOn`), aerb
  `appointedPerson`, maintenance `raiseTicket`. Migration `0263_laundry_floor.sql` (renumbered at merge).

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

### 3.6 LD-1 — rounds and sealed bags (D1)
A pickup is ONE act, `signPickup`: nothing is written until the runner (the caller) and EITHER the ward (a PIN, by user id
or sign-in name, never the runner) OR "runner only" with a reason have signed (`linen_rounds_one_ward_sign_ck` says the
same in the table). Loose linen is counted by piece; a sealed bag goes by tag only — the ward declared its pieces when it
sealed it (`sealBag`, checked against the book), and the ledger moves those declared pieces (`bag_id` on the rows). The
soiled room sees bags by tag and weight (`soiledRoomView`, `weighBag`). `sendToLaundry` takes `bagTags` (the bag's pieces
travel unopened) and loose `lines` checked against the LOOSE pool (`soiledPool(..., { loose: true })`). A delivery
(`signDelivery`) issues up to par through the same path as `topUpWard` (`upToPar` + `issueToWardIn`); a ward at par is
recorded as skipped, unsigned. The clock (`runLinenClock`, on the worker tick while `linen` is on) raises each live
ward's slot rounds (`LINEN_ROUND_SLOTS`, IST) once, within a two-hour catch-up.

### 3.7 LD-1 — holds (D4)
A hold is on a BED (never the patient). Every bag from that bed is refused at a pickup and at a batch (`on_hold`) while
the hold is active. MLC: released only with the police receiver (name, rank, station); the bed's sealed bags go off the
ward's book (`hold_handed_over`) and never reach the laundry. Chemotherapy: no hand releases it (`released_by_clock`);
the clock does, 48 h after `doseAt`. Radioactive: only the RSO appointed today (`aerb.appointedPerson`).

### 3.8 LD-1 — the plant, quality check, CSSD (D2, D5, D6, D7)
Every batch has ONE stream (`streamOf` → `mixed_stream`) and a `mode` (in_house / vendor). In-house: `sent` (waiting) →
`washing` (`startCycle`) → `rewash` (an infected cycle that missed 71 °C/3 min or 65 °C/10 min, `linenDisinfected`) or
`qc` (`releaseBatch`) → `received` (`recordQc`; theatre waits for `handToCssd`). A cycle's batches share its infected flag
and stream by composite key (`linen_cycle_batches` → `linen_wash_cycles (id, infected, stream)` and → batch), so a mixed
load cannot be written even past the intent. A machine down refuses a cycle; with no washer up, waiting work is the
vendor queue (`plantView.vendorQueue`, `routeToVendor`, then `receiveFromLaundry` as any vendor batch). A machine with a
place raises a maintenance ticket when marked down (as the linen system actor). QC per item: pass (`laundry_in`, or for
theatre `issue_to_cssd` on a CSSD PIN + `linen.cssd_receive`), rewash (`qc_rewash`, back to the soiled pool), mend
(`qc_mend`; `mendReturn` → `mend_return`), condemn (a store condemn request — four eyes as before).

### 3.9 LD-1 — the bed-ready gate (D3)
Housekeeping's passed check (`housekeeping/kinds.ts` `bedCleanVerified`) asks `bedReadyGate` before freeing the bed.
Shelf = book on hand − one set per occupied bed − one set per bed already waiting. Short of a set → a `linen_bed_waits`
row (rush) and the bed stays `cleaning`. `issueToWardIn` (top-up, delivery) and a borrow into the ward call
`releaseLinenWaits`, which clears waits oldest first while the shelf holds a set and frees each bed still in cleaning
(`ipd.markBedCleanIn`). DECIDED: a ward never counted and never moved is not live on linen and is not gated; while
`linen` is dark the gate lets every bed through; a bed marked clean by hand at the Beds board is not gated.
`rushDemand` is today's planned discharges per ward against the shelf plus today's theatre cases, computed on read.

## 4. Invariants and traps
- **The ledger is append-only** (trigger `linen_movements_append_only`). A wrong entry is corrected by a further one.
- Counts and movements at the SAME instant: the movement is AFTER the count — in `bookBalances` (`m.at >= counted_at`)
  and in `weeklyVariance` (inside the window from the opening count, outside it at the closing count). One rule, both reads.
- An act's instant is the caller's `now` when given (tests), else the database's `clock_timestamp()` read AFTER the
  act's lock (`stamp`): the controller passes no clock.
- Returns, a lending ward's borrow and an approved write-off are refused above the ward's book balance
  (`exceeds_on_hand`): a ward live for the first time counts its shelves before it returns anything. DECIDED.
- A count's idempotency key reused with other numbers is refused (`key_reused`); the same numbers again are one count.
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
- LD-1: `intents.ts` and `holds.ts`/`floor.ts`/`plant.ts`/`gate.ts` import each other (helpers one way, `requireNotHeld`
  and `releaseLinenWaits` the other): a cycle that only works because every use is inside a function body. Keep it so.
- LD-1: a tag is unique only among LIVE bags (sealed, picked); it is reused once its bag is sent or handed over.
- LD-1: `releaseBatch` does not look for the "last" cycle by time (two cycles can share an instant): a batch back in
  `washing` with every cycle finished had its last cycle pass, because a failed infected cycle moves it to `rewash`.
- LD-1: an MLC hold placed after the bag was picked up leaves that bag in the soiled room, blocked, until the hold ends —
  the hand-over moves only bags still sealed on the ward. A new migration edit needs the lane's test databases dropped
  (drizzle does not re-run an edited migration).

## 5. Who calls linen
- kernel: manifests (`linenManifest`, API only). No subscription. LD-1: the worker tick runs `runLinenClock` while
  `linen` is on (`kernel/worker/jobs.ts`, `whenModuleOn`).
- housekeeping: `bedReadyGate` from `bedCleanVerified` (LD-1, D3).
- **Seam, not built: IPD admission and discharge call `raiseLinenChange(tx, { placeId: bedId, reason })`** inside their
  own transaction. This branch has no IPD admission yet, so linen subscribes to nothing. Daily linen change per policy
  is ward routine and is not raised as tasks (no worker job in this lane).
- tasks: `defineTaskKind`, `raiseTask` through `modules/tasks/index.ts`.
