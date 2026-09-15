# Lab catalogue import — the three sheets, and what each column means

**This is the template `import:lab-catalogue` reads.** Fill in what you have; send what you filled in.
The loader **never invents a value**, so a column you leave blank stays blank in the system rather
than being given a sensible-looking default.

```
pnpm --filter @hmis/core import:lab-catalogue \
  --analytes analytes.csv --orderables orderables.csv --ranges ranges.csv \
  --actor "Dr A. Sharma"
```

**Without `--apply` it writes nothing** and prints what it would do, row by row. Read that first. Add
`--apply` only when the plan says what you expect.

---

## Before anything else: five things that will save you a round trip

1. **Any subset of the three files.** Sending only a corrected range book is normal — you do not have
   to re-send the test list to fix a band.
2. **A column name the loader does not recognise refuses the whole file**, and names the column. This
   is deliberate: a sheet with `critical_lo` where the loader wants `critical_low` would otherwise
   import every row with the critical band silently missing, and report success.
3. **One bad row refuses the entire import.** Nothing is written. You cannot end up with half a
   catalogue and no way to tell which half.
4. **Blank is blank.** Not zero, not a default. On an update, a column your file does not mention is
   left exactly as it is rather than being blanked.
5. **Commas are fine inside a cell if you quote it** — `"Tietz, 6th ed."` arrives intact. Excel does
   this for you when you save as CSV.

---

## Sheet 1 — `analytes.csv`: the things that are measured

One row per measured quantity. Haemoglobin is an analyte; "CBC" is not.

```
code,name_en,name_hi,result_type,unit,decimals,loinc_code,absurd_low,absurd_high,critical_low,critical_high
```

| column | required | what it is |
|---|---|---|
| `code` | **yes** | your short code, unique — `HB`, `GLU-F` |
| `name_en` | **yes** | as it prints on the report |
| `name_hi` | no | the Hindi name, if you have one |
| `result_type` | **yes** | `numeric`, `text` or `coded` |
| `unit` | no | `g/dL`, `mg/dL` — blank for a text result |
| `decimals` | no | how many decimal places print |
| `loinc_code` | no | if your reference lab uses LOINC |
| `absurd_low` / `absurd_high` | no | **outside this, the value is refused as a typo, not flagged.** A haemoglobin of 145 is a mis-key for 14.5 |
| `critical_low` / `critical_high` | no | outside this, somebody is telephoned |

> **`formula` analytes are not importable and are refused by name.** A calculated quantity (an A:G
> ratio, an LDL by Friedewald) is an expression over other analytes, and it is set up in the system
> rather than in a spreadsheet cell.

---

## Sheet 2 — `orderables.csv`: the things that are ordered

One row per test a doctor can order. "CBC" is an orderable; it expands into the analytes it reports.

```
code,name_en,name_hi,discipline,specimen_type,container,min_volume_ml,bench_key,tat_minutes_routine,tat_minutes_stat,requires_fasting,consent_required,sensitive,notifiable,analyte_codes,price_paise
```

| column | required | what it is |
|---|---|---|
| `code` | **yes** | your test code, unique |
| `name_en` | **yes** | as it prints |
| `discipline` | **yes** | `biochemistry`, `haematology`, `microbiology`, … |
| `specimen_type` | **yes** | `serum`, `plasma`, `whole_blood`, `urine`, … |
| `container` | **yes** | the tube — `sst`, `edta`, `citrate`, `fluoride`, … |
| `min_volume_ml` | no | the least the bench will accept |
| `bench_key` | no | which bench runs it |
| `tat_minutes_routine` | **yes** | promised turnaround. **This is the SLA the system measures against** |
| `tat_minutes_stat` | no | the urgent promise, if different |
| `requires_fasting` | no | `true` / `false` |
| `consent_required` | no | `true` / `false` |
| `sensitive` | no | `true` / `false` — restricts who may read the result |
| `notifiable` | no | `true` / `false` — a notifiable disease |
| `analyte_codes` | **yes** | the analytes it reports, **separated by `;`**, in the order they print |
| `price_paise` | no | **read and never written — see below** |

### The price column

**Fill it in if you like; nothing is written from it.** Every run says so out loud, with a count.

A price that entered the system from a spreadsheet would look exactly like a price a chartered
accountant had signed, and there is no way to tell them apart afterwards. Lab prices go in through the
tariff, with sign-off. The column exists so that your sheet stays the one document, and so the loader
can tell you it saw a price and deliberately did not use it.

---

## Sheet 3 — `ranges.csv`: the reference and critical bands

One row per band. A test with different bands for men, women and children has one row each.

```
analyte_code,sex,age_min_days,age_max_days,low,high,text,critical_low,critical_high,source,effective_from
```

| column | required | what it is |
|---|---|---|
| `analyte_code` | **yes** | must match a `code` from sheet 1 |
| `sex` | **yes** | `male`, `female`, `other`, or `any` |
| `age_min_days` / `age_max_days` | **yes** | the band's age window **in days** — `0` to `36500` is "any age"; a neonate band might be `0` to `28` |
| `low` / `high` | one of these or `text` | the numeric band |
| `text` | one of these or `low`/`high` | for a non-numeric answer — `Negative` |
| `critical_low` / `critical_high` | no | the telephone band, if it differs by age or sex |
| `source` | **yes** | **see below** |
| `effective_from` | **yes** | `YYYY-MM-DD` — when this band starts applying |

### Why `source` is required

**A reference range without a source is a clinical assertion nobody can attribute.** When a
pathologist asks six months from now why the system called a result low, `Tietz, 6th ed.` or
`Roche kit insert 2026-02` or `local study, 300 healthy donors` is the answer; a blank is not.

The loader refuses a blank source **before writing anything**, so you find out from the plan rather
than halfway through a load.

### Bands must not overlap

Two rows covering the same sex and the same age window make "which range applies" depend on the order
the system happened to read them. The loader refuses the second one and names the first.

---

## What the plan looks like

```
REFUSE ranges line 14 [GLU/any/0-36500] — source_required
REFUSE orderables line 7 [LIPID] — unknown_analyte_codes:CHOL-T
plan: 126 create, 4 update, 2 refuse (0 file-level)
price_paise: 64 row(s) carry a price and NONE WAS WRITTEN — DEV PLACEHOLDER, CA sign-off required
DRY RUN — nothing was written. Re-run with --apply to write it.
```

Fix the named rows, re-run the dry run until it refuses nothing, then add `--apply`.

## What is recorded

Each applied import is recorded: the file names, a hash of their contents, how many analytes,
orderables and ranges were written, **who ran it** (`--actor`) and when. Re-sending the identical
files is recognised as the same import rather than counted twice.
