import { depositLowCard } from "./bill-desk";
import { familyCallbacksCard } from "./family";
import { bedProposalCard, cleaningOverdueCard, dischargeBlockedCard } from "./now-cards";
import { assessmentDueCard, ewsRisingCard, handoverPendingCard, overdueVitalsCard } from "./nursing-cards";
import { dueDoseCard, newOrderCard } from "./emar-cards";
import { allergyFlagsCard } from "./rounds-cards";
import { tpaDueCard } from "./tpa-read";
import { wardNeedsYouCard } from "./nurse-ward-read";
import { IPD_EMAR_ALLERGY_CONSUMER } from "./emar-events";
import {
  IPD_BEDS_VIEW, IPD_BEDS_MANAGE, IPD_BEDS_CLEAN, IPD_BEDS_OVERFLOW, IPD_ADMIT_REQUEST, IPD_ADMIT, IPD_PAYER_MANAGE, IPD_BAND_PRINT, IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS, IPD_TRANSFER_START, IPD_TRANSFER_ACCEPT, IPD_DISCHARGE_VIEW, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_BILL, IPD_GATE_PASS, IPD_GATE_SCAN, IPD_DISCHARGE_EXIT, IPD_MORTUARY_MANAGE, IPD_BILLDESK_VIEW, IPD_FAMILY_ISSUE, IPD_CONDITION_SET, IPD_ROUND_SIGN, IPD_ORDER_PLACE,
  IPD_NURSING_VIEW, IPD_VITALS_RECORD, IPD_ASSESSMENT_RECORD, IPD_SHIFT_HANDOVER, IPD_EWS_RESPOND, IPD_NURSING_ASSIGN, IPD_NURSING_FLOAT,
  IPD_EMAR_VIEW, IPD_EMAR_GIVE, IPD_EMAR_VERIFY, IPD_EMAR_ISSUE,
} from "./permissions";
import { IPD_FAMILY_STOP_CONSUMER } from "./family-events";
import { admissionAbsconded, admissionDeceased } from "./discharge-events";
import type { ModuleManifest } from "../../kernel/modules/manifest";

export {
  IPD_BEDS_VIEW, IPD_BEDS_MANAGE, IPD_BEDS_CLEAN, IPD_BEDS_OVERFLOW, IPD_ADMIT_REQUEST, IPD_ADMIT, IPD_PAYER_MANAGE, IPD_BAND_PRINT, IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS, IPD_TRANSFER_START, IPD_TRANSFER_ACCEPT, IPD_DISCHARGE_VIEW, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_BILL, IPD_GATE_PASS, IPD_GATE_SCAN, IPD_DISCHARGE_EXIT, IPD_MORTUARY_MANAGE, IPD_BILLDESK_VIEW, IPD_FAMILY_ISSUE, IPD_CONDITION_SET, IPD_ROUND_SIGN, IPD_ORDER_PLACE,
  IPD_NURSING_VIEW, IPD_VITALS_RECORD, IPD_ASSESSMENT_RECORD, IPD_SHIFT_HANDOVER, IPD_EWS_RESPOND, IPD_NURSING_ASSIGN, IPD_NURSING_FLOAT,
  IPD_EMAR_VIEW, IPD_EMAR_GIVE, IPD_EMAR_VERIFY, IPD_EMAR_ISSUE,
} from "./permissions";

