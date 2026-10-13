---
type: module-notes
title: "ipd — module notes"
description: "Why and traps of the inpatient module: validated bed and ward attributes and the bed-layout loader (E0.3), the bed intents and the Beds board (E1.1), admission — request, plan and deposit from the tariff, admit onto a bed in one transaction, the payer record, the band, the emergency lane and the downtime back-fill (E1.2) — and the running bill: tariff lock, day rule, nightly posting, visit seam, reversals, interim bill (E2.1) — and the payer split: payer- or patient-payable per line, room-rent cap with proportional deduction, co-pay, approved amount, denial to cash, scheme ₹0 (E2.2) — and transfers: start with an SBAR handover, accept by the receiving nurse, cancel, the atomic swap and the class change in place at the next noon (E3.1) — and discharge: fit, departments confirm, structured summary, final bill with payer claim and dues, gate pass, LAMA / abscond / death, mortuary register (E3.2)."
resource: apps/core/src/modules/ipd
tags: [ipd, beds, resources, admission, billing, transfer, discharge, now-cards, bed-flow]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# ipd — module notes

Hand-written notes: the WHY and the traps. Signatures are generated in `docs/architecture/modules/ipd.md`.
Paths are relative to `apps/core/src/modules/ipd/` unless they start with a module name, `kernel/`, `scripts/`,
`packages/` or `apps/`. Citations name a file and a symbol, never a line number. The spec is
SPEC-ipd-core-2026-10-12 §4.1 (kept outside the repository); the plan is decision 0072, issue #715 (E0.3).

