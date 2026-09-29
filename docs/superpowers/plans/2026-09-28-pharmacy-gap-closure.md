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

None open. The three below were ruled on 2026-09-28 (asked in hmis-10's session, answered "No." to each):
- **Patient GSTIN on the pharmacy bill: NO.** Every pharmacy bill stays B2C.
- **Old MRP beside the new MRP at the counter: NO.**
- **Home delivery / online orders: NO.** Do not build them.

## Stages (each = one PR on this lane or a sibling lane, CI-gated, one migration per PR, numbered at rebase)

### A — go-live blockers

| # | What | Shape |
|---|---|---|
| A1 | **Opening-stock sheet from a screen** | The pharmacist's CSV is uploaded on `/materials/grn` and checked row by row. It is captured as GRNs, which land in the existing QC worklist. The pharmacist QCs and posts them there, so the two-person DD8 gate is unchanged. `scripts/import-opening-stock.ts`'s planner moves into `src` (the scripts folder is not type-checked). The script keeps working as a thin caller. |
| A1b | **Add stock found on the shelf** | **DONE BY WHAT EXISTS (DECIDED 2026-09-28, no code).** A known batch found on the shelf is a blind count's `found` variance, booked through `materials_stock_adjustment` (the MS approves), from `/materials/counts`. A batch never on the books goes in on the opening-stock sheet (A1), with the supplier blank → OPENING STOCK. Healthray's free "+ Add stock" is a silent add, and we do not copy it. |
| A2 | **Item-master editor** | HSN, schedule, manufacturer, storage class and lead time, plus new LASA and high-alert flags. Migration `0140_item_master_fields`. The desk shows a chip on the line (red high alert, gold LASA). **DECIDED:** no second-person gate at OPD handover. NABH's independent double-check binds administration on the ward, and at the counter the chip plus the existing scan-to-pick is the check. Revisit with IPD. The schedule is the formulary medicine's and is changed through `PATCH /formulary/medicines/:id` under `formulary.manage`. Everyone else sees it read-only. |
| A3 | **Credit is the owner's, hospital-wide** | See "A3 — design" below. The owner's scope ruling of 2026-09-28 widened this from pharmacy to the whole hospital. |
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

## A3 — design (owner rulings 2026-09-28: "nobody can issue credit except owner", scope = whole hospital)

**What counts as credit (DECIDED, from the option the owner chose):** credit is letting a service, a medicine or a
report go out without being paid for. A bill raised unpaid while the thing it pays for is still HELD is not credit.
The lab's reflex and add-on bills are the case in point: the report stays locked until the money is in (DD23's
interlock). Releasing that report unpaid IS credit.

**Measured on `main` @ ae828c3d:**

