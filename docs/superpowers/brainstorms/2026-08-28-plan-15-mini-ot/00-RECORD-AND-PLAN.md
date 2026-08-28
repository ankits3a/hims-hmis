# Plan 15 — Mini-OT day-care: brainstorm record
**Date:** 2026-08-28 · **Status:** brainstorm v2 — forks DECIDED under the owner's 2026-08-28 mandate ("most logical, the way Indian hospitals work"; all standard certificates and machinery assumed present); edge-case pass done; nothing executed · **Author:** session record
**Companions:** department series `2026-08-27-department-series/15-ot-anaesthesia-cssd.md` (§1, §3, §4, §13, §14, §15 — the raw material) · `00-INDEX-AND-SYNTHESIS.md` themes 1, 5, 6, 7, 9, 21 · spec §11.16-A (v4.8) · roadmap *Stage-2 acceleration* + the 2026-08-27 re-slice · Plan 14 phase doc DD13, § 4A-3, § 6.6, close review F5.

---

## 0. What this document is

The planning session that opens Plan 15 after Plan 14 closed (2026-08-28, code-complete, NOT deployed). It settles what Plan 15 *is*, records what the tree actually offers it, names the forks only the owner can rule, and sketches a task list sized to the method's actuals. Nothing here is ruled unless §5 says the owner said so.

**The one-sentence finding:** the OT brainstorm's Plan 15 sketch (doc 15 §14, T1–T11) is ~25 tables, eight workflow definitions, four statutory surfaces, a CSSD bench and a money engine. Plan 14's own precedent — doc 09 was ruled three phases, and the nine-task slice still took two blocking review passes — says this is **three phases, not one**. The first decision is the slice.

---

## 1. Where the house is (read from `main` at `1fc8674`, this session)

| Item | State | Consequence for 15 |
|---|---|---|
| Plan 13 registry | LIVE (prod 34 migrations). Ten kinds in the CHECK; `theatre` and `device` are in the CHECK and **no manifest declares them** — `resources.test.ts` says "until Plan 15" | 15 claims `theatre` (and `bed` for the two bays — nobody has claimed `bed`); the autoclave `device` belongs with the CSSD slice |
| Worker `collectResourceKinds` | **CLOSED by Plan 14 T2** (`worker.module.ts:125`) | The Plan 13 carry-forward is discharged; a mini-OT manifest with subscriptions boots correctly in the worker |
| Registry `active` toggle | `opd/masters.ts` maps `active` ← `status !== retired` in one mapper (DD2). Plan 13 said "the toggle has to go when the registry gains a second writer" | 15 IS the second writer. Its T1 must either route theatre/bed status through the kernel status API only and leave OPD's mapper alone, or retire the mapper. Recommend: leave OPD's mapper (it is a read predicate, not a writer) and give 15 no `active` at all |
| Plan 14 materials | CODE-COMPLETE, NOT DEPLOYED. `consignmentDeployed`, `materialConsumed`, `consumptionsFor(encounterId)`, `consignment_lots`, `store` kind all exist in `modules/materials/index.ts` | DD13 is frozen: 15 imports `consignmentDeployed` and appends it inside its scan-on-use transaction. **15 cannot deploy before 14 deploys** — its migration chains on `0034` |
| Encounter model | There is **no kernel encounter table and no enum**. `opd_encounters.type` is `text NOT NULL DEFAULT 'opd'`; `billing.encounter_id` is plain text with no FK (house precedent) | Index theme 1 / R-035 ("one kernel migration adds every enum value") is **moot as written** — there is nothing to extend. O-1 is a real fork: see §3.1 |
| Episode number grammar | `kernel/episodes/series.ts` reserves one letter per document type; `S` is `lab_specimen` | A day-care case needs its own letter (`D`?) reserved in that file — a one-line kernel edit, decided at authoring |
| Billing | Payment and advance are one row (allocation differs); `advance_refund` exists | The "deposit clearance" gate has a real substrate. Whether *dues/advance* policy is final is an index gate item — verify at authoring, not assume |
| Approvals / Class-B definitions | One full admin in prod; every two-key rule is theatre until runbook O1 | Case-selection criteria (Class B) can only ship under **single-approver honesty mode (R-247)** with `governance.single_approver_used` events. Say so in the phase doc |
| Copilot `ot-briefing` pack | 12a not shipped | The pack is a declared stub, as doc 12 §2.3 allows; it does not gate 15 |
| Roster (Plan 20) / transport (Plan 31) | Not built | Anaesthetist on-call resolves to `usersHoldingRole()` statically; no porter tasks in 15 |
| Spec §11.16-A | v4.8 written and in the spec; the roadmap says "adversarially passed before Plan 15 is authored, per the rhythm" | Not evidenced as passed. Either the phase doc's own review discharges it, or a short adversarial pass runs first (§4) |

