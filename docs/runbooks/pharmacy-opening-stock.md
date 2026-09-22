# Pharmacy opening stock — counting the real shelf in

Owner ruling 2026-09-22: the counter first runs on TRIAL stock so a real ticket can be walked end to end.
Then the pharmacist counts the real shelf onto one sheet, the trial stock is wiped, and the sheet is received.

## 1. The sheet

Start from `docs/runbooks/pharmacy-opening-stock-template.csv` (open it in Excel or LibreOffice and save it
as CSV again). One row per **brand + batch** on the shelf:

| column | what to write | example |
|---|---|---|
| `brand` | the name on the strip, with its strength, or the item code from /pharmacy/items | `Zeptol 200` |
| `batch` | the batch number as printed | `ZT24031` |
| `expiry` | month/year as printed | `08/2027` |
| `mrp_per_pack` | rupees, as printed on the pack | `42.00` |
| `pack_size` | tablets in the strip; `1` for a bottle, tube or inhaler | `10` |
| `packs` | whole packs you counted | `12` |
| `rack` | where it sits (replaces the suggested rack) | `B2` |
| `supplier_name` | optional — an active vendor's name or code; blank means "OPENING STOCK" | |
| `purchase_rate_per_pack` | optional — what the hospital paid per pack; blank is valued at 0 | `30.00` |

Rules the script enforces, so you learn them from the sheet and not at the counter:

- **The brand must already be on the shelf** (loaded from the starter list). A name it cannot place is
  refused with the three nearest names; a name that fits two items (e.g. `Allercet` — 10 mg tablet and
  5 mg/5 mL syrup) is refused until you add the strength.
- **Expired stock is not received.** Segregate it. Stock expiring within six months is received on its own
  GRN and waits for the materials head to accept it in **/approvals**; run the script again after that.
- **MRP must divide into whole paise per tablet.** ₹42.00 on a strip of 10 is fine; ₹35.50 on a strip of 15
  is not (₹2.3666…), and the stock gate refuses it. Such rows are refused by name — bring them to the
  pharmacist in charge.
- **A strip size the item does not have yet** (the starter list assumed 10) is added as a new pack unit, which
  needs a materials head on the command (`--head`).
- Two rows with the same brand and batch are refused — add the packs together.

## 2. Order of the day

```
# 0. who: a storekeeper, a registered pharmacist, a materials head — real accounts, made at /admin/users
# run with DATABASE_URL pointing at the database being stood up

# 1. take the trial stock off (dry run first, then --apply)
pnpm --filter @hmis/core exec tsx scripts/wipe-trial-stock.ts --as <materials_head>
pnpm --filter @hmis/core exec tsx scripts/wipe-trial-stock.ts --as <materials_head> --apply

# 2. receive the sheet (dry run until it says REFUSE 0, then --apply)
pnpm --filter @hmis/core exec tsx scripts/import-opening-stock.ts --file opening-stock.csv \
     --as <storekeeper> --qc <pharmacist> --head <materials_head>
pnpm --filter @hmis/core exec tsx scripts/import-opening-stock.ts --file opening-stock.csv \
     --as <storekeeper> --qc <pharmacist> --head <materials_head> --apply

# 3. after the materials head accepts any near-expiry GRN in /approvals, run step 2 again with --apply
# 4. check: pharmacy_batch_in_stock should read ok
pnpm --filter @hmis/core standup:check pharmacy
```

The whole sheet is received in one transaction or not at all, and the same file run twice receives nothing
the second time (its challan is `OPENING/<file hash>`). Every line goes through the real GRN gate:
the storekeeper captures, the pharmacist signs QC and posts.

## 3. What each script is

| script | writes |
|---|---|
| `set-schedule-flags.ts` | Schedule X / H1 / H on every formulary medicine, from the Drugs Rules 1945 lists and NRCeS |
| `build-pharmacy-starter-list.ts` | nothing — writes `scripts/data/pharmacy-starter-list.csv` for review |
| `load-pharmacy-shelf.ts` | the drug items, their sale registrations and suggested racks |
| `load-trial-stock.ts` | vendor `TRIAL-STOCK`, GRNs `TRIAL/…`, batches `TRIAL-…` (needs `--i-understand-trial`) |
| `wipe-trial-stock.ts` | a write-off movement per trial batch (`ref_type trial_stock_removed`), vendor suspended |
| `import-opening-stock.ts` | this sheet, through capture → QC → post |
