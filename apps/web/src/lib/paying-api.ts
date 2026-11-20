import { api } from "./api";
import type {
  WireGstCredit, WireMsmeDryRun, WireTdsDryRun, WireHoldsDryRun, WirePayBookDraft, WirePayBooked, WirePayHold, WirePayablesByGroup, WirePayingDesk, WirePayingSettings, WireRunToAuthorise,
  WireServiceEntry, WireServiceToConfirm, WireSesPeriodKind, WireSesSource, WireAuditFlag, WireGstCreditRule, WireMsmeDuesReport, WireServiceEntryRow,
  WireStoresTallyLedgers, WireTaxTable, WireTaxTables, WireTdsRule,
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
export const bookBill = (body: {
  kind: "grn" | "ses"; id: string; vendorBillNo: string; billDate: string; irn?: string | null;
  lines?: { itemId: string; qtyPacks: number; ratePaise: number; gstCredit?: WireGstCredit | null; reverseCharge?: boolean | null }[];
}): Promise<WirePayBooked> => api("POST", "/stores/pay/book", body);
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
/** S6b (#1116): each switch alone (unchanged when absent), with the dry run it followed. */
export const setPayingSwitch = (body: { holdsCoverPharmacy?: boolean; msmeRule?: "as_today" | "act"; tdsGoods?: boolean; dryRunAt: string }): Promise<WirePayingSettings> =>
  api("POST", "/stores/pay/settings", body);
export const setPayingSettings = (holdsCoverPharmacy: boolean, dryRunAt: string): Promise<WirePayingSettings> => setPayingSwitch({ holdsCoverPharmacy, dryRunAt });
export const msmeDryRun = (): Promise<WireMsmeDryRun> => api("GET", "/stores/pay/settings/msme-dry-run");
export const tdsDryRun = (): Promise<WireTdsDryRun> => api("GET", "/stores/pay/settings/tds-dry-run");
export const serviceDepartments = (): Promise<{ id: string; code: string; name: string }[]> => api("GET", "/stores/pay/services/departments");
export const servicesToConfirm = (departmentId: string): Promise<WireServiceToConfirm[]> => api("GET", `/stores/pay/services?departmentId=${enc(departmentId)}`);
export const confirmService = (body: {
  purchaseOrderId: string; departmentId: string; period: { kind: WireSesPeriodKind; key: string; start: string; end: string }; source: WireSesSource;
  lines?: { itemId: string; qtyBase: number; shortReason?: string | null }[];
}): Promise<WireServiceEntry> => api("POST", "/stores/pay/services", body);

/* ═══ STORES S6c (#1116) — the desk's tax screens (the CA's tables, certificates, Tally ledger names, MSME objections), the
 * half-yearly MSME dues report, the auditor's flags and their review, a department's sheets and the reversing entry. ═══ */
export type TdsCertificate = { id: string; vendorId: string; vendorName: string; number: string; rateBps: number; validFrom: string; validTo: string; documentRef: string; by: { id: string; name: string }; at: string };
export type MsmeObjection = {
  id: string; kind: "qc_rejection" | "short"; vendorName: string; doc: { type: "grn" | "ses"; id: string; no: string }; raisedOn: string; reason: string;
  closed: { on: string; note: string } | null;
};
export const taxTables = (): Promise<WireTaxTables> => api("GET", "/stores/pay/tax-tables");
export const saveTaxTable = (body: { kind: "tds"; rules: WireTdsRule[]; documentRef: string } | { kind: "gst_credit"; rules: WireGstCreditRule[]; documentRef: string }): Promise<WireTaxTable> =>
  api("POST", "/stores/pay/tax-tables", body);
export const signTaxTable = (tableId: string, documentRef: string): Promise<WireTaxTable> => api("POST", `/stores/pay/tax-tables/${enc(tableId)}/sign`, { documentRef });
export const tdsCertificates = (): Promise<TdsCertificate[]> => api("GET", "/stores/pay/tds-certificates");
export const addTdsCertificate = (body: { vendorId: string; number: string; rateBps: number; validFrom: string; validTo: string; documentRef: string }): Promise<{ id: string }> =>
  api("POST", "/stores/pay/tds-certificates", body);
export const tallyLedgers = (): Promise<WireStoresTallyLedgers> => api("GET", "/stores/pay/tally-ledgers");
export const setTallyLedgers = (names: Record<string, string>): Promise<WireStoresTallyLedgers> => api("POST", "/stores/pay/tally-ledgers", { names });
export const msmeObjections = (): Promise<MsmeObjection[]> => api("GET", "/stores/pay/msme-objections");
export const addMsmeObjection = (body: { grnId?: string | null; sesId?: string | null; kind: "qc_rejection" | "short"; raisedOn: string; reason: string }): Promise<{ id: string }> =>
  api("POST", "/stores/pay/msme-objections", body);
export const closeMsmeObjection = (id: string, closedOn: string, note: string): Promise<{ id: string }> => api("POST", `/stores/pay/msme-objections/${enc(id)}/close`, { closedOn, note });
export const msmeReport = (half?: string): Promise<WireMsmeDuesReport> => api("GET", `/stores/pay/msme-report${half === undefined ? "" : `?half=${enc(half)}`}`);
export const auditFlags = (status?: "open" | "upheld" | "dismissed"): Promise<WireAuditFlag[]> => api("GET", `/stores/pay/flags${status === undefined ? "" : `?status=${status}`}`);
export const ownerMonthFlags = (month: string): Promise<WireAuditFlag[]> => api("GET", `/stores/pay/flags/owner-month?month=${enc(month)}`);
export const reviewFlag = (flagId: string, verdict: "upheld" | "dismissed", note: string): Promise<WireAuditFlag> => api("POST", `/stores/pay/flags/${enc(flagId)}/review`, { verdict, note });
export const serviceSheets = (departmentId: string): Promise<WireServiceEntryRow[]> => api("GET", `/stores/pay/services/sheets?departmentId=${enc(departmentId)}`);
export const reverseService = (sesId: string, reason: string): Promise<WireServiceEntry> => api("POST", `/stores/pay/services/${enc(sesId)}/reverse`, { reason });
export const payingSuppliers = (): Promise<{ id: string; code: string; name: string }[]> => api("GET", "/stores/pay/suppliers");
