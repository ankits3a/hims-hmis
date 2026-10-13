/**
 * The inpatient module's permission strings, in a file of their own (E3.3 review #764): `manifest.ts` declares them and
 * imports the desk cards' modules, and those modules check these strings — a constants file both can import breaks the
 * manifest ↔ module import cycle. The meaning of each string is documented in `manifest.ts`.
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
// E4.1 (#733) — nursing.
export const IPD_NURSING_VIEW = "ipd.nursing.view";
export const IPD_VITALS_RECORD = "ipd.vitals.record";
export const IPD_ASSESSMENT_RECORD = "ipd.assessment.record";
export const IPD_SHIFT_HANDOVER = "ipd.handover.shift";
export const IPD_EWS_RESPOND = "ipd.ews.respond";
