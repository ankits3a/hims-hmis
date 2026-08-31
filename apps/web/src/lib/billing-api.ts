import { api, ApiError } from "./api";

/**
 * The billing wire contract, shared by the four Plan 08 pipeline-C screens — the sibling of
 * `lib/opd-api.ts`, and the same convention: every `Date` column arrives JSON-serialized as an ISO
 * string, every IST calendar date as 'YYYY-MM-DD', and **every money value is INTEGER PAISE**
 * (Global Constraint, plan line 134). Nothing here validates; the server stays authoritative.
 *
 * TWO THINGS THE SERVER DELIBERATELY DOES NOT SEND, recorded here so no screen goes looking:
 *  · `GET /billing/receipts` returns `panCaptured: boolean`, never the Rule 114B `panNumber`
 *    (commit 30a272d). Render it as a compliance chip; there is no route that returns the number.
 *  · `GET /billing/receipts` and `GET /billing/refunds` carry `patientId` but NO patient name —
 *    unlike every other reader on this surface, which routes names through `getPatientSummaries`.
 *
 * NEITHER LIST ROUTE PAGINATES and `listDues` filters in memory. Known Phase-1 scale seams; do not
 * build paging the API cannot serve.
 */

// ——— money primitives ————————————————————————————————————————————————————————————————————————

export type TenderMode = "cash" | "upi" | "card";

/** THE tender shape, at the wire and in `TenderEditor`'s `onChange`. `amountPaise` is an integer. */
export type WireTender = { mode: TenderMode; amountPaise: number; refText?: string };

export type WireSettlement = { state: "unpaid" | "partial" | "settled"; outstandingPaise: number };

export type WireTaxSummaryRow = {
  sacCode: string; rateBps: number; exempt: boolean;
  taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
};

/** D3's `InvoiceTotals`: every field a fold over line heads; `roundingPaise` applied ONCE (§170). */
export type WireInvoiceTotals = {
  grossPaise: number; discountPaise: number; taxableBasePaise: number;
  cgstPaise: number; sgstPaise: number;
  taxableTurnoverPaise: number; exemptTurnoverPaise: number;
  taxSummary: WireTaxSummaryRow[];
  rawTotalPaise: number; netPayablePaise: number; roundingPaise: number;
};

// ——— pricing: what the preview and the fee quote return ——————————————————————————————————————

export type WireDiscountCategory = "charity" | "scheme" | "negotiated_corporate" | "employee";

/** The engine's contest record for one line — what the counter renders as "why this price". */
export type WireAdjustmentCandidate = {
  sourceKey: string; ruleKey: string | null; kind: "percent_bps" | "flat_paise";
  discountCategory: WireDiscountCategory | null;
  amountPaise: number; reason: string;
  requiresApproval: boolean; // Plan 08 enforces it against the approvals engine
  rejected: { code: "over_cap" | "unknown_category"; detail: string } | null;
};

export type WirePricedLine = {
  lineId: string; serviceId: string; serviceName: string; category: string;
  qty: number; unitPaise: number; grossPaise: number;
  regulatedClamp: unknown;
  candidates: WireAdjustmentCandidate[]; winner: WireAdjustmentCandidate | null;
  discountPaise: number; taxableBasePaise: number;
  gst: {
    sacCode: string; rateBps: number; exempt: boolean;
    exemptReason: string | null; cgstPaise: number; sgstPaise: number;
  };
  netPaise: number;
};

export type WirePricedDraft = {
  tariffVersionId: string; intendedPayer: string;
  lines: WirePricedLine[]; totals: WireInvoiceTotals;
};

/** D8's fee branch. `free: true` IS the revisit branch — a null service, not a missing mapping. */
export type WireFeeQuote = {
  encounterId: string; visitType: string; free: boolean;
  feeServiceId: string | null; draft: WirePricedDraft | null;
};

// ——— what the counter posts ——————————————————————————————————————————————————————————————————

export type WireManualDiscount = {
  discountCategory: WireDiscountCategory;
  kind: "percent_bps" | "flat_paise";
  value: number;
  reason: string;
};

export type WireInvoiceLineInput = {
  lineId: string; serviceId: string; qty: number;
  manualDiscount?: WireManualDiscount;
};

export type WireIssueInvoiceBody = {
  draftId: string;
  patientId: string;
  encounterId?: string;
  lines: WireInvoiceLineInput[];
  // RC-1 T1: `changeGivenPaise` is DECLARED so the type reaches the server's schema honestly — the
  // counter had been adding it via an object spread, which skips excess-property checking, while
  // the controller's zod silently stripped it.
  receipt?: { tenders: WireTender[]; panNumber?: string; form60?: boolean; note?: string; changeGivenPaise?: number };
  credit?: { reason: string; approvalId?: string };
  discountApprovals?: Record<string, string>;
};

export type WireIssueInvoiceResult = {
  invoiceId: string; invoiceNo: string;
  totals: WireInvoiceTotals;
  receiptId: string | null; receiptNo: string | null;
  allocatedPaise: number;
  unallocatedPaise: number; // the change-due / banked-advance lane (D2 step 5) — never an error
  creditExtended: boolean;
  settlement: WireSettlement;
  warnings: string[];
};

