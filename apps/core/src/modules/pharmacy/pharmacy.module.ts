import { Module } from "@nestjs/common";
import { PharmacyCounterController } from "./pharmacy-counter.controller";
import { PharmacyItemsController } from "./pharmacy-items.controller";

/**
 * PLAN 16c — the module. T1 shipped it inert; T2 mounted the sale-items controller, T3 the
 * counter's (the `LabModule` precedent).
 */
@Module({ controllers: [PharmacyItemsController, PharmacyCounterController] })
export class PharmacyModule {}
