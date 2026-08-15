import fc from "fast-check";
import { classOf, nextInQueue, orderQueue } from "./queue-engine";
import type { QueueEntryState } from "./queue-engine";

const T = (hhmmIst: string) => new Date(`2026-08-17T${hhmmIst}:00.000+05:30`); // IST wall clock → instant
const NOW = T("10:00");
const NONE = { perkEveryNth: null };
const e = (over: Partial<QueueEntryState> & { id: string; seq: number }): QueueEntryState => ({
  tokenNo: over.seq, kind: "walk_in", appointmentAt: null, eligibleAt: T("09:00"), danger: false, reEntry: false, perk: false, skips: 0, ...over,
});

describe("orderQueue — §11.1 discipline, hand-derived", () => {
  const A = e({ id: "A", seq: 1, eligibleAt: T("09:00") });                                        // walk-in, first to be eligible
  const B = e({ id: "B", seq: 2, kind: "appointment", appointmentAt: T("09:50"), eligibleAt: T("09:45") }); // due (late by 10 min)
  const C = e({ id: "C", seq: 3, kind: "appointment", appointmentAt: T("10:20"), eligibleAt: T("09:30") }); // FUTURE (arrived early)
  const D = e({ id: "D", seq: 4, eligibleAt: T("09:10"), danger: true });                          // danger vitals
  const E = e({ id: "E", seq: 5, eligibleAt: T("09:55"), reEntry: true });                         // back from the lab
  const F = e({ id: "F", seq: 6, eligibleAt: T("09:05"), skips: 1 });                              // walk-in
  const G = e({ id: "G", seq: 7, kind: "appointment", appointmentAt: T("09:30"), eligibleAt: T("09:58") }); // due (very late), earlier slot than B

  it("D E G B A F C: danger, re-entry, due appointments by slot, walk-ins FIFO, future appointment last", () => {
    expect(orderQueue([A, B, C, D, E, F, G], NOW, NONE, 0).map((x) => x.id)).toEqual(["D", "E", "G", "B", "A", "F", "C"]);
    expect(nextInQueue([A, B, C, D, E, F, G], NOW, NONE, 0)!.id).toBe("D");
  });
  it("classes: D=0 E=1 G=2 B=2 A=3 F=3 C=4; C becomes due at 10:20", () => {
    expect([D, E, G, B, A, F, C].map((x) => classOf(x, NOW))).toEqual([0, 1, 2, 2, 3, 3, 4]);
    expect(classOf(C, T("10:20"))).toBe(2);
    expect(orderQueue([A, C], T("10:20"), NONE, 0).map((x) => x.id)).toEqual(["C", "A"]);
  });
  it("a skipped walk-in re-queued (eligibleAt = now) falls behind the other walk-ins but keeps its token", () => {
    const F2 = { ...F, eligibleAt: T("10:00"), skips: 2 };
    expect(orderQueue([F2, A], NOW, NONE, 0).map((x) => x.id)).toEqual(["A", "F"]);
    expect(F2.tokenNo).toBe(6);
    // …and the token is not the order key: the LOWEST token, once skipped, still falls behind the later-issued one.
    const A2 = { ...A, eligibleAt: T("10:00"), skips: 1 };
    expect(orderQueue([A2, F], NOW, NONE, 0).map((x) => x.id)).toEqual(["F", "A"]);
    expect(A2.tokenNo).toBe(1);
  });
  it("E-32 perk: on the Nth call the earliest perk walk-in heads the walk-ins — never above danger, re-entry or a due appointment", () => {
    const Fp = { ...F, perk: true, eligibleAt: T("09:30") };
    expect(orderQueue([A, Fp, C], NOW, { perkEveryNth: 2 }, 1).map((x) => x.id)).toEqual(["F", "A", "C"]); // (1+1)%2===0 → perk turn
    expect(orderQueue([A, Fp, C], NOW, { perkEveryNth: 2 }, 2).map((x) => x.id)).toEqual(["A", "F", "C"]); // (2+1)%2!==0 → plain
    expect(orderQueue([A, Fp, C, D], NOW, { perkEveryNth: 2 }, 1).map((x) => x.id)).toEqual(["D", "A", "F", "C"]); // danger heads: no promotion
    expect(orderQueue([A, Fp, C, B], NOW, { perkEveryNth: 2 }, 1).map((x) => x.id)).toEqual(["B", "A", "F", "C"]); // due appt heads: no promotion
    expect(orderQueue([A, Fp, C], NOW, { perkEveryNth: 1 }, 0).map((x) => x.id)).toEqual(["F", "A", "C"]); // N=1: every call is a perk turn
    expect(orderQueue([A, Fp, C], NOW, NONE, 1).map((x) => x.id)).toEqual(["A", "F", "C"]);         // hook off (Plan 07 config)
  });
  it("empty → null", () => { expect(nextInQueue([], NOW, NONE, 0)).toBeNull(); });
});

