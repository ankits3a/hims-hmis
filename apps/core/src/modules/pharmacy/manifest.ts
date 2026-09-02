import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 16c T1 — THE PHARMACY MODULE'S SEAM, and the `medication` order kind CLAIMED.
 *
 * ═══ `orderKinds` — THE RESERVATION TAKEN UP (kernel/orders/kinds.ts DD9) ═══
 *
 * `medication` was reserved for Plan 16 and claimed by nobody; its number series,
 * `pharmacy_dispense` (`P`), has sat in `EPISODE_SERIES` since Plan 14 T1. This declaration joins
 * the two. The order is placed AT THE COUNTER when a pharmacist claims the prescription (D1, the
 * 17a T4 shape): `placePermission` is therefore the counter's own, `requiresClinician` is true
 * because the prescriber is the responsible clinician, and `selfOrderable` is false because a
 * patient does not order their own Schedule H drug. `kernel/orders/parity.test.ts` pins the claimed
 * set and grew by one in this commit.
 *
 * ═══ `menu: []` AND `subscriptions: []` THIS TASK — the `partnersManifest` rule, twice ═══
 *
 * The two routes land at T5 with the NAV entries (`nav-parity` compares the two), and the
 * `prescription.issued` subscription lands at T3 with its handler, the worker install and the
 * census in ONE commit, so no commit ever exists in which the worker cannot boot.
 */
export const pharmacyManifest: ModuleManifest = {
  key: "pharmacy",
  title: "Pharmacy",
  menu: [],
  permissions: [
    /** Claim a queued Rx at the counter, which places the `medication` order; verify, pick, bill. */
    "pharmacy.dispense.place",
    "pharmacy.dispense.read",
    /** D7 — hand over a dispense carrying a Schedule H/H1 line. A registered pharmacist's, and nobody else's. */
    "pharmacy.dispense.scheduled",
    /** D3 — bridge a drug item to its tariff service. */
    "pharmacy.sale_items.manage",
  ],
  subscriptions: [],
  orderKinds: [
    {
      kind: "medication",
      seriesKey: "pharmacy_dispense",
      placePermission: "pharmacy.dispense.place",
      requiresClinician: true,
      requiresIndication: false,
      selfOrderable: false,
    },
  ],
};
