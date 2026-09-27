# Synthetic laboratory data set (Plan 17-F · S)

**Everything in this folder is invented.** It exists so the Central Lab can be stood up and rehearsed on a
non-production database while the owner's real inputs are owed (roadmap owner list: the catalogue
spreadsheet, the pathologist of record, four role holders, the analyser inventory). It must never reach
production. The scripts that read it refuse the production port and require `HMIS_SYNTHETIC_DATA_OK=1`.

| File | What it is | Loaded by |
|---|---|---|
| `analytes.csv`, `orderables.csv`, `ranges.csv` | 40 common Indian hospital-lab tests the 64-test golden book (`test/fixtures/lab-catalogue.json`) lacks: hormones, fertility, tumour markers, thalassaemia and G6PD, Coombs, GTT, 24-hour urine protein, hepatitis and monsoon-fever serology, arthritis markers, 4 profiles. Plus text bands for 13 golden analytes that had none (urine and stool microscopy, smear), without which `lab_range_sources_present` can never pass. Every band's source starts `SYNTHETIC`. In the owner's own template format (`docs/runbooks/lab-catalogue-template.md`) | `import:lab-catalogue`, which is the owner's runbook path, rehearsed |
| `prices.csv` | Synthetic prices in paise for all 104 orderables, at typical Indian corporate-hospital levels. Not benchmarked, not CA-signed | `scripts/dev-lab-standup.ts` (tariff ceremony) |
| `staff.json` | 11 synthetic staff (owner, medical superintendent, a second administrator, 2 pathologists, reception + cashier, phlebotomist, 2 technicians, billing manager, the AU480 bridge service account). **No passwords**: `tools/lab-synthetic.sh` generates them into `~/.hmis-synthetic/<db>.credentials` (mode 600) and pipes them to `seed:staff` | `seed:staff`, `seed:admin` |
| `instruments.json` | 11 analysers: the lab-stations board's inventory plus the Curio Lab Gen 1, with models invented where unknown, and each one's analyte codes | `scripts/seed-lab-synthetic.ts` |

The pathologist of record is **Dr Meera Iyer**, registration `UPMC-45219` (synthetic, from
`dev-lab-standup.ts`).

Run it, on the dev instance only:

```
tools/lab-synthetic.sh            # database hmis_lab_synth on :5433; re-runnable
```

A changed data set needs a fresh database (`drop database …`, then run again). The catalogue loader
deliberately refuses the same file twice, and reference bands do not overlap.
