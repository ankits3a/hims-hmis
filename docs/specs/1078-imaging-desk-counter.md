---
issue: 1078
status: built
approved: 2026-11-14
---
# SPEC — Imaging desk counter in two steps, with collect and check-in done on the server (#1078)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM2 of the imaging programme #1075. Rulings: 0098.

## What

- Two of four steps only advance (`radiology-reception.tsx` 253–254).
- The browser issues the invoice, fetches its lines and links each to a study; a failed link leaves a "relink" button (158–202).
- Walk-in and check-in are two chained calls (221–231); arrival check-in is one call per study in a loop (144–150).
- The desk finds a new patient only by a typed visit number (`imaging-desk-door.tsx`).
- The slot time is prefilled with the next quarter hour without checking the machine is free (line 437).

## Decisions

- Two steps: **Bill**, then **Slot & slip**. The patient's studies and what the prep bay will ask move into the lane. A booked, paid patient who arrives is checked in by being opened, and the dock's only act is Done.
- Three server acts replace the browser sequences. Each checks its own permissions.
  - `arriveAtDesk(encounterNo)`: checks in every study of the visit booked for today (IST); returns each study's gate list; a study that refuses is reported and does not stop the others.
  - `collectAtDesk(encounterNo, studyIds, addOns, tender)` with an idempotency key: validates every study first, issues the house invoice through billing's existing `issueInvoice`, links each line to its study. A retry with the same key issues nothing new and completes the links. DECIDED: retry-safe rather than one transaction, because billing's issue act owns its transaction and its signature must not change.
  - `walkInNow(studyId)`: first free machine plus check-in, in one transaction.
- `proposeSlot(studyId)` (L1): the first free quarter-hour on an available machine of the study's modality that is licensed if ionising. The Slot step opens with it filled; Enter books it.
- The desk door takes UHID, phone, name or visit number in one box, through the existing patient search, then shows that patient's visits of today and their advised imaging.
- DECIDED: no discount and no credit at the counter (0015); TPA pre-authorisation is unchanged.

## Done means

- **D1** `arriveAtDesk` on a visit with two studies booked today checks in both and returns each gate list; a study booked for tomorrow stays `scheduled`.
- **D2** `collectAtDesk` for two self-pay studies issues one invoice, sets both studies' invoice line, and each study is then authorised by invoice.
- **D3** After a forced failure between issue and link, the same call with the same key leaves one invoice and both studies linked.
- **D4** `collectAtDesk` naming a study of another patient is refused and issues no invoice.
- **D5** `walkInNow` books the first free machine and leaves the study checked in; with no machine available it refuses and the study is unchanged.
- **D6** `proposeSlot` skips an occupied slot and an unlicensed ionising machine.
- **D7** (web) The counter shows two steps; with a booked, paid study in hand the dock offers Done; with an unpaid one it offers Collect.
- **D8** (web) Typing a UHID in the desk door lists the patient and today's visit.
- **D9** (web) Collecting calls one radiology desk route and no billing or invoice-line route.

## Out of scope

- registering a new patient (the Registration link stays); the walk-in visit (IM2b).

## Build notes

- **Files.** radiology new `desk.ts`, new `radiology-desk.controller.ts`, `radiology.module.ts`, `schedule.ts` (extract first-free-slot), `counter.ts` · web `radiology-reception.tsx`, `components/radiology/imaging-counter.tsx`, `imaging-desk-door.tsx`, `lib/radiology-api.ts` · locales (SHARED) · contracts `radiology.ts`.
- **Migration** no. **Permissions** none (existing `radiology.schedule`, `radiology.checkin`, `radiology.bill_decisions.manage`, `billing.invoice.issue`, `billing.receipt.record`). **Size** M. **Depends on** IM1, IM7a.
