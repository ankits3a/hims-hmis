import { ApiError, api } from "./api";
import type {
  DietCatalogueEntry, DietCode, DietConsultView, DietKitchenBoardView, DietListView, DietMeal, DietMealRoundView, DietPreference,
  DietWard, DietWardSheetView,
} from "@hmis/contracts";

/* ═══ E4.4 DIET (issue #736) — `apps/core/src/modules/diet/diet.controller.ts`'s `/diet…` (DIET_ROUTES, copied: the web
 * imports `@hmis/contracts` for TYPES only). Refusals come back as `{ code }`; the screen shows `diet.refusal.<code>`. ═══ */

const enc = encodeURIComponent;

export const fetchDietCatalogue = () => api<DietCatalogueEntry[]>("GET", "/diet/catalogue");
export const fetchDietWards = () => api<DietWard[]>("GET", "/diet/wards");
export const fetchWardSheet = (wardId: string) => api<DietWardSheetView>("GET", `/diet/wards/${enc(wardId)}/sheet`);
export const fetchKitchenBoard = (meal?: DietMeal, date?: string) => {
  const qs = meal !== undefined && date !== undefined ? `?meal=${enc(meal)}&date=${enc(date)}` : "";
  return api<DietKitchenBoardView>("GET", `/diet/kitchen${qs}`);
};
export const fetchDietList = (id: string) => api<DietListView>("GET", `/diet/lists/${enc(id)}`);
export const fetchDietConsults = () => api<DietConsultView[]>("GET", "/diet/consults");
export const fetchMealRounds = () => api<DietMealRoundView[]>("GET", "/diet/rounds");

export type OrderDietBody = {
  admissionId: string; code: DietCode; preference: DietPreference; tubeVolumeMl?: number; tubeEveryHours?: number; note?: string;
};
export const orderDietApi = (b: OrderDietBody) => api<{ kind: string; id: string }>("POST", "/diet/orders", b);
export const startNpoApi = (b: { admissionId: string; reason: string; startsAt?: string; endsAt?: string }) =>
  api<{ id: string }>("POST", "/diet/npo", b);
export const liftNpoApi = (npoId: string, reason: string) => api<{ id: string }>("POST", `/diet/npo/${enc(npoId)}/lift`, { reason });
export const requestConsultApi = (admissionId: string, reason: string) => api<{ id: string }>("POST", "/diet/consults", { admissionId, reason });
export const completeConsultApi = (id: string, note: string) => api<{ id: string }>("POST", `/diet/consults/${enc(id)}/complete`, { note });
export const buildListsApi = (meal: DietMeal, date: string) => api<{ built: string[] }>("POST", "/diet/lists/build", { meal, date });
export const markPrintedApi = (id: string) => api<{ id: string; printedAt: string }>("POST", `/diet/lists/${enc(id)}/printed`, {});
export const dispatchListApi = (id: string) => api<{ id: string; taskId: string }>("POST", `/diet/lists/${enc(id)}/dispatch`, {});
export const serveLineApi = (lineId: string, outcome: "delivered" | "refused") =>
  api<{ id: string; served: string; consultOpened: boolean }>("POST", `/diet/lines/${enc(lineId)}/serve`, { outcome });
export const setMealRoundApi = (b: DietMealRoundView) => api<DietMealRoundView[]>("POST", "/diet/rounds", b);

/** The refusal code a diet door answered with, or null. */
export function dietRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

/** "07:30" in IST from an ISO instant. */
export function istClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** "07:30" from minutes after IST midnight. */
export function minuteClock(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
