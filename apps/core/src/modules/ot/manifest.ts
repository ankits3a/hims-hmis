import { OT_RESOURCE_KINDS } from "./kinds";
import { OT_IMPLANT_CONFIRMED_CONSUMER, OT_PATIENT_MERGED_CONSUMER } from "./consumers";
import { patientMerged } from "../patients";
import { materialConsumed } from "../materials";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 15 T2 / DD14 — the mini-OT's declared surface.
 *
 * ═══ THE FOURTEEN PERMISSIONS ARE DECLARED HERE, AHEAD OF EVERY ROUTE THAT GUARDS ON THEM ═══
 *
 * `scripts/seed-roles.ts` and `test/seed-roles.test.ts` hold a REACHABILITY INVARIANT — every
 * declared permission is granted to a role or entered in `NOT_YET_MODELLED` with a reason — plus a
 * census pin and a README parity table compared cell for cell. All three files are named in T2's
 * Files list and in NO later task's, so a permission first declared by T5 or T8 would fail the
 * build for a task that is not allowed to fix it. That is 16a's F1 and Plan 14's own note, applied
 * at authoring time rather than discovered again.
 *
 * ═══ WHO HOLDS THEM (DD14), AND THE THREE SEPARATIONS THAT ARE NOT ARBITRARY ═══
 *
 *   · `ot_incharge` holds everything EXCEPT `gates.override`, `definitions.manage` and
 *     `bill.compose`. The person who runs the unit does not get to wave a clinical gate through,
 *     publish the criteria that define what the unit may do, or compose the bill for it. Those are
 *     three different people's authority and the whole point of the module.
 *   · `surgeon` and `anaesthetist` BOTH hold `gates.override`, because DD5's override needs two
 *     distinct actors holding those two roles. A single role holding it would make `overrideGate`
 *     satisfiable by one person with two logins.
 *   · `recovery_nurse` holds `discharge`; `ot_nurse` does not. A patient leaves from the bay, and
 *     the person who signs her out is the person who scored her.
 *
 * ═══ THE MENU ENTRIES POINT AT ROUTES T8 MOUNTS ═══
 *
 * For six commits the links exist and the routes do not — the `formularyManifest` and
 * `materialsManifest` precedent, invisible in the window because every entry is gated on a
 * permission whose only holders are roles with no humans in them (Spike Q3: `ot_incharge`,
 * `surgeon`, `anaesthetist`, `ot_nurse`, `recovery_nurse` and `daycare_coordinator` exist on
 * production as of this phase's seed, with zero holders).
 *
 * ═══ ONE SUBSCRIPTION IN THIS COMMIT, AND T5 ADDS THE SECOND — THE `partnersManifest` RULE ═══
 *
 * `patient.merged` → `ot.patient_merged` shipped at T2 **with its handler**; `material.consumed` →
 * `ot.implant_confirmed` lands at T5, also with its handler and the worker's `workerConsumers`
 * entry, in ONE commit. No commit ever exists in which a declared subscription has no handler —
 * `buildSubscriptionBus` makes that a boot error by design.
 *
 * ═══ INSTALLED IN **BOTH** PROCESSES, SO `manifests.test.ts` LEG 3 STAYS AT FOUR ═══
 *
 * It carries subscriptions (above) and, from T4, a scheduler job (`surgeon.late_flagged`), so the
 * worker has something to consume and something to run — the `materials` case exactly. `ops`,
 * `membership`, `formulary` and `resources` are the four the worker omits, and this manifest joins
 * neither side of that difference.
 */
export const otManifest: ModuleManifest = {
  key: "ot",
  title: "Operation Theatre",
  menu: [
    { label: "Theatre list", path: "/ot/list", permission: "ot.cases.read" },
    { label: "Book day-care case", path: "/ot/book", permission: "ot.cases.book" },
    { label: "Recovery", path: "/ot/recovery", permission: "ot.recovery.operate" },
  ],
  permissions: [
    "ot.definitions.read",
    "ot.definitions.manage",
    "ot.cases.read",
    "ot.cases.book",
    "ot.cases.cancel",
    "ot.list.manage",
    "ot.gates.satisfy",
    "ot.gates.override",
    "ot.cockpit.operate",
    "ot.implants.scan",
    "ot.counts.record",
    "ot.recovery.operate",
    "ot.discharge",
    "ot.bill.compose",
  ],
  subscriptions: [
    { event: patientMerged.name, consumer: OT_PATIENT_MERGED_CONSUMER },
    // PLAN 15 T5 / DD9 — the second, landed WITH its handler and the worker's `workerConsumers`
    // entry in ONE commit (the `partnersManifest` rule). It closes the scan's asynchronous half:
    // until `material.consumed` arrives the implant row is `deploying` and `signOut` is refused.
    { event: materialConsumed.name, consumer: OT_IMPLANT_CONFIRMED_CONSUMER },
  ],
  resourceKinds: OT_RESOURCE_KINDS,
};
