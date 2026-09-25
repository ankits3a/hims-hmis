import { api } from "./api";
import { printInFrame } from "./print-api";

/**
 * PHARMACY PARITY P5 — the office's Reports wire (`/pharmacy/office/reports/*`), transcribed from
 * `sales-register.ts`, `office-reports.ts` (materials' `reports.ts`), `gstr2b.ts` and `activity.ts`.
 * Money is integer paise; every date is an IST calendar day.
 */
export type ReportPreset = "today" | "week" | "month" | "fy" | "custom";
export const REPORT_PRESETS: readonly ReportPreset[] = ["today", "week", "month", "fy", "custom"];
export type RangeInput = { preset: ReportPreset; from: string; to: string; store: string };

export type SaleSource = "dispense" | "walk_in" | "downtime";
export type TenderLabel = "cash" | "upi" | "card" | "split" | "unpaid";
export const SALES_GROUPS = ["document", "item", "doctor", "patient", "operator", "tender"] as const;
export type SalesGroupBy = (typeof SALES_GROUPS)[number];
export const MARGIN_GROUPS = ["item", "category", "doctor"] as const;
export type MarginGroupBy = (typeof MARGIN_GROUPS)[number];

export type WireSalesLine = {
  itemId: string; itemCode: string; itemName: string; batchId: string; batchNo: string; expiryDate: string | null; qtyBase: number;
  hsn: string; rateBps: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number;
  costPaise: number | null; profitPaise: number | null;
};
export type WireSalesRow = {
  kind: "sale" | "refund"; id: string; docNo: string; invoiceId: string; invoiceNo: string; date: string; at: string; source: SaleSource;
  ref: string | null; storeCode: string | null; patientId: string; patientName: string; uhid: string; prescriber: string | null;
  operatorName: string; tender: TenderLabel | null; grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number;
  sgstPaise: number; roundingPaise: number; netPaise: number; outstandingPaise: number | null; costPaise: number | null;
  profitPaise: number | null; marginBps: number | null; lines: WireSalesLine[];
};
export type WireSalesGroup = {
  key: string; label: string; sub: string | null; sales: number; refunds: number; qtyBase: number | null; taxablePaise: number;
  cgstPaise: number; sgstPaise: number; discountPaise: number; returnsPaise: number; netPaise: number; profitPaise: number | null;
};
type Side = { count: number; grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number };
export type WireSalesRegister = {
  from: string; to: string; preset: string; groupBy: SalesGroupBy; storeCode: string | null; margin: boolean;
  rows: WireSalesRow[]; groups: WireSalesGroup[];
  totals: {
    sales: Side; refunds: Side; net: { taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number };
    costPaise: number | null; profitPaise: number | null; marginBps: number | null;
  };
};

export type WireMarginRow = { key: string; label: string; sub: string | null; qtyBase: number | null; revenuePaise: number; costPaise: number; marginPaise: number; marginBps: number | null };
export type WireMarginReport = {
  from: string; to: string; preset: string; groupBy: MarginGroupBy; storeCode: string | null; rows: WireMarginRow[];
  totals: { revenuePaise: number; costPaise: number; marginPaise: number; marginBps: number | null };
};

export type WireHsnRow = {
  hsn: string; rateBps: number; exempt: boolean; uqc: string; qty: number; taxablePaise: number; cgstPaise: number; sgstPaise: number;
  igstPaise: number; taxPaise: number; valuePaise: number;
};
export type WireHsnReport = {
  from: string; to: string; preset: string; storeCode: string | null; rows: WireHsnRow[];
  totals: { qty: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number; valuePaise: number };
};

export type WirePurchaseLine = {
  itemId: string; itemCode: string; itemName: string; hsnCode: string | null; batchNo: string | null; qty: number; uom: string;
  ratePaise: number; taxablePaise: number; gstRateBps: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
};
export type WirePurchaseRow = {
  kind: "bill" | "debit_note" | "credit_note"; id: string; docNo: string; vendorDocNo: string | null; ref: string | null; date: string;
  vendorId: string; vendorCode: string; vendorName: string; gstin: string | null; interState: boolean; taxablePaise: number;
  cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number; paidPaise: number | null;
  duePaise: number | null; status: string; lines: WirePurchaseLine[];
};
type PMoney = { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number };
export type WirePurchaseRegister = {
  from: string; to: string; preset: string; rows: WirePurchaseRow[];
  totals: { bills: PMoney & { paidPaise: number; duePaise: number }; debitNotes: PMoney; creditNotes: PMoney; net: Omit<PMoney, "count"> };
};

