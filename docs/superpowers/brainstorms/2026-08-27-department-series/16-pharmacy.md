# 16 — Pharmacy — Brainstorm & Planning

- **Date:** 2026-08-27
- **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED
- **Series:** Department Brainstorm & Planning (doc 16 of the set; neighbours referenced: 03 patient engagement/online, 07 nursing/eMAR, 09 procurement & stores, 14/15/17/18/19 per roadmap)
- **Ground truth read:** spec v4.8 §4–§10, §11.1 (E4), §11.2 (discharge cascade), §11.8, §11.10, §11.11, §11.14, §11.19-C fixes 3/8/16/19, §11.19-D 39, §11.19-E 4/33, §13, §14–§16; S10 §1–§2, §7 card 25, §11 SoD, §12 mechanisms; copilot spec §0–§2; roadmap Plan 16 entry + 2026-08-23 knowledge-sourcing ruling + stage-2 acceleration; Plan 13 §1–§3 + DD4 kinds; Plan 16a §1–§4 + CLOSE; plan-09 brainstorm §4 format.

**Executive summary.** Pharmacy is the module that turns a prescription into a batch in a patient's hand and a line on their bill, and turns every tablet in the building into a row someone can be asked about. It owns: stock locations (registry `store` kind), the batch/expiry stock ledger, OPD retail dispensing, IPD per-patient indents and ward/floor stock, the statutory registers (Schedule H1, Schedule X, NDPS narcotics, cold-chain excursion, ADR), pharmacist verification of orders, interventions, antimicrobial stewardship approvals, recalls and destruction. It is NOT: the medicine master (Plan 16a `formulary` owns salts/medicines/interactions), procurement (Plan 14 owns vendor/PO/GRN/consignment and creates batches through an interface), billing (Plan 06/08 own tariff and invoices; pharmacy posts `charge.posted`), or administration (eMAR in the nursing/IPD module emits `medication.administered`; pharmacy consumes). The three hardest problems: (1) **one flow, three legal regimes** — a single counter dispenses OTC, Schedule H/H1 and NDPS with different consent, register and custody rules, and the UX must not make the pharmacist think about which one applies; (2) **money that is not ours to set** — every drug line is `min(tariff, MRP, NPPA ceiling)` at batch granularity, with GST slabs, TPA caps and PMJAY-inclusive packages contesting the same line; (3) **leakage in a building where drugs move through six hands** — floor stock, crash carts, patient's-own meds, returns and samples all have to terminate on a bill or a cost centre, and the triangle (issued vs billed vs counted) must close per location per day without turning nurses into clerks.

## 1. Frame — what exists, what is locked, what this document adds

**Built today (Phase 1):** `formulary` module (16a, shipped 2026-08-26): `formulary_salts` / `_medicines` / `_medicine_salts` / `_interactions` / `_staging`; exact-only resolution; issue-time allergy (salt+class), interaction (severe = hard-warn with override, moderate = soft) and duplicate-salt checks in `modules/opd/rx-checks.ts`; `pharmacy` role exists in `seed:roles` with `formulary.read/manage/staging.review` and no holders; OPD `prescription.issued` with `RxLine{drug,dose,route,frequency,durationDays,instructions,noSubstitution,medicineId?}`; tariff engine with best-single-benefit and versioning; billing counter; approvals engine; workflow engine with Class-A/B/C governance; notifications gateway; Plan 13 resource registry (`resources`, `resource_status_history`, closed kind union including `store` — declared by this module per Plan 13 DD4: "Plan 16 adds `store`").

**Locked decisions inherited (not re-litigated):**
- §11.8: formulary-first; generic substitution unless `noSubstitution`; allergy/contraindicated = hard stop, moderate/duplicate = warning; restricted antimicrobials need senior-physician approval; NDPS/Schedule X double-lock, witnessed, second factor (§14), running ampoule balance, witnessed wastage; H1 register writes itself from dispense events; high-alert two-nurse at administration; eMAR generates dose tasks; med reconciliation at admission/transfer/discharge; patient's-own meds pharmacist-verified, doctor-approved, unbilled; returns: sealed + receipt ≤ 7 days = full credit, never narcotics or cold-chain.
- §11.10: every stock-holding place is a stock location; batch+expiry everywhere; UOM once in item master; FEFO-enforced picking; two-sided issue/receive scans; leakage triangle; expiry ladder 90/60/30; witnessed destruction with certificate; batch recall = one-action freeze; emergency local purchase ₹15k float approval-gated; GRN residual shelf-life gate.
- §11.19-C fix 3: **charge = min(tariff, MRP, NPPA ceiling), hard block above ceiling; batch-MRP at GRN**. Fix 8: `allergy.recorded` re-screens pending dispenses. Fix 16: counts never by custodian. Fix 19: walk-in retail POS with Schedule-H gate, anonymous-or-linked customer, GST invoice.
- §11.19-E 33: cold-chain on utility-telemetry pattern; manual verified tasks day one. E-4: sealed record never blinds the treating team's drug-safety checks.
- §11.1 E4: stock-out → substitute (doctor pinged) or partial dispense + auto-refund of gap. §11.2 discharge step 3: unused ward meds returned, credit to bill.
- §16: Replenishment (T4 automation), Expiry Watchman (T1 automation) ship with pharmacy; clinical cap T2–T3.
- Roadmap 2026-08-23 ruling: DTC formulary/high-alert/LASA/antibiotic policy is hospital-authored; interaction/dose dataset RFQ (₹8–12L/yr band); data licence not SaaS; join at salt+ATC; vendor severity maps via governed config. **Plan 16 is gated on both clocks.**
- Legacy harvest: strip-vs-piece packing unit first-class; expired stock blocked from sale and shown red; counter receipt confirmation on store→counter transfer; owner daily collection message includes pharmacy.
- Plan 13: registry owns location hierarchy; **containment/assignment rules are the owning module's**. Kinds `store` (this plan); `device` is Plan 15's declaration — pharmacy fridges/data-loggers reuse it, not a new kind.

**Scope boundaries / who owns what table:** formulary → medicine identity; procurement (14) → vendors, PO, GRN header, consignment ledger, supplier invoice; **pharmacy (16) → `pharmacy_batches` (created by GRN interface call), stock ledger, dispenses, indents, ward stock, all statutory registers, interventions, ADR register, recall actions**; billing → invoice lines (pharmacy posts charges); IPD/nursing (doc 07) → eMAR tasks, administration events; patients → allergies; registry → `store` resources.

**This document adds:** the dispense/indent/narcotic/return/verification/recall workflow definitions, the data model, ~110 edge rows, six chaos walkthroughs, the KPI set, the agent roster placement, hardware/budget, 14 owner rulings, and a split of Plan 16 into 16c/16d/16e/16f.

## 2. Actors, roles & role cards

| # | Role (S10 card) | Stations | Shift | Notes |
|---|---|---|---|---|
| 25 | **Pharmacist** (registered, Pharmacy Act 1948 §42) | OPD counter, IPD pharmacy, ward rounds | 24×7 in three shifts once IPD live; day-one 2–3 | Only role that may complete a Schedule H/H1/X dispense; login carries `pharmacist_registration_no` + state council validity date (S10 mechanism 8) |
| NEW 25a | **Chief Pharmacist / Pharmacy In-charge** | formulary governance, DTC secretary, registers QA, stewardship desk | Day + on-call | Owns `formulary.manage`, recall execution, destruction witness, NPPA/MRP master-data change control |
| NEW 25b | **Clinical Pharmacist** (ward) | order verification queue, reconciliation, interventions, ADR, AMS | Day; one per 60–80 beds at scale | Separate card because KPIs differ from counter (intervention rate vs TAT). Day-one: same person as 25 |
| NEW 25c | **Pharmacy Assistant / Dispensing Aide** | picking, labelling, billing hand-off, shelf-filling, counts | 24×7 | May pick and scan; **cannot complete** any scheduled dispense — the workflow refuses the transition |
| 26 | Storekeeper (central) | bulk store → pharmacy transfers, counts | Day | Custodian of bulk; never counts own store |
| 27 | Purchase Officer | Plan 14 side; receives `stock.below_reorder`, `indent.drafted` | Day | Never GRN-receives |
| 3/4 | Cashier / Billing Supervisor | OPD pharmacy till is a cashier session (§7) | Shifts | Pharmacist may also hold cashier role at night — a SoD-permitted bundle with variance register |
| 20/23 | Staff Nurse / Ward In-charge | ward indents, floor stock, crash cart seal checks, returns, eMAR | 24×7 | Ward in-charge = floor-stock custodian; never counts it |
| 8–14 | Doctors | prescribe, approve substitution, answer intervention, restricted-antibiotic request | — | AMS approver = designated senior physician / ID physician (§11.8) |
| 37 | Quality Manager (DPO) | ADR/PvPI coordinator, incident review, NABH MOM chapter | Day | PvPI reporting officer |
| 39 | Medical Superintendent | second key on clinical definitions; narcotic destruction witness; NDPS licence holder-of-record | On-call | |
| — | Drug Inspector / NABH assessor | external | — | Walk-in demand list in §7 |

**Agents/automations (§9 detail):** Replenishment (T4 automation) · Expiry Watchman (T1 automation) · Cold-Chain Sentinel (T1 automation) · Narcotic Balance Checker (T0 automation) · Substitution Suggester (T2 automation, deterministic) · Stewardship Alert (T1 automation) · ADR Signal (T0 agent, inference) · Pharmacy Leakage Auditor (Leakage Auditor scope extension, T0) · Interaction Dataset Loader (Expertise-store job, T3 behind DTC approval) · Pharmacy Digest (Digest Writer scope).

**SoD hard pairs (S10 §11 extended, proposed):** narcotic issuer / witness (exists) · dispenser / cashier for the same invoice when the dispense is Schedule X or NDPS · stock custodian / counter (exists) · MRP-ceiling master editor / GRN batch-MRP capturer · recall declarer / recall closer · destruction custodian / destruction witness · intervention author / intervention outcome verifier (doctor) · ADR reporter / ADR causality assessor. `sod.violation_blocked` fires on all.

**Bundling (S10 §10):** night shift may bundle pharmacist + cashier + IPD indent desk; may never bundle pharmacist + ward custodian. Roster publication gate: every shift touching an NDPS store needs two eligible people in reach (witness rule) — else `roster.blocked`.

