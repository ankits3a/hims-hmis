# Pharmacy stage D — medication safety (D1–D5)

Lane `pharmacy-safety`. This is the detail for stage D of `2026-09-28-pharmacy-gap-closure.md`; the phase doc
and its order belong to lane `pharmacy-gaps`. D6 (ward returns) waits for the IPD brainstorm.

## Why

On 2026-09-28 the owner asked for a second review of the pharmacy against Healthray and against "a complete hospital
HIMS". Healthray covers none of these five items either. All five are NABH medication-management (MOM) expectations,
and each is ABSENT on `main` @ 63fd0e67. The grep evidence is in the hand-off to `pharmacy-gaps` and in memory
`pharmacy-healthray-parity-plan`.

The five items:
- **D1** — adverse drug reaction (ADR) reporting.
- **D2** — medication error and near-miss log.
- **D3** — fridge temperature log with excursion hold.
- **D4** — crash-cart and emergency-tray checks.
- **D5** — Reserve/restricted antimicrobial approval gate.

## Owner rulings that bound this stage (2026-09-28)

- The eight other departments (IPD, ER, TPA, blood bank, dialysis, immunisation, ambulance, mortuary) get their own
  brainstorms. Nothing here builds a table or screen for them.
- No patient GSTIN on the bill. No old MRP beside the new MRP. No home delivery.

## Shared rules for all five

- **One PR and one migration per item.** Each migration is numbered at rebase time (0141 is free today).
- **Registers are append-only.** A trigger refuses UPDATE and DELETE, as for `pharmacy_reg_h1` (0056) and
  `controlled_stock_register` (0135).
  - A state change (reviewed, reported, closed) is a new row in a `_events` table, never an edit.
  - Where a status column is unavoidable, it is updated only by the service. The trigger allows only that column to
    change.
- **Needs rows.** Each item adds a side to `modules/pharmacy/office-needs.ts`, following its own pattern:
  - the side is read with that side's route permission;
  - the side is dropped on `permission_denied`;
  - it returns a kind plus data;
  - the copy lives in web i18n under `pharmacyOffice.today`.
- **Screens.** Each screen is a self-contained component on its own route first. It is wired into the office header
  menu (**Law**: D1, D2; **Stock**: D3, D4) after B3 merges.
- **Permissions and roles.** Each new permission goes into `pharmacy/manifest.ts` and `scripts/seed-roles.ts`, with
  the pinned counts in `test/seed-roles.test.ts` and the README role tables updated in the same PR.
- **Tests first.** Every gate gets a test that fails on `main` first.
- **Copilot.** The agent may DRAFT (e.g. pre-fill an ADR from the consult note). A person records every row. Nothing
  posts without a person.

## D1 — adverse drug reaction (ADR) reporting

**Basis:**
- PvPI (IPC Ghaziabad, MoHFW) Suspected ADR Reporting Form.
- NABH MOM: ADEs are monitored and reported.
- Causality uses the WHO-UMC scale.

**Model:** `pharmacy_adr_reports`, append-only. Fields:
- patient;
- suspected medicines, each with salt, item, batch, dose, route, start and stop dates, and an optional dispense ref;
- concomitant medicines;
- reaction text and onset date;
- seriousness (death / life-threatening / hospitalisation / disability / congenital anomaly / other medically
  important / not serious);
- outcome (recovered / recovering / not recovered / fatal / unknown);
- dechallenge and rechallenge;
- reporter.

`pharmacy_adr_events` records each later act:
- `causality_assessed`, with the WHO-UMC grade;
- `sent_to_pvpi`, with date, channel (AMC / ADR PvPI app / email) and PvPI reference;
- `closed`.

**The loop that has to close:** recording an ADR calls `addAllergy(tx, …, { source: "pharmacy", saltId, severity })`
in the SAME tx. This is the radiology contrast-reaction pattern (`radiology/reactions.ts:202`). The next prescription
and the next dispense then refuse the drug through the existing allergy book. `addAllergy`'s `source` union gains
`"pharmacy"`; the HTTP route stays closed to it.

