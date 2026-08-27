import { Module } from "@nestjs/common";

/**
 * The materials module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02),
 * so mounting a controller here mounts its permission checks with it — which is why every route T8
 * adds carries `@RequirePermission` and none carries a check of its own. That is Plan 13 T5's
 * recorded rule and the `FormularyModule` shape.
 *
 * **Empty of controllers until T8**, deliberately: T2 ships the module SEAM — the manifest, the
 * kind, the permissions, the events, the errors and the seed — and the routes land when there are
 * functions behind them. A controller mounted now would be a controller with nothing to call.
 */
@Module({ controllers: [] })
export class MaterialsModule {}
