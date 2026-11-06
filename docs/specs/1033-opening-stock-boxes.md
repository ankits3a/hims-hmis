---
issue: 1033
status: approved
approved: 2026-11-06
---
# SPEC — Opening stock: count whole boxes as well as loose strips (#1033)
The pharmacist counts sealed boxes and loose strips on the shelf. The opening-stock sheet (CSV and the on-screen grid at Stock → Opening stock sheet) asks only for `pack_size` (tablets per strip) and `packs` (strips). Add two optional columns so the sheet does the multiplication.

- `boxes`: whole boxes on the shelf. `packs_per_box`: strips (or bottles, tubes) in one box. `packs` now means the loose ones.
- Total packs = boxes × packs_per_box + packs. Tablets = total packs × pack_size. That total goes on one GRN line, exactly as a `packs` value would today.
- MRP, purchase rate and free goods stay per pack (strip), as printed on the strip. DECIDED.
- No new "box" unit is added to the item register, and no migration. The columns are input only. DECIDED.
- Both shapes of input (CSV and grid) go through the same planner (`planOpeningRows`); the grid shows the total live before submit.

## Done means
- D1: A CSV row with boxes 3, packs_per_box 10, packs 4, pack_size 15 captures one GRN line of 34 strips = 510 tablets.
- D2: A row with boxes but no packs_per_box (or packs_per_box 0) refuses the file, naming the line and the column.
- D3: A sheet without the two new columns captures exactly what it captures today.
- D4: A row with boxes 2 and packs_per_box 10 but `packs` blank is accepted (20 strips). A row with no boxes and no packs is refused as today.
- D5: The on-screen grid has Boxes and Per box inputs, and each row shows "= N strips · M tablets" before submit.
- D6: The CSV template and the runbook list both columns with one example row.
