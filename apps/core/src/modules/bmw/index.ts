/**
 * E1.7 BIO-MEDICAL WASTE (issue #724, decision 0072) — other modules import this one only through here
 * (lint-enforced). Importing it also defines the `bmw_collection` task kind and the `waste_handler` skill
 * (`kinds.ts`), which is why both the API and the worker load it.
 */
export { bmwManifest, BMW_HANDLE, BMW_MANAGE, BMW_VIEW } from "./manifest";
export { BmwModule, registerBmwPrinting } from "./bmw.module";
export { BMW_COLLECTION_TASK, BMW_SUPERVISOR_ROLE, WASTE_HANDLER_SKILL } from "./kinds";
export { BmwError, bmwHttpStatus } from "./errors";
export {
  BMW_SYSTEM, allocate, collectBag, formatBarcode, generateBag, handOverManifest, recordCbwtfWeight, recordDeptWeight,
  resolveDispute, storeBag, verifyManifestGap,
} from "./intents";
export type { BagRow, CategoryGap, CbwtfResult, DisputeRow, GenerateResult, ManifestRow } from "./intents";
export { BMW_CLOCK_BATCH, sweepBmwStorage } from "./clock";
export type { BmwClockResult } from "./clock";
export { BMW_PICKUP_IST, bagByBarcode, bmwBoard, bmwHandlerView, bmwPlaces, nextPickupAt } from "./reads";
export { formIvCsv, formIvReport, monthlyReport, monthlyReportCsv } from "./reports";
export { BAG_LABEL_DOCUMENT, drawBagLabel, renderBagLabelJob } from "./label";