export type WireValuationRow = {
  storeResourceId: string; storeCode: string; storeName: string; itemId: string; itemCode: string; itemName: string; baseUom: string;
  hsnCode: string | null; batchId: string; batchNo: string; expiryDate: string | null; ownership: string; qtyBase: number;
  landedCostPaise: number; costValuePaise: number; mrpPerBasePaise: number | null; mrpValuePaise: number | null;
};
export type WireValuationGroup = { key: string; code: string; name: string; batches: number; qtyBase: number | null; costValuePaise: number; mrpValuePaise: number; baseUom?: string };
export type WireValuation = {
  asOf: string; rows: WireValuationRow[]; byStore: WireValuationGroup[]; byItem: WireValuationGroup[];
  totals: { batches: number; costValuePaise: number; mrpValuePaise: number; noMrpBatches: number };
  vendorOwned: { batches: number; qtyBase: number }; truncated: boolean;
};

export const NON_MOVING_DAYS = [30, 60, 90, 180] as const;
export type NonMovingSuggestion = "return" | "write_off" | "watch";
export type WireNonMovingRow = {
  storeResourceId: string; storeCode: string; storeName: string; itemId: string; itemCode: string; itemName: string; baseUom: string;
  batchId: string; batchNo: string; expiryDate: string | null; ownership: string; recalled: boolean; qtyBase: number; landedCostPaise: number;
  costValuePaise: number; lastMovedAt: string | null; idleDays: number | null; vendorId: string | null; supplierName: string;
  supplierKind: string; suggestion: NonMovingSuggestion; returnableUntil: string | null;
};
export type WireNonMoving = {
  asOf: string; days: number; since: string; rows: WireNonMovingRow[];
  totals: { batches: number; items: number; costValuePaise: number; returnValuePaise: number; writeOffValuePaise: number }; truncated: boolean;
};

export type ReconBucket = "matched" | "mismatch" | "only_2b" | "only_books";
export const RECON_BUCKETS: readonly ReconBucket[] = ["mismatch", "only_2b", "only_books", "matched"];
export type WireReconRow = {
  bucket: ReconBucket; gstin: string; supplier: string; invoiceNo: string;
  twoB: { date: string; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; valuePaise: number } | null;
  books: { billId: string; billNo: string; date: string; status: string; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number } | null;
  diffs: { field: "date" | "taxable" | "igst" | "cgst" | "sgst"; twoB: string | number; books: string | number }[];
};
type Heads = { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number };
export type WireGstr2b = {
  from: string; to: string; preset: string; period: string | null; gstin: string | null; counts: Record<ReconBucket, number>;
  rows: WireReconRow[]; totals: { twoB: Heads; books: Heads };
  notes: { count: number; valuePaise: number; rows: { gstin: string; tradeName: string; invoiceNo: string; date: string; valuePaise: number; noteType: string }[] };
};

export type WireActivityChange = { field: string; label: string; before: string | number | boolean | null; after: string | number | boolean | null };
export type WireActivityEntry = {
  at: string; name: string; actorId: string; actorName: string; status: string | null; changes: WireActivityChange[];
  facts: Record<string, string | number | boolean | null>;
};
export type WireActivity = { kind: string; id: string; no: string; label: string; entries: WireActivityEntry[] };
export type WireActivityFeed = { from: string; to: string; rows: { at: string; name: string; actorName: string; docNo: string | null; amountPaise: number | null }[] };

function query(r: Partial<RangeInput> & Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined || v === "") continue;
    if ((k === "from" || k === "to") && r.preset !== "custom") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s === "" ? "" : `?${s}`;
}

