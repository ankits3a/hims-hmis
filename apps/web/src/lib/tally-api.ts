import { api, apiDownload } from "./api";
import type { RangeInput } from "./reports-api";

/**
 * PHARMACY PARITY P5 — the Tally export's wire (`/pharmacy/office/tally/*`), transcribed from
 * `modules/pharmacy/tally.ts`. TallyPrime XML (owner ruling 2026-09-25): the vouchers file and the
 * ledgers (masters) file it needs, both downloaded from a RECORDED export so a file can be fetched
 * again exactly as it was written.
 */
export type TallyLedgers = {
  companyName: string;
  sales: string; salesReturns: string; outputCgst: string; outputSgst: string;
  purchases: string; purchaseReturns: string; inputCgst: string; inputSgst: string; inputIgst: string;
  cash: string; bank: string; roundOff: string; returnShortfall: string;
  patientParty: "patient" | "single"; patientLedger: string;
};
export const LEDGER_FIELDS = [
  "sales", "salesReturns", "outputCgst", "outputSgst", "purchases", "purchaseReturns", "inputCgst", "inputSgst", "inputIgst",
  "cash", "bank", "roundOff", "returnShortfall",
] as const;
export type WireTallyLedgerState = { ledgers: TallyLedgers; confirmed: boolean; updatedBy: string | null; updatedAt: string | null };

export type TallyVoucherKind =
  | "sale" | "sales_return" | "receipt" | "refund" | "purchase" | "purchase_return" | "supplier_payment" | "credit_shortfall" | "return_closed";
export const TALLY_KINDS: readonly TallyVoucherKind[] = [
  "sale", "sales_return", "receipt", "refund", "purchase", "purchase_return", "supplier_payment", "credit_shortfall", "return_closed",
];
export type WireTallyVoucher = {
  kind: TallyVoucherKind; type: string; remoteId: string; number: string; date: string; reference: string | null; party: string; narration: string;
  entries: { ledger: string; amountPaise: number; party: boolean }[];
};
export type WireTallyExport = {
  id: string; from: string; to: string; voucherCount: number; counts: Record<TallyVoucherKind, number>; debitPaise: number; checksum: string;
  exportedBy: string; exportedAt: string;
};
export type WireTallyPreview = {
  from: string; to: string; preset: string; confirmed: boolean; ledgers: TallyLedgers; voucherCount: number;
  counts: Record<TallyVoucherKind, number>; debitPaise: number; sample: WireTallyVoucher[]; earlier: WireTallyExport[];
};

const BASE = "/pharmacy/office/tally";
const rangeBody = (r: RangeInput): Record<string, string> => (r.preset === "custom" ? { preset: r.preset, from: r.from, to: r.to } : { preset: r.preset });
const rangeQuery = (r: RangeInput): string => `?${new URLSearchParams(rangeBody(r)).toString()}`;

export const fetchTallyLedgers = (): Promise<WireTallyLedgerState> => api("GET", `${BASE}/ledgers`);
export const saveTallyLedgers = (l: TallyLedgers): Promise<WireTallyLedgerState> => api("PUT", `${BASE}/ledgers`, l);
export const fetchTallyPreview = (r: RangeInput): Promise<WireTallyPreview> => api("GET", `${BASE}/preview${rangeQuery(r)}`);
export const exportTally = async (r: RangeInput): Promise<WireTallyExport> => (await api<{ export: WireTallyExport }>("POST", `${BASE}/exports`, rangeBody(r))).export;
export const fetchTallyExports = async (): Promise<WireTallyExport[]> => (await api<{ exports: WireTallyExport[] }>("GET", `${BASE}/exports`)).exports;
/** The recorded file, through the app's download path (`Content-Disposition` names it). */
export const downloadTallyFile = (e: WireTallyExport, file: "vouchers" | "masters"): Promise<void> =>
  apiDownload(`${BASE}/exports/${encodeURIComponent(e.id)}/${file}.xml`, `tally-pharmacy-${e.from}-to-${e.to}-${file}.xml`);
