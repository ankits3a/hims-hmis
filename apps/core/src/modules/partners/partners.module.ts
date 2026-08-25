import { Module } from "@nestjs/common";
import { PartnersController } from "./partners.controller";

/**
 * The partners module.
 *
 * THE CONTROLLER JOINS THE DECORATOR IN THE SAME COMMIT AS THE ROUTES IT SERVES (T1's own note):
 * T7 mounts attribution, the statement import, the reference mapping and the aging read model, and
 * T8 extends the same controller with the channel P&L. Shipping an empty controller earlier would
 * have put a route surface into a deployment before anything guarded it.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02), so
 * a module that mounts a controller mounts its permission checks with it — which is why every route
 * carries `@RequirePermission` and none carries a permission check of its own.
 *
 * The dispatcher consumer this module owns (DD7) is WORKER-side and reaches the worker through
 * `workerConsumers(db)` — not through this Nest module, and not through any provider. T6's four
 * subscriptions, `accrualConsumer` and the worker's `registry.install(partnersManifest)` are one
 * edit in `kernel/worker/worker.module.ts`; nothing about the accrual lane is resolved out of a
 * Nest container, so there is deliberately no provider to add here for it.
 */
@Module({ controllers: [PartnersController] })
export class PartnersModule {}
