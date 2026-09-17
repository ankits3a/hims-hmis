import { PHARMACY_RX_ISSUED_CONSUMER } from "./consumers";
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
 * ═══ THE MENU LANDED AT T5 WITH THE ROUTES — the `partnersManifest` rule ═══
 *
 * Each path matches `apps/web/src/router.tsx`'s own route exactly (`nav-parity` compares the two). The
 * `prescription.issued` subscription landed at T3 with its handler, the worker install and the
 * census in ONE commit, so no commit ever existed in which the worker could not boot.
 */
export const pharmacyManifest: ModuleManifest = {
  key: "pharmacy",
  title: "Pharmacy",
  menu: [
    { label: "Dispense counter", path: "/pharmacy/counter", permission: "pharmacy.dispense.read" },
    { label: "Sale items", path: "/pharmacy/items", permission: "pharmacy.sale_items.manage" },
    { label: "Pharmacists", path: "/pharmacy/pharmacists", permission: "pharmacy.pharmacists.manage" },
    { label: "Reorder list", path: "/pharmacy/reorder", permission: "pharmacy.dispense.read" },
    { label: "H1 register", path: "/pharmacy/registers/h1", permission: "pharmacy.register.read" },
    /** P12 — the leakage triangle: the billing supervisor's and the owner's read, not the counter's. */
    { label: "Pharmacy leakage", path: "/pharmacy/leakage", permission: "billing.reports.read" },
  ],
  permissions: [
    /** Claim a queued Rx at the counter, which places the `medication` order; verify, pick, bill. */
    "pharmacy.dispense.place",
    "pharmacy.dispense.read",
    /** D7 — hand over a dispense carrying a Schedule H/H1 line. A registered pharmacist's, and nobody else's. */
    "pharmacy.dispense.scheduled",
    /** D3 — bridge a drug item to its tariff service. */
    "pharmacy.sale_items.manage",
    /**
     * P2 — file and end a pharmacist's state council registration (Pharmacy Act 1948 §42). Never
     * one's own: the act refuses `self_registration` whatever this grant says.
     */
    "pharmacy.pharmacists.manage",
    /**
     * P9 — read the Schedule H1 register (Drugs and Cosmetics Rules 1945 r.65(3A)): patients by name,
     * and what they were given. The pharmacist's, not the aide's.
     */
    "pharmacy.register.read",
    /**
     * P17 — the same register with a sealed patient's real name and address: the copy an inspector
     * is handed. The pharmacist in charge, the medical superintendent and the owner.
     */
    "pharmacy.register.read_sealed",
  ],
  /** T3 — D10: the Rx is at the counter before the patient is. Handler, worker install and census landed in the same commit. */
  subscriptions: [{ event: "prescription.issued", consumer: PHARMACY_RX_ISSUED_CONSUMER }],
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
