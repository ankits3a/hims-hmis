# 09 — Procurement, Stores, Vendor Management & Consignment — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED · **Roadmap home:** Track A **Plan 14** (first stage-2 module; Plan 15 mini-OT consumes its consignment interface, Plan 16 pharmacy consumes its item/batch/store substrate).

**Executive summary.** This module is the hospital's *procure-to-pay* spine (spec P4) plus the *custody* half of request-to-issue (P3): item master, vendor master, indent → quotation → PO → GRN → supplier invoice → 3-way match → payment run → Tally export, with rate contracts, consignment/loaner ownership, capital equipment intake (capex → installation → warranty/AMC → biomedical), sub-store custody, cycle counts and the leakage triangle. It is **not** pharmacy dispensing (Plan 16 — prescriptions, FEFO picks to patients, Schedule H1/NDPS registers), **not** the biomedical maintenance ticket fabric (§11.12 P5 — this module only *creates* the asset and its AMC/calibration obligations), **not** statutory accounting (Tally stays the ledger; we export vouchers) and **not** a supplier portal (later, §12). Its three hardest problems: **(1) the batch/MRP/expiry truth at the receiving gate** — every downstream safety and price rule (§11.19-C fix 3 `min(tariff, MRP, ceiling)`, FEFO, recalls) is only as good as what the GRN clerk typed at 6 p.m. with a lorry waiting; **(2) consignment stock that the hospital does not own but does dispense** — the implant is in a patient before any PO exists, the GST deemed-supply clock is running, and three parties (vendor, OT, accounts) hold three different counts; **(3) fraud that looks like normal work** — split POs under the approval line, a "new" vendor with the storekeeper's cousin's bank account, short-supplied cartons GRN'd in full, and near-expiry stock accepted for a scheme discount that never reaches the bill.

---

## 1. Frame — what exists, what is locked, what this document adds

**Built today (Phase 1):** kernel events outbox, workflow engine (versioned definitions, SLA timers, ladders — Plan 03), approvals engine with `cumulativeAmount()` over an IST calendar day (Plan 04, C-12 anti-structuring), RBAC + SoD hard pairs (`assertNotSodPair`, Plan 02), scheduler/worker, ops modes + downtime kit, patients, tariff (with a single `sac_code` column carrying SAC for services / HSN for goods), billing (append-only invoices, credit notes, refund vouchers, cashier sessions), notifications gateway, memberships/partners, **formulary** (`formulary_salts` at moiety level, `formulary_medicines` = brand, composition join — the drug half of the item master already exists and this module must reference it, never copy it), global search, user admin. Plan 13 (in flight) gives `resources` with kind `store` — every stock location in this module is a registry resource, not a private table.

**Locked decisions inherited (do not re-litigate; extend only):**
- §10.1 P3/P4 patterns; the **leakage principle** — every item movement terminates on a patient bill or a named cost center.
- §11.10 P2P: aggregated indents → PO against rate contracts + approved vendor list; **three quotes above ₹50k** (configurable, via approvals engine); **GRN with QC at the gate** — quantity + minimum residual shelf-life, short-expiry rejected at receiving (**default < 6 months / 75% rule**); **3-way match PO/GRN/invoice before posting**; Tally export; vendor scorecards (fill rate, TAT, rejection rate) auto-derived.
- §11.10 exceptions: **emergency local purchase ₹15k default float per store, approval-gated, retro-GRN'd** — an escape valve, not a bypass; **batch recall = one-action freeze at every location**; donation stock evented in without payables; rate-contract expiry → renegotiation task; UOM conversions defined **once in the item master, never per transaction**; cycle counts as recurring verified tasks; expiry ladder 90/60/30 → return-to-supplier window → witnessed destruction with certificate; write-offs are evented losses.
- §11.19-C fix 2 (**cash-law layer**): **₹10k/vendor/day cash cap** on petty/emergency purchases with auto-split to bank transfer (Income-tax Act §40A(3)); thresholds are CA-confirmed configuration (§19 open item).
- §11.19-C fix 3 (**regulated-price layer**): item master gains MRP + DPCO/NPPA ceiling with effective dates; **batch-MRP captured at GRN**; consignment scan-on-use obeys `min(tariff, MRP, ceiling)`.
- §11.19-C fix 16 + §11.19-D fix 29: **non-custodian counts**, randomised counter assignment, blind recounts, annual external stock audit.
- §11.19-D fix 1 (**disbursement reconciliation**): monthly three-way HMIS matched-invoice ledger vs Tally payment vouchers vs bank statement; **vendor master incl. bank details under §11.18 change control with owner approval and a cooling-off before first payment to changed details**; vendor-payment anomalies → Fraud Sentinel.
- §11.19-D fix 7: **ownership dimension on stock locations (owned / consignment / loaner)**, excluded from valuation, leakage triangle per ownership class, **GST §31(7) six-month deemed-supply clock per consignment lot**.
- §11.16 OT: loaner implants 3-way matched per case (vendor challan / usage / invoice); loaner sets CSSD-sterilised with BI before use; vendor rep presence logged (`vendor_rep.logged`). §11.16-A: ortho implants are consignment; agreements go past counsel.
- §11.15 / §11.19-E fix 2 / fix 23: **procurement mandates** — no monitor/ventilator without HL7/serial export; PBX with API; **DPDP processor agreement from every vendor whose equipment touches patient data**; `vendor_access.logged` for escorted access.
- §11.11: petty-cash imprest per department with reconciliation tasks (`pettycash.reconciled`); Tally sync verification monthly; owner weekly digest carries vendor scorecards.
- §16 roster: **Replenishment Agent (automation, T4 — drafts indents; POs above threshold still approved)**, **Expiry Watchman (automation, T1 — batches, rate contracts, AMC)**, Leakage Auditor (T0), Fraud Sentinel (T0), Payout Batcher pattern (T3). Automations over inference wherever a rule suffices.
- Plan 08 R4: RCM parked to procurement (lands here); e-invoicing/IRP for *our* outward supplies deferred — this module only *validates* supplier e-invoices.
- S10 SoD hard pairs: **PO approver / GRN receiver**; **stock custodian / cycle counter**; requester / approver; payout preparer / approver.
- Plan 13 §4A (RULED): master-data change control (Class B/C for masters) is its **own governance phase after O1**; until then masters are direct audited writes — this module must be written so that flipping vendor/item masters onto definition-governance is a wiring change, not a rewrite.

**What this document adds:** the full lifecycle set as workflow definitions, the item/vendor/contract/consignment/capex data model, the statutory surfaces (GST ITC eligibility for a largely exempt healthcare supplier, MSMED Act 45-day rule, TDS sections, Drugs & Cosmetics licence checks at vendor onboarding), 100+ edge cases, six chaos walkthroughs, KPIs, and the automation/agent placement with a Plan 14/14b split.

**Scope boundaries & neighbours (who owns which table):**
| Concern | Owner | This module's relationship |
|---|---|---|
| Drug identity (brand, salt, strength, form) | `formulary` | `items` row of class `drug` **references** `formulary_medicines.id`; never duplicates composition |
| Stock locations (stores, sub-stores, consignment bins) | kernel `resources` (Plan 13, kind `store`) | This module owns `stock_ledger` rows keyed by `resource_id` + ownership class |
| Dispensing to patients, FEFO pick, H1/NDPS registers | Plan 16 pharmacy | Pharmacy calls `stores.issue()` interface; consumption events post charges via billing |
| Charge posting, credit notes, GST on sales | billing / tariff | This module emits `material.consumed` with batch-MRP; billing prices it |
| Approvals, SoD, cumulative thresholds | kernel approvals (Plan 04) | Consumer: PO approval, GRN variance, write-off, vendor onboarding, capex |
| Maintenance tickets, PM tasks, calibration execution | P5 task fabric / future biomedical (Plan 20 proposed) | This module *creates* the asset, warranty, AMC, calibration-due schedule and emits `asset.commissioned` |
| Payment execution, ledgers, bank | Tally + bank (bought) | Export vouchers; import bank statement read-only for 3-way disbursement recon |
| Housekeeping/linen/BMW consumables | Plan 19 | Sub-store custody and par levels live here; task fabric there |

---

## 2. Actors, roles & role cards

**Human roles (S10 card numbers where they exist):**
| Role | S10 | Stations in this module | Shift / bundling |
|---|---|---|---|
| **Purchase Officer** | 27 | RFQ/quotes, comparative statement, PO drafting, amendments, rate contracts, vendor negotiation, vendor onboarding request | Day; 1 → 4–5; **never GRN-receives** (SoD) |
| **Storekeeper (central stores)** | 26 | Receiving dock, GRN entry + gate QC, put-away, issue to sub-stores, returns to vendor, counts on *other* locations | Day + evening; 1–2 → 10–14; **never PO-approves** |
| **Pharmacist (GRN QC for drugs)** | 25 | Batch/expiry/MRP verification on drug GRNs, near-expiry acceptance decision, cold-chain check, recall execution | Rides pharmacy roster; 24×7 later |
| **Sub-store custodian** (ward in-charge / OT sister / ICU in-charge / lab in-charge) | — (custody duty of cards 20–24, 29) | Receiving scan at sub-store, par-level view, urgent requests, consumption confirm | Per floor; **never counts own store** |
| **Materials Head** (NEW card proposed — day-one bundled with Purchase Officer, splits at ~100 beds) | new | Approves indents above L1, PO up to L2, variance approvals on stores, vendor scorecard review, rate-contract renewals | Day; bundles with duty manager on nights for emergency purchase approval |
| **Accounts Payable Clerk** (NEW card proposed; day-one = the accountant) | new | Supplier invoice entry / e-invoice IRN verification, 3-way match exceptions, TDS section tagging, MSME due-date tracking, payment run preparation, Tally export | Day; **never prepares AND approves a payment run** |
| **Biomedical Engineer** | 33 | Capex technical spec, pre-installation checklist, installation/commissioning acceptance, warranty & AMC/CMC register, calibration schedule | Day; AMC vendor coordination |
| **Purchase Committee** (NEW — governance body, not a login: Materials Head + Finance + a clinical HOD for the category + owner above L3) | new | Comparative statement sign-off above threshold, capex sanction, vendor blacklist | Weekly sitting; evented via approvals |
| **Duty Manager** | 31 | Night approval of emergency local purchase; downtime declarer for stores | 24×7 |
| **Owner** | governance role (§11.19-D fix 10) | L4 approvals, capex above cap, vendor bank-detail change, blacklist, write-offs above threshold | Two-key deputy pair when unreachable |
| **Internal auditor / CA** (external) | — | Reads registers, samples GRNs, confirms thresholds (40A(3), 269ST, TDS rates, ITC rule 42/43 apportionment) | Quarterly |
| **Vendor representative** | external | Delivery, consignment replenishment, loaner sets, OT presence (`vendor_rep.logged`), portal later | Escorted; DPDP processor agreement where applicable |

