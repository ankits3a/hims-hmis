import { api, ApiError } from "./api";

/**
 * PLAN 16a T7 — the formulary wire contract, transcribed from `formulary.controller.ts` exactly as
 * `membership-api.ts` and `ops-api.ts` transcribe theirs: this file DESCRIBES what those routes
 * ship and never re-derives or widens it.
 *
 * ═══ EVERY PAYLOAD HERE IS UNTRUSTED CONTENT ═══
 *
 * `WireStagingRow.payload` is scraped from a third-party site. The reviewer who reads it is a
 * PRIVILEGED user — a pharmacist with `formulary.staging.review` — which makes the staging screen
 * the highest-value XSS target in the application: a payload that executed would run with a
 * curator's session. It is typed `Record<string, unknown>` rather than anything structured on
 * purpose, so that no consumer can be tempted to treat a scraped field as a fact, and the screen
 * renders every one of them through React's text path. There is no `dangerouslySetInnerHTML`
 * anywhere in this feature and its test asserts a `<script>` payload renders inert.
 */

export type WireSalt = {
  id: string; name: string; aliases: string[]; drugClass: string | null;
  atcCode: string | null; active: boolean;
};

export type WireMedicine = {
  id: string; brandName: string; form: string; routeClass: string;
  strengthLabel: string | null; scheduleFlag: string | null; stagingId: string | null; active: boolean;
  salts: { saltId: string; strength: string | null }[];
};

export type WireInteraction = {
  id: string; saltAId: string; saltBId: string;
  severity: "severe" | "moderate"; note: string; source: string;
  routeScope: "systemic_only" | null; active: boolean;
};

export type WireStagingRow = {
  id: string; kind: string; name: string;
  /** SCRAPED. Untrusted. Rendered as text, never as markup — see the header. */
  payload: Record<string, unknown>;
  sourceUrl: string; minedAt: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null; reviewedAt: string | null; medicineId: string | null;
};

export type WireCoverage = {
  coverage: number;
  /** DD5 — the SERVER decides. The client never re-derives the threshold from `coverage`. */
  noticeEnabled: boolean;
  unresolvedTop: { drug: string; count: number }[];
};

export async function fetchSalts(): Promise<WireSalt[]> {
  return (await api<{ items: WireSalt[] }>("GET", "/formulary/salts")).items;
}

export async function fetchMedicines(): Promise<WireMedicine[]> {
  return (await api<{ items: WireMedicine[] }>("GET", "/formulary/medicines")).items;
}

/** Pull-based (spec §1.1): a name search. There is no route that lists every pending row. */
export async function searchStaging(q: string): Promise<WireStagingRow[]> {
  if (q.trim() === "") return [];
  return (await api<{ items: WireStagingRow[] }>(
    "GET", `/formulary/staging/search?q=${encodeURIComponent(q)}`,
  )).items;
}

export type AdmitInput = {
  brandName: string; form: string; routeClass: "systemic" | "topical";
  strengthLabel?: string | null; scheduleFlag?: string | null;
  salts: { saltId: string; strength?: string | null }[];
  acknowledgeIntraFdc?: boolean;
};

export async function admitStaging(stagingId: string, input: AdmitInput): Promise<{ medicineId: string }> {
  return api<{ medicineId: string }>("POST", `/formulary/staging/${stagingId}/admit`, input);
}

export async function rejectStaging(stagingId: string, reason: string): Promise<void> {
  await api<{ ok: true }>("POST", `/formulary/staging/${stagingId}/reject`, { reason });
}

export async function addMedicine(input: AdmitInput): Promise<{ medicineId: string }> {
  return api<{ medicineId: string }>("POST", "/formulary/medicines", input);
}

export async function addSalt(input: { name: string; drugClass?: string | null }): Promise<{ saltId: string }> {
  return api<{ saltId: string }>("POST", "/formulary/salts", input);
}

/** T8's endpoint. A 404 means "not deployed yet" and the caller treats it as OFF (DD5). */
export async function fetchCoverage(): Promise<WireCoverage | null> {
  try {
    return await api<WireCoverage>("GET", "/formulary/coverage");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** The module's refusals, rendered as the message the server sent rather than re-worded here. */
export function formularyErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string; code?: string } | null;
    return body?.message ?? body?.code ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