// ——— properties (fast-check) ———
const BASE = Date.parse("2026-08-17T03:30:00.000Z"); // 09:00 IST
const minuteArb = fc.integer({ min: 0, max: 8 * 60 });
const rawEntryArb = fc.record({
  id: fc.uuid(),
  seq: fc.integer({ min: 1, max: 1_000_000 }),
  kind: fc.constantFrom("appointment", "walk_in") as fc.Arbitrary<"appointment" | "walk_in">,
  apptMin: minuteArb, eligibleMin: minuteArb,
  danger: fc.boolean(), reEntry: fc.boolean(), perk: fc.boolean(), skips: fc.nat({ max: 5 }),
});
const entryArb: fc.Arbitrary<QueueEntryState> = rawEntryArb.map((r) => ({
  id: r.id, seq: r.seq, tokenNo: r.seq % 500 + 1, kind: r.kind,
  appointmentAt: r.kind === "appointment" ? new Date(BASE + r.apptMin * 60_000) : null,
  eligibleAt: new Date(BASE + r.eligibleMin * 60_000), danger: r.danger, reEntry: r.reEntry, perk: r.perk, skips: r.skips,
}));
const queueArb = fc.uniqueArray(entryArb, { selector: (x) => x.seq, maxLength: 40 });
const nowArb = minuteArb.map((m) => new Date(BASE + m * 60_000));
const ids = (xs: QueueEntryState[]) => xs.map((x) => x.id);

describe("orderQueue — properties", () => {
  it("P1 is a permutation of its input", () => {
    fc.assert(fc.property(queueArb, nowArb, (q, now) => {
      expect(ids(orderQueue(q, now, NONE, 0)).sort()).toEqual(ids(q).sort());
    }));
  });
  it("P2 classes never decrease along the ordering (danger < re-entry < due appt < walk-in < future appt)", () => {
    fc.assert(fc.property(queueArb, nowArb, (q, now) => {
      const cs = orderQueue(q, now, NONE, 0).map((x) => classOf(x, now));
      for (let i = 1; i < cs.length; i++) expect(cs[i - 1]! <= cs[i]!).toBe(true);
    }));
  });
  it("P3 within a class, eligibleAt (walk-ins/danger/re-entry) or appointmentAt (appointments) never decreases, seq breaks ties", () => {
    fc.assert(fc.property(queueArb, nowArb, (q, now) => {
      const o = orderQueue(q, now, NONE, 0);
      for (let i = 1; i < o.length; i++) {
        const a = o[i - 1]!, b = o[i]!;
        if (classOf(a, now) !== classOf(b, now)) continue;
        const key = (x: QueueEntryState) => (classOf(x, now) === 2 || classOf(x, now) === 4 ? x.appointmentAt!.getTime() : x.eligibleAt.getTime());
        expect(key(a) < key(b) || (key(a) === key(b) && a.seq < b.seq)).toBe(true);
      }
    }));
  });
  it("P4 deterministic under input shuffling", () => {
    fc.assert(fc.property(queueArb, nowArb, fc.array(fc.nat(), { minLength: 40, maxLength: 40 }), (q, now, noise) => {
      const shuffled = [...q].sort((a, b) => (noise[a.seq % 40]! - noise[b.seq % 40]!) || a.seq - b.seq);
      expect(ids(orderQueue(shuffled, now, NONE, 3))).toEqual(ids(orderQueue(q, now, NONE, 3)));
    }));
  });
  it("P5 the perk hook only ever moves ONE class-3 perk entry to the head, only when the plain head is class 3, only on an Nth call; otherwise identical", () => {
    fc.assert(fc.property(queueArb, nowArb, fc.integer({ min: 1, max: 5 }), fc.nat({ max: 20 }), (q, now, n, calls) => {
      const plain = orderQueue(q, now, NONE, calls);
      const perked = orderQueue(q, now, { perkEveryNth: n }, calls);
      const perkTurn = (calls + 1) % n === 0;
      const head = plain[0];
      const candidate = plain.find((x) => x.perk && classOf(x, now) === 3);
      if (!perkTurn || head === undefined || classOf(head, now) !== 3 || candidate === undefined) {
        expect(ids(perked)).toEqual(ids(plain));
      } else {
        expect(perked[0]!.id).toBe(candidate.id);
        expect(ids(perked).filter((i) => i !== candidate.id)).toEqual(ids(plain).filter((i) => i !== candidate.id));
      }
    }));
  });
});
