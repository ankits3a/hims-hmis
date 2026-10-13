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

// Both reads carry the server's `asOf`: the phone's clock offset is taken from it (review 8, `serverNow`).
export const getStation = (wardId?: string | null): Promise<IpdNurseStation> =>
  api<IpdNurseStation>("GET", q(R.station, wardId)).then((s) => { noteServerTime(s.asOf); return s; });
export const getMyShift = (wardId?: string | null): Promise<IpdMyShift> =>
  api<IpdMyShift>("GET", q(R.myShift, wardId)).then((s) => { noteServerTime(s.asOf); return s; });
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
  vitalsId: string; score: { kind: IpdEwsKind; value: number; band: IpdEwsBand } | null; alertRaised: boolean;
  /** False when this set raised an alert and no doctor could be told (the phone says "No doctor reached — call"). */
  doctorReached?: boolean | null; lateEntry: boolean;
};

/** Mints the body ONCE: the key and the time taken travel with it through any queueing and replay. */
export function vitalsBody(admissionId: string, values: VitalsValues, opts: { refused?: boolean; confirmed?: boolean; at?: Date } = {}): VitalsBody {
  const b: VitalsBody = {
    idempotencyKey: newIdempotencyKey(), admissionId, observedAt: (opts.at ?? serverNow()).toISOString(), source: "person",
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
export const acknowledgeEws = (alertId: string, note?: string): Promise<unknown> =>
  post(R.acknowledgeEws, note === undefined || note.trim() === "" ? { alertId } : { alertId, note: note.trim() });

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

// ═══════════════════════════════════════════ the server's clock ═══════════════════════════════════════════

/**
 * E4.1 review — THE PHONE'S CLOCK IS NOT TRUSTED (§4.10 edge 18). Every station / my-shift read carries the server's
 * `asOf`; the offset to it is remembered here, and both the time a set is stamped with and the 30-minute queue expiry
 * read `serverNow()`, so a phone set ten minutes fast neither stamps the future nor expires a set early.
 */
let serverOffsetMs = 0;
export function noteServerTime(asOf: string, localNow: number = Date.now()): void {
  const t = Date.parse(asOf);
  if (Number.isFinite(t)) serverOffsetMs = t - localNow;
}
export function serverNow(localNow: number = Date.now()): Date { return new Date(localNow + serverOffsetMs); }

// ═══════════════════════════════════════════ the offline vitals queue ═══════════════════════════════════════════

const QUEUE_KEY = "hmis.ipd.vitalsQueue.v1";

/** A queued set: the exact body the server receives, plus a local label (never sent) to name it if it is dropped. */
export type QueuedVitals = VitalsBody & { queueLabel?: string };

function readQueue(): QueuedVitals[] {
  try {
    const raw = globalThis.localStorage?.getItem(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as QueuedVitals[]) : [];
  } catch { return []; }
}
function writeQueue(q: QueuedVitals[]): void {
  try { globalThis.localStorage?.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* private window: queue lives in memory only */ }
  for (const l of listeners) l();
}
/**
 * REVIEW 6 — never write back a stale copy: every change RE-READS storage and removes only the keys it was asked to,
 * so a set queued by another tab (or by this screen) while a replay was waiting on the network is never lost.
 */
function removeFromQueue(keys: readonly string[]): void {
  if (keys.length === 0) return;
  const drop = new Set(keys);
  writeQueue(readQueue().filter((e) => !drop.has(e.idempotencyKey)));
}
const listeners = new Set<() => void>();

export function queuedVitals(): QueuedVitals[] { return readQueue(); }

/** Adds a set once (by its key). Vitals only — the type admits nothing else. `label` names the patient if it is dropped. */
export function queueVitals(b: VitalsBody, label?: string): void {
  const q = readQueue();
  if (q.some((e) => e.idempotencyKey === b.idempotencyKey)) return;
  writeQueue([...q, label === undefined ? b : { ...b, queueLabel: label }]);
}

/** A set that will not be sent: the nurse is told which (time taken, patient) and to record it on paper. */
export type DroppedVitals = { body: QueuedVitals; reason: "expired" | "refused"; code?: string };
export type ReplayResult = { sent: number; dropped: DroppedVitals[]; kept: number };

/**
 * REVIEW 5 — only a FINAL business refusal drops a set: a 4xx other than 408 (timeout) and 429 (slow down). A network
 * error, a 5xx, a 408 or a 429 keeps it for the next replay.
 */
export function isFinalRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

let replaying: Promise<ReplayResult> | null = null;

const strip = (e: QueuedVitals): VitalsBody => {
  const body: QueuedVitals = { ...e };
  delete body.queueLabel;
  return body;
};

/**
 * Sends what is queued, oldest taken first. A 2xx removes the entry; a final refusal removes it and names it in
 * `dropped`; anything else (offline, 5xx, 429) keeps it and stops the run. Sets taken more than 30 minutes ago (by the
 * SERVER's clock) are not sent: they are dropped and named, to be charted on paper.
 */
export function replayVitals(now: Date = serverNow(), send: (b: VitalsBody) => Promise<unknown> = sendVitals): Promise<ReplayResult> {
  if (replaying !== null) return replaying;
  replaying = (async () => {
    const res: ReplayResult = { sent: 0, dropped: [], kept: 0 };
    const limit = now.getTime() - OFFLINE_QUEUE_MINUTES * 60_000;
    const all = readQueue().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const expired = all.filter((e) => new Date(e.observedAt).getTime() < limit);
    res.dropped.push(...expired.map((body) => ({ body, reason: "expired" as const })));
    removeFromQueue(expired.map((e) => e.idempotencyKey));
    for (const e of all.filter((x) => new Date(x.observedAt).getTime() >= limit)) {
      try {
        await send(strip(e));
        res.sent += 1;
      } catch (err) {
        if (!isFinalRefusal(err)) break;
        const code = (err as ApiError).body as { code?: unknown } | null;
        res.dropped.push({ body: e, reason: "refused", ...(typeof code?.code === "string" ? { code: code.code } : {}) });
      }
      removeFromQueue([e.idempotencyKey]);
    }
    res.kept = readQueue().length;
    return res;
  })().finally(() => { replaying = null; });
  return replaying;
}

/** Records a set now, or queues it when the network (or the server) is not there. A final refusal is the caller's. */
export async function saveVitals(b: VitalsBody, label?: string): Promise<{ queued: true } | { queued: false; result: VitalsResult }> {
  if (globalThis.navigator?.onLine === false) { queueVitals(b, label); return { queued: true }; }
  try {
    return { queued: false, result: await sendVitals(b) };
  } catch (e) {
    if (!isFinalRefusal(e)) { queueVitals(b, label); return { queued: true }; }
    throw e;
  }
}

/**
 * Sets dropped by any replay, NAMED until the nurse taps Done. Module-level, not per hook: the replay runs in the live
 * loader's hook and the list is shown by the live line's (a per-hook list was never seen — found on the browser walk).
 */
let droppedStore: DroppedVitals[] = [];
function addDropped(d: readonly DroppedVitals[]): void {
  if (d.length === 0) return;
  droppedStore = [...droppedStore, ...d];
  for (const l of listeners) l();
}

/** The queue's live length, the sets dropped by replays (named), and a replay on `online`. */
export function useVitalsQueue(): { queued: number; dropped: DroppedVitals[]; replay: () => void; clearDropped: () => void } {
  const [queued, setQueued] = useState(() => readQueue().length);
  const [dropped, setDropped] = useState<DroppedVitals[]>(() => droppedStore);
  const replay = useCallback(() => {
    if (readQueue().length === 0) return;
    void replayVitals().then((r) => addDropped(r.dropped), () => undefined);
  }, []);
  const clearDropped = useCallback(() => { droppedStore = []; for (const l of listeners) l(); }, []);
  useEffect(() => {
    const on = (): void => { setQueued(readQueue().length); setDropped(droppedStore); };
    listeners.add(on);
    window.addEventListener("online", replay);
    return () => { listeners.delete(on); window.removeEventListener("online", replay); };
  }, [replay]);
  return { queued, dropped, replay, clearDropped };
}

/** test seam */
export function resetVitalsQueueForTests(): void {
  try { globalThis.localStorage?.removeItem(QUEUE_KEY); } catch { /* ignore */ }
  replaying = null;
  serverOffsetMs = 0;
  droppedStore = [];
}
