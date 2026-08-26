import type { ModuleManifest } from "../modules/manifest";
import { KERNEL_RESOURCE_KINDS } from "./kinds";

/**
 * PLAN 13 T2 — the `resources` §4 manifest.
 *
 * `kernel/resources` is KERNEL CODE THAT CARRIES A MANIFEST for exactly the reason
 * `kernel/ops/manifest.ts` states in as many words: the §4 seam is where permissions are DECLARED,
 * and a route guarding on a permission no manifest declares is a route `syncPermissions` leaves
 * unreachable by every role FOREVER (no `permissions` row → `grantPermissionToRole` refuses it
 * outright). `auth`, `workflow`, `approvals`, `alerts` and `ops` are all this shape.
 *
 * ═══ ONE PERMISSION, AND THERE IS DELIBERATELY NO `resources.manage` (DD14) ═══
 *
 * `resources.read` guards T5's three read routes and is granted to `opd_admin` — **the role that
 * reads rooms today, so NO NEW AUTHORITY IS CREATED** (16a DD10's minimum-authority posture).
 *
 * There is no `resources.manage` because there is no registry write ROUTE. Master writes for rooms
 * continue through OPD's existing `opd.masters.manage`-guarded routes, now delegating into the
 * registry (DD9), and the first module that needs a registry write route declares and mounts its
 * own permission WITH it. `seed-roles.test.ts:160` records the trap of a permission *"declared,
 * guarding a LIVE route, and held by nobody"*; a `manage` permission guarding NO route is the same
 * defect seen from the other side — held by somebody, reaching nothing.
 *
 * ═══ `menu: []` — NO SCREEN, AND `subscriptions: []` — NO CONSUMER ═══
 *
 * This phase adds no screen (the SPA route census stays 25) and no consumer. `subscriptions: []`
 * is what keeps `resourcesManifest` installable in the API before any handler exists — a declared
 * subscription with no matching handler is a BOOT ERROR by design (`buildSubscriptionBus`,
 * kernel/worker/jobs.ts), which is the (1b) discipline `manifests.test.ts` records. It is also why
 * this manifest is NOT installed in the worker: it would catalog nothing new and subscribe to
 * nothing, exactly as `ops`, `membership` and `formulary` do not.
 *
 * ═══ NO `search` PROVIDER, AND THE HALF-BUILT SEAM IS NAMED RATHER THAN FINISHED (DD15) ═══
 *
 * `SearchEntity` in `packages/contracts/src/search.ts` ALREADY declares `"room"` and
 * `kernel/search/registry.ts`'s `ENTITY_ORDER` already ranks it — **and no provider anywhere
 * registers it**, so `@room` has been a typeable chip resolving to nothing since Plan 11h shipped.
 * Finishing it here would be right in kind and wrong in scope: the roadmap's traps say no
 * dashboard, this phase adds no screen, and a palette entry for a registry nobody can yet see is
 * apparatus ahead of need. Recorded so the next reader finds a NAMED GAP rather than an apparent
 * oversight — the module that first gives the registry a screen adds one `search:` array entry
 * here, and Plan 11h's DD1 made that a one-line change.
 */
export const RESOURCES_READ = "resources.read";

export const resourcesManifest: ModuleManifest = {
  key: "resources",
  title: "Resource registry — floors, wards, halls, rooms and beds",
  menu: [],
  permissions: [RESOURCES_READ],
  subscriptions: [],
  resourceKinds: KERNEL_RESOURCE_KINDS,
};
