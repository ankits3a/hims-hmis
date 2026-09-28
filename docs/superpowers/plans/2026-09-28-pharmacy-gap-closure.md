# Pharmacy — closing the gaps against the Healthray notes and our own boards

## Context

On 2026-09-28 the owner asked two questions. Are we missing anything we planned against Healthray? And do the
back-office screens match the product's design assets? Three read-only audits ran on `main` @ `07d2f8ff`, with
spot-checks by hand. This phase answers them.

**Measured:**
- The parity plan (`2026-09-24-pharmacy-healthray-parity.md`, P1–P6) is almost entirely BUILT.
- Against the two Healthray notes (25 Initialization submodules, 29 reports, the s01 sale screen, item master,
  stock management, shell, IPD), 78 items break down as **30 built, 30 partial, 18 absent, 0 deliberately rejected**.
- **None of the 14 back-office screens match the design assets.** They are `/materials/{items,vendors,grn,counts,transfers}`,
  `/pharmacy/{items,pharmacists,reorder,office,office/reports,registers/h1,retail-licence,downtime}` and
  `/formulary/admin`.
  - All 14 are in the old shadcn/Tailwind look, with 0–4 Paper & Pine uses each.
  - All 14 sit in the 70-link shell, which scrolls sideways by 778 px at 390 px width.
  - Only `/pharmacy/desk` is Paper & Pine.
  - The Main and Day boards (`docs/design/2026-09-18-pharmacy-desk/`) have no implementation, and Shelf diverges.
  - `/pharmacy/office` has seven tabs, and the "stores" nav still has 14 leaves. That breaks the parity plan's own
    principle 1, "two places, not 25 menus".

## Owner rulings (2026-09-28)

- **Credit is owner-only.** Nobody but the owner may issue credit: no tier, no cap, no delegate. This covers TPA,
  insurer and corporate credit too, until the owner rules otherwise. It is built as a `kernel/approvals` type with
  approver `owner`, and no act-first: the goods do not leave until the owner approves.
- **IPD gets a plan of its own.** Ward issue, the IP patient list, charging to the IP bill and the OPD/IPD toggle are
  out of this phase. `apps/core` has no admission, bed or ward table today.

## DECIDED (standard Indian-corporate-hospital answer; the owner may overturn)

- **No role editor.** Roles stay code-owned (`admin-users.tsx` says so), and the admin screen gets a read-only
  permission grid. An in-app role editor is a privilege-escalation surface. Copy-from-role is dropped with it.
- **No manual or bulk discount at the counter** until the owner rules on money. Only membership discounts exist today.
- **PO dispatch to the vendor waits** for an email/WhatsApp sender, which is a procurement decision. Print and PDF
  are what exist.
- **The ABDM MedicationDispense push waits** for ABDM going live.

## Owed by the owner (money / law)

- Patient GSTIN on the pharmacy bill (B2B input credit): yes or no?
- Old MRP next to new MRP at the counter: yes or no?

## Stages (each = one PR on this lane or a sibling lane, CI-gated, one migration per PR, numbered at rebase)

### A — go-live blockers

