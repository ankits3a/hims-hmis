import { Module } from "@nestjs/common";
import { RadiologyDefinitionsController } from "./radiology-definitions.controller";
import { RadiologyOrdersController } from "./radiology-orders.controller";
import { RadiologyScheduleController } from "./radiology-schedule.controller";
import { RadiologyStudyController } from "./radiology-study.controller";
import { RadiologyAcquisitionController } from "./radiology-acquisition.controller";
import { RadiologyBillDecisionsController } from "./radiology-bill-decisions.controller";
import { RadiologyReportsController } from "./radiology-reports.controller";

/**
 * PLAN 18a T3 — the radiology module's Nest wiring.
 *
 * AuthGuard/PermissionGuard are global `APP_GUARD`s from `AuthModule` (the order is load-bearing,
 * Plan 02), so mounting a controller here mounts its permission checks with it — which is why every
 * route carries `@RequirePermission` and none carries a check of its own. The `LabModule` shape.
 *
 * ═══ IT REGISTERS NO ENCOUNTER RESOLVER, AND THAT IS NOT AN OMISSION ═══
 *
 * Radiology owns no episode LETTER of the kind `resolveEncounterByPrefix` dispatches on. An imaging
 * order hangs off an OPD `V` visit or a day-care `D` encounter, and the modules that MINT those
 * numbers are the modules that answer for them — `opd.module.ts` registers `V`, `ot.module.ts`
 * registers `D`. The `X` series this phase does own is an ACCESSION, not an encounter: it names a
 * study, never an episode a bill can hang off, so nothing should ever resolve it as one.
 *
 * The same reasoning `lab.module.ts` gives for owning no letter, one module over.
 *
 * ═══ WHAT IS NOT MOUNTED YET ═══
 *
 * NOTHING, at T8 — placement, the governed book, the diary, the study console, acquisition, the
 * counter's bill-decision queue and the whole reporting path are all mounted. T9 adds the screens
 * that call them and the end-to-end proof through the REAL manifest.
 */
@Module({
  controllers: [
    RadiologyOrdersController,
    RadiologyDefinitionsController,
    RadiologyScheduleController,
    RadiologyStudyController,
    RadiologyAcquisitionController,
    RadiologyBillDecisionsController,
    RadiologyReportsController,
  ],
})
export class RadiologyModule {}
