---
issue: 1086
status: approved
approved: 2026-11-14
---
# SPEC — Move the consent schema and fasting constants from ot into the kernel (#1086)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM7b of the imaging programme #1075. Rulings: 0098.

## What

- `gates.ts` and `ir.ts` import the consent schema and the fasting constants from `ot` (lines 12 and 16). Imaging does not depend on theatre for consent; it borrows code.

## Decisions

- The consent schema, the consent-evidence reader and the fasting constants move to `kernel/consent`. `ot` re-exports them under the same names, so nothing that imports `ot` changes.
- Radiology imports them from the kernel.
- Stated plainly: radiology still imports `ot` in `place.ts` for the day-care case states. That is a real dependency and stays.
- No behaviour change.

## Done means

- **D1** `gates.ts` and `ir.ts` import nothing from the theatre module.
- **D2** The theatre module's index still exports the consent schema and the fasting constants, and they are the kernel's objects.

## Out of scope

- Nothing beyond the decisions above.

## Build notes

- **Files.** `kernel/consent/` (new, SHARED kernel), `modules/ot/` consent file and `index.ts`, radiology `gates.ts`, `ir.ts`.
- **Migration** no. **Permissions** none. **Size** S. **Depends on** IM3 (same `gates.ts`); otherwise free.
