import { ApiError, api, apiDownload } from "./api";
import type {
  BmwBagCard, BmwBoardView, BmwCategory, BmwClockLevel, BmwFormIvReport, BmwHandlerView, BmwMonthlyReport, GenerateBagResult,
} from "@hmis/contracts";

/* ═══ E1.7 BIO-MEDICAL WASTE (issue #724) — `apps/core/src/modules/bmw/bmw.controller.ts`'s `/bmw…`. Every bag act
 * answers the bag's card; the phone shows the next step from its state. ═══ */

export const fetchBmwBoard = () => api<BmwBoardView>("GET", "/bmw/board");
export const fetchBmwHandler = () => api<BmwHandlerView>("GET", "/bmw/handler");
export const fetchBag = (barcode: string) => api<BmwBagCard>("GET", `/bmw/bags/${encodeURIComponent(barcode.trim().toUpperCase())}`);

/** A fresh key per TAP (PR #749 review): a double tap or a retried request is the same bag on the server. */
export const newTapKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `tap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const generateBagApi = (category: BmwCategory, placeResourceId: string, cytotoxic: boolean, idempotencyKey: string) =>
  api<GenerateBagResult>("POST", "/bmw/bags", { category, placeResourceId, ...(cytotoxic ? { cytotoxic: true } : {}), idempotencyKey });

const bagAct = (verb: "weight" | "collect" | "store", barcode: string, grams?: number) =>
  api<BmwBagCard>("POST", `/bmw/bags/${encodeURIComponent(barcode)}/${verb}`, grams === undefined ? {} : { grams });
export const weighBag = (barcode: string, grams: number) => bagAct("weight", barcode, grams);
export const collectBagApi = (barcode: string, grams?: number) => bagAct("collect", barcode, grams);
export const storeBagApi = (barcode: string, grams: number) => bagAct("store", barcode, grams);

export const fetchMonthly = (month: string) => api<BmwMonthlyReport>("GET", `/bmw/reports/monthly?month=${month}`);
export const fetchFormIv = (year: string) => api<BmwFormIvReport>("GET", `/bmw/reports/form-iv?year=${year}`);
export const downloadMonthly = (month: string) => apiDownload(`/bmw/reports/monthly.csv?month=${month}`, `BMW-monthly-${month}.csv`);
export const downloadFormIv = (year: string) => apiDownload(`/bmw/reports/form-iv.csv?year=${year}`, `BMW-Form-IV-${year}.csv`);

/** The refusal code a bmw door answered with, or null. The screen shows `bmw.refusal.<code>`. */
export function bmwRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

/** Whole hours since generation, read at `nowMs`. */
export const ageHours = (generatedAt: string, nowMs: number): number => Math.max(0, Math.floor((nowMs - Date.parse(generatedAt)) / 3_600_000));

/** "1.24 kg" — waste is weighed in grams and read in kilograms. */
export const kg = (grams: number | null): string => (grams === null ? "—" : `${(grams / 1000).toFixed(grams >= 10_000 ? 1 : 2)} kg`);

/*
 * The web imports only TYPES from `@hmis/contracts` (its package resolves to a build the web does not have), so the
 * clock's two lines and the colour list are repeated here — the same numbers as `BMW_WARN_HOURS` / `BMW_LIMIT_HOURS`.
 */
export const BMW_WARN_HOURS = 36;
export const BMW_LIMIT_HOURS = 48;
export const BMW_CATEGORIES = ["yellow", "red", "white_translucent", "blue"] as const satisfies readonly BmwCategory[];
export function bmwClockLevel(generatedAt: string, now: Date): BmwClockLevel {
  const hours = (now.getTime() - Date.parse(generatedAt)) / 3_600_000;
  return hours >= BMW_LIMIT_HOURS ? "alert" : hours >= BMW_WARN_HOURS ? "warning" : "ok";
}
