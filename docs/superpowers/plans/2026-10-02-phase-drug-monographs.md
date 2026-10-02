# Phase: drug monographs — where the Drug Information Service specification lives

**Date:** 2026-10-02. **Source:** the owner's "Advanced Drug Information Service & Clinical Knowledge
Architecture" specification, v1.25 (example drug: Herpex 800 DT). **Owner instruction:** check whether the
database holds what the specification lists, then "do the needful".

## What the specification asks for, and where each part now lives

| Specification part | Where it lives | State |
|---|---|---|
| Identity: SNOMED CT ids, hospital code, brand, generic, ATC, class | `formulary_generics`, `formulary_substances`, `formulary_medicines`, `formulary_salts` | held before this phase |
| Regulatory: schedule, high alert, LASA flag | `formulary_medicines.schedule_flag`, `items.high_alert`, `items.lasa` | held before this phase |
| Manufacturer and marketer as two names | `items.manufacturer`, `items.marketed_by` | #443 |
| Manufacturing licence, pharmacopoeia, LASA warning text, storage ceiling in °C | `items.mfg_licence_no`, `pharmacopoeia`, `lasa_note`, `storage_max_c` | #444 |
| Stock, batches, expiry, cost, MRP, rack, pack sizes, reorder levels | `stock_batches`, `stock_balances`, `item_uoms`, `item_stock_levels`, `pharmacy_shelf_locations` | held before this phase |
| Interactions, drug–disease, allergy classes | `formulary_interactions`, `formulary_drug_disease`, `formulary_salts.allergy_classes` | held before this phase |
| Patient text: summary, bilingual FAQs, warnings, side-effect triage | `formulary_monographs.patient` | this phase |
| Prescriber text: indications with ICD-10, hepatic adjustment, Beers, monitoring, pearls | `formulary_monographs.prescriber` | this phase |
| Renal dose bands | `formulary_renal_doses` (rows) | this phase |
| Nursing text: tube administration, contrast and perioperative holds, dialysis, overdose | `formulary_monographs.nursing` | this phase |
| Jan Aushadhi benchmark | `formulary_monographs.affordability` | this phase |

## Decisions

- **DECIDED — relational stays for stock and money.** The specification's section 4 offers one JSON document
  per drug. Stock, batches and prices stay as rows under the ledger's locks; the specification's
  `pharmacy_inventory_pos` object is a view of them, not a second copy.
- **DECIDED — prose is JSON, one row per generic.** The four tellings are text that changes as a document.
  Each is one `jsonb` section, kept as the specification wrote it, capped at 64 KB.
- **DECIDED — renal bands are rows.** A check will compute on them. A band is `[crcl_min, crcl_max)` in
  mL/min; bands of one monograph never overlap.
- **DECIDED — nothing reads a draft.** Every save writes a draft. A second person reviews it
  (`monograph_same_actor` refuses the writer). An edit after review is a draft again. This is the answer to
  the September clinical master, whose columns were filled by drug class and held dangerous text (plan P21).
- **DECIDED — no new permission.** Saving and reviewing both need `formulary.manage`; the two-person rule is
  what separates them. Reading the reviewed text needs `formulary.read`.
- **DECIDED — keyed by the generic's SNOMED CT id,** the specification's own key (`med_master_<sctid>`).

## Built

- Migration `0170_formulary_monographs.sql`: `formulary_monographs`, `formulary_renal_doses`.
- `modules/formulary/monographs.ts`: `saveMonograph`, `reviewMonograph`, `getMonograph`, `renalDoseFor`.
- Endpoints: `GET /formulary/monographs/:sctid` (reviewed only), `GET /formulary/monographs/:sctid/draft`,
  `POST /formulary/monographs`, `POST /formulary/monographs/:id/review`.
- Events: `monograph.saved`, `monograph.reviewed`.

## Not built — the next steps, in order

1. **A screen to write and review a monograph.** Today the only door is the API.
2. **Readers.** Nothing consumes a reviewed monograph yet: the counter's counselling slip, the patient
   copilot, the doctor's renal check (`renalDoseFor` against the latest eGFR) and the ward. Each reader is its
   own piece of work; the renal check is clinical decision support and needs its own acceptance cases.
3. **Content.** No monograph is loaded. The specification carries one drug. Who writes and who reviews the
   rest is the owner's call; bulk-loading unreviewed text is exactly what the gate exists to stop.
4. **Not stored, by choice:** artwork code, a per-item "allow loose tablets" flag, a per-batch selling price.
   None has a reader. Add each with the feature that reads it.
