import { Module } from "@nestjs/common";
import { PharmacyItemsController } from "./pharmacy-items.controller";

/**
 * PLAN 16c — the module. T1 shipped it inert; T2 mounts the sale-items controller and T3 the
 * counter's (the `LabModule` precedent).
 */
@Module({ controllers: [PharmacyItemsController] })
export class PharmacyModule {}
