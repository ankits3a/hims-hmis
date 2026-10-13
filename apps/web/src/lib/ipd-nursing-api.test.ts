import { ApiError } from "./api";
import {
  noteServerTime, outOfLimits, queueVitals, queuedVitals, replayVitals, resetVitalsQueueForTests, saveVitals, serverNow, vitalsBody,
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
    expect(r).toMatchObject({ sent: 2, dropped: [], kept: 0 });
    expect(queuedVitals()).toEqual([]);
  });

  it("drops sets older than 30 minutes unsent and NAMES them (time taken, patient) for paper", async () => {
    const now = new Date();
    const old = vitalsBody(ADM, { pulse: 60 }, { at: minAgo(31, now) });
    const fresh = vitalsBody(ADM, { pulse: 61 }, { at: minAgo(29, now) });
    queueVitals(old, "Test Patient A"); queueVitals(fresh, "Test Patient B");
    const sent: VitalsBody[] = [];
    const r = await replayVitals(now, async (b) => { sent.push(b); return {}; });
    expect(sent.map((b) => b.idempotencyKey)).toEqual([fresh.idempotencyKey]);
    expect(sent[0]).not.toHaveProperty("queueLabel"); // the label never leaves the phone
    expect(r.dropped.map((d) => [d.body.idempotencyKey, d.body.queueLabel, d.body.observedAt, d.reason]))
      .toEqual([[old.idempotencyKey, "Test Patient A", old.observedAt, "expired"]]);
    expect(queuedVitals()).toEqual([]);
  });

  it("keeps the set on a network error and drops (and names) it only on a final 4xx refusal", async () => {
    const now = new Date();
    const a = vitalsBody(ADM, { pulse: 50 }, { at: minAgo(5, now) });
    const b = vitalsBody(ADM, { pulse: 51 }, { at: minAgo(4, now) });
    queueVitals(a, "Test Patient A"); queueVitals(b);
    const r1 = await replayVitals(now, async () => { throw new TypeError("Failed to fetch"); });
    expect(r1).toMatchObject({ sent: 0, kept: 2 });
    expect(queuedVitals()).toHaveLength(2);
    const r2 = await replayVitals(now, async (x) => {
      if (x.idempotencyKey === a.idempotencyKey) throw new ApiError(409, { code: "admission_wrong_state", rule: "r", fix: "f" });
      return {};
    });
    expect(r2).toMatchObject({ sent: 1, kept: 0 });
    expect(r2.dropped).toEqual([{ body: expect.objectContaining({ idempotencyKey: a.idempotencyKey, queueLabel: "Test Patient A" }), reason: "refused", code: "admission_wrong_state" }]);
  });

  it.each([502, 503, 500, 429, 408])("review 5: a %d keeps the set for the next replay", async (status) => {
    const now = new Date();
    const a = vitalsBody(ADM, { pulse: 52 }, { at: minAgo(3, now) });
    queueVitals(a);
    const r = await replayVitals(now, async () => { throw new ApiError(status, { message: "upstream" }); });
    expect(r).toMatchObject({ sent: 0, dropped: [], kept: 1 });
    expect(queuedVitals().map((e) => e.idempotencyKey)).toEqual([a.idempotencyKey]);
  });

  it("review 5: saveVitals queues on a 502 instead of losing the set", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad gateway" }), { status: 502 })));
    const r = await saveVitals(vitalsBody(ADM, { pulse: 79 }), "Test Patient C");
    expect(r).toEqual({ queued: true });
    expect(queuedVitals().map((e) => e.queueLabel)).toEqual(["Test Patient C"]);
  });

  it("review 6: a set queued WHILE a replay waits on the network is not lost", async () => {
    const now = new Date();
    const first = vitalsBody(ADM, { pulse: 60 }, { at: minAgo(3, now) });
    queueVitals(first);
    const late = vitalsBody(ADM, { pulse: 61 }, { at: minAgo(1, now) });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const run = replayVitals(now, async (b) => {
      if (b.idempotencyKey === first.idempotencyKey) await gate; // the network is slow…
      return {};
    });
    queueVitals(late); // …and the nurse saves another set meanwhile
    release();
    const r = await run;
    expect(r.sent).toBe(1);
    expect(queuedVitals().map((e) => e.idempotencyKey)).toEqual([late.idempotencyKey]);
  });

  it("review 8: expiry and the time stamped read the SERVER's clock, not the phone's", async () => {
    const phone = Date.now();
    noteServerTime(new Date(phone - 20 * 60_000).toISOString(), phone); // the phone runs 20 minutes fast
    expect(Math.round((serverNow(phone).getTime() - phone) / 60_000)).toBe(-20);
    const b = vitalsBody(ADM, { pulse: 70 }, { at: new Date(phone - 40 * 60_000) }); // 40 phone-minutes ago = 20 server-minutes ago
    queueVitals(b);
    const r = await replayVitals(undefined, async () => ({}));
    expect(r).toMatchObject({ sent: 1, dropped: [] });
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
