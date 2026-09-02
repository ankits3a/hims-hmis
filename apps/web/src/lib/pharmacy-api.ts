import { api, ApiError } from "./api";
import en from "../locales/en.json";

/**
 * PLAN 16c — the pharmacy module's wire types and calls. Every shape here is what the server
 * returns, field for field; a field that stops crossing the wire fails a screen test instead of
 * silently vanishing (the `lab-api.ts` posture).
 */
export type WireSaleItem = {
  itemId: string; code: string; name: string; baseUom: string; gstRateBps: number | null;
  serviceId: string; serviceCode: string; category: string; active: boolean; itemActive: boolean;
};

export type WireSaleCandidate = { id: string; code: string; name: string; baseUom: string; gstRateBps: number | null };

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, v);
  const s = p.toString();
  return s === "" ? "" : `?${s}`;
}

export async function fetchSaleItems(q: { search?: string } = {}): Promise<WireSaleItem[]> {
  const { items } = await api<{ items: WireSaleItem[] }>("GET", `/pharmacy/sale-items${qs({ search: q.search })}`);
  return items;
}

export async function fetchSaleCandidates(q: { search?: string } = {}): Promise<WireSaleCandidate[]> {
  const { items } = await api<{ items: WireSaleCandidate[] }>("GET", `/pharmacy/sale-items/candidates${qs({ search: q.search })}`);
  return items;
}

export async function registerSaleItem(itemId: string): Promise<{ itemId: string; serviceId: string; serviceCode: string; category: string }> {
  return api("POST", "/pharmacy/sale-items", { itemId });
}

export async function patchSaleItem(itemId: string, patch: { active: boolean }): Promise<void> {
  await api<{ ok: true }>("PATCH", `/pharmacy/sale-items/${itemId}`, patch);
}

export function pharmacyErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | undefined;
    if (body !== undefined && typeof body.code === "string") return body.code;
  }
  return null;
}

/** A code the locale knows becomes a sentence; anything else is the server's own message. */
export function pharmacyErrorText(e: unknown, t: (key: string) => string): string {
  const code = pharmacyErrorCode(e);
  if (code !== null && Object.prototype.hasOwnProperty.call(en.pharmacyErrors, code)) {
    return t(`pharmacyErrors.${code}`);
  }
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown } | undefined;
    return body !== undefined && typeof body.message === "string" ? body.message : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