const BASE = "/pharmacy/office/reports";
export const fetchReportStores = async (): Promise<{ code: string; name: string }[]> => (await api<{ stores: { code: string; name: string }[] }>("GET", `${BASE}/stores`)).stores;
export const fetchSalesRegister = (r: RangeInput, groupBy: SalesGroupBy): Promise<WireSalesRegister> => api("GET", `${BASE}/sales${query({ ...r, groupBy })}`);
export const fetchMargin = (r: RangeInput, groupBy: MarginGroupBy): Promise<WireMarginReport> => api("GET", `${BASE}/margin${query({ ...r, groupBy })}`);
export const fetchHsn = (r: RangeInput): Promise<WireHsnReport> => api("GET", `${BASE}/hsn${query(r)}`);
export const fetchPurchaseRegister = (r: RangeInput): Promise<WirePurchaseRegister> => api("GET", `${BASE}/purchases${query(r)}`);
export const fetchValuation = (asOf: string, store: string): Promise<WireValuation> => api("GET", `${BASE}/valuation${query({ asOf, store })}`);
export const fetchNonMoving = (days: number, store: string): Promise<WireNonMoving> => api("GET", `${BASE}/non-moving${query({ days, store })}`);
export const reconcileGstr2b = (input: { format: "json" | "csv"; content: string; preset: ReportPreset; from: string; to: string }): Promise<WireGstr2b> =>
  api("POST", `${BASE}/gstr2b`, input.preset === "custom" ? input : { format: input.format, content: input.content, preset: input.preset });
export const fetchActivityFeed = (r: RangeInput): Promise<WireActivityFeed> => api("GET", `${BASE}/activity${query(r)}`);
export const fetchActivity = (no: string): Promise<WireActivity> => api("GET", `${BASE}/activity/document${query({ no })}`);

/**
 * The portal's GSTR-2B JSON carries e-invoice reference numbers, dates and flags the match never
 * reads; they are dropped before the upload so a month's file stays well inside the API's 1 MB body.
 */
const DROP_2B = new Set(["irn", "irngendate", "srctyp", "itcavl", "rsn", "diffprcnt", "rev", "pos", "supfildt", "supprd", "chksum", "cess", "num"]);
export function trimGstr2bJson(text: string): string {
  return JSON.stringify(JSON.parse(text) as unknown, (k, v: unknown) => (DROP_2B.has(k) ? undefined : v));
}

/** Integer paise as rupees for a cell: `1,234.50`. */
export const money = (paise: number | null | undefined): string =>
  paise === null || paise === undefined ? "—" : (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Basis points as a percentage: `23.5%`. */
export const pct = (bps: number | null | undefined): string => (bps === null || bps === undefined ? "—" : `${(bps / 100).toFixed(1)}%`);
export const todayIst = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A report as A4 for the browser to print or save as PDF (the PO's path): a heading, the table, the totals. */
export function printReport(title: string, subtitle: string, header: readonly string[], rows: readonly (readonly string[])[], totals: readonly string[] | null, numeric: readonly boolean[]): boolean {
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const cell = (text: string, i: number, tag: "td" | "th"): string => `<${tag}${numeric[i] === true ? ' class="n"' : ""}>${esc(text)}</${tag}>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page{size:210mm 297mm;margin:12mm}body{font-family:"Segoe UI",Arial,"Nirmala UI",sans-serif;font-size:10px;color:#111;margin:0}
h1{font-size:15px;margin:0 0 2px}.sub{color:#444;margin-bottom:8px}table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid #ccc;padding:3px 4px;text-align:left;vertical-align:top}th{background:#f2f2f2;-webkit-print-color-adjust:exact}
.n{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:700;border-top:2px solid #111}
</style></head><body><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div><table>
<thead><tr>${header.map((h, i) => cell(h, i, "th")).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c, i) => cell(c, i, "td")).join("")}</tr>`).join("")}</tbody>
${totals === null ? "" : `<tfoot><tr>${totals.map((c, i) => cell(c, i, "td")).join("")}</tr></tfoot>`}</table></body></html>`;
  return printInFrame({ html, title, page: { widthMm: 210, heightMm: 297 } });
}
