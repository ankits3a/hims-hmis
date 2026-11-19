import { STORES_DESK_PROVIDERS } from "./desk";
import { storesCopilotIntents } from "./copilot-intents";
import { storesCopilotReadTools } from "./copilot-tools";
import { reorderTool } from "./copilot-acts";
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
 * S3 (#1113, decisions 5, 15) adds two: `stores.tower.read` (hospital; the materials head, the storekeeper, the medical
 * superintendent, the duty manager, the owner) reads the control tower (`/stores/tower`, its own menu row), its owner's
 * one line and the "Stuck" Now card; `stores.spend.read` (hospital; the owner, the materials head, the medical
 * superintendent) adds the month's spend per department to the tower. Never a doctor (decision 0058).
 *
 * S4a (#1114, decision 16) adds three: `stores.assets.manage` (hospital; biomedical and the materials head) tags units,
 * records warranty, AMC/CMC, calibration, repairs and the device link, and runs the opening sweep; `stores.assets.read`
 * (hospital; the materials head, biomedical, the medical superintendent, the stores auditor, the owner) reads every
 * unit, cost included; `stores.assets.export` (hospital; `accounts_officer`) downloads the month's asset additions for
 * Tally. A department's shelf-grant holders read their own units without any of the three. The desk is
 * `/stores/assets` (its own menu row); the phone passport `/stores/asset` is opened by a scan.
 *
 * S4b (#1114, decision 16) adds one: `stores.assets.condemn` (the committee's seats: `department_head` at its
 * department, `accounts_officer`, `materials_head`, `biomedical_engineer`) signs or objects to a condemnation or a loss;
 * the HOD at the department or biomedical proposes one. The phone signs at `/stores/condemn`.
 *
 * S5a (#1115, decision 16) adds four: `stores.purchase.request` (department; `department_store_incharge` and
 * `department_head`) asks to buy a non-stock or capital item; `stores.buying.manage` (hospital; the materials head and
 * the new `purchase_officer`) raises the store's requests, lifts a band and keeps the supplier's Stores fields;
 * `stores.budget.manage` (hospital; `accounts_officer` and the owner) sets the departments' month budgets;
 * `stores.grn.qc` (the materials head and `biomedical_engineer` at hospital scope, `department_head` at its department)
 * signs a non-drug GRN's QC with no pharmacist. The phone and desk screen is `/stores/buy` (its own menu row).
 *
 * S5b (#1115, decision 16) adds `stores.award.sign`: a committee seat's signature on a band C award (the materials head,
 * `accounts_officer`, `medical_superintendent`, `biomedical_engineer` at hospital scope; `department_head` at its department
 * for the user HOD's seat) and, with `stores.masters.manage`, the materials head's band B approval. The desk (16:9: Buy
 * now, Grouping, RFQs, Comparisons, Awards, POs) and the phone approval sheet are `/stores/buying` (its own menu row).
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
    { label: "Control tower", path: "/stores/tower", permission: "stores.tower.read" },
    { label: "Assets", path: "/stores/assets", permission: "stores.assets.read" },
    { label: "Buying", path: "/stores/buy", permission: "stores.buying.manage" },
    { label: "Buying desk", path: "/stores/buying", permission: "stores.buying.manage" },
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
    "stores.tower.read",
    "stores.spend.read",
    "stores.assets.manage",
    "stores.assets.read",
    "stores.assets.export",
    "stores.assets.condemn",
    "stores.purchase.request",
    "stores.buying.manage",
    "stores.budget.manage",
    "stores.grn.qc",
    "stores.award.sign",
  ],
  subscriptions: [],
  /** S2a (#1112, decision 12) — the Now cards: "Indents to approve", "To pick", "To receive", "To take back"; S3 adds "Stuck" (`desk.ts`). */
  desk: [...STORES_DESK_PROVIDERS],
  /**
   * S3 (#1113, decision 8) — the concierge: six reads and one act (`stores.reorder`, propose → confirm), routed by
   * the phrasebook alone (no menu entries: the frozen eval set's recordings are untouched).
   */
  copilotTools: [...storesCopilotReadTools, reorderTool],
  copilotIntents: storesCopilotIntents,
};