## 1. Purpose
The inpatient module. E0.3 starts it with the BED REGISTRY: every floor, ward, hall, room and bed of the
hospital as rows of the kernel resource registry (`kernel/resources`), with IPD's own facts about a bed and a
ward kept in `resources.attributes`. Later lanes add the bed board, admission, transfer, nursing and discharge.
E1.1 (#718) adds the module surface: `manifest.ts` (four `ipd.beds.*` permissions, the Beds menu), `IpdModule`
(the bed routes under `/ipd/beds`, the live topic `ipd_beds:board`) and the bed intents behind the Beds board.

## 2. Key files (owner of what)
- `bed-attributes.ts` — `IpdBedAttributesSchema` (class, gender rule, isolation, negative pressure, ICU flag,
  equipment, day care, overflow) and `IpdWardAttributesSchema` (department code, unit type, ward or hall). The
  rules live in the schema's refinements: airborne needs negative pressure; class `overflow` ⇔ `overflow: true`;
  class `daycare` ⇔ `daycare: true` (DECIDED, E0.3); no equipment tag twice.
- `bed-layout.ts` — `parseBedLayoutCsv` (header row 1; refuses missing or unknown columns), `validateBedLayout`
  (pure: rows → plan or every problem), `loadBedLayout` (diff and, with `apply`, write in one transaction) and
  `formatBedLayoutReport` (the dry-run summary).
- `errors.ts` — `IpdError`; `bed_layout_invalid` carries `detail.problems`.
- `packages/contracts/src/ipd-bed-classes.ts` — `IPD_BED_CLASSES` and `IPD_BED_CLASS_INFO` (census and rates
  flags). Shared with the rate card lane: do not rename its exports.
- `scripts/load-bed-layout.ts` — `runBedLayoutLoad`: `--file`, `--by`, `--apply`. Not a seed.
- `scripts/data/gen-ipd-bed-layout.ts` — `planningBedLayoutCsv` writes `scripts/data/ipd-bed-layout.planning.csv`.
- `beds.ts` (E1.1) — the bed intents: `reserveBed`, `releaseReservation`, `assignBed`, `blockBed`, `unblockBed`,
  `markBedClean`, `releaseIncumbentBed`; the bed-master act `retireBed`; the job `lapseBedReservations(db, now)`;
  the seams `releaseBedOccupant(tx, …)` (discharge/transfer empty a bed through it) and `markBedCleanIn(tx, …)`
  (housekeeping's task completion calls it); the cutover `markIncumbentBeds`; `nextRuleValidBeds`.
- `bed-rules.ts` — `checkBedRules`, the one pure rule check every bed act and (later) every Bed Flow proposal asks.
- `beds-board.ts` — `readBedBoard(db, actor, { wall })`, the board's read model (`IpdBedBoard` in contracts).
- `bed-events.ts`, `realtime.ts`, `beds.controller.ts`, `ipd.module.ts`, `manifest.ts`.
- `kernel/db/schema/ipd.ts` — `ipd_bed_reservations`, `ipd_bed_blocks`, `ipd_bed_stays` (migration `ipd_beds`).
- `packages/contracts/src/ipd/bed-board.ts` — board schema, routes, topic, `IpdRefusalBody`.
- `scripts/mark-incumbent-beds.ts` — `--file`, `--by` (holds `ipd.beds.manage`), `--apply`. Not a seed.
- `apps/web/src/screens/ipd-beds.tsx` — the board (route `/ipd/beds`, `?wall=1` for wall displays).

- `admissions.ts` (E1.2) — `requestAdmission`, `cancelAdmission`, `admit`, `emergencyAdmit`, `backfillDowntime`,
  `recordConsent`, `recordStabilised`, `incompleteOf`. `admission-core.ts` — lock/read, `moveAdmission` (workflow
  instance + mirror in one tx, engine refusals → IPD words), `mintAdmissionNo` (`IP26-000123`), and the links the bed
  intents call (`linkReservation`, `linkReservationEnded`, `linkPlacement`).
- `deposit.ts` — `IPD_DEPOSIT_POLICY` (decision 0072's days and percentages), `quoteDeposit` (pure), `planAdmission`,
  `takeDeposit` (thin wrapper over billing `recordReceipt`), `ipdNonPayableDepositCode`.
- `payer.ts` — `recordPayerAuth` (the manual authorisation record). `bands.ts` — `printBand`, `reprintBand`,
  `allergyWords`. `approval-types.ts` — the three IPD approval types and `registerIpdApprovalTypes` (go-live step).
- `admission-read.ts` — the desk's reads (view, quotes, bed proposals, OPD advice, consultants, `askApproval`).
- `admissions.controller.ts` — `/ipd/admissions/*` (`IPD_ADMIT_ROUTES`). `admission-events.ts` — the events.
- `kernel/db/schema/ipd.ts` — `ipd_admissions`, `ipd_payer_auths`, `ipd_admission_deposits`, `ipd_bands` (migration
  `ipd_admit`). `packages/contracts/src/ipd/admissions.ts` — read models and routes.
- `apps/web/src/screens/ipd-admit.tsx` — the Admit sheet (`/ipd/admit`, `?admission=<id>`); the Beds board's waiting
  column links to it.

- (E2.1) `charge-days.ts` — `ipdChargeableDays(stays, admittedAt, dischargedAt, upToIstDate)`, the pure day rule;
  `rentClassOf`, `classRank`. `charges.ts` — `postAdmissionCharges` (one admission up to a day), `postNightlyIpdCharges`
  (the job), `postConsultantVisit(tx, …)` (the rounds seam), `reverseChargeLine`, `priceComponent`. `interim-bill.ts` —
  `readInterimBill`. `charge-events.ts` — `ipd.charge.rent_posted` (G5b), `.visit_recorded`, `.exception_raised`,
  `.reversed`. `kernel/db/schema/ipd.ts` — `ipd_charge_lines`, `ipd_charge_exceptions`, `ipd_admissions.tariff_version_id`
  (migration `ipd_charges`). `packages/contracts/src/ipd/charges.ts` — `IpdInterimBill`, `IPD_CHARGE_ROUTES`.
  `apps/web/src/screens/ipd-bill.tsx` — the interim bill (`/ipd/admissions/$admissionId/bill`, no nav entry).

- (E2.2) `payer-split.ts` — THE PURE ENGINE: `splitBill(lines, terms, nonPayables)` (per line payer paise, patient paise,
  reason codes; totals; words), `splitTermsOf(payerKind, authRows, sumInsured, schemeNonCovered)` (the record → terms),
  `capWarningOf`, `distributeGroup`, `CAP_EXEMPT_CLASSES`, `PROPORTIONAL_COMPONENTS`. `payer-bill.ts` — its inputs from the
  database (`computePayerSplit`, `loadSplitTerms`, both `Db | Tx`), `roomRentCapWarning(db, actor, admissionId,
  targetClass)`, `capWarningsFor` (the admit sheet's class cards), the non-payables list (`listPayerNonPayables`,
  `addPayerNonPayable`, `retirePayerNonPayable`). `payer.controller.ts` — `IPD_PAYER_ROUTES`. `kernel/db/schema/ipd.ts` —
  `ipd_payer_auths.room_rent_cap_paise` / `room_rent_cap_si_bp` / `co_pay_bp`, `ipd_payer_non_payables`,
  `ipd_payer_split_snapshots` (migration `ipd_payer`). `packages/contracts/src/ipd/payer.ts` — `IpdPayerSplit`,
  `IpdRoomRentCapWarning`, routes; the interim bill carries `payerSplit` and `patientBalancePaise`; `IpdClassQuote.capWarning`.
  `patients` `coverageSumInsuredPaise` (new; the only patients read). Web: `apps/web/src/screens/ipd-bill.tsx` Payer/Patient columns and
  the Payer split card; `apps/web/src/screens/ipd-admit.tsx` shows `capWarning.words` on a class card.
- (E3.1) `transfers.ts` — `startTransfer`, `acceptHandover`, `cancelTransfer`, `swapBeds`, `changeClass` (the intents) and
  `listHandovers`, `transferOptions` (the reads). `class-change.ts` — `nextNoonIst`, `applyClassChanges` (pure: splits a
  stay at its class change), `classChangesOf`. `transfer-events.ts` — `ipd.transfer.started|accepted|cancelled`,
  `ipd.bed.swapped`, `ipd.admission.class_changed`. `transfers.controller.ts` — `/ipd/transfers/*` (`IPD_TRANSFER_ROUTES`).
  `beds.ts` seams: `lockBedsInOrder`, `holdBedForTransferIn`, `endHoldIn`, `vacateBedForSwapIn`, `bedWithWard`.
  `kernel/db/schema/ipd.ts` — `ipd_transfers`, `ipd_class_changes` (migration `ipd_transfer`).
  `packages/contracts/src/ipd/transfers.ts` — `IpdHandoverList`, `IpdTransferOptions`, `IPD_IN_PLACE_CLASSES`,
  `IPD_TRANSFER_HOLD_MINUTES`; `cancel_transfer` joins the intent catalogue (`packages/contracts/src/ipd/intents-ward.ts`).
  `apps/web/src/screens/ipd-transfer-panel.tsx` (the Beds drawer's Transfer panel) and
  `apps/web/src/screens/ipd-handovers.tsx` (`/ipd/handovers`).
- (E3.2) `discharge.ts` — `declareFit`, `cancelFit`, `confirmCharges` (the department list `departmentsFor`, the role map
  `IPD_DEPARTMENT_ROLES`), the summary (`saveSummaryDraft`, `signSummary`, `readSummary`, `ensureSummaryDraft`).
  `discharge-bill.ts` — `composeFinalBill`, `prepareFinalBill`, `settleFinalBill`, `askDuesApproval`, `readFinalBill`.
  `discharge-exit.ts` — `issueGatePass`, `scanGatePass`, `recordLama`, `recordAbscond`, `recordDeath`, the mortuary register
  (`receiveBody`, `recordPoliceClearance`, `releaseBody`, `listMortuary`). `discharge-read.ts` — `readDischargeTracker`,
  `readDischargeBoard`. `discharge-events.ts`, `discharge.controller.ts` (`IPD_DISCHARGE_ROUTES`). `kernel/db/schema/ipd.ts` —
  `ipd_discharges`, `ipd_discharge_confirmations`, `ipd_discharge_summaries`, `ipd_final_bills`, `ipd_payer_claims`,
  `ipd_gate_passes`, `ipd_stay_exits`, `ipd_mortuary_register` (migration `ipd_discharge`). `approval-types.ts` gains
  `ipd_discharge_dues`. `packages/contracts/src/ipd/discharge.ts` — tracker, board, summary content, final bill, mortuary,
  routes; `packages/contracts/src/ipd/intents-discharge.ts` — `billing` department, tender `ref`, `witnessName`, death `cause`, `mortuaryEntryId`.
  `apps/web/src/screens/ipd-discharge.tsx` (`/ipd/discharge`, `?admission=`), `apps/web/src/lib/ipd-discharge-api.ts`.
  (#763) `bill-cover.ts` — `liveBills`, `coveredLineIds`, `closedThroughOf`, `lineIsBilled`, `hasUnbilledLines`.
  `discharge-bill.ts` — `prepareSupplementaryBill`, `settleSupplementaryBill`, `unbilledTake`. `bill-void.ts` — `askBillVoid`,
  `voidBill`, `ipdRefundVoucherGuard` / `registerIpdRefundVoucherGuard`. Approval `ipd_bill_void`; event `ipd.bill.voided`;
  migration `ipd_suppbill`. Web: `apps/web/src/screens/ipd-settled-bills.tsx` (on the bill desk).

- (E2.3) `deposit-ladder.ts` — `IPD_DEPOSIT_LADDER` (7,500 / 9,000 bp), `IPD_DEPOSIT_RECIPIENT_ROLES`, `IPD_CLINICAL_ROLES`,
  `depositPosition` (split + deposit held + used bp + balances), `evaluateDepositLadder(db, admissionId, now)`,
  `evaluateAllDepositLadders`, `icuBurnOf`. `daily-totals.ts` — `queueDailyTotals`, `queueAllDailyTotals`, `messageNameOf`,
  `dayOfStay`. `bill-desk.ts` — `readBillDesk`, `retryFromBillDesk`, `runIpdBillDeskNightly` (rides the nightly charges job),
  `depositLowCard` (the desk's `ipd.deposit_low` Now card, declared in `manifest.ts`). `billdesk.controller.ts` —
  `IPD_BILLDESK_ROUTES` (`GET /ipd/bill-desk`, `POST /ipd/admissions/:id/charges/retry`). `billdesk-events.ts`.
  `kernel/db/schema/ipd.ts` — `ipd_deposit_alerts` (migration `ipd_billdesk`). `packages/contracts/src/ipd/bill-desk.ts`.
  `kernel/notify/templates.ts` — template `ipd.daily_totals` (held: `heldReason`), `kernel/notify/pump.ts` suppresses a held
  template `template_pending`. Web: `apps/web/src/screens/ipd-bill-desk.tsx` (`/ipd/bill-desk`, nav "Bill desk").

- (E3.3) `family.ts` — staff side: `issueFamilyLink`, `revokeFamilyLink`, `setCondition` (word + family-off switch),
  `listFamilyCallbacks`, `closeFamilyCallback`, `readFamilyPanel`, `familyBlockOf`, the stop consumer `familyStopConsumer` /
  `handleFamilyStop`, the desk card `familyCallbacksCard`. `family-public.ts` — the attendant's side (no staff session):
  `familyGate`, `sendFamilyOtp`, `verifyFamilyOtp`, `readFamilyView`, `readFamilyBillDetails`, `requestFamilyCallback`.
  `permissions.ts` — every `ipd.*` permission string (re-exported by `manifest.ts`; breaks the manifest ↔ module cycle, #764).
  `family-throttle.ts` — `FamilyAddressThrottle`, the per-address cap on the public routes.
  `family-otp.ts` — `FamilyOtpSender` (SMS adapter with DLT id `IPD_FAMILY_OTP_DLT_TEMPLATE_ID`, else refused; non-prod log opt-in
  `IPD_FAMILY_OTP_TO_LOG`). `family-events.ts`, `family.controller.ts` (`IPD_FAMILY_ROUTES`; public routes `@Public()` POSTs with the token in
  the BODY, cookies `hmis_fdev` / `hmis_fses` on `/api/ipd/family`). `daily-totals.ts` `attendantOf` / `attendantPhoneOf` (shared recipient rule).
  `discharge-read.ts` `familyTrackerOf`. `kernel/db/schema/ipd.ts` — `ipd_admission_conditions`, `ipd_family_links`,
  `ipd_family_otps`, `ipd_family_sessions`, `ipd_family_callbacks` (migration `ipd_family`). `packages/contracts/src/ipd/family.ts`.
  Web: `apps/web/src/screens/ipd-family.tsx` (`/family#<token>`, public, sibling of `/login`), `apps/web/src/screens/ipd-family-panel.tsx` (the
  Family card on the discharge desk), `apps/web/src/screens/ipd-family-callbacks.tsx` (`/ipd/family-callbacks`, nav "Family calls").

- (E5.1 #738, E5.2 #739) `bed-flow.ts` — `readBedFlow(db, reader, at)`: BED FLOW T0, every `requested` admission (oldest
  first) with its proposal or null; remembers what it shows and withdraws what went stale. `bed-flow-log.ts` —
  `settleBedProposalIn` (called by `reserveBed` and `assignBedIn`, so admit / emergency / back-fill / assign_bed all log the
  outcome) and `withdrawBedProposalIn` (called by `cancelAdmission` and the read). `now-cards.ts` — the Now cards
  `bedProposalCard`, `dischargeBlockedCard` (`stuckStepOf`, pure), `cleaningOverdueCard`, the shared `nowIdentities`,
  `nowSubtitle`, `rankNowRows`, `SEALED_LABEL`. `bill-desk.ts` `depositLowCard(ctx)` (money). `goals/bed-flow-queries.ts` —
  `IPD_BED_FLOW_QUERIES` BF1 (accepted %) and BF2 (overridden %), per IST week. `beds.ts` `roomGendersFor` (the twin-room
  rule for many beds, one holder rule with `roomGender`). `kernel/db/schema/ipd.ts` — `ipd_bed_proposals` (migration
  `ipd_bed_flow`). Contracts: `IpdBedFlowProposal`, `IpdWaitingCard.flow` / `.uhid`, board `totals.predictedDischargesTomorrow`.
  Web: the Beds board's waiting cards (`apps/web/src/screens/ipd-beds.tsx`): proposal, reasons, Confirm.

## 3. Invariants
- A bed is a kernel `bed` row. No new resource kind, no kernel edit, no migration: the attributes are jsonb,
  validated here, and only the keys the schemas name are written. Other keys on a row are kept.
- The loader validates the WHOLE file first. One bad row refuses the file, every bad row is listed by its
  spreadsheet row number, and nothing is written.
- Idempotent upsert by code (`resources_site_kind_code_lower_ux`: site, kind, lower(code)). A second run of the
  same file writes nothing: no row, no history, no event.
- The loader never deletes, retires, moves or revives. An IPD bed (a bed row whose attributes carry `class`)
  missing from the file is reported as "not in file" and left alone. A code already used by a place under a
  different parent, or by a retired place, refuses the file: moving and un-retiring are a person's acts.
- Dry run is the default and needs no permission. Applying needs `auth.users.manage` (DECIDED until the bed
  board declares IPD's own bed-master permission): `bed-layout.ts` `BED_LAYOUT_PERMISSION`, checked inside
  `loadBedLayout` (`bed_layout_forbidden`) and by the script's `--by`.
- The parser refuses a duplicate header name and any row whose cell count differs from the header's.
- An occupied bed's class, gender rule, isolation, ICU, day-care or overflow attribute never changes by file
  (`bed_occupied` refuses the file); equipment may. E1.1 keeps holds in
  `ipd_bed_reservations`, not a kernel status: the loader does not yet refuse a rule change on a held bed (owed).
- A ward and a hall may not share a code (`ward_hall_collision`), though the registry's index would allow it.

### Beds (E1.1)
- An intent is ONE function: parse the contract's zod input → re-check the permission (`ipd_forbidden`) → run
  under the contract's idempotency key (`withIdempotency`, route `ipd:<intent>`) → lock → re-check state and rules
  → write + event. A refusal is `IpdRefusal` (contract code, `rule`, `fix`, `bedRule` such as "Female-only bed",
  `detail`); HTTP 404 for `*_not_found`, 403 for the overflow gate, 409 otherwise (`IpdRefusalBody`).
- LOCK ORDER: the admission (advisory xact lock on `ipd_admission:<id>`, reserve/assign), then the bed's parent
  (room or ward) FOR UPDATE, then the bed, then IPD rows — `releaseBedOccupant` and the incumbent marker too (its
  dry run takes no lock). An open-stay unique violation maps to `admission_wrong_state`, never a 500. The parent lock serialises a
  twin room's two beds (gender fixed by the first occupant or holder until empty) and is also what makes two desks
  racing for one bed answer "bed just taken" with `detail.nextBeds` instead of the kernel's raw `already_occupied`.
- Kernel statuses only. Reserved = kernel `available` + an active `ipd_bed_reservations` row (partial unique: one
  live hold per bed). Blocked = kernel `blocked` + an active `ipd_bed_blocks` row; on an occupied bed the block is
  `pending_release` and `releaseBedOccupant` applies it. Occupant triad: `ipd_admission` / admission id, with the
  patient and billed class on the open `ipd_bed_stays` row (partial unique per bed and per admission). Incumbent:
  occupant `incumbent`/`incumbent` + `attributes.incumbent: true` (+ optional `incumbentGender`).
- Room gender comes from `placed_as` on open stays and live holds (and `incumbentGender`); a first holder with no
  recorded gender locks the room as unknown (`room_gender_unknown`, "Room gender not recorded — set it first").
- A hold past `expiresAt` is lapsed inline by any act that meets it (`currentHold`), not only by the minute job.
- DECIDED: a hold may be placed on an available OR cleaning bed; assignment needs `available`. One live hold per
  admission (a new one ends the old as `plan_changed`); assignment consumes the admission's own hold.
- The lapse is `lapseBedReservations(db, now)`, every minute (`kernel/worker/jobs.ts`), system actor
  `ipd-reservation-lapse`, provenance `system`, idempotent; it never ends a hold whose `expiresAt` is after `now`.
- Every event payload carries `provenance` (G11b) and, with an admission, `admissionId` (G2). Moves into cleaning
  carry `clean:routine` / `clean:terminal` (G3). Payloads carry ids only: the gateway fans them to every viewer.
- Board counts: census = class `inCensus` and not overflow; overflow apart; day care/emergency outside both.
  Wall mode sends initials only (`occupant.name` null, block notes blank).
- Overflow beds need `ipd.beds.overflow` (duty manager) — `overflow_needs_duty_manager`, checked before any rule.
- DECIDED rule details: child = under 14 on the day (no DOB → not refused on age); paediatric/NICU/PICU beds refuse
  adults; adult ICU and gender-segregated general beds refuse children; isolation rank none<contact<droplet<airborne
  and airborne also needs negative pressure; ward classes general→suite swap only with a flagged upgrade/downgrade
  in that direction; ICU flag must match both ways; gender = administrative gender, `need.placeAs` for other/unknown.
- Until ipd-admit: `admissionId` is the caller's request id and the bed intents carry `patientId` + `need`; ipd-admit
  derives both from the admission. `reserve_bed` does not yet emit `ipd.admission.reserved` (no admission record).

### Admission (E1.2)
- ONE workflow instance per admission (`ipd_admission` definition, Class A): `ipd_admissions.state` mirrors it and
  every move goes through `moveAdmission` in the same transaction. The workflow checks ROLES (front_office,
  front_office_supervisor, duty_manager for desk acts; doctor for requests); the intent checks PERMISSIONS. A user with
  the permission but none of those roles is refused `ipd_forbidden` by the engine.
- One open admission per patient: checked first (refused `admission_already_open` with the first admission in
  `detail`) and enforced by the partial unique index `ipd_admissions_open_patient_ux`; a lost race maps to the same
  refusal (the insert runs in a savepoint).
- `admit`, `emergencyAdmit` and `backfillDowntime` place the patient through `assignBedIn` INSIDE their own
  transaction (bed rules re-checked under the bed lock); `admit` judges plan, ICU approval and deposit on the LOCKED
  row. LOCK ORDER: every act on an admission first takes its advisory lock (`admissionAdvisoryLock`, shared with the
  bed intents and taken by `lockAdmission`); then placing acts take room → bed → admission row, `cancelAdmission`
  takes the row → the beds of its holds, money acts take the row → billing's rows.
- Money: every rupee comes from the active tariff (`IPD_<ROOM|NURSING|VISIT>_<CLASS>`; cashless non-payables
  `IPD_NONPAY_DEPOSIT_<CLASS>`). A missing component refuses `rate_missing` with `detail.class`, `detail.missing`,
  `detail.serviceCodes` — only when the DEPOSIT needs the missing rate (a ₹0 basis stands, estimate shown as n/a).
  Deposit = 3 class days (ICU 3 ICU days), surgery 50 % of the typed estimate, PM-JAY/state scheme ₹0, emergency
  before stabilisation ₹0, downtime back-fill `downtime_backfill` (paper; `deposit_check_pending` until the bill desk
  takes or checks it — `GET /ipd/admissions/deposit-checks`). DECIDED: the surgery share rounds UP to the whole rupee
  (deposits are collected in whole rupees). A payer change re-quotes the deposit. Doctor outputs carry no money (0058).
- `takeDeposit`: the billing receipt (`recordReceiptInTx`) and the link commit in ONE transaction; the intent's
  idempotency key is a unique column on the link, so a retry finds the committed pair and never takes money twice.
- Scheme cap: Σ GRANTED non-covered approvals (each names its amount) ≥ Σ every receipt of the patient since the
  request (entered-in-error excepted), checked under the admission row lock — on the desk's deposit AND on billing's
  generic receipt route via the receipt guard (`registerIpdReceiptGuard`, registered by `IpdModule`; billing's seam
  `registerReceiptGuard`). A cancel with a deposit still on account refuses `deposit_not_refunded`.
- `admit` needs a receipt linked to the admission covering `depositRequiredPaise`, or an exemption matching the plan's
  basis (scheme, emergency, cashless at ₹0) or a granted `ipd_deposit_waiver` approval.
- ICU class (icu, nicu, picu — HDU is not ICU) needs a GRANTED `ipd_icu_admission` approval on the admission. The
  emergency lane asks first (`askEmergencyIcuApproval` mints the admission id the approval names) and admits under it. Approvers: medical_superintendent or an `intensivist` role holder.
- A scheme patient's receipt needs a granted `ipd_non_covered_line` approval on the admission, and at most its amount.
- Band QR/barcode carry the band SERIAL (`<IP no>-<n>`); one live band per admission (partial unique); a reprint voids
  the old one with its reason. Allergies print in words; "Allergy: none recorded" when none.
- Downtime back-fill keeps the paper's request and admission times on the row, the stay and the events; the paper
  serial is upper-cased and unique.

### Running bill (E2.1)
- TARIFF LOCK: every admit path (`admit`, `emergencyAdmit`, `backfillDowntime`) records the version in force at the
  admitted instant in `ipd_admissions.tariff_version_id`; every charge prices from it through the tariff engine
  (`loadPricingContext({ tariffVersionId })` + `priceInvoiceLines`), so a later revision never reaches the stay and a lower
  regulated price still wins. Null (no tariff active, or admitted before E2.1) → the version in force at `admitted_at`,
  else a `tariff_missing` exception.
- LINES ARE NOT A BILLING INVOICE. Billing's invoices are issued, numbered, immutable documents with one live invoice per
  encounter; a running bill cannot live on one. Lines go to `ipd_charge_lines` (append-only: a trigger refuses UPDATE and
  DELETE) with their price frozen at posting; the final bill (E3.2) composes ONE invoice from them, the OT
  `composeDischargeBill` pattern (DECIDED). No billing or tariff signature changed.
- DAY RULE (DECIDED, see `charge-days.ts`): IST midnight to midnight; admission day billed whatever the hour; discharge
  day free up to 14:00 IST inclusive; highest class held MORE than an hour that day, else the longest; an ended stay under
  an hour is transit and dropped; the stay's `billed_class` (protected/booked) wins over the bed's; overflow bills general;
  daycare, emergency and LDR carry no rent; general < … < suite < hdu < icu = nicu = picu; home leave keeps billing.
  Review #756: overlapping stays are clipped to the previous stay's end first; when EVERY stay is under an hour none is
  dropped (minimum one day — admit 10:00, leave 10:30 bills that day at the stay's class).
- DECIDED (review #756): a day spent on an LDR, day-care or emergency bed posts no rent, nursing or RMO — those beds
  carry packages and services, not daily rates.
- IDEMPOTENCY IS THE DATABASE: partial unique indexes — one `ipd.nightly` line per (admission, service date, component),
  one `ipd.visit` line per (admission, date, consultant), one reversal per line. Inserts are `on conflict do nothing`;
  `ipd.charge.rent_posted` goes out only with a room line that was actually inserted, so G5b sees one per night.
- MISSING RATE: no item on the locked version, ₹0, or the service absent or SWITCHED OFF → required components (room,
  nursing, visit) raise one `ipd_charge_exceptions` row per key (event once) and post nothing; `rmo` is skipped silently;
  `cross_visit` falls back to `visit`. A later run that can price it posts the line and resolves the row.
- NIGHTLY JOB: `postNightlyIpdCharges(db, now)`, `dailyIst` 00:05; admissions in a bed plus ENDED ones whose
  `charges_posted_through` is short of the discharge day or that have an open exception (no age window); posts every
  unposted day up to YESTERDAY (a missed night is caught up with its own dates). One transaction per admission; the
  admission and stays are RE-READ under its advisory lock before the days are computed; a null tariff pin is resolved
  and persisted in that transaction. A DOMAIN failure (IPD/tariff/zod error, SQLSTATE 22/23) becomes a `posting_failed`
  exception (`error_code`, `fail_count`); at 3 consecutive the job skips the admission until `retryAdmissionCharges`
  (billing manager) resolves it. Only infrastructure errors fail the run. Today is never posted.
- VISITS: `postConsultantVisit(tx, { admissionId, consultantUserId, seenAt, source: "rounds_tap" })` — a consultant is a
  user with an ACTIVE `opd_doctors` row (residents are not on it → not charged); first tap per IST day posts, repeats post
  nothing; every tap emits `ipd.charge.visit_recorded`. Not the admitting/covering consultant → `cross_visit` (else `visit`).
  Class = billed class of the bed held at `seenAt` (no-rent bed → general, DECIDED). The answer carries no money.
  A REVERSED visit does not count: the day can be charged again, the new line taking the next `visit_seq` (the visit
  unique index is (admission, day, consultant, visit_seq) — a partial index cannot see another row's reversal).
- REVERSAL: `reverseChargeLine` (`ipd.charges.reverse`, billing_manager; HTTP `POST /ipd/charge-lines/:id/reverse`,
  `charges.controller.ts`, reason required) inserts the negated twin with a reason (zero-net lines too; a lost race on
  the unique index answers `charge_line_already_reversed`); a
  reversed nightly line is NOT re-posted by the job (its key is spent) — the corrected charge is the bill desk's (E2.3).
- DEPOSIT on the interim bill (`depositHeldPaise`): Σ deposit receipts (entered-in-error excepted) − the patient's
  advance refunds issued since the request, floored at 0 (billing refunds advances per patient, not per receipt).
- MONEY OFF DOCTORS (0058): `ipd.bill.view` (front office, its supervisor, duty manager, cashier, billing manager, owner)
  gates the interim bill; charge events carry ids and dates only; acceptance (viii) pins the doctor-reachable IPD routes and
  scans their answers for money keys.

### Payer split (E2.2, #726)
- COMPUTED ON READ, never stored per line: the interim bill computes it every time from the record. Only a PRINT keeps it
  (`ipd_payer_split_snapshots`, one row per print, the whole split as jsonb); the final bill (E3.2) will keep its own.
- THE RECORD IS THE ONLY SOURCE OF MONEY TERMS: the room-rent cap (paise per day, or bp of the coverage's sum insured), the
  co-pay (bp) and the approved total are what the TPA desk typed on `record_payer_auth`; each term is the LATEST STATED
  value in the current authorisation (rows from the last `payer_change` on). Nothing is defaulted: no cap typed, no cap
  applied; a % cap with no sum insured on the coverage applies no cap and raises `room_rent_cap_unresolved`.
- MODES: cash / no payer → all patient (`cash`); `insurance_reimbursement` → all patient (`cash`: the patient claims
  later); `insurance_cashless` and `corporate` → insured; `pmjay` / `state_scheme` → scheme (every line payer, patient ₹0;
  the patient's only money is Σ granted `ipd_non_covered_line` approvals, `schemeNonCoveredPaise`; the receipt guard still
  enforces it on every route).
- INSURED, the order per line: reversed pair 0/0 → denied (`denied`, whole stay, from admission) → not yet approved
  (`auth_pending`, patient until approval) → non-payable (`non_payable`) → room-rent cap → co-pay → approved amount
  (`over_approved_amount`, consumed in POSTING ORDER — postedAt, then id; never service date — review $2: a line posted
  later never takes approval from one posted earlier, so a printed bill's earlier lines never flip on a later read). An approval covers the stay FROM ADMISSION: the split reads the
  latest state, never the approval's date, so day-1 lines turn payer-payable the moment a day-2 approval is recorded.
- ROOM-RENT CAP (IRDAI proportional deduction; review $8): a day whose live nightly room line's TAXABLE value (ex-GST)
  exceeds the cap and whose class is not critical care (`icu`, `nicu`, `picu`, `hdu` — DECIDED $) → the room line and that
  day's nursing, RMO, visit and cross-visit are paid net × cap / taxable rent — the ratio applies to taxable and each
  line's GST follows its taxable split (`room_rent_over_cap` on the room line, `room_rent_cap_proportional` on the others).
  Exactly ONE live nightly room line per (admission, date) — the day rule guarantees it; two throw (review 10). Pharmacy,
  consumables, implants and diagnostics are never proportionally deducted (when they post, they take no deduction).
- ROUNDING (DECIDED $, review 3): cap and co-pay are exact fractions (BigInt); each (service date, component) group's payer
  share is floored ONCE and handed out as each line's floor plus one paisa to the largest remainders, ties by line id.
  payer + patient = the line exactly.
- DENIAL: whole stay patient-payable and `cash_consent_missing` on the bill until a `payer_change` entry carrying a
  `counsellingDocumentId` (the signed consent) follows the denial; after it the stay stays `denied` (cash from admission).
  APPEAL (DECIDED $, review 9): an APPROVED `initial` recorded after the denial is the appeal's outcome — accepted by the
  intent, it reinstates insurance and clears `cash_consent_missing`. A payer change is not an appeal.
- SCHEME CARVE-OUT (DECIDED $, review 7): Σ granted non-covered approvals is carved out of the LATEST lines in posting
  order (payer reduced, patient increased, reason `non_covered`), never more than the lines carry — no money appears that
  is not on a line.
- CAP STATED ONE WAY (review RED 1): an entry carries an absolute cap OR a % cap, never both (zod refine on
  `record_payer_auth` + `ipd_payer_auths_one_cap_ck`); across entries the latest stated one wins.
- COVERAGE MOVES WITH THE PAYER (review 6): `record_payer_auth` takes `coverageId` (checked to be the patient's,
  `state_changed`); a `payer_change` sets `ipd_admissions.coverage_id` to it (none → null) with the payer kind; an initial
  that sets the payer sets it. A % cap resolves against the admission's CURRENT coverage.
- PRINT (review 4, 5): `printInterimBillSnapshot` (in `interim-bill.ts`) takes the admission lock and reads lines, record,
  coverage, approvals, non-payables and deposit in ONE transaction, keeps the split, and answers it; the screen prints that
  answer, and a failed keep blocks printing ("Could not record — try again").
- RECORD ORDER (DECIDED, E2.2): a REQUESTED initial may be answered by a second `initial` with the insurer's status; a
  requested entry approves nothing (`approved_total_paise` = the last approved total), and an approved enhancement adds to
  the last APPROVED total in the current authorisation — a requested enhancement never inflates it.
- NON-PAYABLES: `ipd_payer_non_payables` (service code or tariff category, case-insensitive; retired, never deleted). It
  starts EMPTY (DECIDED): no IRDAI non-medical category exists as a tariff category. The billing manager keeps it
  (`ipd.payer.terms`, `/ipd/payer/non-payables`).
- PERMISSIONS (review 11): status and pre-auth number stay with `ipd.payer.manage` (front office, its supervisor, duty
  manager, billing manager); the money terms (room-rent cap, co-pay) and the non-payables list need `ipd.payer.terms`,
  held by `billing_manager` alone (no TPA role exists in the model).
- MONEY OFF DOCTORS (0058): the split rides on the interim bill (`ipd.bill.view`); the cap warning needs `ipd.bill.view` or
  `ipd.admit`; the non-payables list `ipd.payer.terms`. No doctor role holds any of them.
### Transfer (E3.1)
- A transfer is complete ONLY at `acceptHandover` by a person other than the sender (`sender_cannot_accept`). Until
  then the patient's stay and the origin bed (kernel `occupied`, occupant = the admission) are untouched and the target
  is an ordinary `ipd_bed_reservations` hold (12 h, `IPD_TRANSFER_HOLD_MINUTES`) — every other act sees it held.
- Accept is ONE transaction: `releaseBedOccupant` on the origin (cleaning; `clean:terminal` when the admission is
  isolated), `assignBedIn(viaAdmit)` on the target (consumes the hold, re-checks every rule under lock, opens the stay
  at the bed's class), `transferring → admitted`, one `ipd.transfer.accepted { transferId, admissionId, … }` (the passes
  lane consumes it by that name). A retry with the same key answers the first result; another accept is
  `transfer_not_open`.
- The 30-minute escalation is NOT a job: the admission workflow's `transferring` SLA (30 min, ladder 100 % →
  `nursing_supervisor`); with nobody in that role the kernel's rung falls back to `duty_manager` (`resolveRung`).
  `ipd_transfers.escalates_at` copies the rung's due instant for the handover clock.
- `cancel_transfer` (DECIDED, §4.4 "cancel back") rides the workflow's single `transferring → admitted` edge (the engine
  allows one edge per pair), so its workflow roles are `accept_handover`'s; either transfer permission may cancel.
- LOCK ORDER for two beds/two admissions: advisory locks in admission-id order → `lockBedsInOrder` (all parents in id
  order, then all beds in id order) → admission rows in id order → IPD rows. A one-bed act (parent → bed) cannot cycle
  with it.
- A swap vacates both beds with kernel reason `swap` (not `clean:*`: G3 never counts it) straight back to `available`,
  then places each patient with `assignBedIn(viaAdmit)`; any refusal or failed write rolls both back (acceptance iii
  injects a trigger failure). A bed with a block waiting for release cannot take a swap.
- A transfer's need = the admission's isolation and gender + the TARGET bed's class and ICU flag, so a clinical move
  never needs a class consent; onto an ICU bed from a non-ICU bed needs a granted `ipd_icu_admission` approval.
- CLASS CHANGE IN PLACE (`changeClass`, permission `ipd.admit`): ward room classes only (`class_not_ward`), consent in
  the admission consent's shape, upgrade needs `roomRentCapAcknowledged`. It is a row in `ipd_class_changes`, never a
  future-dated stay; `charges.ts` `staysOf` folds it in (`applyClassChanges`) so the day rule decides the noon day
  (highest class held over an hour). It binds its stay: a move before noon leaves it behind. A newer change supersedes
  one not yet in effect.
- Review #759: $ DECIDED — a HOSPITAL-initiated move (bed_management, isolation, gender_fix, maintenance; a swap for
  gender_fix / isolation_fix) bills at the LOWER of the class billed before and the new bed's class (`protectBookedClass`
  on the new stay); a patient-requested or clinical move bills the new bed's class.
- Review #759: a swap refuses an isolated patient (`swap_isolation` — the bed needs a terminal clean: use a transfer) and
  applies start's ICU gate per patient (`intensivistApprovalIdA/B`); `askApproval` takes `icu` for an admitted ward
  patient (step-up). Accept refuses a lapsed hold (`transfer_hold_lapsed`); wherever a transfer's hold lapses
  (`endReservation` with `lapsed`: the minute job or an act meeting it) the transfer is cancelled `hold_lapsed`, the
  admission returns to `admitted` and `ipd.transfer.cancelled` goes out. Asking for the class already in effect revokes a
  pending class change. The panel's targets re-derive each candidate's twin-room gender (`bedRoomGender`).
- Permissions (DECIDED): `ipd.transfer.start` and `ipd.transfer.accept` are held by `duty_manager` alone until the
  ipd-nursing lane seeds `ward_nurse` / `nursing_supervisor` (the workflow already names those roles); the duty manager
  is also an `accept_handover` actor in the contract.

### Discharge (E3.2, #730)
- THE GATE PASS IS THE SINGLE GATE (E0.2): `issue_gate_pass` refuses `charges_unconfirmed` (detail.pending names the
  departments, billing last), `summary_unsigned`, `bill_unsettled`, `receiving_hospital_missing`; it moves `fit_declared →
  discharging`. The scan (`ipd.gate.scan`: front office, duty manager — no security role yet) ends the stay: `discharged`, or
  `transferred_out` for a refer-out, both announced as `ipd.admission.discharged` (the state in the payload). The bed goes
  to cleaning through `releaseBedOccupant` (`clean:terminal` when isolated).
- DEPARTMENTS (DECIDED): ward always (`lines` / `always`), lab / radiology / pharmacy when a kernel order placed since
  admission is still open (`orders.kind` lab / imaging), billing always and LAST (`charges_unconfirmed` while any other is
  pending). A department is the actor's by ROLE (`IPD_DEPARTMENT_ROLES`, `actorHoldsAnyRole`) — `department_not_yours`.
  The rows belong to ONE declaration; cancel_fit voids them with it, a new fit lists afresh.
- SUMMARY: one per admission, `version` bumps on every save, sign names the version (`draft_changed`). The treating
  consultant (admission consultant or covering) signs; anyone else's sign is a resident's → `awaiting_cosign`. Signed is
  immutable (`summary_already_signed`). `draft_model_id` / `draft_prompt_version` null until M5; label "Draft" until
  signed. LAMA and death open a draft (`ensureSummaryDraft`) — the summary is still given.
- FINAL BILL ($ DECIDED): non-reversed lines only (a reversed line AND its reversal drop out); `billVersion` = the count
  of the admission's lines (append-only ⇒ any posting or reversal changes it → `bill_changed`). `prepareFinalBill` posts
  through the settle day with `presumedDischargeAt` (the day rule's 14:00 grace applies); it posts nothing once a final
  bill exists. ONE billing invoice for the PATIENT portion, each line at its frozen price (`prepaidUnitPaise`; a split line
  goes on at the patient's share of taxable, qty 1); deposits (the admission's deposit receipts, oldest first) via
  `settleFromReceipts`; tenders as the invoice's receipt (cash / UPI / card; UPI and card need `ref`); excess deposit →
  `requestRefund(advance_refund)` (held instead under `insurer_pending_undertaking`); the payer portion → `ipd_payer_claims`
  (billing has no payer-credit model). All in ONE transaction under the admission lock. Rounding once, by billing.
- DUES (⚖ DECIDED — Consumer Protection Act, state clinical-establishment rules, NHRC charter): never a detention, never
  a wait. An unpaid balance is recorded at once (`dues_recorded`) against the signed undertaking document; the invoice is
  raised `holdUntilPaid` (open on billing's dues list, `credit_extended` false — billing's owner-only credit ruling is not
  touched). The gate pass says `duesRecorded`. The approval follows the exit (review #762 below).
- OTHER ENDINGS: LAMA / DAMA (`ipd.discharge.exit`; admitted or fit_declared), abscond (`ipd.discharge.exit`; also from
  discharging; MLC needs `policeIntimationRef`), death (`ipd.discharge.declare`; also mid-transfer). Each (`endStay`):
  cancels an open transfer and its hold, releases the bed (death and abscond terminal clean), voids a live gate pass,
  closes the declaration, moves to the terminal state with `ended_at`, emits the passes lane's event once. The bill
  settles after (allowed in lama / absconded / deceased; no department cascade) — nothing reads the bill to refuse.
- REVIEW #762 (all DECIDED; $ money, ⚖ law):
  - $ RED 1/4: the SETTLE posts the running bill itself (`postAdmissionCharges` with `presumedDischargeAt` = the settle
    instant) under the admission lock, then composes; the bill is final at settlement. A gate scan after 14:00 the same
    day adds nothing (the hospital's delay).
  - $ RED 2: the nightly job skips an admission with a final bill. A settled patient still in by the next IST day is the
    bill desk's `settled_not_exited` (computed on read). Superseded by #763 below (posting resumes after the settle day).
  - $ RED 3: `cancel_fit` refuses `final_bill_exists` ("Ask billing to void the bill", #763). ⚖ LAMA / abscond / death
    still end the stay after a final bill (bill desk `ended_after_bill`); without one, an ending stamped before the
    posted charges' cover (per live line: min(the IST midnight ending its date, its posting instant)) refuses
    `time_before_charges`.
  - $ RED 5: ONE source of truth, `priceFinalBill`: patient = the invoice as billing prices it (`rawTotalPaise`, before its
    one rounding); claim = total − patient; payer + patient = total to the paisa (a negative claim refuses `bill_changed`);
    the view and the settle both call it. A settled bill's view reads the row, never a re-pricing.
  - $ RED 6: deposits applied are capped by `depositHeldPaise` (receipts less issued advance refunds); the refund is the rest.
  - ⚖ RED 7: the exit never waits on an approval — `dues_recorded` records the dues at once against the signed undertaking;
    `recordDuesApproval` attaches the granted `ipd_discharge_dues` approval later; the bill desk (`listBillDesk`,
    `GET /ipd/discharge/bill-desk`) lists `dues_awaiting_approval` until then.
  - ⚖ RED 8: the undertaking is an existing ACTIVE `patient_documents` row of THIS patient (`undertaking_invalid`). No
    `undertaking` document kind exists yet, so any kind is accepted (seam: add the kind in patients' `DOCUMENT_KINDS`).
  - 9: the dues flag and the settlement kind ride no event; `duesRecorded` is null for a viewer without money.
  - 10: `refundState` is `refund_pending` until billing issues the voucher against the refund approval.
  - 11: the settle names `patientPayablePaise` it read (the payer split's inputs are not in the line count); a different
    recomputed amount refuses `bill_changed`.
  - 12: the web keeps one idempotency key per settle attempt (same form = same key on a retry).
  - 13: `confirm_charges` has no system bypass (no system caller exists; a department is a role).
  - 14: a payer portion with no payer refuses `payer_kind_missing` (`assertPayerAccounted`; unreachable today — the split
    reads the payer from the admission — kept so a claim is never silently dropped).
  - 15: requester ≠ approver: the approvals kernel refuses it (`assertNotSodPair`); `recordDuesApproval` re-checks.
- SUPPLEMENTARY BILL AND VOID (#763 + review of a0d85914, all DECIDED $ / ⚖, standard Indian corporate hospital practice):
  - COVER (`bill-cover.ts`): an admission has a final bill (seq 0) and supplementary bills (seq 1, 2…); one LIVE bill per
    (admission, seq) (`ipd_final_bills_live_ux`). Each bill records the lines it composed (`line_ids`, reversed pairs
    included); the next bill composes the rest. Only a pre-0214 row (`cover_by_time`, set by the migration) falls back
    to "lines posted by its settlement"; no new bill does.
  - $ POSTING: every chargeable day is posted under the day rule (`charge-days.ts`), deduplicated per (day, component) —
    so the SETTLEMENT DAY is charged once the stay runs past 14:00 on it, and lands in the supplementary bill. Only the
    NIGHTLY job skips a live bill's settlement day and before (locked review #762 RED 2: the first midnight after
    settlement posts nothing); the exit acts (gate pass, supplementary prepare/settle) post it with the real presumed
    exit. Settled before 14:00, stayed the night, left before 14:00 next day → the settlement day is billed (full day),
    the exit day is not.
  - `prepareSupplementaryBill` / `settleSupplementaryBill` (routes `…/bill/supplementary/prepare|settle`, `ipd.discharge.bill`,
    body = `settle_final_bill`'s) = the final settle on the uncovered lines (`settleLocked`): same state guard family
    (`fit_declared`, `discharging`, ended states), payer split over the WHOLE stay, its own claim row (one claim per bill),
    deposit, tenders, refund, ⚖ dues. Deposit available = held − Σ live bills' applied − their refunds not yet issued.
    Refuses `bill_unsettled` (no live final), `nothing_to_bill`, `admission_wrong_state`.
  - ⚖ GATE PASS — never stricter than the final bill: with a live final bill it posts up to now; while lines wait it
    refuses `supplementary_unsettled` UNLESS the act carries `undertakingDocumentId` — then the waiting charges are
    settled right there as a supplementary bill with dues recorded (`recordSupplementaryDuesIn`; deposit first, no
    payment, no approval; any gate-pass holder, e.g. the duty manager at night). `duesRecorded` = any live bill has dues.
  - DUES APPROVAL: one approval attaches to ONE bill, never the requester's own (`usableDuesApproval`, settle and
    `recordDuesApproval`).
  - VOID (`bill-void.ts`): `askBillVoid` (`ipd.discharge.bill`, reason) files `ipd_bill_void` (subject = the bill; billing
    manager or owner). `voidBill` refuses, BEFORE any write: `bill_not_found`, `bill_already_voided`,
    `void_newer_bill_first`, `void_needs_approval` (`detail.reason` `not_granted` | `self_approved`), ⚖ `gate_pass_live`
    (an issued pass not yet scanned — allowed after the scan), `payer_claim_settled`, `refund_issued`. Then one tx under
    the admission lock: billing's `cancelRefundRequestOnTx` (marker `refund_cancellations`, read by `issueRefundVoucher`
    under the approval lock — fails closed in every process; a pending request is also rejected when the voider may
    decide it, only SoD / role_denied tolerated); a `correction` credit note; `releaseInvoiceSurplusOnTx` for
    `invoiceAllocatedPaise`; counter money on the bill ADOPTED as the stay's deposit (row + `ipd.deposit.taken` event each);
    claim → `withdrawn`; event `ipd.bill.voided` (ids + `adoptedReceiptIds`). Reopens the running bill: `cancel_fit`
    proceeds, the next settle composes ONE new bill (also after the exit: `discharged`, `transferred_out`).
  - `ipd.bill.settled` carries `kind` and `seq`. A reversal of a line a live bill took refuses `charge_line_billed`.
  - Web: the bill desk (`/ipd/bill-desk`) "Settled bills" (`apps/web/src/screens/ipd-settled-bills.tsx`, `GET
    /ipd/discharge/bill-desk` — exceptions plus the last `IPD_SETTLED_BILL_RECENT_DAYS` days): Supplementary bill (on
    `supplementary_owed`, `settled_not_exited`, `ended_after_bill`) and Ask to void / Void bill on the newest bill.
- MORTUARY: a death opens the register row (`expected`); `receiveBody` needs a second person (two-person identity check);
  `releaseBody` needs police clearance for an MLC and NEVER reads the bill (⚖ a body is never held for money).
- MONEY OFF DOCTORS (0058): declare_fit / cancel_fit / sign_summary / record_death answers carry no money keys (acceptance
  vii; the fit event's id is `declarationId`, never `dischargeId` — "charge" is a money word to the scanner). The tracker's
  `bill` is filled only for `ipd.bill.view` / `ipd.discharge.bill` holders.

### Deposit ladder, daily totals, bill desk (E2.3, #727)
- USED = the payer split's patient-payable total ÷ the deposit held (`depositHeldPaise`: receipts − advance refunds). A
  payable bill with NOTHING held counts as over 100 % (stored 1,000,000 bp) and fires both levels (DECIDED $) — but only
  where a deposit is OWED (`depositOwed`, review 4): scheme ₹0, a waiver or any exemption, or no deposit required (an
  emergency before stabilisation) → the ladder does not run. A cash downtime back-fill owes one (the paper deposit).
- ONCE WHILE ARMED: one live `ipd_deposit_alerts` row per (admission, level) — a partial unique index. HYSTERESIS (review
  6): a level re-arms (`rearmed_at`) only when usage falls below 70 % (top-up) / 85 % (escalation); the next crossing fires
  a NEW row and new notices. The notices are raised IN THE ALERT ROW'S TRANSACTION (`raiseNoticeIn`, review 5), keyed
  `ipd.deposit_alert:<row id>` per person — both commit or neither.
- WHEN: after the nightly posting (`runIpdBillDeskNightly`, inside the `postNightlyIpdCharges` job — no job of its own;
  the ladder and the daily totals each in their own try, each admission in its own, failures logged — review 1), and after
  every committed act that moves the numbers: a deposit, a bill-desk Retry, a charge reversal, an advance refund (billing's
  `registerAdvanceRefundListener`, registered by `IpdModule`). Those run `evaluateDepositLadderSafely`: a ladder failure is
  logged and the act still succeeds (review 8). Only admissions in a bed.
- WHO (DECIDED $, decision 0058 review 3): 75 % → cashier, front-office supervisor, billing manager; 90 % → the same
  plus duty manager and owner (never the MS). A holder of any clinical role (`IPD_CLINICAL_ROLES`, MS included) is dropped
  even if they also hold a desk role; `test/ipd-clinical-roles.test.ts` derives the clinical roles from `seed:roles`' titles.
- CARE NEVER STOPS FOR MONEY: only `deposit-ladder.ts` and `bill-desk.ts` read `ipd_deposit_alerts`; acceptance (v) pins the
  file list and that a round and the next night still post over 90 %.
- ICU BURN: open stay billed ICU/HDU/NICU/PICU → average patient-payable of the last three POSTED service days; days left =
  (held − payable) ÷ per day, floored. Recomputed by construction when the nightly run posts. ≤ 1 day left is a desk exception.
- DAILY TOTALS: once per admission per IST day (dedupe `ipd.daily_totals:<admission>:<date>`), the bill through yesterday:
  DEDUPE (review 9): one `ipd_daily_totals` row per (admission, IST date), unique, decided under the admission's advisory
  lock. First name (alias when confidential), day of stay, bill total (rounded), deposit held, balance ("amount due" when
  negative). NO line, diagnosis, ward, bed or doctor. Attendant (DECIDED): active guardian with a phone and bill authority,
  else the latest deposit payer recorded as a relative with a phone; travels as a reference (`attendant`, `attendantRef`),
  never a number. None → `ipd.daily_totals.skipped` `no_attendant_phone`; sealed (`sensitive_context`) → `sealed`, no row.
  HELD: no approved WhatsApp template, no DLT id, and the pump addresses a patient row to the patient's phone — the pump
  records every row `suppressed` / `template_pending`. G10 therefore measures nothing until the template is released.
  DECIDED (review 10): keep held — RELEASE NEEDS AN ATTENDANT-RECIPIENT SEAM in kernel/notify (issue #761).
- BILL DESK: candidates from the facts (live ladder rows, open charge exceptions, unchecked downtime deposits, denial
  entries, the latest authorisation `requested` > 24 h, ICU-class stays, `fit_declared`/`discharging`); only those are
  computed. "Expected discharge today" = `fit_declared` or `discharging` with the patient owing (DECIDED, no date field yet).
  `ipd.billdesk.view` (cashier, billing manager, front-office supervisor, duty manager, owner); Retry needs
  `ipd.charges.reverse`. Deposit reasons are the LIVE ladder rows only (a re-armed level leaves the desk, review 7). A sealed
  patient (`sensitive_context`) shows by alias or "Sealed patient" — no name, UHID or bed (review 2).

### Family link (E3.3, #731)
- ⚖ ONLY THE REGISTERED ATTENDANT: the recipient is `attendantOf` (the daily totals' rule); the desk cannot type a number. The
  link stores the attendant REFERENCE + an HMAC-SHA256 of the phone under `SECRET_KEY` (`familyPhoneDigest`, kernel/crypto
  `hmacSign`, #764) at issue; `sendFamilyOtp` re-resolves the reference at send time
  and refuses `family_phone_changed` if it no longer hashes the same. No input chooses the number.
- TOKENS: link token (32 bytes), OTP (6 digits, 10 min, hash bound to challenge id), device cookie and session cookie (12 h,
  never past discharge + 24 h) — all stored as SHA-256 only. The OTP challenge is bound to the device that asked; the session to
  the device that verified. Limits: 3 sends / h / link, 5 wrong codes / h / link, 5 callbacks / 24 h / link, and 120 public
  requests / 10 min / address (in memory, per process — no global limiter exists in the API).
- REVIEW #764 ORDERING: `verifyFamilyOtp` runs in ONE transaction under the admission lock — count the attempt first
  (`attempts + 1 … returning`), sum the hour, refuse over the limit BEFORE comparing the code; a right code gives its attempt
  back and stamps `verified_at where verified_at is null` (one code, one session). `sendFamilyOtp` commits the challenge first and
  sends with no transaction or lock held; a failed send is marked `failed_at` (it neither counts nor verifies).
- TOKEN NEVER IN A PATH (#764): the edge's access log (Caddyfile `access_log`) keeps paths unredacted by design and the API writes
  no request log, so the page is `/family#<token>` (a fragment never leaves the browser) and every public call is a POST with the
  token in the body. Cookies are `Secure` always in production. `IPD_FAMILY_OTP_TO_LOG` in production refuses to boot.
- ⚖ OFF FOR: `patients.sensitive_context` (sealed), `ipd_admissions.mlc` (every MLC — no "restricted" field), and the treating
  team's switch (`ipd_admission_conditions.family_off_reason`: psychiatric, HIV, MTP, POCSO, patient request). Confidential
  patients keep the link with the ALIAS and no ward. Turning off revokes a live link.
- REVOKE ON THE PATH THAT SETS A BLOCK (#764): the team's switch revokes in `setCondition`; sealing a patient revokes through the
  `ipd.family_stop` consumer on `patient.updated` (`sensitiveContext` → true). MLC has no later path (set only at admission, when
  the issue already refuses), so for MLC the read-time refusal below is the guard.
- OPEN CHECK ON EVERY PUBLIC READ (`openLink`): link active, no block, admission in a bed — or discharged / referred out / LAMA
  within 24 h (then marked `expired` on first open after). Death and absconding close the page at once (state check) and the
  worker consumer `ipd.family_stop` records the revocation (cursor seeded by `seedCursors`).
- ⚖ DPDP: purpose `inpatient_updates` stated on the page and stored; consent (who, relation, verbal/paper) stored at issue. The
  view carries no line items; `readFamilyBillDetails` is a second explicit step and appends `ipd.family.bill_details_viewed`.
- CALLBACKS are rows for the ward desk (`ipd.family.issue`); nothing answers them; events carry no question text. The desk list
  follows the patient row as it is now (#764): sealed → no name, bed or ward ("Sealed patient"); confidential → alias rule, no bed
  or ward. Closing is the conditional UPDATE `… returning` under the admission lock: one close, one event.

### Now cards and Bed Flow T0 (E5.1 #738, E5.2 #739)
- ONE PROVIDER, ONE PERMISSION PER CARD TYPE (`manifest.ts` `desk`, provider key = card key): `ipd.bed_proposal` →
  `ipd.beds.manage`, `ipd.discharge_blocked` → `ipd.discharge.view`, `ipd.deposit_low` → `ipd.billdesk.view` (MONEY; no
  doctor or nurse role holds it, decision 0058), `ipd.cleaning_overdue` → `ipd.beds.clean`. DECIDED: existing permissions,
  no new strings (no seed-roles count change). The family callbacks card (E3.3) is a fifth provider.
- A card exists only while something is wrong; an empty card is never sent. Rows rank by severity, then the longest wait,
  then id (`rankNowRows`). Patient rows carry name (alias when restricted), UHID and bed through ONE rule, `nowIdentities`
  (also the Beds board's waiting cards); sealed → alias or "Sealed patient", no UHID and NO bed text anywhere on the row
  (review #767). EXCEPTION, DECIDED (review #767): the money card `deposit_low` shows the admission number, never a name —
  the desk is read over a shoulder. Row words are English, server-side; card titles are i18n keys.
- DECIDED thresholds: bed proposal hot at ≥ 30 min waiting (the spec budget); a discharge step is stuck after 60 min "now"
  (hot past the 3-hour target); cleaning overdue after 60 min (`IPD_CLEANING_OVERDUE_MINUTES`), hot after 120.
- `cleaning_overdue` and Bed Flow's "free since" read each bed's LATEST `resource_status_history` row by one indexed probe
  per bed (`latestStatusAt`, lateral on `resource_status_history_resource_seq_idx (resource_id, seq)`), never a history scan.
- BED FLOW asks `checkBedRules` — the same function as every bed act — with the twin room's gender (`roomGendersFor`) and
  `mayUseOverflow: false`. Never proposed: overflow, cleaning, held, blocked beds. HELD and BLOCKED come from the acts' own
  predicate (`beds.ts` `holdIsLive`, `LIVE_BLOCK_STATUSES`, `bedHoldsAndBlocks`): a hold past `expiresAt` is NOT held (the act
  lapses it inline), so its bed is proposed (review #767). Tie-break: requested class, a ward of the
  admitting department (`ipd_admissions.department` vs ward `department`), the bed free longest (last status move), code.
  Oldest request first; a bed goes to one request; an open still-valid proposal is kept (it does not jump).
- CONFIRM = `reserve_bed` (DECIDED, departing from "assign_bed" in the brief): a waiting request is `requested`, and
  `assign_bed` refuses a real admission that is not `admitted` (`linkPlacement`); placement happens at `admit`. Bed Flow never
  acts by itself.
- ONE READ, BATCHED (review #767): one query per fact, places loaded only for the candidates' parents, withdrawals one update
  per reason, new proposals one insert. Callers compute it ONCE per request (the board off the wall; the card).
- REASONS are static codes (`IPD_BED_FLOW_REASONS`, worded by the web, en + hi); `freeMinutes` is computed at read time.
- The proposal log `ipd_bed_proposals`: one open row per admission AND one per bed (two partial uniques; a lost insert
  shows no proposal this read, never an error); outcome `accepted` / `overridden`
  (the act's bed vs the proposal's) / `withdrawn` with `bed_taken`, `bed_blocked`, `bed_not_valid`,
  `bed_given_to_earlier_request`, `admission_cancelled`, `admission_left_waiting`. The READ writes (records and withdraws) —
  deliberate: there is no job, and the outcome is written by the acts in their own transaction. BF1/BF2 count each
  admission's FINAL decided proposal once (a re-proposal after a released hold replaces the earlier outcome); placement onto
  the proposed bed by `reserve_bed` or `admit` is `accepted`, onto any other bed `overridden`.
- The web words a refused Confirm by its refusal CODE (`ipdBeds.flow.refused.<code>`), never the server's English.
- Tomorrow's predicted discharges = live `ipd_discharges` with `fit_when = 'tomorrow'` declared since IST midnight (marks only).
- OWED TO M4 (no source data in this stack; no stub, no fake rows): `due_dose` (eMAR), `overdue_vitals` (nursing
  observations), `new_order` (ipd-orders), `ews_rising` (EWS scores), `handover_pending` (nurse shift handover; transfer
  handovers already have `/ipd/handovers`), `assessment_due` (nursing assessments). Each is a new provider + permission.

## 4. Traps
- `docker/prod/deploy.sh` runs every seed on every deploy. The loader is a script a person runs; never wire it
  into a seed.
- PLANNING LAYOUT from the confirmed bed split; the hospital's real room list replaces it. The workbook is
  1,150 beds (720 wards, 240 critical care, 50 NICU/SNCU, 20 LDR, 60 day care, 60 emergency); the rest of the
  1,200 is dialysis stations and theatres, which are not beds. Edit the generator, regenerate, commit both:
  `test/ipd-bed-layout-planning.test.ts` compares the file to the generator byte for byte.
- `scripts/data/` must hold only `.ts` files except files a script takes as an argument
  (`test/scripts-data-compiles.test.ts` `TAKEN_BY_ARGUMENT`); the planning CSV is listed there.
- Codes are unique per kind across the whole site, not per ward: a bed code must carry its ward
  (`F05-ORT-M-B12`), or two wards' "B12" collide. OT recovery bays are kernel `bed` rows too; their codes are
  not IPD's, and a clash refuses the file rather than adopting the bay.
- The loader writes ~1,600 rows through `createResource` (history row and event each). The planning workbook
  takes ~10 s on the build host; the acceptance tests give it 300 s.

- (E1.1) The kernel has no HTTP retire route; `retireBed` is the only retire that knows reservations. A script or
  module calling `retireResource` on a bed directly bypasses the "retired while reserved" refusal.
- (E1.1) `nextRuleValidBeds` does not re-derive each candidate's room gender (a proposal, not an act): the act
  re-checks under lock.
- (E1.1) A new scheduler job owes five censuses: `kernel/worker/jobs.test.ts`, `kernel/worker/scheduler.test.ts`, `test/alerts-parity.test.ts`,
  `test/worker-runtime.e2e.test.ts` and `docker/prod/prometheus/alerts.yml`.
- (E1.1) The bed-layout loader still applies with `auth.users.manage` (`BED_LAYOUT_PERMISSION`); moving it to
  `ipd.beds.manage` is owed.

- (E1.2) GO-LIVE STEPS, not seeds: the `ipd_admission` workflow definition must be drafted, approved (owner + MS) and
  activated, and `registerIpdApprovalTypes(db, activator)` run. Until then every request answers
  `admission_workflow_inactive` (503) and an approval request `approval_type_missing`.
- (E1.2) The bed intents still accept a request id with NO admission row (the approved E1.1 acceptance tests use
  one); with a real admission they check the caller's patient and need against the row (`state_changed`). So
  `ipd_bed_reservations.admission_id` / `ipd_bed_stays.admission_id` still have no FK to `ipd_admissions`.
- (E1.2) The thermal relay has no `ipd_wristband` print document (a kernel print-outbox edit, owed): the band
  prints from the desk's browser at band size; a named `printerId` is only checked to be alive.

- (E2.1) GO-LIVE: the rate card lane creates the IPD services INACTIVE (so `validateTariffConfig` stays green); the
  charges treat an inactive service as a missing rate. At cutover the priced IPD services must be switched on (a
  person's act in the tariff screen; no script yet — owed), or every day lands as an exception.
- (E2.1) SEAMS LEFT OPEN: pharmacy issue/return posting (§4.3) is not here — it will post its own source into
  `ipd_charge_lines` (add a source value and its idempotency index); ward consumables by scan likewise. Payer split and
  the room-rent cap are E2.2; deposit ladder and bill desk E2.3; the final bill E3.2 (`postAdmissionCharges` up to the
  discharge day, then compose the invoice).
- (E2.1) The transfer and discharge lanes do not exist yet: the acceptance tests write class moves and the discharge
  directly into `ipd_bed_stays` / `ipd_admissions` (`test/helpers/ipd.ts` `mkChargesWorld`).

- (E2.2) The split's words are English, built server-side (like refusal words); the web's labels are translated.
- (E2.2) The cap warning prices the target class on the admission's LOCKED tariff version once admitted (the active
  price book before): a transfer lane quoting a class change must call `roomRentCapWarning`, not re-price itself.
- (E2.2) Scheme non-covered money is per approval, not per line: no charge line is marked non-covered (approvals carry
  an amount). A line-level mark is owed if the scheme desk needs it.
- (E3.1) SEAMS LEFT OPEN: `not_receiving_ward` is not enforced (no nurse-to-ward assignment yet — ipd-nursing); the porter
  task is the transport lane's `requestPatientMove` (comment in `startTransfer`); the room-rent cap warning TEXT on an
  upgrade is the payer lane's (E2.2) — the intent only checks the acknowledgement; death mid-transfer
  (`transferring → deceased`, ipd-discharge) must cancel the open `ipd_transfers` row and its hold.
- (E3.1) The kernel workflow stamps state entry with the real clock, so the escalation rung is at real-now + 30 min
  even when an act is called with an explicit `now` (tests read the rung's `due_at` and drive `runDueTimers` around it).

- (E3.2) SEAMS LEFT OPEN: the department "silence over 30 minutes escalates" is not a job (the tracker shows the clock; the
  workflow's 3-hour SLA tells the duty manager); `medicines_not_returned` (pharmacy returns) and
  `medicine_not_on_active_order` wait for the eMAR / ipd-orders lanes; the mortuary handover and MCCD are register rows, not
  tasks (`taskIds` is empty); claim filing, the family tracker link (E3.3) and the AI drafter (M5) are later lanes.
- (E3.2) Superseded by review #762, then #763: cancel_fit refuses while a LIVE bill exists (void it first); the nightly job
  posts again after the settlement day (supplementary bill).
- (#763) Migration `ipd_suppbill` replaced `ipd_final_bills_admission_ux` / `ipd_payer_claims_admission_ux` (one per
  admission) with one live bill per (admission, seq) and one claim per bill. Anything that read "the" final bill by
  admission alone must use `finalBillRow` / `liveBills` (a voided row stays).
- (#763) The approvals kernel has no "cancelled" state: a granted refund approval stays granted after a void (the office
  worklist may still list it); billing's `refund_cancellations` marker refuses its voucher.
- (#763) Migration 0214 was regenerated in place (unmerged): a lane test DB that applied the old 0214 must be dropped.
- (#763) Go-live: `registerIpdApprovalTypes` now also registers `ipd_bill_void` (run it again — idempotent).
- (E3.2) Re-pricing on the invoice uses TODAY's active tariff version with the frozen unit as `prepaidUnitPaise`: a service
  removed from the active version since posting refuses `tariff_item_missing`; a GST rate change re-taxes the line. Member
  benefits (flag-gated) could discount a self-pay line on the invoice — the invoice is billing's truth.
- (E3.2) Blocker and "waiting for" words are English, server-side (like refusal words); the web translates its own labels.
- (E3.2) Print isolation: other screens hide `body *` with `!important` in print (all CSS is global), so the discharge
  prints answer with `!important` and a named page (`@page ipdd-a4`).

- (E2.3) `.ipdb` is ALSO the Beds board's root class (`ipd-beds.css`: `height: 100vh; overflow: hidden`), and vite loads
  every screen's CSS globally: the bill desk overrides it with `.ipdb.ipdbd`. The interim bill (`apps/web/src/screens/ipd-bill.tsx`) still
  inherits the collision (owed).
- (E2.3) Releasing the daily totals (issue #761): approve the WhatsApp template / DLT id, give the pump a recipient seam that
  resolves `attendantRef` at send time, then remove `heldReason` from `ipd.daily_totals`. Until then nothing is sent.
- (E2.3) Migration 0209 was regenerated in place (unmerged) to add `ipd_daily_totals`: a lane test DB that applied the old
  0209 dies `relation already exists` — drop `hmis_lane_<lane>_test_1/_2`.

- (E3.3) HELD: the OTP SMS needs a DLT template id (`IPD_FAMILY_OTP_DLT_TEMPLATE_ID`); without it every send answers
  `family_otp_unavailable` (503). The link itself is handed over at the desk (QR / copy) — no SMS/WhatsApp of the link yet.
- (E3.3) `ipdManifest` now has a subscription, so the WORKER installs it (`kernel/modules/manifests.test.ts`, `kernel/worker/seed-cursors.test.ts`,
  `apps/core/test/worker-runtime.e2e.test.ts` censuses moved). The stop consumer constant lives in `family-events.ts` to avoid a
  manifest ↔ family import cycle.
- (E3.3) No ward-nurse role is seeded: callbacks go to front office / supervisor / duty manager; `ipd.condition.set` is the
  doctor's until ipd-nursing seeds nursing roles.

- (E5.2) `.ipdb` at ≤ 760 px is now one PAGE-scrolling column (`ipd-beds.css`); the bill desk shares `.ipdb` and inherits it.
- (E5.2) `readBedFlow` writes on read; the Beds board (not the wall) and the `ipd.bed_proposal` card both call it. Lane test
  DBs that applied an older 0213 must be dropped if the migration is regenerated.

## 5. Callers
- `scripts/load-bed-layout.ts` (operator).
- `beds.controller.ts` (the web board), `kernel/worker/jobs.ts` (`lapseBedReservations`),
  `scripts/mark-incumbent-beds.ts` (cutover). ipd-admit, ipd-transfer, ipd-discharge and housekeeping call
  `assignBed`/`reserveBed`, `releaseBedOccupant` and `markBedCleanIn`.
- (E1.2) `admit`/`emergencyAdmit`/`backfillDowntime` call `assignBedIn` and `endAdmissionHolds`; the Beds board reads
  open requests for its waiting column (`beds-board.ts`); ipd-charges (E2.1) reads `ipd_admissions` (payer, deposit)
  and `ipd_admission_deposits`; eMAR resolves band serials against `ipd_bands`.
- (E2.1) `kernel/worker/jobs.ts` (`postNightlyIpdCharges`, daily 00:05 IST); the rounds lane calls `postConsultantVisit`;
  the final bill (E3.2) calls `postAdmissionCharges`; `admissions.controller.ts` serves `readInterimBill`.
- (E2.2) `readInterimBill` calls `computePayerSplit`; `quotesFor` calls `capWarningsFor`; the transfer/class-change lane
  calls `roomRentCapWarning` before an upgrade consent; the final bill (E3.2) will call `computePayerSplit` and keep it.
- (E3.1) `transfers.controller.ts` (the Beds drawer's Transfer panel, the `/ipd/handovers` list); the passes lane consumes
  `ipd.transfer.accepted`; `charges.ts` reads `ipd_class_changes` through `classChangesOf`.
- (E3.2) `discharge.controller.ts` (the Discharge desk); the passes lane consumes `ipd.admission.discharged|lama|absconded|
  deceased`; the goal queries read `ipd.discharge.fit_declared` and `ipd.gate_pass.scanned` (G4); `prepareFinalBill` calls
  `postAdmissionCharges` (with `presumedDischargeAt`); `endStay` calls `endHoldIn` / `releaseBedOccupant`; billing's
  `issueInvoice`, `previewInvoice`, `requestRefund`, `receiptUnallocatedPaise` are called inside the settle transaction.
- (E2.3) `kernel/worker/jobs.ts` (`postNightlyIpdCharges` job → `runIpdBillDeskNightly`); `takeDeposit` → `evaluateDepositLadder`;
  `kernel/desk` collects the `ipd.deposit_low` provider (key renamed from `ipd.billdesk` in E5.1) from `ipdManifest.desk`; the notify pump renders `ipd.daily_totals`.
- (E5.1/E5.2) `kernel/desk` collects the five IPD providers from `ipdManifest.desk`; `readBedBoard` calls `readBedFlow`;
  `reserveBed` / `assignBedIn` call `settleBedProposalIn`; `cancelAdmission` calls `withdrawBedProposalIn`.