/**
 * E1.1 (#718) — the inpatient module's declared surface. The bed board is its first screen and these four are its
 * first permissions (spec SPEC-ipd-core §4.1, §4.9 A):
 *
 *   ipd.beds.view      read the capacity board (and subscribe to it live)
 *   ipd.beds.manage    reserve, release a reservation, assign, block, unblock, release an incumbent bed, retire
 *   ipd.beds.clean     mark a cleaned bed ready (the housekeeping lane will call the same function)
 *   ipd.beds.overflow  put a patient on an overflow bed (extra bed, corridor trolley): the duty manager's approval
 *
 * E1.2 (#719) adds the admission desk's four (spec §4.2, §4.9 B):
 *
 *   ipd.admit.request  raise an admission request (the doctor's advice or the desk on the advising doctor's word);
 *                      mark an emergency patient stabilised. Answers carry no money (decision 0058).
 *   ipd.admit          plan (payer, class, deposit), take the deposit, admit, cancel, the emergency lane, the
 *                      downtime back-fill, record consent, ask for an approval
 *   ipd.payer.manage   the manual authorisation record (pre-auth, enhancements, final approval, payer change); since
 *                      #604 (decision 0075) also the TPA desk: payer queries, documents, scheme packages, claim filing
 *                      and rejection, the board `/ipd/tpa` and the `ipd.tpa_due` card
 *   ipd.band.print     print and reprint the wristband
 *
 * E2.1 (#725) adds the running bill's two (spec §4.3, §4.9 H). NO DOCTOR ROLE HOLDS EITHER (decision 0058):
 *
 *   ipd.bill.view       read an admission's interim bill (lines, totals, deposit, balance) — billing and front office
 *   ipd.charges.reverse post a reversal line against a wrong charge (never an edit) — the billing manager
 *
 * E2.2 (#726, review 11) adds one. NO DOCTOR ROLE HOLDS IT (decision 0058):
 *
 *   ipd.payer.terms     type the letter's money terms (room-rent cap, co-pay) on the authorisation record and keep
 *                       the non-payables list — the billing manager (the TPA desk sits in billing). Status and
 *                       pre-auth number stay with `ipd.payer.manage` (front office). #604: also a claim's settlement
 *                       (net paid, TDS, deductions) and the scheme package master import.
 *
 * E3.1 (#729) adds the transfer's two (spec §4.4). A class change in place rides `ipd.admit` (the desk's consented
 * act with money consequences; never a doctor's):
 *
 *   ipd.transfer.start  start a transfer with its SBAR handover, cancel it, swap two patients' beds
 *   ipd.transfer.accept accept a handover as the receiving nurse (the only act that moves the patient), or decline it
 *
 * E2.3 (#727) adds one. NO DOCTOR ROLE HOLDS IT (decision 0058):
 *
 *   ipd.billdesk.view   the bill desk (exceptions only: deposit ladder, posting exceptions, unchecked downtime deposits,
 *                       cash consent, waiting authorisations, discharges with a balance) and its `deposit_low` Now card —
 *                       cashier, billing manager, front-office supervisor, duty manager, owner
 *
 * E3.2 (#730) adds the discharge's eight (spec §4.7). Money stays off doctors (0058): the final bill needs
 * `ipd.discharge.bill`, held by billing alone; the tracker's money block needs `ipd.bill.view`.
 *
 *   ipd.discharge.view     read the discharge desk (board, tracker, summary) — everyone in the cascade
 *   ipd.discharge.declare  declare and cancel fit, draft and sign the summary, record a death — the doctor
 *   ipd.discharge.confirm  confirm "no pending charge" for one's own department (the role decides which)
 *   ipd.discharge.bill     compose and settle the final bill, ask for the dues approval — the cashier, billing manager
 *   ipd.gate.pass          issue the gate pass — the desk, billing, the duty manager
 *   ipd.gate.scan          scan the gate pass at the exit — the front office and the duty manager (no security role yet)
 *   ipd.discharge.exit     record LAMA / DAMA and absconding — the doctor and the duty manager
 *   ipd.mortuary.manage    receive and release a body in the mortuary register — the duty manager
 *
 * E3.3 (#731) adds the family link's two:
 *
 *   ipd.family.issue    issue and revoke the attendant's family link (OTP to the registered phone), read and close the
 *                       family's callback requests — front office, its supervisor, the duty manager (the ward desk)
 *   ipd.condition.set   set the condition word the family sees and turn the family link off for a sensitive admission —
 *                       the doctor (nursing roles join when ipd-nursing seeds them). Clinical; no money.
 *
 * E4.1 (#733) adds nursing's five (spec §4.5, §4.9 C/D1). Clinical; no money:
 *
 *   ipd.nursing.view       read the nurse station (board C), my shift (board D1) and a patient's nursing chart
 *   ipd.vitals.record      record vitals (scored at once), intake/output and nursing notes; the `overdue_vitals` card
 *   ipd.assessment.record  record the nursing admission assessment (due within an hour); the `assessment_due` card
 *   ipd.handover.shift     give a shift handover (SBAR drafted from the record) and accept another nurse's; the
 *                          `handover_pending` card
 *   ipd.ews.respond        acknowledge an early-warning alert (G7: a doctor's acknowledgement counts); the `ews_rising` card
 *
 * WM-1 (#982, decision 0089) adds the ward's two. Clinical; no money:
 *
 *   ipd.nursing.assign     draft, copy and publish a ward's shift map (every occupied bed to one registered nurse), assign
 *                          and reassign a bed with a reason, read the in-charge cockpit; the `ward_needs_you` card — the
 *                          ward in-charge and the nursing supervisor
 *   ipd.nursing.float      read the float pool by floor and move a nurse to another ward for a shift — the nursing
 *                          supervisor and the nursing superintendent
 *
 * E4.2 (#734) adds the rounds' two (spec §4.5A, §4.9 E). Clinical; no money on either (decision 0058):
 *
 *   ipd.round.sign      read the doctor's rounds list and a patient's round page, sign a round (a resident's is a draft
 *                       until co-signed), co-sign, ask for and close a cross-consult — the doctor
 *   ipd.order.place     place, stop and cancel inpatient orders (drugs; lab and imaging through the ordering door, which
 *                       still asks `orders.place` and the department's own permission) — the doctor
 *
 * E4.3 (#735) adds the eMAR's four (spec §4.6, §4.9 D). Clinical; no money (decision 0058):
 *
 *   ipd.emar.view    read a patient's MAR, the ward MAR chart, the phone's due list and the override counts; hold a dose on a
 *                    doctor's instruction (with `ipd.order.place`); the `new_order` card — nurses, doctors, pharmacists
 *   ipd.emar.give    the bedside: scan, give, hold, refuse, miss, re-offer, correct (entered in error / incident), the second
 *                    nurse's PIN, infusions, narcotic wastage, record a verbal order; the `due_dose` card — the nursing roles
 *   ipd.emar.verify  the pharmacist's verify queue (allergy, interaction, dose, duplicate), verify / reject / query, the
 *                    allergy flags, the label sheet — the pharmacist
 *   ipd.emar.issue   issue to the ward with patient labels (stock out through the materials ledger) and take returns back
 *                    (stock in, units credited) — the pharmacist
 *
 * Who holds them is `scripts/seed-roles.ts` (README "IPD beds" and "IPD admission" prose). The 2-hour reservation lapse is a scheduler job (`kernel/worker/jobs.ts`
 * `lapseBedReservations`); the one subscription is E3.3's family-link stop, so the worker installs this manifest.
 */

