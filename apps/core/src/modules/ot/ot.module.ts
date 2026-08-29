import { Module, OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
// PLAN 17 PHASE 0 T3 — the registry moved to the kernel; billing re-exports the same names.
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { daycareEncounters } from "../../kernel/db/schema";
import { OtDefinitionsController } from "./ot-definitions.controller";
import { OtCasesController } from "./ot-cases.controller";
import { OtCockpitController } from "./ot-cockpit.controller";
import { OtRecoveryController } from "./ot-recovery.controller";

/**
 * The mini-OT module.
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02), so
 * mounting a controller here mounts its permission checks with it — which is why every route T8
 * adds carries `@RequirePermission` and none carries a check of its own. Plan 13 T5's recorded rule
 * and the `MaterialsModule` shape.
 *
 * T2 shipped the module SEAM — manifest, kind, permissions, events, errors, approval types, the
 * merge consumer and the seed — with NO controller, deliberately: routes land when there are
 * functions behind them. **T8 mounts the four**, and `ot.e2e.test.ts` walks a refusal from every
 * error family through them so the `toHttp` mapping is EXECUTED rather than asserted (Plan 13's
 * 500-escape specimen, which this repository has now shipped three times).
 */
@Module({ controllers: [OtDefinitionsController, OtCasesController, OtCockpitController, OtRecoveryController] })
export class OtModule implements OnModuleInit {
  /**
   * PLAN 15 T7 / DD11-F2 — **THE OT CLAIMS THE `D` PREFIX.**
   *
   * `issueInvoice` resolved every encounter through OPD and threw `unknown_encounter` for a
   * day-care one, so the whole discharge bill was unreachable. Billing now dispatches on the
   * episode-number letter; this registers the reader for ours and billing imports nothing from here.
   *
   * The resolver returns the encounter's PAYER MAPPING (F10), not its `payer_class`: billing's
   * `intended_payer` is its own enum, and `fp_scheme` maps PROVISIONALLY onto `pmjay` until 15b
   * builds the FP claim and the CA rules on whether the two may share a bucket.
   */
  onModuleInit(): void {
    registerOtEncounterResolver();
  }
}

/** Exported for the same reason OPD's is: a suite may register it without booting Nest. */
export function registerOtEncounterResolver(): () => void {
  return registerEncounterResolver(EPISODE_SERIES.daycare, async (db, encounterNo) => {
    const rows = await db.select().from(daycareEncounters)
      .where(eq(daycareEncounters.encounterNo, encounterNo));
    const encounter = rows[0];
    if (!encounter) return null;
    return { patientId: encounter.patientId, intendedPayer: intendedPayerFor(encounter.payerClass) };
  });
}

/**
 * F10 — §3A's EIGHT payer classes onto billing's `intended_payer`, which has four buckets.
 *
 * The mapping is lossy on purpose and the losses are named:
 *   · `self_pay`, `staff_dependant`, `charity`, `membership_prepaid` → `self`. All four are the
 *     patient's own bill with a different discount behind it, and the discount is the tariff's job.
 *   · `insured_tpa` → `tpa`; `corporate_credit` → `corporate`; `govt_scheme` → `pmjay`.
 *   · **`fp_scheme` → `pmjay`, PROVISIONALLY.** A family-planning claim goes to the district, not to
 *     PMJAY, and the two are different payers with different registers. 15b builds the FP claim and
 *     widens billing's enum if the CA rules they must not share a bucket; until then this is the
 *     closest true bucket and the phase says so rather than inventing an enum value.
 */
export function intendedPayerFor(payerClass: string): string {
  switch (payerClass) {
    case "insured_tpa": return "tpa";
    case "corporate_credit": return "corporate";
    case "govt_scheme":
    case "fp_scheme": return "pmjay";
    default: return "self";
  }
}
