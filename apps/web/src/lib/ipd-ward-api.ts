import { ApiError, api, newIdempotencyKey } from "./api";
import type { IpdFloatPool, IpdShiftMapView, IpdWardCockpit } from "@hmis/contracts";

/**
 * WM-1 (#982, decision 0089) — the ward's nurses on the wire: the in-charge cockpit, the shift map (draft, same as last
 * shift, publish), assigning a bed to a nurse, ending a duty, acuity, and the supervisor's float pool. Shapes are the
 * contract's (`packages/contracts/src/ipd/nurse-ward.ts`); paths are copied here because the contract file imports zod
 * and the web bundle takes it for TYPES only. Every act carries a fresh idempotency key.
 */
export const W = {
  cockpit: "/ipd/nursing/ward/cockpit",
  map: "/ipd/nursing/ward/map",
  saveMap: "/ipd/nursing/ward/map/save",
  copyMap: "/ipd/nursing/ward/map/copy",
  publishMap: "/ipd/nursing/ward/map/publish",
  assignNurse: "/ipd/nursing/ward/assign-nurse",
  endDuty: "/ipd/nursing/ward/end-duty",
  floatPool: "/ipd/nursing/ward/float-pool",
  moveFloat: "/ipd/nursing/ward/float",
  acuity: "/ipd/nursing/acuity",
} as const;

export type NurseShift = "morning" | "evening" | "night";
export type StaffKind = "rn" | "student" | "incharge" | "float";
export type AcuityLevel = "self_care" | "partial_care" | "full_care";
/** Copied from the contract (`IPD_ACUITY_POINTS`). */
export const ACUITY_POINTS: Record<AcuityLevel, number> = { self_care: 1, partial_care: 1.5, full_care: 2 };

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export const getCockpit = (wardId?: string | null): Promise<IpdWardCockpit> =>
  api("GET", wardId ? `${W.cockpit}?wardId=${encodeURIComponent(wardId)}` : W.cockpit);
export const getShiftMap = (wardId: string, shiftDate: string, shift: NurseShift): Promise<IpdShiftMapView> =>
  api("GET", `${W.map}?wardId=${encodeURIComponent(wardId)}&shiftDate=${shiftDate}&shift=${shift}`);
export const getFloatPool = (floorId?: string | null): Promise<IpdFloatPool> =>
  api("GET", floorId ? `${W.floatPool}?floorId=${encodeURIComponent(floorId)}` : W.floatPool);

export type MapDraft = {
  wardId: string; shiftDate: string; shift: NurseShift;
  staff: { userId: string; kind: StaffKind; pairedWithId?: string }[];
  beds: { bedId: string; nurseId: string; studentId?: string }[];
};
export const saveShiftMap = (d: MapDraft): Promise<{ mapId: string }> => post(W.saveMap, d);
export const copyShiftMap = (wardId: string, shiftDate: string, shift: NurseShift): Promise<{ mapId: string; copiedFrom: string | null }> =>
  post(W.copyMap, { wardId, shiftDate, shift });
export const publishShiftMap = (mapId: string): Promise<{ mapId: string; late: boolean; ratioBreach: boolean }> =>
  post(W.publishMap, { mapId });
export const assignNurse = (bedId: string, nurseId: string, reason?: string): Promise<{ ratioBreach: boolean }> =>
  post(W.assignNurse, { bedId, nurseId, ...(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }) });
export const endMyDuty = (wardId: string): Promise<{ endedAt: string }> => post(W.endDuty, { wardId });
export const moveFloat = (b: { userId: string; toWardId: string; shiftDate: string; shift: NurseShift; reason: string }): Promise<unknown> =>
  post(W.moveFloat, b);
export const setAcuity = (admissionId: string, level: AcuityLevel, ventilated: boolean): Promise<{ points: number }> =>
  post(W.acuity, { admissionId, level, ...(ventilated ? { ventilated: true } : {}) });

/** A ward act's refusal: its code (translated by `ipdWard.err.<code>`) and the beds it names. */
export type WardError = { code: string; bedIds: string[] };
export function wardErrorOf(e: unknown): WardError | null {
  if (!(e instanceof ApiError) || e.body === null || typeof e.body !== "object") return null;
  const b = e.body as { code?: unknown; detail?: { bedIds?: unknown } };
  if (typeof b.code !== "string") return null;
  return { code: b.code, bedIds: Array.isArray(b.detail?.bedIds) ? b.detail.bedIds.filter((x): x is string => typeof x === "string") : [] };
}

/** The nursing shift an instant falls in, with its IST date (the date it starts on) — the server's `shiftSlotOf`. */
export function shiftAt(at: Date): { date: string; key: NurseShift } {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const day = ist.toISOString().slice(0, 10);
  if (m >= 8 * 60 && m < 14 * 60) return { date: day, key: "morning" };
  if (m >= 14 * 60 && m < 20 * 60) return { date: day, key: "evening" };
  if (m >= 20 * 60) return { date: day, key: "night" };
  return { date: new Date(ist.getTime() - 86_400_000).toISOString().slice(0, 10), key: "night" };
}
/** The shift after `s`. */
export function nextShift(s: { date: string; key: NurseShift }): { date: string; key: NurseShift } {
  if (s.key === "morning") return { date: s.date, key: "evening" };
  if (s.key === "evening") return { date: s.date, key: "night" };
  return { date: new Date(Date.parse(`${s.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), key: "morning" };
}
