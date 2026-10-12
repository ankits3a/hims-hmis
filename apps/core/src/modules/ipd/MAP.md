---
type: module-notes
title: "ipd — module notes"
description: "Why and traps of the inpatient module: validated bed and ward attributes on kernel resource rows and the bed-layout loader (E0.3), and the bed intents, reservations with a 2-hour lapse, blocks, incumbent beds and the Beds capacity board (E1.1)."
resource: apps/core/src/modules/ipd
tags: [ipd, beds, resources]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# ipd — module notes

Hand-written notes: the WHY and the traps. Signatures are generated in `docs/architecture/modules/ipd.md`.
Paths are relative to `apps/core/src/modules/ipd/` unless they start with a module name, `kernel/`, `scripts/`,
`packages/` or `apps/`. Citations name a file and a symbol, never a line number. The spec is
SPEC-ipd-core-2026-10-12 §4.1 (kept outside the repository); the plan is decision 0072, issue #715 (E0.3).

## 1. Purpose
The inpatient module. E0.3 starts it with the BED REGISTRY: every floor, ward, hall, room and bed of the
hospital as rows of the kernel resource registry (`kernel/resources`), with IPD's own facts about a bed and a
ward kept in `resources.attributes`. Later lanes add the bed board, admission, transfer, nursing and discharge.
E1.1 (#718) adds the module surface: `manifest.ts` (four `ipd.beds.*` permissions, the Beds menu), `IpdModule`
(the bed routes under `/ipd/beds`, the live topic `ipd_beds:board`) and the bed intents behind the Beds board.

## 2. Key files (owner of what)
- `bed-attributes.ts` — `IpdBedAttributesSchema` (class, gender rule, isolation, negative pressure, ICU flag,
  equipment, day care, overflow) and `IpdWardAttributesSchema` (department code, unit type, ward or hall). The
  rules live in the schema's refinements: airborne needs negative pressure; class `overflow` ⇔ `overflow: true`;
  class `daycare` ⇔ `daycare: true` (DECIDED, E0.3); no equipment tag twice.
- `bed-layout.ts` — `parseBedLayoutCsv` (header row 1; refuses missing or unknown columns), `validateBedLayout`
  (pure: rows → plan or every problem), `loadBedLayout` (diff and, with `apply`, write in one transaction) and
  `formatBedLayoutReport` (the dry-run summary).
- `errors.ts` — `IpdError`; `bed_layout_invalid` carries `detail.problems`.
- `packages/contracts/src/ipd-bed-classes.ts` — `IPD_BED_CLASSES` and `IPD_BED_CLASS_INFO` (census and rates
  flags). Shared with the rate card lane: do not rename its exports.
- `scripts/load-bed-layout.ts` — `runBedLayoutLoad`: `--file`, `--by`, `--apply`. Not a seed.
- `scripts/data/gen-ipd-bed-layout.ts` — `planningBedLayoutCsv` writes `scripts/data/ipd-bed-layout.planning.csv`.
- `beds.ts` (E1.1) — the bed intents: `reserveBed`, `releaseReservation`, `assignBed`, `blockBed`, `unblockBed`,
  `markBedClean`, `releaseIncumbentBed`; the bed-master act `retireBed`; the job `lapseBedReservations(db, now)`;
  the seams `releaseBedOccupant(tx, …)` (discharge/transfer empty a bed through it) and `markBedCleanIn(tx, …)`
  (housekeeping's task completion calls it); the cutover `markIncumbentBeds`; `nextRuleValidBeds`.
- `bed-rules.ts` — `checkBedRules`, the one pure rule check every bed act and (later) every Bed Flow proposal asks.
- `beds-board.ts` — `readBedBoard(db, actor, { wall })`, the board's read model (`IpdBedBoard` in contracts).
- `bed-events.ts`, `realtime.ts`, `beds.controller.ts`, `ipd.module.ts`, `manifest.ts`.
- `kernel/db/schema/ipd.ts` — `ipd_bed_reservations`, `ipd_bed_blocks`, `ipd_bed_stays` (migration `ipd_beds`).
- `packages/contracts/src/ipd/bed-board.ts` — board schema, routes, topic, `IpdRefusalBody`.
- `scripts/mark-incumbent-beds.ts` — `--file`, `--by` (holds `ipd.beds.manage`), `--apply`. Not a seed.
- `apps/web/src/screens/ipd-beds.tsx` — the board (route `/ipd/beds`, `?wall=1` for wall displays).

## 3. Invariants
- A bed is a kernel `bed` row. No new resource kind, no kernel edit, no migration: the attributes are jsonb,
  validated here, and only the keys the schemas name are written. Other keys on a row are kept.
- The loader validates the WHOLE file first. One bad row refuses the file, every bad row is listed by its
  spreadsheet row number, and nothing is written.
- Idempotent upsert by code (`resources_site_kind_code_lower_ux`: site, kind, lower(code)). A second run of the
  same file writes nothing: no row, no history, no event.
- The loader never deletes, retires, moves or revives. An IPD bed (a bed row whose attributes carry `class`)
  missing from the file is reported as "not in file" and left alone. A code already used by a place under a
  different parent, or by a retired place, refuses the file: moving and un-retiring are a person's acts.
- Dry run is the default and needs no permission. Applying needs `auth.users.manage` (DECIDED until the bed
  board declares IPD's own bed-master permission): `bed-layout.ts` `BED_LAYOUT_PERMISSION`, checked inside
  `loadBedLayout` (`bed_layout_forbidden`) and by the script's `--by`.
- The parser refuses a duplicate header name and any row whose cell count differs from the header's.
- An occupied bed's class, gender rule, isolation, ICU, day-care or overflow attribute never changes by file
  (`bed_occupied` refuses the file); equipment may. E1.1 keeps holds in
  `ipd_bed_reservations`, not a kernel status: the loader does not yet refuse a rule change on a held bed (owed).
- A ward and a hall may not share a code (`ward_hall_collision`), though the registry's index would allow it.

### Beds (E1.1)
- An intent is ONE function: parse the contract's zod input → re-check the permission (`ipd_forbidden`) → run
  under the contract's idempotency key (`withIdempotency`, route `ipd:<intent>`) → lock → re-check state and rules
  → write + event. A refusal is `IpdRefusal` (contract code, `rule`, `fix`, `bedRule` such as "Female-only bed",
  `detail`); HTTP 404 for `*_not_found`, 403 for the overflow gate, 409 otherwise (`IpdRefusalBody`).
- LOCK ORDER: the bed's parent (room or ward) FOR UPDATE, then the bed, then IPD rows. The parent lock serialises a
  twin room's two beds (gender fixed by the first occupant or holder until empty) and is also what makes two desks
  racing for one bed answer "bed just taken" with `detail.nextBeds` instead of the kernel's raw `already_occupied`.
- Kernel statuses only. Reserved = kernel `available` + an active `ipd_bed_reservations` row (partial unique: one
  live hold per bed). Blocked = kernel `blocked` + an active `ipd_bed_blocks` row; on an occupied bed the block is
  `pending_release` and `releaseBedOccupant` applies it. Occupant triad: `ipd_admission` / admission id, with the
  patient and billed class on the open `ipd_bed_stays` row (partial unique per bed and per admission). Incumbent:
  occupant `incumbent`/`incumbent` + `attributes.incumbent: true` (+ optional `incumbentGender`).
- DECIDED: a hold may be placed on an available OR cleaning bed; assignment needs `available`. One live hold per
  admission (a new one ends the old as `plan_changed`); assignment consumes the admission's own hold.
- The lapse is `lapseBedReservations(db, now)`, every minute (`kernel/worker/jobs.ts`), system actor
  `ipd-reservation-lapse`, provenance `system`, idempotent; it never ends a hold whose `expiresAt` is after `now`.
- Every event payload carries `provenance` (G11b) and, with an admission, `admissionId` (G2). Moves into cleaning
  carry `clean:routine` / `clean:terminal` (G3). Payloads carry ids only: the gateway fans them to every viewer.
- Board counts: census = class `inCensus` and not overflow; overflow apart; day care/emergency outside both.
  Wall mode sends initials only (`occupant.name` null, block notes blank).
- Overflow beds need `ipd.beds.overflow` (duty manager) — `overflow_needs_duty_manager`, checked before any rule.
- DECIDED rule details: child = under 14 on the day (no DOB → not refused on age); paediatric/NICU/PICU beds refuse
  adults; adult ICU and gender-segregated general beds refuse children; isolation rank none<contact<droplet<airborne
  and airborne also needs negative pressure; ward classes general→suite swap only with a flagged upgrade/downgrade
  in that direction; ICU flag must match both ways; gender = administrative gender, `need.placeAs` for other/unknown.
- Until ipd-admit: `admissionId` is the caller's request id and the bed intents carry `patientId` + `need`; ipd-admit
  derives both from the admission. `reserve_bed` does not yet emit `ipd.admission.reserved` (no admission record).

## 4. Traps
- `docker/prod/deploy.sh` runs every seed on every deploy. The loader is a script a person runs; never wire it
  into a seed.
- PLANNING LAYOUT from the confirmed bed split; the hospital's real room list replaces it. The workbook is
  1,150 beds (720 wards, 240 critical care, 50 NICU/SNCU, 20 LDR, 60 day care, 60 emergency); the rest of the
  1,200 is dialysis stations and theatres, which are not beds. Edit the generator, regenerate, commit both:
  `test/ipd-bed-layout-planning.test.ts` compares the file to the generator byte for byte.
- `scripts/data/` must hold only `.ts` files except files a script takes as an argument
  (`test/scripts-data-compiles.test.ts` `TAKEN_BY_ARGUMENT`); the planning CSV is listed there.
- Codes are unique per kind across the whole site, not per ward: a bed code must carry its ward
  (`F05-ORT-M-B12`), or two wards' "B12" collide. OT recovery bays are kernel `bed` rows too; their codes are
  not IPD's, and a clash refuses the file rather than adopting the bay.
- The loader writes ~1,600 rows through `createResource` (history row and event each). The planning workbook
  takes ~10 s on the build host; the acceptance tests give it 300 s.

- (E1.1) The kernel has no HTTP retire route; `retireBed` is the only retire that knows reservations. A script or
  module calling `retireResource` on a bed directly bypasses the "retired while reserved" refusal.
- (E1.1) `nextRuleValidBeds` does not re-derive each candidate's room gender (a proposal, not an act): the act
  re-checks under lock.
- (E1.1) A new scheduler job owes five censuses: `kernel/worker/jobs.test.ts`, `kernel/worker/scheduler.test.ts`, `test/alerts-parity.test.ts`,
  `test/worker-runtime.e2e.test.ts` and `docker/prod/prometheus/alerts.yml`.
- (E1.1) The bed-layout loader still applies with `auth.users.manage` (`BED_LAYOUT_PERMISSION`); moving it to
  `ipd.beds.manage` is owed.

## 5. Callers
- `scripts/load-bed-layout.ts` (operator).
- `beds.controller.ts` (the web board), `kernel/worker/jobs.ts` (`lapseBedReservations`),
  `scripts/mark-incumbent-beds.ts` (cutover). ipd-admit, ipd-transfer, ipd-discharge and housekeeping call
  `assignBed`/`reserveBed`, `releaseBedOccupant` and `markBedCleanIn`.