## 3. Core flows as workflow definitions

All are workflow definitions (§10.2), versioned, Class-B unless noted; states carry SLA; `sla.breached` recorded always, active alerts only where marked ★.

### 3.1 OPD dispense (P3 + P6 fused; pattern "scan → verify → pick → bill → hand over")

```
prescription.issued ──► QUEUED (Rx visible at counter before patient arrives, §11.1)
   │ QR scan / UHID search
   ▼
CLAIMED (pharmacist/aide)  ── SLA 2 min to VERIFYING ★(OPD wait active alert)
   ▼
VERIFYING  (checks re-run: allergy/interaction/duplicate at dispense-time on RESOLVED batch,
            schedule gate, ceiling price, stock/FEFO pick list)  SLA 3 min
   ├─ intervention needed → HELD_FOR_DOCTOR (doctor pinged; SLA 10 min; escalate dept head 20 min)
   ├─ restricted antimicrobial w/o approval → HELD_FOR_AMS (approval engine)
   ▼
PICKING (batch told, scan each pack; strip/piece unit)  SLA 5 min
   ├─ short stock → PARTIAL_PROPOSED (substitute rules §3.1a or partial qty)
   ▼
BILLING (invoice drafted from picked batches: min(tariff,MRP,ceiling), GST slab, adjustment contest)
   ├─ patient declines line(s) → lines dropped, stock un-reserved, `dispense.line_declined` NEW
   ▼
PAID  (payment.received / credit payer)  — or CREDIT_HOLD for IPD/TPA
   ▼
HANDED_OVER (counsel, label, H1 register row auto-written) → `dispense.completed` NEW
   └─ within 7 days: RETURN_REQUESTED → RETURN_ACCEPTED/REJECTED (credit note) `material.returned`
Terminal: COMPLETED · CANCELLED (reason-coded; stock released) · ABANDONED (paid-not-collected 24h → refund path E1)
```
Roles: CLAIMED/PICKING any pharmacy role; VERIFYING→PICKING and →HANDED_OVER **pharmacist only** for Schedule H/H1/X/NDPS lines (permission `pharmacy.dispense.scheduled`); OTC-only carts may be completed by aide with pharmacist-on-duty flag true. Escalation: pharmacist in-charge at 2× SLA; duty manager at 3× (P7 ladder).
Events consumed: `prescription.issued`, `allergy.recorded`, `payment.received`, `payer.switched`, `batch.recalled`. Emitted: NEW `dispense.claimed`, `dispense.verified`, `dispense.held`, `dispense.partial`, `substitution.recorded`, `dispense.completed`, `dispense.line_declined`, `dispense.cancelled`; existing `material.issued`, `material.consumed`, `charge.posted`, `material.returned`, `stock.below_reorder`.

**3.1a Substitution rules (deterministic, corporate default):** same moiety + same strength + same form/route + not `noSubstitution` → pharmacist may substitute with **patient consent captured on screen (Hindi/English toggle) and printed on label "substituted for X"**; doctor is notified (not asked) via `substitution.recorded`. Different strength (2×250 for 500) → allowed with pharmacist confirmation, dose instruction rewritten. Different salt-form of same moiety → allowed (16a moiety identity) except for narrow-therapeutic-index list (DTC-owned: phenytoin, levothyroxine, warfarin, lithium, carbamazepine, digoxin, cyclosporine, tacrolimus) → **doctor approval required**. Different moiety in same class → never substitution; that is a new prescription (doctor amends, `prescription.issued` v2 supersedes). `noSubstitution` → HELD_FOR_DOCTOR if brand unavailable; doctor may lift flag from phone (approval item).

**3.1b Walk-in retail (fix 19):** same definition with `QUEUED` entered from a paper/outside Rx capture (photo attached, prescriber name/reg no typed, Schedule H gate: no Rx → OTC lines only) or anonymous OTC sale. Customer = linked UHID or `anonymous` (name+phone mandatory for H1; H1 register requires patient + prescriber name/address by Rule 65(3)).

### 3.2 IPD per-patient indent (P3; drug order → indent → issue → eMAR → charge)

```
order.placed(drug) [from IPD round / eMAR] ──► PHARMACIST_VERIFICATION queue (SLA 30 min routine; 10 min STAT ★; 2 h for scheduled "next-day" supplies)
   ├─ verified → INDENT_DRAFTED (per patient, per shift window; unit-dose where applicable)
   ├─ intervention → HELD (doctor task)
   ▼
PICK_PACK (patient-labelled cassette/bag; FEFO; scan) ──► DISPATCHED (issue scan) ──► RECEIVED_AT_WARD (nurse receive scan; two-sided) 
   ▼
eMAR administers → `medication.administered` → `charge.posted` (bill = read model of care, §11.11)
   ├─ missed/refused/discontinued → dose stays in ward custody → RETURN_TO_PHARMACY (credit) or FLOOR_STOCK_ABSORB (cost centre) 
Discharge: OPEN_INDENTS_STOPPED (cascade step 2) → RETURN_UNUSED (step 3) → DISCHARGE_MEDS dispensed via 3.1 with reconciliation
```
**Charge timing (recommended default O-4):** charge posts on **issue to ward** for consumables and floor-stock replenishment, and on **administration** for per-patient drugs (aligns with §11.11 eMAR → charge and makes returns of un-administered doses a non-event financially). Unadministered doses at discharge are returned or written to ward cost centre — never silently billed.

### 3.3 Ward / floor stock & crash carts (P3 + P5)

Par per location per item (Class-B definition data). `stock.below_reorder` at par-minus-on-hand → Replenishment drafts a floor-stock indent (T4) → issue/receive scans → consumption terminates on the bed's bill via eMAR (per-patient) or on the ward cost centre (bulk items: IV fluids below threshold, antiseptics). Crash cart = a `store` resource with a **seal number**; daily seal-check task (verified task, P5); seal broken → `crash_cart.opened` NEW → mandatory restock task with 60-min SLA ★ (ICU/ED) and per-item consumption attribution to the code's patient (`code.activated` correlation); expiry check monthly; anything within 30 days rotated out.

### 3.4 NDPS narcotics & Schedule X (P3 with double custody)

```
RECEIVED (GRN, Form 3E-style stock register entry; two signatures) ──► IN_VAULT (double-lock store resource; balance per ampoule/tablet)
ISSUE_REQUESTED (doctor order, patient-linked; OT per-case kit; palliative)
   ▼ approval engine: pharmacist + witness (second factor §14; both scan badges)
ISSUED (`narcotic.issued` NEW; balance decrements; register row)
   ▼ administration on eMAR (two-nurse) → partial-ampoule WASTAGE_WITNESSED (`narcotic.wasted` NEW; two identities)
   ▼ unused → RETURNED_TO_VAULT (witnessed) 
DAILY_BALANCE_VERIFIED (`narcotic.balance_verified` NEW; count by non-custodian + custodian) — discrepancy → `narcotic.discrepancy_flagged` NEW → incident + MS notified within 1 h ★
EXPIRED/DAMAGED → DESTRUCTION_REQUESTED → approval (MS) → DESTRUCTION_WITNESSED (drug inspector / gazetted officer as per state NDPS rules; certificate attached) → `batch.destroyed`
```
Schedule X: same custody but single-lock acceptable; prescription copy (photo/scan) retained 2 years (Rule 65(10)); register per Rule 65. Essential Narcotic Drugs (morphine, fentanyl, methadone, oxycodone etc. under NDPS Rules 2015 amendment, RMI status) — hospital must be a Recognised Medical Institution; Form 3E stock/consumption record; owner ruling O-2 on RMI application timing.

### 3.5 Pharmacist verification of orders & interventions (P2-like review; Class-C definition — clinical)

Every IPD drug order and every OPD Rx with a hard-warning override enters the verification queue. Checks: 16a suite re-run on **resolved batch** (not just medicine), dose-range (licensed dataset, weight from vitals), renal/hepatic adjustment flags (lab values when Plan 17 live; manual field before), route/form sanity, therapeutic duplication across active orders, IV compatibility (dataset), restricted antimicrobial policy. Outcome states: VERIFIED · INTERVENTION_RAISED (`pharmacist.intervention_recorded` NEW: type ∈ {dose, interaction, allergy, duplication, route, formulary, cost, renal, pregnancy, stewardship, other}; severity; recommendation) → doctor ACCEPTED / MODIFIED / REJECTED_WITH_REASON (`intervention.resolved` NEW) — a rejected intervention is data, never a block, except allergy/contraindicated which stays hard-stop at prescribing. SLA on doctor response: 30 min STAT / 4 h routine; unanswered → dept head.

### 3.6 Antimicrobial stewardship (approval overlay)

Restricted list (DTC, Class-B): e.g. carbapenems, colistin, polymyxin B, linezolid, tigecycline, daptomycin, echinocandins, voriconazole, fosfomycin IV. Order → `antimicrobial.approval_requested` NEW → AMS approver (ID physician / designated senior) within 2 h ★; **first 24 h supplied on "empiric allowance"** (corporate default: never withhold the first dose) with automatic stop at 48 h if not approved (`order` auto-flagged, doctor must re-justify: culture sent? de-escalation?). Day-3 and day-7 review tasks. Outputs feed DDD/100 bed-days and the antibiogram (with LIMS).

### 3.7 Recall & freeze (P3 exception)

`batch.recalled` (from Plan 14 or CDSCO/NPPA alert entered by chief pharmacist) → **one action freezes the batch at every location** (dispense/issue transitions refuse; shelves show red) → per-location pull tasks (P5) → dispensed-patient contact list (E-fix §11.18-9) → Recall Agent campaign → return to supplier / destruction → `recall.closed` NEW with reconciliation: received − dispensed − on-hand − returned = 0.

### 3.8 Returns (customer, ward, supplier)

Customer: 7-day, sealed, receipt, never narcotics/cold-chain/cut strips/Schedule X — credit note (§7), stock re-entered to a `quarantine` sub-location until pharmacist inspects, then saleable. Ward: unadministered per-patient doses → credit to bill if charge already posted; floor stock → transfer. Supplier: short-expiry/near-expiry within contract window (Plan 14 debit note), recall.

### 3.9 Cold chain (utility-telemetry pattern)

