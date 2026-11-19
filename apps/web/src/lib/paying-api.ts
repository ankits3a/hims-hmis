import { api } from "./api";
import type {
  WireHoldsDryRun, WirePayBookDraft, WirePayBooked, WirePayHold, WirePayablesByGroup, WirePayingDesk, WirePayingSettings, WireRunToAuthorise,
  WireServiceEntry, WireServiceToConfirm, WireSesPeriodKind, WireSesSource,
} from "@hmis/contracts";

/**
 * STORES S6a (#1116) — the client of `modules/stores/paying.controller.ts` (`/stores/pay/*`): the paying desk, booking a
 * bill from a GRN or a service entry, holds (release, keep), runs (draft, submit, the owner's decision on the phone),
 * recording a payment with its UTR, the switches and their dry run, and the department's "Service to confirm".
 */
const enc = encodeURIComponent;

export type RunVendor = {
  vendorId: string; vendorName: string; msme: boolean; payPaise: number;
  payment: { paymentNo: string; mode: string; reference: string | null } | null;
};

export const payingDesk = (): Promise<WirePayingDesk> => api("GET", "/stores/pay/desk");
export const payablesByGroup = (): Promise<WirePayablesByGroup> => api("GET", "/stores/pay/by-group");
export const bookDraft = (kind: "grn" | "ses", id: string): Promise<WirePayBookDraft> => api("GET", `/stores/pay/book/${kind}/${enc(id)}`);
export const bookBill = (body: { kind: "grn" | "ses"; id: string; vendorBillNo: string; billDate: string; lines?: { itemId: string; qtyPacks: number; ratePaise: number }[] }): Promise<WirePayBooked> =>
  api("POST", "/stores/pay/book", body);
export const billHolds = (billId: string): Promise<WirePayHold[]> => api("GET", `/stores/pay/bills/${enc(billId)}/holds`);
export const releaseHold = (holdId: string, reason: string): Promise<WirePayHold> => api("POST", `/stores/pay/holds/${enc(holdId)}/release`, { reason });
export const keepHold = (holdId: string, reason: string, reviewOn: string): Promise<WirePayHold> => api("POST", `/stores/pay/holds/${enc(holdId)}/keep`, { reason, reviewOn });
export const draftRun = (): Promise<{ id: string; runNo: string }> => api("POST", "/stores/pay/runs/draft", {});
export const runToAuthorise = (runId: string): Promise<WireRunToAuthorise> => api("GET", `/stores/pay/runs/${enc(runId)}`);
export const submitRun = (runId: string): Promise<WireRunToAuthorise> => api("POST", `/stores/pay/runs/${enc(runId)}/submit`, {});
export const decideRun = (runId: string, approve: boolean, reason?: string): Promise<WireRunToAuthorise> =>
  api("POST", `/stores/pay/runs/${enc(runId)}/decide`, approve ? { approve } : { approve, reason });
export const runVendors = async (runId: string): Promise<RunVendor[]> =>
  ((await api("GET", `/materials/payment-runs/${enc(runId)}`)) as { vendors: RunVendor[] }).vendors;
export const recordPayment = (runId: string, body: { vendorId: string; mode: string; reference: string | null; paidOn?: string | null }): Promise<unknown> =>
  api("POST", `/stores/pay/runs/${enc(runId)}/pay`, body);
export const holdsDryRun = (): Promise<WireHoldsDryRun> => api("GET", "/stores/pay/settings/dry-run");
export const setPayingSettings = (holdsCoverPharmacy: boolean, dryRunAt: string): Promise<WirePayingSettings> =>
  api("POST", "/stores/pay/settings", { holdsCoverPharmacy, dryRunAt });
export const serviceDepartments = (): Promise<{ id: string; code: string; name: string }[]> => api("GET", "/stores/pay/services/departments");
export const servicesToConfirm = (departmentId: string): Promise<WireServiceToConfirm[]> => api("GET", `/stores/pay/services?departmentId=${enc(departmentId)}`);
export const confirmService = (body: {
  purchaseOrderId: string; departmentId: string; period: { kind: WireSesPeriodKind; key: string; start: string; end: string }; source: WireSesSource;
  lines?: { itemId: string; qtyBase: number; shortReason?: string | null }[];
}): Promise<WireServiceEntry> => api("POST", "/stores/pay/services", body);