**SoD hard pairs (RBAC-enforced; S10 §11 + additions proposed):** PO approver / GRN receiver · requester / approver · custodian / counter · **vendor-master editor / first-payment approver (NEW)** · **AP preparer / payment-run approver (NEW)** · **GRN receiver / return-to-vendor approver (NEW)** · **emergency-purchase buyer / retro-GRN acceptor (NEW)** · comparative-statement drafter / award approver.

**Automation & agent actors (each a first-class RBAC actor, kill switch, heartbeat; detail §9):** Replenishment Agent (automation T4-draft) · Expiry Watchman (automation T1) · Invoice Matcher (automation, NEW, T3) · Quote Comparator (automation, NEW, T2) · Price Variance Sentinel (automation, NEW, T0) · Consignment Reconciler (automation, NEW, T1→T3) · Asset Lifecycle Clock (automation, NEW, T1 — warranty/AMC/calibration under Expiry Watchman) · Leakage Auditor (T0, existing) · Fraud Sentinel — procurement stage (T0, existing, new detectors) · Payment Run Batcher (T3, the Payout Batcher pattern applied to AP) · Invoice Reader (agent, NEW, T2 — OCR/LLM draft of invoice lines from a scanned supplier invoice) · Procurement Copilot (Lane 3, T2 propose→confirm).

---

## 3. Core flows as workflow definitions

All are workflow definitions (§10.2), Class B (Materials Head drafts, owner activates), SLAs `record_only` at go-live except where marked **active**. Escalation ladder default: role holder → Materials Head → Duty Manager → owner SMS (fix 11 dead-end fallback).

### 3.1 Indent (P3 request; Replenishment Agent drafts)
```
draft ─submit→ submitted ─approve→ approved ─issue(partial)→ partially_fulfilled ─issue→ fulfilled → closed
  │                 │                 │                              │
  └cancel→ cancelled└reject→ rejected └convert→ po_raised (when no stock)   └short_close→ closed(short, reason)
```
Roles: draft = custodian/Replenishment Agent; approve = Materials Head (value/category matrix, §3.10); issue = storekeeper; receive-confirm = custodian (two-sided scan, §11.10). SLA: submitted→approved 4 h routine / 30 min urgent (**active** for urgent), approved→issued 8 h / 1 h. Events: `material.requested` · `indent.drafted` · `material.issued` · `material.returned` · NEW `indent.approved` · NEW `indent.short_closed`. Variants: per-patient indent (pharmacy), consignment top-up indent (vendor-fulfilled), inter-store transfer (§3.8).

