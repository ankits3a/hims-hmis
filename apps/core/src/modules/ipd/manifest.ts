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

export const ipdManifest: ModuleManifest = {
  key: "ipd",
  title: "Inpatients",
  menu: [
    { label: "Beds", path: "/ipd/beds", permission: IPD_BEDS_VIEW },
    { label: "Admit", path: "/ipd/admit", permission: IPD_ADMIT },
  ],
  permissions: [
    IPD_BEDS_VIEW, IPD_BEDS_MANAGE, IPD_BEDS_CLEAN, IPD_BEDS_OVERFLOW, IPD_ADMIT_REQUEST, IPD_ADMIT, IPD_PAYER_MANAGE, IPD_BAND_PRINT,
  ],
  subscriptions: [],
};