| Path | Today | After |
|---|---|---|
| OPD counter: a credit-extended invoice lets the consult start (`billing/gate.ts` `feeCovered`) | the cashier (`billing.credit.extend`) up to `creditCapPaise`, with no approval; `billing_credit_extension` (approver **billing_manager**) above it | every remainder needs a GRANTED `billing_credit_extension`, whose approver is **owner** |
| Lab desk: order with part payment, `credit: {reason}` (`lab-desk.tsx:79`, `lab/desk.ts:442`) | lab reception holds `billing.credit.extend` | **held, not credit (built #347):** the interlock holds EVERY unpaid lab report, so the desk's balance is a hold; the desk says "pay at the report" |
| Lab reflex / add-on at the bench (`lab/verify.ts:680`) | a credit invoice, issued automatically | an unpaid invoice HELD by the interlock, with no credit flag and no approval: collected before the report goes |
| Lab report released unpaid (`lab_release_unpaid`) | approver **billing_manager** | approver **owner** |
| Pharmacy: medicines handed over unpaid | impossible (money before the drug) | a desk "credit" tender raises the owner's approval, and the dispense holds until it is granted |

**Build order (one lane, `credit-owner`; billing is imported everywhere, so behaviour changes only, no signature
change):**
1. `billing_credit_extension` and `lab_release_unpaid`: approver `owner`. The cap no longer exempts anything. Any
   remainder needs the granted approval; `creditCapPaise` stays in config, but credit stops reading it.
2. An internal-only `holdUntilPaid: {reason}` on `issueInvoice`, for the lab's reflex and add-on bills. It is not on
   the HTTP route. It persists the invoice unsettled with `credit_extended = false`, so no fee gate treats it as paid.
3. Lab desk: no ask needed. Its balance is held until the report (see the table). The ask lives on the billing
   counter, as "Ask the owner for ₹X on credit" (`owner-credit-ask.tsx`), and the pharmacy will reuse it.
4. Pharmacy desk: a "Credit — owner approves" tender, the same approval, with the dispense held at `picked`.
5. Test fixtures that used `credit: {reason}` as a shortcut for "an unpaid invoice" (about 30 files) move to a helper
   that files and grants the approval, or to `holdUntilPaid`.
6. `seed-roles`: `billing.credit.extend` stays with the roles that USE a granted approval. Granting it no longer
   lets anyone extend credit alone. README prose is updated.

**Until A3 ships, production still lets a cashier extend credit up to the cap.** The fastest safe stop that breaks
nothing is the owner setting `creditCapPaise` to 0 in `/billing/config`. Then every credit asks for approval,
though still from the billing manager until step 1 lands. The lab reflex path, which passes no approval, would
then refuse. So this stop is NOT applied until step 2 is in.

## A6a — rack and strip labels (as built 2026-09-29, lane `pharmacy-a6-labels`)

DECIDED (standard Indian-corporate-hospital answer; the owner may overturn):

- **One sticker size, 50 × 25 mm**, on the pharmacy's own barcode label printer (TSC / Zebra / TVS class). It is a
  new logical print destination, `pharmacy_label`, next to the 72 mm `pharmacy_thermal` bill roll. Each sticker is
  one 50 × 25 mm page. A relay operator maps the destination to the printer's queue
  (`tools/print-relay/README.md`).
- **Two documents**:
  - `pharmacy_rack_label`, for the shelf edge: the rack location large, the item name, and the code with the store.
  - `pharmacy_strip_label`, for a loose strip cut from its box: the item name (up to three lines so the strength
    survives), the batch, **EXP MM/YYYY** in bold, and the MRP per pack from the books.
  - Both carry an 18 mm QR.
- **The QR is an in-house payload**, not GS1, because there is no GTIN to encode:
  - a rack label says `HMIS1|<itemCode>`;
  - a strip label says `HMIS1|<itemCode>|<batchNo>|<packUom>`.
  - The desk's pick scan (`scan.ts`) reads it as that item and batch. The expiry comes from the books, so there is
    no printed-expiry cross-check.
- **Refused before anything prints** (`invalid_label`):
  - a rack label for an item with no rack in that store;
  - a strip label without a batch of that item;
  - a strip label for a batch with no MRP on the books (a loose strip is sold at its MRP);
  - a pack the item does not have;
  - more than 500 stickers in one print.
- **Permission**: `pharmacy.sale_items.manage`, the same one that sets the rack (`PUT /pharmacy/items/:id/location`).
  No new permission.
- **Screen**: Office → Items → "Rack & strip labels" (the Menu artboard's "new (A6)" entry).
  - One list per store: item, rack, rack-label copies, and each held batch with its strip-label copies.
  - Two print buttons, and no tabs.
  - With no relay serving the label printer, the stickers print from the browser.
- **No migration**: `print_jobs.document` is plain text.

A6b (indent: a sub-store or OT asks the central store; issued as a transfer) is still to come. It is a separate PR
and carries the migration.

## Stage D — pharmacy safety (added 2026-09-28 from hmis-10's Healthray re-review; built in lane `pharmacy-safety` by hmis-10)

**Owner ruling, 2026-09-28, verbatim:** "IPD, Emergency, Insurance/TPA, Blood Bank, Dailysis, Immunisation, Ambulance,
mortuary each will have individual brainstorm session. For now, let's only focus on Pharmacy department."

The owner ruled on none of the D items individually. Each item below is the standard Indian-corporate-hospital
answer, DECIDED.

**How the absences were measured:** `grep -rniE` over `apps/core/src`, `apps/web/src` and `packages/contracts` on
`main` @ 63fd0e67, excluding tests and locales, with several spellings per item. The hit lists are in the table.

| # | What | Measured absence | Basis | Plugs into |
|---|---|---|---|---|
| D1 | ADR / pharmacovigilance: a suspected-ADR report, which also writes the patient's allergy in the same transaction | only the radiology contrast reactions exist (`radiology/reactions.ts`, `imaging_contrast_reactions`); reuse that shape | PvPI (IPC Ghaziabad, MoHFW), Suspected ADR Reporting Form; NABH MOM | office **Law** menu; a "needs you" row until submitted to the AMC |
| D2 | Medication-error and near-miss log | no hits (two unrelated "near miss" uses in abdm and lab) | NABH MOM; NCC MERP index A–I; the error rate is a quality indicator | office **Law** menu; the desk's ⋯ gets "record a near miss" |
| D3 | Fridge cold-chain temperature log | "fridge" exists only as a free-text shelf label (`shelf-locations.ts:18`) | Drugs & Cosmetics Rules 1945, storage as labelled; NABH MOM storage | office **Stock** menu; a missed reading or an excursion is a "needs you" row |
| D4 | Crash-cart / emergency-tray check and restock (OPD, radiology and OT trays; ER trays go to the ER brainstorm) | zero hits | NABH MOM (emergency medicines standardised, checked, replenished) | office **Stock** menu; a check that is due is a "needs you" row |
| D5 | Reserve-tier antibiotic gate (WHO AWaRe Reserve) | `cds/guardrails.ts:156-165` is advisory amber only | ICMR AMSP 2018: Reserve agents need prior authorisation by the ID physician or microbiologist | a `kernel/approvals` type; the approver is the role holding a new antimicrobial-authorise permission; the dispense holds until granted; the ask goes into the pharmacy desk's authorisation sheet |
| D6 | Ward returns | zero hits | — | **waits for the IPD brainstorm** (ruling above) |

- **Standard numbers:** confirm the NABH 5th edition MOM numbers from the text before quoting them in any screen or print.
- **Migrations:** each D PR takes the next free number at rebase, and pharmacy-safety tells this lane before each rebase.
- **"Needs you" rows:** D rows join `GET /pharmacy/office/needs` (`pharmacy/office-needs.ts`, B2 #349) as new sources, after #349 merges.