Fridge = registry `device`; sensor readings via MQTT → TimescaleDB (or manual twice-daily verified task day one, E-33); thresholds 2–8 °C (vaccines/insulin), −20 °C where applicable; excursion → `cold_chain.excursion_recorded` NEW → affected batches to QUARANTINE_HOLD → pharmacist decision (manufacturer stability data) → release or destruction; register is the table. Power loss → ★ alert to pharmacist + maintenance within 5 min; 30-min unresolved → move-to-backup task.

## 4. Data model sketch

Module folder `apps/core/src/modules/pharmacy/`; own schema file; manifest declares `store` resource kind (Plan 13 DD4) with statuses `open | closed | sealed | frozen | retired`, and `crash_cart` as a **sub-type of `store`** (attribute, not a new kind — Plan 13's containment stance).

| Table | Key columns (sketch) |
|---|---|
| `pharmacy_items` | medicine_id (FK formulary) · hsn_code · gst_rate (5/12/18/0) · packing: pack_size, strip_size, piece_saleable bool · uom ladder · storage_class (ambient/cold/frozen/narcotic/schedule_x/high_alert/lasa_group) · schedule (mirror of formulary, denormalised for gating) · ntI_flag · restricted_antimicrobial bool · nppa_scheduled bool · consignment bool · active |
| `pharmacy_price_regulation` | item_id · kind (nppa_ceiling / mrp_annual_cap) · ceiling_price_per_unit · gazette_ref · effective_from/to · entered_by · approved_by (master-data change control) |
| `pharmacy_batches` | id · item_id · batch_no · mfg_date · expiry · **mrp_per_pack** (from GRN, Plan 14 interface) · purchase_rate · supplier_id · grn_ref · consignment_ref? · status (saleable/quarantine/frozen/expired/destroyed) · barcode/GS1 GTIN+lot if present |
| `pharmacy_stock` | location_id (registry resource) · batch_id · qty_base_unit · reserved_qty · last_counted_at · par_level (per location-item) · reorder_level |
| `pharmacy_stock_movements` | append-only: id · batch_id · from_location · to_location · qty · movement_type (grn_in/transfer/issue/dispense/return/adjust/destroy/consume/sample_in/own_med_in) · ref (dispense_id/indent_id/…) · terminates_on (patient_bill:invoice_line | cost_center:id | supplier | destruction) · actor · occurred_at/recorded_at |
| `pharmacy_dispenses` | id · workflow_instance_id · patient_id? · encounter_id? · prescription_id? · channel (opd/ipd_discharge/retail/online) · customer (uhid/anonymous{name,phone}) · prescriber (internal user / external{name,reg_no,photo_doc}) · payer_tag · status mirror · counselled_by · language |
| `pharmacy_dispense_lines` | dispense_id · rx_line_idx · medicine_id_ordered · medicine_id_dispensed · batch_id · qty · unit · substitution_type · consent_captured_by/at · unit_price_rule_winner (tariff/mrp/ceiling) · gst_rate · charge_event_id · declined bool |
| `pharmacy_indents` / `_lines` | patient/ward · window (shift) · type (per_patient/floor/crash_cart/stat) · unit_dose bool · states mirrored · dispatch_scan · receive_scan |
| `pharmacy_verifications` | order_ref · pharmacist · checks_json (engine version, dataset version) · outcome |
| `pharmacy_interventions` | id · verification_id · type · severity · recommendation · doctor_response · resolved_at · cost_avoided? |
| **Registers (first-class tables, append-only):** `reg_schedule_h1` (Rule 65(3): date, patient name+address, prescriber name+reg no, drug, qty, batch — retained 3 y) · `reg_schedule_x` (+ Rx copy doc ref, 2 y) · `reg_narcotics` (Form-3E-shaped: opening, received, issued, wasted, balance per item per day; issuer, witness, patient, order ref) · `reg_cold_chain` (device, reading, excursion, action) · `reg_adr` (PvPI suspected-ADR form fields: patient, drug/batch, reaction, onset, dechallenge/rechallenge, causality WHO-UMC, reporter, PvPI submission ref) · `reg_destruction` (item, batch, qty, method, witnesses, certificate doc, BMW category) · `reg_recall` · `reg_local_purchase` · `reg_intervention` (view over interventions) · `reg_own_medication` |
| `pharmacy_counts` / `_count_lines` | location · scheduled_by (randomised, non-custodian) · counted vs system · variance · approval_ref · blind bool |
| `pharmacy_lasa_groups` | group_id · medicine_ids · tallman_label · shelf_separation_rule |
| `pharmacy_ams_approvals` | order_ref · antimicrobial · indication · culture_sent · approver · decision · review_due_d3/d7 |
| `pharmacy_samples_free` | batch_id · source (sample/donation/scheme) · zero-price bool · dispensed_to | 
| `pharmacy_rosters_view` | (consumed from roster) pharmacist_on_duty per store per shift — drives the "scheduled dispense allowed" gate |

**FHIR shapes:** `MedicationDispense` (per dispense line; `substitution.wasSubstituted/reason`), `MedicationRequest` already from OPD, `MedicationStatement` for own-meds & reconciliation, `AdverseEvent` for ADR, `Medication` for batch/lot (`batch.lotNumber/expirationDate`). Stored JSONB alongside rows, serialised for ABDM later.

**Retention (recommended defaults):** H1 register 3 y (Rule 65(3)); Schedule X Rx copies 2 y; NDPS records 2 y minimum (NDPS Rules) — recommend 5 y; cold-chain 3 y; ADR indefinitely (linked to patient record retention); stock movements 8 y (GST/IT); dispense records follow OPD 5 y / IPD 10 y; MLC-linked indefinitely.

**DPDP data classes:** dispense line + patient = health data (sensitive); anonymous OTC = personal (name/phone); registers containing patient names are health data; PvPI export is a lawful third-party transfer with purpose logging; staff-as-patient dispenses fall under sealed handling (E-4 carve-out for pharmacist doing the dispense).

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.**

### A. Identity & wrong-patient
- **A1** Two "Ram Kumar" prescriptions in queue, aide scans the wrong one → dispense binds to QR (UHID+visit+Rx id); handover requires patient phone-last-4 or token confirmation for scheduled drugs → test: dispense with mismatched confirmation refuses `HANDED_OVER`.
- **A2** Attendant collects for patient (IPD discharge, bedridden OPD) → attendant name+phone captured; label still bears patient; H1 register records patient → test: register row patient ≠ collector, both stored.
- **A3** Patient merged (Plan 05) after dispense → dispense rows re-link to survivor; interaction priors follow → test: `patient.merged` re-links and check engine sees prior Rx.
- **A4** Anonymous retail buyer later registers → optional link with consent; anonymous rows never auto-matched by phone → test: same phone does not auto-attach.
- **A5** Twins/newborn with same surname and ward → per-patient indent cassette labelled with UHID + mother's name + DOB; eMAR wristband scan is the last gate (doc 07) → test: indent label fields.
- **A6** Rx issued to encounter A, patient re-enters same day (B outcome §11.1) with amended Rx → v2 supersedes v1; queue shows one card; partially dispensed v1 lines carry over → test: superseded lines not double-dispensed.
- **A7** Sealed/VIP record at counter → alias on display and label per §14; pharmacist sees allergies (E-4) → test: label prints alias; check engine still fires on true allergies.
- **A8** Staff-as-patient buys own medicines → sealed class; dispense visible only to dispensing pharmacist and patient → test: another pharmacist's search returns nothing.

### B. Timing, concurrency, race
- **B1** Two counters claim the same Rx → `CLAIMED` is FOR-UPDATE transition; second gets "claimed by X at counter 2" → test: concurrent claim, one wins.
- **B2** Last strip of a batch picked at two counters → reservation at PICKING decrements `reserved_qty` atomically; loser is offered next FEFO batch or partial → test: 2 pickers × 1 unit.
- **B3** Rx amended by doctor while counter is picking → `prescription.issued` v2 event interrupts: lines re-verified, picked lines diff shown → test: amended line flagged, unchanged lines keep pick.
- **B4** Allergy recorded at vitals desk after Rx queued (fix 8) → pending dispense re-screened; hard-stop line held → test: `allergy.recorded` → `dispense.held`.
- **B5** Payment received but stock scanned out after cashier session closed → dispense in PAID; handover after session close is allowed (no money moves) → test: handover post-close ok.
- **B6** Expiry passes at midnight while batch is reserved in an open cart → batch flips to `expired` on the daily job; BILLING refuses expired batch → test: cart with batch expiring tonight, clock past midnight.
- **B7** NPPA ceiling effective today, GRN yesterday at higher MRP → price = min(tariff, batch MRP, new ceiling) → test: ceiling < MRP yields ceiling.
- **B8** IPD tariff-locked (admission date) but batch MRP fell → min() picks lower MRP; tariff lock protects only against increases → test: price never exceeds current batch MRP.
- **B9** Ward indent submitted at 07:58, shift handover 08:00 → indent window carries `requested_by_shift`; receiving nurse from next shift may receive → test: receive by different user allowed, both logged.
- **B10** STAT order and routine order for same drug → separate instances; STAT bypasses batching → test: STAT SLA 10 min instance created.

### C. Partial failure & downtime
- **C1** Core down, OPD pharmacy must dispense → downtime kit: printed Rx has QR; paper dispense slip with batch numbers written; H1 register kept manually; backfill screen captures `occurred_at` from slip, `recorded_at` now; stock movements backfilled in slip order → test: backfill preserves FEFO check warnings but does not block; register rows carry `backfilled=true`.
- **C2** Scanner dead → keyboard entry of batch no (typeahead) allowed with `manual_entry` flag; KPI counts manual rate → test: flag present.
- **C3** Label printer dead → dispense completes; label reprint task; handover allowed with handwritten label flag (never for narcotics) → test: NDPS handover refuses without printed label.
- **C4** Payment gateway/UPI down → cash/credit-hold; dispense continues → test: PAID reachable via cash tender.
- **C5** Formulary module unavailable (read helper throws) → checks report `UNAVAILABLE` (law 6), dispense continues for OTC/H; **Schedule H1/X/NDPS require pharmacist attestation "checked manually"** → test: attestation required only for scheduled lines.
- **C6** Licensed dataset load fails mid-way → previous version stays active (model-change-class event); checks stamp dataset version → test: version pin unchanged on failed load.
- **C7** MQTT broker down for fridges → after 15 min of no readings, manual reading task created every 6 h; readings backfilled from logger export → test: gap creates task.
- **C8** Worker/scheduler down → expiry flips and `stock.below_reorder` delayed; dispense path never depends on worker (fail-open) → test: dispense with worker stopped.
- **C9** Partial network: ward tablet offline → indents queued locally? **No** (no offline SPA in Phase 1): paper indent + phone; pharmacy enters on behalf with `requested_by` = nurse name → test: proxy entry logged as `on_behalf_of`.
- **C10** Backfill of a narcotic issue after downtime → requires both issuer and witness to re-authenticate at backfill time → test: single-actor backfill refused.

### D. Money — billing, refunds, payers, packages, TPA
- **D1** Tariff > MRP for a branded item (config error) → min() picks MRP; `price.tariff_above_mrp_flagged` NEW T0 report → test: winner = mrp.
- **D2** MRP > NPPA ceiling on a scheduled formulation (manufacturer non-compliant batch) → **hard block** at GRN (Plan 14) and at dispense; chief pharmacist may sell at ceiling with reason (legal: selling above ceiling is the offence, selling below is not) → test: dispense at ceiling allowed, above refused.
- **D3** GST slab per item: 5% (life-saving list), 12% (most drugs), 18% (some nutraceuticals/cosmetics), nil (blood, human vaccines listed) → invoice line uses item's `gst_rate`; inclusive-MRP arithmetic: taxable = MRP/(1+rate) → test: golden fixture per slab.
- **D4** Partial dispense of a paid-in-advance line (E4) → auto-refund of gap as credit note + refund voucher below threshold auto-approved → test: gap refund event.
- **D5** Patient declines 3 of 7 lines at billing → lines dropped; doctor notified (adherence signal); stock released → test: `dispense.line_declined` ×3.
- **D6** Membership category discount on pharmacy (e.g., 10% Gold) vs coupon → best-single-benefit; **never below purchase cost** floor? — corporate practice: discounts apply on MRP items; recommend floor at purchase rate + 5% → O-6 → test: contest picks one.
- **D7** TPA cap "pharmacy max ₹X or 20% of bill" → payer-rule adjustment at invoice; excess to patient as self-pay split → test: split invoice lines by payer.
- **D8** PMJAY package inclusive of drugs → dispense lines post charge to package allowance (`package.allowance_consumed`), zero to patient; **drugs outside package** flagged for pre-authorisation, never charged to patient without documented consent (PMJAY rule) → test: outside-package line blocked until consent/approval.
- **D9** Payer switched mid-stay (`payer.switched`) → past pharmacy charges re-attributed per §11.4 map 3; drug prices do not change → test: re-attribution without price change.
- **D10** Return after 7 days → refused with reason; manager override via approval only for hospital error → test: day 8 refused, override path evented.
- **D11** Return of cut strip / opened bottle → refused; return of cold-chain/narcotic → refused hard, no override → test: category-based refusal.
- **D12** Same batch sold at two MRPs (old and new packs) → price per **batch**, not item → test: two batches two prices.
- **D13** Credit-hold IPD patient hits credit limit (`credit.limit_breached`) → pharmacy still issues life-saving/STAT; elective/non-formulary held pending finance → test: STAT bypass.
- **D14** Free samples/donation stock dispensed → zero-price line still posts (leakage principle: terminates on bill at ₹0) with `source=sample`; GST nil → test: ₹0 charge event exists.
- **D15** Consignment implant/drug used (Plan 14 interface) → scan-on-use creates batch-in + consume same transaction; price min() applies → test: consignment ledger and bill agree.
- **D16** Cashier session variance from pharmacy till → §7 variance register; pharmacist-cashier bundle flagged in dyad analytics → test: variance row attributes both roles.
- **D17** Discharge meds billed but patient leaves without collecting → 24 h → ABANDONED → refund path; stock unreserved → test: timeout job.
- **D18** Round-off: MRP ₹7.37 per tab × 14 → invoice-level rounding to nearest rupee per GST rules (Section 170 CGST) → test: rounding line.
- **D19** Insurance requires generic name on bill → invoice line prints brand + salt + batch + expiry (also NABH) → test: print template.
- **D20** Corporate rate contract price for drugs below MRP → adjustment rule as payer contract; still ≤ ceiling → test: contract wins when lower.

### E. Consent, legal, MLC, minors, unconscious
- **E1** Schedule H drug without prescription at retail → refuse; OTC lines only; `dispense.refused_no_rx` NEW counts (Rule 65) → test: H line cannot be added.
- **E2** Schedule H1 (e.g., 3rd/4th gen cephalosporins, tramadol, alprazolam) → register row auto-written with prescriber + patient address; **address mandatory** → test: missing address blocks handover.
- **E3** Outside doctor's Rx (paper) → prescriber name + registration no + photo of Rx; safety checks run against our formulary; **prescriptions older than the Rx validity policy (recommend: Schedule H 6 months? corporate: single dispense unless "repeat ×N")** → O-7 → test: repeat count enforced.
- **E4** Teleconsult Rx (Telemedicine Guidelines 2020): List O/A/B only; List B needs prior in-person; narcotics/Schedule X prohibited → our tele-Rx carries flag; dispense refuses X/NDPS from tele-encounter → test: tele-encounter + Schedule X refused.
- **E5** Minor buys emergency contraception / OTC → allowed for OTC; prescription-only items need Rx; no guardian gate beyond law → test: none blocked for OTC.
- **E6** MLC patient (poisoning) — pharmacy records what was dispensed pre-arrival if brought → own-med register with MLC flag; release discipline → test: MLC-flag rows behind records-request workflow.
- **E7** Unconscious ED patient, narcotics needed, no consent possible → treatment first (E3); narcotic issue on doctor order, patient-linked; consent not a gate for administration → test: NDPS issue without consent doc succeeds, evented.
- **E8** Substitution without patient consent recorded → substitution transition refuses without consent capture (except IPD where doctor approved) → test: OPD substitution needs consent.
- **E9** Patient refuses generic; wants brand not stocked → line declined; note to doctor; optional local-purchase? No — OPD retail never local-purchases for one patient; give written Rx → test: decline path.
- **E10** DNR/treatment refusal flagged on eMAR → pharmacy indents continue unless discontinued; comfort meds prioritised → test: no auto-stop.
- **E11** Rx from a doctor whose credential expired (`credential.blocked`) → OPD blocks prescribing already; outside-Rx with unverifiable reg no → allowed with flag; H1 register still written → test: flag present.
- **E12** Pregnancy category X drug (isotretinoin) for female 15–45 → intervention mandatory + counselling checkbox → test: intervention auto-raised.

### F. Staff absence, overload, handover
- **F1** No registered pharmacist on duty (night) → **scheduled dispense transitions refuse** (Pharmacy Act §42; D&C Rule 65(2)); OTC continues; ED emergency drugs come from ED floor stock under doctor's order → `pharmacist.absent_flagged` NEW; roster gate should have prevented it → test: no pharmacist on duty → H line refused.
- **F2** Pharmacist logged in but left (badge not scanned out) → on-duty flag from roster + last activity < 30 min; stale → prompt re-auth → test: stale session refuses scheduled dispense.
- **F3** Queue > 25 waiting → `overload.flagged`; second counter opens (Coverage Resolver T3) → test: threshold event.
- **F4** Handover mid-pick: cart abandoned 15 min → auto-release reservations, card returns to QUEUED with note → test: timer releases.
- **F5** Narcotic witness unavailable → issue cannot proceed; escalation to ward in-charge as witness (eligible role list) → test: ineligible witness refused.
- **F6** Locum pharmacist (temp_role) → registration number captured on grant; expiry auto-revokes → test: expired grant refuses.
- **F7** Aide completes OTC-only cart while pharmacist on break → allowed; if a scheduled line exists → refused → test: mixed cart.
- **F8** Clinical pharmacist backlog > 4 h routine → SLA breach recorded; STAT protected by separate queue → test: STAT unaffected by routine backlog.

### G. Equipment failure
- **G1** Fridge excursion 12 °C for 3 h → batches quarantined; pharmacist decision task with manufacturer stability reference; insulin pens already dispensed today listed → test: quarantine + patient list.
- **G2** Data logger battery dead → no readings → manual task (C7) → test.
- **G3** Barcode on Indian pack unreadable (no GS1, only text) → item-level barcode (internal label) printed at GRN; batch chosen from FEFO list → test: internal label resolves.
- **G4** Narcotic safe lock jammed → drugs inaccessible; ED backup narcotics from OT/ED sub-store; incident → test: alternate store issue evented with reason.
- **G5** Ward tablet broken → paper indent proxy (C9).
- **G6** Power loss > UPS → fridge on generator; if none, cold-box transfer task with temperature log → test: transfer creates movement to `cold_box` location.
- **G7** Label printer prints wrong label sequence (two patients) → label carries QR; handover scans label QR = dispense id → test: label/dispense mismatch refused.

### H. Data quality, late-arriving, backdated
- **H1** GRN entered days after physical receipt (Plan 14) → batches appear late; dispenses already made from "unknown batch" paper → backfill links movement to batch with `occurred_at` earlier → test: negative-stock guard allows backfill order.
- **H2** Batch expiry typed as 03/2027 vs 2027-03-31 → normalise to last day of month (Indian packs print MM/YY) → test: parser.
- **H3** Same batch no across two suppliers/manufacturers → batch identity = (item, manufacturer, batch_no) → test: uniqueness.
- **H4** Free-text Rx line unresolved (16a) → dispense picker must resolve to a medicine; pharmacist's pick **feeds the coverage worklist** and may propose alias → test: `formulary_staging` row created from dispense.
- **H5** Doctor wrote "Tab. Augmentin 625 1-0-1 × 5" qty missing → qty derived = frequency × days × per-dose; pharmacist confirms → test: derivation.
- **H6** Ward returns 6 tablets of a batch pharmacy never issued to that ward → refuse; variance flag → test: return without prior issue refused.
- **H7** Count entered as 0 by mistake → blind recount task auto-created if variance > 10% or > ₹2,000 → test: threshold.
- **H8** Manufacturer changes MRP mid-batch (sticker) → new batch row with same batch_no + `mrp_revision` → test: two price rows.
- **H9** Weight missing for paediatric dose check → intervention "weight not recorded" + vitals task → test: check returns UNAVAILABLE not pass.
- **H10** Backdated eMAR administration (nurse charts 3 h late) → charge posts with `occurred_at` earlier; discharge bill cut-off uses `occurred_at` → test: late-charted dose before discharge is billed.
- **H11** Prescription duration 0/null (16a chronic) → dispense qty prompt; interaction priors treat as current → test.

### I. Fraud, leakage, gaming
- **I1** Issued vs billed vs counted triangle per location per day → variance row; pattern per location → Leakage Auditor → test: fixture with 3 unbilled units surfaces.
- **I2** Pharmacist dispenses to "walk-in cash" the stock from an IPD indent → per-patient indent stock is a separate location (`ward_patient_bin`); retail counter cannot pick from it → test: location isolation.
- **I3** Returns fraud: refund without physical return → return requires scan of pack + quarantine movement in same transaction → test: credit note without movement impossible.
- **I4** Narcotic diversion: partial ampoule "wasted" repeatedly by same nurse-witness dyad → dyad analytics (S10 mechanism 23) + wastage rate per nurse vs peers → test: report row.
- **I5** Expiry write-off used to hide theft → destruction requires witnessed count + photo doc; destruction qty ≤ system qty; anomaly if write-offs cluster before counts → test: over-destruction refused.
- **I6** Doctor–pharmacy kickback: brand steering → substitution-policy compliance and brand-share per prescriber report (T0, MS reviewer) → test: report only, no auto-action.
- **I7** Discount abuse at pharmacy till → §7 caps + reason codes; per-user pattern → Fraud Sentinel → test.
- **I8** Ghost indents to floor stock feeding a private clinic → floor-stock consumption vs census/eMAR expected use ratio per ward → anomaly → test: ratio > 2σ flagged.
- **I9** Sample drugs sold at MRP → sample batches carry `zero_price=true`; billing refuses non-zero → test.
- **I10** Counterfeit/spurious suspected (packaging, patient complaint) → `counterfeit.suspected` NEW → batch frozen everywhere; sample retained; Drug Inspector notified (D&C Act §18/§27) → test: freeze + register.
- **I11** Cashier voids pharmacy invoice after handover → invoices immutable; only credit note with return scan → test.
- **I12** GRN quantity > physical (supplier-store collusion, Plan 14) → count variance surfaces; not pharmacy's control but pharmacy's counts are the detector → test: first cycle count flags.
- **I13** "Free" strip given to relative → every handover is a dispense; zero-price needs reason + approval; T0 report of zero-price by user → test.

### J. Privacy, sealed records, VIP, staff-as-patient
- **J1** Pharmacy queue display shows names → tokens only on public display; counter screen shows name → test: public read surface omits name.
- **J2** WhatsApp "your medicines are ready" → per-patient language; no drug names in message (a psychiatric or HIV drug name is sensitive) → test: template has no line items.
- **J3** ART/psychiatric/MTP-related drugs → dispense flagged sensitive class; register rows still statutory; exports masked except lawful → test: PvPI export de-identified.
- **J4** Drug inspector asks for H1 register → print/export of the table for date range; contains patient names by law → `document.release_logged` → test: release event.
- **J5** Dispense record for staff-as-patient (A8).
- **J6** Copilot narration for pharmacist → tokenised (copilot §2.2); dispense history lines allowlisted → test: leak fixture.

### K. Language, literacy, accessibility
- **K1** Label in Hindi with pictograms (sun/moon, before/after food) generated from structured sig → test: sig → Hindi string fixture.
- **K2** Bhojpuri-only patient, cannot read → counselling checkbox with "explained verbally, attendant present"; voice note? (lawful: dictation Class 2; defer) → test: counselling field required for scheduled drugs.
- **K3** Visually impaired → large-print label option; WhatsApp schedule as audio? deferred → test: flag.
- **K4** Numbers: "1-0-1" vs "BD" — normalised sig grammar; printed both ways → test.
- **K5** Substitution consent screen in patient's language; consent text versioned → test: version stamped.

### L. Scale (100/day → 2,000/day)
- **L1** 2,000 OPD × 3.5 lines = 7,000 dispense lines/day; counter count from queue depth model: 6–8 OPD counters; separate discharge-meds counter; queue routing by ticket → test: perf budget dispense-claim < 300 ms at 50 concurrent.
- **L2** 610 beds × 8 orders/day → ~5,000 verifications/day; verification queue must be worklist-filtered by ward and priority; auto-verify rule for repeat continuation orders with no change? **Recommend: repeat orders auto-verified by rule (deterministic), new orders human** → O-9 → test: continuation order skips queue with `auto_verified`.
- **L3** Stock ledger rows ~10M/yr → partition movements by month; counts by location → test: query plans.
- **L4** Multi-store: central pharmacy, OPD retail ×2, ED, OT, ICU satellite, ward bins ×30, crash carts ×40 → all registry resources; Replenishment per location → test: 100 locations fixture.
- **L5** Second building/site later → `site_id` already on events; store hierarchy under site → no change now.
- **L6** Night volume: one pharmacist for building → satellite ADCs (automated dispensing cabinets, Pyxis-like) are a Phase-4 buy; design events now (`adc.issued`) — negative-space note.

### M. Integration failures
- **M1** Plan 14 GRN interface down → pharmacy can create a `provisional batch` from physical pack (MRP typed) with `unlinked_grn` flag; reconciled when GRN posts → test: flag cleared on link.
- **M2** Interaction dataset vendor API outage → irrelevant (data licence, local execution — RFQ rule a) → test: checks run offline.
- **M3** eMAR (doc 07) not yet live → IPD charge on issue (O-4 fallback), returns credit → test: config toggles charge point.
- **M4** ABDM: dispense as care-context later; no dependency now.
- **M5** NPPA gazette revision missed → compliance calendar reminder monthly; Expiry Watchman scope; manual entry via change control → test: reminder task.
- **M6** WhatsApp gateway down → ready-notification failed; counter announces token → test: `notification.failed` not blocking.
- **M7** Tally export of pharmacy sales (GST) → day book by HSN/rate → verified vs posted (§11.11) → test: sync verification.
- **M8** Online order (doc 03) arrives for Schedule H without uploaded Rx → refused at intake (e-pharmacy draft rules; no Schedule X/NDPS online ever) → test.
- **M9** Home delivery of cold-chain item → allowed only with cold-box + temperature strip; NDPS never → test: category gate.

### N. Clinical safety specifics
- **N1** LASA pair (e.g., **hydrOXYzine / hydrALAzine**, Dobutamine/Dopamine, cefTRIAXone/cefOTAXime) picked → on-screen tall-man + second scan confirm; shelving rule: never adjacent bins → test: LASA pick requires confirm.
- **N2** High-alert (KCl concentrate, insulin, heparin, chemo) → indent label "HIGH ALERT", two-nurse at eMAR; concentrated KCl never floor stock (NABH MOM) → test: floor-stock par for KCl conc = refused.
- **N3** Restricted antibiotic ordered at 02:00 → empiric allowance 24 h, AMS task at 08:00 → test: auto-stop at 48 h.
- **N4** Chemo compounding verification (§11.8) → pharmacist checks BSA dose; day-care path → test: compounding step in workflow.
- **N5** Allergy override at prescribing → verification queue always; pharmacist counsels → test: override → queue.
- **N6** Duplicate: paracetamol in FDC + plain → checks at dispense on resolved batch composition → test: FDC expansion.
- **N7** ADR reported by nurse → `adr.reported`; pharmacist assesses causality (WHO-UMC); serious → PvPI form within 15 days (recommended internal SLA 7 d); batch cross-check across patients → ADR Signal → test: serious ADR creates PvPI task with SLA.
- **N8** Drug recall from CDSCO alert → 3.7; dispensed patients contacted → test: contact list from dispense lines.
- **N9** Look-alike packaging from same manufacturer → LASA group at admission → test.
- **N10** Own medication brought (e.g., patient's thyroxine) → pharmacist identifies (photo, strip), doctor approves continuation; stored in patient bin; eMAR administers unbilled; returned at discharge → test: ₹0 movement terminates on patient (own).
- **N11** Reconciliation at admission: home meds list (typed from strips/photos) vs new orders; omissions flagged to doctor → `medication.reconciled` → test: unmatched home med → task.
- **N12** Discharge reconciliation: discontinued drugs must be explicitly marked; WhatsApp schedule derived only from reconciled list → test: unreconciled → no message.
- **N13** Paediatric syrup: dose in mL vs mg, strength per 5 mL → sig calculator; dose-range check → test.
- **N14** Insulin dispensed, patient has no fridge at home → counselling note; one-vial policy → test: counselling required.
- **N15** Expired batch found on shelf during pick → one-tap quarantine + variance + Expiry Watchman miss incident → test: expired never sellable (legacy rule).

### O. Ward stock & crash carts
- **O1** Crash cart used during code → seal broken; consumption attributed to `code.activated` patient; restock SLA 60 min → test.
- **O2** Seal intact but expiry inside → monthly check task lists items ≤ 30 d → test.
- **O3** Ward borrows from another ward → transfer between locations, never off-book; shortcut "borrow" button creates transfer → test: movement exists.
- **O4** Floor stock consumed for patient but not charted → orphan report (§11.11) → nurse task → test.
- **O5** Ward returns near-expiry floor stock → transfer to pharmacy quarantine → test.

### P. Procurement/consignment/local purchase touchpoints
- **P1** Emergency local purchase at 23:00 (₹15k float) → `local_purchase.recorded`; provisional batch; retro-GRN → test.
- **P2** Consignment stock count vs vendor statement → Plan 14; pharmacy exposes on-hand by consignment ref → test: read interface.
- **P3** Short-expiry received (< 6 months) rejected at GRN (Plan 14) — pharmacy never sees it → boundary test.
- **P4** Rate-contract expired, item still needed → Purchase Officer task; dispense unaffected → test.

**Row count: 114.**

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 09:30, server down for 70 minutes, 180 patients in OPD.** 09:31 `downtime.declared` cannot be emitted — the duty manager declares on paper; PBX broadcast. Pharmacy switches to the downtime kit: printed Rx (every one has a QR + drug lines) + paper dispense slips (pre-printed, serial-numbered) with batch numbers written from the pack; H1 register book (physical, kept in the kit) written by hand; cash receipts from the manual receipt book; narcotics: no OPD narcotics dispensed during downtime (policy), IPD narcotics from ward stock on paper register with two signatures. 10:40 system back. Backfill screen: scan slip serial → scan Rx QR → lines pre-filled → type batch → `occurred_at` from slip; checks run and *warn* but never block backfill; register rows marked backfilled; cash reconciled to the manual receipt book via the downtime-cash reconciler (SoD: not the declarer). Agents: Replenishment and Expiry Watchman are mode-gated and skip the window; Leakage Auditor next morning shows the downtime window as a separate column. Audit afterwards: every dispense has `recorded_at − occurred_at ≈ 70–120 min`, slip serial gaps (a missing serial is a question, not a mystery).

**6.2 Bus accident, 23 casualties at 21:15, one pharmacist in building.** `disaster.declared` → ED floor stock and crash carts opened (seals broken, `crash_cart.opened` ×4); consumption attributed to disaster correlation id, patient attribution deferred (unknown patients get temp UHIDs). Narcotic issue for analgesia: OT sub-store NDPS kit issued to ED under doctor order with ED in-charge as witness (eligible list); balance verified at 02:00 by the night pharmacist + non-custodian. Coverage Resolver pages the on-call pharmacist (T3, duty manager approves). Restocking: Replenishment drafts STAT indents from central store; storekeeper on call. At 06:00 the pharmacy digest lists: 4 carts to restock, 11 patients with consumption not yet on bills (orphan queue), 2 narcotic ampoules wasted-witnessed, zero discrepancies.

**6.3 Registered pharmacist no-show on night shift.** Roster gate should have blocked publication; the fallback happened anyway (sick at 21:00). 22:00 the counter is staffed by an aide: OTC continues; the first Schedule H card refuses HANDED_OVER with "no registered pharmacist on duty" and `pharmacist.absent_flagged` → duty manager + chief pharmacist; Coverage Resolver proposes the locum pool; a temp_role grant with registration number goes live 22:40; until then IPD ward needs are met from floor stock on doctor's order (evented). Post-mortem digest row: 40 minutes of scheduled-dispense outage, 6 patients waited, 0 dispensed unlawfully — the audit trail is the defence.

**6.4 Cold-chain failure discovered at 08:00.** Sensor shows 14 °C since 02:10 (compressor failure); the alert fired to the night pharmacist who acknowledged and moved nothing (human failure). System: `cold_chain.excursion_recorded` at 02:25; batches (insulin ×14, vaccines ×9, some biologicals) auto-QUARANTINE_HOLD at 02:25 — the night dispense of one insulin vial at 05:30 was **refused** by the batch status and the pharmacist took one from the ED fridge (transfer logged). Morning: chief pharmacist reviews manufacturer stability tables (insulin generally tolerates ≤ 30 °C for 28 days; specific vaccines do not) → release insulin with note, destroy vaccines with witness, incident report, maintenance AMC call. Register shows the whole chain. Digest to owner: ₹ value destroyed, root cause, the 3-hour acknowledgement gap as a KPI reading (not a punishment).

**6.5 VIP + MLC + fraud attempt within one hour.** 11:00 a VIP (sealed) admitted; pharmacy sees alias, dispenses on true allergies (E-4). 11:20 an MLC poisoning case: the attendant brings the strips consumed; pharmacist enters own-medication register with MLC flag; release governed by the records workflow. 11:45 a "relative of staff" presents a photographed prescription for 60 tramadol (H1) from an outside doctor with a registration number that does not verify: dispense allowed by law only if the Rx is genuine — pharmacist refuses on professional judgement, logs `dispense.refused_suspected_forgery` NEW with the Rx image; Fraud Sentinel correlates the phone number with two previous refusals across counters. Nothing here needed a manager in the loop; everything is answerable to an inspector.

**6.6 Recall + power + network loss, Saturday 16:00.** CDSCO alert: batch X of a common antibiotic suspension is NSQ (not of standard quality). Chief pharmacist enters recall → freeze at 31 locations in one action; pull tasks dispatched. 16:20 grid fails, generator starts, fibre cut by the same excavation: internet gone, LAN alive (stage-3 on-prem) — or in stage 1 (cloud) the whole app is unreachable: downtime kit (6.1) + the printed recall list from the alert (the recall screen prints one). Ward staff pull physically from the printed list; on restore they scan-confirm the pulls. Dispensed-patient contact campaign waits for WhatsApp connectivity; Recall Agent retries with the P7 ladder. Reconciliation on Monday: received 120, dispensed 71 (patients contacted 68, 3 unreachable → call task), on-hand 44, returned to supplier 44, variance 5 → registered, investigated (two wards had opened bottles in use — cost-centre write-off, evented).

## 7. Compliance, audit & statutory surfaces

| Surface | Statute | System object | Who signs | Retention |
|---|---|---|---|---|
| Retail/hospital sale licence (Form 20/21; 20B/21B wholesale) | D&C Rules 1945 | compliance calendar (`license.expiring`) | owner | — |
| Registered pharmacist supervision | Pharmacy Act 1948 §42; D&C Rule 65(2), 65(15) | on-duty gate; registration validity on user | pharmacist | — |
| Schedule H prescription-only | Rule 65 | schedule gate | — | — |
| Schedule H1 register | Rule 65(3), 97(1)(d) | `reg_schedule_h1` (auto) | pharmacist | 3 years |
| Schedule X | Rule 65(10), 65(15), 66 | `reg_schedule_x` + Rx copy | pharmacist | 2 years |
| NDPS / Essential Narcotic Drugs | NDPS Act 1985; NDPS Rules 1985 as amended 2015 (Rule 52A–52N, RMI) | `reg_narcotics` (Form 3E shape), destruction register | pharmacist + witness; MS | ≥ 2 years (recommend 5) |
| Price control | DPCO 2013 (paras 4–6, 20, 24); Essential Commodities Act | `pharmacy_price_regulation`, min() rule, hard block | chief pharmacist (change control) | 8 y |
| Labelling | Rule 96, 97 | label template with batch/expiry/MRP | — | — |
| GST | CGST Act 2017 §31 (invoice), rate notifications | invoice HSN/rate | — | 6 y from annual return |
| Expired/NSQ/spurious | D&C Act §17A/17B, §18, §27 | expired block; `counterfeit.suspected`; destruction cert | chief pharmacist; inspector | — |
| BMW | BMW Rules 2016 (yellow category: discarded/expired/cytotoxic drugs) | destruction register → BMW manifest (Plan 19) | — | 5 y |
| ADR | PvPI (IPC Ghaziabad), NABH MOM chapter; New Drugs & Clinical Trials Rules 2019 for trial drugs | `reg_adr`, PvPI form export | quality manager (PvPI coordinator) | permanent |
| Telemedicine | TPG 2020 List O/A/B | tele-Rx flag gate | — | — |
| e-pharmacy / home delivery | Draft e-pharmacy rules 2018; state DCA circulars | online intake gate (no X/NDPS) | — | — |
| NABH MOM (medication management) chapter | NABH 5th/6th ed. MOM.1–MOM.11 | formulary, high-alert list, LASA list, storage, prescription audit, ADR, medication errors (incident), near-miss | DTC | — |
| DPDP | DPDP Act 2023 | data classes per §4; consent for WhatsApp; PvPI transfer purpose | DPO | — |
| Cold chain | NABH MOM; drug inspector practice | `reg_cold_chain` | pharmacist | 3 y |

**What the drug inspector walks in and demands:** licence copies; pharmacist registration certificates and duty roster; Schedule H1 register for a date range; Schedule X stock/purchase/sale; NDPS balance, stock, wastage, destruction certificates; cold-chain log for today and the last excursion; expired stock segregation area and destruction records; purchase invoices for a random batch (Plan 14) — **every one is a screen with print/export and a `document.release_logged` event**. NABH assessor adds: DTC minutes (committee machinery §11.19-D 39), medication error/near-miss register (incident module + `pharmacy_interventions`), prescription audit sample, high-alert storage, LASA shelving evidence (photo tasks), crash cart checklists, antibiotic policy and DDD trend.

## 8. Staff KPI & KRA

All event-derived, load-normalised, diagnostic (S10 §2). Formula registry ids proposed as `pharm.*`.

**Pharmacist (counter)** — KRA: right drug/patient/batch; registers beyond reproach.
| id | KPI | Formula | Load context | Gaming vector → resistance |
|---|---|---|---|---|
| pharm.tat | Dispense TAT | median(`dispense.completed` − `dispense.claimed`) | queue depth, lines/cart | claiming late → TAT2 = completed − `prescription.issued` also shown |
| pharm.rx_ahead | Rx-ahead-of-patient % | carts VERIFYING before patient scan | — | none |
| pharm.subst | Substitution-policy compliance | substitutions with consent & rule match ÷ substitutions | — | skipping substitution → generic share shown alongside |
| pharm.partial | Partial-dispense rate | `dispense.partial` ÷ carts | stock-out rate | none — reads as stock signal |
| pharm.manual | Manual-entry rate | scans with `manual_entry` ÷ scans | scanner uptime | — |
| pharm.reg | Register completeness | H1/X rows with all mandatory fields ÷ scheduled dispenses | — | structural (gate) |
| pharm.narc | Narcotic reconciliation | discrepancies ÷ balance checks (target 0) | — | dyad analytics |
| pharm.returns | Return acceptance error | returns later found unsaleable ÷ returns | — | — |

**Clinical pharmacist** — KRA: every IPD order verified; interventions that change care.
| pharm.verif_tat | Verification TAT | median(verified − order.placed) by priority | orders/shift | queue cherry-picking → STAT and routine reported separately |
| pharm.interv_rate | Intervention rate | interventions ÷ orders verified (per 100) | case mix | inflating trivial interventions → acceptance rate paired |
| pharm.interv_accept | Doctor acceptance % | ACCEPTED+MODIFIED ÷ resolved | — | — |
| pharm.recon | Reconciliation completion | `medication.reconciled` at admission ≤ 24 h ÷ admissions | admissions | — |
| pharm.ams | AMS approval TAT & 48-h stop compliance | approvals within 2 h ÷ requests; auto-stops without re-justification | — | — |
| pharm.adr | ADR reports per 1,000 bed-days; serious ADR PvPI within 7 d | — | census | under-reporting reads as low → paired with trigger-tool signal |

**Chief pharmacist / stores** — KRA: formulary current, stock true, nothing expires unseen.
| pharm.stockout | Stock-out % | items below zero at any location × hours ÷ item-hours | seasonality | — |
| pharm.expiry_loss | Expiry loss % | value `batch.destroyed`(expired) ÷ stock value | — | hiding via returns → return-to-supplier value shown |
| pharm.fefo | FEFO compliance | picks not oldest-first ÷ picks | — | structural |
| pharm.accuracy | Stock accuracy | counted = system lines ÷ counted lines | — | count randomisation |
| pharm.coverage | Formulary coverage | 16a coverage endpoint | — | — |
| pharm.coldchain | Excursion count, ack time | — | — | — |
| pharm.near_miss | Near-miss reports (LASA confirms, refused forgeries, held carts) per 1,000 dispenses | — | — | higher is better — reported as safety culture |

**Nurse (pharmacy-facing lines on card 20):** floor-stock count variance; crash-cart check compliance; return-within-shift of unadministered doses.

**Owner's 8 a.m. digest (pharmacy block):** yesterday's pharmacy revenue (OPD/IPD/retail) and its GST split; dispense TAT median and 90th; stock-outs (count, top 5 items); expiry ≤ 30 d value; narcotics: balance verified Y/N and any discrepancy; cold-chain excursions; interventions raised/accepted; AMS approvals pending; ADRs reported; leakage triangle variance value by location; any `pharmacist.absent_flagged`; recalls open.

## 9. AI agents & the copilot — where inference earns its place

| Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Replenishment** | automation | T4 (drafting; PO approval stays human above threshold) | nightly + `stock.below_reorder`; par, on-hand, lead time, 30-day velocity | `indent.drafted` per location; central→sub-store transfers auto-issued below value threshold | Purchase officer for POs; storekeeper picks | manual indent screen | per-agent | job version | dry-run diff vs human indents for 30 days | Class 0 (no PHI) | 16c |
| **Expiry Watchman** | automation | T1 | daily; batches, licences, NPPA revisions, pharmacist registrations | `batch.expiring` 90/60/30; return-to-supplier tasks; red shelves | pharmacist acts | expiry report | per-agent | — | none needed | 0 | 16c |
| **Cold-Chain Sentinel** | automation | T1→T3 (auto-quarantine is a T3 act behind standing DTC approval) | MQTT readings / manual tasks | excursion event, quarantine hold, alert ladder | pharmacist releases | manual log | per-device | — | threshold tests | 0 | 16d |
| **Narcotic Balance Checker** | automation | T0 | daily 06:00; register vs movements vs counts | discrepancy flag, MS notice | — | manual balance | — | — | — | 0 (register has patient names → Class 1 for exports) | 16d |
| **Substitution Suggester** | automation (deterministic over formulary) | T2 | stock-out or `noSubstitution`-false line with cheaper same-moiety batch | suggested line with price delta | pharmacist + patient consent | manual pick | — | rule version | golden fixtures | 0 | 16c |
| **Stewardship Alert** | automation | T1 | restricted order without approval; 48-h/72-h timers; culture result (Plan 17) | AMS tasks, auto-stop flags | AMS approver / doctor | AMS paper form | — | — | — | 1 | 16e |
| **ADR Signal** | agent (inference over de-identified event sequences) | T0 | weekly; dispense lines × incident/vitals/lab events by batch and moiety | ranked "possible cluster" report for PvPI coordinator | quality manager | trigger-tool SQL report (deterministic first stage) | per-agent | model id, prompt version, hashes | precision on seeded synthetic clusters; no patient identifiers | Class 1 tokenised | 16e (post-12a gates) |
| **Pharmacy Leakage Auditor** | automation (scope extension of the 12a Leakage Auditor) | T0 | daily triangle per location | variance report, dyads | billing supervisor / matron reviewers | SQL report | — | — | — | 0 | 16c |
| **Interaction Dataset Loader** | automation | T3 (DTC approval per release) | vendor release file | staged mapping diff, shadow re-run of last 30 days' checks | DTC/chief pharmacist | manual staging | — | dataset version | shadow diff of alert counts | 0 | 16c |
| **Copilot (pharmacist lane 3)** | agent | T2 | "show me why this was held", "draft the intervention note for order X", "which patients got batch Y" | narration over the fact sheet; typed claims cite lines; drafts of intervention text | pharmacist edits/signs | screens | global | copilot §2.4 | copilot eval suite | 1 | post-12a, ops-first ruling (pharmacy counter is a mid-cohort candidate — not clinical-decision but not housekeeping either) |

**Clinical cap:** nothing here changes a dose, releases a hold or approves an antimicrobial; suggester and copilot draft. **Rule wins:** every safety check is deterministic (16a + dataset); the only inference is ADR clustering and narration.

**Three presentation lanes for pharmacy work:** Lane 1 hand-built keyboard-first: OPD dispense counter (scan → F-keys → bill → print) and the IPD verification worklist — highest frequency, lowest diversity. Lane 2 schema-generated: counts, returns, recall pulls, cold-chain manual log, destruction, own-meds register, AMS approvals, LASA group maintenance, price-regulation entry — forms from tool schemas, no bespoke screens. Lane 3 conversation: chief pharmacist's queries (batch trace, why-held explanations, digest questions), nurse "what did pharmacy send for bed 12" — propose→confirm for any state change (e.g., "quarantine batch X" renders the structured action).

**Journey Feed contributions:** `dispense.completed` (what, substituted?, counselled), `dispense.held` + intervention + resolution, `medication.reconciled`, AMS approval, ADR, own-medication verified, return credited, recall contact. Agents post status ("indent dispatched 10:42, received 10:55") before any block.

**Prompt inputs (copilot, concrete):** fact sheet lines = active orders (moiety, dose, route), last 7 days' dispenses (moiety, qty), allergies, weight/age band, renal flag, check results with alert ids, open interventions; **excluded**: names, phone, address, ward bed label, prescriber name (tokenised `[DR-n]`).

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One beep context:** Rx QR → cart opens with checks done, FEFO batches pre-assigned, price computed; target claim→verified ≤ 20 s for a clean cart.
- **Keyboard grammar at counter:** F2 scan, F4 substitute, F6 partial, F8 bill, F9 print label, Esc hold; no mouse for the happy path; interactive < 100 ms (§15).
- **Rx-ahead-of-patient:** cart pre-verified on `prescription.issued`; counter shows "ready" before the patient reaches; target ≥ 80% of carts VERIFYING before scan.
- **Pick-to-light-lite:** printed pick list sorted by shelf address; bin labels with QR; LASA bins colour-coded.
- **Labels:** 2 s thermal label with QR = dispense line id; Hindi/English sig; tall-man for LASA.
- **Batch capture once:** GRN captures GTIN/batch/expiry/MRP; internal barcode printed for packs without GS1; every later touch is a scan.
- **Unit-dose for IPD:** patient cassettes per shift; nurses scan cassette QR at receive; eMAR scans dose.
- **TAT clocks visible:** counter board shows per-cart clock; ward shows indent clock; SLA colours.
- **Worklists, not menus:** verification queue sorted by priority×age; interventions inbox for doctors inside the round screen.
- **Print surfaces:** invoice with salt/batch/expiry/HSN; registers print in statutory column order; recall list prints with location addresses.
- **Tablet at ward:** large targets for receive/return/count; camera scan.
- **Voice:** dictation into read-only search only (deferred-note guardrail); no voice orders.
- **Measured targets (recommended):** OPD dispense TAT median ≤ 8 min, 90th ≤ 15 (corporate benchmark 10–20); IPD routine verification ≤ 30 min, STAT ≤ 10; stock accuracy ≥ 99%; expiry loss ≤ 0.5% of stock value; stock-out < 1% item-days; narcotic variance 0; register completeness 100% (structural).

## 11. Integrations, devices & dependencies

| Device/vendor | Protocol | Notes |
|---|---|---|
| 2D barcode scanners (Zebra DS2208, Honeywell 1470g, Indian: TVS-E, Retsol) | USB HID | GS1 DataMatrix on export packs; most Indian retail packs have only 1D EAN or none → internal labels |
| Thermal label printers (TSC TE244, Zebra ZD230, Citizen) | USB/ETH, ZPL/TSPL | 50×25 mm dispense labels; 38×25 shelf/bin labels |
| Receipt/invoice printer (Epson TM-T82, 80 mm) | USB | GST invoice |
| Cold-chain loggers (Elitech RC-5+, Tempsen, TZone, Rotronic) + IoT gateway (Indian: Tempcube, Wireless Sensors, Ambetronics) | MQTT/HTTP → Mosquitto → TimescaleDB | E-33 pattern; day-one manual verified task acceptable |
| Medical refrigerators (Blue Star MR, Voltas Vestfrost, Godrej) | — | with alarm contacts to gateway |
| Narcotic safe (double-lock, wall-anchored) | — | badge-scan second factor at the workstation, not on the safe |
| Automated dispensing cabinets (Pyxis/Omnicell; Indian: Medikabazaar-supplied) | HL7 v2 / vendor API | Phase 4; events reserved |
| Interaction/dose dataset (FDB / Medi-Span / Micromedex / CIMS) | flat files, local | RFQ rules a–d; loads through staging→governance |
| NPPA ceiling list | gazette PDFs/CSV (nppaindia.nic.in) | manual change-control entry; watch task monthly |
| PvPI | ADR form (PDF/XLS), ADRPvPI app | export only |
| Tally | voucher export (Plan 08/14) | pharmacy sales by HSN |
| WhatsApp/SMS gateway (Plan 10) | existing | ready-for-pickup, schedule, recall contact |
| Online orders (doc 03) | internal API | Rx image intake |

**Edge-service rule:** sensors and any serial device talk to an edge service (mini-PC/gateway), never to core; core consumes MQTT/HTTP. **Dependencies:** Plan 13 (registry — done), Plan 14 (GRN/batch/consignment interface — must precede 16c), 16a/16b (formulary, snapshot card — done), Plan 10 (notifications), Plan 08 (cashier sessions), doc 07/IPD (eMAR events — 16d charge-on-administration switch), Plan 17 (lab values for renal dosing, cultures for AMS — optional), Plan 19 (BMW manifest for destruction), 12a (agent harness before any T3+). **Events consumed:** `prescription.issued`, `order.placed`, `allergy.recorded`, `patient.admitted/transferred/discharged`, `payment.received`, `payer.switched`, `grn.received`, `batch.recalled`, `medication.administered/missed/refused`, `code.activated`, `downtime.declared/ended`, `roster.published`, `credential.blocked`.

## 12. Buy vs build, hardware & rough INR budget

**Build (module):** everything in §3–§4 — it owns tables and workflows and is the leakage/statutory core; no Indian pharmacy SaaS gives the event spine, registers-as-tables, or the min() rule with our billing.
**Buy:** interaction/dose dataset (₹8–12L/yr, RFQ running) · cold-chain sensors/gateway · label/receipt printers · scanners · ADCs later (₹25–60L each — Phase 4, only if measured night-issue volume justifies) · Tally.
**Do not build:** drug knowledge content, GS1 registry, e-pharmacy marketplace.

| Item | Qty (day-one → 610 beds) | Unit ₹ | Total ₹ (day-one / target) |
|---|---|---|---|
| 2D scanners | 4 → 40 | 3,500–6,000 | ~20k / ~2L |
| Label printers | 2 → 20 | 15–35k | ~50k / ~5L |
| Receipt printers | 2 → 10 | 8–12k | ~20k / ~1L |
| Counter PCs/monitors (if not existing) | 2 → 12 | 35–45k | ~80k / ~5L |
| Ward tablets (rugged-ish, 10") | 2 → 40 | 15–25k | ~40k / ~8L |
| Cold-chain loggers + gateway | 3 loggers + 1 gw → 40 + 6 | 4–15k + 15–25k | ~35k / ~5L |
| Medical fridges (if replacing domestic) | 1 → 8 | 45–90k | ~60k / ~6L |
| Narcotic safes | 1 → 6 | 15–40k | ~25k / ~2L |
| Shelf/bin labelling, LASA colour bins | — | — | ~15k / ~1.5L |
| UPS for counter + fridge alarm | 1 → 8 | 8–15k | ~12k / ~1L |
| **Hardware subtotal** | | | **~₹3.5L day-one / ~₹36L at 610 beds** |
| Interaction/dose dataset licence | annual | | ₹8–12L/yr (already provisional in §13) |
| ADCs (optional, Phase 4) | 0 → 6–10 | 25–60L | 0 / ₹1.5–6Cr — **not recommended before measurement** |

## 13. Owner rulings needed

- **O-1 Charge point for IPD drugs** — recommend: per-patient drugs charge on `medication.administered` once eMAR is live; on issue until then (config switch). Why: §11.11 rule, cleanest returns.
- **O-2 NDPS Recognised Medical Institution application** — recommend: apply now (state drugs controller) so morphine/fentanyl stock is lawful before IPD/OT/palliative; go-live gate for NDPS flows.
- **O-3 Retail (walk-in) pharmacy operates as a separate Form 20/21 licensed premises or under hospital licence** — recommend: separate retail licence + retail stock location; hospital pharmacy dispenses only to encounters. Legal exposure item.
- **O-4 Generic substitution default** — recommend: substitute by default unless `noSubstitution`, with patient consent capture; NTI list requires doctor. Doctor notified, not asked.
- **O-5 Prescription validity for repeat dispensing (outside and own Rx)** — recommend: single dispense per Rx unless doctor marks "repeat ×N up to 6 months"; chronic-care repeat within 6 months allowed on pharmacist judgement for non-H1 — needs your policy (H1 never repeated).
- **O-6 Pharmacy discount floor** — recommend: membership/category discounts on pharmacy capped at 10–15% and never below landed cost + 5%; no coupons on Schedule X/NDPS.
- **O-7 Return policy text** — recommend: 7 days, sealed, receipt, not cold-chain/narcotic/X/cut strips; restocking fee nil; refund by original tender.
- **O-8 Empiric allowance for restricted antimicrobials** — recommend 24 h supply, hard review at 48 h; AMS approver named (ID physician or MS delegate).
- **O-9 Auto-verification of unchanged continuation orders** — recommend: yes (deterministic rule), new orders and any change go to a human; needed at 610-bed scale.
- **O-10 Home delivery scope** — recommend: OTC and Schedule H with uploaded Rx within city; no cold-chain until validated cold-box process; never X/NDPS. Legal exposure.
- **O-11 Pharmacist headcount and 24×7 date** — 2–3 now; roster gate makes the third pharmacist a go-live requirement for 24×7 scheduled dispensing. Money.
- **O-12 DTC chair and committee cadence** — name chair (MS or senior physician); monthly; needed for formulary/restricted lists to be "governed definition data".
- **O-13 Charity/free drugs cost centre cap for pharmacy** — recommend monthly cap under §11.11 charity cost centre; approvals above.
- **O-14 ADCs** — recommend defer to Phase 4 pending measured night-issue volume.

## 14. Plan sketch — how this becomes phase documents

**Gates before authoring:** DTC formulary, high-alert list, LASA list, restricted-antimicrobial list signed (clock 1); interaction/dose dataset contract signed and a sample file in hand (clock 2); Plan 14 shipped with the batch/GRN/consignment interface; Plan 13 `store` kind seam confirmed; 12a harness available for T3+ automations (T0/T1 automations can run under the scheduler with the harness's identity rules if 12a is late — fail-open either way); O-1..O-4, O-11 ruled.

- **16c — Stock ledger, stores & OPD dispensing** (first deploy): `store` kind + locations; items/packing/GST/price-regulation; batches via Plan 14 interface; movements; FEFO; OPD dispense workflow (3.1) + retail (3.1b) + substitution; billing integration (min() rule at batch); returns; H1/X registers; expired block; counts + triangle; Replenishment, Expiry Watchman, Substitution Suggester, Leakage scope; label/scanner support; downtime backfill screen. Golden suite: price-rule fixtures per slab and per winner; register completeness mutants; concurrency B1/B2.
- **16d — IPD supply, ward stock, narcotics, cold chain** (with or just before IPD/eMAR plan): indents (3.2), floor stock/par/crash carts (3.3), NDPS/Schedule X vault workflow (3.4) with second factor and witness, daily balance, destruction; cold chain (3.9) manual-first then MQTT; Narcotic Balance Checker, Cold-Chain Sentinel; charge-point switch (O-1); own-medication path; reconciliation tables (eMAR consumes).
- **16e — Clinical pharmacy: verification, interventions, AMS, ADR, recall** (needs dataset loaded): verification workflow (3.5) with dose-range/renal checks; interventions; AMS overlay (3.6) and Stewardship Alert; ADR register + PvPI export + ADR Signal (post-12a gates); recall workflow (3.7) with patient contact arm; LASA groups; dataset loader governance.
- **16f — Pharmacy KPIs, digest, lanes 2/3 surfaces, online/home delivery hooks** (after 30 days of live data): formula-registry entries; digest block; schema-generated forms; copilot pack `pharmacy-counter`; doc 03 online intake.

**Sequencing:** 14 → 16c (can overlap 15's tail) → 16d alongside the IPD cluster's first plan → 16e when dataset lands → 16f after baselines. Each deploy gated on its golden suite + a pharmacist staff walkthrough at the real counter.

**Negative-space question answered:** the absences that are signals in pharmacy — (1) a prescription with no dispense within 2 h while the patient checked out (adherence/abandonment or cash problem); (2) a bed with orders but no indent for 24 h (order never reached pharmacy); (3) an issued narcotic with no administration and no wastage within 4 h; (4) a fridge with no reading for 15 min; (5) a ward with consumption but no census-proportional floor-stock indent (borrowing off-book or hoarding); (6) an intervention with no doctor response by SLA; (7) a restricted antimicrobial past 48 h with no AMS decision; (8) a batch received but never dispensed within 60% of shelf life (dead stock); (9) zero ADRs in a month on a 300-bed census (under-reporting, not safety); (10) a pharmacist shift with zero manual-entry and zero holds (bypass?).

**Department-head interview questions (chief pharmacist, current pharmacy staff):**
1. Walk me through last Saturday night: who dispensed, who witnessed narcotics, what was written where?
2. Which five items stock out most, and what do you do in that hour?
3. When a doctor writes a brand you do not stock, what happens today and who tells the doctor?
4. Show me the last return you accepted and the last you refused. Why?
5. How are H1 register entries kept now, and what does the inspector actually check?
6. Which look-alike pairs have caused a near-miss here?
7. What is in the crash cart, who checks it, how often is it found short?
8. How do you handle the patient's own medicines brought from home?
9. What happens to short-expiry stock — supplier returns, discounts, transfers?
10. Which packs have no scannable barcode? Which come as loose strips/pieces?
11. How do TPA/PMJAY patients' drug bills get split today?
12. What would make you stop trusting the system's stock number?
13. Tell me about the last ADR you saw — was it reported anywhere?
14. Who has fridge keys and what happened the last time the power went at night?

## 15. Open questions & risks

1. **Charge on administration requires eMAR** (doc 07) — if the IPD cluster slips, 16d ships charge-on-issue and the returns path carries more weight; both must be golden-tested.
2. **Indian pack barcoding is inconsistent**; the internal-label-at-GRN cost is real labour at 2,000 OPD/day — measure GRN lines/day in Plan 14 before deciding on pre-printed vs on-demand labels.
3. **Interaction dataset severity mapping** may produce alert volumes that train click-through (16a §1.4 calibration); the shadow re-run at load is mandatory, not optional.
4. **NDPS RMI status and state rules vary**; Form numbers/register formats must be confirmed with the state drugs controller before 16d's register columns freeze.
5. **Retail licence vs hospital dispensing boundary** (O-3) affects which stock location serves which flow — must be ruled before 16c's location seed.
6. **Stage-1 cloud topology** means a fibre cut takes the pharmacy down; the paper kit is the mitigation until stage 2/3; the pharmacy is the OPD floor's most downtime-sensitive desk after billing.
7. **Consignment and free-sample zero-price lines** interact with GST (samples have no supply) — CA confirmation needed for invoice presentation.
8. **PvPI reporting is voluntary for hospitals but NABH expects it**; who signs is O-12's DTC.
9. **16b's snapshot card** must gain a dispense-history section (copilot §2.1 "grows as pharmacy plugs in") — assign to 16e.
10. **Legacy pharmacy system absorption** (E-11 transition boundary map): stock opening balances, open batches and the day of cutover need their own runbook in 16c; a double-running window with the legacy system as safety net is the deliberate edge-case harvest.
