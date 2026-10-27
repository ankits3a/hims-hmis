import { api, newIdempotencyKey } from "./api";
import type { IpdRestraintRegister, IpdWardQuality, IpdWardSafety, IpdWardStock } from "@hmis/contracts";

/**
 * WM-2 (#983, decisions 0089 / 0091) — ward safety, stock and quality on the wire. Shapes are the contract's
 * (`packages/contracts/src/ipd/ward-safety.ts`); paths are copied here because the contract file imports zod and the web
 * bundle takes it for TYPES only. Every act carries a fresh idempotency key.
 */
export const WS = {
  safety: "/ipd/ward-safety",
  careCheck: "/ipd/ward-safety/care-check",
  restraintCheck: "/ipd/ward-safety/restraint/check",
  restraintFamily: "/ipd/ward-safety/restraint/family",
  restraintEnd: "/ipd/ward-safety/restraint/end",
  restraintRegister: "/ipd/ward-safety/restraint/register",
  cartCheck: "/ipd/ward-safety/cart/check",
  cartUse: "/ipd/ward-safety/cart/use",
  keys: "/ipd/ward-safety/narcotic-keys",
  stock: "/ipd/ward-safety/stock",
  stockIndent: "/ipd/ward-safety/stock/indent",
  quality: "/ipd/ward-safety/quality",
  lineReview: "/ipd/ward-safety/line/review",
} as const;

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export const getWardSafety = (wardId?: string | null): Promise<IpdWardSafety> =>
  api("GET", wardId ? `${WS.safety}?wardId=${encodeURIComponent(wardId)}` : WS.safety);
export const getWardStock = (wardId: string): Promise<IpdWardStock> => api("GET", `${WS.stock}?wardId=${encodeURIComponent(wardId)}`);
export const getWardQuality = (wardId: string, month: string): Promise<IpdWardQuality> =>
  api("GET", `${WS.quality}?wardId=${encodeURIComponent(wardId)}&month=${month}`);
export const getRestraintRegister = (wardId: string, month: string): Promise<IpdRestraintRegister> =>
  api("GET", `${WS.restraintRegister}?wardId=${encodeURIComponent(wardId)}&month=${month}`);

export const recordCareCheck = (planId: string): Promise<{ nextDueAt: string }> => post(WS.careCheck, { planId });
export type RestraintTicks = { circulation: boolean; skin: boolean; hydration: boolean; toileting: boolean };
export const recordRestraintCheck = (restraintId: string, ticks: RestraintTicks): Promise<{ nextCheckAt: string }> =>
  post(WS.restraintCheck, { restraintId, ...ticks });
export const recordFamilyTold = (restraintId: string, toldName: string, relation: string, nominatedRepresentative: boolean): Promise<unknown> =>
  post(WS.restraintFamily, { restraintId, toldName, relation, toldAt: new Date().toISOString(), ...(nominatedRepresentative ? { nominatedRepresentative: true } : {}) });
export const endRestraint = (restraintId: string, reason: string): Promise<unknown> => post(WS.restraintEnd, { restraintId, reason });
export type CartLine = { item: string; qty: number };
export const checkCart = (cartId: string, sealNo: string, recount?: CartLine[]): Promise<{ incidentId: string | null; status: string }> =>
  post(WS.cartCheck, { cartId, sealNo, ...(recount === undefined ? {} : { recount }) });
export const markCartUsed = (cartId: string): Promise<unknown> => post(WS.cartUse, { cartId });
export const takeKeys = (wardId: string): Promise<unknown> => post(WS.keys, { wardId });
export const raiseWardIndent = (wardId: string): Promise<{ indentNo: string; lines: number }> => post(WS.stockIndent, { wardId });

/** The doctor's daily "still needed?" on a line: keep it, or take it out now. */
export const reviewLine = (lineId: string, decision: "keep" | "remove"): Promise<unknown> => post(WS.lineReview, { lineId, decision });

/** The IST month `YYYY-MM` an instant falls in. */
export function istMonth(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}
