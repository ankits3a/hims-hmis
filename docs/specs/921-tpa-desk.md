---
issue: 921
status: approved
approved: 2026-10-19
---
# SPEC — insurance-lite TPA desk (2026-10-15)

Ruling: decision 0075 (R-5, #604): a light TPA desk before IPD go-live; portal filing stays manual. Owner: "go with
your defaults". Every choice below is the standard practice of a top Indian corporate hospital TPA desk, marked
DECIDED; money choices are marked **$** and listed in the PR for the owner to confirm. Lane `ipd-tpa`, on the IPD lane
tip (payer #758, discharge #762, supplementary bill and void #775). One additive migration. IPD stays off production (0073).

## Truth (what is stored; rows are appended, a status column moves forward only)
- Pre-auth record = the existing `ipd_payer_auths` entries (initial, enhancement, final, denial, payer change).
  New: `ipd_tpa_queries` (insurer's query on a pre-auth, enhancement, final or claim; when raised; our answer and when),
  `ipd_tpa_documents` (a patient document attached to a stage, by kind; detached, never deleted).
- `ipd_scheme_packages`: PM-JAY / state-scheme package master (scheme, code, name, specialty, kind, rate, pre-auth
  flag). A re-import retires a changed row and inserts the new one. `ipd_admission_packages`: packages chosen for a stay,
  rate SNAPSHOT at selection (DECIDED $: a later rate change never re-prices a stay, as the tariff lock at admission).
- Claims = the existing `ipd_payer_claims` row per settled bill. New: `ipd_claim_events` (submitted, settled, short_paid,
  rejected) with claimed amount, net paid, TDS, UTR; `ipd_claim_deductions` (reason code + amount + note).

## Rules (each in an intent; the screen only asks)
1. Ageing clock (DECIDED, IRDAI health master circular 2024; NHA TMS): an unanswered pre-auth or enhancement request is
   due in 60 min (scheme: 6 h); a final-approval request in 180 min; hot at twice the due time. An open insurer query is
   the hospital's to answer: due in 60 min, hot at 4 h. The clock shows on every row ("waiting 2 h 10 min").
2. Enhancement due (DECIDED $): insured stay with an approval, no request already waiting, and claimable ≥ 90 % of the
   approved total. Claimable = the payer split's payer share + what is held back as "over approved amount".
3. Packages (DECIDED $, PM-JAY HBP rule): only on a pmjay / state_scheme admission, only that scheme's live packages.
   Highest-rate package 100 %, second 50 %, third onward 25 %. Σ = the payer amount shown and the default claimed amount.
   Package-included lines never bill the patient: the scheme split stays patient ₹0 and the receipt guard still refuses.
   Lines above the package are the hospital's (shown as package variance), never the patient's.
4. Claim (DECIDED): submit needs the discharge summary and the final bill attached at stage "claim"; a rejected claim may
   be resubmitted. Settlement: net paid + TDS + Σ deductions must equal the claimed amount to the paisa, else refused.
   No deduction → settled; any deduction → short_paid. Both mark the claim row `settled` (a void is then refused, #763).
5. TDS (DECIDED $): typed from the insurer's settlement advice, never computed; counts as received for reconciliation.
6. Deductions (DECIDED $): recorded with a reason; never re-billed to the patient by the system (billing manager decides).
7. Reconciliation (per claim, on read): bill payer portion · claimed · net + TDS · deductions · package variance ·
   unexplained (0 when settled). Claims ageing: from submission; row at 30 days, hot at 60 (IRDAI 30-day settlement).
8. Permissions (DECIDED, no new string): queries, documents, packages, claim submit/reject, the board → `ipd.payer.manage`;
   settlement and the package import → `ipd.payer.terms` (billing manager). No doctor role holds either (0058).

## Intents (zod contracts in `@hmis/contracts` IPD_INTENTS; acceptance tests call these)
record_tpa_query · answer_tpa_query · attach_tpa_document · select_scheme_package · remove_scheme_package ·
submit_claim · record_claim_settlement · record_claim_rejection. Reads: `readTpaBoard`, `readTpaPanel`.
Importer: `importSchemePackages` (CSV, NHA HBP column names accepted; dry run by default) + `scripts/import-scheme-packages.ts`.
Sample fixture `scripts/data/nha-hbp-sample.csv`: 8 synthetic rows — NOT the NHA list; the real list is loaded by the owner.

## Surfaces
- TPA desk board `/ipd/tpa` (menu, `ipd.payer.manage`): Pre-auths waiting (clock), Queries with us, Enhancement due,
  Claims to submit, Claims with payer (ageing). 16:9 desktop; one column at 390 px. en + hi.
- Per-admission TPA panel on the bill page `/ipd/admissions/:id/bill`: authorisation timeline, open queries (answer),
  documents (attach), packages (scheme), claims with reconciliation and Submit / Settle / Reject.
- Now card `ipd.tpa_due` (`ipd.payer.manage`): pre-auths ageing, enhancements due, claims over 30 days; admission
  number, never a name (money card rule, review #767). No doctor screen shows any of it.

## Not here
Portal automation (Phase 3), e-claim upload, insurer master per TPA, recovery of deductions from the patient, GST on
claims, an auto-filled pre-auth form.

## Done means (acceptance: `apps/core/src/modules/ipd/acceptance/tpa.acceptance.test.ts`)
- [ ] (i) A pre-auth requested at 10:00 is on the board ok at 10:30, warn at 11:15 (card "Pre-auth waiting 1 h 15 min"),
      hot at 12:01; an approval takes it off.
- [ ] (ii) An insurer query stops the insurer's clock and starts ours; answering it closes it; a stranger's document refuses.
- [ ] (iii) Approved ₹4,800: ₹2,200 claimable is not due; ₹4,400 (91 %) is "enhancement due" (warn), ₹6,600 is hot; a
      requested enhancement replaces it with a pre-auth waiting row (stage enhancement).
- [ ] (iv) Importer: the sample CSV dry-runs to 8 adds; apply writes them; a second run is 0 changes; a changed rate
      retires the old row; a bad row refuses the whole file and names the line.
- [ ] (v) A PM-JAY stay with two packages ₹30,000 + ₹20,000 shows payer amount ₹40,000; the patient owes ₹0 on every
      line; a receipt is refused; a package on a cash stay refuses `package_needs_scheme`.
- [ ] (vi) A settled bill's claim: submit refuses without summary + bill documents; with them it is "with payer".
- [ ] (vii) Settlement net + TDS + deductions ≠ claimed refuses; short-paid with two deductions reconciles to ₹0
      unexplained; the claim row is `settled` and a void of that bill refuses `payer_claim_settled`.
- [ ] (viii) A claim submitted 31 days ago shows on the card; a rejection then resubmission restarts its clock.
- [ ] (ix) Money off doctors: no TPA intent lists a doctor actor; the doctor role cannot read the board or the card.
