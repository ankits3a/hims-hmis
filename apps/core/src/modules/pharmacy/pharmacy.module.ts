import { Module } from "@nestjs/common";
import { registerDocumentRenderer } from "../../kernel/printing/render";
import { PharmacyControlledController } from "./pharmacy-controlled.controller";
import { PharmacyCounterController } from "./pharmacy-counter.controller";
import { PharmacyDoctorController } from "./pharmacy-doctor.controller";
import { PharmacyItemsController } from "./pharmacy-items.controller";
import { PharmacyOfficeController } from "./pharmacy-office.controller";
import { PharmacyPharmacistsController } from "./pharmacy-pharmacists.controller";
import { PharmacyReportsController } from "./pharmacy-reports.controller";
import { PharmacyTallyController } from "./pharmacy-tally.controller";
import { PharmacyDowntimeController, PharmacyRetailController } from "./pharmacy-retail.controller";
import { renderPharmacyPaper } from "./print";
import type { OnModuleInit } from "@nestjs/common";

/**
 * PHARMACY P1 — the desk's bill and labels are drawn by THIS module and printed by the kernel's
 * relay. Exported so a suite can register them without booting Nest (`registerOpdEncounterResolver`'s
 * reasoning); `onModuleInit` is the production path. Returns the unregister.
 */
export function registerPharmacyPrinting(): () => void {
  const off = [
    registerDocumentRenderer("pharmacy_bill", (db, params, now, requester) => renderPharmacyPaper(db, "pharmacy_bill", params, now, requester)),
    registerDocumentRenderer("pharmacy_labels", (db, params, now, requester) => renderPharmacyPaper(db, "pharmacy_labels", params, now, requester)),
  ];
  return () => { for (const f of off) f(); };
}

/**
 * PLAN 16c — the module. T1 shipped it inert; T2 mounted the sale-items controller, T3 the
 * counter's (the `LabModule` precedent). P2 mounted the register of pharmacists; P19 the walk-in
 * retail counter; P20 the paper-dispense entry; Consult v2 the doctor's read of the shelf; parity
 * P1 the desk's paper.
 */
@Module({ controllers: [PharmacyItemsController, PharmacyCounterController, PharmacyPharmacistsController, PharmacyRetailController, PharmacyDowntimeController, PharmacyDoctorController, PharmacyOfficeController, PharmacyReportsController, PharmacyTallyController, PharmacyControlledController] })
export class PharmacyModule implements OnModuleInit {
  onModuleInit(): void {
    registerPharmacyPrinting();
  }
}
