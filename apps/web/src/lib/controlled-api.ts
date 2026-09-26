import { api } from "./api";
import type { WireRenderedDocument } from "./print-api";

/**
 * PHARMACY P6 — the office's Controlled side: the cabinet of NDPS narcotic / psychotropic and Schedule X
 * drugs, its licences, its trained prescribers, the day's balance check, the acts made under two keys, the
 * registers and the balance (`apps/core/src/modules/pharmacy/pharmacy-controlled.controller.ts`).
 */
export type LicenceKind = "ndps_rmi" | "schedule_x";
export type WireControlledLicence = {
  id: string; kind: LicenceKind; licenceNo: string; form: string; issuingAuthority: string; holderName: string; responsiblePerson: string;
  validFrom: string; validUntil: string; documentRef: string | null; note: string | null; recordedBy: string; recordedAt: string;
};
export type WireLicenceState = {
  kind: LicenceKind; name: string; state: "missing" | "not_yet_valid" | "lapsed" | "current"; licence: WireControlledLicence | null;
  daysLeft: number | null; renewalDue: boolean;
};
export type WireControlledToday = {
  storePresent: boolean; storeId: string | null;
  licences: Record<LicenceKind, WireLicenceState>;
  checkedToday: { countId: string; checkedAt: string; balanced: boolean } | null;
  discrepancies: { countId: string; checkedAt: string }[];
  custodianPairHeld: boolean;
  pending: {
    grns: { id: string; grnNo: string; challanNo: string; status: string }[];
    transfers: { id: string; fromResourceId: string; issuedAt: string }[];
    writeOffs: { id: string; writeOffNo: string; approvalStatus: string }[];
    adjustments: { approvalId: string; countId: string; lines: number; netQty: number }[];
  };
  needsYou: { key: string; params: Record<string, string | number> }[];
};
export type WirePrescribers = {
  current: { id: string; doctorId: string; doctorName: string; registrationNo: string | null; training: string; recordedAt: string }[];
  doctors: { id: string; name: string; registrationNo: string | null }[];
};
export type WireSheetLine = { batchId: string; itemId: string; drugName: string; batchNo: string; expiryDate: string | null; unit: string; onHand: number; reserved: number };
export type WireCheckResult = {
  countId: string; balanced: boolean; approvalId: string | null;
  lines: { batchId: string; drugName: string; batchNo: string; expected: number; counted: number; variance: number }[];
};
export type WireBalanceRow = {
  itemId: string; drugName: string; unit: string; batchId: string; batchNo: string; expiryDate: string | null; ndpsClass: string | null; scheduleFlag: string | null;
  opening: number; received: number; issued: number; destroyed: number; adjusted: number; closing: number; ledgerClosing: number;
  registerRows: number; ledgerRows: number; reconciled: boolean;
};
export type WireBalance = { storeResourceId: string; fromDay: string; toDay: string; rows: WireBalanceRow[]; reconciled: boolean };
export type Witness = { username: string; pin: string };
export type WitnessedAct =
  | { act: "grn_post"; grnId: string }
  | { act: "transfer_receive"; transferId: string; lines: { lineId: string; qtyReceived: number }[] }
  | { act: "return_dispatch"; returnId: string; controllerApprovalRef?: string }
  | { act: "write_off_post"; writeOffId: string; disposal?: { disposalAgency?: string; manifestNo?: string; disposalDate?: string }; officer?: { name: string; designation: string; orderRef: string } }
  | { act: "adjustment_post"; approvalId: string };

export const fetchControlledToday = (): Promise<WireControlledToday> => api("GET", "/pharmacy/controlled/today");
export const fetchControlledLicences = (): Promise<{ items: WireControlledLicence[] }> => api("GET", "/pharmacy/controlled/licences");
export const recordControlledLicence = (body: Omit<WireControlledLicence, "id" | "recordedBy" | "recordedAt" | "documentRef" | "note"> & { documentRef?: string; note?: string }): Promise<WireControlledLicence> =>
  api("POST", "/pharmacy/controlled/licences", body);
export const fetchPrescribers = (): Promise<WirePrescribers> => api("GET", "/pharmacy/controlled/prescribers");
export const recordPrescriber = (doctorId: string, training: string): Promise<{ id: string }> => api("POST", "/pharmacy/controlled/prescribers", { doctorId, training });
export const endPrescriber = (id: string, reason: string): Promise<{ ok: true }> => api("POST", `/pharmacy/controlled/prescribers/${id}/end`, { reason });
export const fetchCheckSheet = (): Promise<{ lines: WireSheetLine[] }> => api("GET", "/pharmacy/controlled/check");
export const recordCheck = (witness: Witness, lines: { batchId: string; countedQty: number }[], note?: string): Promise<WireCheckResult> =>
  api("POST", "/pharmacy/controlled/checks", { witness, lines, ...(note === undefined || note.trim() === "" ? {} : { note: note.trim() }) });
export const postWitnessedAct = (witness: Witness, act: WitnessedAct): Promise<{ act: string; refId: string }> => api("POST", "/pharmacy/controlled/acts", { witness, ...act });
export const fetchRegisterDocument = (kind: "form3h" | "schedule_x" | "form3e", from: string, to: string): Promise<WireRenderedDocument> =>
  api("GET", `/pharmacy/controlled/register/document?kind=${kind}&from=${from}&to=${to}`);
export const fetchBalance = (from: string, to: string): Promise<WireBalance> => api("GET", `/pharmacy/controlled/balance?from=${from}&to=${to}`);
