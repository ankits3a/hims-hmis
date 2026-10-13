---
type: module-notes
title: "diet — module notes"
description: "Why and traps of diet and kitchen: the diet order per admission, NPO that always wins (by hand or from an OT booking), the meal lists built at the cut-off, the one reconcile every change goes through, telling the old ward on the task engine, the kitchen board, the ward diet sheet and the dietician's consult queue."
resource: apps/core/src/modules/diet
tags: [diet, ipd, tasks, ot]
generated: { by: agent:claude, at: 2026-10-13 }
verified: []
stale_after: 2027-01-13
---
# diet — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/diet.md`. Paths are relative to `apps/core/src/modules/diet/` unless they start with a module
name, `kernel/`, `scripts/`, `packages/` or `apps/`. Citations name a file and a symbol, never a line number.
Spec: SPEC-ipd-companions §7, §10, §11 (kept outside the repository); issue #736, decision 0072.

## 1. Purpose
The doctor's diet order to the kitchen's meal list. A diet order per admission (catalogue in
`packages/contracts/src/diet.ts` `DIET_CATALOGUE`), NPO with a start and an optional end, four meal rounds with a
cut-off and a serve time, one meal list per ward per meal built at the cut-off, printed (A4 + tray labels), dispatched
by the kitchen and delivered on the task engine. NPO ALWAYS WINS. No money anywhere (decision 0058): diet is inside the
room-rent package and IPD's rate components have no diet line, so nothing is charged here (DECIDED; no price invented).
A leaf: it imports `ipd`, `tasks`, `patients` (types) only through their `index.ts`; OT is heard through its events.

## 2. Key files (owner of what)
- `names.ts` — six permissions, the consumer `diet.reconcile`, the event names it hears (IPD, OT), the two new roles.
- `rounds.ts` — `mealRounds` (settings rows over `DIET_MEAL_ROUND_DEFAULTS`), `slotOf`, `nextSlot`, `dueSlots`,
  `istDayStart` (via `istDayWindow`, never a hand-written offset).
