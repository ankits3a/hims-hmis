---
issue: 1111
status: approved
approved: 2026-11-18
---
# SPEC: Stores S1, the non-drug master, stores and department shelves (#1111) — APPROVED by owner 2026-11-18

Owner answered Q1–Q5 with the recommended options on 2026-11-18 (decision 0099). This is slice S1 of the Stores & Procurement programme (`docs/specs/stores-programme.md`). Owner,
2026-11-18: "a master stock and inventory module that includes any item that hospital requires (even a dustbin)
… From this master inventory other department receives their material (even the housekeeping)." Pharmacy is
separate.

## What exists

- `items.class` is checked against `ITEM_CLASS_VALUES` (`kernel/db/schema/materials.ts`). Items have no category
  and no tracking mode.
- A store is a registry resource made by `createStore` (`materials/stores.ts`), with `parentId` and
  `attributes`. `custodianRoles` is checked with `usersHoldingRole`, which ignores scope
  (`kernel/workflow/roles.ts`).
- `item_stock_levels` holds min/reorder/max per item and store. `setStockLevel` needs `materials.po.raise`.
- `MovementInput.costCenter` exists, but no caller sets it (`materials/ledger.ts`). No intent records a
  department's use of non-drug stock. Today `consume` is posted only by pharmacy and the OT consignment consumer.
- Every materials screen is a page of `/pharmacy/office`. `storekeeper` and `materials_head` have no holders.
  There is no HOD role and no department in-charge role.

## Decisions

1. **A new leaf module, `stores`.** It imports `materials` through `index.ts` only, so there is one item table
   and one ledger. Materials changes are additive only, because pharmacy is live on the same functions.
2. **Non-drug only.** Stores intents refuse class `drug`. Stores reads never return a drug item or a pharmacy
   store (`PHARM-*`). S1 registers the classes consumable, consumable_dated, stationery, asset (counted), service,
   reagent, gas and linen. Ruled (0099 Q1): anything that can appear on a patient's bill stays with pharmacy, so
   class `implant` and patient-billable consumables are refused. Ruled (Q5): linen, uniforms and canteen dry
   provisions are Stores items.
3. **Category tree.** It has two levels. The 12 seeded top categories:
   - General and sundries; Housekeeping and sanitation; Stationery and printed forms; Electrical; Plumbing and
     civil; IT and peripherals; Furniture and fixtures; Biomedical spares; Non-billable patient-care
     consumables.
   - Linen and uniforms; Kitchen provisions (dry stock only; daily fresh items are received at the kitchen and
     used the same day); Medical gases and lab reagents (non-billable).

   The materials head edits the sub-categories. Every stores item has one category.
4. **Tracking mode per item:**
   - `expensed`: used on receipt (stationery, printed forms, small sundries). It never carries a par.
   - `shelf`: kept at the department and counted.
   - `durable`: units counted at the department, never "used". They leave only by return or condemnation (S4).
   - `tagged` (one QR per unit) arrives with S4 (#1114).
5. **Requests are steered to the master.** There is no free-text line. "Not in the list" files a new-item
   request to the materials head, who creates the item or points to an existing one; the duplicate finder
   (`findDuplicateItems`) runs first. The requester gets one notice either way.
6. **Store structure:**
   - One central non-drug store per site, `GEN-MAIN`, with service hours.
   - Optional trade sub-stores (engineering, IT, kitchen, linen).
   - One night store (the emergency cabinet, used in S2).
   - Department shelves. A shelf is a `store` resource whose parent is its floor, with `departmentId` (org
     department) and `suppliedBy` (the store it indents on). A department may keep several shelves;
     housekeeping keeps one per floor (owner, 2026-10-26).
7. **Department scope.** Every shelf act (receive, use, check, reorder) checks a department-scoped permission
   inside the stores intent, with `hasPermission(…, "department", { departmentId })`. This is the roster
   precedent (`roster/access.ts`). Department roles hold no `materials.*` grant.
8. **Charge at issue.** The receiving department's org code is the cost centre. A receipt into a department
   shelf writes that cost centre on its ledger rows at the batch's received cost (GRN line unit cost per base
   unit). An `expensed` item is consumed in the same transaction, against the same cost centre.
9. **Use.**
   - "Used" (one tap and a quantity) posts a `consume` at the shelf.
   - The shelf check is monthly, or weekly where the HOD chooses. It records on-hand and posts the difference
     as use (`refType: shelf_check`).
   - A count above book posts nothing and raises a "More than book" card for the materials head.
   - `durable` items refuse "Used".
10. **Opening day.** Each shelf may be counted once with the source `opening`, with no charge.
11. **Par.** min/reorder/max per shelf item (existing `item_stock_levels`), set by the materials head at the
    HOD's request.
12. **Reorder draft.** One tap proposes every `shelf` item at or under reorder, for the quantity max − on hand,
    rounded up to the issue pack. In S1 this is a draft; sending it is S2's ticket. Until S2, the central store
    may push stock to a shelf (existing `issueStock`). The shelf receives through the stores intent (decision 8).
