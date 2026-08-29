import { Module } from "@nestjs/common";

/**
 * The laboratory module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02), so
 * mounting a controller here mounts its permission checks with it — which is why every route T8
 * adds carries `@RequirePermission` and none carries a check of its own. The `OtModule` and
 * `MaterialsModule` shape.
 *
 * **T2 ships the module SEAM with NO controller, deliberately**: routes land when there are
 * functions behind them. T8 mounts the five controllers and `lab.e2e.test.ts` walks a refusal from
 * every error family through them, so `labHttpStatus` is EXECUTED rather than asserted — the
 * 500-escape specimen this repository has now shipped three times.
 *
 * **It registers no encounter resolver**, and that is not an omission. The lab owns no encounter
 * letter: its walk-in is a `V` visit that OPD's resolver already answers (DD15, phase 0 E9), and
 * `openLabWalkin` lives in `modules/opd/encounters.ts` for exactly that reason — the module that
 * owns `V` mints `V`.
 */
@Module({})
export class LabModule {}
