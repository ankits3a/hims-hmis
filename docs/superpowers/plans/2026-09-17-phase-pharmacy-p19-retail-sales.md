# Pharmacy P19 — walk-in retail sales (2026-09-17)

**Lane** `formulary` worktree, branch `lane/retail-sales`. Migration **0102**.

## 1. WHY

Doc 16 fix 19 and §3.1b: walk-in retail POS with Schedule-H gate, anonymous-or-linked customer, and
a GST invoice. Register row R-174 recommended a separate Form 20/21 retail licence and a separate
retail stock location. The owner (2026-09-17), on that row: *"start builinding without the license
later."*

This slice builds the sale. The shop stays shut until the licence is recorded (R-2).

## 2. DECISIONS

- **R-1. A walk-in sale is its own record, not a dispense.**
  - A dispense is a clinical act against an OPD prescription. Verify places a `medication` order
    under the visit's number with the prescriber as the ordering clinician.
  - A walk-in has no visit and no clinician in this hospital. Inventing either would write a false
    clinical record.
  - So `pharmacy_retail_sales` and `pharmacy_retail_sale_lines` hold the sale. It shares the ledger,
    the price rule (`min(tariff, MRP, ceiling)` per batch), the GST slab, billing, the register of
    pharmacists and the H1 register with the counter.
- **R-2. No sale without a current retail licence.**
  - Selling to the public without a Form 20/21 licence is an offence (Drugs and Cosmetics Act 1940
    §18(c)).
  - The licence is recorded against the retail store: the Form 20 and Form 21 numbers, valid from and
    to, and the pharmacist in charge named on it. It is recorded under `pharmacy.retail.manage`,
    held by the owner, the medical superintendent and the pharmacist in charge.
  - A sale refuses `retail_licence_missing` until a licence is recorded, and `retail_licence_lapsed`
    outside its dates.
  - A licence row is never edited. A renewal or a correction is a new row, and the latest row is
    the licence.
  - Census row `pharmacy_retail_licence` stays red until a licence is recorded and current.
- **R-3. Its own store: `PHARM-RETAIL`.**
  - `seed:pharmacy` creates it beside `PHARM-OPD`, with the same custodian roles.
  - It is stocked like the counter: a goods receipt posted into it, or a transfer from the main
    store (`POST /materials/transfers`; there is no transfer screen yet).
  - A walk-in sale never picks from the OPD counter's shelf (doc 16 I2, location isolation).
- **R-4. Every sale names a registered person. The anonymous option is not built.**
  - Billing requires every invoice to name a patient (ruling R5).
  - The cash limit (§269ST) is counted per person per day. One shared "walk-in customer" record
    would add up every stranger's cash, and the counter would be refused at ₹2 lakh by midday.
  - Standard Indian hospital pharmacies take a name and mobile number on every bill anyway.
  - The counter either finds the customer (by UHID or mobile) or registers them: name, sex, age, and
    mobile if they have one.
  - Registering asserts `patients.register` in the service, the OPD walk-in precedent.
    `pharmacy` gains `patients.register`; the aide does not, because the aide does not sell.
  - The near-match probe runs before registering and never attaches a person automatically
    (doc 16 A4).
- **R-5. The Schedule H gate (Drugs and Cosmetics Rules 1945, r.65(9)).**
  - Lines with no schedule or `OTC` sell without a prescription.
  - `H` and `H1` lines sell only on an outside prescription. The counter captures:
    - the prescriber's name, registration number and address;
    - the prescription's date, which may not be in the future;
    - a photo of the prescription.
  - The photo is filed on the customer's record as `outside_prescription`, in the sale's
    transaction, under the sale's own permission. It is the only document the sale writes, and only
    for its own customer.
  - Schedule X is refused (R-3 of the counter, until double custody).
  - A sale with any `H` or `H1` line needs `pharmacy.dispense.scheduled` and a current council
    registration, as at the counter (Pharmacy Act 1948 §42).
- **R-6. The H1 register.**
  - Rule 65(3) asks for "the name and address of the prescriber". The register gains
    `prescriber_address`. It stays null on counter rows, whose prescriber practises at the hospital.
  - The register row points at a dispense line or a retail line. Exactly one of the two is set,
    enforced by a CHECK.
- **R-7. Clinical checks.**
  - `runRxChecks` runs on what is sold, against the customer's recorded allergies and current
    medicines.
  - An allergy match or a severe interaction refuses the line (`allergy_block`,
    `interaction_block`). The pharmacist refers the customer to their prescriber.
  - There is no override at the retail counter: no prescriber in this hospital has decided anything
    here.
- **R-8. One act.**
  - A preview prices the cart and reports the gates. It writes nothing.
  - A sale then happens in one transaction:
    1. registers the customer, if new, and files the prescription photo;
    2. takes each line from one batch (FEFO, or a batch that was named or scanned), asking about
       expiry again at the act;
    3. posts the `consume` rows;
    4. issues the invoice with its receipt;
    5. writes the sale, its lines and any H1 rows;
    6. emits one `retail.sold` carrying every ledger id (no `material.consumed`; see §4).
  - The request carries an idempotency key.
  - The cash law, the PAN rule and the settlement rule are billing's own and are not repeated here.
