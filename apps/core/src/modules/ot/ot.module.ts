import { Module } from "@nestjs/common";

/**
 * The mini-OT module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02), so
 * mounting a controller here mounts its permission checks with it — which is why every route T8
 * adds carries `@RequirePermission` and none carries a check of its own. Plan 13 T5's recorded rule
 * and the `MaterialsModule` shape.
 *
 * T2 ships the module SEAM — manifest, kind, permissions, events, errors, approval types, the merge
 * consumer and the seed — with NO controller, deliberately: routes land when there are functions
 * behind them. **T8 mounts the four controllers**, and that is the only change this file needs.
 */
@Module({ controllers: [] })
export class OtModule {}