---

## 2. The slice — recommendation

Cut **vertically**: the thinnest path one real case can walk end-to-end with every hard gate structural, and nothing built that the first hundred cases will not exercise.

### 15 — Day-care spine (this phase)
The ortho implant case and the non-MTP gynae case, from OPD procedure advice to same-day discharge with a correct bill.

- **Registry:** `theatre` ×1, `bed` ×2 (contained under the theatre; `class` = `daycare_recovery`, tariff link deferred per Plan 13 §4A-1), the consignment `store` already exists in 14's vocabulary. Status vocabularies via the open kind seam — no kernel edit.
- **Encounter:** `daycare_encounters` (OT-owned, per O-1 recommendation), `D`-series episode number, `opd_encounter_id` back-reference to the advising consult.
- **Case + list:** `ot_cases`, `ot_lists` (published previous evening; the coordination artifact), sequencing/re-sequencing, on-day cancellation reason-coded.
- **Gates as child workflow instances** (WF-OT-GATES): anaesthesia review + ASA · procedure consent + anaesthesia consent (guardian path D-31) · site marking · NPO · deposit clearance · **escort verified** · case-selection criteria (Class B, single-approver mode) · privileging (warning-only until O-8's list exists). Statutory gates (MTP/PCPNDT) are **absent from this slice, not stubbed** — see 15c.
- **WHO checklist as workflow states** Sign-in → Time-out → Sign-out; two-person counts with **scrub ≠ circulating SoD** and count-mismatch hard stop; the five timestamps.
- **Implant scan-on-use** → `consignmentDeployed` appended in the same transaction as the case's implant row; `lot_exhausted` surfaced on the cockpit. Sticker/batch/serial captured.
- **Recovery:** Aldrete/PADSS scoring-to-threshold (thresholds definition data), escort re-verify at discharge (blocked, evented), `daycare.discharged`, follow-up booking through the OPD appointment path, missed follow-up = recall task.
- **Conversion:** `daycare.converted_to_admission` + the documented handoff to the incumbent system (E-11 boundary map). Nothing else — no IPD.
- **Money:** the discharge bill composed from procedure package + `consumptionsFor(encounterId)` implant lines + the deposit allocation, through billing's existing counter path with the `regulated` clamp applied there. **No chargeables spine** (§4A-3: recommended 16c — held). No theatre-time bands, no cancellation matrix (O-4/O-5 → 15d or 14c; one theatre does not yet have the data to design them from).
- **Screens (Lane 1, hand-built):** theatre board/list, cockpit (gates → checklist → implants → close), recovery bay, booking from the OPD consult's procedure-advice branch.
- **Events:** the seven from §11.16-A minus `form_f.recorded`, plus `case.cancelled`, `timeout.halted`, `count.mismatch`, `gate.overridden` (two-actor clinical override lane only; **no override for statutory gates by definition**).

### 15b — CSSD-lite
`cssd_sets` (FK to the autoclave `device`, per Plan 13 §4A), loads, BI per load, release/hold policy (O-6), BI-fail auto-recall of the whole load, issue-against-tomorrow's-list, expiry watch, IUSS. In 15, the "valid sterile set" gate is a **documentation gate** (set ids typed/scanned, no structural check) — exactly the index theme-6 posture for pre-roster chaperone gates; 15b turns it structural. Needs the owner's autoclave/BI-reader facts (§5.2).

### 15c — Statutory surfaces
`pcpndt` module (registrations config + Form-F register, shared with Plan 18), Form-F structural gate on any applicable USG, MTP register (`termination.recorded`, sealed class, opinion-count config, Form C/I/II print layouts), MLC check for ortho trauma, sealed-class propagation on worklists/labels/invoices. **Gated on the certificates being on file** (§19) and on the E-21 electronic-register legality opinion. Until 15c, MTP and in-unit USG procedure classes are **outside the Class-B whitelist** — the unit opens for ortho and non-MTP gynae. That is the ruling in §3.4.

### Why not the other cuts
- *Horizontal (all schema in 15, all screens in 15b):* the review method has shown twice that the defects live in the seams between a write path and its consumer; a schema-only phase reviews nothing real.
- *Statutory first:* certificates and counsel opinions are outside the team's control; putting them on the critical path stalls the whole track.
- *Doc 15's T1–T11 as one phase:* 14 took 458k on reviewers alone for nine tasks and still needed two blocking passes. Eleven tasks with money, sealed records and statutory print layouts is not a phase this method has actuals for.

---

## 3. The forks — DECIDED (planner, under the 2026-08-28 mandate; owner may overturn any line)

The owner ruled 2026-08-28: when in doubt take the most logical choice, the way an Indian corporate hospital works; assume every certificate and machine that such a hospital holds is on file (MTP approved-place, PCPNDT registration for machine + sonologists, autoclave with a rapid BI reader, C-arm with AERB licence, OT environment monitoring). Each line below is therefore a DECISION, not a question.

| # | Fork | DECIDED | Why this is the logical choice |
|---|---|---|---|
| 3.1 | **O-1 encounter home** | OT-owned `daycare_encounters`; `D` letter reserved in `kernel/episodes/series.ts`; `opd_encounter_id` back-reference to the advising consult | No kernel enum exists to extend; OPD's queue/visit lifecycle must not learn a surgical one. R-035 is discharged by this ruling |
| 3.2 | **F5 ceiling source** | Clamp against the ceiling **re-derived at invoice time**; the frozen `material.consumed.ceilingPaise` is provenance. On divergence the composer uses the derived value and emits `material.ceiling_diverged` | The invoice is the tax document and must match the gazette as corrected on the day of issue; NPPA enforcement reads the invoice, not the event log |
| 3.3 | **Charge path** | Chargeables spine stays at 16c; 15 composes at discharge from one read | Unchanged from Plan 14 §4A-3 |
| 3.4 | **Slice order** | **15 spine → 15b statutory → 15c CSSD-lite → 15d money detail + equipment/telemetry** | Certificates assumed → 15b is not gated, only sized. Gynae day-care in India is MTP/D&C/hysteroscopy-heavy with a pelvic USG before most of them; the unit is half-open without 15b, so it lands immediately after the spine and before CSSD. Whitelist excludes `mtp` and in-unit USG classes structurally until 15b ships |
| 3.5 | **Class-B criteria with one admin** | R-247 single-approver honesty mode: `governance.single_approver_used` on every criteria/privileging publish; re-ratify within 30 d of O1 | The truthful posture; a two-key rule with one key is theatre |
| 3.6 | **Overnight conversion** | Conversion timestamp is the billing boundary: our invoice covers everything to `daycare.converted_to_admission` (theatre, implants, consumables, recovery); the incumbent IPD bills the admission from that instant. `daycare_encounters` closes with `outcome=converted`, handoff document printed (summary + implant stickers + drug chart). Physical destination: the incumbent 10-bed IPD | Indian practice folds day-care into the IPD bill; with two systems the only double-billing-proof rule is a timestamp boundary |
| 3.7 | **Deploy chain** | 15 chains on `0034`; build + review do not need 14 deployed; first production case needs 0034+0035 together; 15's close does not re-open 14's deploy question | — |
| 3.8 | **Deposit gate** | Definition data: self-pay deposit ≥ 100 % of package quote by default (configurable %); insured: pre-auth number + sanctioned amount typed as a documentation gate (TPA module is Plan 22/20-series); shortfall → approvals-engine exception (single-approver); §269ST cash block inherited from billing | Corporate hospitals take the full package as deposit for day-care; poor-patient exceptions are an owner call, so they go through approvals, not a lower default |
| 3.9 | **O-2 bay class / bed billing** | Bays carry `class=daycare_recovery`; day-care bills by procedure package, never by bed-hours | Plan 13 §4A-1 already ruled the tariff link waits for IPD |
| 3.10 | **O-3 Form-F home** | Tiny shared `pcpndt` module (registrations config + Form-F register) in 15b; radiology (18) consumes it | One register, two consumers |
| 3.11 | **O-4 theatre-time basis** | Deferred to 15d: wheel-in→wheel-out in bands (first 60 min, then 30-min blocks — the corporate norm), anaesthesia induction→handover. **15 makes the five timestamps immutable transitions** so 15d computes from them | Package-first billing makes bands matter only outside package; one theatre has no band data yet |
| 3.12 | **O-5 cancellation matrix** | 15 captures reason code + attribution class `patient / hospital / surgeon / payer / clinical`; the charge consequence (opened consumables → patient only when patient-attributable, else cost centre "OT cancellation") lands in 15d; issued-unopened stock returns via 14's transfer | Attribution must be captured from day one or the matrix has no data |
| 3.13 | **O-6 BI release** | Implant loads held until rapid BI negative (1–3 h); non-implant loads released on parametric + class-5 chemical indicator with retrospective BI and auto-recall (15c) | Rapid BI reader assumed present; this is the CSSD norm in accredited Indian hospitals |
| 3.14 | **O-7 wrongly-opened implant** | Hospital cost centre unless vendor packaging defect; **never the patient**; per-vendor override only via a signed agreement clause | — |
| 3.15 | **O-8 privileging** | Privileging list per surgeon (procedure classes) is definition data in 15; outside privilege = **booking refused** (not a warning); list seeded by the MS at go-live under 3.5 | Credentialing committees are standard; a warning-only gate is unenforced |
| 3.16 | **O-9 telemetry** | 15: start-of-list environment log (temp/humidity/pressure) as a documentation gate; sensor integration + "block if no reading > 2 h" → 15d | Sensors exist but the edge service is an integration phase |
| 3.17 | **O-10 photography** | Out of 15 except the implant-sticker photo (H3); no clinical image capture until a consent-scope policy exists | — |
| 3.18 | **O-11 criteria defaults** | ASA I–II · age 1–70 · BMI < 35 · escort mandatory · home within ~1 h · **procedure whitelist seed** — gynae: first-trimester MTP (suction evacuation / medical), D&C, diagnostic + operative hysteroscopy, LEEP/cervical biopsy, Bartholin marsupialisation, laparoscopic/minilap tubectomy, polypectomy, colposcopy, difficult IUCD removal, pelvic USG · ortho: implant/K-wire removal, closed reduction + percutaneous pinning, carpal tunnel release, trigger finger release, ganglion excision, diagnostic/therapeutic knee arthroscopy (meniscectomy), tendon repair, distal radius/ankle fixation on anaesthetist's call, joint aspiration/injection, MUA. **Excluded:** obstetric emergencies, ACL/joint replacement, anything needing a blood reserve. Department heads confirm-or-correct the seed | This is the whitelist most corporate day-care units run; excluding blood-reserve cases removes the blood-bank gate from 15 entirely (M2 becomes moot) |
| 3.19 | **O-12 FP scheme** | Tubectomy is on the whitelist as an ordinary paid procedure; the government FP-scheme register/compensation surface is OUT until the owner says the hospital is empanelled (empanelment is not a standard certificate) | — |
| 3.20 | **Narcotics in theatre** | The NDPS per-case kit, witnessed wastage and running balance belong to **Plan 16's controlled-drug register**; 15's anaesthesia record lists drugs given; no OT-local narcotic register | One register, the pharmacy's |
| 3.21 | **Histopath specimens** | In 15 (gynae D&C/hysteroscopy produce a specimen almost every case): specimen row per case, label printed from the open case only (A10), dispatch record with destination (in-house lab or outsourced courier) — the manual chain until 17 | Cannot be deferred: the specimen exists whether the lab module does or not |
| 3.22 | **Death on table** | Minimal but present in 15: `death.on_table_recorded` → case terminal, theatre `blocked_incident`, MLC flag, legal hold on the record, MS notified. The six-task cascade (police, mortuary, disclosure) → 28a/15d | A day-care unit can still have a death; the event cannot be "deferred" if it happens |
| 3.23 | **Late discharge** | Discharge-ready after a configurable cut-off (default 20:00) → offer conversion to overnight observation (which IS 3.6's conversion); escort choice recorded | Sending a post-anaesthesia woman home at 22:00 is not Indian practice |
| 3.24 | **Escort** | Adult (≥ 18) with a phone; relationship recorded; hired attendants allowed with ID type + last-4; `escort_id ≠ patient_id` CHECK (A7); DPDP-minimal fields | — |

---

## 4. Method notes for the authoring session

- **One doc, LIGHT lane, ~9 tasks, second review pass mandatory** (the owner's 2026-08-28 "no third pass" ruling was explicitly not a precedent for skipping the second).
- **Read before authoring:** doc 15 §3.1 (WF-OT-CASE states), §3.2 (gates as child workflows), §3.6 (PACU), §3.8 (implant case), §4 (data model), §5 rows named in §7 below; `modules/materials/events.ts` (DD13 verbatim), `modules/materials/consumption.ts` (`consumptionsFor`'s actual return shape post-M5), `modules/opd/workflow-def.ts` (the definition-JSON house shape), `kernel/db/schema/resources.test.ts` (kind claiming contract), `kernel/episodes/series.ts` (letter reservation).
- **Spec §11.16-A adversarial pass:** booked "before Plan 15 is authored", not evidenced. Run it as a FRESH reviewer pass over §11.16-A + this record (scope, not memory — §2.115), or state in the phase doc that its own second review discharges it. Do not skip silently.
- **Fixture rule §2.102** from T1: the implant fixture must NOT have tariff = MRP = ceiling, and the F5 test needs frozen ≠ derived.
- **Downtime is hospital-scoped** until Plan 30 — say so (index theme 9).
- **Stop-loss:** shape 14 — set from 14's actuals (`token-baselines.json`), not from doc 15's ambition.
- **§1.3 absolute:** no scratch files; quoted heredocs into `node`/`python3`.

---

## 5. What remains for the owner — confirm-or-correct, not blocking

Everything below has a default from §3 already; the phase doc is authored on the default and the owner corrects any line.
1. The whitelist seed (3.18) — gynae + ortho heads strike or add procedures
2. Conversion destination and billing boundary (3.6) — the incumbent IPD bills from the conversion instant
3. Deposit default 100 % of package for self-pay (3.8)
4. FP-scheme empanelment: assumed NO (3.19)
5. Expected cases/month — sizes nothing in 15; matters for 15d's band design

---

## 6. Proposed task list for 15 (spine) — for the phase doc to argue, not adopt

| T | Content | Depends on |
|---|---|---|
| T1 | Schema `daycare_encounters`, `ot_cases`, `ot_lists`, `ot_case_gates`, `ot_checklist_runs`, `ot_counts`, `ot_case_implants`, `ot_specimens`, `pacu_scores`, `ot_privileges`, criteria definition; `D` episode letter; registry manifest claiming `theatre` + `bed`; module skeleton; `patient.merged` consumer | 0034 |
| T2 | Workflow definitions WF-DAYCARE-CASE (with transition matrix incl. `cancelled_onday`, `absconded`, `converted`, `death_on_table` terminals), WF-OT-GATES (child instances), WF-PACU; events in the catalog | T1 |
| T3 | Booking from the OPD procedure-advice branch; Class-B criteria + privileging check under R-247; duplicate-booking soft-block; deposit quote via PricingContext | T2 |
| T4 | Readiness: gate writes (anaesthesia/ASA incl. external PAC, consents with language/interpreter/thumb + guardian path + conversion item, laterality invariant, site, NPO computed, deposit/pre-auth, escort, MLC decision for trauma), list publish + print-from-draft | T3 |
| T5 | Cockpit: holding QR verify, WHO states, counts (two actors, SoD, optimistic version, derived status), five immutable timestamps, C-arm dose log, implant scan → `consignmentDeployed` in-transaction (state-guarded, idempotent on case+serial, explant path), specimen label + dispatch, `procedure.converted`, death-on-table minimal | T4, DD13 |
| T6 | Recovery: bay assignment (occupancy-guarded), scoring-to-threshold (two scores 30 min apart), escort re-verify, ISBAR handover ack, late-discharge cut-off → conversion offer, `daycare.discharged` / `converted` / `absconded`, follow-up booking + recall task, family WhatsApp status at wheel-in/out via Plan 10 | T5 |
| T7 | Discharge bill composition: package + `consumptionsFor` implant lines flagged outside-package + deposit allocation; F5 asserted; `material.ceiling_diverged`; composition refused unless the case is `signed_out` (no ghost cases); unreturned issued stock flagged at discharge | T6 |
| T8 | Screens (Lane 1): list/board, cockpit, recovery, booking branch; i18n; nav parity; per-case downtime pack print | T3–T7 |
| T9 | Gate report: criteria + privileging published under R-247, consignment agreement on file, `mtp`/USG classes structurally out until 15b; drills (count mismatch, escort absent, downtime backfill); two review passes | all |

Nine tasks. If the phase doc's argument grows it past ten, something above belongs in 15b/15c/15d.

---

## 7. Edge-case register — the pass the owner asked for

Source: doc 15 §5 (111 rows) + §6 chaos walkthroughs + cross-module chaos; filtered against the spine. **IN** rows are assertions the phase doc must carry; deferred rows name the slice that owns them. Ids are doc 15's.

### 7.1 IN the spine (15) — 52 rows
| Area | Rows | What 15 must assert |
|---|---|---|
| Identity / site | A1, A2, A3, A5, A7, A8, A9, A10 | Holding verify by UHID QR before `signed_in`; check-in refused without band id; laterality triple-equality (booking = consent = marking); `patient.merged` rewrites the case + re-verify flag; `escort_id ≠ patient_id` CHECK; time-out halt = near-miss row; (patient, date, procedure) soft-block; specimen label only from the open case |
| Timing / races | B1, B4, B7, B8, B10, B11 | Sign-in serialises on the theatre row (exactly one of two racing succeeds); count row optimistic version → one 409; discharge needs ≥ 2 threshold scores 30 min apart; `incision` unreachable without `timed_out` (transition matrix test); cross-midnight case counted once, tariff pinned at case start; bay assign on occupied → error |
| Downtime | C1, C2, C6, C10, C11 | Backfill with `occurred_at` < `recorded_at` and all three WHO phases required to close; list printable from draft; registry error inside the transition fails loudly, no half-state; hospital-scoped downtime until Plan 30; backfilled cancellation + refund linked to the downtime session |
| Money | D2, D5, D8, D9, D12, D15 | Implant lines flagged outside-package before discharge; deposit carried across postponement; explant → 14 return path + vendor cost centre, one patient charge; `min(tariff, MRP, ceiling)` line records which won; issued ≠ consumed at discharge → return task; §269ST inherited |
| Consent / legal | E5, E7, E8, E15, K2, K4 | RTA ortho: MLC decision recorded before wheel-in; consent has language + interpreter/witness + thumb path; `consent.revoked` → `cancelled_onday reason=patient_withdrew`, no theatre charge; minor without guardian consent → blocked |
| Staff | F1, F2, F3, F4, F9, F10 | `surgeon.late_flagged` at +15/+30, no-show cancel at +60 with reason `surgeon_no_show`; sign-in requires an assigned anaesthetist actor (static role holder until Plan 20); same actor for both counts → `sod.violation_blocked`; privileging refuses booking; trainee logged, consultant is surgeon of record |
| Equipment | G2, G4 | `procedure.converted` requires the consent's conversion item; C-arm case cannot sign out without a dose log |
| Data quality | H1, H2, H3, H6, H8, H9, H10, H11 | Signing after 24 h needs a reason; op-note amendment append-only; manual UDI needs a verifier; consent requires procedure code + template version; "counts correct" derived from rows, never typed; NPO computed from the typed time; deploy idempotent on (case, serial); score from the wrong bay warns |
| Fraud | I4, I7, I9 | Timestamps immutable, correction = reason + second actor + credit note; bill composition refused without WHO events; clinical cancellation reasons need anaesthetist co-sign |
| Privacy | J1, J2, J3, J7 | Alias from `patients.get` on list/board/recovery; no WhatsApp to unverified numbers for VIP; family-facing text is token + status; sealed flag renders as "standard precautions" to non-clinical roles |
| Integration | M3 | FHIR Encounter class=AMB for the day-care encounter |
| Chaos | 6.2, 6.3 | Server-down mid-case on the per-case pack; anaesthetist no-show + surgeon late + deposit short on one morning — every branch above exists |

### 7.2 New rows this pass added (Indian-context gaps in doc 15)
| Id | Scenario | Decision |
|---|---|---|
| N1 | Family fed the patient despite the NPO call | NPO gate = typed last-intake time (computed) + patient attestation at check-in; violation → `cancelled_onday`, attribution `patient` |
| N2 | Escort is a hired attendant / a minor | 3.24: adult with phone and ID; minor escort refused |
| N3 | Discharge-ready at 21:30 | 3.23: cut-off → conversion offer, escort choice recorded |
| N4 | Patient outside criteria (age 72, ASA III) the surgeon still wants as day-care | Two-actor clinical override (surgeon + anaesthetist, distinct ids, reason) → `gate.overridden`, digest line; statutory gates have no override lane |
| N5 | Pre-auth denied at 07:00 on the list day | Attribution class `payer`; self-pay counselling; deposit paid → proceeds, else `postponed reason=payer_denied` |
| N6 | Implant scanned before the case is in theatre (nurse pre-opens) | `consignmentDeployed` allowed only in states `timed_out … signed_out`; earlier → refused |
| N7 | Implant deployed, then case abandoned pre-incision | D8's explant/return path; attribution `clinical` |
| N8 | Bilateral as two cases, one day | One `daycare_encounter`, two `ot_cases`; bill composes per encounter (consumptionsFor is per encounter) |
| N9 | Patient walks out of recovery without discharge | `absconded` terminal; bill issued as-is; recall call task; escort not verified is recorded as the cause |
| N10 | ED overflow parks a patient in a recovery bay (cross-chaos 106) | Bay assignment only through the OT module for day-care cases; ED use = registry status set by in-charge with reason; never a `pacu_scores` row |
| N11 | Surgeon extends the procedure on the table | `procedure.converted` + consent conversion item (G2); package delta → 15d |
| N12 | Deposit shortfall for a poor patient | 3.8: approvals-engine exception under single-approver mode, evented; no silent lower default |
| N13 | Same-day return to theatre (bleeding after D&C) | `return_to_ot.flagged` NEW case row linked to the original, no second deposit, quality counter; the second case's bill folds into the same encounter |
| N14 | Two Sunita Devis, one is the other's escort | A1 + A7 together: escort verify scans the escort's own id if she has a UHID; cross-view blocked |

### 7.3 Deferred, by owning slice
- **15b statutory:** E1, E2, E3, E4, E16, E17, J5, 6.6 (MTP minor + POCSO, spouse-not-a-field, gestation limits + opinion count, certificate expiry as config, Form-F gate, sealed alias on invoices, copilot sealed-class, the inspector walk-in).
- **15c CSSD-lite:** B6, C3, F5, G6, G7, H4, I2, I10, I11, M6, 6.1 (late insert vs set availability, manual cycle entry, temp role for autoclave, cycle/Bowie-Dick failure, backdated BI recall reaching used sets, loaner without load, exclusive set status, derived expiry, no data port, BI-positive mid-list).
- **15d money/equipment/telemetry:** D1, D3, D4 (charge side), D6, D7, D10, D11, D13, D14, B2 (full cascade), B5, C4, C7, G1, G3, G5, G8, G9, G10, M7, I1, I6, I12, F6, 6.5.
- **Plan 16 (NDPS):** I5. **Plan 17/18:** M1 external results, B12 frozen section. **28a quality:** E11 cascade, E12, E18, J4, J6. **Plan 20 roster:** F8, F6 validation. **Plan 22/document chrome:** K1 pictorial instructions, K3/K5 display + IVR. **Out of scope by whitelist:** A6, B3, B9, E6, E13, E14, E19, M2, L1–L5, 6.4 (MLC trauma path exists minimally via 3.22), 6.7 (disaster widening = Class-B emergency activation, evented — stays with 28-G).

---

## 8. Assumptions this record now rests on (owner mandate 2026-08-28)
- MTP approved-place certificate, PCPNDT registration (machine + sonologists), AERB licence for the C-arm, autoclave with rapid BI reader, OT environment monitoring: **all present**. Their expiry dates are config with an Expiry Watchman warning (E4 pattern) — 15b/15c capture them.
- The hospital is not FP-scheme empanelled (3.19).
- The incumbent IPD stays the destination for conversions until the IPD cluster (3.6).
- The blood bank is never on the day-care critical path because the whitelist excludes blood-reserve cases (3.18).
