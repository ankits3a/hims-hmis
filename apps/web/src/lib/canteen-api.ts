import { ApiError, api, apiDownload, newIdempotencyKey } from "./api";
import type {
  CanteenAdmissionLookup, CanteenBedMenu, CanteenCharityGrant, CanteenDay, CanteenDeductionRow, CanteenMonthIncome, CanteenPayment, CanteenRentInvoice, CanteenSale,
  CanteenSetupView, CanteenTillClose, CanteenAllergen, CanteenFoodType, CanteenMeal, CanteenPriceList,
} from "@hmis/contracts";

/* ═══ CN-1 CANTEEN (issue #977) — `apps/core/src/modules/canteen/canteen.controller.ts`. The web bundle imports the
 * contract package for TYPES only, so the paths are written here. ═══ */

export type CanteenDish = {
  dishId: string; code: string; name: string; meal: CanteenMeal; foodType: CanteenFoodType; allergens: CanteenAllergen[];
  prices: Partial<Record<CanteenPriceList, number>>;
};
type SaleLine = { dishId: string; qty: number };

export const fetchCanteenSetup = () => api<CanteenSetupView>("GET", "/canteen/setup");
export const fetchMenu = (outletId: string) => api<CanteenDish[]>("GET", `/canteen/outlets/${encodeURIComponent(outletId)}/menu`);
export const fetchMySession = () => api<CanteenTillClose | null>("GET", "/canteen/my-session");
export const openTillApi = (tillId: string, openingCashPaise: number) => api<{ sessionId: string }>("POST", "/canteen/sessions", { tillId, openingCashPaise });
export const sellApi = (sessionId: string, lines: SaleLine[], pay: CanteenPayment, forPatientOf?: string) =>
  api<CanteenSale>("POST", "/canteen/sales", { sessionId, idempotencyKey: newIdempotencyKey(), lines, pay, ...(forPatientOf === undefined ? {} : { forPatientOf }) });
export const closeTillApi = (sessionId: string, countedCashPaise: number, note?: string) =>
  api<CanteenTillClose>("POST", `/canteen/sessions/${encodeURIComponent(sessionId)}/close`, { countedCashPaise, ...(note ? { note } : {}) });
export const approveVarianceApi = (sessionId: string, note: string) =>
  api<CanteenTillClose>("POST", `/canteen/sessions/${encodeURIComponent(sessionId)}/approve-variance`, { note });
export const findAdmissionApi = (q: string) => api<CanteenAdmissionLookup>("GET", `/canteen/admission?q=${encodeURIComponent(q)}`);
export const fetchBedOrders = () => api<CanteenSale[]>("GET", "/canteen/bed-orders");
export const confirmBedOrderApi = (orderId: string, sessionId: string) =>
  api<CanteenSale>("POST", `/canteen/bed-orders/${encodeURIComponent(orderId)}/confirm`, { sessionId });
export const requestCharityApi = (body: { admissionId: string; kind: "free" | "subsidised"; meals: number; mealLimitPaise: number; validUntil: string; note: string }) =>
  api<{ grantId: string; approvalId: string }>("POST", "/canteen/charity", body);
export const fetchGrant = (grantId: string) => api<CanteenCharityGrant>("GET", `/canteen/charity/${encodeURIComponent(grantId)}`);
export const fetchCanteenDay = (date: string) => api<CanteenDay>("GET", `/canteen/day?date=${encodeURIComponent(date)}`);
export const fetchCanteenMonth = (month: string) => api<CanteenMonthIncome>("GET", `/canteen/month?month=${encodeURIComponent(month)}`);
export const fetchDeductions = (month: string) => api<CanteenDeductionRow[]>("GET", `/canteen/deductions?month=${encodeURIComponent(month)}`);
export const downloadDeductions = (month: string) => apiDownload(`/canteen/deductions.csv?month=${encodeURIComponent(month)}`, `canteen-deductions-${month}.csv`);
export const issueRentApi = (outletId: string, month: string) => api<CanteenRentInvoice>("POST", "/canteen/rent-invoices", { outletId, month });

// Setup (manager) and finance rules.
export const createOutletApi = (b: Record<string, unknown>) => api<{ outletId: string }>("POST", "/canteen/outlets", b);
export const createTillApi = (b: { outletId: string; code: string; name: string }) => api<{ tillId: string }>("POST", "/canteen/tills", b);
export const createDishApi = (b: Record<string, unknown>) => api<{ dishId: string }>("POST", "/canteen/dishes", b);
export const setPriceApi = (dishId: string, list: CanteenPriceList, pricePaise: number) => api<{ priceId: string }>("POST", "/canteen/prices", { dishId, list, pricePaise });
export const createCostCentreApi = (code: string, name: string) => api<{ costCentreId: string }>("POST", "/canteen/cost-centres", { code, name });
export const createFreeRuleApi = (code: string, name: string, perDay: number) => api<{ freeRuleId: string }>("POST", "/canteen/free-rules", { code, name, perDay });
export const setBedClassMealsApi = (bedClass: string, mealsPerDay: number) => api<unknown>("PUT", "/canteen/bed-class-meals", { bedClass, mealsPerDay });
export const issueBedQrApi = (bedCode: string, outletId: string) => api<{ qrId: string; token: string }>("POST", "/canteen/bed-qrs", { bedCode, outletId });
export const createCategoryApi = (code: string, name: string) => api<{ categoryId: string }>("POST", "/canteen/staff-categories", { code, name });
export const setStaffRuleApi = (b: Record<string, unknown>) => api<{ ruleId: string }>("POST", "/canteen/staff-rules", b);
export const issueCardApi = (b: { username: string; categoryId: string; staffCode: string }) => api<{ cardId: string; version: number }>("POST", "/canteen/staff-cards", b);

// The bed's QR page (no login): the token travels in the body.
export const fetchBedMenu = (token: string) => api<CanteenBedMenu>("POST", "/canteen/bed/menu", { token });
export const placeBedOrderApi = (token: string, body: { lines: SaleLine[]; pay: "upi" | "bed_class" | "ipd_bill"; upiReference?: string; forPatient?: boolean }, familyToken?: string) =>
  body.pay === "ipd_bill"
    ? api<CanteenSale>("POST", "/ipd/family/canteen/order", { token, familyToken, idempotencyKey: newIdempotencyKey(), ...body })
    : api<CanteenSale>("POST", "/canteen/bed/order", { token, idempotencyKey: newIdempotencyKey(), ...body });

/** The family page keeps its link token here after the OTP, so the bed page can put meals on the hospital bill. */
export const FAMILY_TOKEN_KEY = "hmis.family.token";
export function storedFamilyToken(): string | null {
  try { return localStorage.getItem(FAMILY_TOKEN_KEY); } catch { return null; }
}

/** The refusal code a canteen door answered with, or null. */
export function canteenRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const code = (e.body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : `http_${String(e.status)}`;
}

/** "₹84" / "₹84.50" from paise. */
export function rupees(paise: number): string {
  return paise % 100 === 0 ? `₹${String(paise / 100)}` : `₹${(paise / 100).toFixed(2)}`;
}

/** Rupees typed at a till ("84", "84.5") → paise, or null. */
export function paiseOf(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (m === null) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
