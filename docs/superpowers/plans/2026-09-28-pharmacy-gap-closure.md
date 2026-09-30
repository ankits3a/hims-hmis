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
- ~~No manual or bulk discount at the counter until the owner rules on money.~~ **Superseded: the owner ruled on
  2026-09-30** — see "Owner rulings 2026-09-30 (money)" below (a sale discount with a reason, tiered approval).
- **PO dispatch to the vendor waits** for an email/WhatsApp sender, which is a procurement decision. Print and PDF
  are what exist.
- **The ABDM MedicationDispense push waits** for ABDM going live.

## Owner rulings 2026-09-30 (money)

Memory note `owner-rulings-2026-09-30-pharmacy-money`. Built in lane `pharmacy-discount-rounding` (one PR, migration
`0164_invoice_rounding_rule` (renumbered at merge), additive: `invoices.rounding_rule text not null default 'half_up'`).

**1 — Rounding by tender.** First ruling: *"If patient is paying using cash then keep whole-rupee rounding, round down.
If paying via UPI or Card then we can collect to the paisa."* **AMENDED by the owner the same day, on PR #424:** *"If the
amount is 33.60, the collection should be 34. If it's 30.91 then collection should be Rs 31. If it is Rs 30.49 then
collection can be Rs 30. But if it's 30.51 then collection in cash should be 31."* So cash rounds to the NEAREST rupee,
halves up (₹30.50 → ₹31), and may collect up to 49 paise above MRP — the owner's decision.
- Pharmacy bills only — the desk's dispense bill, the walk-in sale and the paper (downtime) dispense. Any cash tender
  (a split included) → `half_up`: ₹33.60 → ₹34.00 (+₹0.40), ₹30.91 → ₹31.00, ₹30.49 → ₹30.00, ₹30.50 → ₹31.00,
  ₹30.51 → ₹31.00. Only UPI and/or card → `exact`: ₹33.60 → ₹33.60. The rule is chosen from the tenders by
  `pharmacy/discount.ts` `pharmacyRoundingRule` and passed to billing as an internal `roundingRule`; billing refuses
  `exact` on a bill that is not wholly pharmacy lines (`pharmacy_bill_only`), so OPD, lab and radiology keep §170
  half-up exactly as before.