**Print:** the PvPI form is filled from the row through `kernel/printing`. Submission is manual; PvPI has no API.

**Permissions:**
- `pharmacy.adr.record`: pharmacy, pharmacy_incharge, doctor.
- `pharmacy.adr.manage` (causality, sent, close): pharmacy_incharge, medical_superintendent.

**Needs row (LAW):** an ADR not yet sent to PvPI. It turns red when it is serious and older than 15 days.

**Desk entry:** "Report a reaction" on the patient in hand.

## D2 — medication error and near miss

**Basis:**
- NABH MOM: medication errors, near misses and ADEs are captured and analysed.
- NCC MERP index A–I.
- The error rate is an NABH quality indicator.

**Model:** `pharmacy_medication_incidents`, append-only. Fields:
- kind (`near_miss` = category A–B; `error` = C–I);
- stage (prescribing / transcribing / dispensing / administration / monitoring);
- type (wrong drug / strength / dose / quantity / patient / route / expired / LASA mix-up / omission / other);
- NCC MERP category;
- optional patient, dispense line and item;
- contributing factors (LASA, look-alike packaging, illegible Rx, workload, interruption, other);
- what happened;
- reporter.

`pharmacy_medication_incident_events` records `reviewed` (root cause, action taken) and `closed`.

**Blame-free:** the reporter's name is stored for the audit trail. It is shown only to holders of `.review`.
Reports and exports show the role, never the name.

**Indicator:** errors per 1,000 dispensed lines per month, and near misses per month, on the office Reports page.

**Permissions:**
- `pharmacy.incidents.record`: pharmacy, pharmacy_assistant, pharmacy_incharge, doctor.
- `pharmacy.incidents.review`: pharmacy_incharge, medical_superintendent.

**Needs row (LAW):** an unreviewed incident. It is red at category E or above and older than 24 h.

**Desk entry:** "Record a near miss" in the desk line's ⋯ menu (`pharmacy-desk/lines.tsx`), pre-filled with the line.

## D3 — fridge temperature log and excursion hold

**Basis:**
- Drugs & Cosmetics Rules 1945: store as the label directs.
- NABH MOM storage: the cold chain is monitored and documented.

**Model:**
- `pharmacy_cold_units` (store resource, label, low 2 °C, high 8 °C, active). It is module-owned, not a new resource
  kind, so the kernel CHECK is untouched.
- `pharmacy_cold_readings`, append-only: current, min and max since the last reset (min/max thermometer), taken at,
  by, note.
- `pharmacy_cold_excursions`: opened automatically when any of current/min/max is out of range, then closed by a
  decision.

**DECIDED schedule:** readings at 09:00 and 17:00 IST. A reading more than 60 min late is a "missed" needs row. The
schedule is computed when the needs list is read, so no worker job is needed.

**Excursion hold:** while an excursion is open on a unit, `handOverDispense` (beside the controlled gates at
`handover.ts:95`) refuses lines whose item has `storage_class = cold_2_8` in that unit's store. The error is
`cold_chain_excursion_open`, and the message names the unit and whom to call.

Closing an excursion needs `pharmacy.coldchain.manage`. The closer records a decision per affected batch:
- **release** — within the product's stability data, with the reason recorded;
- **write-off** — through the existing MWO path.

**Permissions:**
- `pharmacy.coldchain.record`: pharmacy, pharmacy_assistant, storekeeper.
- `pharmacy.coldchain.manage`: pharmacy_incharge, materials_head.

**Needs row (STOCK):**
- a missed reading (amber);
- an open excursion (red, tier 0).

## D4 — crash-cart and emergency-tray checks

**Basis:** NABH MOM: emergency medications are available, standardised, checked and replenished promptly after use.

**Scope:** OPD, radiology, OT and day-care trays. ER and ward carts use the same model later, from their own
brainstorms.

