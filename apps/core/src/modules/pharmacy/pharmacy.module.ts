import { Module } from "@nestjs/common";
import { PharmacyCounterController } from "./pharmacy-counter.controller";
import { PharmacyItemsController } from "./pharmacy-items.controller";
import { PharmacyPharmacistsController } from "./pharmacy-pharmacists.controller";
import { PharmacyDowntimeController, PharmacyRetailController } from "./pharmacy-retail.controller";

/**
 * PLAN 16c — the module. T1 shipped it inert; T2 mounted the sale-items controller, T3 the
 * counter's (the `LabModule` precedent). P2 mounted the register of pharmacists; P19 the walk-in
 * retail counter; P20 the paper-dispense entry.
 */
@Module({ controllers: [PharmacyItemsController, PharmacyCounterController, PharmacyPharmacistsController, PharmacyRetailController, PharmacyDowntimeController] })
export class PharmacyModule {}
