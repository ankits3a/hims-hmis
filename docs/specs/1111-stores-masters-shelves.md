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
- `stock_ledger` has no update or delete path in the code (`materials/ledger.ts`; `ledger.test.ts` pins it on
  the source), but no database trigger refuses one. There is no reversal intent.
- `receiveStock` (`materials/transfers.ts`) checks no permission itself (the route holds
  `materials.stock.receive`) and skips the keeper check when the store has no `custodianRoles`.
- Items have no alias or Hindi-name column and no patient-billable marker. Materials has no item import;
  `findDuplicateItems` (`materials/item-merge.ts`) scans the whole catalogue, and `similarNames` compares two names.
- `MovementInput.costCenter` exists, but no caller sets it (`materials/ledger.ts`). No intent records a
  department's use of non-drug stock. Today `consume` is posted only by pharmacy and the OT consignment consumer.
- Every materials screen is a page of `/pharmacy/office`. `storekeeper` and `materials_head` have no holders.
  There is no HOD role and no department in-charge role.

## Decisions

1. **A new leaf module, `stores`.** It imports `materials` through `index.ts` only, so there is one item table
   and one ledger. Materials changes are additive only, because pharmacy is live on the same functions.
2. **Non-drug only.** Stores intents refuse class `drug`. Stores reads return only stores that stores itself
   created (`attributes.domain: 'stores'`), never a drug item. S1 registers the classes consumable, consumable_dated, stationery, asset (counted), service,
   reagent, gas and linen. Ruled (0099 Q1): anything that can appear on a patient's bill stays with pharmacy, so
   class `implant` and items marked `patient_billable` are refused. Ruled (Q5): linen, uniforms and canteen dry
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
5. **Requests are steered to the master.** Search matches the name and `search_aliases` (Hindi, Hinglish and
   local names, e.g. "kachra dabba" for a dustbin); a typed fallback finds an item by its code's last four
   digits. There is no free-text line. "Not in the list" files a new-item
   request to the materials head, who creates the item or points to an existing one; the duplicate finder
   (`findDuplicateItems`) runs first. The requester gets one notice either way.
6. **Store structure:**
   - One central non-drug store per site, `GEN-MAIN`, with service hours and `custodianRoles: ['storekeeper']`
     (pharmacists hold `materials.stock.issue` and `.receive`, so the keeper list is what keeps them out).
   - Optional trade sub-stores (engineering, IT, kitchen, linen).
   - One night store (the emergency cabinet, used in S2).
   - Department shelves. A shelf is a `store` resource whose parent is its floor, with `departmentId` (org
     department) and `suppliedBy` (the store it indents on). A department may keep several shelves;
     housekeeping keeps one per floor (owner, 2026-10-26).
7. **Department scope.** Every shelf act (receive, use, check, reorder) checks a department-scoped permission
   inside the stores intent, with `hasPermission(…, "department", { departmentId })`. This is the roster
   precedent (`roster/access.ts`). Department roles hold no `materials.*` grant. Stock enters a shelf only through
   `receiveAtShelf`: the existing materials receive route into a shelf is refused for every caller
   (`shelf_receives_through_stores`), because `receiveStock` itself checks no permission and a shelf names no keeper.
8. **Charge at issue.** The receiving department's org code is the cost centre. A receipt into a department
   shelf writes that cost centre on its ledger rows at the batch's received cost (GRN line unit cost per base
   unit). An `expensed` item is consumed in the same transaction, against the same cost centre.
9. **Use.**
   - "Used" (one tap and a quantity) posts a `consume` at the shelf.
   - The shelf check is monthly, or weekly where the HOD chooses. It records on-hand and posts the difference
     as use (`refType: shelf_check`).
   - A count above book posts nothing and raises a "More than book" card for the materials head.
   - `durable` items refuse "Used".
