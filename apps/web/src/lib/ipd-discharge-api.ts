import { api, newIdempotencyKey } from "./api";
import type {
  IpdDischargeBoard, IpdDischargeDepartment, IpdDischargeTracker, IpdFinalBill, IpdSummaryContent, IpdSummaryView,
} from "@hmis/contracts";

/**
 * E3.2 (#730) — the discharge desk's wire (spec §4.7, §4.9 F). Shapes are the contract's (`packages/contracts/src/ipd/
 * discharge.ts`, `intents-discharge.ts`); the paths are copied here because the web bundle imports the contract package
 * for TYPES only. Every act carries a fresh idempotency key in its body (§4.10 edge 9).
 */
const R = {
  board: "/ipd/discharge/board",
  declareFit: "/ipd/discharge/declare-fit",
  cancelFit: "/ipd/discharge/cancel-fit",
  confirm: "/ipd/discharge/confirm",
  saveSummary: "/ipd/discharge/summary",
  signSummary: "/ipd/discharge/summary/sign",
  prepareBill: "/ipd/discharge/bill/prepare",
  settle: "/ipd/discharge/bill/settle",
  askDues: "/ipd/discharge/bill/ask-dues",
  gatePass: "/ipd/discharge/gate-pass",
  scan: "/ipd/discharge/gate-pass/scan",
} as const;

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export type Tender = "cash" | "upi" | "card";
export type Settlement = "paid" | "refund_due" | "dues_recorded" | "insurer_pending_undertaking";

export const getDischargeBoard = (): Promise<IpdDischargeBoard> => api("GET", R.board);
export const getDischargeTracker = (admissionId: string): Promise<IpdDischargeTracker> =>
  api("GET", `/ipd/discharge/${encodeURIComponent(admissionId)}`);
export const getSummary = (admissionId: string): Promise<IpdSummaryView> =>
  api("GET", `/ipd/discharge/${encodeURIComponent(admissionId)}/summary`);

export const declareFit = (admissionId: string, disposition: "home" | "transfer_out", when: "today" | "tomorrow" = "today"): Promise<unknown> =>
  post(R.declareFit, { admissionId, disposition, when });
export const cancelFit = (admissionId: string, reason: string): Promise<unknown> => post(R.cancelFit, { admissionId, reason });
export const confirmDepartment = (admissionId: string, department: IpdDischargeDepartment): Promise<unknown> =>
  post(R.confirm, { admissionId, department });
export const saveSummary = (admissionId: string, expectedVersion: number, content: IpdSummaryContent): Promise<IpdSummaryView> =>
  post(R.saveSummary, { admissionId, expectedVersion, content });
export const signSummary = (admissionId: string, draftId: string, draftVersion: number): Promise<unknown> =>
  post(R.signSummary, { admissionId, draftId, draftVersion });

export const prepareFinalBill = (admissionId: string): Promise<IpdFinalBill> => api("POST", R.prepareBill, { admissionId });
/**
 * Review #762 item 12: the caller passes ONE idempotency key per settle attempt and re-sends it on a retry (a timeout
 * after the server settled must not take the money twice); a changed form is a new attempt with a new key.
 */
export const settleFinalBill = (idempotencyKey: string, b: {
  admissionId: string; billVersion: number; patientPayablePaise: number; settlement: Settlement;
  payments: { tender: Tender; amountPaise: number; ref?: string }[];
  duesApprovalId?: string; undertakingDocumentId?: string;
}): Promise<{ billNo: string }> => api("POST", R.settle, { idempotencyKey, ...b }, idempotencyKey);
export const askDuesApproval = (admissionId: string, amountPaise: number, note: string): Promise<{ approvalId: string }> =>
  api("POST", R.askDues, { admissionId, amountPaise, note });

export const issueGatePass = (admissionId: string, receivingHospital?: { name: string; confirmedBy: string }): Promise<{ code: string }> =>
  post(R.gatePass, { admissionId, ...(receivingHospital === undefined ? {} : { receivingHospital }) });
export const scanGatePass = (gatePassCode: string, gateId: string): Promise<{ admissionId: string; state: string }> =>
  post(R.scan, { gatePassCode, gateId, scannedAt: new Date().toISOString() });

/** The id a hand scan at the desk records as its gate (no gate registry yet — DECIDED, E3.2). A valid ULID. */
export const HAND_GATE_ID = "01K0000000000000000000GATE";

