import { api } from "./api";

/**
 * PHARMACY PARITY P3 — the paying wire: supplier bills, payables and the supplier ledger, payment
 * runs (`/materials/supplier-bills/*`, `/materials/payables*`, `/materials/payment-runs/*`) and the
 * office's own pay reads (`/pharmacy/office/pay`, `/pharmacy/office/bill-draft/:grnId`). Transcribed
 * from `supplier-bills.ts`, `payments.ts` and `office.ts`; money is integer paise.
 */
export type BillStatus = "draft" | "matched" | "held_for_match" | "accepted" | "part_paid" | "paid" | "cancelled";
export type BillMismatch = "not_received" | "qty_over" | "qty_under" | "rate" | "gst_rate" | "value";

export type WireBillLineInput = { grnId: string; itemId: string; uom?: string | null; qtyPacks: number; ratePaise: number; gstRateBps: number };

export type WireBillDraft = {
  vendorId: string; vendorName: string; vendorGstin: string | null; msme: boolean; grnId: string; grnNo: string;
  purchaseOrderId: string | null; poNo: string | null; vendorBillNo: string; billDate: string; interState: boolean;
  lines: (WireBillLineInput & { itemCode: string; itemName: string; uom: string; multiplier: number; expectedBase: number })[];
  expectedTotalPaise: number;
};

export type WireBillSummary = {
  id: string; billNo: string; status: BillStatus; vendorId: string; vendorCode: string; vendorName: string; msme: boolean;
  vendorBillNo: string; billDate: string; fy: string; purchaseOrderId: string | null; interState: boolean;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number;
  expectedTotalPaise: number; paidPaise: number; outstandingPaise: number; heldReason: string | null;
  acceptanceDate: string | null; dueDate: string | null; differenceReason: string | null;
  createdBy: string; createdAt: string; acceptedBy: string | null; acceptedAt: string | null;
};

export type WireBillLine = {
  id: string; grnId: string; grnNo: string; itemId: string; itemCode: string; itemName: string; uom: string; multiplier: number;
  qtyPacks: number; ratePaise: number; taxablePaise: number; gstRateBps: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  totalPaise: number; expectedBase: number; expectedPacks: number; expectedRatePaise: number; expectedTaxablePaise: number;
  expectedGstRateBps: number; differencePaise: number; mismatch: BillMismatch[]; out: boolean;
};

export type WireBill = WireBillSummary & {
  note: string | null; poNo: string | null; cancelReason: string | null; differenceAcceptedBy: string | null;
  names: Record<string, string>; lines: WireBillLine[];
  unbilled: { grnId: string; grnNo: string; itemId: string; itemCode: string; itemName: string; expectedBase: number; expectedTaxablePaise: number }[];
  payments: { paymentId: string; paymentNo: string; runNo: string; mode: string; reference: string | null; paidOn: string; paidPaise: number }[];
};

export type AgeBucket = "0_30" | "31_60" | "61_90" | "90_plus";
export const AGE_BUCKETS: readonly AgeBucket[] = ["0_30", "31_60", "61_90", "90_plus"];

export type WirePayableRow = WireBillSummary & { ageDays: number; bucket: AgeBucket; overdueDays: number; reservedPaise: number };
export type WireSupplierSummaryRow = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean; phone: string | null; gstin: string | null;
  totalPaise: number; paidPaise: number; remainingPaise: number; overduePaise: number; buckets: Record<AgeBucket, number>;
};
export type WirePayables = {
  asOf: string; bills: WirePayableRow[]; suppliers: WireSupplierSummaryRow[]; buckets: Record<AgeBucket, number>;
  totalOutstandingPaise: number; overduePaise: number;
};

export type WireLedgerEntry = {
  date: string; kind: "bill" | "payment"; voucherNo: string; reference: string; creditPaise: number; debitPaise: number; balancePaise: number; id: string;
};
export type WireLedger = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean; from: string | null; to: string | null;
  openingPaise: number; entries: WireLedgerEntry[]; closingPaise: number; billedPaise: number; paidPaise: number;
};

export type RunStatus = "draft" | "pending_authorisation" | "authorised" | "completed" | "cancelled";
export type PaymentMode = "neft" | "rtgs" | "upi" | "cheque" | "cash";
export const PAYMENT_MODES: readonly PaymentMode[] = ["neft", "rtgs", "upi", "cheque", "cash"];

export type WireRunSummary = {
  id: string; runNo: string; status: RunStatus; source: "manual" | "agent"; totalPaise: number; vendorCount: number; billCount: number;
  approvalId: string | null; rejectionNote: string | null; createdBy: string; createdAt: string; submittedAt: string | null;
  authorisedBy: string | null; authorisedAt: string | null; completedAt: string | null;
};
export type WireRunLine = {
  id: string; billId: string; billNo: string; vendorBillNo: string; billDate: string; dueDate: string | null; msme: boolean;
  totalPaise: number; prevPaidPaise: number; creditPaise: number; payPaise: number; remainingPaise: number; overdueDays: number; paid: boolean;
};
export type WireRunVendor = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean; coolingOffUntil: string | null; payPaise: number;
  lines: WireRunLine[];
  payment: { paymentId: string; paymentNo: string; mode: PaymentMode; reference: string | null; paidOn: string; amountPaise: number; recordedBy: string } | null;
};
export type WireRun = WireRunSummary & {
  note: string | null; cancelReason: string | null; names: Record<string, string>; vendors: WireRunVendor[];
  approval: { status: string; approverRole: string; requesterId: string; decidedBy: string | null; decisionNote: string | null } | null;
};

