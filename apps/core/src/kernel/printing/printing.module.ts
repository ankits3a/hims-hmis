import { Module } from "@nestjs/common";
import { PrintingController } from "./printing.controller";

/**
 * FD-24 T2 — the print relay's three routes.
 *
 * A KERNEL module rather than a feature module, for the reason `notify` is one: the counter, the
 * cashier and the vitals bay all put paper in a patient's hand, and none of them owns printing.
 */
@Module({ controllers: [PrintingController] })
export class PrintingModule {}
