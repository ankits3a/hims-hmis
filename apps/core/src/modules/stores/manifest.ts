import { STORES_DESK_PROVIDERS } from "./desk";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * STORES S1 (#1111, decision 0099) — the non-drug Stores module: one master register for every item the
 * hospital keeps that is not a medicine ("even a dustbin"), the central store and department shelves.
 *
 * It is a LEAF over `materials`: one item table and one ledger, reached only through `materials/index.ts`.
 * Pharmacy is separate and out of scope; Stores refuses drug, implant and patient-billable items.
 *
 * ═══ THREE PERMISSIONS, AND THE SCOPE IS THE POINT ═══
 *
 *   · `stores.masters.manage` (hospital) — categories, items, stores, shelves, par, the new-item queue.
 *     The materials head.
 *   · `stores.shelf.read` (department) — one department's shelf: on hand, status words, use rates. The
 *     department's in-charge and its head.
 *   · `stores.shelf.work` (department) — receive at, use from, check and draft a reorder for a shelf. The
 *     department's store in-charge.
 *
 * The two shelf strings are asked AT THE SHELF'S DEPARTMENT inside each Stores intent (the roster
 * precedent, `roster/access.ts`), so the shelf routes carry no route-level guard: the department is a
 * fact of the shelf, not of the URL. Department roles hold no `materials.*` grant.
 *
 * S2a (#1112) adds three: `stores.indents.approve` (department; the HOD, and the medical superintendent at
 * hospital scope as stand-in), `stores.nightstore.issue` (hospital; the night store's keepers) and
 * `stores.audit.read` (hospital; the audit pack).
 *
 * S2b (#1112, decision 7) adds `stores.carry` (hospital; the porter, `support_staff`): take custody of an
 * issued ticket by scanning its label, hand it on, bring it back undelivered.
 *
 * S2c (#1119, decision 3) adds two: `stores.gatepass.raise` (hospital; the storekeeper and the materials head) raises,
 * prints and closes a gate pass; `stores.gatepass.scan` (hospital; the security guard, `security_guard`) scans it out
 * and in. Each has its own menu row: the guard's Gate (`/stores/gate`, the only screen a guard has) and the store's
 * Passes (`/stores/passes`).
 *
 * The first menu entry: `/stores`, the materials head's desk. The phone shelf (`/stores/shelf/$shelfId`) is
 * reached from it and from a department's own link; it is not a menu row because a department-scoped
 * holder sees no hospital-scope menu.
 */
export const storesManifest: ModuleManifest = {
  key: "stores",
  title: "Stores",
  menu: [
    { label: "Stores", path: "/stores", permission: "stores.masters.manage" },
    { label: "Gate passes", path: "/stores/passes", permission: "stores.gatepass.raise" },
    { label: "Gate", path: "/stores/gate", permission: "stores.gatepass.scan" },
  ],
  permissions: [
    "stores.masters.manage",
    "stores.shelf.read",
    "stores.shelf.work",
    "stores.indents.approve",
    "stores.nightstore.issue",
    "stores.audit.read",
    "stores.carry",
    "stores.gatepass.raise",
    "stores.gatepass.scan",
  ],
  subscriptions: [],
  /** S2a (#1112, decision 12) — the three Now cards: "Indents to approve", "To pick", "To receive" (`desk.ts`). */
  desk: [...STORES_DESK_PROVIDERS],
};