### 3.2 Quotation / RFQ / comparative statement
```
draft ─send→ sent ─quote_recorded×n→ quotes_received ─compare→ comparative_drafted ─award→ awarded
                    │ (deadline)                                   │
                    └extend / close_short (<3 quotes, reason)       └reject_all→ re_tender
```
Roles: Purchase Officer sends; Quote Comparator automation drafts the comparative statement (landed cost per UoM incl. GST, freight, scheme, credit days, residual shelf-life); award by Materials Head ≤ L2, Purchase Committee > L2. **Three-quote rule ≥ ₹50k** — fewer than three = `tender.degraded` with reason code (sole manufacturer / proprietary / emergency / repeat within contract) and one level higher approval (mirrors the spec's degraded-mode discipline: declared, evented, reconciled). Events NEW: `rfq.issued` · `quote.recorded` · `comparative.drafted` · `tender.degraded` · `award.recorded`.

### 3.3 Rate contract
```
draft ─approve→ active ─(T-60/30/7)→ expiring ─renew→ active(v+1) | ─lapse→ expired
                          └suspend (vendor blacklisted / quality)→ suspended
```
Contract = vendor × item × price × UoM × validity × MOQ × lead time × scheme terms × price-escalation clause. Expiry Watchman fires `rate_contract.expiring` (NEW) → renegotiation task. A PO under an active contract needs no quotes (contract *is* the quote). Auto-derived coverage %: PO value under contract / total PO value.

### 3.4 Purchase order
```
draft ─submit→ pending_approval ─approve→ approved ─send→ sent ─ack→ acknowledged ─grn→ partially_received ─grn→ fully_received → closed
   │                │                                                     │
   └cancel          └reject→ rejected                                     └short_close (reason) / amend→ new version (v+1, delta re-approved)
```
Roles per approval matrix (§3.10). PO amendment = new immutable version; **delta above original approval band re-enters approval** (kills the "approve small, amend big" trick). SLA: pending_approval 24 h (**active** for `urgent`); sent→ack 48 h (vendor SLA, scorecard only). Events: `po.created` · `po.approved` · NEW `po.amended` · NEW `po.sent` · NEW `po.acknowledged` · NEW `po.short_closed` · NEW `po.cancelled`.

### 3.5 GRN (goods receipt) with gate QC
```
draft ─capture lines→ gate_qc ─pass→ accepted → posted
                        │ partial → partially_accepted (rejected lines → return_pending)
                        └fail → rejected (grn.rejected)
```
Gate QC checks (deterministic, per line): qty vs PO (over-receipt tolerance default 0%, under = partial); batch + expiry mandatory for classes `drug|consumable_dated|reagent|implant`; **residual shelf-life ≥ 6 months or ≥ 75% of total shelf-life, whichever lower** (§11.10) else `near_expiry_acceptance` approval by pharmacist + Materials Head with written justification; MRP captured per batch (fix 3), **MRP < landed cost = hard block** (selling below cost or a mis-key); pack/strip/unit conversion from item master; cold-chain items — data-logger/temperature reading mandatory; free goods (scheme) captured as separate zero-price lines with the same batch discipline; damaged/short cartons as rejected lines with photo. Receiver ≠ PO approver (SoD). Posting emits `grn.received` (stock in at `owned` or `consignment` class per PO type) and starts the invoice-match clock. Events: `grn.received` · `grn.rejected` · NEW `grn.line_rejected` · NEW `near_expiry.accepted` · NEW `free_goods.received`.

### 3.6 Supplier invoice → 3-way match → payment
```
recorded ─match→ matched ─approve→ approved_for_payment ─batch→ in_payment_run ─paid→ paid
   │                │ exceptions → on_hold (price / qty / tax / IRN / vendor-doc / MSME) ─resolve→ matched
   └duplicate_flagged                                                                  └dispute→ disputed → debit_note
```
Invoice Matcher automation: PO price vs invoice price (tolerance default ±0.5%, above = hold `price_variance`), GRN accepted qty vs invoiced qty, GST rate/HSN vs item master, **IRN + signed QR validation** where supplier's turnover mandates e-invoice, vendor GSTIN active (GSTN status check nightly, or cached), duplicate invoice number per vendor per FY, MSME flag → due date = min(agreed, 45 days from acceptance) (MSMED Act 2006 §15), TDS section tag (§194C/194J/194H/194I/194Q) for service and high-value goods invoices. Payment Run Batcher (T3) drafts weekly runs: due-date sorted, MSME first, cash-law compliant, exports to Tally + bank NEFT file behind approval. Events: `supplier_invoice.recorded` · `invoice.matched` · NEW `invoice.held` · NEW `invoice.approved_for_payment` · NEW `payment_run.drafted/.approved/.executed` · `settlement.recorded` · `disbursement.mismatch_flagged` · NEW `debit_note.issued` · `tds_credit.reconciled`.

### 3.7 Return to vendor / debit note
```
requested ─approve→ approved ─dispatched→ awaiting_credit ─credit_note_received→ closed | ─timeout(30d)→ escalated
```
Triggers: GRN rejection, near-expiry return window (spec ladder), recall, wrong item, price dispute. Stock leaves at the *received batch cost*; debit note carries GST reversal (ITC reversal where claimed). Return approver ≠ GRN receiver.

### 3.8 Stock transfer between stores & sub-store issue
```
requested → picked (FEFO batch named) → in_transit → received (two-sided scan) | → discrepancy_flagged (same hour) → resolved(adjust/return)
```
In-transit is a location. Discrepancy = variance register row, not a silent adjustment.

### 3.9 Cycle count & variance
```
scheduled ─assign(random non-custodian)→ assigned → counting (blind, no system qty shown) → counted → variance_review → approved(adjusted) | recount_ordered → counting
```
`stock.counted` · `stock.variance_flagged` · `stock.adjusted` (approval-gated, reason code, ₹ impact). Annual external audit rides the same definition with `external=true`.

### 3.10 Approval matrix (recommended default, configurable data — corporate-standard bands)
| Band | Value (per PO, cumulative per vendor per IST day via `cumulativeAmount`) | Approver | Quotes |
|---|---|---|---|
| L0 | ≤ ₹5k under contract | auto-approve (Replenishment/Materials) | none |
| L1 | ≤ ₹50k | Materials Head | contract or 1 |
| L2 | ₹50k–₹5L | Materials Head + Finance | 3 (or `tender.degraded`) |
| L3 | ₹5L–₹25L | Purchase Committee | 3 + comparative |
| L4 | > ₹25L or any capex > ₹10L | Owner | tender + committee |
Clinical urgency classes fixed per request type (Plan 04 Q4): `routine|urgent|emergency`; emergency = act-first-review-after with justification.

### 3.11 Consignment lot (§11.19-D fix 7 generalised)
```
challan_received → in_stock(consignment) ─scan_on_use→ deployed → po_auto_raised → invoiced → matched → paid
        │                  │ ─return→ returned_to_vendor        │
        │                  └(150 d) aging_flagged (GST §31(7) 180-day deemed supply)
        └rejected_at_gate
```
`consignment.deployed` (existing) = charge + patient sticker + vendor liability in one event; PO auto-created at contract price; monthly `consignment.reconciled` (NEW) three-way: vendor statement / our ledger / physical count. Loaner sets: `loaner_set.received/.returned` + CSSD BI gate before use.

### 3.12 Capital equipment (capex)
```
requested ─justify(clinical need, utilisation forecast, spec sheet, data-export mandate)→ committee_review ─sanction→ sanctioned ─tender→ awarded ─po→ ordered ─delivered→ site_ready_check ─install→ installed ─acceptance_test(+AERB/licence where applicable)→ commissioned → in_service
                                                                                                                                              └acceptance_failed → rework / reject
```
`asset.commissioned` (NEW) creates the registry `device` resource, the asset register row (cost, date, depreciation class, location, custodian), warranty clock, AMC/CMC contract shell, calibration schedule, and the training-record obligation. Asset Lifecycle Clock (under Expiry Watchman) fires `warranty.expiring`, `amc.expiring`, `calibration.due` (NEW). Retirement: `asset.condemned` (NEW) — condemnation committee, e-waste/BMW disposal certificate, Tally write-off voucher.

### 3.13 Emergency local purchase (petty cash float)
```
need_declared ─approve(duty mgr/Materials)→ approved ─bought→ purchased ─retro_grn(next working day)→ retro_grn'd ─reconcile→ closed
```
Float ₹15k/store default; **₹10k/vendor/day cash cap** hard block with auto-split prompt to UPI/NEFT (40A(3)); invoice photo mandatory; `local_purchase.recorded` · `pettycash.reconciled`. Emergency-purchase rate is a scorecard KPI trending down.

### 3.14 Vendor onboarding / suspension / blacklist
```
draft ─docs→ docs_pending ─verify→ verified ─approve(owner above ₹ threshold or drug/implant class)→ active ─suspend→ suspended ─reinstate→ active
                                                                                                    └blacklist(committee)→ blacklisted (terminal for 3 yrs)
```
Mandatory docs by class: GSTIN (validated), PAN, bank proof (cancelled cheque; penny-drop verify), MSME/Udyam certificate (optional but drives §15 timers), **Drugs & Cosmetics Act wholesale licence Form 20B/21B (drugs), Form 20/21 as applicable**, DPDP processor agreement (device/software vendors touching PHI), Legal Metrology/ISI/CE/USFDA where relevant for devices, AERB type-approval (radiology). Bank-detail change = owner approval + **cooling-off 7 days before first payment** (fix 1). `vendor_master.changed` · NEW `vendor.suspended` · NEW `vendor.blacklisted`.

---

## 4. Data model sketch

Module folder `stores` (or `procurement` — one module, two manifests would violate "one module owns its tables"; **one module `materials`** recommended with sub-folders). All money in integer paise; all quantities in base UoM (integer) with conversions applied at capture.

| Table | Key columns (sketch) |
|---|---|
| `items` | id · code · name · class (`drug|consumable|consumable_dated|reagent|implant|asset|service|stationery|linen|gas`) · `formulary_medicine_id?` (FK, drug class only) · generic_group_id · hsn_code · gst_rate_id · base_uom · `dpco_ceiling_paise?` + effective_from · `mrp_default_paise?` · abc_class (A/B/C by value) · ved_class (Vital/Essential/Desirable) · storage_class (`ambient|cold_2_8|frozen|narcotic|flammable`) · batch_tracked bool · serial_tracked bool · shelf_life_days · active · updated_by/at |
| `item_uoms` | item_id · uom · to_base_multiplier (box=10 strip; strip=10 tab) · is_purchase_uom · is_issue_uom · barcode_gtin? |
| `item_barcodes` | item_id · gtin/ean · pack_level · vendor_id? (vendor-specific codes) |
| `vendors` | id · legal_name · trade_name · gstin (+ status, last_verified_at) · pan · msme_udyam_no? · msme_class · bank (masked; change-controlled) · payment_terms_days · credit_limit? · class flags (drug_licensed, device, service, consignment) · status (`draft|active|suspended|blacklisted`) · blacklist_until · rating_cache |
| `vendor_documents` | vendor_id · type (`drug_licence_20B|21B|gst_cert|pan|cheque|udyam|dpdp_agreement|iso|aerb`) · number · valid_from/to · file_ref · verified_by |
| `vendor_bank_changes` | vendor_id · old/new (masked) · requested_by · approved_by · cooling_off_until · first_payment_allowed_at |
| `rate_contracts` / `rate_contract_lines` | vendor_id · validity · line: item_id · uom · price_paise · moq · lead_days · scheme (buy X get Y) · escalation_clause · status |
| `rfqs` / `rfq_quotes` / `comparative_statements` | rfq → quotes per vendor per line (price, tax, freight, credit days, shelf-life offered, validity) → comparative (landed cost per base UoM, rank, award reason, degraded flag + reason) |
| `indents` / `indent_lines` | from_resource_id · to_resource_id (store) · urgency · line: item_id · qty_requested/approved/issued · par_snapshot · patient_id? · cost_center_id? |
| `purchase_orders` / `po_lines` / `po_versions` | vendor_id · type (`standard|consignment_auto|capex|service|blanket`) · version · contract_id? · rfq_id? · totals · approval_id · status mirror · line: item_id · uom · qty · price · gst · scheme_free_qty · delivery_date |
| `grns` / `grn_lines` | po_id? (null for retro/emergency/donation) · vendor_id · challan/invoice ref · received_by · qc_by · store_resource_id · line: po_line_id? · item_id · batch_no · mfg_date · expiry · mrp_paise · qty_received/accepted/rejected · reject_reason · free_goods bool · temp_log_ref? · photos |
| `stock_batches` | item_id · batch_no · expiry · mrp_paise · landed_cost_paise · vendor_id · grn_line_id · ownership (`owned|consignment|loaner|donated`) · recall_status |
| `stock_ledger` (append-only) | resource_id · batch_id · qty_delta (base) · reason (`grn|issue|transfer_out|transfer_in|consume|return|adjust|destroy|recall_freeze`) · ref (event id) · patient_id? · cost_center_id? · actor · occurred_at/recorded_at |
| `stock_balances` (materialised, per resource × batch) | qty_on_hand · qty_reserved · qty_frozen |
| `par_levels` | resource_id · item_id · min · max · reorder_qty · review_period · auto_indent bool |
| `stock_counts` / `count_lines` / `variance_register` | schedule · counter (≠ custodian) · blind · counted_qty · system_qty_at_freeze · variance_qty/₹ · approval_id · reason_code |
| `consignment_lots` | vendor_id · challan_no · challan_date · item/batch/serial · qty · deemed_supply_deadline (challan+180 d) · status · reconciled_at |
| `supplier_invoices` / `invoice_lines` / `match_results` | vendor_id · invoice_no (unique per vendor per FY) · date · irn? · irn_verified · gst breakup · tds_section? · tds_amount · msme_due_date · hold_reasons[] · matched_at · approved_by |
| `debit_notes` / `vendor_credit_notes` | linked to returns/disputes; GST reversal lines |
| `payment_runs` / `payment_run_lines` | prepared_by · approved_by (≠) · mode (NEFT/UPI/cash≤cap) · tally_export_ref · bank_file_hash · executed_at |
| `disbursement_recon` | month · hmis_total · tally_total · bank_total · mismatches[] |
| `petty_cash_floats` / `local_purchases` | store_resource_id · float_paise · purchase: vendor (free-text allowed, PAN if > ₹ threshold) · cash_paid · 40A3_split_flag · invoice_photo · retro_grn_id |
| `capex_requests` / `assets` / `asset_contracts` / `calibration_schedule` | request (justification, forecast, committee minutes ref) · asset (tag, resource_id kind `device`, cost, date, depreciation class, warranty_to, custodian, location) · contract (`AMC|CMC|warranty`, vendor, scope, uptime clause, penalty, PM frequency) · calibration (due, done, certificate ref, traceability) |
| `cost_centers` / `budgets` | code · department · owner role · budget lines per FY per category · committed (open POs) · actual (GRN posted) |
| `vendor_scorecards` (derived nightly) | vendor_id · period · fill_rate · on_time_% · rejection_% · price_variance_% · invoice_accuracy_% · score |
| **Statutory registers as tables** | `grn_register` (view over grns, printable), `purchase_register_gst` (GSTR-2B-shaped: invoice, GSTIN, taxable, CGST/SGST/IGST, ITC eligible/blocked), `msme_dues_register` (§22 MSMED disclosure), `tds_deduction_register`, `stock_destruction_register` (witnessed, certificate), `schedule_h1_purchase_register` (drug GRN lines of H1 items — Plan 16 co-owns), `asset_register`, `consignment_register`, `cash_purchase_register` (40A(3) evidence) |

**Registry kinds needed (Plan 13):** `store` (central stores ×4 categories, each sub-store, in-transit pseudo-store, consignment bin, quarantine/recall bin, expired-awaiting-destruction bin), `device` (assets commissioned by §3.12). Propose attribute `ownership_classes_allowed` on store resources.

**Retention:** GST records 72 months from annual return due date (CGST §36); Income-tax 6 AY + (8 years practical); Drugs & Cosmetics purchase records 3 years (Rule 65) — H1 register 3 years; NDPS 2 years+; asset register life of asset + 8 years; stock ledger permanent (append-only, partition by year).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.**

### A. Item master, UoM & identity
- **A1** Vendor invoices "Paracetamol 500 — 1 box" where the box is 20 strips this month and 25 last month → conversion fixed in `item_uoms`; GRN captures *vendor pack* and computes base qty; mismatch with challan units flagged → test: GRN of 1 box posts 200 tabs; changing multiplier requires master change with effective date and never rewrites history.
- **A2** Same salt, two brands, two vendors, one par level → par levels sit on `generic_group_id`; Replenishment drafts on the group, purchase chooses the contract brand → test: group on-hand sums both brands.
- **A3** Item created twice with spelling variants ("Syr. Amox" / "Amoxycillin syrup") → duplicate-detect on formulary FK + strength + form; merge tool re-points ledger (no delete) → test: merge preserves ledger sum.
- **A4** Barcode on the carton is vendor-specific, not GTIN → `item_barcodes` allows per-vendor codes; scan resolves or prompts "map this code?" (storekeeper, evented) → test: unknown code never silently creates an item.
- **A5** HSN rate changes by notification (e.g., 12% → 5%) mid-contract → `gst_rate_id` effective-dated; PO carries rate at creation; GRN/invoice validate against rate on *invoice date* → test: invoice dated after change matched at new rate, older at old.
- **A6** Item class flips from consumable to dated-consumable (batch now mandatory) → existing balances without batches move to a synthetic `LEGACY-UNK` batch with expiry unknown, excluded from FEFO, count-forced within 30 days → test: issue from LEGACY blocked for dated classes after grace.
- **A7** Serial-tracked asset consumable (e.g., a probe) → `serial_tracked` items require one line per serial at GRN; issue by serial → test: duplicate serial rejected.
- **A8** DPCO ceiling revised downward while stock on hand has batch-MRP above new ceiling → charge rule `min(tariff, MRP, ceiling)` handles sale; stores flags batches for vendor price-difference claim → test: `ceiling.revised` produces claim task per affected batch.

### B. Vendor master & onboarding
- **B1** New vendor's GSTIN is "cancelled" on GSTN → onboarding blocked; existing vendor's GSTIN cancelled → status auto-suspended, open POs flagged, ITC on invoices after cancellation date blocked → test: nightly GSTIN check flips status and emits `vendor.suspended`.
- **B2** Vendor bank changed by email "please update our account" → change requires owner approval + document + 7-day cooling-off; first payment to new account needs a callback record → test: payment run rejects a line whose vendor has `first_payment_allowed_at > now`. (§11.19-D fix 1)
- **B3** Vendor is MSME but never told us; sends Udyam cert after 60 days of unpaid invoices → interest liability computed from acceptance date on registration date-effective basis, flagged to CA; future invoices timed at 45 days → test: msme_due_date recomputed on cert upload; §43B(h) disallowance risk row in register.
- **B4** Drug vendor's Form 20B licence expires → Expiry Watchman warns 60/30 days; expired = drug POs blocked, consumables continue → test: PO of class `drug` to expired-licence vendor fails; `stationery` PO succeeds.
- **B5** Same PAN, two vendor rows (branches) → allowed with `parent_vendor_id`; cumulative-day cash and TDS thresholds aggregate at PAN → test: two ₹6k cash payments to two branches same day trip 40A(3) split.
- **B6** Storekeeper's relative registers as a vendor → declaration-of-interest field on onboarding; Fraud Sentinel cross-checks vendor bank/phone/address against staff master (hashed) → test: match yields `fraud.signal` row, not a block (T0).
- **B7** Vendor blacklisted mid-PO → open POs frozen, GRNs against them require Materials Head override with reason; consignment stock of that vendor must be reconciled and returned within 30 days → test: blacklist emits tasks for each open PO and consignment lot.
- **B8** Vendor rep requests OT presence for an implant case → `vendor_rep.logged` with escort; rep never touches the HMIS; consignment usage scan by OT staff only → test: rep identity is not a user.

### C. Indent, par levels & replenishment
- **C1** Ward indents 50 units of an item with par max 10 → line auto-capped with "exceeds par" flag; override needs reason → test: approved qty ≤ max unless override event present.
- **C2** Replenishment Agent drafts an indent at 02:00 during downtime → automation is mode-gated (backfill/downtime) and skips; on recovery re-evaluates par-minus-on-hand once → test: no duplicate indents after downtime recovery.
- **C3** Two custodians submit urgent indents for the same last 5 units → issue is transactional; second gets short-issue + auto-PO/emergency path → test: on-hand never negative under concurrent issue.
- **C4** Par level for an item that hasn't moved in 180 days → Replenishment proposes par reduction (T2 draft to Materials Head) → test: dead-stock report lists it; no auto-change.
- **C5** Indent for a patient who was discharged before issue → issue blocked with "encounter closed"; pharmacy returns to stock → test: `material.issued` with closed encounter rejected.
- **C6** Seasonal surge (dengue) doubles consumption in a week → par recomputation uses 4-week moving average with surge flag; Replenishment drafts larger, still approval-bound above L0 → test: draft qty follows demand; approval required above band.
- **C7** Sub-store custodian on leave, replacement doesn't know the tablet → indent via Lane-2 generated form or Lane-3 copilot ("ward 3 needs 2 boxes of gloves") → propose→confirm renders the structured indent → test: confirmation produces same `material.requested` payload as the form.

### D. Quotations, tender & contracts
- **D1** Only two vendors exist for a proprietary reagent → `tender.degraded` with reason `sole/limited source` + evidence (OEM letter); approval one band higher → test: award without degraded flag and < 3 quotes fails.
- **D2** Lowest quote has 4-month residual shelf-life offer → comparative ranks on *effective cost* (expected wastage) and flags shelf-life below rule; award requires near-expiry justification → test: rank ≠ price rank when shelf-life penalty applies.
- **D3** Quote in a different UoM (per 100 vs per strip) → normalised to base UoM landed cost before comparison → test: per-base cost equal across quotes of same price.
- **D4** Quote validity lapses before award → award blocked; re-confirm task to vendor → test: award on expired quote fails.
- **D5** Rate-contract price escalation clause triggers (input cost index) → contract line versioned; PO after effective date picks new price; earlier POs unchanged → test: price by PO date.
- **D6** Contract vendor repeatedly short-supplies; spot buys at higher price → price-variance vs contract accumulates as *claim* against vendor (contract clause); scorecard drop; renewal task carries the numbers → test: variance ledger sums per contract.
- **D7** Two quotes arrive from vendors sharing a phone number/address (cartel/shell) → Fraud Sentinel signal on comparative → test: signal row present, award still human.

### E. PO lifecycle & amendments
- **E1** PO of ₹48k then amended to ₹1.2L after approval → delta re-enters L2 approval; v1 stays immutable → test: `po.amended` with delta above band spawns approval; GRN against v2 blocked until approved.
- **E2** Split POs: three POs of ₹45k same vendor same day → `cumulativeAmount(payee, day)` = ₹1.35L → L2 required on the third; retrospective report on splits per requester → test: third PO auto-escalates. (C-12)
- **E3** PO sent to the vendor by WhatsApp PDF; vendor ships against a cancelled PO → GRN against cancelled PO refused; goods held in quarantine pending return → test: GRN with status `cancelled` PO fails; quarantine location gets stock.
- **E4** Blanket PO (annual gases contract) → releases per delivery against the blanket; running total vs ceiling → test: release beyond ceiling blocked.
- **E5** PO for capex without committee sanction ref → blocked for `capex` type → test: `capex_request_id` mandatory.
- **E6** Vendor delivers 30 days late; item bought locally meanwhile → PO short-closed with reason `late`; scorecard on-time hit; local purchase linked → test: short-close carries `local_purchase_id`.
- **E7** Same item on two open POs from two vendors (duplicate ordering) → draft-time warning "open PO exists"; approval sees it → test: warning payload lists open PO ids.

### F. GRN, batch, expiry, MRP
- **F1** Expiry printed as "08/2027" → stored as last day of month (31-08-2027) per Drugs & Cosmetics convention → test: parser yields month-end.
- **F2** Batch with expiry 5 months away, 25% discount offered → gate flags; near-expiry acceptance only for fast movers (projected consumption before expiry ≥ qty) with pharmacist + Materials Head approval; discount must reduce landed cost, MRP unchanged → test: acceptance without consumption forecast fails.
- **F3** Same batch number on two GRNs with different expiries (vendor error or relabel) → hard stop; pharmacist resolves → test: batch uniqueness per item enforced.
- **F4** MRP on strip ₹120, vendor invoice ₹130/strip → `MRP < landed cost` hard block; reason: mis-key or fraud → test: block + `grn.line_rejected`.
- **F5** Free goods "10+1" → 1 unit as zero-price line same batch; landed cost of the 11 = paid/11; MRP same → test: valuation = paid total; ledger qty = 11.
- **F6** Excess delivery 105 vs 100 → over-receipt tolerance 0% default: 5 rejected or "accept excess" needs approval + PO amendment → test: accepted qty ≤ PO qty without approval.
- **F7** Delivery arrives 21:30, storekeeper gone, security signs challan → `grn.provisional` (NEW) by duty staff: cartons counted, stock into quarantine, not issuable; storekeeper completes gate QC next morning → test: provisional stock not visible to FEFO pick.
- **F8** Cold-chain vaccine arrives with a warm cold-box, no data logger → hard reject for `cold_2_8` unless logger reading in range; `coldchain.excursion` event → test: GRN of cold class without temp reading blocked.
- **F9** Damaged carton discovered at put-away after GRN posted → post-GRN rejection via return flow within 48 h; stock ledger reverses; not an edit of GRN → test: GRN row immutable, reversal row present.
- **F10** Vendor invoice arrives with the goods but PO was never raised (habitual verbal ordering) → GRN allowed as `no_po` class only under emergency/local purchase with approval; else refuse delivery → test: no_po GRN requires approval id.
- **F11** Two storekeepers receive the same PO partially at the same time → line-level locking; second GRN sees remaining qty → test: sum of GRN qty ≤ PO qty under concurrency.
- **F12** Batch already recalled by CDSCO alert arrives fresh → recall list checked at gate; recalled batch cannot be accepted → test: `batch.recalled` set blocks GRN line.
- **F13** GRN clerk keys expiry 2072 instead of 2027 → sanity bound (shelf-life ≤ item max); typo blocked → test: expiry > mfg + shelf_life_days ×1.2 rejected.
- **F14** Implant with serial + UDI barcode → GS1 UDI parsed (GTIN, lot, expiry, serial) into fields; manual entry allowed with double-key → test: UDI parse fixture.
- **F15** Donated stock (NGO camp) → GRN class `donation`, ownership `donated`, no payable, valued at MRP for insurance/records, cannot be sold above zero unless policy → test: no `supplier_invoice` link allowed.

### G. Invoice matching, GST, TDS, MSME, cash law
- **G1** Supplier invoice GST 12% but item master says 5% → hold `tax_mismatch`; AP resolves by master correction (change-controlled) or vendor credit note → test: hold reason recorded; ITC not claimed until resolved.
- **G2** Invoice number reused by vendor next FY → uniqueness per vendor per FY; same FY duplicate = `duplicate_flagged` → test: second insert same FY fails.
- **G3** Supplier with AATO > ₹5 Cr sends invoice without IRN → hold `irn_missing`; ITC ineligible until valid e-invoice → test: vendor flag `einvoice_mandatory` forces IRN.
- **G4** Invoice for goods GRN'd across two GRNs → many-to-many match; partial match posts partial → test: match quantity aggregation.
- **G5** ITC for a largely exempt healthcare supplier → ITC eligibility by cost-center taxable ratio (CGST Rules 42/43); pharmacy retail = eligible, ward consumables under exempt health services = blocked → register shows eligible vs blocked → test: same invoice split by cost center gives different ITC.
- **G6** Invoice paid after 180 days → ITC reversal with interest (CGST §16(2) proviso) → Payment Run flags "ITC reversal due" at day 170 → test: aging job emits at 170.
- **G7** Vendor hasn't filed GSTR-1, invoice absent in GSTR-2B → ITC not claimable; `gstr2b_missing` hold on ITC (not on payment) → test: monthly 2B import marks lines.
- **G8** Service invoice (AMC ₹2L) → TDS §194J (technical 2%) or §194C (contract 1%/2%) tagged by AP with CA-configured mapping per service class; TDS deducted at credit or payment whichever earlier → test: net payable = gross − TDS; TDS register row.
- **G9** Goods purchases from one vendor cross ₹50L in FY and hospital turnover > ₹10 Cr → §194Q 0.1% TDS on excess; vendor may already collect TCS — precedence rule → test: threshold tracker emits at ₹50L.
- **G10** Emergency purchase ₹14k cash from a chemist at 2 a.m. → 40A(3) cap ₹10k/vendor/day: system splits ₹10k cash + ₹4k UPI, or blocks with reason; disallowed if forced → test: cash line > cap rejected; `40A3_split_flag` set. (fix 2; thresholds CA-confirmed — O-3)
- **G11** Transporter paid ₹30k cash (limit ₹35k for transporters) → vendor class `transporter` uses its own cap → test: cap by class.
- **G12** Vendor demands cash for an ₹80k implant → 269ST applies to the *receiver*, but hospital policy: no cash above cap; also anti-kickback signal → test: cash mode unavailable above cap.
- **G13** MSME invoice disputed within 15 days (MSMED §15 proviso) → dispute logged with date stops the clock legitimately; undisputed = 45-day clock → test: `msme_due_date` unchanged by dispute logged after day 15.
- **G14** RCM supply (GTA freight, legal fees, security agency) → invoice tagged `rcm`; hospital self-invoices and pays tax; ITC per eligibility → test: RCM line creates output-tax voucher for Tally.
- **G15** Credit note from vendor for rate difference after payment → applied against next payment; never cash refund without approval → test: net-off in next run.
- **G16** Price variance +0.4% (within tolerance) on 200 lines → auto-matched; +0.6% → hold; Price Variance Sentinel reports vendors "living at 0.49%" → test: tolerance boundary + pattern report.
- **G17** Payment run approved but bank file rejected for one line (IFSC invalid) → line back to `approved_for_payment`; others paid; `payout.bounced` analog NEW `payment.bounced` → test: partial execution recorded per line.
- **G18** Tally shows a payment voucher with no HMIS match → monthly disbursement recon flags `disbursement.mismatch_flagged` → task to AP + digest line → test: recon fixture with orphan voucher.

### H. Consignment & loaner
- **H1** Implant used at 23:00, patient billed, vendor never told → `consignment.deployed` auto-creates PO + vendor notification; monthly statement reconciliation → test: deployed qty = auto-PO qty.
- **H2** Consignment lot idle 170 days → `consignment.aging_flagged` at 150; return or convert to purchase before 180 (GST §31(7)) → test: aging event at day 150.
- **H3** Vendor's statement lists 12 stents used, our ledger 10 → reconciliation difference task; OT record review; either two unrecorded uses (charge leakage + patient-safety traceability gap) or vendor error → test: diff report lists case-level candidates.
- **H4** Consignment item expired on shelf → vendor's loss, but hospital must not dispense; frozen and returned; ledger shows return, no write-off → test: expired consignment cannot be deployed.
- **H5** Loaner set arrives 1 h before surgery, not yet sterilised → BI gate blocks use (§11.16); case delayed or postponed, evented → test: `loaner_set.received` without `cssd.load_sterilized` blocks `implant.recorded`.
- **H6** Implant deployed then explanted intra-op (wrong size) → opened-but-unused implant is *charged to vendor or hospital per agreement*, never to patient unless used; second implant charged → test: two `consignment.deployed`, one `consignment.wasted` (NEW), one patient charge.
- **H7** Consignment vendor blacklisted → all lots frozen, returned; cases needing implants re-sourced → test: blacklist cascades to consignment bins.
- **H8** Vendor sends consignment on a *tax invoice* not a delivery challan → wrong document class; AP does not record as payable; return/correct → test: consignment GRN refuses `invoice` doc type.
- **H9** Patient's TPA disputes implant price → invoice line carries batch, UDI, MRP, sticker image ref; price = min(tariff, MRP) → test: line payload completeness.

### I. Sub-stores, transfers, counts, leakage
- **I1** Ward receives 10, scans 8 → same-hour discrepancy task; in-transit holds 2 → test: in-transit balance until resolved.
- **I2** Ward in-charge counts her own store → `sod.violation_blocked`; count reassigned randomly → test: assignment excludes custodian.
- **I3** Blind count shows +30 units (more than system) → positive variance is *also* a signal (unrecorded receipt / unbilled return) → test: positive variance flagged with same weight.
- **I4** Issued 100 gloves, billed 40, counted 55 → leakage triangle: 5 unexplained; per-location pattern → Leakage Auditor row → test: triangle arithmetic fixture.
- **I5** Cycle count during active issuing → count freezes system qty at start; movements during count reconciled by ledger timestamps → test: variance excludes post-freeze moves.
- **I6** Sub-store hoards (par max exceeded repeatedly) → report; not a block → test: hoarding indicator.
- **I7** Transfer between two sub-stores directly (ward to ward) → allowed only as evented transfer with both scans; no "borrowing" → test: unscanned move impossible to record except via variance.
- **I8** Expired batch found in ward → freeze, return to central expired-bin, destruction with witness + certificate, `batch.destroyed`; write-off value evented → test: destruction requires two actors + certificate ref.
- **I9** Narcotics/psychotropics stock (Schedule X / NDPS) in central store → this module holds custody events only; register semantics are Plan 16's; two-person issue enforced here already → test: NDPS-class issue needs witness actor.
- **I10** Stock adjustment "to make it match" → every adjust needs reason code + approval + ₹ impact; patterns of small adjustments by one user → Fraud Sentinel → test: adjust without approval fails.

### J. Capex, installation, AMC, calibration
- **J1** X-ray unit ordered without AERB type-approval / eLORA registration plan → capex checklist blocks sanction for `radiation` category without AERB fields → test: mandatory field per category.
- **J2** Equipment delivered, room not ready (power, earthing) → `site_ready_check` state with facility tasks; warranty start negotiated as *commissioning date* not delivery → test: warranty_from = commissioned_at.
- **J3** Acceptance test fails (image quality) → `acceptance_failed`; payment milestone held (70/20/10 default) → test: milestone invoice hold reason `acceptance_pending`.
- **J4** Monitor bought without HL7 export → spec mandate field `data_export_capability` required for `patient_monitoring` category; sanction blocked → test: mandate enforced. (§11.15)
- **J5** AMC expires; vendor keeps servicing informally → `amc.expiring` at 60/30; expired = PM tasks still generated but flagged "no contract"; renewal task → test: PM generation independent of contract.
- **J6** Calibration overdue for a NABH-critical device → `calibration.due` → device flagged in registry (`status: calibration_overdue`); use not blocked by this module (clinical modules decide) → test: registry attribute set.
- **J7** Asset moved wards without record → asset custodian transfer flow; annual physical asset verification → test: asset location = registry parent.
- **J8** Condemnation of a ventilator → committee, e-waste vendor certificate, Tally disposal voucher, registry `retired` → test: `asset.condemned` cascade.
- **J9** Software subscription (e.g., PACS licence) as recurring capex/opex → `service` PO blanket with renewal clock under Expiry Watchman → test: renewal task.
- **J10** Vendor's engineer needs remote access to a device on the LAN → `vendor_access.logged`, time-boxed; DPDP processor agreement on file else blocked → test: access without agreement refused.

### K. Emergency purchase, downtime & partial failure
- **K1** Server down, oxygen cylinder vendor at gate → paper GRN from sealed kit (serial range), cylinders serialised on paper; backfill with `occurred_at` → test: backfill serial reconciliation report shows every paper serial.
- **K2** Approvals engine unreachable (worker down) for emergency PO → act-first-review-after class for `emergency` urgency; justification mandatory; review queue → test: emergency PO records `approval_pending_review`.
- **K3** Payment run half-exported when Tally export fails → export idempotent by run id; re-run produces identical file; no double voucher → test: hash equality on re-export.
- **K4** GSTN API down for GSTIN validation → cached status with `stale_since`; onboarding allowed as `provisional` for non-drug vendors; drug vendors wait → test: fail-open with flag.
- **K5** Barcode scanner dead at dock → keyboard entry with double-key of batch/expiry; flagged `manual_entry` for audit sampling → test: manual GRNs sampled at higher rate.
- **K6** Replenishment Agent kill switch pulled → par-level worklist still shows suggestions computed by deterministic SQL view; humans indent manually → test: no dependency of the indent screen on the agent process.
- **K7** Petty cash float exhausted at night, second emergency → duty manager can approve a one-time float top-up (evented), reconciled next day → test: float negative impossible.
- **K8** Two-hour power+network loss mid cycle-count → count sheet printed at start; counts entered later with `occurred_at`; system-qty freeze timestamp preserved → test: variance computed against freeze snapshot.

### L. Fraud, leakage & gaming
- **L1** Fake vendor with real GSTIN of a defunct firm → GSTN status + bank penny-drop name match to legal name; mismatch blocks activation → test: name similarity < threshold blocks.
- **L2** Storekeeper GRNs 100, receives 90, vendor gives 10 to him privately → random re-count of recent GRNs by non-custodian (Fraud Sentinel picks); vendor scorecard + count variance correlation → test: sampling job selects GRNs within 48 h.
- **L3** Purchase officer awards to a higher quote citing "quality" → award reason mandatory, committee sees delta; repeated pattern per officer → signal → test: award with non-lowest requires reason code.
- **L4** Near-expiry accepted at discount, discount not passed to landed cost → gate captures invoice price per line; landed cost derived, not typed → test: landed cost computed from invoice only.
- **L5** Kickback via "free goods" delivered but not recorded → scheme terms on contract; expected free qty vs recorded → variance signal → test: contract scheme vs GRN free lines.
- **L6** Ghost PO: PO + GRN + invoice all by colluding pair → SoD prevents same person; three-way match plus random physical verification of high-value GRNs; bank payee name check → test: SoD assertion on GRN receiver vs PO approver.
- **L7** Same invoice submitted twice with a suffix ("/A") → fuzzy duplicate detection (amount + date + vendor) → hold → test: fuzzy match fixture.
- **L8** Emergency purchase used routinely (bypass) → emergency rate KPI, per-store; above 2% → Materials Head review; per-requester pattern → test: KPI formula.
- **L9** Splitting capex into "consumables" to dodge committee → item class `asset` by value rule (> ₹50k unit or capitalisation policy) auto-classifies → test: unit price > threshold forces class review.
- **L10** Stock adjusted down before audit, up after → Fraud Sentinel: adjustment timing vs count schedule → test: pattern report.
- **L11** Vendor rep "borrows" back consignment stock without challan → every consignment movement needs vendor challan ref; rep has no system access → test: unreferenced consignment decrement impossible.
- **L12** Approver approves own department's indent as requester (bundled night role) → `assertNotSodPair` on requester/approver even when bundled → test: bundled role still blocked.

### M. Privacy, VIP, staff, language, accessibility
- **M1** Per-patient indent for a sealed/VIP patient → indent shows encounter token, not name; consignment vendor statement carries case id only → test: no PII in vendor exports.
- **M2** Staff-as-patient implant → same alias rules; vendor rep in OT sees no identity → test: alias on OT consignment sticker.
- **M3** Storekeeper reads Hindi only → GRN screen bilingual; item names transliterated searchable (Devanagari search per 11h) → test: Hindi search fixture.
- **M4** Vendor invoice photo contains patient names (dispatch to patient direct) → invoice images stored under procurement class, not clinical; OCR agent input scrubbed → test: Invoice Reader payload has no patient fields.
- **M5** Accessibility: dock tablet in gloves → large touch targets, scan-first flow; keyboard fallback → test: UX budget checks.

### N. Scale & integration
- **N1** 2,000 OPD/day, 610 beds: ~80 GRNs/day, 12k SKUs, 40 sub-stores → ledger partitioned by month; balances materialised; count scheduling covers A-class monthly, B quarterly, C annually → test: perf budget: GRN post < 300 ms, balance query < 100 ms at 5M ledger rows.
- **N2** Vendor sends e-invoice JSON / GST portal 2B download → import adapters as edge-service style parsers (never in request path) → test: 2B CSV fixture.
- **N3** Tally XML import fails on a ledger name mismatch → vendor ↔ Tally ledger mapping table; unmapped = export blocked for that vendor with task → test: mapping required.
- **N4** Bank statement import (read-only CSV) with a debit not in HMIS → orphan-debit task (E-25 analog) → test: recon fixture.
- **N5** Supplier portal (later) submits ASN/invoice → same API as internal entry, vendor identity as external actor class → test: portal invoice = `supplier_invoice.recorded` with actor type `vendor`.
- **N6** GS1/UDI scanning of implants with concatenated AIs → parser library fixture per manufacturer (Stryker, J&J DePuy, Meril, SMV) → test: 10 real barcode fixtures.

### O. Timing, backdating, data quality
- **O1** GRN entered 3 days after physical receipt → `occurred_at` = challan/receipt date, `recorded_at` = now; MSME/ITC clocks run from *acceptance* (occurred) → test: due date from occurred_at.
- **O2** Invoice date before GRN date (advance invoice) → allowed; match waits for GRN; 180-day ITC clock from invoice date → test: match state `awaiting_grn`.
- **O3** Backdated PO to cover an emergency purchase → PO `created_at` immutable; retro-GRN class is the legal path; a PO dated before its own approval is impossible → test: retro flow only.
- **O4** Rate contract validity in the past at approval → rejected → test: validity check.
- **O5** Financial-year rollover (1 April) → invoice numbering uniqueness per FY; budget lines new FY; open POs carry over with committed amounts → test: FY boundary fixture.
- **O6** Batch expiry today at 23:59 → FEFO excludes from issue on expiry date itself (conservative) → test: boundary.

**Row count: 103.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 09:00 — six lorries, one storekeeper, server fine, scanner dead.** 09:05 four vendors' deliveries queue; the only 2D scanner is dead. System: GRN screen falls to keyboard mode with double-key on batch/expiry and marks every line `manual_entry`; Fraud Sentinel's sampling raises the re-count probability of these GRNs to 100% within 48 h. Humans: storekeeper does count-only provisional GRNs (`grn.provisional`) into quarantine so lorries leave; pharmacist completes gate QC batch-by-batch through the day. Agents: Replenishment sees quarantine stock as *not available* and does not cancel its pending indents; Expiry Watchman ignores provisional lines. Paper: challans stapled and photographed. Backfill: the provisional→posted transition carries `occurred_at` = challan time. Audit trail: two-stage GRN with actor per stage, re-count task, scanner-down incident ticket to biomedical.

**6.2 Wednesday 14:30 — server down for 3 hours mid-payment-run and mid-GRN.** Duty manager declares downtime. AP had approved a payment run; bank file not yet generated. System on recovery: run state is `approved_for_payment` (DB-persisted); export idempotent by run id; Tally export re-tried once. GRNs during downtime on serially-numbered paper forms from the store's sealed kit; oxygen cylinders written by serial. Humans: storekeeper issues on paper issue slips with ward signature (two-sided). Agents: all mode-gated automations pause; on `downtime.ended` Replenishment recomputes once. Backfill screen: paper serials must all be entered or voided; the reconciliation proves every serial and every rupee. Audit: `downtime.declared/ended`, every backfilled event with `occurred_at` ≠ `recorded_at`, reconciliation report signed by duty manager (≠ declarer? — SoD is declarer/cash-reconciler; stores reconciliation by Materials Head).

**6.3 Friday 18:00 — implant case tomorrow 08:00, consignment shelf empty, vendor rep unreachable.** OT indent for a 6-hole DCP plate: consignment bin shows zero (used Tuesday, not scanned — a `consignment.deployed` never fired). System: OT booking shows "implant availability: NOT CONFIRMED" (Plan 15 consumes the interface); Consignment Reconciler flags Tuesday's case as candidate (implant recorded in OT note, no consignment scan). Humans: OT sister scans the sticker from Tuesday's case file → late `consignment.deployed` with `occurred_at` Tuesday → auto-PO, patient charge orphan cleared (charge.orphan report had it); purchase officer calls a second consignment vendor under contract; emergency local purchase path if needed (implant > ₹10k → NEFT, not cash). Agents: nothing acts autonomously; SLA Chaser nudges the vendor contact task. Audit: late-scan event with the gap explained, orphan charge closed, vendor statement will now match.

**6.4 Month-end — GST 2B mismatch, MSME vendor threatening interest, CA at the door.** 2B import shows 14 invoices missing (vendors didn't file). System: ITC holds on those lines, register shows eligible/blocked/2B-missing; MSME register shows 3 invoices at day 41 — Payment Run Batcher had drafted them first; one is on `price_variance` hold — the hold does *not* stop the MSME clock (only a dispute logged within 15 days would have) so the run pays it and opens a debit-note dispute in parallel. CA walks in: `purchase_register_gst`, `msme_dues_register`, `tds_deduction_register`, `cash_purchase_register` are tables — printed with QR. Humans: AP chases vendors for GSTR-1 filing (task per vendor). Audit: every hold, release, and MSME interest exposure computed and dated.

**6.5 Tuesday 02:00 — night nurse needs an out-of-stock antibiotic; petty cash; a chemist that wants cash.** Ward sub-store zero, central store zero (contract vendor short-supplied). System: urgent indent → stock-out branch → emergency local purchase request to duty manager (phone browser); ₹10k/vendor/day cap enforced: ₹12,400 bill → ₹10k cash + ₹2,400 UPI from hospital UPI, or two chemists. Duty manager approves with justification; invoice photo uploaded; retro-GRN next morning by the storekeeper (SoD: buyer ≠ acceptor); batch/expiry captured then; patient charge posts from administration (Plan 16) with the retro batch. Agents: Replenishment already had an open PO — the short-supply is a vendor scorecard hit and a contract claim. Audit: `local_purchase.recorded`, split flag, retro GRN linked, emergency-rate KPI increments for that store.

**6.6 Thursday 11:00 — VIP implant case + CDSCO recall alert + a suspicious vendor bank change, same hour.** 11:02 CDSCO alert for a stent batch: pharmacist triggers `batch.recalled` → one-action freeze across every location including the cath-lab consignment bin; OT list shows the VIP case's planned stent batch frozen → alternate batch selected; nothing about the VIP's identity leaves the OT surface (alias on consignment sticker). 11:20 an email asks to change the stent vendor's bank account: AP raises `vendor_bank_change` → owner approval required + 7-day cooling-off; Fraud Sentinel notes the request came 3 days after a large invoice was approved — signal row. 11:40 the frozen batch is returned to vendor with debit note; the recall register self-writes. Audit: freeze event with location list, alternate-batch usage, bank-change request with cooling-off timestamp, fraud signal, return + debit note — all in one correlation graph.

---

## 7. Compliance, audit & statutory surfaces

| Statute / standard | Surface in this module | Register table | Retention |
|---|---|---|---|
| CGST/SGST Acts — §16 ITC conditions, §31(7) consignment deemed supply, §36 records, Rules 42/43 apportionment, Rule 55 delivery challan, e-invoice (Rule 48(4)), e-way bill (Rule 138) | ITC eligibility per line/cost center, 180-day payment clock, IRN validation, challan-vs-invoice document class, inbound e-way bill number capture > ₹50k | `purchase_register_gst`, `consignment_register` | 72 months from annual return |
| Income-tax Act — §40A(3)/(3A) cash > ₹10k/person/day (₹35k transporters), §269ST (receipts), §194C/194J/194H/194I/194Q TDS, §43B(h) MSME timing, §11 application (trust) | Cash cap + auto-split, TDS tagging + deduction register, MSME-linked disallowance flags, capex application reporting | `cash_purchase_register`, `tds_deduction_register` | 8 years practical |
| MSMED Act 2006 §15/§16/§22 | 45-day (or agreed ≤45) due date, 15-day dispute window, compound interest at 3× RBI bank rate, half-yearly MSME Form-1 (MCA, if applicable) / audit disclosure | `msme_dues_register` | 8 years |
| Drugs & Cosmetics Act 1940 & Rules — Rule 65 purchase records, licences 20B/21B, Schedule H1 register, Rule 104A cold storage | Vendor licence gate, batch/expiry/MRP at GRN, recall freeze, cold-chain evidence | `schedule_h1_purchase_register` (co-owned Plan 16), `vendor_documents` | 3 years min |
| DPCO 2013 / NPPA / Legal Metrology (Packaged Commodities) Rules 2011 | Ceiling attributes with effective date, MRP capture, price-difference claims | `items` history | — |
| NDPS Act / Schedule X | Two-person custody events; registers in Plan 16 | — | 2+ years |
| BMW Rules 2016 | Expired stock destruction certificate, condemned assets disposal | `stock_destruction_register` | 5 years |
| AERB (radiation equipment) | Capex category gate: type-approved model, eLORA registration, RSO named | `assets` attributes | life of asset |
| NABH (5th ed.) — MOM chapter (medication storage, recalls), FMS (equipment inventory, calibration, AMC), ROM/HRM (SoD) | Recall drill evidence, calibration currency, asset inventory, near-expiry register | `asset_register`, `calibration_schedule`, recall log | ongoing |
| DPDP Act 2023 | Processor agreements for device/software vendors; vendor-facing exports carry no patient identity; invoice images are non-clinical class | `vendor_documents` | per DPIA |
| Companies Act / Trust accounting | Fixed-asset register, depreciation class, condemnation minutes | `asset_register` | permanent |

**Who signs what:** GRN — receiver + QC (pharmacist for drugs); near-expiry acceptance — pharmacist + Materials Head; variance — approver ≠ custodian; destruction — two witnesses + certificate; payment run — preparer + approver; vendor bank change — owner; capex — committee + owner above cap; comparative statement — committee/officer per band.

**What an inspector demands and gets in one click:** drug inspector — purchase records by batch with vendor licence numbers; GST officer — purchase register with ITC eligible/blocked and IRN evidence; income-tax auditor — cash purchase register with split evidence and MSME dues; NABH assessor — asset list with calibration status, recall drill trail, expired-stock destruction certificates; internal auditor — SoD violation attempts (`sod.violation_blocked`), variance register, emergency purchases by store.

**DPDP data classes:** vendor PII (PAN, bank) = financial-sensitive, masked in UI, change-controlled; staff identity in actor fields; patient identity appears only via `patient_id` on per-patient indents/consignment usage and is never exported to vendors.

---

## 8. Staff KPI & KRA

All event-derived, load-normalised, diagnostic (S10 §2). Formulae target the KPI formula registry (deferred note 5).

**Purchase Officer (27)** — KRA: never stock out, never overpay, provably.
| KPI | Formula (events) | Normalisation | Gaming vector → resistance |
|---|---|---|---|
| PO cycle time | median(`po.approved` − `indent.approved`) by urgency | per urgency class, per line count | Approving in bulk late Friday → measured per PO, not per batch |
| Rate-contract coverage % | Σ PO value with contract_id / Σ PO value | by category | Padding contracts with junk items → coverage weighted by value |
| Emergency purchase rate | count(`local_purchase.recorded`) / count(`po.created`) | per store, per month | Reclassifying emergencies as routine → emergency defined by class of GRN (no_po) |
| Vendor fill rate (portfolio) | Σ GRN accepted / Σ PO qty on due date | per vendor | Short-closing POs to hide → short-close reasons counted |
| Price variance vs contract | Σ(invoice − contract) / Σ contract | per category | — |
| Degraded-tender share | count(`tender.degraded`) / count(awards ≥ ₹50k) | — | Inflating "sole source" → committee reviews reasons quarterly |

**Storekeeper (26)** — KRA: physical equals system, always provable.
| KPI | Formula | Normalisation | Gaming |
|---|---|---|---|
| Stock accuracy | 1 − Σ|variance| / Σ counted value | by ABC class | Counting own store → SoD blocks |
| GRN gate TAT | median(`grn.received` − dock arrival / challan time) | by lines per GRN | Provisional GRNs left open → open-provisional aging KPI |
| Issue TAT to sub-stores | median(`material.issued` − `indent.approved`) | by urgency, lines | — |
| Expiry-on-shelf incidents | count(`batch.destroyed` where owned) value | per store | Hiding expired stock → blind counts find it |
| Manual-entry share | GRN lines `manual_entry` / total | — | — |
| Discrepancy resolution time | median(resolved − `stock.variance_flagged`) | — | — |

**Pharmacist (GRN QC)** — near-expiry acceptance rate and its wastage outcome (accepted lines expired unused / accepted lines); recall execution time (`batch.recalled` → all locations frozen); cold-chain rejections.

**AP Clerk (NEW)** — auto-match rate (`invoice.matched` without hold / total); hold aging; MSME on-time payment % (paid ≤ due); ITC reversal incidents (180-day); duplicate-invoice catches; Tally export exceptions. Gaming: releasing holds without resolution → hold release requires reason and is sampled.

**Biomedical Engineer (33)** — calibration currency %; AMC coverage of critical devices; commissioning TAT (delivered → in_service); acceptance-fail rate per vendor.

**Materials Head (NEW)** — approval TAT by band; variance approvals per store; contract coverage; vendor scorecard review completion; budget vs actual by cost center (committed + actual ≤ budget; overrun flagged at 90%).

**Owner's 8 a.m. digest lines for this department:** open POs above L3 awaiting owner; emergency purchases yesterday (count, ₹, stores); GRN holds > 48 h; near-expiry acceptances; batches expiring ≤ 30 d by value; consignment lots > 150 d; MSME invoices due ≤ 7 d; vendor bank-change requests pending; variance ₹ yesterday; fraud signals count; budget lines > 90%. Weekly: vendor scorecards, leakage triangle per ownership class, ITC blocked ₹, contract renewals due.

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied: deterministic first (law 6). Only two candidates here need a model.

| Candidate | Kind | Tier | Trigger / inputs | Output | Human sign-off | Fail-open path | Kill scope | Provenance | Eval / guardrail | DPIA class | Ships |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Replenishment Agent** (existing roster) | automation | T4-draft (drafts; L0 auto-approves ≤ ₹5k under contract; above = approval) | nightly + `stock.below_reorder`; par, on-hand, open PO/indent, 4-wk demand, lead time | `indent.drafted` / draft PO under contract | Materials Head above L0 | Par worklist is a SQL view; manual indent | per-agent; global halt | rule version stamp in event | golden par fixtures; never negative; no duplicate open indent | none (no PHI) | Plan 14 |
| **Expiry Watchman** (existing) | automation | T1 | daily; batches (90/60/30), rate contracts (60/30/7), AMC/warranty/calibration, vendor licences, consignment aging (150 d) | tasks + digest lines | — | reports still queryable | per-agent | — | date-boundary fixtures | none | Plan 14 |
| **Invoice Matcher** (NEW) | automation | T3 (auto-post matched invoices within tolerance; holds otherwise) | `supplier_invoice.recorded`, `grn.received`, 2B import | `invoice.matched` / `invoice.held` | AP releases holds; payment run approval | manual match screen | per-agent | tolerance config version | boundary fixtures ±0.5%; duplicate fuzzy | financial-sensitive vendor data | Plan 14 |
| **Quote Comparator** (NEW) | automation | T2 | `quote.recorded` ×n | comparative statement draft (landed cost, shelf-life penalty, rank) | award by human | manual comparative | per-agent | formula version | UoM normalisation fixtures | none | Plan 14 |
| **Price Variance Sentinel** (NEW; a Fraud Sentinel detector) | automation | T0 | nightly | vendors near tolerance edge, split-PO patterns, award-to-non-lowest patterns, adjustment timing vs counts, staff↔vendor identity matches (hashed) | none (report) | — | rides Fraud Sentinel | — | precision on seeded fraud fixtures | staff + vendor identifiers, hashed | Plan 14 |
| **Consignment Reconciler** (NEW) | automation | T1 → T3 (auto-PO on `consignment.deployed` is T3 behind contract) | `consignment.deployed`, monthly vendor statement import, counts | auto-PO, reconciliation diff tasks, aging flags | Materials Head on diffs | manual PO | per-agent | — | diff fixtures | patient_id present internally, never exported | Plan 14b |
| **Asset Lifecycle Clock** (NEW; under Expiry Watchman) | automation | T1 | `asset.commissioned`, contract dates | warranty/AMC/calibration tasks | — | — | shared | — | — | none | Plan 14b |
| **Payment Run Batcher** (Payout Batcher pattern) | automation | T3 | weekly; approved invoices, due dates, MSME flags, cash law, bank-change cooling-off | `payment_run.drafted` + NEFT file + Tally XML behind approval | AP approver ≠ preparer | manual run | per-agent | file hash in event | idempotent export test; cap tests | financial | Plan 14b |
| **Invoice Reader** (NEW) | **agent** (OCR + LLM extraction) | T2 draft | uploaded invoice image/PDF (no PHI; scrubbed anyway) | draft `supplier_invoice` lines + draft GRN lines (batch/expiry/MRP) for human confirm | AP/storekeeper confirms every line | type it | per-agent | model id, prompt version, input/output hash (§16) | field-level accuracy eval ≥ 98% on 200 Indian invoice fixtures; never auto-posts; numeric sanity bounds | vendor financial data only; provider under DPA | Plan 14b (flag-inert until 12a governance) |
| **Procurement Copilot** (Lane 3 over the 12a tool catalog) | agent | T2 propose→confirm | staff ask ("why is the Cipla invoice on hold?", "raise an urgent indent for ward 3: 2 boxes gloves") | rendered structured action or answer with cited event ids | human confirmation IS the API call | Lane-2 generated screens | 12a runtime | 12a stamps | 12a evals | asker's permissions; delegated authority | after 12a, ops pilot cohort |

**Presentation lanes for this department:** Lane 1 hand-built keyboard/scan-first screens — **GRN gate** (scan → lines → batch/expiry/MRP → QC → post, sub-second per line) and **PO approval inbox** (one-key approve/reject with cumulative-day context). Lane 2 schema-generated worklists — indents, holds, counts, contracts expiring, capex states, vendor onboarding docs (the middle tail). Lane 3 — stores/AP staff are in the ops pilot cohort with housekeeping (deferred note 3).

**Journey Feed contributions:** per-patient indents, consignment deployments (implant sticker + batch + vendor liability) and recall freezes affecting a patient's batch appear on the patient's feed as structured posts; nothing procurement-internal (prices, vendors) is shown on clinical surfaces.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep GRN:** scan UDI/GS1 or vendor barcode → item + batch + expiry + serial pre-filled; keyboard path for the rest; a 30-line GRN in < 4 min (target). Lines reject at capture, not at posting.
- **Pre-filled from PO:** GRN opens from the PO barcode on the printed PO (QR on every printed doc, §7); vendor challan number and expected lines pre-loaded; only deviations typed.
- **Landed cost derived, never typed:** invoice price + freight apportionment + scheme → per-base-UoM cost; MRP typed once per batch with the `MRP ≥ cost` guard.
- **Approval inbox with context:** every PO approval shows contract price vs quoted, cumulative-day vendor total, open POs for the same item, vendor score, budget line burn — one screen, one key.
- **Two-sided scans** at sub-store receipt (§11.10) with same-hour discrepancy — accuracy without a reconciliation department.
- **Blind counts on a handheld** — counter never sees system qty; variance computed server-side.
- **TAT clocks visible:** GRN gate age, hold age, MSME days-left, contract days-left on worklists; active alerts only for oxygen/gases stock and emergency approvals (§10.3).
- **Printing:** PO, GRN, return note, debit note, comparative statement, payment advice all with QR and version; Hindi/English item names.
- **Mobile:** dock tablet (GRN), ward handheld (receiving scan, counts), phone browser for approvals (Materials Head/duty manager/owner).
- **Targets:** auto-match ≥ 85% of invoices; GRN gate median < 30 min from arrival; PO cycle (routine) < 24 h; stock accuracy > 99% (A-class); expiry write-off < 0.5% of stock value; emergency purchases < 2% of POs; MSME on-time 100%; perf budgets per §15.

---

## 11. Integrations, devices & dependencies

| Integration | Mechanism | Rule |
|---|---|---|
| Tally (bought) | XML voucher export (purchase, debit note, payment, RCM self-invoice, asset capitalisation); monthly sync verification (§11.11) | Export idempotent by document id; vendor↔ledger mapping table; never write into Tally from request path |
| Bank | NEFT bulk file (bank format); statement CSV import read-only (fix 1 three-way recon) | Edge-style importer; hashes stored |
| GSTN | GSTIN status check (public search / GSP API), GSTR-2B JSON import, IRN QR signature verification (public key) | Cached, fail-open with stale flag; no ITC claim on stale |
| Vendors | PDF PO by WhatsApp/email via Plan 10 gateway; later supplier portal (vendor as external actor class) | Portal invoices flow through the same `supplier_invoice` API |
| Barcodes | GS1 (GTIN/lot/expiry/serial, UDI), vendor codes, our own item labels (Code-128/QR) | Parser fixtures per manufacturer |
| Cold chain | USB/Bluetooth data loggers (CSV) at GRN; later MQTT fridge sensors on the utility pattern | Reading mandatory for `cold_2_8` |
| Registry (Plan 13) | `store`/`device` kinds; status attributes (`calibration_overdue`) | Reference only |
| Plan 16 pharmacy | `stores.issue()`, `stores.reserve()`, batch/MRP read; H1/NDPS registers there | Interface, no table access |
| Plan 15 mini-OT | consignment availability read; `consignment.deployed` emitter (OT scan) | Interface |
| Plan 19 housekeeping/BMW | sub-store par for linen/consumables; destruction certificates to BMW manifest | Events |
| Biomedical (Plan 20 proposed) | consumes `asset.commissioned`, contracts, calibration schedule; emits PM/breakdown tasks | Events |
| Events consumed | `material.consumed`, `charge.posted` (leakage triangle), `downtime.declared/ended`, `approval.granted/rejected`, `batch.recalled`, `consignment.deployed`, `implant.recorded`, `roster.synced` (counter eligibility) | |

Indian market examples: 2D scanners Zebra DS2208 / Honeywell Voyager 1470g; label printers TSC TE244 / Zebra ZD230; Android handheld Zebra TC21 or Urovo DT40; data loggers Elitech RC-5 / Testo 174T; cold-chain fridges with probes (Vestfrost/Haier pharma).

---

## 12. Buy vs build, hardware & rough INR budget

**Build (own tables + workflow):** everything in §4 — this is a core module by the §9 rule. **Buy:** Tally (exists), bank NEFT rails, GSTN/GSP access (₹10–25k/yr if a GSP is used for 2B/IRN convenience), e-invoice verification is free (public keys), barcode/UDI parsing library (open source GS1 parser), OCR (Tesseract free; cloud OCR/LLM via 12a `InferenceClient` under DPA for Invoice Reader). **Do not build:** supplier portal in Plan 14 (defer), vendor e-tendering, TDS return filing (CA + Tally), fixed-asset depreciation engine (Tally).

| Item | Qty (day-one → 610 beds) | INR |
|---|---|---|
| 2D barcode scanners (dock ×2, pharmacy store ×2, sub-stores) | 4 → 40 | ₹6–9k each → ₹35k → ₹3L |
| Label printers (item/batch labels, asset tags) | 1 → 6 | ₹12–22k each |
| Android handhelds for counts/receiving | 2 → 25 | ₹18–55k each → ₹60k → ₹8L |
| Dock tablet + stand | 1 → 4 | ₹15–20k each |
| Cold-chain data loggers | 4 → 30 | ₹3–8k each |
| Asset tags (polyester/metal QR) | 500 → 8,000 | ₹8–15 each |
| Handheld for owner/committee approvals | phones exist | — |
| **Day-one total** | | **~₹1.5–2.5L**; 610-bed ~₹14–18L (rides the LAN fit-out flag in §13) |

---

## 13. Owner rulings needed

- **O-1 Approval bands (§3.10).** Recommend L0 ≤ ₹5k under contract auto; L1 ₹50k; L2 ₹5L; L3 ₹25L; L4 owner above. Why: corporate-standard, keeps the owner out of routine POs while cumulative-day aggregation stops splitting.
- **O-2 Near-expiry acceptance rule.** Recommend spec default (≥ 6 months or ≥ 75%, lower) + fast-mover exception with pharmacist + Materials Head sign-off and a consumption forecast. Why: unconditional refusal starves short-shelf-life items (vaccines, some reagents).
- **O-3 Cash-law thresholds as CA-confirmed config** (40A(3) ₹10k / ₹35k transporters; 269ST ₹2L). Recommend: adopt statute values now, CA confirms before go-live (§19 already lists this).
- **O-4 GST ITC posture.** Recommend: per-cost-center eligibility with pharmacy retail eligible and exempt-service consumption blocked (Rules 42/43), CA validates the apportionment method. Why: over-claiming ITC is the audit finding that costs; the register must show blocked ITC as cost.
- **O-5 MSME policy.** Recommend: pay MSMEs at ≤ 30 days regardless of agreed terms, and log disputes only within 15 days. Why: §43B(h) disallowance + interest exceed the working-capital benefit.
- **O-6 Vendor bank change cooling-off = 7 days, owner approval always.** Recommend yes (fix 1 leaves duration open).
- **O-7 Capitalisation threshold.** Recommend ₹50k unit value or any item with warranty/AMC → asset class; below = consumable. Why: NABH equipment inventory + depreciation practice.
- **O-8 Consignment agreements standard clauses** (return of expired at vendor cost, monthly statement, 150-day review, sticker/UDI mandatory, rep conduct, DPDP) — counsel review already in flight; recommend the module refuses consignment GRNs from vendors without a signed agreement on file.
- **O-9 Capex committee composition and cap** (recommend Materials Head + Finance + category HOD + biomedical; owner above ₹10L; two-key deputy pair when unreachable per fix 10).
- **O-10 Emergency float and cap per store** (recommend ₹15k central/pharmacy, ₹5k wards/OT; duty manager approves at night).
- **O-11 Blacklist duration and criteria** (recommend 3 years; triggers: fake documents, repeated short supply after two notices, kickback evidence, GSTIN cancellation for fraud).
- **O-12 Invoice Reader activation** — inference on vendor invoices (no PHI) via a DPA-covered provider after 12a governance; recommend yes, flag-inert until then.
- **O-13 Payment run cadence and signatories** (recommend weekly Thursday; AP prepares, Finance approves, owner above ₹10L per run or any new-bank-detail payee).

---

## 14. Plan sketch — how this becomes phase documents

**Plan 14 — Procurement & Stores core (Track A first).** Sections/tasks: (1) `materials` module skeleton, manifest, permissions, registry `store` kinds seeded (central ×4, quarantine, in-transit, expired-bin); (2) item master + UoM + barcodes + drug-class FK to formulary + HSN/GST + DPCO fields (fix 3) + ABC/VED; (3) vendor master + documents + GSTIN validation + bank change cooling-off + status lifecycle (workflow def); (4) rate contracts + RFQ/quotes + comparative (Quote Comparator automation) + degraded-tender; (5) indent workflow + par levels + Replenishment Agent (harness from 12a runtime or the 08.5 scheduler with agent identity if 12a is not yet live — name the seam); (6) PO workflow + versions + approval matrix on Plan 04 with `cumulativeAmount`; (7) GRN gate with QC rules, batch/expiry/MRP, free goods, provisional GRN, cold-chain, recall check; stock ledger + balances + FEFO reservation interface for Plan 16; (8) transfers + two-sided scan + discrepancy; cycle counts + variance register + SoD/randomisation; (9) supplier invoice + Invoice Matcher + holds + registers (GST purchase, MSME, TDS, cash) + Tally purchase-voucher export; (10) emergency local purchase + petty cash + 40A(3) split; (11) returns/debit notes; recall freeze; destruction register; (12) screens: GRN gate (Lane 1), approval inbox (Lane 1), Lane-2 worklists; (13) Expiry Watchman scope (batches, contracts, licences); golden suites (UoM, GRN QC, match tolerance, cash split, cumulative-day). **Gates before authoring:** Plan 13 shipped (store kind); O-1..O-5 ruled; CA thresholds; formulary FK shape confirmed; Plan 12a runtime status decided for the Replenishment harness.

**Plan 14b — Consignment, capex/AMC intake, payments.** (1) consignment lots + ownership dimension on balances + `consignment.deployed` consumer + auto-PO + monthly reconciliation + aging; loaner set states with CSSD gate consumed from Plan 15; (2) capex request → committee → commissioning workflow; asset register; warranty/AMC/CMC contracts; calibration schedule; Asset Lifecycle Clock; condemnation; (3) payment runs + NEFT file + Tally payment export + bank statement import + disbursement recon (fix 1); (4) vendor scorecards + Price Variance Sentinel detectors into Fraud Sentinel; budgets vs actual per cost center; (5) Invoice Reader (flag-inert) + 2B/IRN import adapters; (6) Lane-3 pilot hooks. **Gate:** Plan 15 must be able to read consignment availability — so 14b's consignment section may need to land *before* Plan 15's OT scan task; sequence 14 → 14b(consignment slice) → 15 → 14b(rest) if calendar demands.

**Plan 20 (proposed, new) — Biomedical equipment fleet** (P5 tickets, PM tasks, breakdown SLA 30 min for critical, uptime reporting, NABH FMS evidence) — belongs to the Quality/NABH pack; consumes 14b's assets.

**Negative-space question — what absence is a signal here?** A GRN with no invoice within 30 days (vendor not billing = free goods off-book or invoice going elsewhere); a PO with no GRN past due date (vendor fill failure or goods received off-system); consumption with no issue (sub-store stock appearing from nowhere); an implant in an OT note with no `consignment.deployed`; a vendor with invoices but no GSTR-1 filings; a store with *zero* variance for four counts running (counts being copied from system); an asset with no PM task ever; an emergency purchase with no matching stock-out event; a rate contract that no PO has ever used.

**Staff edge-case interview questions (Materials Head / storekeeper / pharmacist / accountant):**
1. What happens today when a lorry arrives after the storekeeper leaves? Who signs?
2. Which vendors routinely deliver short and how is it recorded?
3. How are free goods / schemes recorded now, and who benefits?
4. Which items are bought without a PO every month, and why?
5. When was the last near-expiry acceptance, and did the stock get used?
6. How do you handle a vendor invoice whose GST rate differs from the item?
7. Which vendors are MSME? How do you know?
8. How many implants used last quarter had no vendor invoice for > 60 days?
9. How is petty cash reconciled and who holds the float at night?
10. Which equipment has an AMC, which is on "call and pay", and who tracks calibration?
11. Has a vendor's bank account ever changed? How was it verified?
12. What does the drug inspector ask for when he visits, and how long does it take to produce?
13. Which sub-store can you *not* count without the in-charge present?
14. When the system was down last, how did receiving and issuing work?

---

## 15. Open questions & risks

- **Formulary FK shape:** `items.formulary_medicine_id` assumes one item per brand-strength-form; Plan 16 may want pack-level SKUs under one medicine — confirm before Plan 14 T2.
- **12a runtime timing:** Replenishment/Invoice Matcher need the agent harness (identity, kill switch, heartbeat). If 12a is not live, Plan 14 runs them as scheduler jobs under agent actor identities with a documented migration to the harness — the seam must be named.
- **Master-data governance (Plan 13 §4A):** vendor/item masters are direct audited writes until the governance phase; vendor bank change nevertheless needs owner approval *now* — implement via the approvals engine, not workflow definitions, and re-home later.
- **ITC apportionment for a trust hospital:** Rules 42/43 method depends on the CA's treatment of pharmacy sales and taxable room rent; the register shape is designed, the numbers are not ours to decide.
- **§194Q vs vendor TCS interplay** and hospital turnover status — CA.
- **Consignment tax treatment** (deemed supply at 180 days, vendor's invoice date vs usage date, e-way bill on challan) — counsel review already in flight for agreements; tax opinion still needed.
- **Billing exception debt:** the roadmap's open item (SLA-bearing status columns) — this module adds none; every lifecycle above is a workflow definition, including the payment run.
- **Scale of definitions:** fourteen workflow definitions is many for one module; Class-B activation load on the owner is real — recommend activating in two batches (Plan 14: indent, PO, GRN, invoice, count, vendor; Plan 14b: rest).
- **Legacy stock opening balance:** the migration from the current pharmacy/store records (batches without expiry, unknown MRPs) will create `LEGACY-UNK` batches — the pilot-as-secondary window must include a full physical count before FEFO trusts the ledger.
- **Risk — the receiving gate as bottleneck:** at 80 GRNs/day one dock and one QC pharmacist will not hold; the provisional-GRN state is the pressure valve, and staffing per S10 (storekeeper 10–14) must arrive with the floors.
