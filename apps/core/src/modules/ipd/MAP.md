---
type: module-notes
title: "ipd — module notes"
description: "Why and traps of the inpatient module: validated bed and ward attributes and the bed-layout loader (E0.3), the bed intents and the Beds board (E1.1), admission — request, plan and deposit from the tariff, admit onto a bed in one transaction, the payer record, the band, the emergency lane and the downtime back-fill (E1.2) — and the running bill: tariff lock, day rule, nightly posting, visit seam, reversals, interim bill (E2.1) — and the payer split: payer- or patient-payable per line, room-rent cap with proportional deduction, co-pay, approved amount, denial to cash, scheme ₹0 (E2.2) — and transfers: start with an SBAR handover, accept by the receiving nurse, cancel, the atomic swap and the class change in place at the next noon (E3.1) — and the deposit ladder, the daily totals to the attendant and the exceptions-only bill desk (E2.3) — and discharge: fit, departments confirm, structured summary, final bill with payer claim and dues, gate pass, LAMA / abscond / death, mortuary register (E3.2) — and nursing: the admission assessment, vitals scored by NEWS2 / MEOWS / PEWS with one alert per breach, intake/output, notes, the shift handover, the nurse station and the phone (E4.1) — and rounds: the doctor's list, S/O/A/P round sign with resident co-sign, fit from the round, inpatient orders (drugs; lab and imaging through the ordering door) and the order event contract for the eMAR, cross-consults, the 08:00 cover and 14:00 nudge clock (E4.2) — and lab / imaging orders on the running bill through billing's episode charge sink, reversed when cancelled before the work (#785) — and the eMAR: pharmacist verify, ward issue with patient labels, the dose schedule, the bedside acts with both scans, the second nurse's PIN, PRN limits, infusions, the narcotic register, verbal orders, the allergy re-check and the missed-dose sweep (E4.3) — and the TPA desk: pre-auth clock, payer queries, documents, scheme packages and their importer, the claim tracker with its reconciliation (#604)."
resource: apps/core/src/modules/ipd
tags: [ipd, tpa, insurance, beds, resources, admission, billing, transfer, discharge, now-cards, bed-flow, nursing, ews, rounds, orders, order-billing, emar, copilot, drafts]
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