- **DECIDED:** a bill with no tender (the owner's credit) takes the cash rule (nearest rupee): the dues are most often
  paid in cash.
- **DECIDED:** a credit note rounds by its invoice's stored rule. A full cancel of a ₹34.00 cash bill credits ₹34.00;
  a full cancel of a ₹33.60 UPI bill credits ₹33.60 — a half-up credit note would free ₹34.00 there, and the refund
  voucher would refuse it as more than was received.
- The desk's preview carries both payables (`byTender.cash`, `byTender.digital`); the rail shows the one for the
  tender under the cashier's finger (Cash/Split vs UPI/Card) with its rounding line. The walk-in counter does the same.
- Register: MRP and Rounding columns (MRP − discount = taxable + CGST + SGST; + rounding = total). GSTR-3B: rounding is
  not a supply and stays out of the taxable value; the summary states the period's pharmacy rounding beside it.
  Tally: the Round Off ledger takes it, as before.

**2 — Sale-side discount.** *"The pharmacist may give up to 10% off MRP on a bill, with a reason. Above 10% needs the
pharmacy in-charge's approval. Above 25% goes to the owner. A discount worth more than ₹25,000 on one bill also goes to
the owner."*
- A % off MRP (basis points) or ₹ off the bill, with a reason, on the desk bill and the walk-in cart, from a sheet
  behind the bill's ⋯. Up to 10% inclusive: the pharmacist gives it. Above 10% up to 25% inclusive:
  `pharmacy_discount_incharge` (approver `pharmacy_incharge`). Above 25%, or more than ₹25,000.00 of discount on one
  bill: `pharmacy_discount_owner` (approver `owner`). Exactly ₹25,000.00 is not "more than". Comparisons are exact
  (cross-multiplied); a ₹ discount is judged by its share of the bill's MRP total.
- The approval binds the bill (the dispense id, or the walk-in cart's own id, which the sale then takes as its id so
  one approval sells once), the kind and value asked, the patient and the rupee amount. The bill waits while it is
  pending. The kernel refuses a decision by whoever asked. An in-charge's grant never covers an owner-tier discount.
- It prices through the SAME contest as membership benefits (`billing/sale-discount.ts`, one more `AdjustmentSource`),
  so GST is carved out of each discounted line (`inclusiveTaxHead(charged)`): the taxable value and CGST/SGST fall
  with the price. Rounding (ruling 1) applies after the discount. Admitted only on a pharmacy bill.
- **DECIDED:** best single benefit per line, as the contest already rules — a member benefit that is bigger on a line
  wins that line; the two never stack. The approval amount is the sale discount's own share.
- Worked examples (15 Crocin, ₹33.60 of MRP): **8%** is ₹2.69 off → ₹30.91: cash ₹31.00 (+₹0.09), UPI/card ₹30.91;
  the pharmacist's own. **15%** is ₹5.04 off → ₹28.56: cash ₹29.00 (+₹0.44), UPI/card ₹28.56; the in-charge approves.
- **DECIDED:** a ₹ discount is spread over the lines in proportion to their MRP (largest remainder), so the shares sum
  to the rupees asked; a % is taken off each line, half-up, as every other percentage benefit is.
- **DECIDED:** a walk-in discount that needs an approval needs a named customer first (`discount_needs_customer`): an
  approval of money is filed against a patient.
- **DECIDED:** the approver role of each type is fixed, so the owner does not approve an in-charge-tier ask, and an
  in-charge who is also billing needs a second in-charge. If the hospital has one in-charge on duty, a 10–25% discount
  that they themselves ask for waits for the next one.
- Shown on the bill rail, the printed desk bill (Discount (reason) −₹x), the walk-in memo (billing's invoice print),
  the sales register (Discount column), the GSTR-3B summary (a note: already out of the taxable value, CGST Act
  s.15(3)(a)) and the Tally sale voucher's narration (MRP less discount).
- Permissions: no new permission string. `pharmacy_incharge` gains `approvals.requests.read` and `.decide` (an
  approver role must be able to open its queue). Two approval types, registered by `seed:pharmacy` on deploy.

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

## A6b — indents (as built)

Lane `pharmacy-a6-indent`. Migration **0155** (generated as 0152; renumbered at merge after A5 0152, radiology 0153 and the desk split 0154) (`store_indents`, `store_indent_lines`, plus hand-carried guard
triggers). No new permission: `seed-roles` pins do not move.

DECIDED (standard Indian-corporate-hospital answer):
- An indent is a sub-store (ward, OT, pharmacy counter) asking a supplying store for stock, in base units. It moves
  nothing. The supplying store **issues** it as one ordinary transfer (`issueStock`: FEFO, through `IN-TRANSIT`),
  which the indent records, or **rejects** it with a reason. The requester may **cancel** it, with a reason, while it
  is still requested. The receiving side receives the transfer through the existing receipt, unchanged.
- States: `requested → issued | rejected | cancelled`, once. `issued` ⇔ a transfer is linked. A rejection and a
  cancellation each carry their reason. The header and lines are immutable apart from that one decision, and a line's
  `qty_issued` is set once (DB triggers). Neither is ever deleted.
- Issue quantities: a line defaults to the asked quantity capped at what the supplying store has available now. The
  keeper may lower any line, even to 0, but may not raise it above what was asked. The indent must carry at least one
  unit. More than the shelf holds is the transfer's own refusal (`insufficient_stock`).
- One item appears once per indent, whole quantities above zero, and the two stores must differ.
- Numbering: `EPISODE_SERIES.store_indent` = `MIN` (`MIN2609290001`).
- Who may: raise and cancel need `materials.stock.receive`, and issue and reject need `materials.stock.issue`. Reads
  need `materials.stock.read`. A store that names `custodianRoles` is acted for only by holders of one of those roles:
  the requesting store's keepers raise and cancel, and the supplying store's keepers issue and reject. This is the same
  rule as `receiveStock` and the tray restock.
- Errors: `unknown_indent` (404), `invalid_indent` (409, not 400: `errors.test.ts` pins the module to 403/404/409, and
  every other `*_invalid` code in the module is a 409), `indent_closed` (409). An empty reason is the module's
  existing `reason_required`, and a non-keeper is the existing `not_store_keeper`.
- Events: `material.indent_raised`, `material.indent_issued`, `material.indent_rejected` and
  `material.indent_cancelled`, one per act, each in the act's transaction.
- HTTP (`materials-indents.controller.ts`): `GET /materials/indents`, `GET /materials/indents/:id`,
  `POST /materials/indents`, and `POST /materials/indents/:id/{issue,reject,cancel}`.
- Screen: an **Indents** section at the top of Transfers & indents (`/materials/transfers`). It shows open indents
  with Issue and Reject for the supplying side and Cancel for the requester. Raise, Issue, Reject and Cancel each open
  as a sheet. The issue sheet starts each line at the asked quantity and shows the shelf. Answered indents are listed
  with their transfer or their reason. There are no filter tabs.

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

## Desk fixes (2026-09-30)

Lane `pharmacy-desk-fixes`, from the end-to-end walk of 2026-09-29 (the owner dispenses to real patients from 2026-09-30).

- **DECIDED — a pick splits a line FEFO across batches.** Standard Indian hospital practice: when the first-to-expire
  batch cannot cover a line, the pick takes the rest from the next batches of the same item in the counter's store
  (for a controlled drug, the cabinet), earliest expiry first, as many as it takes. Every per-batch guard is the one the
  single-batch pick had (`fefoPick` → `sellableBatchRows`: held here, not recalled, not expired, net of reservations and
  cold-chain/recall freezes; `handOverDispense` re-asks expiry per line at the act). Only more than all the batches hold
  is `short_stock` (a partial with a reason). A NAMED batch (`batchId`, or a GS1 scan's batch) is still one batch.
- **How: one extra dispense line per extra batch, made at the pick.** The prescription's line keeps the first batch; each
  further batch is a NEW `pharmacy_dispense_lines` row with the same rx line, medicine, schedule, NDPS class and
  substitution/consent, its own reservation, no order item, and `split_from_line_idx` = the line it came from (migration
  `0154_pharmacy_split_pick`, one nullable column, additive). Chosen over a child "line batches" table because every
  downstream reader — reservation release/expiry sweep, bill (`priceLines`), hand-over (consume, H1 and controlled
  registers), label, returns, refund, closing — already works one row per line, so each gets one row per batch with no
  change. What had to know: `dispense.picked` carries `splitFrom`; the day summary does not count a split row as a
  picked line; closing counts prescription lines; the desk draws a split inside its prescription line (`parts`), the
  ticket header counts prescription lines, and the tick-time advice says `split` / `short_all` instead of "one batch per line".
- **Bill rail follows a quantity edit before the tick; a paid ticket shows what was taken plus the rounding** (read off
  the invoice through `/closing`, `roundingPaise` added). Rounding is not recomputed — that is an open owner money ruling.
- **Near-expiry approval card** names the GRN, supplier, invoice/challan and each short-dated line (batch, expiry, days
  left, quantity) via `GET /materials/grns/:id/near-expiry`; the supplier bank-change card names the supplier and the
  masked old → new account.
- **H1 register drug name** no longer repeats a strength the brand carries ("Azee 500 tablet"). Rows already written keep
  their text (the register copies at write time).

## Owner rulings 2026-09-30 (refunds and GRN)

Lane `pharmacy-refund-grn-setting`. The owner's answers to the go-live night's questions 3 and 4
(memory note `owner-rulings-2026-09-30-pharmacy-money`). Rounding and the sale-side discount are a
sibling lane's (`pharmacy-discount-rounding`).

**4 — Refunds: every refund goes to the billing manager; one ABOVE ₹25,000.00 goes to the owner.** As built:

- The tier was already on `main` from the 28 Sep board ruling (#380): `requestRefund` files
  `billing_refund` (approver `billing_manager`) at or under 2,500,000 paise and `billing_refund_owner`
  (approver `owner`) above it (`refundApprovalTypeFor`, strictly greater). The approval carries the exact
  amount, patient and subject; `issueRefundVoucher` accepts only a granted approval of the type the
  amount needs, bound to the same amount, patient and subject.
- ₹20,000.00 → the billing manager decides. ₹25,000.00 exactly → the billing manager. ₹25,000.01 and
  ₹30,000.00 → the owner; a billing manager's approve or reject is refused by the engine's role check
  (`role_denied`), and a manager-type grant cannot issue the voucher (`approval_subject_mismatch`).
- Nobody decides their own: the kernel's `requester_approver` SoD pair refuses the requester (cashier,
  manager or owner) deciding their own ask, and records `sod.violation_blocked`.
- NEW in this lane: the request note now leads with the paper — `Bill <invoice no> · credit note <cn no>`
  for a refund against a bill, `Advance balance` for an advance — so the owner's approvals card shows
  patient, amount and bill.
- Hospital-wide: every caller goes through `requestRefund` — pharmacy returns (`pharmacy/returns.ts`),
  pharmacy bill refunds (`pharmacy/refund.ts`), OT (`ot/bill.ts`) and the billing counter/office
  (`POST /billing/refunds/request`). No signature changed.
- The line is the owner's number in code (`REFUND_OWNER_ABOVE_PAISE`), not a config row: a row a manager
  could edit would let the manager move the line that decides whether the manager decides.

**3 — Two-person GRN is a SETTING, OFF by default, recommended ON.** As built:

- `materials_settings` (one row, `id = 'main'`; migration `0163_materials_settings` (renumbered at merge; radiology took 0162), additive). No row =
  every setting off. Column `grn_qc_needs_second_person`.
- `GET /materials/settings` (`materials.stock.read`) and `PUT /materials/settings`
  (`materials.stores.manage` — the materials head and the admin/owner role; reused, not minted). Each
  change appends `store_settings.changed` `{ setting, from, to }` with the actor; a save that changes
  nothing writes nothing.
- ON: `runGateQc` and `postGrn` refuse the GRN's capturer with `grn_same_person` (409). Because the check
  sits in those two functions, every door obeys it — the GRN screen, `applyOpeningStock` / the
  `import-opening-stock` script, the controlled-cabinet receipt, the seed and trial-stock scripts. A GRN
  QC'd by its capturer before the setting was turned on still needs a second person to POST it.
- OFF: today's behaviour, nothing blocked. The GRN worklist marks a GRN checked by its capturer
  ("Checked by the same person who captured it") — already checked, or open in the capturer's hands.
- Screen: pharmacy office → Stock → **Stores settings**, a switch with the line "Recommended: turn this on
  once a second trained person (pharmacist or storekeeper) is on every shift." With the setting ON, the
  capturer's GRN sheet says somebody else checks it and its QC/Post buttons are off.
- DECIDED: the post is guarded as well as the QC (the ruling says "QC and post"); the near-expiry request
  is not guarded (it decides nothing and the materials head approves it).

## Paper prescription at the desk (2026-09-30)

Owner, at the live counter: *"If any registered patient comes to the counter then I am unable find the patient and
dispense any medicine … I should be able to find the patient and bill him after looking at the physical prescription
even if no other desk has uploaded prescription on behalf of the doctor."* `findAtCounter` found the patient, but a
ticket opened only on an active e-prescription of today, so the desk said `no_prescription_today` and stopped.

DECIDED (standard Indian hospital pharmacy practice):

1. **The door.** When the desk finds a registered patient with no e-prescription today, the find answer carries the
   patient and the desk offers **Dispense from a paper prescription**. Finding the patient (UHID, name, phone, QR,
   token) is the start; there is no second entry to learn.
2. **The sheet** (one sheet, keyboard-first, `Ctrl ⏎` saves): the hospital doctor written on the paper (defaults to the
   visit's doctor), the date on the paper (today or earlier), the photo (REQUIRED when any line is Schedule H/H1,
   optional otherwise; filed on the patient's record as `consult_prescription` against the visit, so the desk's `S`
   sheet shows it at the slip cross-confirm), and the medicines off the OPD shelf (the same shelf search the counter
   uses, brand or salt) with the quantity in base units and optional dose / frequency / days for the label. Save
   issues the prescription, queues the ticket, claims it for this pharmacist and opens it.
3. **Model (a).** The paper becomes a REAL `opd_prescriptions` row on the patient's visit on that date, transcribed by
   the pharmacist (`transcribed_by`, the FD-31 column), prescriber of record the hospital doctor on the paper. Chosen
   over (b) because a dispense needs a prescription AND an encounter by FK, the medication order needs the encounter's
   `V` number and an ordering clinician, and nine readers (`verify`, `handover` → H1 register, `authorisations`,
   `antimicrobial` steward, `claim`, labels, returns) read the prescription: (a) leaves every one of them unchanged.
   No migration. OPD gains one narrow export, `issuePharmacyPaperPrescription`, the `"pharmacy_paper"` authority of
   `issuePrescription`: grant `pharmacy.dispense.place` asserted in the service; the visit's state is not asked (the
   doctor who writes on paper never moved it); a visit that already carries an active e-prescription is refused (this
   door never supersedes the doctor's own); no override is accepted.
4. **Safety.** Schedule X and NDPS narcotic/psychotropic lines are refused (`paper_rx_controlled`) — the two-key cabinet
   needs the doctor's e-prescription. H1 needs the photo (`prescription_required`) and the prescriber's registration
   number on the doctor master (`invalid_prescription`); the H1 register row is written at hand-over as for any ticket.
   Allergy, severe interaction, hard duplicate and severe drug-disease hits refuse (`allergy_block`, `interaction_block`,
   `duplicate_block`, `drug_disease_block`) because no prescriber is present to override. The slip cross-confirm
   (FD-31) still gates the bill.
5. **Audit.** `pharmacy.paper_rx.entered`: who typed it, the prescriber and registration number, the date on the paper,
   the photo's document id, the lines. `dispense.queued` carries `source: "paper"`.
6. **Permissions.** `pharmacy.dispense.place` only; no new permission.
7. **Not this door.** An OUTSIDE doctor's prescription is a walk-in sale (P19 R-1, `/pharmacy/retail`); the sheet links
   there. A registered patient with NO hospital visit on the paper's date is refused (`paper_rx_no_visit`) with the way
   forward: the front desk opens the visit. A pharmacy-only attendance (a visit with no consultation fee, the lab
   walk-in's pattern) is the follow-up if the owner wants the counter to open one itself.
