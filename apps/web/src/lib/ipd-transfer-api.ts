import { api, newIdempotencyKey } from "./api";
import type { IpdBedClass, IpdHandoverList, IpdTransferOptions } from "@hmis/contracts";

/**
 * E3.1 (#729) — the transfer surfaces' wire (spec §4.4). Shapes are the contract's (`packages/contracts/src/ipd/
 * transfers.ts`, `intents-ward.ts`); the paths are copied here because the web bundle imports the contract package
 * for TYPES only. Every act carries a fresh idempotency key in its body (§4.10 edge 9).
 */
const R = {
  handovers: "/ipd/transfers/handovers",
  options: "/ipd/transfers/options",
  start: "/ipd/transfers/start",
  accept: "/ipd/transfers/accept",
  cancel: "/ipd/transfers/cancel",
  swap: "/ipd/transfers/swap",
  changeClass: "/ipd/transfers/change-class",
} as const;

export const TRANSFER_REASONS = [
  "clinical_step_up", "clinical_step_down", "post_op", "isolation", "gender_fix", "patient_request", "bed_management",
] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];
export const SWAP_REASONS = ["gender_fix", "isolation_fix", "clinical", "patient_request"] as const;
export type SwapReason = (typeof SWAP_REASONS)[number];
export const CANCEL_REASONS = ["patient_deteriorated", "receiving_ward_declined", "bed_unsuitable", "plan_changed", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type Sbar = { situation: string; background: string; assessment: string; recommendation: string };
export type ClassConsent = {
  signedBy: "patient" | "guardian" | "representative";
  method?: "paper" | "tablet_signature";
  documentId?: string;
  signerName?: string;
  relation?: string;
  witnessName?: string;
  representativeReason?: string;
};

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export const getHandovers = (wardId?: string): Promise<IpdHandoverList> =>
  api("GET", wardId === undefined ? R.handovers : `${R.handovers}?wardId=${encodeURIComponent(wardId)}`);
export const getTransferOptions = (admissionId: string): Promise<IpdTransferOptions> =>
  api("GET", `${R.options}?admissionId=${encodeURIComponent(admissionId)}`);

export const startTransfer = (b: { admissionId: string; toBedId: string; reason: TransferReason; handover: Sbar }): Promise<{ transferId: string; escalatesAt: string }> =>
  post(R.start, b);
export const acceptHandover = (transferId: string): Promise<{ bedId: string }> => post(R.accept, { transferId });
export const cancelTransfer = (transferId: string, reason: CancelReason, note?: string): Promise<unknown> =>
  post(R.cancel, { transferId, reason, ...(note ? { note } : {}) });
export const swapBeds = (admissionIdA: string, admissionIdB: string, reason: SwapReason): Promise<unknown> =>
  post(R.swap, { admissionIdA, admissionIdB, reason });
export const changeClass = (b: { admissionId: string; toClass: IpdBedClass; consent: ClassConsent; roomRentCapAcknowledged: boolean }): Promise<{ effectiveFrom: string }> =>
  post(R.changeClass, b);
