import { ApiError } from "./api";
import {
  outOfLimits, queueVitals, queuedVitals, replayVitals, resetVitalsQueueForTests, saveVitals, vitalsBody,
} from "./ipd-nursing-api";
import type { VitalsBody } from "./ipd-nursing-api";

/*
  E4.1 (#733) — the offline vitals queue (spec §0B "Offline"): vitals only, stamped with the time taken, sent once by
  their key, dropped unsent after 30 minutes. Every id is synthetic (`01FAKE…`).
*/
const ADM = "01FAKE00000000000000000001";
const minAgo = (m: number, now: Date): Date => new Date(now.getTime() - m * 60_000);

beforeEach(() => { resetVitalsQueueForTests(); });
afterEach(() => { vi.unstubAllGlobals(); resetVitalsQueueForTests(); });

describe("offline vitals queue (E4.1)", () => {
  it("mints the key and the time taken once; a refused set carries no values", () => {
    const at = new Date("2030-01-01T04:30:00.000Z");
    const b = vitalsBody(ADM, { pulse: 88 }, { at });
    expect(b.observedAt).toBe(at.toISOString());
    expect(b.idempotencyKey).toMatch(/^[0-9a-f-]{32,36}$/);
    const r = vitalsBody(ADM, { pulse: 88 }, { refused: true });
    expect(r.values).toEqual({});
    expect(r.refused).toBe(true);
  });

  it("adds a set once by its key", () => {
    const b = vitalsBody(ADM, { pulse: 80 });
    queueVitals(b); queueVitals(b);
    expect(queuedVitals()).toHaveLength(1);
  });

  it("replays oldest-taken first and empties the queue on 2xx", async () => {
    const now = new Date();
    const late = vitalsBody(ADM, { pulse: 90 }, { at: minAgo(2, now) });
    const early = vitalsBody(ADM, { pulse: 70 }, { at: minAgo(10, now) });
    queueVitals(late); queueVitals(early);
    const sent: VitalsBody[] = [];
    const r = await replayVitals(now, async (b) => { sent.push(b); return {}; });
    expect(sent.map((b) => b.values.pulse)).toEqual([70, 90]);
    expect(sent[0]!.idempotencyKey).toBe(early.idempotencyKey);
    expect(r).toMatchObject({ sent: 2, refused: 0, kept: 0 });
    expect(queuedVitals()).toEqual([]);
  });

  it("drops sets older than 30 minutes unsent and reports them as expired", async () => {
    const now = new Date();
    const old = vitalsBody(ADM, { pulse: 60 }, { at: minAgo(31, now) });
    const fresh = vitalsBody(ADM, { pulse: 61 }, { at: minAgo(29, now) });
    queueVitals(old); queueVitals(fresh);
    const sent: string[] = [];
    const r = await replayVitals(now, async (b) => { sent.push(b.idempotencyKey); return {}; });
    expect(sent).toEqual([fresh.idempotencyKey]);
    expect(r.expired.map((e) => e.idempotencyKey)).toEqual([old.idempotencyKey]);
    expect(queuedVitals()).toEqual([]);
  });

  it("keeps the set on a network error and drops it on a server refusal", async () => {
    const now = new Date();
    const a = vitalsBody(ADM, { pulse: 50 }, { at: minAgo(5, now) });
    const b = vitalsBody(ADM, { pulse: 51 }, { at: minAgo(4, now) });
    queueVitals(a); queueVitals(b);
    const r1 = await replayVitals(now, async () => { throw new TypeError("Failed to fetch"); });
    expect(r1).toMatchObject({ sent: 0, kept: 2 });
    expect(queuedVitals()).toHaveLength(2);
    const r2 = await replayVitals(now, async (x) => {
      if (x.idempotencyKey === a.idempotencyKey) throw new ApiError(409, { code: "admission_wrong_state", rule: "r", fix: "f" });
      return {};
    });
    expect(r2).toMatchObject({ sent: 1, refused: 1, kept: 0 });
  });

  it("saveVitals queues when the browser is offline and when the network fails", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const r = await saveVitals(vitalsBody(ADM, { pulse: 77 }));
    expect(r).toEqual({ queued: true });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const r2 = await saveVitals(vitalsBody(ADM, { pulse: 78 }));
    expect(r2).toEqual({ queued: true });
    expect(queuedVitals()).toHaveLength(2);
  });

  it("asks to confirm values outside the physiological limits, and a systolic not above the diastolic", () => {
    expect(outOfLimits({ pulse: 88, spo2: 97 })).toEqual([]);
    expect(outOfLimits({ pulse: 250 })).toEqual(["pulse"]);
    expect(outOfLimits({ temperatureC: 33.5, spo2: 60 }).sort()).toEqual(["spo2", "temperatureC"]);
    expect(outOfLimits({ systolic: 80, diastolic: 90 })).toEqual(["systolic"]);
  });
});