// ——— stored documents ————————————————————————————————————————————————————————————————————————

export type WireInvoice = {
  id: string; invoiceNo: string; patientId: string; encounterId: string | null;
  tariffVersionId: string; intendedPayer: string;
  buyerGstin: string | null; buyerLegalName: string | null;
  grossPaise: number; discountPaise: number; taxableBasePaise: number;
  cgstPaise: number; sgstPaise: number;
  rawTotalPaise: number; roundingPaise: number; netPayablePaise: number;
  creditExtended: boolean; creditReason: string | null; creditApprovalId: string | null;
  issuedBy: string; issuedAt: string; serviceDay: string; seq: number;
};

export type WireInvoiceLine = {
  id: string; invoiceId: string; lineNo: number;
  serviceId: string; serviceName: string; category: string;
  qty: number; unitPaise: number; grossPaise: number;
  regulatedClamp: unknown; candidates: unknown; winner: unknown;
  discountPaise: number; taxableBasePaise: number;
  sacCode: string; rateBps: number; exempt: boolean; exemptReason: string | null;
  cgstPaise: number; sgstPaise: number; netPaise: number;
};

/** The alias-safe patient summary every printed money document carries (confidential/VIP §14). */
export type WireBillingPatient = {
  requestedId: string; id: string; uhid: string;
  name: string | null; alias: string | null; restricted: boolean;
  administrativeGender: string; dob: string | null;
};

/** `GET /billing/invoices/:id/print` — letterhead, alias-safe patient, stored lines, signed QR. */
export type WireInvoicePrint = {
  letterhead: { name: string; addressLines: string[] };
  invoice: WireInvoice;
  lines: WireInvoiceLine[];
  patient: WireBillingPatient | null;
  settlement: WireSettlement;
  qrPayload: string;
};

/** One row of the dues worklist. `name` is null exactly when `restricted` — render `alias` then. */
export type WireDueRow = {
  invoiceId: string; invoiceNo: string; patientId: string;
  uhid: string; name: string | null; alias: string | null; restricted: boolean;
  serviceDay: string; issuedAt: string;
  netPayablePaise: number; outstandingPaise: number;
  creditExtended: boolean; seq: number;
};

/** The tariff catalogue row the counter's line editor searches (`GET /tariff/services`). */
export type WireService = {
  id: string; code: string; name: string; category: string;
  regulated: boolean; active: boolean;
};

// ——— errors ——————————————————————————————————————————————————————————————————————————————————

/**
 * The billing error body — the OPD-shaped `{ statusCode, message, code, detail? }`, owner-ratified
 * for this NEW module. The patients and tariff modules keep their `code: message` string bodies and
 * NEITHER convention is realigned to the other (an owner halt condition on this plan).
 */
export type WireBillingError = { statusCode: number; message: string; code: string; detail?: unknown };

/**
 * The displayable text of a failed billing call — `opdErrorMessage`'s mirror, deliberately a
 * SEPARATE function over the same body shape rather than an import, so that "align the two error
 * conventions" can never become a one-line temptation here.
 */
export function billingErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (Array.isArray(body?.message)) {
      return body.message
        .map((issue) =>
          typeof issue === "object" && issue !== null && "message" in issue
            ? String((issue as { message: unknown }).message)
            : String(issue),
        )
        .join("; ");
    }
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return String(e);
}

/** The machine `code` of a failed billing call, or null — the screens branch on this, never on status. */
export function billingErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | null;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return null;
}

/** The `detail` a refusal carries (asked-vs-cap, episode-vs-threshold), or null. */
export function billingErrorDetail(e: unknown): unknown {
  return e instanceof ApiError ? (e.body as { detail?: unknown } | null)?.detail ?? null : null;
}

// ——— fetchers ————————————————————————————————————————————————————————————————————————————————

export function fetchFeeQuote(encounterId: string): Promise<WireFeeQuote> {
  return api("GET", `/billing/visits/${encodeURIComponent(encounterId)}/fee-quote`);
}

export function previewInvoice(body: {
  encounterId?: string; lines: WireInvoiceLineInput[];
}): Promise<WirePricedDraft> {
  return api("POST", "/billing/invoices/preview", body);
}

export function issueInvoice(
  body: WireIssueInvoiceBody,
  idempotencyKey?: string,
): Promise<WireIssueInvoiceResult> {
  return api("POST", "/billing/invoices", body, idempotencyKey);
}

export function fetchInvoicePrint(invoiceId: string): Promise<WireInvoicePrint> {
  return api("GET", `/billing/invoices/${encodeURIComponent(invoiceId)}/print`);
}

export function listDues(patientId: string): Promise<{ items: WireDueRow[] }> {
  return api("GET", `/billing/patients/${encodeURIComponent(patientId)}/dues`);
}

export function listServices(): Promise<{ items: WireService[] }> {
  return api("GET", "/tariff/services");
}

/** The name a money document shows for a patient: the alias whenever the row is restricted. */
export function billingPatientLabel(
  p: { name: string | null; alias: string | null; restricted: boolean } | null | undefined,
): string {
  if (!p) return "—";
  return p.restricted ? (p.alias ?? "—") : (p.name ?? p.alias ?? "—");
}
