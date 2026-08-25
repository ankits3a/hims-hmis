import { api, ApiError } from "./api";
import type { SearchHit } from "@hmis/contracts";

/**
 * PLAN 09 T3 — THE RECOGNITION WIRE CONTRACT, transcribed from `membership.controller.ts` exactly
 * as `ops-api.ts` and `billing-api.ts` transcribe theirs: this file DESCRIBES the shape those
 * routes ship, it never re-derives or widens it.
 *
 * ═══ THERE IS NO MONEY TYPE IN THIS FILE, AND THAT IS E-32 ═══
 *
 * The counter's recognition surface shows what a card IS and what it GRANTS by name. It shows no
 * amount, no cap, no sale price and no commission, because no counter screen may show a sales
 * figure — and the cheapest way to keep that true is for the wire shape not to carry one. The
 * arithmetic happens once, on the invoice (T4), where it is audited.
 */

export type WireRecognisedMembership = {
  instanceId: string;
  planId: string;
  planTitle: string;
  cardCode: string;
  status: "active" | "expired" | "suspended" | "cancelled";
  /** `'import' | 'counter' | 'grace'` — O-1's grace-honoured card says so on the screen. */
  origin: string;
  verified: boolean;
  usable: boolean;
  validFrom: string;
  validTo: string;
  queuePerk: boolean;
  benefits: { benefitKey: string; title: string }[];
};

/** `unusableReason` is `couponUnusableReason`'s union — one SENTENCE per reason, never a boolean. */
export type WireRecognisedCoupon = {
  couponId: string;
  code: string;
  title: string;
  instanceId: string | null;
  unusableReason:
    | "retired" | "not_yet_valid" | "expired" | "off_weekday" | "outside_window" | "min_bill_not_met"
    | null;
};

export type WireRecognition = {
  patientId: string | null;
  memberships: WireRecognisedMembership[];
  coupons: WireRecognisedCoupon[];
  /**
   * E-32's disclosure, AS THE SERVER SENDS IT. The screen renders this string rather than a locale
   * key on purpose: the sentence a member is shown when the hospital honours a card is a decision
   * of the system, not of whichever client happens to be rendering it, and a screen must not be
   * able to quietly stop saying it.
   */
  disclosure: string;
};

export type WireInstrumentLookup = { hits: SearchHit[]; total: number; auditId: string };

export function lookupInstruments(q: string, limit = 10): Promise<WireInstrumentLookup> {
  return api("GET", `/membership/instruments/lookup?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function fetchRecognition(input: { patientId?: string; codes?: string[] }): Promise<WireRecognition> {
  const params = new URLSearchParams();
  if (input.patientId !== undefined && input.patientId !== "") params.set("patientId", input.patientId);
  if (input.codes !== undefined && input.codes.length > 0) params.set("codes", input.codes.join(","));
  return api("GET", `/membership/recognition?${params.toString()}`);
}

export type WireGraceHonorBody = {
  cardCode: string;
  patientId: string;
  planId: string;
  approvalId: string;
  reason: string;
};

export function graceHonor(body: WireGraceHonorBody): Promise<{ instanceId: string; cardCode: string; origin: string }> {
  return api("POST", "/membership/grace-honor", body);
}

// ────────────────────────────────── error helpers ──────────────────────────────────
//
// The `opsErrorMessage`/`opsErrorCode` precedent, transcribed as SEPARATE functions over the same
// `ApiError` shape rather than imported — `billing-api.ts` states the reason in its own comment: so
// that "align the three error conventions" can never become a one-line temptation. This module's
// `toHttp` sends `{statusCode, message, code, detail?}`; a 401/403 from the guards is Nest's own
// shape, for which `membershipErrorCode` correctly returns null.

export function membershipErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return String(e);
}

export function membershipErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | null;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return null;
}

/**
 * The seconds a `lookup_rate_limited` refusal says to wait, or null.
 *
 * It is read from the BODY's `detail`, not from the `Retry-After` header, because `api()` returns a
 * parsed body and never the response object — and because the header is there for the HTTP clients
 * that obey it automatically (proxies, retry libraries), which is a different audience from the
 * sentence a cashier reads.
 */
export function retryAfterSec(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  const detail = (e.body as { detail?: unknown } | null)?.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as { retryAfterSec?: unknown }).retryAfterSec;
  return typeof value === "number" ? value : null;
}
