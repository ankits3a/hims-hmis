import { RADIOLOGY_RESOURCE_KINDS } from "./kinds";
import { RADIOLOGY_ORDER_PLACED_CONSUMER } from "./consumers";
import { orderPlaced } from "../../kernel/orders/events";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 18a T2 / DD1 + DD2 — the radiology module's declared surface, and it is the FIRST manifest in
 * this repository to claim an ORDER KIND.
 *
 * ═══ THE CLAIM IS ONE FIELD, AND THAT IS THE WHOLE OF PHASE 0's CONTRACT (§6.1) ═══
 *
 * *"To become an ordering department, a module adds ONE field to its manifest — `orderKinds` — and
 * declares `placePermission` in its own `permissions`. It edits no kernel file."* `orderKinds`
 * below is that field. `kernel/orders/parity.test.ts` has pinned the claimed set at `[]` since
 * phase 0 shipped, with `kinds.ts`'s own header carrying the sentence this manifest satisfies:
 * *"`imaging` is a legal string and is not a kind THIS HOSPITAL HAS until Plan 18a installs the
 * manifest that claims it."*
 *
 * **`requiresIndication: true` is the radiation-justification rule expressed as a DECLARATION.**
 * `placeOrder` refuses an imaging order carrying no reason, and this module writes no guard of its
 * own for it — which is the point of the seam. A CT with no stated indication is a dose nobody can
 * justify to an AERB inspector, and 18c's register reads `orders.indication` for exactly that.
 *
 * **`requiresClinician: true` even though the walk-in has no doctor**, and the two are not in
 * conflict: a walk-in carrying an outside slip places under `authority: 'external_prescription'`
 * with `external_referrer_id` (phase 0 DD6), which is the leg that does not demand a clinician.
 * `selfOrderable: false` — a patient does not order their own CT; when Plan 26 composes a health
 * package it places as `system`/`protocol`.
 *
 * ═══ THE TWENTY-SIX PERMISSIONS ARE DECLARED AT T2, AHEAD OF EVERY ROUTE THAT GUARDS ON THEM ═══
 *
 * Fifteen here and five on `pcpndtManifest`. `scripts/seed-roles.ts`, `test/seed-roles.test.ts` and
 * the README parity table hold a REACHABILITY INVARIANT — every declared permission is granted to a
 * role or entered in `NOT_YET_MODELLED` with a reason. All of them are named in T2's Files list and
 * in NO later task's, so a permission first declared by T5 or T8 would fail the build for a task
 * that is not allowed to fix it (16a's F1, and Plan 15's own note).
 *
 * ═══ THREE SEPARATIONS THAT ARE NOT ARBITRARY, AND THE CENSUS CANNOT SEE ANY OF THEM ═══
 *
 *   · **`radiology_receptionist` does NOT hold `radiology.gates.satisfy`.** The person who books
 *     the scan and takes the money does not get to record that the patient is not pregnant.
 *   · **`radiographer` does NOT hold `radiology.reports.sign`.** The technologist acquires; the
 *     radiologist reports. This is the separation the whole department exists around.
 *   · **`pcpndt_incharge` does NOT hold `pcpndt.form_f.write`.** The in-charge VERIFIES what others
 *     wrote. An officer who can both write and verify a statutory form is a single point of failure
 *     with a criminal statute behind it.
 *
 * T2 A3's mutant is the reason those three are pinned BY NAME rather than trusted to the count: a
 * grant of `reports.sign` to `radiographer` leaves every census passing and the separation gone.
 *
 * ═══ THE SUBSCRIPTION, AND IT LANDED WITH ITS HANDLER — T3 (the `partnersManifest` RULE) ═══
 *
 * `buildSubscriptionBus` makes a declared subscription with no handler a BOOT ERROR by design
 * (§2.54's own specimen: `worker.ts` heartbeating for five minutes over an empty consumer list).
 * T2 therefore shipped `subscriptions: []`, and `order.placed` → `radiology.order_placed` arrives
 * HERE at T3 **with** `handleOrderPlaced`, **with** the worker's `workerConsumers` entry and
 * **with** the consumer census, in ONE commit. **No commit has ever existed in which this array
 * names a consumer nothing implements**, which is the property the rule is about rather than the
 * ordering.
 *
 * The event is the KERNEL's, not this module's: every claiming module's orders raise `order.placed`,
 * so the handler's first line is a `kind !== "imaging"` return. A lab order must reach this consumer
 * and produce nothing at all.
 *
 * ═══ THE MENU POINTS AT ROUTES T9 MOUNTS ═══
 *
 * For several commits the links exist and the screens do not — the `formularyManifest`,
 * `materialsManifest` and `otManifest` precedent, invisible in the window because every entry is
 * gated on a permission whose only holders are roles with no humans in them yet (S4: all four
 * radiology roles are DECLARED by this phase and production holds zero of each).
 */
export const radiologyManifest: ModuleManifest = {
  key: "radiology",
  title: "Radiology & Imaging",
  menu: [
    { label: "Imaging reception", path: "/radiology/reception", permission: "radiology.schedule" },
    { label: "Imaging worklist", path: "/radiology/worklist", permission: "radiology.worklist.read" },
    // 18-S RS6 — the modality rooms: the technologist's console, dose log, rejects and downtime.
    { label: "Modality rooms", path: "/radiology/room", permission: "radiology.acquire" },
    // 18-S RS8a — the reading room: the radiologist's urgency-sorted list and the report workspace.
    { label: "Reading room", path: "/radiology/read", permission: "radiology.reports.write" },
    // 18-S RS2b — the technologist's portable round (the beds the trolley goes to).
    { label: "Portable round", path: "/radiology/portable", permission: "radiology.acquire" },
    // 18-S RS3 — the desk's diary (machines × time) and the waiting-hall display.
    { label: "Imaging diary", path: "/radiology/diary", permission: "radiology.schedule" },
    { label: "Imaging hall display", path: "/radiology/display", permission: "radiology.display.read" },
    // 18-S RS4 — the Setup station: machines, books and prices.
    { label: "Imaging setup", path: "/radiology/setup", permission: "radiology.devices.manage" },
    // 18-S RS5 — the prep & safety bay (the gates the order opened, contrast and reaction).
    { label: "Prep & safety bay", path: "/radiology/prep", permission: "radiology.gates.satisfy" },
    // 18-S RS7 — the sonologist's room, the Form F register, the §19 registration, the monthly return.
    { label: "Ultrasound & PCPNDT", path: "/radiology/usg", permission: "pcpndt.form_f.write" },
  ],
  permissions: [
    "radiology.orders.place",
    "radiology.worklist.read",
    "radiology.schedule",
    "radiology.checkin",
    "radiology.gates.satisfy",
    "radiology.gates.override",
    "radiology.acquire",
    "radiology.reports.write",
    "radiology.reports.sign",
    "radiology.reports.amend",
    "radiology.reports.read",
    "radiology.definitions.read",
    "radiology.definitions.manage",
    "radiology.bill_decisions.manage",
    "radiology.criticals.ack",
    // PLAN 18b T1 — the modality worklist export. A MACHINE permission: the bridge on the
    // PACS host pulls `GET /radiology/mwl`, and `radiographer` holds it so a console can be
    // checked by a human. It reads names, so it is a PHI surface (`imaging.worklist`).
    "radiology.mwl.read",
    // 18-S RS3 — the waiting-hall board (tokens + first name and initial). The OPD pattern: the
    // kiosk `display` role holds it, and so does the desk that turns the TV on.
    "radiology.display.read",
    // 18-S RS4 — the machine register (register, edit, status with a reason) and the Setup
    // station's reads. The radiologist, who already drafts the department's books, holds it.
    "radiology.devices.manage",
    // 18-S RS5 — the contrast injection and a contrast reaction. Split off `radiology.acquire` so the
    // radiology NURSE (who injects and watches for the reaction) can record both without being
    // able to start or finish an acquisition. Held by everyone who held `acquire` for these routes.
    "radiology.contrast.record",
  ],
  subscriptions: [{ event: orderPlaced.name, consumer: RADIOLOGY_ORDER_PLACED_CONSUMER }],
  resourceKinds: RADIOLOGY_RESOURCE_KINDS,
  orderKinds: [
    {
      kind: "imaging",
      seriesKey: "radiology_order",
      placePermission: "radiology.orders.place",
      requiresClinician: true,
      requiresIndication: true,
      selfOrderable: false,
    },
  ],
};
