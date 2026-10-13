import { depositLowCard } from "./bill-desk";
import { familyCallbacksCard } from "./family";
import { bedProposalCard, cleaningOverdueCard, dischargeBlockedCard } from "./now-cards";
import { IPD_FAMILY_STOP_CONSUMER } from "./family-events";
import { admissionAbsconded, admissionDeceased } from "./discharge-events";
import type { ModuleManifest } from "../../kernel/modules/manifest";

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
 *   ipd.payer.manage   the manual authorisation record (pre-auth, enhancements, final approval, payer change)
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
 *                       pre-auth number stay with `ipd.payer.manage` (front office).
 * E3.1 (#729) adds the transfer's two (spec §4.4). A class change in place rides `ipd.admit` (the desk's consented
 * act with money consequences; never a doctor's):
 *
 *   ipd.transfer.start  start a transfer with its SBAR handover, cancel it, swap two patients' beds
 *   ipd.transfer.accept accept a handover as the receiving nurse (the only act that moves the patient), or decline it
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
 * E2.3 (#727) adds one. NO DOCTOR ROLE HOLDS IT (decision 0058):
 *
 *   ipd.billdesk.view   the bill desk (exceptions only: deposit ladder, posting exceptions, unchecked downtime deposits,
 *                       cash consent, waiting authorisations, discharges with a balance) and its `deposit_low` Now card —
 *                       cashier, billing manager, front-office supervisor, duty manager, owner
 *
 * E3.3 (#731) adds the family link's two:
 *
 *   ipd.family.issue    issue and revoke the attendant's family link (OTP to the registered phone), read and close the
 *                       family's callback requests — front office, its supervisor, the duty manager (the ward desk)
 *   ipd.condition.set   set the condition word the family sees and turn the family link off for a sensitive admission —
 *                       the doctor (nursing roles join when ipd-nursing seeds them). Clinical; no money.
 *
 * Who holds them is `scripts/seed-roles.ts` (README "IPD beds" and "IPD admission" prose). The 2-hour reservation lapse is a scheduler job (`kernel/worker/jobs.ts`
 * `lapseBedReservations`); the one subscription is E3.3's family-link stop, so the worker installs this manifest.
 */
export const IPD_BEDS_VIEW = "ipd.beds.view";
export const IPD_BEDS_MANAGE = "ipd.beds.manage";
export const IPD_BEDS_CLEAN = "ipd.beds.clean";
export const IPD_BEDS_OVERFLOW = "ipd.beds.overflow";
export const IPD_ADMIT_REQUEST = "ipd.admit.request";
export const IPD_ADMIT = "ipd.admit";
export const IPD_PAYER_MANAGE = "ipd.payer.manage";
export const IPD_BAND_PRINT = "ipd.band.print";
export const IPD_BILL_VIEW = "ipd.bill.view";
export const IPD_CHARGES_REVERSE = "ipd.charges.reverse";
export const IPD_PAYER_TERMS = "ipd.payer.terms";
export const IPD_TRANSFER_START = "ipd.transfer.start";
export const IPD_TRANSFER_ACCEPT = "ipd.transfer.accept";
export const IPD_DISCHARGE_VIEW = "ipd.discharge.view";
export const IPD_DISCHARGE_DECLARE = "ipd.discharge.declare";
export const IPD_DISCHARGE_CONFIRM = "ipd.discharge.confirm";
export const IPD_DISCHARGE_BILL = "ipd.discharge.bill";
export const IPD_GATE_PASS = "ipd.gate.pass";
export const IPD_GATE_SCAN = "ipd.gate.scan";
export const IPD_DISCHARGE_EXIT = "ipd.discharge.exit";
export const IPD_MORTUARY_MANAGE = "ipd.mortuary.manage";
export const IPD_BILLDESK_VIEW = "ipd.billdesk.view";
export const IPD_FAMILY_ISSUE = "ipd.family.issue";
export const IPD_CONDITION_SET = "ipd.condition.set";

export const ipdManifest: ModuleManifest = {
  key: "ipd",
  title: "Inpatients",
  menu: [
    { label: "Beds", path: "/ipd/beds", permission: IPD_BEDS_VIEW },
    { label: "Admit", path: "/ipd/admit", permission: IPD_ADMIT },
    // E3.1 (#729) — the receiving ward's "Waiting for you" handover list.
    { label: "Handovers", path: "/ipd/handovers", permission: IPD_TRANSFER_ACCEPT },
    // E3.2 (#730) — the discharge desk: every admission in the cascade, its steps, clocks and blockers.
    { label: "Discharge", path: "/ipd/discharge", permission: IPD_DISCHARGE_VIEW },
    // E2.3 (#727) — the bill desk.
    { label: "Bill desk", path: "/ipd/bill-desk", permission: IPD_BILLDESK_VIEW },
    // E3.3 (#731) — the ward desk's family callback requests.
    { label: "Family calls", path: "/ipd/family-callbacks", permission: IPD_FAMILY_ISSUE },
  ],
  permissions: [
    IPD_BEDS_VIEW, IPD_BEDS_MANAGE, IPD_BEDS_CLEAN, IPD_BEDS_OVERFLOW, IPD_ADMIT_REQUEST, IPD_ADMIT, IPD_PAYER_MANAGE, IPD_BAND_PRINT,
    IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS,
    // E3.1 (#729)
    IPD_TRANSFER_START, IPD_TRANSFER_ACCEPT,
    // E3.2 (#730)
    IPD_DISCHARGE_VIEW, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_BILL, IPD_GATE_PASS, IPD_GATE_SCAN,
    IPD_DISCHARGE_EXIT, IPD_MORTUARY_MANAGE,
    // E2.3 (#727)
    IPD_BILLDESK_VIEW,
    // E3.3 (#731)
    IPD_FAMILY_ISSUE, IPD_CONDITION_SET,
  ],
  // E3.3 (#731) — death and absconding revoke the family link (`familyStopConsumer`, registered in the worker's
  // `workerConsumers` in the same commit; its cursor is seeded at deploy by `seedCursors`).
  subscriptions: [
    { event: admissionDeceased.name, consumer: IPD_FAMILY_STOP_CONSUMER },
    { event: admissionAbsconded.name, consumer: IPD_FAMILY_STOP_CONSUMER },
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
  ],
};
