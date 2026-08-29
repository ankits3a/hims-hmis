import type { ModuleManifest } from "./manifest";
import { deskManifest } from "../desk/manifest";
import { ordersManifest } from "../orders/manifest";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import { alertsManifest } from "../alerts/manifest";
import { opsManifest } from "../ops/manifest";
import { membershipManifest } from "../../modules/membership";
import { partnersManifest } from "../../modules/partners";
import { formularyManifest } from "../../modules/formulary";
import { resourcesManifest } from "../resources/manifest";
import { materialsManifest } from "../../modules/materials";
import { otManifest } from "../../modules/ot";
import { labManifest } from "../../modules/lab";

/**
 * `ALL_MANIFESTS` — ONE list of the manifests the API installs, consumed by everything that
 * needs to know "which modules exist" (Plan 11d D2).
 *
 * WHY THIS FILE EXISTS, because a list of imports looks like tidying and this one is not.
 * Before it, "which manifests exist" lived in FOUR hand-maintained copies: `app.module.ts`
 * (nine), `kernel/worker/worker.module.ts` (its own set), `scripts/seed-admin.ts` (ONE), and
 * `scripts/seed-ops.ts` (ONE). Ledger §2.54 is the entry that says two copies of one fact drift
 * by construction — and the drift between `seed-admin.ts`'s one-manifest registry and
 * `app.module.ts`'s nine IS THE MECHANISM OF MAJOR 4. `seed-admin.ts` grants
 * `registry.allPermissions()` to `admin`; with `authManifest` alone installed, that phrase means
 * six strings, so on a live deployment `admin` held six of the fifty-nine declared permissions
 * and every `opd.*`, `billing.*`, `patients.*`, `tariff.*` and `workflow.*` route answered 403 to
 * the only user who existed. Measured against production 2026-08-24 (plan §B-MEASURED): the
 * catalog held 59, `admin` held 9, and FIFTY declared permissions were held by nobody.
 *
 * `manifests.test.ts` is the half that makes this load-bearing rather than cosmetic: a manifest
 * installed by `app.module.ts` and absent from this list FAILS the build. Without that assertion
 * the tenth module repeats MAJOR 4 exactly.
 *
 * THE ORDER IS THE ORDER `app.module.ts` INSTALLED THEM IN, and it is preserved deliberately.
 * `ModuleRegistry.install` throws on a duplicate key and `allPermissions()` dedupes, so order
 * changes no behaviour today — but `registry.all()` is what `syncPermissions` walks, and a
 * diff that reorders this list would look like a functional change to every future reviewer.
 *
 * WHAT IS NOT HERE, and why each absence is a decision:
 *   - `notifyManifest` — installed by the WORKER only. It declares five `kernel.notify`
 *     subscriptions, and `buildSubscriptionBus` (kernel/worker/jobs.ts) turns a declared
 *     subscription with no matching handler into a BOOT ERROR. The api process supplies no such
 *     handler, so installing it here would stop the api at startup. The worker's set is an
 *     intentional DIFFERENCE, not drift, and `manifests.test.ts` states it in as many words.
 *   - `opsManifest` is here and is NOT installed by the worker, for the mirror-image reason: it
 *     declares no subscription and the worker runs no ops route.
 * A manifest with an EMPTY `permissions` array (`alerts`) still belongs here: it is installed,
 * so `registry.all()` must see it, and its menu and subscriptions are read from the same
 * registry.
 */
