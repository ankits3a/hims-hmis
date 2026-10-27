# PLAN — Housekeeping HK-1: teams, rounds, checklists, confirmation, door-QR requests (#973)

Spec: `docs/specs/973-housekeeping-rounds.md` (approved 2026-10-26). Rulings: decision 0086. Lane `hk-rounds-973`,
built on `lane/ipd-train` (#967), so it merges after #966 and #967 and stays dark behind `HMIS_MODULES_ON` like the
rest of IPD. Paths are under `apps/core/src/` unless they start with `apps/` or `packages/`.

## Decided by standard practice (the owner rules money and law only)

| Question | DECIDED |
|---|---|
| Infection control role | New role `infection_control`. It holds `housekeeping.verify_terminal` beside `services_supervisor`. |
| Who confirms an area round | Class A: the unit in-charge (`ipd.beds.clean` holders on that unit). Class B ward areas: the nurse in-charge. Toilets and public areas: no per-round confirm; the supervisor's random inspection scores them. Beds: as today. |
| Night window for toilets | Hourly 07:00–22:00 IST, 2-hourly 22:00–07:00. |
| Grace before "missed" | 15 minutes after the due time. |
| Rework goes to | The same doer if still on duty, otherwise the floor pool. |
| A missed round | Marked missed on the board, and the task stays open as late. The next slot is still raised. |
| Attendant not on the roster | Gets no tasks. Publishing the rota warns the supervisor about anyone placed without a roster duty. |
| Phone screens | HK-1 ships on the phone web (`/tasks` and new pages). Expo app screens come in a later lane. |
| QR as proof | It is weak on its own (a photo of the QR passes). The photo plus the doer's signed-in identity is the evidence. The board says so. |

## Data (one migration, numbered at merge; on the lane it is the next after 0261)

New tables: `hk_contractors`, `hk_staff` (in-house or contractor, skills), `hk_checklists` (versioned items),
`hk_areas` (resource, class, floor, checklist, photo needed, `qr_version`), `hk_rotas` + `hk_rota_places` (zone, route,
bed section), `hk_rounds` (area, slot, due, task, due/done/missed; unique area+slot), `hk_work` (scan, answers, photo
key, company snapshot, fail count, last reason), `hk_door_requests` (area, need, task, closed, address hash).

The migration also widens the tasks act CHECK to add `rejected`.

Toilets are `room` resources and public spaces are `hall` resources. The kernel's kind list stays closed.

Shared files touched, to coordinate:
- `kernel/db/schema/index.ts`
- housekeeping `manifest.ts`: new permissions `housekeeping.setup.manage`, `housekeeping.rota.manage`, `housekeeping.confirm`
- `scripts/seed-roles.ts` and `test/seed-roles.test.ts`: the new role and the permission counts
- `test/caddyfile-parity.test.ts`: routes `/housekeeping/setup`, `/housekeeping/rota`, `/door`
- `apps/web/src/router.tsx`
- `kernel/worker/jobs.ts`

## Slices (each a commit with its tests; acceptance tests `spec #973 Dk` land red first)

0. **Red acceptance tests D1–D8** in `modules/housekeeping/acceptance/`, plus web tests for D6 and D7.
1. **Schema + contracts + manifest + role + seed counts.** No behaviour.
2. **Task engine (tasks module):**
   - `rejectTask(reason)` with the act `rejected`; done goes back to assigned (same doer if on duty, else pool).
   - A kind hook `eligible()` so placement and skills narrow `pickWorker`, the pool and `acceptTask`.
   - `verifier_is_doer` covers every doer in every rework round, not only the last.
   - Covers D4 and D5. Shared with transport and maintenance: run their suites.
3. **Setup:** areas, classes, checklists, QR mint and print (`hmacSign`, `a1.<areaId>.<qrVersion>`, revoke by bumping the version), staff and contractors. Covers D1 and D8.
4. **Rota:** draft and publish, the `eligible` hook reading the published places, load per person from `openLoad`. A discharge clean goes to the floor pool. Covers D2.
5. **Rounds clock:** rides `runTaskAndWasteClocks` under `whenModuleOn("housekeeping")`, raising slots with `sourceRef hk-round:<area>:<slot>` (no duplicates), and marks missed after the grace. Covers D1 and D6.
6. **Work door:** `POST /housekeeping/tasks/:id/work` takes the scan token, the answers and the photo (`DOCUMENT_STORE`; the `documents` table needs a patient, so it is not used). `beforeDone` refuses an incomplete record. New bed cleans need a scan; open ones keep tap. Covers D3 and D8 (company snapshot).
7. **Confirm door:** Pass calls `verifyTask` (the bed is freed as today). Fail calls `rejectTask` with a reason. A second fail raises a "Needs you" notice. Covers D4 and D5.
8. **Public door request:** copies the IPD family pattern:
   - `@Public()` POST with the token in the body
   - a per-address throttle, plus a per-area cap in the DB (4 an hour)
   - the four needs only, a system actor and no patient id
   - the web page `/door#<token>`, so the token never reaches the access log
   Covers D7.
9. **Supervisor board read:** missed rounds, Needs-you, load per person, company.
10. **Web:**
    - Live board: extend `housekeeping-board.tsx`.
    - My tasks: extend `my-tasks.tsx` with a checklist sheet, a QR read (`jsqr`) and a photo.
    - Confirm sheet with Pass/Fail and reasons.
    - New pages: `/housekeeping/rota` (Floor / Area / Bed tabs), `/housekeeping/setup`, public `/door`.
    - Then a browser walk at 390 px and 1440 px against the design board.

## Risks
- Engine changes are shared with transport and maintenance.
- Toilet rounds come to about 19 a day per toilet: index `hk_rounds` and keep each round's escalation ladder short.
- Room and hall resources used as areas must not appear on the Beds board (only IPD beds are housekept today; check rooms).

## Verify
Targeted jest for housekeeping, tasks, transport and maintenance under the lock, with the web vitest for the touched screens. Root typecheck and lint. `node tools/arch/gen.mjs`. CI runs the full suites. Stage after #967 is on staging.
