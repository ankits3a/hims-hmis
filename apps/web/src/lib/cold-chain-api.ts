import { api } from "./api";

/**
 * PHARMACY STAGE D3 — the fridge temperature log and the excursion hold, transcribed from
 * `pharmacy/cold-chain.ts`. Record a reading: `pharmacy.coldchain.record`; add or edit a fridge and close an
 * excursion: `pharmacy.coldchain.manage`; reads need either. Temperatures travel as one-decimal strings.
 */
export const COLDCHAIN_RECORD = "pharmacy.coldchain.record";
export const COLDCHAIN_MANAGE = "pharmacy.coldchain.manage";

export type ColdSlotState = "done" | "due" | "missed" | "upcoming" | "not_due";
export type WireColdSlot = { slot: string; state: ColdSlotState; readingId: string | null };
export type WireColdReading = {
  id: string; unitId: string; currentC: string; minC: string; maxC: string; outOfRange: boolean;
  takenAt: string; takenByName: string | null; note: string | null;
};
export type WireColdUnit = {
  id: string; label: string; lowC: string; highC: string; active: boolean;
  store: { id: string; code: string; name: string };
  slots: WireColdSlot[];
  lastReading: WireColdReading | null;
  openExcursion: { id: string; no: string; openedAt: string; batches: number } | null;
};
export type ColdDecision = "release" | "write_off";
export type WireColdExcursionBatch = {
  batchId: string; batchNo: string; expiryDate: string | null; itemId: string; itemName: string; qtyOnHand: number;
  decision: { decision: ColdDecision; reason: string | null; writeOffId: string | null; decidedAt: string } | null;
};
export type WireColdExcursion = {
  id: string; no: string; unit: { id: string; label: string }; store: { id: string; code: string; name: string };
  lowC: string; highC: string; openedAt: string;
  reading: { id: string; currentC: string; minC: string; maxC: string; takenAt: string };
  batches: WireColdExcursionBatch[];
  closed: { closedAt: string; closedByName: string | null; note: string | null } | null;
};

export type ColdReadingBody = { unitId: string; currentC: number; minC: number; maxC: number; takenAt?: string | null; note?: string | null };
export type ColdUnitBody = { storeResourceId?: string; label: string; lowC?: number; highC?: number; active?: boolean };
export type CloseExcursionBody = { decisions: { batchId: string; decision: ColdDecision; reason?: string | null }[]; note?: string | null };
export type RecordedColdReading = { readingId: string; outOfRange: boolean; opened: { id: string; no: string; openedAt: string; batches: number } | null };

export const fetchColdUnits = (): Promise<{ items: WireColdUnit[] }> => api("GET", "/pharmacy/cold-chain/units");
export const fetchColdStores = (): Promise<{ items: { id: string; code: string; name: string }[] }> => api("GET", "/pharmacy/cold-chain/stores");
export const fetchColdReadings = (unitId: string, days = 7): Promise<{ items: WireColdReading[] }> =>
  api("GET", `/pharmacy/cold-chain/units/${encodeURIComponent(unitId)}/readings?days=${String(days)}`);
export const fetchColdExcursions = (open = false): Promise<{ items: WireColdExcursion[] }> =>
  api("GET", `/pharmacy/cold-chain/excursions${open ? "?open=true" : ""}`);
export const recordColdReading = (body: ColdReadingBody, idempotencyKey: string): Promise<RecordedColdReading> =>
  api("POST", "/pharmacy/cold-chain/readings", body, idempotencyKey);
export const addColdUnit = (body: ColdUnitBody): Promise<{ unitId: string }> => api("POST", "/pharmacy/cold-chain/units", body);
export const editColdUnit = (id: string, body: ColdUnitBody): Promise<{ unitId: string }> =>
  api("POST", `/pharmacy/cold-chain/units/${encodeURIComponent(id)}`, body);
export const closeColdExcursion = (id: string, body: CloseExcursionBody): Promise<{ excursionId: string; writeOffId: string | null }> =>
  api("POST", `/pharmacy/cold-chain/excursions/${encodeURIComponent(id)}/close`, body);

/** A typed temperature: a finite number to one decimal place, or null. */
export function parseCelsius(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!/^-?\d{1,2}(\.\d)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Would this reading open an excursion on this fridge? The screen warns before it is saved; the server decides. */
export function isOutOfRange(unit: Pick<WireColdUnit, "lowC" | "highC">, values: readonly number[]): boolean {
  const low = Number(unit.lowC);
  const high = Number(unit.highC);
  return values.some((v) => v < low || v > high);
}
