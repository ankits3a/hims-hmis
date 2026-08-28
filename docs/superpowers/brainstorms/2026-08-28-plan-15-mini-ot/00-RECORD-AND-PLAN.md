# Plan 15 — Mini-OT day-care: brainstorm record
**Date:** 2026-08-28 · **Status:** brainstorm, not approved, nothing executed · **Author:** session record
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

## 3. The forks — what the owner has to rule, with a recommendation each

### 3.1 O-1 — where the day-care encounter lives (cannot be retrofitted cheaply)
The index assumed a kernel enum; the tree has `opd_encounters.type` (text) and nothing else.
- **(a) OT-owned `daycare_encounters`** — doc 15's recommendation. Own lifecycle (booked → checked-in → in-theatre → recovery → discharged/converted), own `D` series, no OPD coupling beyond the back-reference. Billing's plain-text `encounter_id` works unchanged. When IPD lands, `daycare_encounters` migrates into whatever the admission model is — one table, known shape.
- **(b) `opd_encounters.type = 'daycare'`** — zero new tables, but OPD's queue engine, consult-completed indexes, visit numbering and `status` vocabulary would all have to learn a second lifecycle, and OPD would become the owner of a surgical record. The "two homes for one concept" trap runs the other way here: one home for two concepts.
- **Recommend (a).** Record that R-035 is discharged by *this* ruling, not by an enum migration.

### 3.2 F5 (from Plan 14) — which ceiling the `min(tariff, MRP, ceiling)` clamp uses
`material.consumed` FROZE `ceilingPaise` at the deployment instant; `consumptionsFor` RE-DERIVES it at read time. They diverge only when a gazette correction is filed with the same `effective_from`.
- **Recommend: clamp against the re-derived value at invoice time; the frozen value is provenance.** The invoice is the tax document and must be right against the gazette as corrected on the day it is issued; the event records what the system believed at the scan. When the two differ, `consumptionsFor` returns both and the bill composer emits `material.ceiling_diverged` for the digest — never silently picks. This is a ruling, not a fix; Plan 15's phase doc records it as DD-n and asserts it (one test: same-`effective_from` correction, frozen ≠ derived, invoice uses derived, event emitted).
- The alternative (frozen) is defensible only if the owner wants "the price on the day of surgery" to be the legal price — that is a CA question; ask it in the same session as R-097/098/099.

### 3.3 Charge path — chargeables spine at 15 or 16c
Plan 14 § 4A-3 recommended 16c. Nothing in this brainstorm moves it: a day-care bill composes from one read at discharge; a pharmacy counter cannot. **Recommend: hold at 16c**, 15 composes.

### 3.4 Opening scope — does the unit open without MTP/PCPNDT machinery?
- **Recommend: yes.** 15 ships with MTP and in-unit USG **outside** the Class-B whitelist (structurally — a case with those procedure codes cannot be booked). 15c adds them when the certificates are on file. The owner must confirm the unit can run ortho + non-MTP gynae first. If the answer is "MTP is most of the gynae volume", 15c moves ahead of 15b.

### 3.5 Single-approver honesty for Class-B criteria
Case-selection criteria are Class-B definition data and prod has one admin. **Recommend: adopt R-247 now** for 15 (`governance.single_approver_used` on every criteria publish, re-ratify within 30 days of O1). Not adopting it means either theatre (a two-key rule with one key) or no criteria at all.

### 3.6 Overnight conversion — who owns the record after the crossing
Spec §11.16-A says "documented handoff to the incumbent system under E-11's boundary map". The boundary map must name: which system bills the converted episode (double-billing risk), who closes `daycare_encounters`, and where the patient physically goes (the incumbent 10-bed IPD). **Owner fact needed, then a one-paragraph boundary entry in the phase doc.**

### 3.7 The deploy chain
15's migration chains on `0034`. The owner is holding 14's deploy. **Nothing in 15 needs 14 deployed to be built and reviewed** — but the first mini-OT case in production needs 0034 + 0035 together. Recommend the phase doc name this explicitly and that 15's close does not re-open the 14 deploy question.

### 3.8 Rulings from doc 15 §13 this slice can defer
O-4 theatre-time bands, O-5 cancellation matrix → after 100 cases of data (15d). O-6 BI policy, O-9 telemetry, O-10 photography → 15b or never. O-7 wrongly-opened implant → counsel's consignment-agreement review (in flight). O-12 FP sterilisation → **owner fact needed** (yes/no) because it changes 15c's scope.

---

## 4. Method notes for the authoring session

