---
issue: 1077
status: approved
approved: 2026-11-14
---
# SPEC — Imaging: one rule each for study source and treating doctor, reports.ts split, act schemas in contracts (#1077)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM7a of the imaging programme #1075. Rulings: 0098.

## What

- Study source is defined three ways: `reading.ts` `tatClassOf`, `metrics.ts` `SOURCE_OF_O`, `north-star.ts`. The HOD's two number screens disagree.
- The treating-doctor join is written in `closed-loop.ts`, `waiting.ts` and `release.ts`.
- `reports.ts` is 1,563 lines covering authoring, signature, criticals and the patient notice.
- Act schemas are private to controllers; the web hand-writes its types; the copilot will need the same schemas.

## Decisions

- `studySource(study, order)` is the one answer: `walk_in` (outside prescription or self), `daycare` (`D…`), `ipd` (bedside location, or an encounter that is neither `V` nor `D`), `opd` otherwise. DECIDED: `er` is not a source until the emergency module is on `main`; STAT is a priority, not a place. The reading clock's class stays priority first, then source.
- Metrics and the north star both call it. Their per-source counts for a day are equal.
- One exported treating-doctor fragment in `closed-loop.ts`; the other two files use it.
- `reports.ts` becomes `report-authoring.ts`, `report-signature.ts` and `criticals.ts`. Every export keeps its name and signature through `index.ts`.
- Act bodies move to `packages/contracts/src/radiology.ts` as zod schemas; controllers and the web client import them.
- No behaviour changes except the numbers that now agree.

## Done means

- **D1** `studySource` answers `walk_in`, `daycare`, `ipd` and `opd` for the four fixture studies.
- **D2** For one fixture day holding a STAT OPD order, the metrics read and the north-star read report the same count per source.
- **D3** The OPD-doctor join for the treating-doctor rule appears in exactly one radiology source file.
- **D4** `@hmis/contracts` exports the sign, amend, acquired, contrast, hand-over and schedule body schemas, and each route answers 400 for a body its contracts schema rejects.
- **D5** No `reports.ts` exists in the module, and every name it exported is still exported from `index.ts`.

## Out of scope

- `MAP.md` (yours); `gates.ts` split.

## Build notes

- **Files.** radiology `reports.ts` → three files, `index.ts`, `reading.ts`, `metrics.ts`, `north-star.ts`, `closed-loop.ts`, `waiting.ts`, `release.ts`, every `radiology-*.controller.ts` that declares a schema · `packages/contracts/src/radiology.ts` and `index.ts` (shared package) · web `lib/radiology-*.ts`.
- **Migration** no. **Permissions** none. **Size** M. **Depends on** IM1 (same readers).
