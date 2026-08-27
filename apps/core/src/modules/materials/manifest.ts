import { MATERIALS_RESOURCE_KINDS } from "./kinds";
import { consignmentDeployed } from "./events";
import { MATERIALS_CONSUMPTION_CONSUMER } from "./consumption";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * The materials module's declared surface (DD11, DD15, DD16).
 *
 * ═══ THE ELEVEN PERMISSIONS ARE DECLARED HERE, AHEAD OF EVERY ROUTE THAT GUARDS ON THEM ═══
 *
 * `scripts/seed-roles.ts` and `test/seed-roles.test.ts` hold a REACHABILITY INVARIANT — every
 * declared permission is granted to a role or entered in `NOT_YET_MODELLED` with a reason — plus a
 * census pin and a README parity table compared cell for cell, both directions. All three files are
 * named in T2's Files list and in NO later task's, so a permission first declared by T6 or T8 would
 * fail the build for a task that is not allowed to fix it. That is 16a's finding F1 and Plan 09's
 * §6.0 S9, applied at authoring time here rather than discovered again.
 *
 * ═══ WHO HOLDS THEM (DD11) ═══
 *
 *   · `materials_head`  — all eleven. The person accountable for what the hospital owns.
 *   · `storekeeper`     — the six an operator needs: `items.read`, `vendors.read`, `stock.read`,
 *     `grn.capture`, `stock.issue`, `stock.receive`. **Not `grn.qc`**, and that is DD8's two-stage
 *     gate expressed as authority: capture records what came off the lorry so the lorry can leave;
 *     the VERDICT is a separate act. (Capture and QC may be the same USER in this phase — the SoD
 *     pairs S10 names are PO-approver/receiver and custodian/counter, neither of which exists until
 *     14b/14c, and inventing a third pair here would be a rule nobody ruled. The permissions are
 *     nonetheless distinct, so the day a pair IS ruled the strings are already there to hang it on.)
 *     Not `items.manage`, not `vendors.manage`, not `recall.manage`: a storekeeper who could
 *     register a vendor could receive from one nobody approved.
 *   · `pharmacy`        — gains `items.read`, `stock.read`, `grn.qc`. **The pharmacist is the QC
 *     signatory for drugs** (doc 09 §7, "who signs what"), and the two read halves mean the
 *     formulary curator can see what the item it curates is called on a shelf.
 *   · `owner`           — NOTHING NEW. The vendor bank-change approval reaches the owner through
 *     `approvals.*`, which `owner` already holds. Declaring a `materials.*` string for it would be
 *     a second door to one decision.
 *
 * **This mints live authority to nobody today**, and that is measured rather than hoped:
 * `materials_head` and `storekeeper` are created by `seed:roles` with grants and no holders, the
 * `pharmacy` precedent exactly. The grant is a door that opens the day a storekeeper account exists.
 *
 * ═══ THREE MENU ENTRIES POINTING AT ROUTES T9 MOUNTS ═══
 *
 * The plan puts the entries here and the screens in T9, so for seven commits the links exist and
 * the routes do not. That is the `formularyManifest` precedent and it is invisible in the window:
 * every entry is gated on a permission whose only holders are roles with no humans in them.
 * Recorded rather than quietly reordered, because "a menu link that 404s" is worth being deliberate
 * about.
 *
 * ═══ `subscriptions: []` IN THIS TASK, AND T7 ADDS THE ONE — THE `partnersManifest` RULE ═══
 *
 * `buildSubscriptionBus` (kernel/worker/jobs.ts) makes a declared subscription with no matching
 * handler a **BOOT ERROR by design**. `partnersManifest` shipped `subscriptions: []` in Plan 09 T1
 * and landed its four names, `accrualConsumer` in `workerConsumers`, the worker install and the
 * census as ONE commit at T6 — so that no commit ever existed in which the worker could not boot.
 * T7 does exactly the same for `consignment.deployed` / `materials.consumption`.
 *
 * ═══ THIS MANIFEST IS INSTALLED IN **BOTH** PROCESSES, AND LEG 3 STAYS AT FOUR (DD15) ═══
 *
 * `manifests.test.ts`'s third leg enumerates the worker's differences from `ALL_MANIFESTS` — `ops`,
 * `membership`, `formulary`, `resources`, all omitted because each is check-on-execute with no
 * consumer. Materials is the opposite: it carries a subscription (T7) and a daily job
 * (`sweepBatchExpiry`, T8), so the worker installs it too and it appears on NEITHER side of that
 * difference. The count stays FOUR — see the (1e) comment in that file.
 */
export const materialsManifest: ModuleManifest = {
  key: "materials",
  title: "Materials — items, vendors, stores and the stock ledger",
  menu: [
    // Each path matches `apps/web/src/router.tsx`'s own route exactly (the `opsManifest`
    // convention), so the permission-gated link and the screen it opens cannot drift apart.
    { label: "Items", path: "/materials/items", permission: "materials.items.manage" },
    { label: "Vendors", path: "/materials/vendors", permission: "materials.vendors.manage" },
    { label: "Goods receipt", path: "/materials/grn", permission: "materials.grn.capture" },
  ],
  permissions: [
    "materials.items.read",
    "materials.items.manage",
    "materials.vendors.read",
    "materials.vendors.manage",
    "materials.stores.manage",
    "materials.stock.read",
    "materials.grn.capture",
    /** Separate from `grn.capture` — DD8's two-stage gate. See the header. */
    "materials.grn.qc",
    "materials.stock.issue",
    "materials.stock.receive",
    /** DD14's one-action freeze. Narrowest grant in the module: `materials_head` alone. */
    "materials.recall.manage",
  ],
  /**
   * **PLAN 14 T7 — THE ONE SUBSCRIPTION, LANDED WITH ITS HANDLER IN THIS COMMIT.**
   *
   * T2 shipped `subscriptions: []` precisely so that no commit ever existed in which a declared
   * subscription had no handler: `buildSubscriptionBus` (kernel/worker/jobs.ts) makes that a BOOT
   * ERROR by design. This line, `consumptionConsumer` in `workerConsumers`, and the worker-consumer
   * census are ONE commit — the `partnersManifest` rule (§6.0 S2, Plan 10 D13), a fourth time.
   *
   * `consignment.deployed` is DEFINED here (DD13, `events.ts`) and EMITTED BY PLAN 15. Subscribing
   * to an event nothing yet publishes is correct rather than premature: the consumer is the half of
   * the interface this phase owes, and it is what makes Plan 15 a one-file import.
   */
  subscriptions: [
    { event: consignmentDeployed.name, consumer: MATERIALS_CONSUMPTION_CONSUMER },
  ],
  /**
   * DD2 — the `store` kind. `kinds.ts` carries the declaration and the reasoning; this line is what
   * makes `collectResourceKinds` see it at boot, in BOTH processes once T2's worker fix lands.
   */
  resourceKinds: MATERIALS_RESOURCE_KINDS,
  /**
   * The 11h search seam is DECLARED and empty (DD18). `@item` is a natural chip — a storekeeper
   * typing "glove" into the palette — but search results are a read surface with its own RBAC and
   * audit rules, and nothing in this phase's scope asks for one. Plan 11h DD1 makes adding it one
   * line, later, by whoever needs it.
   */
  search: [],
};
