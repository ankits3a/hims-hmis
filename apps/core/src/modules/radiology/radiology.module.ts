import { Module } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { registerFormFSubjectResolver } from "../pcpndt";
import type { OnModuleInit } from "@nestjs/common";
import type { Db } from "../../kernel/db/client";
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
export class RadiologyModule implements OnModuleInit {
  onModuleInit(): void {
    registerRadiologyFormFSubjectResolver();
  }
}

/**
 * ═══ F58 (CLOSE REVIEW) — RADIOLOGY ANSWERS FOR ITS OWN STUDIES WHEN A FORM F IS OPENED ═══
 *
 * `openFormF` writes the patient and the machine into the statutory register from caller-supplied
 * fields and cross-checked neither against the scan. `pcpndt` cannot do the check itself — DD1
 * makes it a manifest of its own so 15b and 62 can install the register without radiology, and
 * `study_id` is `text` for that reason — so the module that OWNS the id space answers for it, the
 * same shape as `opd.module.ts` registering the `V` resolver for the kernel's encounter lookup.
 *
 * Returning `null` for an unknown id is what keeps 15b and 62 working: a study this module does not
 * own is not this module's to contradict.
 *
 * Exported so a SUITE can register it without booting Nest, for the reason `opd.module.ts` gives
 * for its own: a unit suite that needs the cross-check should not have to stand up a module graph,
 * and a private copy in a fixture would be a second answer to "who owns an `X` study".
 */
export function registerRadiologyFormFSubjectResolver(): () => void {
  return registerFormFSubjectResolver("radiology.imaging_study", async (tx, studyId) => {
    const rows = await (tx as unknown as Db)
      .select({
        patientId: imagingStudies.patientId, deviceResourceId: imagingStudies.deviceResourceId,
      })
      .from(imagingStudies)
      .where(eq(imagingStudies.id, studyId));
    const row = rows[0];
    if (!row || row.deviceResourceId === null) return null;
    return { patientId: row.patientId, deviceResourceId: row.deviceResourceId };
  });
}
