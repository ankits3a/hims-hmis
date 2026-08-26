import { Module } from "@nestjs/common";
import { FormularyController } from "./formulary.controller";

/**
 * The formulary module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02),
 * so mounting this controller mounts its permission checks with it — which is why every route
 * carries `@RequirePermission` and none carries a check of its own.
 *
 * T7 extends the same controller with the staging-admission routes and T8 with the curation reads;
 * neither adds a module.
 */
@Module({ controllers: [FormularyController] })
export class FormularyModule {}