10. **Opening day.** Each shelf may be counted once with the source `opening`, with no charge. `openStore` posts
    `GEN-MAIN`'s opening stock once. `importStoresItems` loads the register from a sheet: the duplicate check
    (`similarNames`) runs per row, a dry run creates nothing, and each refusal names its row.
11. **Par.** min/reorder/max per shelf item (existing `item_stock_levels`), set by the materials head at the
    HOD's request. Par, category and track-mode edits each append an event with before and after.
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
16. **Corrections.** A wrong "Used" is corrected by `reverseShelfUse(rowId, reason)`: one opposite ledger row
    (reason `adjust`, `refType: reversal`, `refId` = the original). A row is reversed at most once. The database
    refuses UPDATE and DELETE on `stock_ledger` (a trigger added by this slice's migration).

## Done means

- **D1** `registerStoresItem` creates an item for each of the classes consumable, consumable_dated, stationery,
  asset and service, with a category and a tracking mode. It refuses class `drug` (`not_stores_class`) and
  refuses an item with no category.
- **D2** `listStoresItems` and `listShelves` return only stores with `attributes.domain: 'stores'` and never a
  drug item; a store created by materials or pharmacy is never listed.
- **D3** `requestNewItem` puts one request on the materials head's queue. Resolving it as "use existing" or
  "created" sends the requester exactly one notice. A reorder line with no item id is refused.
- **D4** `createShelf` makes a `store` resource whose parent is the floor, carrying `departmentId`, `suppliedBy`
  and `domain: 'stores'`. Two shelves of one department on two floors are both accepted. A shelf supplied by a
  store stores did not create is refused.
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
- **D15** Registering a class `implant` item, or an item with `patient_billable` true, through a stores intent is
  refused. A `reagent`, `gas` or `linen` item under its category is accepted.
- **D16** Every state-changing S1 intent (register, create shelf, receive, use, check, open, import, new-item
  request, and par, category or track-mode edits) appends one domain event with actor, time, store, item,
  quantity before/after and reason. A raw UPDATE or DELETE on `stock_ledger` is refused by the database.
  `reverseShelfUse(rowId, reason)` posts one opposite row (reason `adjust`, `refType: reversal`, `refId` = the
  original); a second reversal of the same row is refused.
- **D17** The existing materials receive route into a department shelf is refused for every caller
  (`shelf_receives_through_stores`); into `PHARM-OPD` it behaves as before.
- **D18** `searchStoresItems('kachra dabba')` returns the dustbin (via `search_aliases`), and a search by the
  last four digits of its code returns it too.
- **D19** `importStoresItems(rows)` runs the duplicate check per row, creates none on a dry run, and reports each
  refusal with its row number. `openStore('GEN-MAIN')` posts opening stock once; a second call is refused.
- **D20** (web, 390 px) The shelf shows one row per item on one line with a status word; "Used" is reachable in
  ≤ 2 taps; there is no horizontal scroll and no money figure for department staff.

## Screens

Phone screens fit 390 px with no horizontal scroll; `/stores` is 16:9 (fits 1366 × 768). Every status is a word,
never colour alone. Notices are a few words on one line. Strings are verbatim, English / Hindi.

- **Department shelf (phone).** Header: department · floor. Rows, one line each: item name · on hand · status
  word · "Used" / "Check". Primary button: **Reorder / दोबारा मँगाएँ** (opens the draft). Status words: OK / ठीक,
  Low / कम, Out / खत्म. Empty: "No items on this shelf / इस शेल्फ़ पर कोई सामान नहीं". Loading: grey rows, no
  text. Refused: "Not your department / आपका विभाग नहीं".
- **Used (sheet).** Item name, on hand, a quantity stepper (default 1). Primary: **Used / इस्तेमाल हुआ**. Refused:
  "More than on hand / स्टॉक से ज़्यादा", "Not used up, return it / इस्तेमाल नहीं, वापस करें" (durable).
  Done notice: "Saved / सेव हुआ". Undo within the sheet calls `reverseShelfUse`: "Undone / वापस लिया".
- **Shelf check.** One screen: per row item · book hidden · counted box. Primary: **Save count / गिनती सेव करें**.
  Notices: "Count saved / गिनती सेव हुई"; above book: "More than book, sent to stores / बुक से ज़्यादा, स्टोर को भेजा".
- **Reorder draft.** Lines prefilled (item · proposed quantity, editable). Primary in S1: **Save draft / ड्राफ़्ट
  सेव करें** (S2 makes it **Send / भेजें**). Empty: "Nothing to reorder / मँगाने को कुछ नहीं".
- **Add a line (search).** Search box matching name, aliases and last four digits. Empty result offers
  **Not in the list / सूची में नहीं**, which files a new-item request: "Request sent / अनुरोध भेजा". The
  requester's one notice: "Item added / सामान जुड़ गया" or "Use existing item / मौजूदा सामान लें".
- **`/stores` (web, materials head).** Tabs: Categories, Items, Stores, Shelves, Par, New items. One primary per
  tab: Add category, Add item, Add store, Add shelf, Set par, Resolve. Items tab also has **Import items** with a
  dry-run table (row number · refusal). Empty: "Nothing yet / अभी कुछ नहीं". Refused: "No permission / अनुमति
  नहीं".

## Budgets

- The shelf view opens in ≤ 1 s for 200 items. "Used" takes ≤ 2 taps. The check is one screen of numbers.
- The reorder draft is one tap; sending it in S2 takes ≤ 3 taps in all.

## Out of scope

- Tickets, approval, custody and porters (S2, #1112); gate passes (S2c, #1119); the tower and the concierge (S3).
- Tagged units (S4); purchasing (S5).
- Linen circulation (laundry module); patient-billable items (pharmacy); the native staff-app screen (its own issue).

## Build notes

- **Files.**
  - New `apps/core/src/modules/stores/`: manifest, `items.ts`, `shelves.ts`, `use.ts`, `reads.ts`, controller, and
    a `MAP.md`. Materials has none today, so add one there too.
  - `packages/contracts/src/stores.ts`.
  - Web: `/stores` and the phone shelf.
  - Materials, additive only: an optional `costCenter` in `receiveStock`'s options, and a refusal
    `shelf_receives_through_stores` when the destination store carries `domain: 'stores'` and `kind: 'shelf'`
    and the caller is not the stores intent. Pharmacy stores carry neither, so pharmacy is untouched.
- **Migration** yes, one: `item_categories`, `items.category_id`, `items.track_mode`, `items.search_aliases`
  (text array) and `items.patient_billable` (all nullable or defaulted, so pharmacy rows are unchanged),
  `stores_item_requests`, and a hand-carried `stock_ledger_append_only` trigger (`BEFORE UPDATE OR DELETE`, the
  `0012_billing_immutability.sql` pattern).
- **The trigger is a SHARED kernel and migration change touching live pharmacy** (coordinate before editing).
  Verified 2026-11-18: no code path updates or deletes `stock_ledger` rows, `materials/ledger.test.ts` asserts
  that on the source and deletes none, and `test/helpers/db.ts` `truncateAll` uses TRUNCATE, which a row trigger
  does not fire on. Run the pharmacy and materials suites in CI on this PR; any later migration that backfills
  ledger rows must drop and re-create the trigger in the same file.
- **Permissions** `stores.masters.manage`, `stores.shelf.read`, `stores.shelf.work`, plus the two roles. Seed
  `GEN-MAIN` with `custodianRoles: ['storekeeper']` and `domain: 'stores'`. These
  touch the seed-roles pins and README prose.
- **Shared files:**
  - `manifests.ts`, `app.module.ts` and `schema/index.ts`.
  - The router, the locales and the caddyfile parity test.
- **Size** L. **Depends on** nothing. **Blocked by** nothing.