**Model:**
- **A tray is a store:** a `resources` row of kind `store`, a child of `PHARM-OPD`, with `attributes.tray = true`.
  Stock in it is real stock, so FEFO, expiry and the ledger already work.
- `pharmacy_tray_templates` holds the fixed list of item and par quantity per tray. `pharmacy.trays.manage` edits it.
- `pharmacy_tray_checks`, append-only:
  - kind (`daily_seal` / `monthly_full` / `after_use`);
  - seal number seen, and new seal number;
  - per-line quantity present and earliest expiry for full checks;
  - result (`ok` / `deficient`), by, at.
- `after_use` records the optional patient and the items used. Used stock leaves the tray as consumption.
- **Restock:** a deficient check offers one act that issues the deficit from `PHARM-OPD` to the tray through
  `materials/transfers.issueStock`. The tray custodian receives it.

**DECIDED frequency:**
- a daily seal check (the seal number matches);
- a monthly full open check;
- a full check and restock after every use.

**Charging** tray drugs used on a patient to that patient's bill is OUT of D4. It belongs to the ER and IPD
brainstorms, where most use happens.

**Permissions:**
- `pharmacy.trays.check`: pharmacy, pharmacy_assistant, ot_nurse, recovery_nurse, radiographer.
- `pharmacy.trays.manage`: pharmacy_incharge.

**Needs row (STOCK):**
- a daily check missed;
- a tray deficient and not restocked;
- a tray item expiring in 30 days or less.

## D5 — Reserve/restricted antimicrobial approval gate

**Basis:**
- WHO AWaRe classification (2023).
- ICMR AMSP guidelines (2018): Reserve and restricted agents need prior authorisation.

**Today:** `cds/guardrails.ts:157-167` turns 6 `amsp_rules` from `knowledge.json` into advisory cards only. There is
no AWaRe field on the formulary.

**Model:**
- `formulary_medicines.aware_category` (Access / Watch / Reserve / null).
- `formulary_medicines.restricted` (boolean). It is set under `formulary.manage` on `/formulary/admin`.
- Seeded from the WHO AWaRe 2023 list by salt, from a cited data file. **DECIDED:** every Reserve salt starts
  `restricted = true`, and carbapenems also start `restricted = true` (common Indian hospital policy; the knowledge
  bundle already flags meropenem). The hospital may restrict more.

**Gate:** at `verifyDispense` and `handOverDispense`, a line whose medicine is `restricted` needs a GRANTED approval
of type `pharmacy_restricted_antimicrobial`. The approval is bound to that dispense and salt, checked on execute with
`assertGrantedApproval`'s binding check (the `billing/credit-notes.ts:255` pattern).
- The ask goes into the desk's existing authorisation sheet.
- The decision is made in `/approvals`.
- There is no act-first (OPD can wait).

**Approver — DECIDED 2026-09-28 (owner: "I leave upon you to choose the right and logical role"):** a new role,
`antimicrobial_steward`, per ICMR AMSP. Admin grants it in this order of preference: the infectious-disease
physician; else the clinical microbiologist; else a senior physician the medical superintendent names as AMSP lead.
The role is held in addition to the person's clinical role. A steward may not approve their own prescription
(the approver must not be the prescriber).
- The type is registered by `scripts/seed-pharmacy` (or its equivalent), or it throws `unknown_type` in prod.
- It is added to the approvals-inbox test's `SERVER_TYPES`.

**Census row:** RED until at least one user holds `antimicrobial_steward`. Until then a restricted line cannot leave,
and the refusal says who to appoint.

## Order

D1 → D2 → D3 → D5 → D4.

- D1 and D2 are pure additions with no gate.
- D3 adds the first gate.
- D5 touches the formulary and adds a role.
- D4 is the largest: stores, templates, transfers.

## Verify (per PR)

- `pnpm typecheck && pnpm lint`.
- Touched suites under the test lock.
- Browser walk of the new screen at 1920 / 1440 / 1280 / 1024 / 768 / 390.
- CI is the gate.
