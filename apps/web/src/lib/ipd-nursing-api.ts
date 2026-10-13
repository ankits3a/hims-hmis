import { useCallback, useEffect, useState } from "react";
import { ApiError, api, newIdempotencyKey } from "./api";
import type {
  IpdEwsBand, IpdEwsKind, IpdHandoverDraft, IpdMyShift, IpdNurseStation, IpdNursingChart, IpdShiftHandoverList,
} from "@hmis/contracts";

/**
 * E4.1 (#733) — the nursing surfaces' wire (spec SPEC-ipd-core §4.5, §4.9 C/D1). Shapes are the contract's
 * (`packages/contracts/src/ipd/nursing.ts`); paths and the few numbers are copied here because the contract file imports
 * zod and the web bundle takes it for TYPES only (the zod-free `ews.ts` is imported at runtime by the screens).
 * Every act carries a fresh idempotency key in its body (§4.10 edge 9).
 *
 * THE OFFLINE QUEUE (§0B "Offline") holds VITALS ONLY — never notes, doses, orders or bed acts. Each entry is the whole
 * `record_vitals` body, minted once with its key and the time the set was TAKEN (`observedAt`); a replay sends the same
 * body, so the server records it once. Entries older than 30 minutes are not sent: the nurse charts them on paper.
 */
export const R = {
  station: "/ipd/nursing/station",
  myShift: "/ipd/nursing/my-shift",
  chart: (id: string) => `/ipd/nursing/admissions/${encodeURIComponent(id)}/chart`,
  handoverDraft: (id: string) => `/ipd/nursing/admissions/${encodeURIComponent(id)}/handover-draft`,
  assessment: "/ipd/nursing/assessment",
  vitals: "/ipd/nursing/vitals",
  intakeOutput: "/ipd/nursing/intake-output",
  note: "/ipd/nursing/note",
  shiftHandovers: "/ipd/nursing/shift-handovers",
  giveHandover: "/ipd/nursing/shift-handovers/give",
  acceptHandover: "/ipd/nursing/shift-handovers/accept",
  acknowledgeEws: "/ipd/nursing/ews/acknowledge",
} as const;

/** Copied from the contract (`IPD_NURSING_TOPIC`). */
export const IPD_NURSING_TOPIC = "ipd_nursing:board";
/** Copied from the contract (`IPD_OFFLINE_QUEUE_MINUTES`). */
export const OFFLINE_QUEUE_MINUTES = 30;
/** Copied from the contract (`IPD_VITALS_LIMITS`): outside these a value asks "Confirm" (the typo guard). */
export const VITALS_LIMITS: Record<string, readonly [number, number]> = {
  temperatureC: [34, 42], pulse: [30, 200], respRate: [6, 60], systolic: [60, 250], diastolic: [30, 150], spo2: [70, 100],
};

const q = (path: string, wardId?: string | null): string =>
  wardId ? `${path}?wardId=${encodeURIComponent(wardId)}` : path;

export const getStation = (wardId?: string | null): Promise<IpdNurseStation> => api("GET", q(R.station, wardId));
export const getMyShift = (wardId?: string | null): Promise<IpdMyShift> => api("GET", q(R.myShift, wardId));
export const getChart = (admissionId: string): Promise<IpdNursingChart> => api("GET", R.chart(admissionId));
export const getHandoverDraft = (admissionId: string): Promise<IpdHandoverDraft> => api("GET", R.handoverDraft(admissionId));
export const getShiftHandovers = (wardId?: string | null): Promise<IpdShiftHandoverList> => api("GET", q(R.shiftHandovers, wardId));

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export type VitalsValues = {
  temperatureC?: number; pulse?: number; respRate?: number; systolic?: number; diastolic?: number; spo2?: number;
  onOxygen?: boolean; consciousness?: "alert" | "confused" | "voice" | "pain" | "unresponsive"; painScore?: number; capRefillSec?: number;
};
export type VitalsBody = {
  idempotencyKey: string; admissionId: string; observedAt: string; source: "person";
  values: VitalsValues; refused?: true; confirmedOutOfRange?: true;
};
export type VitalsResult = {
  vitalsId: string; score: { kind: IpdEwsKind; value: number; band: IpdEwsBand } | null; alertRaised: boolean; lateEntry: boolean;
};

/** Mints the body ONCE: the key and the time taken travel with it through any queueing and replay. */
export function vitalsBody(admissionId: string, values: VitalsValues, opts: { refused?: boolean; confirmed?: boolean; at?: Date } = {}): VitalsBody {
  const b: VitalsBody = {
    idempotencyKey: newIdempotencyKey(), admissionId, observedAt: (opts.at ?? new Date()).toISOString(), source: "person",
    values: opts.refused === true ? {} : values,
  };
  if (opts.refused === true) b.refused = true;
  if (opts.confirmed === true) b.confirmedOutOfRange = true;
  return b;
}
export const sendVitals = (b: VitalsBody): Promise<VitalsResult> => api("POST", R.vitals, b, b.idempotencyKey);

export type AssessmentInput = {
  admissionId: string; morse: number; braden: number; nutrition: "no_risk" | "at_risk" | "malnourished";
  allergies: string[]; painScore: number; obstetric?: "none" | "pregnant" | "postpartum";
  linesDevices: { kind: string; site?: string }[];
};
export const recordAssessment = (a: AssessmentInput): Promise<{ assessmentId: string; lateEntry: boolean }> =>
  post(R.assessment, {
    ...a, happenedAt: new Date().toISOString(), source: "person", allergyChecked: true, homeMedicines: [], pressureInjuriesOnAdmission: [],
  });
