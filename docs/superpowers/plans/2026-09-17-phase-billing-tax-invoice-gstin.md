# The tax invoice names its supplier: the trust's GSTIN (2026-09-17)

**Lane** `formulary` worktree, branch `lane/tax-invoice-gstin` (from main). No migration.

## 1. WHY

The owner (2026-09-17): *"Giving you GST details of the hospital. This hospital is under a trust …
GST No: 10AAATL6484H1ZP, LEELAWATI DEVI EDUCATIONAL TRUST."*

Measured before building:
- The GSTIN is valid: the check character matches, PAN `AAATL6484H` is a trust PAN (fourth
  character `T`), and state `10` is Bihar, matching the letterhead's Hajipur address.
- **No printed bill carried a supplier GSTIN.** `gst_settings` holds two flags. Production's
  letterhead holds only the name and address lines.
- The printed invoice had no document title and did not print a buyer's GSTIN, although the invoice
  row stores one.

CGST Rules r.46 requires the supplier's name, address and GSTIN, the recipient's GSTIN when
registered, and a signature. The pharmacy bills GST on every strip it sells.

## 2. DECISIONS

- **T-1. The registered person lives on the ONE letterhead** (`opd_config.letterhead`) as two
  optional fields, `legalName` and `gstin`.
  - A GSTIN that is present is validated (shape, state code, check character) by
    `@hmis/contracts` `isValidGstin`.
  - A letterhead written before these fields still loads.
- **T-2. The title follows the lines:**
  - all exempt (a consultation) is a *Bill of Supply* (r.49);
  - all taxable (medicine) is a *Tax Invoice*;
  - a mix is an *Invoice-cum-Bill of Supply* (r.46A).
- **T-3. What the print carries.**
  - The supplier: "A unit of <legal name>", the GSTIN, and the state, which the server derives from
    the GSTIN (the web does not import contracts at run time).
  - The buyer's GSTIN when the invoice has one.
  - "For <legal name> — Authorised signatory".
- **T-4. Setting it in production is one command, the owner's:**
  `set-establishment-gst --gstin … --legal-name … --as admin`, dry run first. `admin` holds
  `opd_admin`, which holds `opd.config.manage` (measured read-only on production).
- **T-5. Census row `supplier_gstin_on_invoice` (G3, hospital)** is red until the letterhead
  carries both. It is red after every deploy seed, because `seed:opd` writes the letterhead without
  them.

## 3. NOT BUILT

- **A screen for the letterhead.** It is still edited only through `PUT /opd/config` and this
  script.
- **Inter-state place of supply and IGST.** Phase-1 exclusion; the hospital supplies within Bihar.
- **E-invoicing (IRP).** Corporate phase.

## 4. MUTANTS (5, each predicted; 5 killed)

- **T1:** the census row is always green.
- **T2:** the letterhead accepts any GSTIN.
- **T3:** the title rule is inverted.
- **T4:** the supplier state is not sent.
- **T5:** the checksum weights are swapped.
