import { Module } from "@nestjs/common";
import { MaterialsController } from "./materials.controller";

/**
 * The materials module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02),
 * so mounting a controller here mounts its permission checks with it — which is why every route T8
 * adds carries `@RequirePermission` and none carries a check of its own. That is Plan 13 T5's
 * recorded rule and the `FormularyModule` shape.
 *
 * T2 shipped the module SEAM — the manifest, the kind, the permissions, the events, the errors and
 * the seed — with NO controller, deliberately: the routes land when there are functions behind
 * them. **T8 mounts the controller**, and it is the only change this file has ever needed.
 */
@Module({ controllers: [MaterialsController] })
export class MaterialsModule {}
