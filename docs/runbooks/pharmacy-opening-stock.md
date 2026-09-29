# Pharmacy opening stock — counting the real shelf in

Owner ruling 2026-09-22: the counter first runs on TRIAL stock so a real ticket can be walked end to end.
Then the pharmacist counts the real shelf onto one sheet, the trial stock is wiped, and the sheet is received.

## 1. On screen — start here

**Pharmacy office → Stock → Opening stock sheet** (`/pharmacy/office?view=stock&page=opening`, 2026-09-29).
Whoever captures deliveries (`materials.grn.capture`) types the shelf in, one row per **brand + batch**:

| cell | what to type | example |
|---|---|---|
| Brand | start typing and pick from the list — it shows strength, form and pack from the item master | `dolo` → Dolo 650 tablet |
| Pack | tablet strip, capsule strip, bottle, vial, ampoule, tube, pouch, sachet, box, other | Tablet strip |
| Per pack | units in one pack — 15 tablets in a strip, `1` for a bottle | `15` |
| Batch | as printed | `DOBS4521` |
| Expiry | month/year as printed | `08/27` |
| Packs | whole packs counted | `12` |
| Free | optional — packs the supplier gave free; received as a free-goods line at cost ₹0 | `1` |
| MRP ₹/pack | as printed on the pack | `33.60` |
| Rate ₹/pack | optional — what the hospital paid per pack; blank is valued at ₹0 | `24.00` |
| Disc % | optional — trade discount; lowers the **cost** only | `10` |
| Rack | where it sits | `A1` |
| Supplier | optional — an active supplier; blank means OPENING STOCK | |

- **Enter or Tab** moves to the next cell; a new row is always waiting at the end. The rows are kept in this
  browser as a draft until they are captured, so a reload loses nothing.
- Each row shows **cost per unit** (rate × (1 − disc/100) ÷ pack, rounded down to the paisa) and the
  **margin against MRP** as you type. GST shows from the item; change it with the row's **Edit item**.
- A second after you stop typing, every row is judged by the **server** — the same rules as the CSV (§2) —
  and a row that will be refused says why, in red, under it. **Capture as GRNs** stays off until no row is
  refused.
- **Capture books goods receipts (GRNs). Nothing is on the shelf yet.** A second person — the pharmacist —
  logs in, opens each GRN in **Stock → Goods receipt (GRN)** (the link on the screen), runs QC and posts it.
  Only then can the counter sell it. The owner entering stock and checking it needs two logins.
- **The sale price is the MRP.** A full strip bills at the printed MRP; a loose tablet at its share, rounded
  down. There is no sale price and no counter discount on this screen (an open money ruling).

**A brand that is not in the list.** The list's last choice is **+ New drug** (also a button at the top), for a
holder of `materials.items.manage`. It asks for brand and strength, the **generic** (searched in the formulary —
OPD, emergency and IPD prescribe from it, and this link is how a prescription reaches the brand), form, pack type
and size, HSN (3004), GST (5%; Nil for the 36 life-saving drugs and contraceptives; 18% only for a non-medicine
under HSN 2106 — there is no 12% slab for medicines since 22 Sep 2025), schedule (defaults to the formulary's),
MRP per pack and storage (room / 2–8 °C). **Add the drug** creates the item with its pack, sets its MRP and puts
it on sale at the counter in one step, then drops it into the row. It also needs `pharmacy.sale_items.manage`,
and changing a schedule needs `formulary.manage`; without them it says which and writes nothing.

A drug in the item master that the counter does not sell yet shows "not sold at the counter yet"; picking it puts
it on sale (`pharmacy.sale_items.manage`).

## 2. The rules every row is judged by (screen and sheet alike)

- **The brand must be sold at the counter.** On screen you pick it; in a sheet a name it cannot place is
  refused with the three nearest names, and a name that fits two items (e.g. `Cetzine` — 10 mg tablet and
  5 mg/5 mL syrup) is refused until you add the strength.
- **Expired stock is not received.** Segregate it. Stock expiring within six months is received on its own
  GRN and waits for the materials head to accept it in **/approvals**.
- **An MRP that does not divide into whole paise is received** (owner ruling 2026-09-22). ₹35.50 on a strip
  of 15 is fine: a full strip bills ₹35.50, a loose tablet ₹2.36.
- **Cost after discount above MRP is refused** — the GRN gate would refuse it too.
- **A pack size the item does not have yet** (the starter list assumed 10) is added as a new pack unit
  (`strip15`, `box10`), which needs `materials.items.manage`. So does creating the OPENING STOCK supplier
  (`materials.vendors.manage`). The screen says so before anything is written.
- Rack labels are set only when the person capturing holds `pharmacy.sale_items.manage`.
- Two rows with the same brand and batch are refused — add the packs together.
- All or nothing, and once: one refused row stops the capture, and the same rows captured twice capture
  nothing the second time (challan `OPENING/<hash>`).

## 2a. Upload a sheet instead (CSV)

Under the grid, **Upload a sheet (CSV) instead**. Start from `docs/runbooks/pharmacy-opening-stock-template.csv`
(open it in Excel or LibreOffice and save it as CSV again). Columns: `brand`, `batch`, `expiry`,
`mrp_per_pack`, `pack_size`, `packs`, `rack`, `supplier_name`, `purchase_rate_per_pack`, and optionally
`pack_type`, `free_packs`, `trade_discount_pct` — the same cells as the grid. **Check** judges every row by §2
and writes nothing; **Capture as GRNs** books one GRN per supplier for the pharmacist's QC, exactly as the grid.

## 3. From the command line (order of the day)

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

## 4. What each script is

| script | writes |
|---|---|
| `set-schedule-flags.ts` | Schedule X / H1 / H on every formulary medicine, from the Drugs Rules 1945 lists and NRCeS |
| `build-pharmacy-starter-list.ts` | nothing — writes `scripts/data/pharmacy-starter-list.csv` for review |
| `load-pharmacy-shelf.ts` | the drug items, their sale registrations and suggested racks |
| `load-trial-stock.ts` | vendor `TRIAL-STOCK`, GRNs `TRIAL/…`, batches `TRIAL-…` (needs `--i-understand-trial`) |
| `wipe-trial-stock.ts` | a write-off movement per trial batch (`ref_type trial_stock_removed`), vendor suspended |
| `import-opening-stock.ts` | this sheet, through capture → QC → post |
