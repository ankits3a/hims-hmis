import { Module } from "@nestjs/common";
import { MembershipController } from "./membership.controller";

/**
 * The membership module.
 *
 * THE CONTROLLER JOINS THE DECORATOR IN THE SAME COMMIT AS THE ROUTES IT SERVES (T1's own note):
 * T3 mounts recognition, card lookup and the O-1 grace-honor path; T5 extends the same controller
 * with the import and reconcile routes. Shipping an empty controller earlier would have put a route
 * surface into a deployment before anything guarded it.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02),
 * so a module that mounts a controller mounts its permission checks with it — which is why every
 * route below carries `@RequirePermission` and none carries a permission check of its own.
 */
@Module({ controllers: [MembershipController] })
export class MembershipModule {}