- **One doc, LIGHT lane, ~9 tasks, second review pass mandatory** (the owner's 2026-08-28 "no third pass" ruling was explicitly not a precedent for skipping the second).
- **Read before authoring:** doc 15 §3.1 (WF-OT-CASE states), §3.2 (gates as child workflows), §3.6 (PACU), §3.8 (implant case), §4 (data model), §13, §14; `modules/materials/events.ts` (DD13 verbatim), `modules/materials/consumption.ts` (`consumptionsFor`'s actual return shape post-M5), `modules/opd/workflow-def.ts` (the definition-JSON house shape), `kernel/db/schema/resources.test.ts` (kind claiming contract).
- **Spec §11.16-A adversarial pass:** the roadmap booked it "before Plan 15 is authored". Run it as a fresh-reviewer pass over §11.16-A + this record (scope, not memory → spawn fresh, §2.115), or state in the phase doc that the doc's own second review discharges it. Do not skip silently.
- **Fixture rule §2.102** applies from T1: the implant fixture must NOT have tariff = MRP = ceiling, or the clamp is untested (the Plan 14 seventh-coinciding-field lesson).
- **Stop-loss:** shape 14 — set from 14's actuals at authoring (`token-baselines.json`), not from doc 15's ambition.
- **§1.3 absolute:** no scratch files; quoted heredocs into `node`/`python3`.

---

## 5. What the owner needs to supply

### 5.1 Rulings (this session or next)
1. O-1 encounter home → recommend OT-owned `daycare_encounters` (§3.1)
2. The slice: 15 spine / 15b CSSD / 15c statutory (§2) — and whether 15c precedes 15b (§3.4)
3. F5 ceiling source → recommend re-derived at invoice, frozen as provenance (§3.2)
4. R-247 single-approver honesty for Class-B criteria (§3.5)
5. Unit opens for ortho + non-MTP gynae before certificates (§3.4)
6. Chargeables spine stays at 16c (§3.3)

### 5.2 Facts (not rulings — the phase doc cannot be honest without them)
- The actual day-care procedure list, gynae and ortho, that the heads would whitelist (O-11 needs the list, not the rule)
- MTP approved-place certificate: on file / applied / not applied
- PCPNDT: is the unit's USG machine already registered, and under which sonologists
- Autoclave model; is there a BI reader (rapid or 24 h); who reads it today
- How ortho implants arrive today — rep brings a sterile set per case, or a consignment stock sits in the store; is any consignment agreement signed (O-8 says no signed agreement = no consignment GRN)
- Where a converted patient goes (the incumbent IPD), who bills that episode
- Anaesthetist arrangement — on staff, visiting, on-call panel
- FP sterilisation under the government scheme: yes/no (O-12)
- Expected cases/month — sizes the list screen and whether O-4/O-5 ever matter

---

## 6. Proposed task list for 15 (spine) — for the phase doc to argue, not adopt

| T | Content | Depends on |
|---|---|---|
| T1 | Schema `daycare_encounters`, `ot_cases`, `ot_lists`, `ot_case_gates`, `ot_checklist_runs`, `ot_counts`, `ot_case_implants`, `pacu_scores`; `D` episode letter; registry manifest claiming `theatre` + `bed`; module skeleton | 0034 |
| T2 | Workflow definitions WF-DAYCARE-CASE, WF-OT-GATES (child instances), WF-PACU; events in the catalog | T1 |
| T3 | Booking from the OPD procedure-advice branch; Class-B criteria check under R-247; deposit quote via PricingContext | T2 |
| T4 | Readiness: gate writes (anaesthesia/ASA, consents incl. guardian path, site, NPO, deposit, escort), list publish | T3 |
| T5 | Cockpit: WHO states, counts + SoD + hard stop, timestamps, implant scan → `consignmentDeployed` in-transaction, `lot_exhausted` surfaced | T4, DD13 |
| T6 | Recovery: scoring-to-threshold, escort re-verify, `daycare.discharged`, follow-up booking + recall task, `daycare.converted_to_admission` + handoff record | T5 |
| T7 | Discharge bill composition: package + `consumptionsFor` + deposit allocation; the F5 ruling asserted; `material.ceiling_diverged` | T6, F5 ruling |
| T8 | Screens: list/board, cockpit, recovery, booking branch; i18n; nav parity | T3–T7 |
| T9 | Gate report: §19 mini-OT items (criteria approved, consignment agreement on file, MTP/PCPNDT explicitly OUT of whitelist), drills (count-mismatch, escort-absent), two review passes | all |

Nine tasks. If the phase doc's argument grows it past ten, something above belongs in 15b/15c/15d.
