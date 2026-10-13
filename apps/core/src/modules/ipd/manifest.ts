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
 * Who holds them is `scripts/seed-roles.ts` (README "IPD beds" and "IPD admission" prose). No subscriptions: the 2-hour reservation
 * lapse is a scheduler job (`kernel/worker/jobs.ts` `lapseBedReservations`), so the worker does not install this
 * manifest.
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

export const ipdManifest: ModuleManifest = {
  key: "ipd",
  title: "Inpatients",
  menu: [
    { label: "Beds", path: "/ipd/beds", permission: IPD_BEDS_VIEW },
    { label: "Admit", path: "/ipd/admit", permission: IPD_ADMIT },
    // E3.1 (#729) — the receiving ward's "Waiting for you" handover list.
    { label: "Handovers", path: "/ipd/handovers", permission: IPD_TRANSFER_ACCEPT },
  ],
  permissions: [
    IPD_BEDS_VIEW, IPD_BEDS_MANAGE, IPD_BEDS_CLEAN, IPD_BEDS_OVERFLOW, IPD_ADMIT_REQUEST, IPD_ADMIT, IPD_PAYER_MANAGE, IPD_BAND_PRINT,
    IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS,
    // E3.1 (#729)
    IPD_TRANSFER_START, IPD_TRANSFER_ACCEPT,
  ],
  subscriptions: [],
};