export const ipdManifest: ModuleManifest = {
  key: "ipd",
  title: "Inpatients",
  menu: [
    { label: "Beds", path: "/ipd/beds", permission: IPD_BEDS_VIEW },
    { label: "Admit", path: "/ipd/admit", permission: IPD_ADMIT },
    // E3.1 (#729) — the receiving ward's "Waiting for you" handover list.
    { label: "Handovers", path: "/ipd/handovers", permission: IPD_TRANSFER_ACCEPT },
    { label: "Bill desk", path: "/ipd/bill-desk", permission: IPD_BILLDESK_VIEW },
    // E3.2 (#730) — the discharge desk: every admission in the cascade, its steps, clocks and blockers.
    { label: "Discharge", path: "/ipd/discharge", permission: IPD_DISCHARGE_VIEW },
    // E3.3 (#731) — the ward desk's family callback requests.
    { label: "Family calls", path: "/ipd/family-callbacks", permission: IPD_FAMILY_ISSUE },
    // E4.1 (#733) — board C, the ward nurse station (16:9), and board D1, my shift on the phone (390 px).
    { label: "Ward", path: "/ipd/ward", permission: IPD_NURSING_VIEW },
    { label: "My shift", path: "/ipd/my-shift", permission: IPD_VITALS_RECORD },
    // WM-1 (#982) — the in-charge's shift assignment and cockpit (1440).
    { label: "Assign nurses", path: "/ipd/ward/assign", permission: IPD_NURSING_ASSIGN },
    { label: "Ward cockpit", path: "/ipd/ward/cockpit", permission: IPD_NURSING_ASSIGN },
    // E4.2 (#734) — the doctor's inpatient rounds list.
    { label: "Rounds", path: "/ipd/rounds", permission: IPD_ROUND_SIGN },
    // E4.3 (#735) — the ward MAR chart (16:9) and the pharmacist's verify queue (desktop).
    { label: "MAR", path: "/ipd/mar", permission: IPD_EMAR_VIEW },
    { label: "IP pharmacy", path: "/ipd/pharmacy", permission: IPD_EMAR_VERIFY },
    // 2026-10-14 — the ward narcotic register (NDPS / NABH): balances, the two-nurse shift count, exceptions.
    { label: "Narcotics", path: "/ipd/narcotics", permission: IPD_EMAR_VIEW },
    // #604 (decision 0075) — the TPA desk board: pre-auths, payer queries, enhancements due, claims (money: no doctor role).
    { label: "TPA desk", path: "/ipd/tpa", permission: IPD_PAYER_MANAGE },
  ],
  permissions: [
    IPD_BEDS_VIEW, IPD_BEDS_MANAGE, IPD_BEDS_CLEAN, IPD_BEDS_OVERFLOW, IPD_ADMIT_REQUEST, IPD_ADMIT, IPD_PAYER_MANAGE, IPD_BAND_PRINT,
    IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS, IPD_BILLDESK_VIEW,
    // E3.1 (#729)
    IPD_TRANSFER_START, IPD_TRANSFER_ACCEPT,
    // E3.2 (#730)
    IPD_DISCHARGE_VIEW, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_BILL, IPD_GATE_PASS, IPD_GATE_SCAN,
    IPD_DISCHARGE_EXIT, IPD_MORTUARY_MANAGE,
    // E3.3 (#731)
    IPD_FAMILY_ISSUE, IPD_CONDITION_SET,
    // E4.1 (#733)
    IPD_NURSING_VIEW, IPD_VITALS_RECORD, IPD_ASSESSMENT_RECORD, IPD_SHIFT_HANDOVER, IPD_EWS_RESPOND,
    // WM-1 (#982)
    IPD_NURSING_ASSIGN, IPD_NURSING_FLOAT,
    // E4.2 (#734)
    IPD_ROUND_SIGN, IPD_ORDER_PLACE,
    // E4.3 (#735)
    IPD_EMAR_VIEW, IPD_EMAR_GIVE, IPD_EMAR_VERIFY, IPD_EMAR_ISSUE,
  ],
  // E3.3 (#731) — death and absconding revoke the family link (`familyStopConsumer`, registered in the worker's
  // `workerConsumers` in the same commit; its cursor is seeded at deploy by `seedCursors`).
  subscriptions: [
    { event: admissionDeceased.name, consumer: IPD_FAMILY_STOP_CONSUMER },
    { event: admissionAbsconded.name, consumer: IPD_FAMILY_STOP_CONSUMER },
    // Review #764 — a patient sealed after the link was issued: revoke on that path.
    { event: "patient.updated", consumer: IPD_FAMILY_STOP_CONSUMER },
    // E4.3 (#735) — an allergy recorded later re-checks every active drug order (`emarAllergyConsumer`, registered in the
    // worker's `workerConsumers` in the same commit).
    { event: "allergy.recorded", consumer: IPD_EMAR_ALLERGY_CONSUMER },
  ],
  // The Now cards (E5.1, #738): one provider and one permission per card type, its key the card's own key.
  // Declared here (not in their files) because those files import this one: the cards are called lazily.
  desk: [
    // E2.3 (#727) — MONEY: `ipd.billdesk.view`, which no doctor or nurse role holds (decision 0058).
    { key: "ipd.deposit_low", permission: IPD_BILLDESK_VIEW, load: async (ctx) => depositLowCard(ctx) },
    // E5.2 (#739) — a waiting request with Bed Flow's proposal; Confirm needs the same permission (`reserve_bed`).
    { key: "ipd.bed_proposal", permission: IPD_BEDS_MANAGE, load: async (ctx) => bedProposalCard(ctx) },
    // E5.1 (#738) — a fit-for-discharge stay stuck at a named step; no money on it.
    { key: "ipd.discharge_blocked", permission: IPD_DISCHARGE_VIEW, load: async (ctx) => dischargeBlockedCard(ctx) },
    // E5.1 (#738) — a bed in cleaning over 60 minutes (housekeeping's permission).
    { key: "ipd.cleaning_overdue", permission: IPD_BEDS_CLEAN, load: async (ctx) => cleaningOverdueCard(ctx) },
    // E3.3 (#731) — open family callback requests for the ward desk.
    { key: "ipd.family_callbacks", permission: IPD_FAMILY_ISSUE, load: async (ctx) => familyCallbacksCard(ctx.db) },
    // E4.1 (#733) — the four nursing cards, each gated by the permission of the act that answers it.
    { key: "ipd.overdue_vitals", permission: IPD_VITALS_RECORD, load: async (ctx) => overdueVitalsCard(ctx) },
    { key: "ipd.assessment_due", permission: IPD_ASSESSMENT_RECORD, load: async (ctx) => assessmentDueCard(ctx) },
    { key: "ipd.ews_rising", permission: IPD_EWS_RESPOND, load: async (ctx) => ewsRisingCard(ctx) },
    { key: "ipd.handover_pending", permission: IPD_SHIFT_HANDOVER, load: async (ctx) => handoverPendingCard(ctx) },
    // WM-1 (#982) — the in-charge's card: a bed with no nurse, a ratio breach, the next shift's map not published.
    { key: "ipd.ward_needs_you", permission: IPD_NURSING_ASSIGN, load: async (ctx) => wardNeedsYouCard(ctx) },
    // E4.3 (#735) — the eMAR's two nurse cards, each with its own permission.
    { key: "ipd.due_dose", permission: IPD_EMAR_GIVE, load: async (ctx) => dueDoseCard(ctx) },
    { key: "ipd.new_order", permission: IPD_EMAR_VIEW, load: async (ctx) => newOrderCard(ctx) },
    // The doctor's allergy card: an open eMAR allergy flag waiting on the doctor's decision, or an allergy recorded since the
    // doctor's last round — on the rounds list's own patients; a row opens the round page (`rounds-cards.ts`).
    { key: "ipd.allergy_flags", permission: IPD_ROUND_SIGN, load: async (ctx) => allergyFlagsCard(ctx) },
    // #604 (decision 0075) — MONEY: the TPA desk's pre-auths ageing, enhancements due and claims over 30 days
    // (`ipd.payer.manage`, which no doctor or nurse role holds — decision 0058). Admission number, never a name.
    { key: "ipd.tpa_due", permission: IPD_PAYER_MANAGE, load: async (ctx) => tpaDueCard(ctx) },
  ],
};