export const ALL_MANIFESTS: readonly ModuleManifest[] = [
  authManifest,
  workflowManifest,
  approvalsManifest,
  patientsManifest,
  tariffManifest,
  opdManifest,
  billingManifest,
  alertsManifest,
  opsManifest,
  // PLAN 09 T1 — the two new modules, appended so the order above is untouched (see the paragraph
  // on ORDER). `partnersManifest` ships with `subscriptions: []` and is installed HERE AND NOT IN
  // THE WORKER until T6 lands its handler in the same commit as its four subscriptions: a declared
  // subscription with no matching handler is a BOOT ERROR by design (§6.0 S2, DD7).
  // `membershipManifest` declares no subscription at all — the module is check-on-execute.
  membershipManifest,
  partnersManifest,
  // PLAN 16a T2 — the formulary, appended for the same reason: the eleven above keep the order
  // they were installed in. It declares no subscription (check-on-execute, like `membership`) and
  // an empty `search` array, so it is installed in the API and NOT in the worker.
  formularyManifest,
  // PLAN 13 T2 — the resource registry, appended so the twelve above keep the order they were
  // installed in. It is KERNEL code carrying a manifest, like `auth`, `workflow`, `approvals`,
  // `alerts` and `ops` — the §4 seam is where permissions are DECLARED, and `resources.read`
  // guards T5's three read routes. It declares `subscriptions: []` and is installed in the API and
  // NOT in the worker: the worker serves no resources route and there is no consumer to feed, so
  // installing it there would catalog nothing new and subscribe to nothing. That makes the
  // worker's difference from this list FOUR rather than three — see manifests.test.ts (1d).
  //
  // It is also the first manifest to carry `resourceKinds`, and it declares the five STRUCTURAL
  // kinds (floor, ward, hall, room, bed) because no module owns a floor. Plan 15 declares
  // `theatre` and `device` on the mini-OT's own manifest without editing kernel code.
  resourcesManifest,
  // PLAN 14 T2 — materials, appended so the thirteen above keep the order they were installed in.
  //
  // **IT IS THE FIRST MANIFEST ON THIS LIST THAT THE WORKER ALSO INSTALLS SINCE `partners`**, and
  // the reason is the one leg 3 of `manifests.test.ts` enumerates: it carries a SUBSCRIPTION (T7's
  // `consignment.deployed` → `materials.consumption`) and a daily JOB (`sweepBatchExpiry`, T8), so
  // the worker has something to consume and something to run. `ops`, `membership`, `formulary` and
  // `resources` are omitted there precisely because they have neither. So the worker's difference
  // from this list stays FOUR — materials appears on neither side of it.
  //
  // It ships `subscriptions: []` in THIS commit and T7 lands the one subscription, its handler in
  // `workerConsumers` and the census as ONE commit — the `partnersManifest` rule (§6.0 S2, Plan 10
  // D13): a declared subscription with no matching handler is a BOOT ERROR by design.
  materialsManifest,
  // PLAN 15 T2 — the mini-OT, appended so the fourteen above keep the order they were installed in.
  //
  // Installed in BOTH processes, the `materials` case exactly: it carries a SUBSCRIPTION
  // (`patient.merged` → `ot.patient_merged`, shipped WITH its handler in this same commit) and,
  // from T4, a scheduler job (`surgeon.late_flagged`). So the worker has something to consume and
  // something to run, and the worker's difference from this list stays FOUR — `ot` appears on
  // neither side of it (manifests.test.ts leg 3).
  //
  // It is also the second manifest to carry `resourceKinds`, and it claims exactly ONE: `theatre`.
  // NOT `bed` — `KERNEL_RESOURCE_KINDS` already claims that and a second declaration is
  // `duplicate_kind` at boot (adversarial finding F1). The two recovery bays are kernel `bed` rows.
  otManifest,
  // PLAN 07c T9 — the desk's own seam, appended so every manifest above keeps the order it was
  // installed in. It is KERNEL code carrying a manifest for the `resources` reason: §4 is where
  // permissions are DECLARED. It declares `subscriptions: []` and no search or desk provider of its
  // own — what it exists for is `staff.reports.read` / `staff.reports.drill`, which nothing else
  // could legitimately declare.
  deskManifest,
  // PLAN 17 PHASE 0 T5 — the order envelope, appended so every manifest above keeps the order it
  // was installed in. It is KERNEL code carrying a manifest for the `resources` and `desk` reason:
  // §4 is where permissions are DECLARED, and `orders.place` / `orders.read` / `orders.cancel` /
  // `orders.read.restricted` are strings nothing else could legitimately declare.
  //
  // It declares `subscriptions: []` and is installed in the API and NOT in the worker — the
  // (1)/(1a)/(1c)/(1d)/(1g) reason a sixth time: the worker serves no orders route and there is no
  // consumer to feed, so installing it there would catalog nothing new and subscribe to nothing.
  //
  // It is the first manifest whose PURPOSE is a seam other manifests declare INTO: `orderKinds` is
  // claimed by Plan 17's lab module, 18a's radiology, 26's packages — none of which edits this
  // file, because a kind is a manifest field and not a list entry.
  ordersManifest,
  /**
   * PLAN 17 T2 — the central lab, appended so the seventeen above keep the order they were
   * installed in. **It is the first manifest to CLAIM an order kind** (`lab`), which is phase 0's
   * whole contract taken up: one field, no kernel edit, `collectOrderKinds` returns one declaration
   * in both processes from this commit onward.
   *
   * Installed in BOTH processes, the `materials` and `ot` case exactly: it carries two scheduler
   * jobs (T5's non-return and SLA sweeps), so the worker has something to run and the worker's
   * difference from this list stays SIX — `lab` appears on neither side of it (manifests.test.ts
   * leg 3). It declares `subscriptions: []`; see `modules/lab/events.ts` for why the lab consumes
   * nothing, `patient.merged` included.
   *
   * It is the THIRD manifest to carry `resourceKinds` and it claims TWO — `bench` and `analyzer`,
   * both already among the ten in `kernel/resources/kinds.ts` (Plan 13 DD4 reserved them for this
   * plan), so this adds a VOCABULARY and no kind. `analyzer` is written by nobody until 17-E, and
   * `modules/lab/kinds.ts` says why it is nonetheless declared here.
   */
  labManifest,
];
