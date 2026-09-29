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

**As built (2026-09-28, migration 0141):**
- Three append-only tables: `pharmacy_adr_reports`, `pharmacy_adr_suspects` (one row per suspected medicine,
  `allergy_id NOT NULL`), `pharmacy_adr_events`. One trigger function refuses UPDATE and DELETE on all three.
- Routes under `/pharmacy/adr`: list, get, the PvPI form (`/:id/document`), record (`pharmacy.adr.record`,
  idempotent), events (`pharmacy.adr.manage`), and a moiety picker (`/salts`).
- The office's LAW side reads `adrAwaitingPvpi` under `pharmacy.adr.manage`.
- The screen is `screens/pharmacy-office/adr.tsx` (`AdrRegisterView`). It is wired as an office page (Law) after B3
  (#352) merges; until then it is unrouted.
- DECIDED: every suspected medicine writes an allergy, one per distinct moiety (two brands of one moiety share one
  allergy). The substance is the formulary moiety's name when picked, else the typed name. This follows the
  rx-checks rule: over-warning costs one reasoned override, a miss costs a patient.
- DECIDED: severity from seriousness. Death, life-threatening, hospitalisation, disability and congenital anomaly
  are `severe`; other medically important is `moderate`; not serious is `mild`.
- DECIDED: the register is read by holders of `record` OR `manage`. The route is authenticated-only and the service
  checks, as for the controlled register, so the MS reads without the record grant.
- DECIDED: causality may be re-assessed (the latest counts); a report is sent to PvPI once and closed once; a
  closed report takes no further act; closing a report never sent needs a reason.
- DECIDED: the printed form carries the patient's initials (blank for a sealed record the reader may not see),
  age, gender and weight, and the reporter's staff ID, never a name (owner ruling 2026-09-06).
- Deferred: the desk's "Report a reaction" on the patient in hand; the office menu entry (after #352).

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

**As built (2026-09-28, migration 0142):**
- Two append-only tables, `pharmacy_medication_incidents` and `pharmacy_medication_incident_events`; one trigger
  function refuses UPDATE and DELETE on both. Every closed set is a CHECK, and
  `pharmacy_medication_incidents_kind_category_ck` holds `(kind = 'near_miss') = (category in ('A', 'B'))`.
- Routes under `/pharmacy/incidents`: list, get, the indicator (`/indicator?months=`), record
  (`pharmacy.incidents.record`, idempotent), events (`pharmacy.incidents.review`).
- The office's LAW side reads `incidentsAwaitingReview` under `pharmacy.incidents.review`.
- The screen is `screens/pharmacy-office/incidents.tsx` (`IncidentRegisterView`), unrouted until B3 (#352) merges.
- DECIDED: the denominator is every line that left the pharmacy in the IST month: `pharmacy_dispense_lines` on a
  dispense `handed_over` that month (by `handed_over_at`), not declined, with `ledger_entry_id` set, plus
  `pharmacy_retail_sale_lines` by the sale's `sold_at`. A verified line never handed over was not dispensed.
- DECIDED: the reporter's role is snapshotted at record time (`reporter_role`): the reporter's role that grants
  `pharmacy.incidents.record`, a permanent assignment before a temporary grant, the first by key. The service
  refuses a person with no such role, as the route does.
- DECIDED: blame-free is decided on the server per reader. Names (the reporter's, and the reviewer's on each event)
  are read from `users` only for a holder of `review`; everyone else gets `name: null` and the role. The web CSV
  export carries the role only, and no patient, whoever presses it.
- DECIDED: a review may be revised (the latest counts); an incident is closed once, only after a review; a closed
  incident takes no further act.
- DECIDED: the LAW row is red (tier 0) at category E or above once 24 h unreviewed; every other unreviewed incident
  is amber at tier 3, beside the other decisions waiting on the in-charge.
- DECIDED: the desk's "Record a near miss" sits in the ⋯ menu, which is drawn only on a line still being worked.
  It offers A or B, and it sends the dispense and the line's index, never a typed patient or item. The server
  takes both from the line and refuses a patient that contradicts it.
- The indicator is on the D2 screen's strip, not yet on the office Reports page.
- Deferred: the office menu entry (Law), after #352.

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

**As built (2026-09-28, migration 0143):**
- Six tables. `pharmacy_cold_units` (the fridge master); append-only by trigger: `pharmacy_cold_readings`,
  `pharmacy_cold_excursion_batches` (the frozen held list), `pharmacy_cold_excursion_closes`,
  `pharmacy_cold_excursion_decisions`. `pharmacy_cold_excursions` refuses DELETE and every change but
  `closed_at`, once, from null (the shared rules' status-column exception); `pharmacy_cold_excursions_open_ux` is
  the partial unique index (one open excursion per fridge).
- Routes under `/pharmacy/cold-chain`: units (list; add and edit under `manage`), stores (the manage sheet's
  picker), a unit's readings, readings (record, idempotent), excursions (list), excursions/:id/close (`manage`).
- The gate `assertNoColdChainHold` sits beside the controlled gates in `handOverDispense` and in the walk-in
  sale (`recordSale`, channel `walk_in`); code `cold_chain_excursion_open`, naming the fridge and the in-charge.
- The office's STOCK side reads `coldChainToday` under `record` OR `manage`: `cold_excursion_open` (red, tier 0)
  and `cold_reading_missed` (amber, tier 4).
- The screen is `screens/pharmacy-office/cold-chain.tsx` (`ColdChainView`), unrouted until B3 (#352) merges.
- DECIDED: the fridge is a mutable master row, edited in place under `manage`, every save a
  `coldchain.unit_saved` event with the before and the after. Not versioned: the range a reading was judged
  against is copied onto its excursion, so nothing decided under the old range is rewritten by the new one.
  The trigger refuses DELETE (set it inactive) and any change of store or creator.
- DECIDED: the held list is the batches, not every cold item in the store: every `cold_2_8` batch with stock
  on hand in the fridge's store when the excursion opened. Stock received after it opened is not held.
- DECIDED: a batch decided `write_off` STAYS held at that store after the close. The write-off is the materials
  destruction write-off (reason `damage`, the MS approves it) raised in the close's transaction; a
  heat-damaged vial does not go back on sale because the approval is pending or was refused. The write-off
  quantity is what is free on the shelf (on hand less reserved and frozen) unless the closer names one.
- DECIDED: a slot is met by a reading taken from 30 minutes before it to 60 minutes after it. A fridge added
  after a slot's 60 minutes did not miss it. The needs row counts TODAY's (IST) slots; the history shows the rest.
- DECIDED: a reading may be entered up to 24 hours after it was taken (the paper chart during an outage),
  never from the future. Readings are read to one decimal place; 4.55 is refused, not rounded.
- DECIDED: a paper dispense (P20, entered after an outage) is recorded, not refused, by the hold — the medicine
  already left, as with the clinical checks there. The walk-in sale is refused.
- Deferred: the office menu entry (Stock), after #352. A transfer out of the fridge's store is not gated (a
  held batch could be moved to another store); a receipt into a store with an open excursion is not held.

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

**As built (2026-09-28, migration 0144):**
- Two columns on `formulary_medicines`: `aware_category` (null / Access / Watch / Reserve, CHECK) and
  `antimicrobial_restricted` (boolean, default false). On the PRODUCT, not the moiety: AWaRe classifies combinations
  as their own entries (ceftazidime is Watch, ceftazidime-avibactam Reserve) and some moieties by route (fosfomycin
  and minocycline IV Reserve, oral Watch).
- DECIDED: no binding table. The approval is the kernel's row: type `pharmacy_restricted_antimicrobial`, subject
  `{ pharmacy_dispense_moieties, "<dispenseId>|<sorted salt ids>" }`, the patient. The gate re-reads the rows at the
  act and checks type, subject and patient on each (the `assertGrantedApproval` shape). The kernel row already holds
  requester, requested-at, decider and note, and a decided row is never edited. Bound to the MOIETY SET, so a generic
  substitution needs no second approval.
- The cited list is `modules/formulary/aware.ts` (WHO/MHP/HPS/EML/2023.04): 23 Access, 32 Watch (the 4 carbapenems among
  them), 28 Reserve entries by moiety set and route; `aware:classify` (`scripts/classify-aware.ts`, run by hand AFTER a steward is appointed — never `seed:pharmacy`, which deploy.sh runs on every deploy; corrected 2026-09-29 after hmis-b7 caught it before a deploy) writes it onto every systemic product whose
  class is still null, and only ever raises `antimicrobial_restricted`. The Indian market's irrational FDCs stay null.
- DECIDED: the type is `urgent`, 240 min SLA (the other urgent types'), no act-first; approver `antimicrobial_steward`.
- DECIDED — self-approval: the kernel's `requester_approver` pair refuses the requester (the pharmacist), not the
  prescriber, and the approval knows no prescriber. So the gate refuses at execute a grant whose decider is the
  prescribing doctor's user (`antimicrobial_self_approval`); the counter asks again and another steward decides.
  `kernel/**` untouched. The inbox card tells a steward who wrote the prescription.
- The gate `assertStewardApprovals` in `verifyDispense` (after the four books) and `handOverDispense` (a product
  restricted after verify is caught at the window). Codes `antimicrobial_steward_approval_required` (names the drug
  and the authorisation sheet), `antimicrobial_steward_not_appointed`, `antimicrobial_self_approval`.
- DECIDED — retail: a restricted antimicrobial is REFUSED at the walk-in counter (`restricted_antimicrobial_walk_in`),
  not gated: the steward reviews an indication this hospital's doctor wrote, and an outside paper prescription has
  neither — the Schedule X / NDPS reasoning. A paper dispense (P20) is recorded, as for the cold-chain hold.
- Desk: the line says where it stands with the steward; ⋯ "Ask the antimicrobial steward" (indication, culture
  sent, planned days — pre-filled from the prescription's course) files the approval
  (`POST /pharmacy/dispenses/:id/lines/:idx/steward`, `pharmacy.dispense.place`, a registered pharmacist); the state is
  `GET /pharmacy/dispenses/:id/steward`. The decision is made in /approvals; the card shows the prescription line
  from `GET /pharmacy/steward-requests/:approvalId` under `pharmacy.antimicrobial.approve`.
- Role `antimicrobial_steward` (held with a clinical role): `pharmacy.antimicrobial.approve`, `approvals.requests.read`,
  `approvals.requests.decide`. README prose, not a fifth table.
- `/formulary/admin` gains the stewardship editor (AWaRe class, "Restricted — needs steward approval") through the
  medicine PATCH under `formulary.manage`; `GET /formulary/medicines/:id/stewardship` reads one product.
- Census `antimicrobial_steward_appointed` (G4, RED until an active holder). Office LAW (read under
  `pharmacy.licences.manage`): `steward_not_appointed` red tier 0 while restricted products exist; `steward_approval_waiting`
  amber per ask pending over 4 h.
- Deferred: pre-filling the ask from the CDS AMSP card's `micro_order`/`max_days` (the desk has no CDS payload today);
  an ask from a line that is no longer editable (verified, billed) has a server path but no desk control; an HTTP e2e
  of the three routes.

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