| # | What | Shape |
|---|---|---|
| A1 | **Opening-stock sheet from a screen** | The pharmacist's CSV is uploaded on `/materials/grn` and checked row by row. It is captured as GRNs, which land in the existing QC worklist. The pharmacist QCs and posts them there, so the two-person DD8 gate is unchanged. `scripts/import-opening-stock.ts`'s planner moves into `src` (the scripts folder is not type-checked). The script keeps working as a thin caller. |
| A1b | **Add stock found on the shelf** | **DONE BY WHAT EXISTS (DECIDED 2026-09-28, no code).** A known batch found on the shelf is a blind count's `found` variance, booked through `materials_stock_adjustment` (the MS approves), from `/materials/counts`. A batch never on the books goes in on the opening-stock sheet (A1), with the supplier blank → OPENING STOCK. Healthray's free "+ Add stock" is a silent add, and we do not copy it. |
| A2 | **Item-master editor** | HSN, schedule, manufacturer, storage class and lead time, plus new LASA and high-alert flags. Migration `0140_item_master_fields`. The desk shows a chip on the line (red high alert, gold LASA). **DECIDED:** no second-person gate at OPD handover. NABH's independent double-check binds administration on the ward, and at the counter the chip plus the existing scan-to-pick is the check. Revisit with IPD. The schedule is the formulary medicine's and is changed through `PATCH /formulary/medicines/:id` under `formulary.manage`. Everyone else sees it read-only. |
| A3 | **Credit sale, owner-only** | A desk "credit" tender raises an approval to the owner, and the dispense holds until it is granted. The amount lands in billing dues. It reuses `invoices.creditExtended`. |
| A4 | **GSTR-3B summary** | Built from the existing GSTR-1 and GSTR-2B figures. No migration. |
| A5 | **Supplier side** | A manual or damaged return to the supplier from a screen, with editable draft lines. A stock-movement ledger screen over `GET /materials/stock/movements`. |
| A6 | **Labels and indent** | Rack and strip barcode labels through `kernel/printing`. An indent (a sub-store or OT asks the central store for stock), issued as a transfer. |

### B — the screens, rebuilt to the boards

Every B stage is verified in Chromium at 1920, 1440, 1280, 1024, 768 and 390 against its board before it is called done.

| # | What |
|---|---|
| B1 | Shell: the 390 px overflow (the OPD nav group does not wrap), and the right key legend per screen. Shared files, so coordinate first. |
| B2 | `/pharmacy/office` in Paper & Pine with the header-menu layout. One "needs you today" list across buy, pay, returns, controlled, licences and pharmacists. The seven tabs go. |
| B3 | The 14 "stores" leaves fold into the office as sections and sheets. The old routes redirect, and nav becomes Desk + Office. |
| B4 | The boards: Shelf becomes `/pharmacy/reorder`, Day becomes a sheet off the desk, Main becomes the desk's "nobody in hand" state. |
| B5 | Filter tabs out (formulary worklist, GRN gate/worklists). Master-data forms move into sheets. Copy fixes ("All 0 drug items…", the licence refusal that points at its own page). |

### C — reports still missing

- Top-selling items.
- Loss-booking register.
- Daily stock (opening, in, out, closing).
- Item catalogue export.
- Real `.xlsx` export.
- Print on the expiry report.
- The side-by-side old/new document view for the activity diff.

## Order

A1 → A2 → B2+B3 → A3 → A4 → B4 → A5 → A6 → B1 → B5 → C.

A1 and A2 come first because without them the shelf cannot be loaded or corrected without an engineer. B2+B3 come
next because every later screen lives inside the office.

## A1 — detail

- **Who:** the uploader needs `materials.grn.capture`, and the storekeeper is the capturer.
  - Rows that need a new pack size or the OPENING STOCK vendor are refused. The refusal names the act and the
    permission (`materials.items.manage` / `materials.vendors.manage`) unless the uploader holds it.
  - Capture never judges its own QC. The pharmacist QCs and posts in the GRN worklist, as for any delivery.
- **What stays from the script:**
  - All or nothing: one refused row refuses the file.
  - A file-hash challan, so the same file twice captures nothing.
  - Near-expiry batches go on their own GRN and wait for `materials_near_expiry_acceptance`.
  - Expired stock is refused.
  - The MRP-per-unit refusal (`mrp_unconvertible`).
  - "Did you mean" suggestions for brands and suppliers.
  - Racks are set when the GRN posts, not at upload.
- **Screen:** "Opening stock" on `/materials/grn`. Pick or paste the CSV, then **Check** shows every row as ok,
  near-expiry or refused with its reason. **Capture** is enabled only when nothing is refused. The result names
  the GRNs now waiting for QC. A template download link points at `docs/runbooks/pharmacy-opening-stock-template.csv`'s
  columns.
