import { Module } from "@nestjs/common";

/**
 * The membership module.
 *
 * NO CONTROLLER YET, and that is deliberate rather than unfinished: T3 creates
 * `membership.controller.ts` (recognition, grace-honor) and T5 extends it with the import and
 * reconcile routes, and both name this file in their own Files lists so the controller joins the
 * decorator in the same commit as the routes it serves. Shipping an empty controller now would put
 * a route surface into a deployment before anything guards it.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02),
 * so a module that mounts a controller mounts its permission checks with it.
 */
@Module({})
export class MembershipModule {}
