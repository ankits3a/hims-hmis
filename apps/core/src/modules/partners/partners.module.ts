import { Module } from "@nestjs/common";

/**
 * The partners module.
 *
 * NO CONTROLLER YET: T7 creates `partners.controller.ts` (attribution, statements, reconciliation)
 * and T8 extends it with the channel P&L, and both name this file in their own Files lists so the
 * controller joins the decorator in the same commit as the routes it serves.
 *
 * The dispatcher consumer this module owns (DD7) is WORKER-side and reaches the worker through
 * `workerConsumers(db)`, not through this Nest module — which is why installing this manifest
 * app-side with no subscriptions is safe and installing it worker-side before T6 would not be.
 */
@Module({})
export class PartnersModule {}
