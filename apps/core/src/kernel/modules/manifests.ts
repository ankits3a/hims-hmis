import type { ModuleManifest } from "./manifest";
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
];
