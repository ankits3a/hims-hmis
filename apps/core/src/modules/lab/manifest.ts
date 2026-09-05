import { LAB_RESOURCE_KINDS } from "./kinds";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 17 T2 — THE LAB MODULE'S MANIFEST, AND **THE ONE FIELD THAT MAKES IT AN ORDERING
 * DEPARTMENT.**
 *
 * ═══ `orderKinds` IS PHASE 0's WHOLE CONTRACT, TAKEN UP ═══
 *
 * Phase 0 §6.1: *"To become an ordering department, a module adds ONE field to its manifest."* This
 * is that field, and the declaration below is **byte-for-byte the fake manifest in
 * `kernel/orders/envelope.e2e.test.ts`** — the test phase 0 wrote to prove its own seam by placing,
 * working and closing an order through a manifest nobody shipped. That test said, in its header:
 * *"if the seam is right, THIS is the entire diff Plan 17 needs in order to become an ordering
 * department, and that claim is checkable here rather than in six weeks."* It is now checkable here.
 * The only kernel lines this whole phase touches are three appends named in T2's commit message,
 * and none of them is in `kernel/orders/`.
 *
 *   · `kind: "lab"` — the set of kinds is OPEN (phase 0 DD3); `orders.kind` carries no CHECK.
 *   · `seriesKey: "lab_order"` — the `L` counter, which `EPISODE_SERIES` has carried since
 *     2026-08-25 and nobody has minted from. **NOT `lab_specimen`**: `S` is a tube, not an order,
 *     and `series.ts`'s own header says a declaration of it here would be the "simplification" it
 *     most expects.
 *   · `requiresClinician: true` — an Indian hospital's medico-legal chain needs the doctor
 *     answerable for the test distinct from the login that typed it. A walk-in with an outside slip
 *     still names one: the pathologist of record (DD15).
 *   · `requiresIndication: false` — a CBC needs no justification. 18a's `imaging` sets it `true`,
 *     because radiation does.
 *   · `selfOrderable: false` — a patient may not order their own lab test. Plan 26's check-up
 *     package is what that field exists for, and `placeOrder` performs **no permission lookup on a
 *     patient id** whatever it says (22c-A review D11).
 *
 * ═══ FIFTEEN PERMISSIONS, AND THE TWO SPLITS WORTH DEFENDING ═══
 *
 * **`lab.results.read` is separate from `lab.results.enter` and `lab.results.verify`**, and it is
 * the permission the DOCTOR holds. DD6's safety rule is that a clinician's view of a verified
 * result is never held for money; that rule needs a permission the clinician can hold without being
 * able to key or sign anything, and this is it.
 *
 * **`lab.reports.print` is separate from `lab.reports.publish`.** Publishing is a pathologist's
 * signature; printing is a counter act, and `lab_reception` does it all day for reports it could
 * never have signed. Collapsing them would either give the front office a signing permission or
 * make the pathologist queue every hand-over.
 *
 * `lab.reports.release_unpaid` is declared here and granted to **nobody in the lab** — the approval
 * that uses it is held by `billing_manager` (DD6, `approval-types.ts`). A permission the module
 * declares and no lab role holds is the honest shape for a control another office exercises.
 *
 * ═══ `subscriptions: []` — see `events.ts` for why the lab consumes nothing ═══
 *
 * ═══ INSTALLED IN **BOTH** PROCESSES, SO `manifests.test.ts` LEG 3 STAYS AT SIX ═══
 *
 * It carries scheduler jobs (T5's two sweeps), so the worker has something to run — the `materials`
 * and `ot` case exactly. `ops`, `membership`, `formulary`, `resources`, `desk` and `orders` are the
 * six the worker omits, and this manifest joins neither side of that difference.
 */
export const labManifest: ModuleManifest = {
  key: "lab",
  title: "Laboratory",
  menu: [
    { label: "Lab desk", path: "/lab/desk", permission: "lab.desk.operate" },
    { label: "Collection", path: "/lab/collection", permission: "lab.collection.operate" },
    { label: "Bench", path: "/lab/bench", permission: "lab.accession.operate" },
    { label: "Verify & report", path: "/lab/verify", permission: "lab.results.verify" },
    /** PLAN 17c T5 — the report centre: the counter's seat, on the counter's permission. */
    { label: "Report centre", path: "/lab/reports", permission: "lab.reports.print" },
  ],
  permissions: [
    "lab.orders.place",
    "lab.catalogue.read",
    "lab.catalogue.manage",
    "lab.desk.operate",
    "lab.collection.operate",
    "lab.accession.operate",
    "lab.results.enter",
    "lab.results.verify",
    "lab.results.read",
    "lab.reports.publish",
    "lab.reports.print",
    "lab.reports.amend",
    "lab.reports.release_unpaid",
    "lab.criticals.close",
    "lab.worklist.read",
    /** 17-E T1 — registering a machine and mapping its codes is an ESTATE act, never the bridge's. */
    "lab.instruments.manage",
    /** 17-E T2 — the bridge's grant: ask what to run, and nothing else. */
    "lab.instruments.read",
    /** 17-E T3 — the bridge POSTS what the machine measured. Separate from the human entry grant. */
    "lab.results.interface",
  ],
  subscriptions: [],
  orderKinds: [
    {
      kind: "lab",
      seriesKey: "lab_order",
      placePermission: "lab.orders.place",
      requiresClinician: true,
      requiresIndication: false,
      selfOrderable: false,
    },
  ],
  resourceKinds: LAB_RESOURCE_KINDS,
};