- `trays.ts` — THE tray rules: `npoCovering`, `trayFor`, `reconcileIn` / `reconcileAdmission`, `tellWard`, the locks.
- `lists.ts` — `buildSlot` (every ward, one meal), `buildDueLists` (the meal clock), `buildLists` (kitchen's "Build
  now"), `markPrinted`, `dispatchList` (raises the delivery task), `serveLine` (tap delivered / refused).
- `orders.ts` — `orderDiet`, `startNpo`, `liftNpo`, `npoForOtBooking`, `liftOtNpo`, consults, `setMealRound`, `endStay`.
- `consumer.ts` — `handleDietEvent` / `dietConsumer`. `kinds.ts` — skill `diet_ward` (support_staff) and the kinds
  `diet_delivery` (onDone marks the list delivered) and `diet_ward_notice`. `reads.ts` — kitchen board, list, ward sheet,
  consult queue, wards. `desk.ts` — the dietician's Now card `diet.consults`. `guard.ts` — permission re-check, provenance.
- Schema `kernel/db/schema/diet.ts` — `diet_meal_rounds` (seeded by the migration), `diet_orders`, `diet_npo`,
  `diet_meal_lists`, `diet_meal_lines`, `diet_consults`; migration `*_diet.sql`.
- ipd seam `ipd/diet-seam.ts` `placedCensus` (who lies on a bed, in which ward — one recursive query) and the shared
  `nowIdentities` (exported from ipd's index for diet).
- Web: `apps/web/src/screens/diet-kitchen.tsx` (`/diet/kitchen`, 16:9, print), `apps/web/src/screens/diet-ward.tsx` (`/diet/ward`,
  390 px), `apps/web/src/screens/diet-consults.tsx` (`/diet/consults`), `apps/web/src/lib/diet-api.ts`.
- Tests: `acceptance/diet.acceptance.test.ts` (done means + NPO wins + sealed label), `diet.test.ts`; fixture
  `apps/core/test/helpers/diet.ts` (`mkDietWorld` on the transfer world, `otEvent`).

## 3. Main flows
- **Order.** `diet.order` (doctor, dietician). The live order is ended (`replaced`) and a new row written with its source
  (`dietician` if the person holds `diet.manage`, else `doctor`). A doctor's therapeutic order (diabetic, renal, cardiac,
  high protein, Ryle's feed) opens a dietician consult. Ordering the catalogue's `npo` starts an NPO instead. A nurse at
  this door is answered `nurse_npo_only` unless she asks for `npo`.
- **NPO.** `diet.npo` (nurse, doctor, dietician): per PATIENT, `starts_at` (default now), optional `ends_at`. An OT
  booking (`daycare.booked`) writes one NPO per case (`source_ref = ot-case:<id>`) from 00:00 IST on the surgery day to
  the end of that day (DECIDED: a forgotten NPO cannot starve anyone for days; the surgeon's post-op order resumes the
  diet). `case.cancelled` lifts it and tells the patient's ward (task `diet_ward_notice`).
- **The meal clock.** `buildDueLists` rides the worker's task-clock tick (`kernel/worker/jobs.ts`
  `runTaskAndWasteClocks`, the bmw precedent — no pool client of its own): every meal whose cut-off has passed and whose
  serve time has not gets its lists built once. Each placed patient gets one line: active, or withdrawn `npo` when an
  NPO covers the serve instant. No order → a normal veg tray marked `defaulted`.
- **Reconcile.** Every change (order, NPO, lift, OT, admitted, transfer accepted, bed swapped, stay ended) runs
  `reconcileIn` for the admission over every list not delivered and served no more than 2 h ago: wrong ward → withdrawn
  `transferred` (and the OLD ward told when that list was printed); NPO covers → withdrawn `npo` (ward told if printed);
  missing from its ward's built list → added `late`; NPO gone → back, `late`; diet changed and trolley not gone → updated.
- **Dispatch and delivery.** Print first (`list_not_printed`), then dispatch raises `diet_delivery` on the ward
  (`source_ref = diet-list:<id>`). The attendant's Done marks the list delivered and every untapped tray delivered.
  The sheet may tap a tray delivered or refused (`diet.serve`); two refusals in 24 h open a consult.

## 4. Invariants and traps
- **NPO always wins** and it lives in ONE function (`npoCovering`), read by the build, the reconcile and the preview.
- **The list lock.** `buildSlot` takes `diet:lists` EXCLUSIVELY; every reconcile takes it SHARED. Without it an NPO
  committed while a list is being built is seen by neither (the tray that slips through). Per-admission advisory lock
  `diet:adm:<id>` serialises the acts on one admission.
- Lines are WITHDRAWN, never deleted: the A4 list shows "NPO — no tray", and the record shows why a tray vanished.
- Telling a ward is a task (`diet_ward_notice`, place = the ward, `source_ref` per line and cause), so a redelivered
  event tells no one twice. Its note names a BED, never a patient (task notes show on the worker's card).
- **Identity.** Names come from ipd's `nowIdentities` for the reader: sealed → alias (or "Sealed patient"), no UHID;
  confidential → alias for a reader without `patients.confidential.read`. DECIDED: the BED stays on a sealed patient's
  tray label and sheet row — the tray must reach the bed; the desk card drops the bed for a sealed patient (#767 rule).
- **Installed in BOTH processes** (the passes shape): the manifest's subscriptions need `workerConsumers`' entry in the
  same commit; the worker also needs the two task kinds (`WORKER_TASK_KINDS`, pinned by
  `kernel/worker/task-kinds.test.ts`).
- **The printed paper is never stale at dispatch** (DECIDED, review of 01d53113, `trays.ts` `afterChange`). After print,
  any change (NPO, lift, diet change, a tray added by an admission or a transfer, a tray removed) marks the list
  `changed_since_print`, stamps the line `changed_at`, and tells the ward (a `diet_ward_notice` task naming bed and patient,
  alias if sealed, plus bells to `diet.npo` / `diet.serve` holders) and the kitchen (bells to `diet.kitchen`); dispatch
  answers `list_changed_since_print` until the kitchen reprints — and the reprint carries only the changed lines,
  highlighted. The screen marks a list printed only after "Printed OK?". After dispatch a change says "do not serve" or
  "tray missing"; an added or changed tray leaves the load (`on_load` false) and gets its OWN `diet_delivery` task.
- Bells carry ward, bed and meal — never a patient (GC6, `kernel/alerts/notices.ts`); the task note names the patient.
- **OT dates.** OT moves a case's date with NO event (`postponeCase`; `list.resequenced` only re-orders a day; there is no
  other date-change path). So diet re-reads the cases: on `list.published` for that day and at deploy
  (`workerBackfills` → `backfillOtNpo`, every case from today on). One NPO row per case (`source_ref`): a new date or a
  rebooking after a lift moves the same row; a cancelled case's NPO is lifted. A postponed case's NPO therefore moves
  when its new day's list is published (or at the next deploy), not at the postponement itself.
- A stay end lifts the admission's NPOs AND the patient's NPOs written before the admission (admission id null).
- Without `diet.clinical.view` (the kitchen) the ward sheet carries no order note, NPO reason ("NPO") or provenance ids.
- A consumer payload diet cannot read is logged and THROWN (the dispatcher retries); unrelated events are ignored.
- The meal clock tells the kitchen (`diet.list_missed`, once per meal) when a meal was served in the last two hours with a
  ward that had patients and no list (the worker was down through the cut-off).
- Meal rounds are validated in order, without overlap (each serve at or before the next cut-off).
- Tests pass explicit instants; the meal clock and every act take `now`. Never pin a date the code reads from the clock.

## 5. Integration steps (owed when ipd-nursing merges)
- Grant the nursing roles (`ward_nurse`, `nursing_supervisor`) `diet.view`, `diet.npo`, `diet.serve` and
  `diet.clinical.view` in `scripts/seed-roles.ts` (+ README prose, `apps/core/test/seed-roles.test.ts` pairs). The OPD key `nurse` is not
  touched. Then ward notices reach the ward's nurses by permission (`notices.ts` `holdersOf`); once nurses are assigned to
  wards, narrow `holdersOf` to the ward's own.

## 6. Who calls diet
- kernel: `app.module.ts` (`DietModule`), `kernel/modules/manifests.ts`, `kernel/worker/worker.module.ts` (install +
  `dietConsumer` + task kinds), `kernel/worker/jobs.ts` (`buildDueLists` on the task-clock tick), `kernel/desk` (card).
- Owed (later lanes): the nursing nutrition screen flags patients for the dietician (ipd-nursing); late-meal small stock;
  kitchen catering and costing; the IPD discharge "dietary" department confirmation still sits with the duty manager.