export const recordIntakeOutput = (b: { admissionId: string; direction: "in" | "out"; kind: string; volumeMl: number }): Promise<unknown> =>
  post(R.intakeOutput, { ...b, observedAt: new Date().toISOString(), source: "person" });
export const addNote = (b: { admissionId: string; category: string; text: string }): Promise<unknown> =>
  post(R.note, { ...b, observedAt: new Date().toISOString(), source: "person" });
export type SbarText = { situation: string; background: string; assessment: string; recommendation: string };
export const giveShiftHandover = (admissionId: string, sbar: SbarText): Promise<unknown> => post(R.giveHandover, { admissionId, sbar });
export const acceptShiftHandover = (handoverId: string): Promise<unknown> => post(R.acceptHandover, { handoverId });
export const acknowledgeEws = (alertId: string): Promise<unknown> => post(R.acknowledgeEws, { alertId });

/** A value outside the physiological limits (the typo guard). Returns the keys that need "Confirm". */
export function outOfLimits(v: VitalsValues): string[] {
  const out: string[] = [];
  for (const [k, [lo, hi]] of Object.entries(VITALS_LIMITS)) {
    const n = (v as Record<string, unknown>)[k];
    if (typeof n === "number" && (n < lo || n > hi)) out.push(k);
  }
  if (typeof v.systolic === "number" && typeof v.diastolic === "number" && v.systolic <= v.diastolic) out.push("systolic");
  return [...new Set(out)];
}

// ═══════════════════════════════════════════ the offline vitals queue ═══════════════════════════════════════════

const QUEUE_KEY = "hmis.ipd.vitalsQueue.v1";

function readQueue(): VitalsBody[] {
  try {
    const raw = globalThis.localStorage?.getItem(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as VitalsBody[]) : [];
  } catch { return []; }
}
function writeQueue(q: VitalsBody[]): void {
  try { globalThis.localStorage?.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* private window: queue lives in memory only */ }
  for (const l of listeners) l();
}
const listeners = new Set<() => void>();

export function queuedVitals(): VitalsBody[] { return readQueue(); }

/** Adds a set once (by its key). Vitals only — the type admits nothing else. */
export function queueVitals(b: VitalsBody): void {
  const q = readQueue();
  if (q.some((e) => e.idempotencyKey === b.idempotencyKey)) return;
  writeQueue([...q, b]);
}

export type ReplayResult = { sent: number; refused: number; expired: VitalsBody[]; kept: number };

/** True for a failure that means "no network" (keep the entry), not a server answer (drop it). */
const isNetworkError = (e: unknown): boolean => !(e instanceof ApiError);

let replaying: Promise<ReplayResult> | null = null;

/**
 * Sends what is queued, oldest taken first. A 2xx or any server answer (a refusal) removes the entry; a network error
 * keeps it and stops the run. Entries taken more than 30 minutes ago are removed unsent and returned as `expired`.
 */
export function replayVitals(now: Date = new Date(), send: (b: VitalsBody) => Promise<unknown> = sendVitals): Promise<ReplayResult> {
  if (replaying !== null) return replaying;
  replaying = (async () => {
    const res: ReplayResult = { sent: 0, refused: 0, expired: [], kept: 0 };
    const limit = now.getTime() - OFFLINE_QUEUE_MINUTES * 60_000;
    const all = readQueue().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    res.expired = all.filter((e) => new Date(e.observedAt).getTime() < limit);
    let pending = all.filter((e) => new Date(e.observedAt).getTime() >= limit);
    writeQueue(pending);
    for (const e of [...pending]) {
      try {
        await send(e);
        res.sent += 1;
      } catch (err) {
        if (isNetworkError(err)) break;
        res.refused += 1;
      }
      pending = pending.filter((p) => p.idempotencyKey !== e.idempotencyKey);
      writeQueue(pending);
    }
    res.kept = pending.length;
    return res;
  })().finally(() => { replaying = null; });
  return replaying;
}

/** Records a set now, or queues it when the network is gone. */
export async function saveVitals(b: VitalsBody): Promise<{ queued: true } | { queued: false; result: VitalsResult }> {
  if (globalThis.navigator?.onLine === false) { queueVitals(b); return { queued: true }; }
  try {
    return { queued: false, result: await sendVitals(b) };
  } catch (e) {
    if (isNetworkError(e)) { queueVitals(b); return { queued: true }; }
    throw e;
  }
}

/** The queue's live length, the "expired" sets of the last replay, and a replay on `online`. */
export function useVitalsQueue(): { queued: number; expired: VitalsBody[]; replay: () => void } {
  const [queued, setQueued] = useState(() => readQueue().length);
  const [expired, setExpired] = useState<VitalsBody[]>([]);
  const replay = useCallback(() => {
    if (readQueue().length === 0) return;
    void replayVitals().then((r) => { if (r.expired.length > 0) setExpired((x) => [...x, ...r.expired]); }, () => undefined);
  }, []);
  useEffect(() => {
    const on = (): void => setQueued(readQueue().length);
    listeners.add(on);
    window.addEventListener("online", replay);
    return () => { listeners.delete(on); window.removeEventListener("online", replay); };
  }, [replay]);
  return { queued, expired, replay };
}

/** test seam */
export function resetVitalsQueueForTests(): void {
  try { globalThis.localStorage?.removeItem(QUEUE_KEY); } catch { /* ignore */ }
  replaying = null;
}