- (E4.1 #733) `nursing.ts` — the acts: `recordNursingAssessment`, `recordVitals` (§0B intents), `recordIntakeOutput`,
  `addNursingNote`, `giveShiftHandover`, `acceptShiftHandover`, `acknowledgeEwsAlert`; the minute job `sweepIpdNursing`;
  `scoreContextOf` (which chart), `dutyDoctorsFor`, `shiftOf`, `isNightIst`, `ioDayStart`, `istDayIndex`, `istClock`,
  `latestScores`, `lastSetAt`, `outOfRange`. `nursing-read.ts` — `readNurseStation` (board C), `readMyShift` (board D1),
  `readNursingChart`, `readHandoverDraft` (SBAR from records, each line with its source), `listShiftHandovers`, `nextDueOf`.
  `nursing-cards.ts` — the four Now cards. `nursing-events.ts`, `nursing.controller.ts` (`IPD_NURSING_ROUTES`).
  `packages/contracts/src/ipd/ews.ts` — THE SCORE TABLES (NEWS2 RCP 2017, MEOWS CEMACH/Singh 2012, PEWS Brighton +
  APLS normals), `ewsKindFor`, `scoreEws`, `ewsNotifies`, `ewsNextDueMinutes`; `packages/contracts/src/ipd/nursing.ts` —
  read models, act inputs, limits, routes, topic `ipd_nursing:board`. `kernel/db/schema/ipd.ts` — `ipd_nursing_assessments`,
  `ipd_vitals`, `ipd_nursing_alerts`, `ipd_intake_output`, `ipd_nursing_notes`, `ipd_shift_handovers` (migration
  `ipd_nursing`). Web: `apps/web/src/screens/ipd-ward.tsx` (`/ipd/ward`, board C), `apps/web/src/screens/ipd-my-shift.tsx`
  (`/ipd/my-shift`, board D1), the shift handover section of `apps/web/src/screens/ipd-handovers.tsx`,
  `apps/web/src/lib/ipd-nursing-api.ts` (with the offline vitals queue).

- (E4.2 #734) `rounds.ts` — `signRound` (S/O/A/P, bedside or remote; fit from the round via `declareFitIn`), `cosignRound`,
  `requestConsult`, `closeConsult`, `assertInBed`. `orders.ts` — `placeIpOrder` (drug; lab / imaging via `ordering`
  `orderTests`), `stopIpOrder`, `cancelIpOrder`, and the eMAR's seams `readIpdOrder`, `activeIpdOrdersOf`,
  `markIpdOrderIssuedIn`, `drugFactsOf`. `rounds-team.ts` — consultant = active `opd_doctors` row (the charges seam's rule),
  `treatingTeamOf` / `onTeam` / `mayCosign`, `unitHeadFor`, `coveringConsultantFor` (roster). `rounds-read.ts` —
  `readRoundsList`, `readRoundPatient`, `roundsConsultantChoices`. `rounds-clock.ts` — `sweepIpdRoundsClock` (08:00
  `applyCovers`, 14:00 / 16:00 `nudgeUnrounded`), riding `sweepStaffNotices` in `kernel/worker/jobs.ts`. `encounter.ts` —
  `registerIpdEncounterResolver` (prefix `IP`). `rounds-events.ts`, `rounds.controller.ts` (`IPD_ROUNDS_ROUTES`).
  `discharge.ts` `declareFitIn` (the fit on the caller's transaction). `kernel/db/schema/ipd-rounds.ts` — `ipd_rounds`,
  `ipd_orders`, `ipd_consults` (migration `ipd_rounds`). Contracts: `packages/contracts/src/ipd/rounds.ts` (read models,
  `IpdOrderPlacedPayloadSchema` / `…Stopped…` / `…Cancelled…`, `IPD_ORDER_EVENT_NAMES`), `packages/contracts/src/ipd/intents-rounds.ts`
  (`cosign_round`, `request_consult`, `close_consult`), `packages/contracts/src/ipd/intents-meds.ts` (`place_ip_order` drug / tests, `stop_ip_order`,
  `cancel_ip_order`), `packages/contracts/src/ipd/intents-ward.ts` (`sign_round` with `soap`, `source`, `fit`). Web: `apps/web/src/screens/ipd-rounds.tsx`
  (`/ipd/rounds`, `/ipd/rounds/$admissionId`, nav "Rounds"), `apps/web/src/lib/ipd-rounds-api.ts`.

- (#785) `order-charges.ts` — THE ORDER CHARGE SINK: `ipdOrderStanding` (live / ended / not an admission), `postIpdOrderCharges`,
  `reverseIpdOrderCharge`, `registerIpdOrderChargeSink` (billing `registerEpisodeChargeSink`, prefix `IP`; `IpdModule` registers it).
  `charges.ts` — `priceService`, `postOrderLineIn` (one `ipd.order` line per order item) and the Retry leg
  `retryOrderExceptionsIn` inside `postAdmissionCharges`. `modules/billing/episode-charges.ts` — the seam (`episodeChargeSinkFor`,
  `episodeChargeStanding`). Callers: `modules/lab/desk.ts` `placeLabOrder`, the reflex in `modules/lab/verify.ts`,
  `modules/lab/money.ts` `refundOnCancel`; `modules/radiology/place.ts` `placeImagingOrder` / `assertEncounterOpen`,
  `modules/radiology/schedule.ts` `cancelStudy`. `kernel/db/schema/ipd.ts` —
  `ipd_charge_lines.order_id` / `order_item_id`, components `lab` / `imaging`, source `ipd.order` (migration `ipd_orderbill`).
  Contracts `IPD_CHARGE_COMPONENTS` / `IpdChargeComponent` (the rate card's `IpdRateComponent` is unchanged).

- (E4.3 #735) `emar.ts` — the acts: `verifyOrder` (+ `verifyFindingsOf`), `issueMed`, `returnMed`, `resolveAllergyFlag`,
  `secondCheck`, `administerDose`, `holdDose`, `refuseDose`, `missDose`, `reofferHeldDoses`, `markDoseInError`,
  `recordInfusionEvent`, `recordNarcoticWastage`, `signVerbalOrder`, the consumer `emarAllergyConsumer` /
  `recheckOrdersForAllergy`, the minute sweep `sweepIpdEmar`. `emar-doses.ts` — `scheduleDosesIn`, `cancelFutureDosesIn` (called
  by `stopIpOrder` / `cancelIpOrder` in their own transaction). `emar-rules.ts` — PURE: `dueTimesFor`, `giveTiming`, `prnState`,
  `isHighAlert`, `isTimeCritical`, `windowMinutesFor`, `doseWordsOf`. `emar-drug.ts` — `emarDrugsOf` (pharmacy shelf item flags,
  formulary composition, NDPS class). `emar-read.ts` — `readPharmacyQueue`, `readEmarPatient`, `readWardChart`, `readEmarDue`,
  `scanAtBedside`, `readLabelSheet`, `readOverrideCounts`. `emar-cards.ts` — `dueDoseCard`, `newOrderCard`. `emar-events.ts`,
  `emar.controller.ts` (`IPD_EMAR_ROUTES`). Verbal orders: `orders.ts` `placeIpOrder` with `verbal` (+ `refuseVerbalHighAlert`).
  `kernel/db/schema/ipd-emar.ts` — `ipd_emar_verifications`, `_issues`, `_labels`, `_returns`, `_doses`, `_acts`,
  `_infusion_events`, `_narcotic_register`, `_verbal_orders`, `_second_checks`, `_allergy_flags` (migration `ipd_emar`).
  `packages/contracts/src/ipd/emar.ts` (read models, constants, routes); `packages/contracts/src/ipd/intents-meds.ts` (verify / issue / give / hold / refuse /
  infusion, and `miss_dose`, `reoffer_held_doses`, `mark_dose_in_error`, `second_check`, `sign_verbal_order`,
  `record_narcotic_wastage`, `return_med`, `resolve_allergy_flag`). Seams outside: pharmacy `shelfByMedicine` /
  `shelfItemForMedicine` / `recordIncident`, formulary `interactionRulesPresent`, materials `fefoPick` / `postMovements`.
  Web: `apps/web/src/screens/ipd-emar-bedside.tsx` (board D2 inside `/ipd/my-shift`), `apps/web/src/screens/ipd-pharmacy.tsx` (`/ipd/pharmacy`, the
  desk and `LabelPrint`), `apps/web/src/screens/ipd-mar.tsx` (`/ipd/mar`), `apps/web/src/lib/ipd-emar-api.ts`.
- (E5.3 #740, E5.4 #741) THE COPILOT DRAFTERS. `copilot-lines.ts` — pure: the `Fact` union, `renderLine` (the one place a fact
  becomes words), `chooseLines`, `quantitiesIn`, `boundPhrases`, `verifyReworded`, `verifyFreeText`, `applyRewordings`.
  `copilot-facts.ts` — `buildFacts` (one admission, one window), `factsHash`. `copilot-model.ts` — `askIpdModel` (the ONE door
  to a model), `ipdModelFrom`, `maskForModel`. `copilot.ts` — `readSinceYesterday`, `polishSinceYesterday`, `readHandoverDraft`,
  `buildSbarDraft`, `buildDischargeDraft`, `medicinesNamedWithoutOrder`. `copilot-drafts.ts` — reads of `ipd_copilot_drafts`.
  `discharge-medicines.ts` — `medicineFlagsOf`, `sameMedicineName`. `copilot.controller.ts` (`IPD_COPILOT_ROUTES`).
  `kernel/db/schema/ipd-copilot.ts` — `ipd_copilot_drafts`; `draft_id` on `ipd_shift_handovers` and `ipd_discharge_summaries`
  (migration `ipd_copilot`). `packages/contracts/src/ipd/copilot.ts`. Web: `apps/web/src/screens/ipd-since.tsx` (first block
  of `/ipd/rounds/$admissionId`), the SBAR stamp in `apps/web/src/screens/ipd-my-shift.tsx`, the draft and flags in
  `apps/web/src/screens/ipd-discharge.tsx`, `apps/web/src/lib/ipd-copilot-api.ts`.

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
  `cross_visit` never falls back to `visit` (review of 72f10b68: a missing cross rate is a `rate_missing` exception). A later run that can price it posts the line and resolves the row.
- NIGHTLY JOB: `postNightlyIpdCharges(db, now)`, `dailyIst` 00:05; admissions in a bed plus ENDED ones whose
  `charges_posted_through` is short of the discharge day or that have an open exception (no age window); posts every
  unposted day up to YESTERDAY (a missed night is caught up with its own dates). One transaction per admission; the
  admission and stays are RE-READ under its advisory lock before the days are computed; a null tariff pin is resolved
  and persisted in that transaction. A DOMAIN failure (IPD/tariff/zod error, SQLSTATE 22/23) becomes a `posting_failed`
  exception (`error_code`, `fail_count`); at 3 consecutive the job skips the admission until `retryAdmissionCharges`
  (billing manager) resolves it. Only infrastructure errors fail the run. Today is never posted.
- VISITS: `postConsultantVisit(tx, { admissionId, consultantUserId, seenAt, source: "rounds_tap" })` — a consultant is a
  user with an ACTIVE `opd_doctors` row (residents are not on it → not charged); first tap per IST day posts, repeats post
  nothing; every tap emits `ipd.charge.visit_recorded`. Not the admitting/covering consultant and not a consultant of the
  admitting consultant's roster unit → `cross_visit` (else `visit`) — review of 72f10b68, $ owner to confirm. A consultant is
  the CONSULTANT CADRE (`rounds-team.ts` `isConsultant`), not a doctor-master row alone.
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

- ORDERS (#785, DECIDED): a lab or imaging order on a LIVE admission — from rounds or any door naming the admission number
  (ordering door, lab desk, lab reflex, radiology) — posts one `ipd.order` line per order item (component `lab` / `imaging`,
  no bed class, `order_id` + `order_item_id` + `service_id`), priced on the admission's LOCKED version (the tariff in force for
  the stay), in the department's own transaction; the department raises NO invoice (lab `lab_items.invoice_id` null, desk
  answer `invoice: null`). Unique per order item (`ipd_charge_lines_order_ux`). A missing rate (no item, ₹0, switched off, a
  tariff refusal) is a `rate_missing` exception keyed `<admission>:<date>:<component>:<order item>`; Retry / the nightly run
  re-price it (`retryOrderExceptionsIn`), a cancelled item closes it. ENDED admission: rounds refuses (`assertInBed`), the
  other doors `encounter_closed`; a reflex of an earlier sample still posts (supplementary bill).
  CANCEL: before the work (lab: no tube COLLECTED; imaging: not on the machine — the department decides `workStarted`) → a
  reversal line; after → nothing (billing reverses with `ipd.charges.reverse`); a line a settled bill took is left (void
  first). Radiology raises no `acquired_unbilled` for an `ipd_admission` study. Diagnostics take no proportional deduction.
  REVIEW OF 47cd79f5 (DECIDED unless marked):
  - LOCK ORDER: every door takes the admission's advisory lock FIRST (`episodeChargeStanding(…, { lock: true })` → sink
    `lock`), then reads the standing under it, before its own rows; posting and reversal re-read under the lock.
  - PRICE: an EXPLICIT ₹0 item posts a ₹0 line; an absent item or a switched-off service is `rate_missing`.
  - $ OWNER TO CONFIRM — IMAGING FEE SWITCH: decision 0067 rules "a study ordered while imaging is free is authorised free"
    with no OPD limit, so an inpatient scan ordered while the imaging fee is off posts a ₹0 line (the OPD path's answer).
    The lab switch prices lab lines at the counter only (`withFeeSwitches`); inpatient lab lines are not changed by it.
  - CANCEL: a line a settled bill took is never reversed behind it — `order_cancelled_after_bill` goes to the bill desk
    (key ends `:<order item>:cancel_billed`); a LAB test cancelled after its sample was COLLECTED raises
    `order_cancelled_after_work` (radiology raises its own `performed_then_cancelled`). Billing answers with
    `ipd.charges.reverse` (after a void, #763) or `keepOrderCharge` (`POST /ipd/charge-lines/:id/keep`); either closes it.
    The department hears the outcome (`refundOnCancel` `runningBill`, `cancelStudy` `runningBill`).
  - AFTER THE BILL / AFTER DISCHARGE: an order the department accepted is always posted; with a live bill it is the
    supplementary bill's (`postIpdOrderCharges` → `supplementary: true`). A scan whose order item is on the running bill
    (`covers`) is authorised `ipd_admission` and raises no `acquired_unbilled` whether or not the stay is still live; its
    report-ready message is never held for payment. A scan with NO line raises `acquired_unbilled` as before.
  - FAIL CLOSED: billing's `issueInvoice` refuses any `IP26-000123` episode (`ipd_running_bill`), and a door in a process
    with no sink registered refuses the order `running_bill_unavailable` (billing writes the grammar out; it imports no
    module). The lab desk refuses a tender on a live admission (`ipd_running_bill`); its preview answers `runningBill: true`
    and the web hides the tender.
  - The deposit ladder re-checks right after a posting (`evaluateDepositLadderSafely`, a savepoint; a failure is logged).

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
- Permissions (DECIDED): `ipd.transfer.start` and `ipd.transfer.accept` are held by `duty_manager`, `ward_nurse` and
  `nursing_supervisor` (E4.1 seeded the nursing roles); the duty manager is also an `accept_handover` actor in the contract.

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
  immutable (`summary_already_signed`). `draft_model_id` / `draft_prompt_version` are stamped by the server from a copilot draft (E5.4, below); label "Draft" until
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
- E4.3 (#735) filled `due_dose` (`ipd.emar.give`) and `new_order` (`ipd.emar.view`); E4.1 (#733) filled `overdue_vitals`,
  `ews_rising`, `handover_pending` and `assessment_due`.

### Nursing (E4.1, #733)
- WHICH SCORE (`ewsKindFor`): under 16 → PEWS; pregnant / ≤ 42 days postpartum (the assessment's `obstetric`) → MEOWS; a
  woman under department `OBG` or on an `ldr` bed → MEOWS unless the assessment answered `none`; else NEWS2 (unknown age →
  NEWS2). The tables are the published charts written out with their citations; `packages/contracts/src/ipd/ews.test.ts` probes every band edge.
- ONE ALERT PER BREACH (`ipd_nursing_alerts`, partial unique "one open ews alert per admission"; review of b0334887): the
  first set at the notify band (`ewsNotifies`: low–medium and up — NEWS2 5+ or a single 3) opens it and tells the duty
  doctor. While it stands EVERY in-breach set writes its band into `band` (it may go DOWN); a set whose band is ABOVE the
  band last seen re-raises THE SAME alert id (G7 reads it as the same breach) and tells them again (notice key
  `ipd.ews:<alertId>:<vitalsId>:<band>`) — so high → medium → high and medium → low–medium → medium each re-notify. A set
  below the band clears it; the next breach is a new row. Only the LATEST set by time taken moves the alert (§4.10 edge 25).
- STAMP ONLY WHEN SOMEBODY WAS TOLD: `notified_at` (and `doctor_reached`), the assessment alert's `notified_at` and
  `supervisor_told_at` are written only when a notice actually went out; the minute sweep retries every unstamped one.
- THE DUTY DOCTOR (DECIDED): the admission's consultant + the `ward_jr` a PUBLISHED roster has on for the department now
  (`whoIsOn` source `published` only), ACTIVE users only. With no doctor to tell, the NURSING FALLBACK CHAIN is told at
  once (`nursingFallback`: active nursing supervisors, else the nursing superintendent, else the duty manager; empty → the
  sweep retries) and the record_vitals answer says `doctorReached: false` ("No doctor reached — call" on the phone and
  station). `high` also tells the chain.
- ACKNOWLEDGEMENT (DECIDED, rapid-response practice): only a DOCTOR's (doctor / resident role, `EWS_ACK_KINDS`) is
  `acknowledged_*` and stops the 10-minute step to the chain; a nurse's or supervisor's is `seen_*`. The note is kept
  (`ack_note`, the event's `note`), so `ipd.ews.acknowledged` is NOT on the realtime fan-out.
- G7's instrument events are `ipd.ews.breached` / `ipd.ews.acknowledged` (`goals/goal-events.ts`); they are NOT any intent's
  event (the goal acceptance test pins that). `byKind` comes from the acknowledger's roles (`actorKindOf`). A replay of a
  set answers what the first act raised, read back from its breach event (`raisedBy`).
- SEALED patients: notices say "Sealed patient" and nothing else (no bed, no IP number, `whereWords`); the station card
  nulls bed code, consultant, IP number and day of stay.
- APPEND-ONLY: `ipd_vitals`, `ipd_intake_output`, `ipd_nursing_notes`, `ipd_nursing_assessments` refuse UPDATE and DELETE
  by trigger (`ipd_nursing_forbid_mutation`, migration `ipd_nursing`). A reassessment, when built, is a new row.
- SWEEP ISOLATION: each row runs in its own transaction inside try/catch; a failing row is logged and counted (`failed`).
- ASSESSMENT DUE: one hour after admission (`IPD_ASSESSMENT_DUE_MINUTES`); the minute sweep raises ONE `assessment_overdue`
  alert per admission ever (partial unique), told to the nursing supervisors; admissions older than 3 days are left to
  the Now card (a cutover backlog never floods the bell). One assessment per admission (`assessment_already_recorded`).
- VITALS are append-only; the typo guard (`IPD_VITALS_LIMITS`, systolic above diastolic) refuses `value_needs_confirm`
  until `confirmedOutOfRange`; a refused set is a row with `refused` and no score; a device reading is refused
  `device_not_registered` (no monitor registry — spec §5 Phase 2). TIME BOUNDS: future beyond the 2-minute skew refused;
  older than 24 h refused `observation_too_old`; past the 30-minute queue accepted with `late_reason = 'offline'`; typed
  15+ min after taken `typed_late` (dual-stamped either way).
- OFFLINE (§0B): only vitals queue on the phone (`apps/web/src/lib/ipd-nursing-api.ts`), ≤ 30 min, stamped with the time taken. The
  phone drops a set only on a FINAL 4xx refusal (keeps it on 5xx / 408 / 429 / network), names every dropped set (time,
  patient) with "record on paper", re-reads storage before each write, and ages sets by the SERVER's clock (`asOf`). The
  server records a replay ONCE by the client's idempotency key twice over: the idempotency ledger (same person) and
  `ipd_vitals.client_key` unique (any path; a racing loser answers the winner's row).
- NEXT DUE (DECIDED from RCP chart 3): no assessment → the assessment; else last set + 12 h (NEWS2 0) / 4 h (1–4) /
  1 h (single 3, 5–6) / 15 min (7+); no set yet → admission + 1 h. A doctor-set frequency is owed to ipd-orders.
- SHIFTS 08–14 / 14–20 / 20–08 IST; night mode 22:00–06:00 IST from the SERVER's clock (`night` on the read); the I/O day
  starts 08:00 IST. A shift handover is per patient: given by one nurse, accepted by another (`shift_handover_own`); a
  newer one supersedes one not accepted. Transfers keep their own SBAR on `ipd_transfers` (`/ipd/handovers` shows both).
- NOW CARDS, one permission each, the permission of the act that answers it: `ipd.overdue_vitals` → `ipd.vitals.record`,
  `ipd.assessment_due` → `ipd.assessment.record`, `ipd.ews_rising` → `ipd.ews.respond`, `ipd.handover_pending` →
  `ipd.handover.shift`. Hospital-wide top five (no nurse-to-ward assignment yet; the station and the phone filter by ward).
- ROLES (DECIDED): `ward_nurse`, `nursing_supervisor`, `nursing_superintendent` (seed-roles; nobody assigned). NONE holds
  `ipd.condition.set`. The supervisor and the superintendent hold `ipd.family.issue` (the family's callbacks go to the nurse
  in charge); all three are on `IPD_CLINICAL_ROLES` (never a money notice). Ward nurse and supervisor now also start and
  accept transfers and confirm the ward at discharge.

### Rounds and inpatient orders (E4.2, #734)
- ONE TEST FOR "CONSULTANT": an active `opd_doctors` row. It decides both whether a round is a draft (`awaiting_cosign`)
  and whether `postConsultantVisit` charges — the two can never disagree. Residents and interns are not on it.
- ONE CHARGEABLE VISIT PER CONSULTANT PER PATIENT PER IST DAY is the charges seam's rule (its unique index); the round never
  re-implements it. A REMOTE review posts nothing (`visit_outcome = remote`); a resident's draft posts nothing (`draft`);
  co-signing is not a visit. `ipd_rounds.visit_outcome` is never read by a doctor surface (decision 0058).
- TREATING TEAM (DECIDED): admitting consultant, `covering_for`, the admitting consultant's roster unit on the day (its
  residents and interns too), and consultants with an OPEN consult. Co-sign: a consultant who is admitting, covering or a
  unit member. Fit from the round: `declareFitIn` — the treating consultant only (`isTreatingConsultant`); a resident is
  refused `consultant_cosign_required`, any other consultant `not_treating_consultant`. Round and fit commit together.
- BOARDED (DECIDED): the admission names a department and the ward's `department` attribute differs. An admission with no
  department is never marked boarded.
- ORDERS: a drug names a formulary medicine (`medicinesByIds`); an AWaRe-classified medicine is an antibiotic whatever the
  prescriber's flag, and needs `stopAt` (intent refusal AND table check `ipd_orders_antibiotic_stop_ck`). A drug carries
  `durationDays` or `stopAt`. Placed `verification = pending` — verify, allergy / interaction / dose checks, issue and doses
  are the eMAR's (E4.3). Lab / imaging go through `orderTests` with the admission number as the episode; the department's
  refusal becomes `test_not_orderable` (detail `reason`, `words`); once placed a lab / imaging order is the department's to
  cancel (`order_kind_not_here` on stop / cancel). A drug order is cancelled only before `issued_at` (the eMAR stamps it with
  `markIpdOrderIssuedIn`; table check `ipd_orders_cancel_before_issue_ck`); stop after issue sets `return_owed`.
- THE ORDER EVENT CONTRACT (eMAR builds on it): payload schemas in contracts `rounds.ts`; ids, codes and the drug schedule
  only — no names, no note or reason text, no money.
- REVIEW OF 72f10b68 (all DECIDED unless marked):
  - CADRE: consultant = active `opd_doctors` row AND the roster cadre — live team memberships' `grade` professor / associate /
    assistant professor; with no live membership the role key decides (`resident`, `intern`, `radiology_resident` = not).
    `rounds-team.ts` `isConsultant` is the ONE test for draft / co-sign / fit AND `charges.ts` `postConsultantVisit`.
  - $ OWNER TO CONFIRM: any consultant of the admitting consultant's roster unit bills `visit`; only another unit's bills
    `cross_visit`; a missing cross rate is a `rate_missing` exception (no fallback to `visit`).
  - $ BACKDATED: a round is chargeable only on the current IST day, or yesterday before 10:00 (a night round written up);
    older ones are recorded (`visit_outcome = backdated`) and raise a `visit_backdated` bill-desk exception (key
    `…:backdated`); billing charges or waives it (`resolveBackdatedVisit`, `ipd.charges.reverse`, `POST
    /ipd/charge-exceptions/backdated-visit`). The bill desk shows "Charge visit" / "Waive" with a
    required reason (`apps/web/src/screens/ipd-bill-desk.tsx`; the reason is kept in `ipd_charge_exceptions.resolution_note`).
  - INPATIENT REPORTS ARE NEVER HELD FOR PAYMENT: lab `EXEMPT_ENCOUNTER_PREFIXES` gains `IP` (whole-prefix equality) and
    radiology `patientCopyHold` exempts the admission-number grammar; billing those orders onto the running bill is #785.
  - The round page refuses anyone off the treating team (`not_treating_team`). SEALED: allergies and isolation stay; name,
    UHID, bed, ward, admission number, diagnosis and admission time are masked (page and list).
  - DRUG ORDER CHECKS: frequency ∈ `RX_FREQUENCIES`, dose unit ∈ `DOSE_UNITS` (`packages/contracts/src/rx-line.ts`); `SOS` ⇔ `prn`; stop after
    now; antibiotic course ≤ 14 days unless `longCourseReason`; dose ceiling by unit family; mass / IU units must match the
    strength label; route vs `route_class` (topical ↔ topical); weight (typed, else the OPD chart's latest within 30 days)
    for a per-kg dose and every child under 16 (`weight_required`); CPOE allergy check with the OPD prescription's matcher
    (`matchAllergiesSaltAware`), refused `allergy_conflict` unless `allergyOverrideReason` (kept on the row, `allergyOverride`
    on the event for the pharmacist). Round orders carry `roundId`.
  - LAB / IMAGING: one transaction under the admission lock; the act's idempotency key is a unique column on the row; the lab
    order is placed in that transaction (`orderTests` `{ tx }`, a savepoint); imaging gets radiology's own key
    (`ipd:<key>`). A retry answers the row and asks no department.
  - `markIpdOrderIssuedIn` answers `issued` / `already_issued` / `not_active` / `not_found` and stamps only an active order.
  - `IP` resolver answers only `IPD_ADMISSION_NO_RE` (`IP26-000123`); `insurance_reimbursement` → `self`.
  - The co-sign queue keeps drafts on stays ended within 7 days (discharge never waits on a co-sign); a draft waiting 24 h
    nudges the treating consultant once (`ipd_round_draft_waiting`). Nudges skip declared roster holidays. `closeConsult`:
    the consulted or the treating consultant only. `cosign_round` is not copilot-proposable.
- CLOCK: rides `sweepStaffNotices` (no job, no pool client). 08:00–11:59 IST: `applyCovers` sets / clears `covering_for` from
  roster absences (unit head, officiating first) and tells the covering consultant once (`ipd-cover:<consultant>:<date>`).
  Mon–Sat 14:00–19:59: one nudge per responsible consultant per day; from 16:00 one per (unit head, consultant) per day. A
  consultant BEDSIDE signed round today is what counts; patients admitted today are not expected. Notices carry counts and
  staff names only.

### eMAR (E4.3, #735)
- VERIFY: the server runs the checks (allergy — the OPD salt-aware matcher; interaction — formulary pairs, "no interaction data"
  when none is adopted; dose — weight for a per-kg dose or a child; duplicate — same moiety, or same `THERAPEUTIC_DUPLICATE_CLASSES`
  class). `verified` needs the four ticks; any non-info finding, or a prescriber's allergy override, needs the pharmacist's note;
  reject / query need a note and tell the prescriber. Verify writes the slots (IST round times OD 09 · BD 09/21 · TDS 08/14/20 ·
  QID 00/06/12/18 · HS 21 · STAT one · SOS none) from verify − window to +36 h; the sweep tops up.
- WINDOW (DECIDED): ±60 min; time-critical ±30 (every antibiotic order, insulin, anti-epileptics, Parkinson's — by moiety/class
  words, the formulary has no flag). Before the window: refused. After it: the sweep marks MISSED with ONE notice per dose
  (`ipd.emar.missed:<doseId>`, duty doctors + nursing fallback); a missed dose may still be given late with `lateReason` until two
  more half-windows pass. A re-offered held dose opens a new window at the return.
- GIVE: wristband = the live `ipd_bands.serial` of THIS admission, or an override with reason + note (counted per nurse and ward,
  `readOverrideCounts`); label = an `ipd_emar_labels.code` of THIS order (a label is never overridden — DECIDED). High-alert (item
  `high_alert`, NDPS narcotic, or the ISMP core names — insulin, heparins, KCl, opioids, common cytotoxics) needs a second-check proof:
  a row in `ipd_emar_second_checks` made by `secondCheck` (another user, holding a nursing role, own username + PIN, throttled like
  the pharmacy witness), bound to the asking nurse, single use, 5 minutes. LASA: `lasaConfirmed`. A give stamped more than 2 min
  before the server's clock is `give_expired` (doses never queue offline). An open allergy flag refuses (`allergy_conflict`).
- ONE OUTCOME PER SLOT: every act locks the admission (advisory) → the order → the slot FOR UPDATE and re-reads its status;
  `(dose_id, slot_seq)` unique is the backstop (two nurses at once: one records, the other `dose_already_recorded`).
- APPEND-ONLY by trigger (`ipd_emar_forbid_mutation`): verifications, issues, labels, returns, acts, infusion events, narcotic
  register. A correction is a NEW act naming the old (`entered_in_error` reopens the slot; `medication_incident` keeps it given and
  files pharmacy's incident register, stage `administration`). One correction per act (unique).
- ISSUE: stock leaves the `PHARM-OPD` store through `postMovements` (`consume`, refType `ipd_emar_issue`, FEFO unless a batch is
  named); labels = ceil(units / stripSize); `markIpdOrderIssuedIn`. Own medicine: no stock, `own_batch_no` + expiry required,
  never charged (0 credited on return). RETURN: stock back to the batches it left (newest first), units credited; a return on a
  stopped order clears `return_owed`. NO MONEY: no running-bill line exists for ward issue yet (owed, below).
- STOP / CANCEL: `cancelFutureDosesIn` cancels every open slot (each its own `cancelled` act) and closes the order's allergy flags,
  in the stop's transaction.
- VERBAL (§4.6): the nurse records via `place_ip_order` + `verbal` (needs `ipd.emar.give`; the named doctor is the prescriber and
  must be on the treating team); never for a high-alert or cytotoxic drug (`verbal_order_not_allowed`); a nurse without `verbal`
  is `verbal_order_only`. Signed by the named doctor or a treating-team member (`sign_verbal_order`); the sweep nudges once 4 h
  before the 24-h deadline and once after it.
- ALLERGY LATER: consumer `ipd.emar_allergy_recheck` on `allergy.recorded` → one flag per (order, allergy), notices to the duty
  doctors and every active `pharmacy` role holder once; closed by the pharmacist (`resolve_allergy_flag`) or by the order's stop.
- NPO (`emar.ts` `npoAt`): read on `diet_npo` with diet's own predicate (diet imports ipd at load; importing diet's index is a
  load-time cycle) — a lifted or ended NPO is not NPO (pinned by `emar-review.acceptance`). DECIDED ("NPO except medications"):
  an oral / sublingual / NG give under NPO needs `npoMeds` — the nurse's "doctor allows meds with sips" with a reason (recorded
  on the act, counted in `readOverrideCounts`); an OT case's NPO (`source = ot_booking`) takes only a doctor's read-back OK
  (`doctor_ok`, a doctor-role holder).
- REVIEW OF d500eb13 (#735), all DECIDED: LABEL LEDGER `ipd_emar_label_uses` — each give consumes the dose in the label's
  base units (`emar-rules.ts` `unitsPerDose`: count doses, mass ÷ strength, a concentration counts a single-dose container;
  a multi-dose container — syrup, insulin pen — is not counted), refused `label_exhausted`; a returned issue's or a superseded
  (lost / damaged re-issue) issue's label is `label_void`; entered-in-error releases the units. SECOND-CHECK PROOFS are bound to
  purpose, order, drug and (scheduled dose) slot. PRN interval and 24-h cap span every PRN order of the admission sharing the
  moiety; a second PRN of one moiety is a `stop` finding at verify. A named batch must be the shelf item's, in PHARM-OPD
  (`batch_mismatch`). NARCOTIC REGISTER: one base unit on every row; entered-in-error appends `reversal`. INFUSION start / rate
  change need the wristband (or override) and the bag's label; a running or paused infusion stops even after the order stops;
  infusion events take the 2-minute stale rule. PIN THROTTLE: an advisory lock on the username around read → verify → count, all
  on the lock's connection. VERIFY: never one's own order (`verify_own_order`); no interaction data needs the note; an allergy
  finding needs `allergyOverride` (reason enum + text). RE-ISSUE: a second issue needs `reissue` (lost / damaged / extra_supply,
  ≤ 3 in 24 h). A bedside weight > 10 % off the order's sends the order back (`query`, the prescriber told) and refuses
  `weight_changed_reverify`. Hold / refuse / miss never before the window. Entered-in-error on a stopped order's slot cancels
  it; a PRN slot reopens. ALLERGY FLAG: the doctor decides (`decide_allergy_flag` stop / continue + reason; a stop of the order
  records "stop"), then the pharmacist closes (`allergy_flag_undecided` before); the prescriber is told too; `workerBackfills`
  re-checks active orders once (`backfillEmarAllergyFlags`). The incident is filed inside the correction's transaction. Late
  window = one more window (`w × (1 + CATCH_UP)`). ISMP names `ISMP_HIGH_ALERT_NAMES`. Verbal emergencies are an enum and the
  named doctor must hold a doctor role. TRIGGERS (all ENABLE ALWAYS, no bypass switch): append-only tables refuse UPDATE,
  DELETE and TRUNCATE; the verbal signature and the second-check spend are write-once (`ipd_emar_verbal_guard`,
  `ipd_emar_second_check_guard`). `test/helpers/db.ts` `truncateAll` turns the TRUNCATE triggers off for its one statement.
  More than five wristband overrides by one nurse in 24 h tell the ward in-charge once a day.

### Copilot: since yesterday, SBAR draft, discharge drafter (E5.3 #740, E5.4 #741)
- THE DETERMINISTIC LAYER CARRIES THE SAFETY. A fact is rows: it holds their ids, the numbers and IST clock times counted or
  read from them, and the drug / test names they carry (a strength inside a name is one of its numbers — `mkFact`). A line is
  `renderLine(fact)`. `acceptance/copilot-verifier.acceptance.test.ts` proves over 400 generated facts that a template prints
  only its fact's numbers, and that any one number changed in a reply is refused — that test is the "number differs from its
  record fails CI" check.
- A MODEL ONLY REWORDS, BY ALLOWLIST, FAIL CLOSED (review of 1f7cc591; a word-by-word check was beaten four ways).
  `verifyReworded` accepts a rewording only when it is the template line's own tokens (`lineTokens`), ALL of them and IN
  ORDER, with nothing between them but words of the closed list `CONNECTIVES` (and, with, since, at, the, a, an, is, was,
  were, are, has, had, been, there, also, then — no "of", "over", "to", "from", "no"). Any other token (a changed or moved
  number, a band word, a medicine, advice, a source, a number word in any script), any character that is not permitted
  punctuation, a proposal or money word: the line keeps the record's own words. The model's real freedom is the order of
  the lines; abnormal lines still sort first. NEVER ADD A BINDING OR NEGATING WORD TO `CONNECTIVES`.
- THE READ NEVER CALLS A MODEL AND NEVER WRITES. `readSinceYesterday` is the page; `polishSinceYesterday` (a POST the page
  fires after it has drawn) asks inside `SINCE_BUDGET_MS` (1 s) and keeps accepted rewordings in `ipd_copilot_drafts` per
  admission, doctor and IST day. A kept rewording is re-verified against TODAY's facts on every read (§4.10 edge 13): a new
  vitals set changes the line's numbers and the kept sentence is dropped. The same `factsHash` never costs a second call
  (also when every line was refused). Model down / slow: a fallback row is kept and the model is left alone for these
  records for `MODEL_COOLDOWN_MS` (5 min, `mayAskAgain`); off / halted / capped / barred: no row. Always the plain timeline.
- WINDOW (DECIDED): since the READER's own latest round on the patient (any status — a resident's draft is their last look),
  else 24 h. Other doctors' rounds in the window are a line.
- ONE DOOR TO A MODEL (`copilot-model.ts`), the staff copilot's own: `openAiCompatibleClient(cfg.copilot)`, `maskQuestion` +
  `assertNoIdentifiers`, `readCopilotGate` (halt `global` / `read`, plus `draft` for the two drafters; the ₹ cap of decision
  0064), `SpendMeter`, and `recordAsk` — a drafter's call is a `copilot_asks` row (`route = model`, `intent = ipd.*`, NO
  question text). SPEND IS RESERVED BEFORE THE CALL (the table is append-only): a `failed` / `answer_key = reserved` row with
  the worst case (input + `maxTokens`), then an `answered` row with no cost — the cap counts high, never low, and the
  health counts see two rows per answered call. `askIpdModel` NEVER THROWS: gate, ledger or provider failing is a fallback.
  Order of refusals: barred → no model configured → halted / capped → identifier leak → down / over budget.
- BARRED (`modelBarred`, read inside the door from the admission — never a caller's flag): sealed (`sensitive_context`),
  confidential (`is_confidential`) and medico-legal (`mlc`) patients get no model call at all, on all three surfaces.
- WHAT A MODEL SEES: since yesterday — the template lines (no identity in them). SBAR / discharge — the shift's nursing
  notes / the round notes and nursing notes, fenced as DATA (`fenced`, `UNTRUSTED` in the system prompt: nothing inside is an
  instruction), masked by VALUE (`termsToMask`: patient name, alias, UHID, admission number, the authors, guardians, pass
  holders, the deposit's payer, the family link's consenter; bed and ward) and by SHAPE (`maskForModel`: the name after a
  kinship word or title, any bed / ward / room token, any telephone number; digits of every script), then scrubbed again.
- FREE TEXT (`verifyFreeText`): ASCII only; every number and clock time already in the notes (or the facts); every guarded
  class it carries (negation, direction, outcome, band — `GUARDED`) carried by the notes; no proposal word; no money word;
  no placeholder; none of the masked names. `medicinesNamedWithoutOrder`: a medicine named with no ACTIVE order is flagged
  whether or not a note names it (`no_active_order` / `order_stopped`); one on no order and in no note is `model_invented`
  (the text is dropped); any other word of a model's text that is in no note, on no order and not in `SUMMARY_WORDS` is
  `unverified` (a misspelt medicine looks like that). The SBAR sentence has nowhere to carry a flag: any flag refuses it.
- NO SILENT CAP: every list is read newest first, one row past its limit (`FACT_ROW_LIMIT`, `DISCHARGE_LIMITS`); a cut list
  is named in `truncated` (shown on the block / the draft) and a truncated discharge draft is not `complete`.
- WHAT A DRAFT ROW KEEPS (retention): never record text — ids, the fingerprint, and the model's own checked sentence or
  paragraph. Structured lines are rendered again from the records. The kernel's retention sweep has no table registry.
- SBAR: window = the giving nurse's shift (for `HANDOVER_GRACE_MS`, 60 min, into the next shift: the shift just ended).
  `readHandoverDraft` (GET, no model, no write) answers the KEPT draft of the shift while the records are what it was built
  from, else the plain lines with `changedSinceDraft`. `buildSbarDraft` (POST) runs on the nurse's tap or when the records
  changed; unchanged records answer the kept draft (no second call). `give_shift_handover` with `draftId` →
  `checkSbarDraftForGive`: this admission's draft (`shift_handover_draft_not_found`), records unchanged since the build
  (`shift_handover_draft_stale` — build again), and `draft_edited` = the given text differs from the draft's. The signer
  may be another nurse than the builder; the card names both (`draft.builtBy`, `givenBy`). Nothing auto-accepts.
- DISCHARGE: structured parts come from the record, never the model — diagnosis (the admission's), medicines (one row per
  ACTIVE drug order, `source: order` + `orderId`), results reported / awaited (the stay's own lab and imaging order items;
  restricted items are never named). Procedures come from ot's `proceduresDone` (cases with an incision during the stay, or of the day-care encounter an
  `ot_daycare_conversion` admission names in `source_ref`; a theatre conversion names both codes; no quote or package),
  source `ot`, named only when there is one (`procedureText`). Bedside and IR procedures have no record here yet. The
  course is the signed rounds quoted in order, or the model's summary. `save_summary_draft` takes `draftId`; the SERVER
  stamps `draft_source = copilot_draft`, the draft's model id and prompt version, and `draft_id`; the stamp is sticky across
  later saves. A template draft has `draft_model_id` null. The draft row's fingerprint is `dischargeRecordsHash` (orders
  and their status, signed rounds, nursing notes, result items): a save naming a draft built before the records changed is
  refused (`summary_draft_stale`); a copilot-sourced summary carries `content.recordsHash` from its last save and the
  signature refuses when the records moved since (`summary_records_changed` — open, check, save, sign). The content's
  server fields (`medicineFlags`, `medicineAck`, `recordsHash`) are stripped from every client save. `IpdSummaryView.stamp`
  is the "Draft" stamp while unsigned and copilot-sourced (screen and `SummaryPrint`).
- MEDICINES WITHOUT AN ACTIVE ORDER (DECIDED): a DRAFTED row (`source: order`) that no longer matches its active order
  refuses the signature (`medicine_not_on_active_order`). A TYPED row is flagged on the summary and the signature needs
  the doctor's reason (`unorderedMedicinesReason`; without it the same refusal with `detail.acknowledge`); the flags and
  `medicineAck` (reason, signer, time) are written into the signed content and never recomputed. The reason is asked on
  EVERY summary that names a medicine with no active order — person-typed or copilot-sourced, with drug orders on the
  stay or none (NABH medicine reconciliation; the E3.2 carve-out was lifted by decision 0074).
- LAB VALUES (`labValueFacts`): lab's `resultedValuesForOrders` (its index) answers the stay's own lab orders' SIGNED,
  non-superseded, non-restricted values signed in the window. One `lab_value` fact per analyte — latest value, plus the
  most severe one when worse — critical (weight 95) before out of range (78) before in range (40), at most
  `LAB_VALUE_FACTS` (4); the "results reported" count line stays. A free-text result is named, never quoted. Vital "abnormal" is judged only for NEWS2 patients
  (`ADULT_RANGE`); a child's or a mother's deterioration is the band's to say. Temperatures print in °C as recorded.
- NO MONEY: nothing here reads a charge line; `MONEY_RE` refuses a model's money word. No permission was added:
  `ipd.round.sign` + the treating team (since yesterday), `ipd.handover.shift` (SBAR), `ipd.discharge.declare` (discharge).

### TPA desk (#604, decision 0075 — SPEC-tpa-desk-2026-10-15)
- FILES: `tpa.ts` (the eight acts), `tpa-read.ts` (`readTpaBoard`, `readTpaPanel`, `tpaDueCard`, `authStateOf`), `tpa-packages.ts`
  (`parseSchemePackagesCsv`, `importSchemePackages`, `searchSchemePackages`, `packageShares`), `tpa-events.ts`, `tpa.controller.ts`
  (`IPD_TPA_ROUTES`), `kernel/db/schema/ipd-tpa.ts` (migration `ipd_tpa`), `packages/contracts/src/ipd/intents-tpa.ts` + `tpa.ts`,
  `scripts/import-scheme-packages.ts` (not a seed), `scripts/data/nha-hbp-sample.csv` (8 SYNTHETIC rows — never the NHA list).
  Web: `/ipd/tpa` (`apps/web/src/screens/ipd-tpa.tsx`) and the panel on the bill page (`apps/web/src/screens/ipd-tpa-panel.tsx`).
- THE PRE-AUTH RECORD IS STILL `ipd_payer_auths` and the claim is still `ipd_payer_claims` (one per settled bill): the desk adds
  queries, documents, packages, claim events and deductions beside them, and moves `ipd_payer_claims.status` only forward
  (`pending` → `filed` on submit; `filed` → `settled` on a settlement or a short payment, → `rejected`; `rejected` → `filed` on a
  resubmission). `settled` is what #763's void reads (`payer_claim_settled`). Claim acts take the ADMISSION lock first, as the void does.
- CLOCK (DECIDED, IRDAI master circular 2024 / NHA TMS; `IPD_TPA_SLA_MINUTES`): a waiting request (latest entry of the current
  authorisation is `requested`) is due in 60 min (scheme 360), a final approval in 180; hot at twice. An OPEN query on a pre-auth
  stage stops the insurer's clock (row `query_open`, ours: due 60, hot 240); its answer RESTARTS the insurer's clock from the
  answer time. Nothing is stored: the clocks are read from rows.
- ENHANCEMENT DUE (DECIDED $): insured (cashless / corporate), approved, nothing waiting, placed, and claimable ≥ 90 % of the
  approved total, claimable = the payer split's payer share + its `over_approved_amount` (what the approval holds back). Hot at 100 %.
- PACKAGES (DECIDED $): only on a pmjay / state_scheme admission and only that scheme's LIVE packages; the rate is a snapshot at
  selection; highest 100 %, second 50 %, third on 25 % (`IPD_PACKAGE_SHARES_BP`); Σ is the payer amount and the default claimed
  amount. The scheme split is untouched (patient ₹0, the receipt guard): package lines never bill the patient; the bill's payer
  part minus the claimed amount is the hospital's package variance, never the patient's.
- IMPORT (DECIDED): NHA's column names accepted in priority order (Procedure Code beats Package Code); a bad row refuses the whole
  file (`package_import_invalid`, `detail.problems` by line); adds and updates, never retires an omitted package; a change retires
  the live row and inserts the new one. `ipd.payer.terms`.
- CLAIM (DECIDED): filed only with `discharge_summary` and `final_bill` attached at stage `claim` (`IPD_CLAIM_REQUIRED_DOCUMENTS`);
  settlement net + TDS + Σ deductions = the claimed amount to the paisa, else `settlement_does_not_add_up` with `detail.gapPaise`;
  TDS typed, never computed; deductions never re-billed to the patient by the system. Ageing from the latest submission: card at
  30 days, hot at 60; a pending claim is late after 7 days (board only).
- CLAIM GUARDS (#604 review, `tpa-claims.test.ts`): a scheme stay's packages are claimed ONCE across its bills (final +
  supplementary each carry a claim row): the cap and default is Σ packages less what the stay's other filed / settled /
  rejected claims claimed; any other claim is capped at its bill's payer portion (`claim_exceeds_claimable`, `detail.capPaise`).
  Packages freeze once any claim of the stay is filed (`package_claim_filed`). A void refuses while the bill's claim is `filed`
  (`payer_claim_filed`): withdrawing it would make the payer's settlement unrecordable and free the stay to claim again. A
  `final_bill` document counts only if named to the claim or attached at or after the claim's bill was settled.
- WHO (DECIDED, no new permission): `ipd.payer.manage` for the board, panel, queries, documents, packages, submit, reject and the
  `ipd.tpa_due` card; `ipd.payer.terms` for a settlement and the import. The card shows the admission number, never a name.
- Acceptance: `acceptance/tpa.acceptance.test.ts` (i–ix); each guard was killed by a mutant before it went green.

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
- (E1.5) `blockBedIn` / `unblockBedIn` are the intents' acts inside a caller's transaction (no permission, no
  idempotency wrapper — the caller owns both); `blockBed` / `unblockBed` wrap them. `unblockBedIn` refuses a block an
  open repair ticket holds (`repair_ticket_open`, "Close the repair ticket") by reading `maintenance_tickets`; the
  maintenance module closes its ticket first and then calls it. `reserveBed` / `assignBed` refuse a bed with ANY open
  repair ticket (`refuseOpenRepair`) — a ticket on a reserved bed blocks nothing. `lockBedIn` exports the ROOM→BED locks.
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

- (E2.3) `.ipdb` is ALSO the Beds board's root class (`ipd-beds.css`: `height: 100vh; overflow: hidden`), and vite loads
  every screen's CSS globally: the bill desk overrides it with `.ipdb.ipdbd`. The interim bill (`apps/web/src/screens/ipd-bill.tsx`) still
  inherits the collision (owed).
- (E2.3) Releasing the daily totals (issue #761): approve the WhatsApp template / DLT id, give the pump a recipient seam that
  resolves `attendantRef` at send time, then remove `heldReason` from `ipd.daily_totals`. Until then nothing is sent.
- (E2.3) Migration 0209 was regenerated in place (unmerged) to add `ipd_daily_totals`: a lane test DB that applied the old
  0209 dies `relation already exists` — drop `hmis_lane_<lane>_test_1/_2`.

- (E3.2) SEAMS LEFT OPEN: the department "silence over 30 minutes escalates" is not a job (the tracker shows the clock; the
  workflow's 3-hour SLA tells the duty manager); `medicines_not_returned` (pharmacy returns) waits for the eMAR lane
  (`medicine_not_on_active_order` is E5.4's, below); the mortuary handover and MCCD are register rows, not
  tasks (`taskIds` is empty); claim filing and the family tracker link (E3.3) are later lanes (the drafter is E5.4).
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

- (E3.3) HELD: the OTP SMS needs a DLT template id (`IPD_FAMILY_OTP_DLT_TEMPLATE_ID`); without it every send answers
  `family_otp_unavailable` (503). The link itself is handed over at the desk (QR / copy) — no SMS/WhatsApp of the link yet.
- (E3.3) `ipdManifest` now has a subscription, so the WORKER installs it (`kernel/modules/manifests.test.ts`, `kernel/worker/seed-cursors.test.ts`,
  `apps/core/test/worker-runtime.e2e.test.ts` censuses moved). The stop consumer constant lives in `family-events.ts` to avoid a
  manifest ↔ family import cycle.
- (E3.3, superseded by E4.1) The nursing roles are seeded: the nursing supervisor and superintendent work the family's
  callbacks too; `ipd.condition.set` stays the doctor's alone.

- (E5.2) `.ipdb` at ≤ 760 px is now one PAGE-scrolling column (`ipd-beds.css`); the bill desk shares `.ipdb` and inherits it.
- (E5.2) `readBedFlow` writes on read; the Beds board (not the wall) and the `ipd.bed_proposal` card both call it. Lane test
  DBs that applied an older 0213 must be dropped if the migration is regenerated.

- (E4.1) SEAMS LEFT OPEN: a missed vitals set is a Now card, not yet a task (§4.5 "becomes a task" — needs a nursing task
  kind on the task engine); Morse/Braden reassessment tasks likewise (`tasksRaised: 0`); pressure-injury photos need the
  documents upload on the assessment form (the web sends none); allergies typed at assessment are not yet written to the
  patient master (`patients` `addAllergy`); doctor-set vitals frequency, NEWS2 SpO2 scale 2 and the PEWS +2 for
  nebulisers / post-op vomiting wait for ipd-orders and eMAR; `not_receiving_ward` and "my patients" wait for a
  nurse-to-ward roster assignment; nurse-to-patient ratio on the station waits for the roster.
- (E4.1) VERIFY BEFORE GO-LIVE (owed): the MEOWS rows against Singh et al. 2012 Table 1 (page cited as p. 13), the
  Brighton PEWS rows against Monaghan 2005 (page cited as p. 33) and the APLS age bands (Table 1.1) — printed pages and every
  threshold row, by a clinician, against the printed sources (`packages/contracts/src/ipd/ews.ts` marks each).
- (E4.1) A new scheduler job (`sweepIpdNursing`, 60 s) moved the five job censuses and the worker pool (27 → 28).
- (E4.1) `packages/contracts/src/ipd/ews.ts` lives in CONTRACTS (the phone scores at once with the same tables); the server re-scores every set and
  is the authority. Changing a table changes both sides in one commit.

- (E4.2, closed by #785) lab / imaging orders now post to the running bill (see Running bill, ORDERS). Verbal
  orders, verify, issue and doses are the eMAR's (E4.3); `new_order` (a nurse's Now card) is E4.3's too. The covering
  consultant is the unit head — the roster has no per-doctor inpatient cover. Latest vitals on the round page wait for the
  nursing lane's export (`vitals: null`). Decision 0054 suggestions are not on the inpatient drug form yet.
- (#785) With `opts.tx` the ordering door runs the IMAGING order in the caller's transaction too (a savepoint): the sink takes
  the admission's advisory lock and the line's FK takes a key-share lock on the admission row, both held by `placeTests` — a
  second connection would wait for ever. Any new caller that holds the admission lock and orders imaging must pass `tx`.
- (#785) STAGING DATA: orders placed on an `IP` number BEFORE this change carry a held lab invoice and no line, and their
  scans have no line — left as they are (staging only; IPD is not live). Such a scan still raises `acquired_unbilled`.
- (#785) MIGRATION 0225 LOCK WINDOW: the ALTERs on `ipd_charge_lines` / `ipd_charge_exceptions` take an ACCESS EXCLUSIVE
  lock and re-validate the widened CHECKs over every row — a few ms on staging; at go-live run it outside OPD hours.
  Regenerated in place before merge: a lane test DB that applied the first 0225 must be dropped.
- (E4.2) `charges.ts` `postConsultantVisit` treats `covering_for` as the treating consultant: the 08:00 clock writes it, so a
  covering head's visit is `visit`, not `cross_visit`.

- (E4.3) SEAMS LEFT OPEN: ward issue and returns are not on the running bill (`ipd_charge_lines` has no pharmacy source — a
  money change for the charges lane); the credit is recorded in units. Labels print from the browser (no `ipd_emar_label`
  print-outbox document; the band's precedent). Interaction findings depend on adopted formulary pairs (none → "no interaction
  data"). The narcotic ward register counts issued / given / wasted / returned units, not a cabinet balance per ward.
  Infusion rate is free-typed (no pump feed, §5 Phase 2). The minute sweep rides `sweepIpdNursing` (no job, no pool client).

## 5. Callers
- `scripts/load-bed-layout.ts` (operator).
- `beds.controller.ts` (the web board), `kernel/worker/jobs.ts` (`lapseBedReservations`),
  `scripts/mark-incumbent-beds.ts` (cutover). ipd-admit, ipd-transfer and ipd-discharge call
  `assignBed`/`reserveBed` and `releaseBedOccupant`. housekeeping (E1.4) listens to the bed's KERNEL events (it
  raises one clean per release) and calls `markBedCleanIn` from its verified clean's transaction.
- (E1.2) `admit`/`emergencyAdmit`/`backfillDowntime` call `assignBedIn` and `endAdmissionHolds`; the Beds board reads
  open requests for its waiting column (`beds-board.ts`); ipd-charges (E2.1) reads `ipd_admissions` (payer, deposit)
  and `ipd_admission_deposits`; eMAR resolves band serials against `ipd_bands`.
- (E2.1) `kernel/worker/jobs.ts` (`postNightlyIpdCharges`, daily 00:05 IST); the rounds lane calls `postConsultantVisit`;
  the final bill (E3.2) calls `postAdmissionCharges`; `admissions.controller.ts` serves `readInterimBill`.
- (E2.2) `readInterimBill` calls `computePayerSplit`; `quotesFor` calls `capWarningsFor`; the transfer/class-change lane
  calls `roomRentCapWarning` before an upgrade consent; the final bill (E3.2) will call `computePayerSplit` and keep it.
- (E3.1) `transfers.controller.ts` (the Beds drawer's Transfer panel, the `/ipd/handovers` list); the passes lane consumes
  `ipd.transfer.accepted`; `charges.ts` reads `ipd_class_changes` through `classChangesOf`.
- (E2.3) `kernel/worker/jobs.ts` (`postNightlyIpdCharges` job → `runIpdBillDeskNightly`); `takeDeposit` → `evaluateDepositLadder`;
  `kernel/desk` collects the `ipd.deposit_low` provider (key renamed from `ipd.billdesk` in E5.1) from `ipdManifest.desk`; the notify pump renders `ipd.daily_totals`.
- (E3.2) `discharge.controller.ts` (the Discharge desk); the passes lane consumes `ipd.admission.discharged|lama|absconded|
  deceased`; the goal queries read `ipd.discharge.fit_declared` and `ipd.gate_pass.scanned` (G4); `prepareFinalBill` calls
  `postAdmissionCharges` (with `presumedDischargeAt`); `endStay` calls `endHoldIn` / `releaseBedOccupant`; billing's
  `issueInvoice`, `previewInvoice`, `requestRefund`, `receiptUnallocatedPaise` are called inside the settle transaction.
- (E5.1/E5.2) `kernel/desk` collects the five IPD providers from `ipdManifest.desk`; `readBedBoard` calls `readBedFlow`;
  `reserveBed` / `assignBedIn` call `settleBedProposalIn`; `cancelAdmission` calls `withdrawBedProposalIn`.
- (E4.1) `kernel/worker/jobs.ts` (`sweepIpdNursing`, every 60 s); `kernel/desk` collects the four nursing providers from
  `ipdManifest.desk`; the realtime router fans nursing events (and every bed event) to `ipd_nursing:board`; the goal
  query G7 reads `ipd.ews.breached` / `ipd.ews.acknowledged`.
- (E4.3) `emar.controller.ts` (the phone's bedside, the pharmacy desk, the ward MAR); `kernel/worker/jobs.ts` `sweepIpdNursing` →
  `sweepIpdEmar`; the worker's `workerConsumers` → `emarAllergyConsumer`; `kernel/desk` collects `ipd.due_dose` / `ipd.new_order`;
  `stopIpOrder` / `cancelIpOrder` call `cancelFutureDosesIn`; goal G6a reads `ipd.dose.given` (`patientCheck.kind`, `labelCode`, `wardId`).
- (E4.2) `rounds.controller.ts` (the Rounds screens); `kernel/worker/jobs.ts` `sweepStaffNotices` → `sweepIpdRoundsClock`; the eMAR
  (E4.3) consumes `ipd.order.placed|stopped|cancelled` and calls `readIpdOrder`, `activeIpdOrdersOf`, `markIpdOrderIssuedIn`;
  `signRound` calls `postConsultantVisit` and `declareFitIn`; `placeIpOrder` calls `ordering` `orderTests` / `routeTests` and
  `formulary` `medicinesByIds`.
- (#785) billing's episode charge sink (`IpdModule` → `registerIpdOrderChargeSink`): lab `placeLabOrder`, the lab reflex,
  `refundOnCancel`; radiology `placeImagingOrder`, `cancelStudy`.
- (E5.3, E5.4) `copilot.controller.ts` (the round page's first block, the handover pane, the summary editor);
  `nursing.ts` `giveShiftHandover` and `discharge.ts` `saveSummaryDraft` call `draftForSigning`; `listShiftHandovers` and
  `readSummary` call `draftProvenances`; `signSummary` calls `medicineFlagsOf`.
