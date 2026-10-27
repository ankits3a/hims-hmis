import { ApiError, api } from "./api";
import type {
  LinenBillCard, LinenUniformView, LinenVendorDeskView, LinenActResult, LinenBedWait, LinenBoardView, LinenFloorView, LinenHandlerView, LinenLaundryView, LinenPlantView, LinenRoundCard,
} from "@hmis/contracts";

/* ═══ E2.4 LINEN (issue #728) — `apps/core/src/modules/linen/linen.controller.ts`'s `/linen…`. The web imports only
 * TYPES from `@hmis/contracts`; refusals come back as `{ code }` and the screen shows `linen.refusal.<code>`. ═══ */

export type LinenLine = { itemCode: string; qty: number };

export const fetchLinenBoard = () => api<LinenBoardView>("GET", "/linen/board");
export const fetchLinenHandler = () => api<LinenHandlerView>("GET", "/linen/handler");

/** A fresh key per Save tap: a double tap or a retried request is one act on the server. */
export const newTapKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `tap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const ward = (id: string, verb: "top-up" | "soiled" | "infected" | "count", lines: LinenLine[], idempotencyKey: string) =>
  api<LinenActResult>("POST", `/linen/wards/${encodeURIComponent(id)}/${verb}`, { lines, idempotencyKey });
export const topUpApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "top-up", lines, key);
export const soiledApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "soiled", lines, key);
export const infectedApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "infected", lines, key);
export const countApi = (wardId: string, lines: LinenLine[], key: string) => ward(wardId, "count", lines, key);
export const borrowApi = (fromWardId: string, toWardId: string, lines: LinenLine[], idempotencyKey: string) =>
  api<LinenActResult>("POST", "/linen/borrow", { fromWardId, toWardId, lines, idempotencyKey });
export const sendLaundryApi = (infected: boolean, lines: LinenLine[], idempotencyKey: string) =>
  api<LinenActResult>("POST", "/linen/laundry/batches", { infected, lines, idempotencyKey });
export const receiveLaundryApi = (batchId: string, lines: LinenLine[]) =>
  api<LinenActResult>("POST", `/linen/laundry/batches/${encodeURIComponent(batchId)}/receive`, { lines });
export const requestCondemnApi = (wardId: string, itemCode: string, qty: number, reason: string) =>
  api<{ id: string; state: string }>("POST", "/linen/condemn", { wardId, itemCode, qty, reason });
export const decideCondemnApi = (id: string, verb: "approve" | "reject") =>
  api<{ id: string; state: string }>("POST", `/linen/condemn/${encodeURIComponent(id)}/${verb}`, {});

/** The refusal code a linen door answered with, or null. */
export function linenRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

/* ═══ LD-1 (#978, decision 0087) — the laundry floor: plant, store, rounds, bags, holds. ═══ */

export type LinenSignature = { username: string; pin: string };
export type LinenRoundSign = { wardSign: LinenSignature } | { runnerOnlyReason: string };

export const fetchLinenPlant = () => api<LinenPlantView>("GET", "/linen/plant");
export const fetchLinenLaundry = () => api<LinenLaundryView>("GET", "/linen/laundry");
export const fetchLinenFloor = () => api<LinenFloorView>("GET", "/linen/floor");
export const fetchLinenBedsWaiting = () => api<LinenBedWait[]>("GET", "/linen/beds-waiting");

const id = encodeURIComponent;
type Decided = { id: string; state: string };

export const openRoundApi = (wardId: string, kind: "pickup" | "delivery") => api<LinenRoundCard>("POST", "/linen/rounds", { wardId, kind });
export const signPickupApi = (roundId: string, lines: LinenLine[], bags: string[], sign: LinenRoundSign) =>
  api<LinenRoundCard>("POST", `/linen/rounds/${id(roundId)}/pickup`, {
    ...(lines.length > 0 ? { lines } : {}), ...(bags.length > 0 ? { bags: bags.map((tag) => ({ tag })) } : {}), ...sign,
  });
export const signDeliveryApi = (roundId: string, lines: LinenLine[], sign: LinenRoundSign) =>
  api<LinenRoundCard>("POST", `/linen/rounds/${id(roundId)}/delivery`, { ...(lines.length > 0 ? { lines } : {}), ...sign });
export const sealBagApi = (b: { wardId: string; bedId?: string; tag: string; infected: boolean; lines: LinenLine[] }) =>
  api<{ id: string; tag: string }>("POST", "/linen/bags", b);
export const placeHoldApi = (h: { kind: "mlc" | "chemo" | "radioactive"; bedId: string; doseAt?: string; note?: string }) =>
  api<Decided>("POST", "/linen/holds", h);
export const releaseHoldApi = (holdId: string, police?: { name: string; rank: string; station: string }) =>
  api<Decided>("POST", `/linen/holds/${id(holdId)}/release`, police === undefined ? {} : { police });

export const machineDownApi = (machineId: string, reason: string) => api<Decided>("POST", `/linen/machines/${id(machineId)}/down`, { reason });
export const machineUpApi = (machineId: string) => api<Decided>("POST", `/linen/machines/${id(machineId)}/up`, {});
export const startCycleApi = (machineId: string, batchIds: string[], program: string) =>
  api<{ id: string }>("POST", "/linen/cycles", { machineId, batchIds, program });
export const finishCycleApi = (cycleId: string, tempC: number, holdMin: number, chemical: string) =>
  api<{ id: string; disinfected: boolean | null }>("POST", `/linen/cycles/${id(cycleId)}/finish`, { tempC, holdMin, chemical });
export const releaseBatchApi = (batchId: string) => api<Decided>("POST", `/linen/laundry/batches/${id(batchId)}/release`, {});
/** LD-2: once vendor laundry is live, plant work leaves for the vendor on a challan (vendor + weight). */
export const vendorBatchApi = (batchId: string, challan: LinenChallanIn = {}) =>
  api<Decided>("POST", `/linen/laundry/batches/${id(batchId)}/vendor`, challan);
export type LinenQcLine = { itemCode: string; pass: number; rewash: number; mend: number; condemn: number };
export const recordQcApi = (batchId: string, lines: LinenQcLine[]) =>
  api<{ batchId: string; movements: number; condemnRequests: number }>("POST", `/linen/laundry/batches/${id(batchId)}/qc`, { lines });
export const cssdApi = (batchId: string, cssdSign: LinenSignature) =>
  api<{ batchId: string; movements: number }>("POST", `/linen/laundry/batches/${id(batchId)}/cssd`, { cssdSign });
/** A top-up with no lines issues every item to par. */
export const topUpToParApi = (wardId: string, key: string) => api<LinenActResult>("POST", `/linen/wards/${id(wardId)}/top-up`, { idempotencyKey: key });

/* ═══ LD-2 (#979, decisions 0087 and 0092) — vendor laundry and uniforms. ═══ */

export type LinenChallanIn = { linenVendorId?: string; weightGrams?: number; rush?: boolean };
export type LinenReturnLine = { itemCode: string; accepted: number; damaged: number; stained: number };

export const fetchVendorDesk = (month?: string) =>
  api<LinenVendorDeskView>("GET", month === undefined ? "/linen/vendor-desk" : `/linen/vendor-desk?month=${id(month)}`);
export const sendToVendorApi = (b: { infected: boolean; lines?: LinenLine[]; bagTags?: string[] } & LinenChallanIn, idempotencyKey: string) =>
  api<LinenActResult>("POST", "/linen/laundry/batches", { ...b, mode: "vendor", idempotencyKey });
export const challanReturnApi = (challanId: string, lines: LinenReturnLine[]) =>
  api<{ challanId: string; closed: boolean; condemnRequests: number }>("POST", `/linen/challans/${id(challanId)}/return`, { lines });
export const addVendorApi = (name: string) => api<{ id: string }>("POST", "/linen/vendors", { name });
export const vendorRateApi = (vendorId: string, itemCode: string, ratePaise: number, effectiveFrom: string) =>
  api<{ id: string }>("POST", `/linen/vendors/${id(vendorId)}/rates`, { itemCode, ratePaise, effectiveFrom });
export const raiseRecoveryApi = (linenVendorId: string, month: string) => api<Decided>("POST", "/linen/recoveries", { linenVendorId, month });
export const decideRecoveryApi = (recoveryId: string, verb: "approve" | "reject", amountPaise?: number) =>
  api<Decided>("POST", `/linen/recoveries/${id(recoveryId)}/${verb}`, amountPaise === undefined ? {} : { amountPaise });
export const checkBillApi = (b: { linenVendorId: string; month: string; vendorBillNo: string; lines: { itemCode: string; pieces: number; amountPaise: number }[]; billedPaise: number }) =>
  api<LinenBillCard>("POST", "/linen/bills", b);
export const decideBillApi = (billId: string, verb: "approve" | "refuse") => api<LinenBillCard>("POST", `/linen/bills/${id(billId)}/${verb}`, {});

export const fetchUniforms = () => api<LinenUniformView>("GET", "/linen/uniforms");
export const uniformApi = (verb: "issue" | "exchange" | "return", body: { username: string; sets?: number; dirty?: number; clean?: number; size?: string }) =>
  api<{ holding: number }>("POST", `/linen/uniforms/${verb}`, body);

/** Paise as rupees for the desk (no paise shown below a rupee's worth of rounding). */
export const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
