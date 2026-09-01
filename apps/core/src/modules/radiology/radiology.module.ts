import { Module } from "@nestjs/common";
import { RadiologyDefinitionsController } from "./radiology-definitions.controller";
import { RadiologyOrdersController } from "./radiology-orders.controller";
import { RadiologyScheduleController } from "./radiology-schedule.controller";
import { RadiologyStudyController } from "./radiology-study.controller";
import { RadiologyAcquisitionController } from "./radiology-acquisition.controller";
import { RadiologyBillDecisionsController } from "./radiology-bill-decisions.controller";

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
 * T8's reporting. At T7 this module is placement, the governed book, the diary, the study console,
 * the acquisition path and the counter's bill-decision queue; the controllers list is where a reader
 * sees that at a glance rather than inferring it from the routes that answer.
 */
@Module({
  controllers: [
    RadiologyOrdersController,
    RadiologyDefinitionsController,
    RadiologyScheduleController,
    RadiologyStudyController,
    RadiologyAcquisitionController,
    RadiologyBillDecisionsController,
  ],
})
export class RadiologyModule {}
