---
issue: 1116
status: approved
approved: 2026-11-19
---
# SPEC: Stores S6, the paying desk and the auditor agent: service bills, tax on the bill, MSME clock, holds and release, UTR, one Tally export (#1116) — APPROVED by owner 2026-11-19 (decision 0100)

Slice S6 of the Stores & Procurement programme (`docs/specs/stores-programme.md`). Written to decision 0099 Q4
(ruled 2026-11-18: one supplier list, one payables list, one payment run and one Tally export for pharmacy and
Stores, with reports split by department and item group) and Q2 (PO tiers). Needs S5 (#1115) for Stores POs;
bills from the existing GRN path work without it. Humans sign every payment, release and write-off.

## What exists (verified in `stores-s3` on 2026-11-19; file and symbol)

- **Bills.** `materials/supplier-bills.ts`: `createSupplierBill`, `matchSupplierBill` (3-way, tolerance
  `matchTolerancePaise`), `acceptSupplierBill`, `acceptBillDifference`, `billDraftFromGrn`, `payables`. A second
  bill with the same vendor bill number in one financial year is already refused (`assertNotDuplicate`,
  `duplicate_bill`, key `vendorBillKey`). **Every bill line needs a GRN**: `supplier_bill_lines.grn_id` is NOT NULL
  (`kernel/db/schema/materials.ts`), so a service bill (laundry, AMC, security) cannot be booked today.
- **GST** is split CGST/SGST or IGST per line (`splitGst`). There is no input-credit eligibility, no reverse
  charge and **no TDS** anywhere in materials.
- **MSME clock.** `dueDateFor`: a supplier with any `msme_class` (micro, small **or medium**: `isMsme`) falls due
  at acceptance + min(terms, 45) days, and **with no terms on file it uses 45** (`MSME_MAX_PAYMENT_DAYS`). The
  day of acceptance is the earliest posting day of the bill's GRNs (`acceptanceDayOf`), and the due date is
  written on the bill when it is accepted. The MSMED Act s.15 sets 15 days where there is no written agreement and
  covers micro and small enterprises only.
- **Payment runs.** `materials/payments.ts`: `planPaymentRun` (vendors in bank-change cooling-off listed apart and
  left out), `draftPaymentRun`, `submitPaymentRun`, `decidePaymentRun` (approval `materials_payment_run_approval`,
  the owner), `recordVendorPayment` (NEFT/RTGS need the UTR: `payment_reference_required`; cooling-off refused:
  `vendor_cooling_off`), `assertNotRunAuthoriser` (the authoriser cannot record the payment). Payment modes are
  NEFT, RTGS, UPI, cheque and cash (`supplier_payments_mode_ck`); a reference is required for all but cash and is
  not checked for shape or reuse. **No hold exists on a bill or a run line.**
- **Tally.** `pharmacy/tally.ts` `tallyExport` is the one TallyPrime export. It books **every** supplier bill as a
  Purchase voucher to one ledger whose default name is "Purchase — Medicines" (`DEFAULT_TALLY_LEDGERS`), with no
  cost centre and no TDS ledger, one amount per bill (not per line). A Stores bill exported today would land in
  medicines. The export is held by
  `billing_manager` and others with `pharmacy.tally.export`.
- **Who.** `materials.bills.manage` is held by `materials_head` and the pharmacy roles; `materials.payments.prepare` and
  `.record` by `materials_head` and `pharmacy_incharge` (`scripts/seed-roles.ts`). There is no accounts role.

## The flow (one journey per actor, end to end)

1. **Department confirms a service (phone).** For a service contract (laundry per piece, AMC visit,
   housekeeping or security manpower, caterer), the confirmer sees "Service to confirm / सेवा की पुष्टि करें" when
   the contract's period ends (a month for most; the start of the term for a prepaid AMC) with the quantities
   prefilled from the source module (the linen module's piece count, S4's AMC visits, attendance-based headcount
   when that feed exists, else typed). One tap **Confirm / पुष्टि करें**, or **Short / कम** with the difference.
   That is the service entry sheet (SES), the GRN of a service.
2. **Accounts officer books the bill (16:9).** Opens "To book / बुक करना है": GRNs and SESs without a bill. Picks one,
   types only what is on the paper (supplier's bill number, date, amounts); everything else is prefilled from the PO,
   GRN or SES. Per line HMIS proposes GST input credit (Eligible / Not available / Shared) and TDS (nature, section and rate from
   the CA-signed table); the officer confirms. The match runs; differences show as words.
3. **Holds place themselves.** On booking and again when a run is drafted: duplicate-like bill, out-of-pattern
   amount, bank change in cooling-off, KYC incomplete, bill above PO, pay-after-GRN unmet, e-invoice number
   missing. Each hold names its rule and the rows behind it. At launch they cover bills with a Stores line or a
   service line; pharmacy-only bills join when the owner switches it on after a dry run (decision 13).
4. **Releaser (phone or desk).** "Holds to clear / रोक हटानी है": one card per hold with its evidence. **Release /
   रोक हटाएँ** with a typed reason, or **Keep / रोके रखें**. The booker cannot release their own bill's hold. The
   cooling-off hold cannot be released by anyone (it ends by time).
5. **Payment run.** Monday (DECIDED: weekly, plus on demand) `draftPaymentRun` lists due bills; held lines are shown
   apart and never included. MSME bills due in ≤ 5 days sit on top in red with the word "Due soon / जल्द देय". The
   materials head submits; the owner authorises on the phone in 2 taps, seeing the total, count, MSME count and how
   many are held out.
6. **Pay and record.** The bank upload is made outside HMIS; the payer records each payment with its UTR (scan of
   the bank advice or typed). The supplier ledger and payables move by themselves.
7. **Accountant.** Once a month **Tally export / Tally निर्यात**: one file for pharmacy and Stores together, Stores
   purchases to category ledgers with department cost centres, tagged equipment to fixed-asset ledgers, TDS to TDS
   payable ledgers.
8. **Auditor agent (T1), nightly.** Flags leaks (department use out of pattern per bed-day or visit, price drift
   against contract, POs split under a limit, one person at both ends of a chain, repeated "More than book"). Each
   flag cites documents and rows, names departments, never a person. The materials head or the stores auditor
   marks it Upheld (with one line on what was done) or Dismissed (with a reason); upheld flags go on the owner's
   monthly list.
9. **Look back.** `storesAuditPack({bill})` and `({vendor})`: ticket → PR → PO → GRN or SES → bill → holds and
   releases → run → authorisation → payment and UTR → department charged (programme I3).

## Decisions

1. **One book (ruled).** Stores bills are `supplier_bills`, in the same payables, runs and export as pharmacy. No
   second payables table. Reports split by department (cost centre) and item group (category; drugs as one
   group).
2. **Service entry sheet.** `stores_service_entries`: contract (an S5 award or PO on class `service` items),
   period (by the contract's terms: a month, a quarter, one visit, or "term started" for a contract billed in
   advance by its own terms), lines (item, quantity, rate from the PO), confirmed by, at, and the source reference
   (`laundry_month`, `amc_visit`, `manpower_month`, `canteen_month`, `term_start`). Confirmer: `stores.ses.confirm`
   at the department that receives the service. One SES per contract and period (`ses_exists`); a short is a line
   difference, not an edit. The SES is append-only; a correction is a reversing SES naming the first.
3. **Bill lines from an SES.** Additive schema change on a shared pharmacy table: `supplier_bill_lines.grn_id`
   becomes nullable, a new nullable `ses_id`, and a CHECK that exactly one is set. Every existing row has a GRN, so
   no row changes. `billDraftFromSes` mirrors `billDraftFromGrn`. The 3-way match is PO × SES × bill.
4. **GST on the bill** (rules for the CA to sign; HMIS states them, it does not advise). Two marks per line, each
   proposed from a rule table keyed on category and supplier type and confirmed by the accounts officer:
   - **Credit:** `eligible` (used for taxable sales), `not_available` (used for exempt healthcare, or a credit
     the law blocks, such as food or works on a building), or `shared` (used for both; the split is the
     accountant's monthly working, outside HMIS). Ruled (decision 0100 Q2): Stores lines default to `not_available`; accounts marks a line `eligible` where the CA allows it; the CA signs the rule table before go-live; pharmacy's bills are not touched.
   - **Reverse charge:** yes or no. With yes the supplier's bill carries no GST, the supplier is paid without
     it, and the export carries the liability for the accountant to pay; whether that tax is credited follows the
     Credit mark.
   - **Cost to the department.** The ledger and S1's charge stay at batch cost before GST (unchanged). The spend
     report and the budget add a second, derived figure "GST not credited / बिना क्रेडिट GST": charge × the GRN
     line's GST rate where the line's Credit mark is `not_available` (the category's default until the bill is
     booked). Nothing is written to the ledger for it.
   - **Pharmacy lines keep today's treatment:** a drug line has no mark (null) and exports to the input GST
     ledgers exactly as now. S6 never proposes a mark on a drug line.
   - **E-invoice.** The bill form takes the invoice reference number (IRN) when the paper carries one. For a
     supplier whose declaration says e-invoicing applies to it (S5a's `einvoice_applicable`), a bill with an
     `eligible` line and no IRN is held (`irn_missing`), because such a bill is not a valid tax invoice for
     credit. HMIS does not check the IRN against the GST portal. Matching credit to the supplier's filed return
     and reversing credit on bills unpaid after 180 days are the accountant's, outside HMIS.
5. **TDS on the bill** (rules for the CA to sign). `stores_tds_rules`, versioned, **shipped empty**:
   - A row: nature of payment (contract or manpower, professional or technical fee, rent, commission, purchase of
     goods), the Act's section reference as text, rate by payee type (individual or HUF, others), threshold kind
     (one bill, a month, or the supplier's total in the financial year) and amount, the rate when PAN is missing,
     and whether the row is switched on.
   - Section numbers are data, never code: the Income-tax Act, 2025 (in force from 1 April 2026) renumbered them.
   - The base is the line's value before GST when the bill shows GST apart.
   - A supplier's lower or nil deduction certificate (a vendor document with rate and validity) overrides the
     row while valid.
   - TDS is proposed per line at booking (deducted when the bill is credited; for an advance, when it is paid),
     the accounts officer confirms or changes it with a reason, and the payable is the bill total less TDS.
   - The table is filled and signed by the CA through the accounts officer (a document upload and a sign event).
     With no signed table nothing is suggested, the bill shows "TDS not checked / TDS जाँच नहीं", and **every
     bill, pharmacy's included, books and pays exactly as today**.
   - **Pharmacy effect, to be signed knowingly:** the purchase-of-goods row, once switched on, also proposes TDS
     on a pharmacy supplier past the yearly threshold (one book). `tdsDryRun` lists the bills and amounts it
     would touch before the row is switched on.
   - Challans, returns and certificates stay in Tally.
6. **MSME clock** (rules for the CA to sign). Ruled (decision 0100 Q1): follow the Act as below, micro and small only, clock from delivery; it ships switched off and is switched on after the dry run.
   - **Who is on the clock:** a supplier with a Udyam registration classed micro or small. A medium enterprise
     follows its ordinary terms. Whether a micro or small **trader** is on the clock is the CA's line in the
     settings (default: on the clock, the cautious side).
   - **When the clock starts:** the day of acceptance, which is the day the goods were delivered (the GRN's
     posting day, `acceptanceDayOf`, unchanged) or the service was rendered (the SES period's last day; the start
     day for a "term started" SES). A written objection inside 15 days (a QC rejection or a "Short") moves the
     start to the day the objection is closed. Waiting does not move it.
   - **When it is due:** 15 days after acceptance with no written agreement; the agreed days with one, never more
     than 45. The agreement is the vendor document `payment_terms_agreement` (S5a).
   - **If late:** the desk shows "Overdue / देय बीत गया" and "Interest accrues / ब्याज लग रहा" with the days late.
     HMIS computes no interest (the Act's rate is three times the bank rate, compounded monthly; the figure is
     the CA's) and reminds that a bill paid late is deductible for tax only in the year it is paid.
   - **Report:** MSME dues outstanding beyond 45 days, half-yearly (the content of the companies' MSME return,
     if the hospital files one).
   - **This changes pharmacy's numbers** (one book): micro and small suppliers with no agreement fall due at 15
     days instead of 45, and medium suppliers stop being capped at 45. So it ships behind a setting (decision
     13), off, with `msmeDryRun` listing each open bill whose due date would move. Switched on, it applies to
     bills accepted from that day; a due date already written on a bill never changes.
7. **Holds (`stores_bill_holds`, append-only; derived "open" = placed and not released).**
   - `duplicate_like`: same supplier, same total, bill dates within 7 days, different number (the exact-number
     case is already refused).
   - `out_of_pattern`: total above 2 × the 90th percentile of that supplier's bills in 12 months, or a first
     bill above ₹1,00,000 (DECIDED thresholds, tunable by the materials head, every change an event).
   - `bank_cooling_off`: the supplier's `first_payment_allowed_at` is in the future (existing); not releasable.
   - `kyc_incomplete`: S5's "KYC complete" rule.
   - `above_po`: bill above PO value beyond the match tolerance.
   - `pay_after_grn`: a pay-after-GRN PO with no posted GRN or SES behind the bill.
   - `irn_missing`: decision 4.
   Holds are placed by rules, not by the agent. An open hold keeps its line out of every run draft, and
   `submitPaymentRun` re-checks (a hold placed after drafting refuses submit: `line_on_hold`). **Scope:** a bill
   with at least one Stores item line or SES line. A pharmacy-only bill gets no hold until decision 13's switch.
8. **Release.** `releaseHold(holdId, reason)` by a holder of `stores.holds.release` within the value rule (ruled, decision 0100 Q6: up
   to ₹50,000 the materials head, above that or when the materials head is barred the owner), never the bill's booker, never the person who approved that bill's PO, never the run's
   authoriser for their own run's lines, never `bank_cooling_off`. A release is an event and a row; a re-placed
   hold is a new row. **Keep** needs a reason and sets a review date (at most 30 days); a kept hold on an MSME
   bill stays red on the desk, because the clock does not stop for a hold.
9. **Run and payment.** Existing `createPaymentRun` / `draftPaymentRun` / owner authorisation unchanged, plus the
   hold filter. `recordVendorPayment` already needs a reference for every mode but cash; S6 adds, for payments
   recorded from the day it ships (pharmacy's included; old rows are not touched):
   - shape by mode (DECIDED): NEFT 16 letters and digits, RTGS 22, UPI 12 digits; cheque as today
     (`reference_shape`);
   - no reuse: the same reference on an earlier payment of the same mode is refused (`utr_reused`), checked in
     the intent and by a partial unique index over rows recorded after the cut-over.
10. **Tally export (shared with pharmacy, additive).** Purchase vouchers get a ledger per item group, read per
    bill line: drugs keep "Purchase — Medicines"; Stores lines go to a purchase ledger per top category; S4
    tagged equipment goes to a fixed-asset ledger per category; GST marked `not_available` goes into the purchase
    or asset amount and not to the input GST ledgers; reverse charge to its own liability ledger; TDS to "TDS
    payable — <nature>"; every Stores line carries the department's cost centre. A bill with drug and Stores
    lines is one voucher with several ledger lines. Ledger names are configurable as today, and the export
    refuses with the list of names still missing. For a period with drug bills only and no TDS, the file is
    byte-identical to before (golden file captured on `main`).
11. **Auditor agent (T1).** Nightly, after S7's planner if present. Flags (`stores_audit_flags`): use out of pattern
    (department use per bed-day or visit > 1.5 × its own 12-week median), price drift (GRN rate > contract + 2 %),
    split POs (same supplier and category, ≥ 2 POs within 7 days each under a tier limit whose sum crosses it), one
    person at both ends (the same user on PR raise and GRN QC, on PO approval and bill booking, or on bill
    booking and payment recording), "More than book"
    ≥ 3 times in a quarter at one shelf. Every flag cites its rows; its text names departments and documents only;
    the person is visible only by opening the cited document under its own grant. Never: a hold, a release, a payment
    or a supplier message. Review: Upheld needs one line on what was done and goes on the owner's monthly list;
    Dismissed needs a reason; a flag unreviewed for 7 days is a tower card. Climbing to T3 (placing a hold) needs 8 weeks with ≥ 90 % of flags upheld and the owner's
    yes; S6 ships T1 only.
12. **Who.** `stores.ses.confirm` (department scope: `department_head`, `department_store_incharge`; biomedical
    for AMC), `stores.holds.release`, `stores.tax.manage` (the TDS and GST-credit tables; `accounts_officer`). The new role
    `accounts_officer` (seeded with no holders) also gets `materials.bills.manage`, `materials.payments.prepare`,
    `materials.payments.record` and `pharmacy.tally.export`, and `stores.audit.read`.
13. **Settings that touch pharmacy are switches, off at merge.** `stores_paying_settings`, versioned:
    `holds_cover_pharmacy` (off), `msme_rule` (`as_today` | `act`; `as_today`), and the TDS rows' own switches.
    Each has a dry run that writes nothing (`holdsDryRun`, `msmeDryRun`, `tdsDryRun`) and is switched by the
    owner's recorded yes. With all of them off, every pharmacy bill, payable, run and export is as before S6.

## Audit by construction

- Every act (SES confirm, bill book with tax lines, hold placed, release, keep, run draft, submit, authorise,
  payment and UTR, TDS table sign, flag upheld or dismissed, export) appends one event with actor, role, time,
  amounts before and after, and reason. A settings switch is an event naming the dry run it followed.
- SES rows, holds and releases, TDS table versions and audit flags refuse UPDATE and DELETE (trigger). A table
  change is a new signed version; a bill keeps the version it was booked under.
- Separation of duties is enforced in intents (booker ≠ releaser; the run's authoriser ≠ the payment's recorder,
  existing `assertNotRunAuthoriser`, SoD pair `payment_authoriser_recorder`; flag reviewer ≠ the department's HOD).
- Every auditor flag is a `copilot_acts` proposal with the reviewing person; `storesAuditPack({bill | vendor})`
  lists the money chain in `seq` order; each export writes one event.

## Done means

Each id is one acceptance test that calls intents, passes `now` in and is red against `main`. "Refused" means
the named code and no row written. D1–D10 are S6a, D11–D16 are S6b, D17–D18 are S6c. A "same as before" clause
is checked against a golden result captured on `main` in the lane's first commit.

- **D1** `confirmServiceEntry` for a laundry contract and month creates one SES; a second for the same contract and
  month is refused (`ses_exists`); `billDraftFromSes` then a booked bill makes one payable, once. A "term started"
  SES for a prepaid AMC makes the bill payable with no `pay_after_grn` hold.
- **D2** A bill line with neither a GRN nor an SES is refused; a line with both is refused. With
  `payingSettings()` all off (its default), a pharmacy fixture bill has the same view, due date, payable,
  `payables` total and `planPaymentRun` result as the golden.
- **D3** On a Stores bill each rule places one hold citing its rows: a same-total bill from the same supplier 3
  days apart with a different number (`duplicate_like`); a bill 3 × the supplier's 90th percentile
  (`out_of_pattern`); a bill above its PO (`above_po`); a pay-after-GRN bill with no GRN (`pay_after_grn`); a
  supplier that is not "KYC complete" (`kyc_incomplete`). Booking the same bill twice places no second hold.
- **D4** A pharmacy-only bill that meets a hold rule gets no hold while `holds_cover_pharmacy` is off;
  `holdsDryRun` lists it and writes nothing; after the owner's switch a newly booked one is held.
- **D5** A line with an open hold is absent from `draftPaymentRun`; a hold placed after drafting makes
  `submitPaymentRun` refuse (`line_on_hold`). `releaseHold` without a reason is refused; by the bill's booker, by
  the PO's approver and above the releaser's value limit it is refused; a `bank_cooling_off` hold is refused for
  everyone. `keepHold` without a reason is refused.
- **D6** A NEFT reference of 12 characters is refused (`reference_shape`) and one of 16 accepted; a UPI reference
  of 12 digits is accepted; a reference already used on an earlier payment of that mode is refused
  (`utr_reused`); a cheque payment records as before.
- **D7** `payablesByGroup` splits open payables by item group and by department; the parts sum to `payables`'
  total to the paisa.
- **D8** (audit) Every S6a act appends one event; UPDATE and DELETE on SES rows, holds and releases are refused
  by the database; `storesAuditPack({bill})` lists PO → GRN or SES → bill → holds and releases → run →
  authorisation → payment with its reference, in order, with actor and role.
- **D9** (web, 16:9) The paying desk at 1366 × 768 shows To book, Holds, Due, Runs, Payments and Exports; MSME
  bills due in ≤ 5 days sit on top with the word "Due soon"; every status is a word.
- **D10** (web, 390 px) The owner authorises a run from its notice in ≤ 2 taps, seeing total, bills, MSME count and
  "n held out", with no horizontal scroll.
- **D11** A Stores line marked `not_available` adds its GST to the department's "GST not credited" figure and
  leaves `departmentChargeOn` unchanged; `eligible` adds nothing. A drug line carries no mark and none is
  proposed. A reverse-charge line leaves the supplier payable without GST and appears in the export's liability
  lines.
- **D12** With no signed TDS table, a bill books with "TDS not checked" and no TDS. With a signed table: a
  manpower bill under the one-bill threshold proposes none and one over it proposes the row's rate on the value
  before GST; a supplier past the yearly threshold is proposed on the next bill; a missing PAN uses the
  PAN-missing rate; a valid lower-deduction certificate uses its rate; the payable equals total − TDS; changing
  it needs a reason; a later table version leaves a booked bill's TDS unchanged.
- **D13** `tdsDryRun` for the purchase-of-goods row lists the pharmacy bills it would touch and writes nothing;
  with the row off, a pharmacy bill past the threshold books with no TDS.
- **D14** For a supplier declared for e-invoicing, a bill with an `eligible` line and no IRN is held
  (`irn_missing`); with an IRN, or with only `not_available` lines, it is not.
- **D15** With `msme_rule: act`: a micro supplier's bill accepted on day 0 with no agreement is due on day 15;
  with an agreement of 60 days, day 45; of 30 days, day 30; a medium supplier's follows its terms; a QC rejection
  on day 5 closed on day 9 gives day 24. With `as_today`, each is due as on `main`. Switching to `act` leaves an
  already accepted bill's due date unchanged, and `msmeDryRun` lists it. At 5 days left a bill reads "Due soon";
  past due, "Overdue".
- **D16** The Tally export for a month with one Stores bill puts its lines on the category purchase ledger with the
  department cost centre, a tagged unit on the asset ledger, `not_available` GST inside the purchase amount, and
  TDS on its ledger; a missing ledger name refuses the export with the list. A drug-only month's file is
  byte-identical to the golden.
- **D17** The auditor raises a split-PO flag for two POs of ₹30,000 each, same supplier and category, 3 days apart,
  and a both-ends flag when one user booked a bill and recorded its payment; every flag cites rows; no flag's
  text contains any user's name (asserted against the users table); the auditor places no hold.
- **D18** `reviewFlag` Upheld without a note, or Dismissed without a reason, is refused; a review by the flagged
  department's HOD is refused; an upheld flag is on `ownerMonthlyList`; UPDATE and DELETE on flags and reviews
  are refused by the database; every flag is a `copilot_acts` proposal naming its reviewer.

## Screens

Desk 16:9 (fits 1366 × 768); confirm, release and authorise on a 390 px phone. Every status is a word. Notices are
a few words on one line. Strings verbatim, English / Hindi. Loading is grey rows with no text. Supplier names and
amounts never appear in a notice.

- **Service to confirm (phone, department).** Header: service · month. Rows: line · quantity prefilled. Primary:
  **Confirm / पुष्टि करें**; secondary "Short / कम" (quantity and one line). Done: "Confirmed / पुष्टि हुई".
  Refused: "Already confirmed / पहले ही पुष्टि", "Not your department / आपका विभाग नहीं".
- **Paying desk (16:9).** Tabs: To book / बुक करना है, Holds / रोक, Due / देय, Runs / भुगतान रन, Payments / भुगतान,
  Exports / निर्यात. Bill status words: Booked / बुक, Matched / मिलान हुआ, Difference / अंतर, Accepted / स्वीकार,
  On hold / रोक पर, In run / रन में, Paid / भुगतान हुआ, Cancelled / रद्द. Due words: Due soon / जल्द देय, Overdue / देय
  बीत गया, Interest accrues / ब्याज लग रहा. Tax words: Eligible / क्रेडिट मिलेगा, Not available / क्रेडिट नहीं, Shared / साझा, Reverse
  charge / रिवर्स चार्ज, TDS not checked / TDS जाँच नहीं, IRN missing / IRN नहीं. One primary per tab: Book bill, Release, (none), Draft run,
  Record payment, Download. Empty: "Nothing here / यहाँ कुछ नहीं".
- **Hold card (phone or desk).** Rule as words: Looks duplicate / दोहराया लगता है, Unusual amount / असामान्य राशि, Bank
  changed recently / बैंक हाल में बदला, KYC incomplete / KYC अधूरा, Above PO / PO से ज़्यादा, Goods not received / माल
  नहीं आया, IRN missing / IRN नहीं. Evidence rows (documents). Primary: **Release / रोक हटाएँ**
  (reason box); secondary "Keep / रोके रखें" (reason, review date). Refused: "Your own bill: ask <releaser> /
  आपका अपना बिल: <releaser> से कहें", "You approved this PO / यह PO आपने मंज़ूर किया", "Ends by itself on <date> /
  <date> को अपने आप खत्म", "Above your limit: goes to the owner / आपकी सीमा से ज़्यादा: मालिक के पास".
- **Authorise run (phone, owner).** One line: "₹ total · n bills · m MSME · k held out". Primary: **Authorise /
  अधिकृत करें**; secondary "Send back / वापस भेजें" (reason).
- **Record payment.** Rows: bill · amount · mode. UTR box (scan the advice or type). Primary: **Save / सेव करें**.
  Refused: "UTR needed / UTR ज़रूरी", "UTR already used / UTR पहले इस्तेमाल", "Check the number: NEFT has 16 /
  नंबर जाँचें: NEFT में 16".
- **Audit flags (desk, materials head and stores auditor).** Rows: kind · department · documents · since. Primary:
  **Upheld / सही पाया** (one line: what was done); secondary "Dismiss / खारिज" (reason).
- **Settings (desk, owner).** Three rows, each a word (Off / बंद, On / चालू) with **See what changes / क्या
  बदलेगा** (the dry run) before **Switch on / चालू करें**: Holds on pharmacy bills / फ़ार्मेसी बिलों पर रोक, MSME
  15-day rule / MSME 15 दिन का नियम, TDS on goods / माल पर TDS.
- **Notices, verbatim.** "Service to confirm / सेवा की पुष्टि करें", "Holds to clear / रोक हटानी है", "Run to
  authorise / भुगतान रन अधिकृत करें", "MSME bill due soon / MSME बिल जल्द देय", "Flags to review / जाँच के संकेत".

## Budgets

- Bill booking from a GRN or SES ≤ 90 s, typing only the supplier's number, date and amounts.
- MSME bills paid late: 0 (red at 5 days). A hold reviewed ≤ 2 working days. Authorise ≤ 2 taps.
- 100 % of payments trace to an accepted bill, and 100 % of NEFT/RTGS payments carry a unique UTR.

## Edge cases

1. **Supplier sends one bill for two months of service.** Two SES; one bill with lines on both.
2. **Credit note from a supplier.** Existing vendor credit and debit note flow; holds do not apply to credits.
3. **Advance payment.** Ruled (decision 0100 Q7): equipment only, up to 30 % against a bank guarantee, with the owner's approval; such an advance is a bill-less payable with its own hold
   until the GRN.
4. **Caterer pays rent and is paid for meals.** Both gross: the meals bill here, the rent invoice outside S6;
   any set-off is an accounts journal in Tally (DECIDED: no netting in HMIS).
5. **Supplier changes bank twice in a month.** Each change restarts the cooling-off (existing rule).
6. **PAN missing.** The TDS table's PAN-missing rate applies and KYC holds the bill.
7. **Same person is accounts officer and releaser.** Allowed only for bills they did not book.
8. **Auditor flag about a department of one person.** Department-level text still points at one person; the flag
   goes only to the materials head and the stores auditor, never to a notice board (decision 0079 precedent).
9. **Tally ledger names not yet set for a category.** Export refuses with the list of missing names, before writing.
10. **One bank transfer pays two bills of one supplier.** One payment row with two allocations, one reference
    (existing shape); two payment rows with one reference are refused.
11. **A hold is kept past an MSME due date.** The bill stays red with "Interest accrues"; the hold's keeper and the
    owner get one notice at 5 days left. HMIS never pays around a hold.
12. **A supplier drops below or crosses the e-invoice limit.** The declaration is re-taken yearly with KYC; the
    hold follows the declaration on file on the bill's date.
13. **Equipment paid in parts** (most on delivery, the rest after installation). The existing part-payment of a
    bill is used; the balance stays in payables until biomedical records `installed` (S4). A formal retention
    register is out of scope.

## Out of scope

- Bank integration and bank statement import; TDS challans, returns and certificates (Tally); the rent and other
  receivables; e-invoice IRN validation against the GST portal (paid data); matching credit to the supplier's
  filed return; the monthly split of shared credit; interest computation on late MSME bills; a retention register;
  vendor portal; forex.

## Build notes

- **Three PRs** (was L in one; three pharmacy-live files are touched, so each PR touches at most two).
  **S6a** (`Refs #1116`): service entries, bill lines from an SES, holds, release, reference shape and reuse,
  `payablesByGroup`, settings, paying desk (D1–D10); touches `supplier-bills.ts` and `payments.ts`. **S6b**
  (`Refs #1116`): GST marks, TDS, IRN, MSME rule, Tally split (D11–D16); touches `supplier-bills.ts`
  (`dueDateFor`, `payables`) and `pharmacy/tally.ts`. **S6c** (`Closes #1116`): the auditor agent and its review
  (D17–D18); touches no pharmacy file.
- **Before any materials or pharmacy edit**, the lane's first commit adds characterisation tests (green on
  `main`, outside `acceptance/`) and golden files for: a pharmacy bill's view, due date and payable; `payables`;
  `planPaymentRun`; a recorded NEFT payment; `tallyExport` for a drug-only month.
- **Files.** Stores: `service-entries.ts`, `tax-on-bill.ts`, `holds.ts`, `msme.ts`, `paying-settings.ts`,
  `auditor-agent.ts`, `paying-reads.ts`, desk providers. Materials, additive: `billDraftFromSes`, the hold filter
  in `draftPaymentRun` / `submitPaymentRun`, the MSME rule in `dueDateFor` read from the setting (behaviour
  change only when switched; ruled, decision 0100 Q1), TDS in `payables` (null = as today), reference shape and
  reuse in `recordVendorPayment`. Pharmacy (`pharmacy/tally.ts`), additive: purchases read per line, ledger by
  item group, cost centres, TDS and reverse-charge ledgers; the drug-only file is unchanged.
- **Migration** one per PR. S6a: `supplier_bill_lines.grn_id` nullable + `ses_id` + one-of CHECK (shared live
  pharmacy table; every existing row has a GRN, so none changes), `stores_service_entries`, `stores_bill_holds`
  (+ releases), `stores_paying_settings`, a partial unique index on `supplier_payments (mode, reference)` for bank
  modes over rows recorded after the cut-over (old duplicates cannot fail the deploy). S6b: bill-line Credit,
  reverse-charge and TDS columns and the bill's IRN (all nullable), `stores_tds_rules` (versioned). S6c:
  `stores_audit_flags` (+ reviews).
- **Worker** the nightly auditor and the hold re-check ride an existing nightly job if one fits, else one new job
  (`worker.module.ts`, SHARED; read the pool-sizing note).
- **Permissions** `stores.ses.confirm`, `stores.holds.release`, `stores.tax.manage` (3), role `accounts_officer`
  (if first) with the grants in decision 12. Seed-roles pins and README prose.
- **Shared files:** `pharmacy/tally.ts` (pharmacy's module: coordinate), materials supplier bills and payments,
  seed-roles + test, schema index, drizzle, router, locales, caddyfile parity (`/stores/pay`).
- **Size** XL (three PRs). **Depends on** S5a (vendor fields, KYC) and S5b for Stores POs and service
  contracts (the GRN path works without). **Blocked by** the CA's TDS and GST-credit
  tables at go-live (not for the build: D12 signs a test table); S6-Q1 (D5), S6-Q2 (D15) and
  S6-Q3 (D11's default) are ruled (decision 0100 Q6, Q1, Q2).
