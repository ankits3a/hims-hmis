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

/**
 * FD-7 T6 — WHAT IS LEFT ON THE PATIENT'S PACKAGE, so the cashier can answer the question the
 * patient actually asks. A NARROW projection by construction: no card code, no plan id, no instance
 * id — a balance is not an identity, and the priced lines already name the benefit that won.
 */
export type WireBenefitBalance = {
  benefitKey: string;
  title: string;
  /** `'count'` — whole visits, read as "3 of 8" — or `'paise'`, read as money (R3). */
  unit: string;
  grantedQty: number;
  remainingQty: number;
};

export type WirePricedDraft = {
  tariffVersionId: string; intendedPayer: string;
  lines: WirePricedLine[]; totals: WireInvoiceTotals;
};

/** D8's fee branch. `free: true` IS the revisit branch — a null service, not a missing mapping. */
export type WireFeeQuote = {
  encounterId: string; visitType: string; free: boolean;
  feeServiceId: string | null; draft: WirePricedDraft | null;
  /**
   * RC-1 T5 / D8 shipped this on the server's `FeeQuote` and it never reached this type, so the
   * seat that is meant to print "review visit — free till <date> (<doctor>)" could not see the
   * reason at all. Added here by RC-2 T1 because this is the type RC-3 renders from; naming only,
   * exactly as the server says — a null never un-frees anything.
   */
  freeReason: { kind: "review_window"; doctorName: string | null; seenOn: string; windowEndsOn: string } | null;
  /**
   * FD-7 T9 / R4 — the slip the desk captured, on BOTH branches, so the cashier's field pre-fills
   * from it. Without this the quote would price with a stored code the screen could not see and the
   * cashier's blank field would then issue the invoice without it — the RC-2 disagreement, arriving
   * from the other direction.
   */
  attributionCode: string | null;
  /**
   * RC-2 T5 / D7 — corporate v0. `"self" | "tpa" | "pmjay" | "corporate"` as the server spells it.
   * On a non-self payer the seat shows "bill to panel — nothing to collect" AND no benefit chips,
   * because RC-2 T3 stops member, coupon and referral benefits at the self-pay share. This field is
   * the reason the chips are absent; without it their absence is unexplained.
   */
  intendedPayer: string;
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
  /**
   * RC-2 review MAJOR 8 — `couponCodes` and `attributionCode` are declared BELOW, and they have to
   * be here rather than only on the server. T2 widened `issueInvoiceBody` and `previewInvoiceBody`
   * so a presented coupon could reach the invoice, and recorded the asymmetry as closed — but this
   * type had no field to carry either, so a seat that quoted ₹450 through `fetchFeeQuote(id, codes)`
   * would still have issued at ₹500. That is RC-1 T1's class exactly (a field the client cannot
   * declare, so the money disagrees), one layer further out than T2 looked.
   */
  draftId: string;
  patientId: string;
  encounterId?: string;
  lines: WireInvoiceLineInput[];
  // RC-1 T1: `changeGivenPaise` is DECLARED so the type reaches the server's schema honestly — the
  // counter had been adding it via an object spread, which skips excess-property checking, while
  // the controller's zod silently stripped it.
  receipt?: { tenders: WireTender[]; panNumber?: string; form60?: boolean; note?: string; changeGivenPaise?: number };
  credit?: { reason: string; approvalId?: string };
  /** The coupon codes the clerk presented. Must match what the quote was asked with, or the money disagrees. */
  couponCodes?: string[];
  /** The partner slip's code, if one was presented. One per visit (V6). */
  attributionCode?: string;
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

/**
 * RC-2 T1 / D2 — the codes the clerk is holding travel WITH the question. Repeatable `?coupon=`,
 * because the server declares it that way; an empty list sends no parameter at all, so the shipped
 * caller's URL is byte-identical and no existing screen changes behaviour.
 */
export function fetchFeeQuote(
  encounterId: string,
  couponCodes: string[] = [],
  attributionCode?: string,
): Promise<WireFeeQuote> {
  // RC-2 review MAJOR 8 — the partner slip travels with the question too; there was no web plumbing
  // for `?referral=` at all, so the referral discount was server-only and unreachable from the seat.
  const query = [
    ...couponCodes.map((code) => `coupon=${encodeURIComponent(code)}`),
    ...(attributionCode === undefined || attributionCode === "" ? [] : [`referral=${encodeURIComponent(attributionCode)}`]),
  ].join("&");
  const path = `/billing/visits/${encodeURIComponent(encounterId)}/fee-quote`;
  return api("GET", query === "" ? path : `${path}?${query}`);
}

export function previewInvoice(body: {
  encounterId?: string; lines: WireInvoiceLineInput[];
  // Same terms the invoice is issued in, so a preview and the bill behind it cannot disagree.
  couponCodes?: string[]; attributionCode?: string;
}): Promise<WirePricedDraft & { balances: WireBenefitBalance[] }> {
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

/* ── FD-9 — the drawer, as a precondition the counter wears ──────────────────────────────────── */

/**
 * `GET /billing/sessions/current` — the caller's OWN open drawer, or null. Self-scoped by the route
 * rather than by an argument: there is no `userId` in the path, so one cashier cannot read another's
 * float (`billing.session.own`).
 *
 * Desk One's header pill renders this as a live PRECONDITION, not decoration: `POST /receipts`
 * refuses cash with no open session (`requireOpenSession`), so the tender keys at the bill stage
 * are disabled while this is null and the pill says why. A screen that offers CASH and then shows
 * a refusal has already wasted the patient's turn at the counter.
 */
export type WireCashSession = {
  id: string;
  cashierUserId: string;
  status: "open" | "closing" | "closed";
  openedAt: string;
  openingFloatPaise: number;
  countedCashPaise: number | null;
  expectedCashPaise: number | null;
  variancePaise: number | null;
  closedAt: string | null;
};

export function fetchCurrentSession(): Promise<{ session: WireCashSession | null }> {
  return api("GET", "/billing/sessions/current");
}

export function openCashSession(floatPaise: number): Promise<WireCashSession> {
  return api("POST", "/billing/sessions", { floatPaise });
}