export type WireUnbilledGrn = { grnId: string; grnNo: string; vendorId: string; vendorName: string; postedAt: string; invoiceNo: string | null; poNo: string | null };

export type WireOfficePay = {
  toMatch: WireUnbilledGrn[]; drafts: WireBillSummary[]; held: WireBillSummary[]; matched: WireBillSummary[];
  dueThisWeek: WirePayableRow[]; overdue: WirePayableRow[]; runs: WireRunSummary[];
  outstandingPaise: number; overduePaise: number;
  plan: { vendors: number; bills: number; totalPaise: number; blocked: number; until: string };
};

export const fetchOfficePay = (): Promise<WireOfficePay> => api("GET", "/pharmacy/office/pay");
export const fetchBillDraft = (grnId: string): Promise<WireBillDraft> => api("GET", `/pharmacy/office/bill-draft/${grnId}`);

export type WireBillInput = {
  vendorId: string; vendorBillNo: string; billDate: string; interState?: boolean; roundOffPaise?: number; note?: string | null; lines: WireBillLineInput[];
};
export const fetchBill = async (id: string): Promise<WireBill> => (await api<{ bill: WireBill }>("GET", `/materials/supplier-bills/${id}`)).bill;
export const createBill = async (input: WireBillInput): Promise<WireBill> => (await api<{ bill: WireBill }>("POST", "/materials/supplier-bills", input)).bill;
export const updateBill = async (id: string, patch: Partial<WireBillInput>): Promise<WireBill> =>
  (await api<{ bill: WireBill }>("PATCH", `/materials/supplier-bills/${id}`, patch)).bill;
export const matchBill = async (id: string): Promise<WireBill> => (await api<{ bill: WireBill }>("POST", `/materials/supplier-bills/${id}/match`)).bill;
export const acceptBill = async (id: string): Promise<WireBill> => (await api<{ bill: WireBill }>("POST", `/materials/supplier-bills/${id}/accept`)).bill;
export const acceptDifference = async (id: string, reason: string): Promise<WireBill> =>
  (await api<{ bill: WireBill }>("POST", `/materials/supplier-bills/${id}/accept-difference`, { reason })).bill;
export const cancelBill = async (id: string, reason: string): Promise<WireBill> =>
  (await api<{ bill: WireBill }>("POST", `/materials/supplier-bills/${id}/cancel`, { reason })).bill;

export const fetchPayables = (vendorId?: string): Promise<WirePayables> =>
  api("GET", `/materials/payables${vendorId === undefined ? "" : `?vendorId=${encodeURIComponent(vendorId)}`}`);
export function fetchLedger(vendorId: string, range: { from?: string; to?: string } = {}): Promise<WireLedger> {
  const p = new URLSearchParams();
  if (range.from !== undefined && range.from !== "") p.set("from", range.from);
  if (range.to !== undefined && range.to !== "") p.set("to", range.to);
  const qs = p.toString();
  return api("GET", `/materials/payables/ledger/${vendorId}${qs === "" ? "" : `?${qs}`}`);
}

export const fetchRun = async (id: string): Promise<WireRun> => (await api<{ run: WireRun }>("GET", `/materials/payment-runs/${id}`)).run;
export const draftRun = async (): Promise<WireRun> => (await api<{ run: WireRun }>("POST", "/materials/payment-runs/draft")).run;
export const updateRun = async (id: string, patch: { lines?: { billId: string; payPaise: number }[]; note?: string | null }): Promise<WireRun> =>
  (await api<{ run: WireRun }>("PATCH", `/materials/payment-runs/${id}`, patch)).run;
export const submitRun = async (id: string): Promise<WireRun> => (await api<{ run: WireRun }>("POST", `/materials/payment-runs/${id}/submit`)).run;
export const cancelRun = async (id: string, reason: string): Promise<WireRun> =>
  (await api<{ run: WireRun }>("POST", `/materials/payment-runs/${id}/cancel`, { reason })).run;
export const recordPayment = async (id: string, vendorId: string, input: { mode: PaymentMode; reference: string | null; paidOn: string | null }): Promise<WireRun> =>
  (await api<{ run: WireRun }>("POST", `/materials/payment-runs/${id}/vendors/${vendorId}/pay`, input)).run;

/** A CSV cell: quoted when it carries a comma, a quote or a line break. */
function cell(v: string | number): string {
  const s = String(v);
  const needsQuotes = s.includes('"') || s.includes(",") || s.includes("\n");
  return needsQuotes ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Rows to CSV text (rupees with two decimals are the caller's). */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Hands a CSV to the browser as a download. */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Rupees as a plain number for a CSV: `1234.50`. */
export const csvRupees = (paise: number): string => (paise / 100).toFixed(2);
