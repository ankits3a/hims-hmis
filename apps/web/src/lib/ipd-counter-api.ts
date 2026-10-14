import { api, newIdempotencyKey } from "./api";
import type { IpdCounterAdmission, IpdCounterSales, IpdCounterShelfEntry } from "@hmis/contracts";

/**
 * #787 (IP counter) — CHARGE TO IP at the OPD pharmacy counter: the wire of `IPD_COUNTER_ROUTES` (contracts
 * `packages/contracts/src/ipd/counter.ts`, types only). A charge or a return carries the key the caller holds, so a retry
 * after a network failure is the same request and charges once.
 */
const COUNTER = {
  lookup: "/ipd/counter/admission",
  shelf: "/ipd/counter/shelf",
  sales: (id: string) => `/ipd/counter/admissions/${encodeURIComponent(id)}/sales`,
  charge: "/ipd/counter/charge",
  returnSale: "/ipd/counter/return",
} as const;

export type CounterChargeLine = { medicineId: string; units: number; batchId?: string };
export type CounterChargeResult = { saleId: string; admissionId: string; lines: { medicineId: string; units: number; netPaise: number }[]; totalPaise: number };

export const findIpAdmission = (q: string): Promise<IpdCounterAdmission> => api("GET", `${COUNTER.lookup}?q=${encodeURIComponent(q)}`);
export const searchIpShelf = (q: string): Promise<IpdCounterShelfEntry[]> => api("GET", `${COUNTER.shelf}?q=${encodeURIComponent(q)}`);
export const fetchIpCounterSales = (admissionId: string): Promise<IpdCounterSales> => api("GET", COUNTER.sales(admissionId));
export const chargeToIp = (admissionId: string, lines: CounterChargeLine[], key: string = newIdempotencyKey()): Promise<CounterChargeResult> =>
  api("POST", COUNTER.charge, { idempotencyKey: key, admissionId, lines }, key);
export const returnToCounter = (saleId: string, itemId: string, units: number, reason: string, key: string = newIdempotencyKey()): Promise<{ returnId: string; units: number; creditedUnits: number }> =>
  api("POST", COUNTER.returnSale, { idempotencyKey: key, saleId, itemId, units, reason }, key);