- **R-9. One batch per line, as at the counter.** A quantity the first FEFO batch cannot cover is
  refused `short_stock`, with what is on offer. The cashier splits the line or names a batch.

## 3. NOT BUILT (this slice)

- **Returns and refunds of a retail sale.** They are P19b, on the counter's P6 rules.
- **The leakage triangle for `PHARM-RETAIL`.** It reads `PHARM-OPD` only. A retail `consume` is
  referenced `pharmacy_retail_sale`, so it will not be mistaken for a counter dispense when the
  report learns a second store.
- **Anonymous sales** (R-4).
- **Home delivery** (doc 16 O-10).

## 4. WHAT WAS BUILT

- **Schema (0102).** Three tables: `pharmacy_retail_licences`, `pharmacy_retail_sales` and
  `pharmacy_retail_sale_lines`. `pharmacy_reg_h1` gains `retail_line_id` and `prescriber_address`,
  under a CHECK that each row has exactly one source.
- **`retail.ts`.**
  - `retailLicenceState`, `recordRetailLicence` and `listRetailLicences`.
  - `searchRetailShelf`, which matches a typed name or code, or a scanned GS1 or EAN pack.
  - `previewRetailSale`, `sellRetail`, `getRetailSale` and `listRetailSales`.
- **Shared pricing.** The counter's per-batch pricing moved into `bill.ts` `priceBatchLine` /
  `winnerOf`, so the two counters price a strip one way.
- **Permissions.**
  - `pharmacy.retail.sell` goes to `pharmacy`, which also gains `patients.register`.
  - `pharmacy.retail.manage` goes to `pharmacy_incharge`, `owner` and `medical_superintendent`.
- **HTTP routes** under `/pharmacy/retail`: `state`, `shelf`, `preview`, `sales`, `sales/:id` and
  `licences`.
- **Census rows:** `pharmacy_retail_store_present` (G2, from the seed) and `pharmacy_retail_licence`
  (G3, red until an act).
- **Web screens:** `/pharmacy/retail` (the sale, the bill with batch and prescriber, today's list)
  and `/pharmacy/retail-licence`.
  - The H1 register screen prints an outside prescriber's address.
  - The counter's `allergy_block` and `interaction_block` sentences no longer say "the prescriber
    did not override". That was not true at the walk-in counter, where no prescriber here decides.
- **Not emitted: `material.consumed`.** Its schema requires an encounter, and its one consumer is
  the OT's case-implant consumer. A walk-in `consume` row carries `ref_type` `pharmacy_retail_sale`
  and the customer; `retail.sold` carries every ledger id.

## 5. MUTANTS (18, each with a written prediction; 18 killed, every count as predicted)

| # | mutant | predicted | result |
|---|---|---|---|
| R1 | a lapsed licence sells | 1, the licence test | 1 of 5 |
| R2 | a lapsed licence reads current | 2, retail and census | 2 of 32 |
| R3 | no prescription gate | 1, H1 | 1 of 5 |
| R4 | no registered-pharmacist gate | 1, H1 | 1 of 5 |
| R5 | registers without `patients.register` | 1 | 1 of 5 |
| R6 | no near-match probe | 1, OTC | 1 of 5 |
| R7 | no allergy check | 1, refusals | 1 of 5 |
| R8 | the retail store resolved to `PHARM-OPD` | 5 | 5 of 5 |
| R9 | Schedule X planned | 1, refusals | 1 of 5 |
| R10 | an expired named batch accepted | 1, refusals | 1 of 5 |
| R11 | no H1 row for a walk-in | 1, H1 | 1 of 5 |
| R12 | the prescriber's address not copied | 1, H1 | 1 of 5 |
| R13 | a future prescription date accepted | 1, H1 | 1 of 5 |
| R14 | the licence recorded under the sell permission | 5 | 5 of 5 |
| R15 | web: sell enabled without the prescription | 1 | 1 of 4 |
| R16 | web: the preview omits the chosen customer | 1 | 1 of 4 |
| R17 | the register reader calls every row `counter` | 1, H1 | 1 of 5 |
| R18 | the walk-in `consume` booked as a dispense | 1, OTC | 1 of 5 |

## 6. VERIFIED

- `pnpm typecheck`: 0 errors. `pnpm lint`: 0 errors (3 old warnings).
- Core: pharmacy module, `pharmacy.e2e`, `standup-check`, `seed-pharmacy`, `seed-roles` and
  `seed-staff`, the parity suites, kernel modules and events, `kernel/db/schema`, materials, and
  patients documents. All green; the counts are in the commit.
- Web: the full suite, 123 files and 1,093 tests.
