import { api, newIdempotencyKey } from "./api";
import type { IpdAgencyNurses, IpdRestraintRegister, IpdWardLots, IpdWardQuality, IpdWardSafety, IpdWardStock, IpdWardStockCatalogue } from "@hmis/contracts";

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
  riskScore: "/ipd/ward-safety/risk-score",
  restraintOrder: "/ipd/ward-safety/restraint/order",
  restraintApply: "/ipd/ward-safety/restraint/apply",
  restraintReview: "/ipd/ward-safety/restraint/review",
  lineInsert: "/ipd/ward-safety/line/insert",
  lineRemove: "/ipd/ward-safety/line/remove",
  event: "/ipd/ward-safety/event",
  cartRegister: "/ipd/ward-safety/cart/register",
  stockPar: "/ipd/ward-safety/stock/par",
  stockCatalogue: "/ipd/ward-safety/stock/catalogue",
  stockLots: "/ipd/ward-safety/stock/lots",
  stockUse: "/ipd/ward-safety/stock/use",
  stockReturn: "/ipd/ward-safety/stock/return",
  agencyNurses: "/ipd/ward-safety/agency-nurses",
  verifyRegistration: "/ipd/ward-safety/agency-nurses/verify",
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

// #1007 — the entry acts.
export const recordRiskScore = (admissionId: string, morse: number, braden: number): Promise<{ plans: { kind: string; change: string }[] }> =>
  post(WS.riskScore, { admissionId, morse, braden });
export type RestraintKind = "physical" | "chemical" | "seclusion";
export const orderRestraint = (admissionId: string, kind: RestraintKind, reason: string): Promise<{ restraintId: string }> =>
  post(WS.restraintOrder, { admissionId, kind, reason });
export const applyRestraint = (restraintId: string): Promise<unknown> => post(WS.restraintApply, { restraintId });
export const reviewRestraint = (restraintId: string, decision: "continue" | "remove"): Promise<unknown> => post(WS.restraintReview, { restraintId, decision });
export type LineKind = "urinary_catheter" | "central_line" | "cannula";
export const insertLine = (admissionId: string, kind: LineKind, site: string, insertedAt: string): Promise<{ dueRemovalAt: string }> =>
  post(WS.lineInsert, { admissionId, kind, site, insertedAt });
export const removeLine = (lineId: string, reason: string): Promise<unknown> => post(WS.lineRemove, { lineId, removedAt: new Date().toISOString(), reason });
export type SafetyEventKind = "fall" | "pressure_injury" | "medication_error" | "line_infection";
export const recordSafetyEvent = (b: { admissionId: string; kind: SafetyEventKind; presentOnAdmission: boolean; lineId?: string; note?: string }): Promise<unknown> =>
  post(WS.event, {
    admissionId: b.admissionId, kind: b.kind, occurredAt: new Date().toISOString(), ...(b.presentOnAdmission ? { presentOnAdmission: true } : {}),
    ...(b.lineId === undefined ? {} : { lineId: b.lineId }), ...(b.note === undefined || b.note.trim() === "" ? {} : { note: b.note.trim() }),
  });
export const registerCart = (wardId: string, code: string, sealNo: string): Promise<{ cartId: string }> => post(WS.cartRegister, { wardId, code, sealNo });
export const setWardPar = (wardId: string, supplyStoreId: string, items: { itemId: string; par: number }[]): Promise<unknown> =>
  post(WS.stockPar, { wardId, supplyStoreId, items });
export const getStockCatalogue = (search: string): Promise<IpdWardStockCatalogue> =>
  api("GET", search.trim() === "" ? WS.stockCatalogue : `${WS.stockCatalogue}?search=${encodeURIComponent(search.trim())}`);

// #1019 — ward stock on a patient at the bedside.
export const getWardLots = (admissionId: string): Promise<IpdWardLots> => api("GET", `${WS.stockLots}?admissionId=${encodeURIComponent(admissionId)}`);
export type StockOutcome = "used" | "issued" | "wasted" | "refused";
export type StockUse = {
  admissionId: string; itemId: string; batchId: string; qty: number; outcome: StockOutcome;
  reason?: string; staffError?: boolean; inPackage?: boolean; waiveReason?: string;
};
export const recordStockUse = (u: StockUse): Promise<{ charged: boolean; notChargedWhy: string | null }> => post(WS.stockUse, {
  admissionId: u.admissionId, itemId: u.itemId, batchId: u.batchId, qty: u.qty, outcome: u.outcome,
  ...(u.reason === undefined || u.reason.trim() === "" ? {} : { reason: u.reason.trim() }),
  ...(u.staffError === true ? { staffError: true } : {}), ...(u.inPackage === true ? { inPackage: true } : {}),
  ...(u.waiveReason === undefined || u.waiveReason.trim() === "" ? {} : { waive: { reason: u.waiveReason.trim() } }),
});

// #1010 / #1009.
export const returnWardLots = (wardId: string): Promise<{ lines: number }> => post(WS.stockReturn, { wardId });
export const getAgencyNurses = (): Promise<IpdAgencyNurses> => api("GET", WS.agencyNurses);
export const verifyRegistration = (userId: string, council: string, registrationNo: string, validUntil: string): Promise<unknown> =>
  post(WS.verifyRegistration, { userId, council, registrationNo, validUntil });

/** HH:MM today in IST → an ISO instant (an insertion time typed on the ward). */
export function istTodayAt(hhmm: string, now: Date = new Date()): string {
  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${day}T${hhmm}:00+05:30`).toISOString();
}
/** Now in IST as HH:MM. */
export function istNowHhmm(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

/** The IST month `YYYY-MM` an instant falls in. */
export function istMonth(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}
