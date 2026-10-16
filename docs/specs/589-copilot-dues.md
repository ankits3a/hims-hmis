---
issue: 589
status: built
approved: 2026-10-11
---
# SPEC — copilot answers patient dues (E1.6, decision 0064) — 2026-10-11 — DRAFT, awaiting owner yes

Lane `copilot-dues` (branch lane/copilot-dues from 6baec16b). Today `patient_dues` routes (phrasebook + choice-route) but no tool claims it → `copilot.answer.noTool`.

1. **Figure (DECIDED):** ONE patient-level number, the counter's own: `patientBalance(db, actor, patientId).outstandingPaise` (billing/receipts.ts → `patientOutstandingPaise`), the figure the billing counter prints as `dues-total` and billing-dues shows. Per bill: net − credit notes − live allocations, floored at 0, entered-in-error bills skipped. Refunds change the advance, not the dues. Not split by visit; the answer adds the number of unpaid bills and the oldest bill's number and date. The tool calls `patientBalance` itself, with no second sum, so it cannot drift from the counter.
2. **Advance (DECIDED, owner may overrule Q1):** not said. The front desk's ruling (2026-09-30) is "amount, bill number, date" only.
3. **Whose patient (DECIDED):** `needsSubject: true`. The subject must be a UHID: uppercase it, check its shape and Verhoeff digit (`isValidUhid`, the OPD tool's order), then look it up with `searchPatients` (which follows merges to the surviving record). A bad check digit gives `uhidCheckFailed`. No match gives `visitUnknownPatient`. A visit number is not accepted (a bill names a patient, FD-35) and gets `duesNeedUhid`. The answer quotes the UHID, never the name, so restricted or VIP aliases never leak. Each lookup writes a `recordPhiAccess` row with surface `copilot.patient_dues`.
4. **Permission (DECIDED):** the gate is `billing.dues.patient.read` (front desk), also admitting `billing.invoice.read` (cashier, billing manager, owner, pharmacy, lab and radiology reception), so it matches `GET /billing/patients/:id/dues`. The `doctor` role holds neither and gets `notPermitted` (owner 2026-10-09: doctors never see money). Plumbing: an additive optional `alsoAdmits?: readonly string[]` on `CopilotToolDecl`. `runTool` admits on any one of them, and the collector boot-checks every string. No seed-roles change. No change to billing `index.ts` (the tool sits in the new `billing/copilot-tools.ts` on the billing manifest's `copilotTools`).
5. **Wording (DECIDED, short for phone):** new keys in contracts and in en/hi locales:
   - `duesOwed`: en "{{uhid}}: {{amount}} due · {{count}} bill(s), oldest {{billNo}} ({{date}})"; hi "{{uhid}}: {{amount}} बाकी · {{count}} बिल, सबसे पुराना {{billNo}} ({{date}})"
   - `duesNone`: en "{{uhid}}: nothing due"; hi "{{uhid}}: कुछ बाकी नहीं"
   - `duesNeedUhid`: en "Give the patient's UHID"; hi "मरीज़ का UHID बताइए"
   - Amount uses the server's ₹ display with paise when they are not zero.

**Done means (fail-first, under the test lock):**
- D1 Fixture with one patient: bill A ₹1,000 with ₹400 paid and a ₹100 credit note; bill B ₹500 paid in full, then a pharmacy-style credit note plus refund voucher; an advance receipt part-refunded. The tool's figure equals `patientBalance(...).outstandingPaise` from the same database. Both are ₹500, and the answer says 1 bill.
- D2 A patient with nothing owed gets `duesNone`. A bad check digit gets `uhidCheckFailed`. An unknown UHID gets `visitUnknownPatient`. A visit number gets `duesNeedUhid`. No subject gets `needSubject`.
- D3 A doctor-role user gets `notPermitted` and the tool body never runs. A front-desk user (`billing.dues.patient.read` only) and a cashier (`billing.invoice.read` only) both get the figure.
- D4 The collector refuses an undeclared `alsoAdmits` string at boot. The dues question no longer answers `noTool`.
- D5 en and hi both carry the 3 new keys (contracts census green). Typecheck, lint and `gen.mjs --check` are green.

**Owner questions:** Q1 should the answer also say the advance on deposit ("₹X jama hai"), and to which seats (the counter shows it; front desk does not)? Q2 none else needed.
