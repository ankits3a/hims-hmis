import { Module } from "@nestjs/common";

/**
 * The partners module.
 *
 * NO CONTROLLER YET: T7 creates `partners.controller.ts` (attribution, statements, reconciliation)
 * and T8 extends it with the channel P&L, and both name this file in their own Files lists so the
 * controller joins the decorator in the same commit as the routes it serves.
 *
 * The dispatcher consumer this module owns (DD7) is WORKER-side and reaches the worker through
 * `workerConsumers(db)` — not through this Nest module, and not through any provider. T6's four
 * subscriptions, `accrualConsumer` and the worker's `registry.install(partnersManifest)` are one
 * edit in `kernel/worker/worker.module.ts`; nothing about the accrual lane is resolved out of a
 * Nest container, so there is deliberately no provider to add here for it.
 */
@Module({})
export class PartnersModule {}