13. **Use rate.**
    - The shelf shows use per day over 30 days.
    - For OPD departments it shows use per OPD visit (OPD is live).
    - For wards it shows use per occupied bed-day once IPD is live (it is null while IPD is off production,
      owner 2026-10-13).
14. **Surfaces.**
    - `/stores` on the web (16:9): categories, items, stores, shelves, par and the new-item queue.
    - The department shelf on a 390 px phone. One row per item, on one line: name · on hand · status word (OK /
      Low / Out) · Used / Check. There is a Reorder button.
    - Department staff see no money.
15. **Roles.** `department_store_incharge` (department-scoped: receive, use, check, draft reorder) and
    `department_head` (department-scoped: reads the shelf, and approves in S2). The materials head holds
    `stores.masters.manage`.

## Done means

- **D1** `registerStoresItem` creates an item for each of the classes consumable, consumable_dated, stationery,
  asset and service, with a category and a tracking mode. It refuses class `drug` (`not_stores_class`) and
  refuses an item with no category.
- **D2** `listStoresItems` and `listShelves` never return a drug item, nor a store whose code starts `PHARM-`.
- **D3** `requestNewItem` puts one request on the materials head's queue. Resolving it as "use existing" or
  "created" sends the requester exactly one notice. A reorder line with no item id is refused.
- **D4** `createShelf` makes a `store` resource whose parent is the floor, carrying `departmentId` and
  `suppliedBy`. Two shelves of one department on two floors are both accepted. A shelf supplied by a pharmacy
  store is refused.
- **D5** `receiveAtShelf` on a transfer from `GEN-MAIN` writes the department's code as `cost_center` on every
  receipt row. The day's charge for that department equals Σ quantity × batch cost of those rows.
- **D6** An `expensed` item received at a shelf leaves the shelf balance at 0. The receipt writes one `consume`
  row carrying the same cost centre.
- **D7** `recordShelfUse` of a `shelf` item posts one `consume` row with the cost centre. A quantity above on
  hand is refused. A `durable` item is refused.
- **D8** `recordShelfCheck` with book 20 and counted 14 posts one `consume` of 6 (`refType: shelf_check`). With
  counted 23 it posts no ledger row and raises one "More than book" card.
- **D9** `openShelf` posts opening balances with no cost centre. A second opening of the same shelf is refused.
- **D10** A holder of the shelf grant for department A cannot receive, use, check or reorder at department B's
  shelf. A storekeeper holding only `materials.*` grants cannot receive into a department shelf.
- **D11** `shelfReorderDraft`, with par 5/10/30 and 8 on hand, proposes 22, rounded up to the issue pack. An
  item at 11 is not proposed. `expensed` and `durable` items are never proposed. Setting a par on an `expensed`
  item is refused.
- **D12** `shelfView` returns, per item: on hand, the status word, the last check date and use per day over 30
  days. For an OPD department it also returns use per OPD visit. While IPD is off, use per bed-day is null.
- **D13** `floorShelfUseByMonth` for a housekeeping floor shelf equals, per item, the sum of that month's
  `consume` rows at that shelf.
- **D14** A pharmacy indent and a pharmacy transfer behave exactly as before S1: same statuses, no cost centre,
  same refusals.
- **D15** Registering a class `implant` item, or an item marked patient-billable, through a stores intent is
  refused. A `reagent`, `gas` or `linen` item under its category is accepted.
- **D16** Every S1 intent that changes state (register, create shelf, receive, use, check, open, new-item
  request) appends one domain event carrying actor, time, store, item, quantity before and after, and reason. An
  UPDATE or DELETE on a stores ledger row is refused by the database; a correction posts a reversing row naming the
  original.

## Budgets

- The shelf view opens in ≤ 1 s for 200 items. "Used" takes ≤ 2 taps. The check is one screen of numbers.
- The reorder draft is one tap; sending it in S2 takes ≤ 3 taps in all.

## Out of scope

- Tickets, approval, custody, porters and gate passes (S2); the tower and the concierge (S3).
- Tagged units (S4); purchasing (S5).
- Linen circulation (laundry module); patient-billable items (pharmacy); the native staff-app screen (its own issue).

## Build notes

- **Files.**
  - New `apps/core/src/modules/stores/`: manifest, `items.ts`, `shelves.ts`, `use.ts`, `reads.ts`, controller, and
    a `MAP.md`. Materials has none today, so add one there too.
  - `packages/contracts/src/stores.ts`.
  - Web: `/stores` and the phone shelf.
  - Materials, additive only: an optional `costCenter` in `receiveStock`'s options. Nothing else changes.
- **Migration** yes, one: `item_categories`, `items.category_id` and `items.track_mode` (nullable, so pharmacy
  rows stay null), and `stores_item_requests`.
- **Permissions** `stores.masters.manage`, `stores.shelf.read`, `stores.shelf.work`, plus the two roles. These
  touch the seed-roles pins and README prose.
- **Shared files:**
  - `manifests.ts`, `app.module.ts` and `schema/index.ts`.
  - The router, the locales and the caddyfile parity test.
- **Size** L. **Depends on** nothing. **Blocked by** nothing.
