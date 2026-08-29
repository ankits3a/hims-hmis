import type { ModuleManifest } from "../modules/manifest";

/**
 * PLAN 17 PHASE 0 T5 — the order envelope's §4 manifest.
 *
 * `kernel/orders` is KERNEL CODE THAT CARRIES A MANIFEST for exactly the reason
 * `kernel/resources/manifest.ts` and `kernel/desk/manifest.ts` state: the §4 seam is where
 * permissions are DECLARED, and a guard on a permission no manifest declares is a guard
 * `syncPermissions` leaves unreachable by every role FOREVER — no `permissions` row means
 * `grantPermissionToRole` refuses it outright. `auth`, `workflow`, `approvals`, `alerts`, `ops`,
 * `resources` and `desk` are all this shape.
 *
 * ═══ FOUR PERMISSIONS, AND THE SPLIT IS THE WHOLE OF DD6 AND DD11 ═══
 *
 * `orders.place` — the kernel half of the placement gate. It says "this person is a member of staff
 * who places orders at all"; the KIND's own permission (`lab.orders.place`) says "for this
 * department". A caller needs BOTH, which is what stops a pharmacist ordering a CT (T3 A5).
 *
 * `orders.read` — the cross-kind readers. It is separate from placing because the ward clerk who
 * reads a pending-investigations list is not the person who writes it.
 *
 * `orders.cancel` — declared here and enforced by the CLAIMING MODULE's route, not by
 * `advanceOrderItem`. The envelope's cancellation gate is the actor-type rule (T4); who among the
 * staff may cancel a lab order versus an imaging order is a departmental decision, and a kernel
 * guard would be a second authority on it. It is declared so that decision has a string to gate on.
 *
 * `orders.read.restricted` — DD11, and it is a SEPARATE grant on purpose. A ward's pending list
 * omits an HIV order, an exposure-protocol source test, a PCPNDT-class USG; the ordering clinician
 * sees their own regardless. A hospital that handed this out with `orders.read` would have decided,
 * without noticing, that every clerk may see every restricted investigation in the building.
 *
 * ═══ GRANTED TO NO ROLE BY THIS PHASE ═══
 *
 * The migration grants nothing (22c-A DD7's discipline). Grants are runbook acts, and there is
 * nothing to grant them FOR until a module claims a kind — `placeOrder` refuses every kind with
 * `unknown_kind` today. Plan 17's own T2 grants `lab.orders.place` alongside these.
 *
 * ═══ `menu: []` — NO SCREEN — AND `subscriptions: []` — NO CONSUMER ═══
 *
 * This phase adds no screen: the doctor cockpit keeps writing `advised_tests` and nothing converts
 * it yet. `subscriptions: []` is what keeps this manifest installable in the API before any handler
 * exists — a declared subscription with no matching handler is a BOOT ERROR by design
 * (`buildSubscriptionBus`). It is for the same reason NOT installed in the worker: it would catalog
 * nothing new there and subscribe to nothing, exactly as `ops`, `membership`, `formulary`,
 * `resources` and `desk` are not.
 */
export const ORDERS_PERMISSIONS = {
  place: "orders.place",
  read: "orders.read",
  cancel: "orders.cancel",
  readRestricted: "orders.read.restricted",
} as const;

export const ordersManifest: ModuleManifest = {
  key: "orders",
  title: "Orders — the cross-kind investigation envelope",
  menu: [],
  permissions: [
    ORDERS_PERMISSIONS.place,
    ORDERS_PERMISSIONS.read,
    ORDERS_PERMISSIONS.cancel,
    ORDERS_PERMISSIONS.readRestricted,
  ],
  subscriptions: [],
};
