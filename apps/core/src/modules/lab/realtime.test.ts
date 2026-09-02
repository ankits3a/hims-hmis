import { LAB_EVENTS } from "./events";
import { LAB_BENCH_NAMES, LAB_BENCH_TOPIC, LAB_REALTIME_NAMES, labTopicsFor } from "./realtime";

/**
 * ═══ PLAN 17c T3 — EVERY ROUTED NAME PRODUCES A TOPIC, and the six produce the bench's ═══
 *
 * 17b F43: six of sixteen names could never produce a topic, so a bench could not see a tube
 * arrive. Here each name in the router is fed a payload of the shape its schema declares, and
 * `[]` — the silent failure — is the kill.
 */
describe("the laboratory's live topics (17c T3)", () => {
  it("routes sixteen names, and no routed name is outside the event catalogue", () => {
    expect(LAB_REALTIME_NAMES).toHaveLength(16);
    const declared = new Set(LAB_EVENTS.map((e) => e.name));
    for (const name of LAB_REALTIME_NAMES) expect(declared.has(name)).toBe(true);
  });

  it("the six tube-and-result events route to the group AND to `lab:bench` — never to `[]`", () => {
    for (const name of LAB_BENCH_NAMES) {
      const topics = labTopicsFor({ name, payload: { orderGroupId: "g-1", specimenId: "s-1" } });
      expect({ name, topics }).toEqual({ name, topics: ["lab:g-1", LAB_BENCH_TOPIC] }); // THE KILL: `[]`
    }
  });

  it("MUTANT — a payload without the group produces NOTHING for the group, which is the 17b defect", () => {
    const topics = labTopicsFor({ name: "lab.specimen_collected", payload: { specimenId: "s-1" } });
    expect(topics).toEqual([LAB_BENCH_TOPIC]);
  });

  it("a critical goes to the group and to the department's critical space; a report goes to the group alone", () => {
    expect(labTopicsFor({ name: "lab.result_critical_flagged", payload: { orderGroupId: "g-1" } }))
      .toEqual(["lab:g-1", "lab_critical"]);
    expect(labTopicsFor({ name: "lab.report_published", payload: { orderGroupId: "g-1" } })).toEqual(["lab:g-1"]);
    expect(labTopicsFor({ name: "lab.report_published", payload: { orderGroupId: "g-1" } })).not.toContain(LAB_BENCH_TOPIC);
  });

  it("the six payloads are STRUCTURAL — no value and no analyte name crosses the bench topic", () => {
    for (const name of LAB_BENCH_NAMES) {
      const schema = LAB_EVENTS.find((e) => e.name === name)!;
      const keys = Object.keys((schema.payloadSchema as unknown as { shape: Record<string, unknown> }).shape);
      /** Pass 1 F4 widened this census: a FLAG beside an analyte id is a result. */
      expect({ name, leaks: keys.filter((k) => /value|flag|analyteCode|nameEn|pathologistReviewPending/.test(k)) }).toEqual({ name, leaks: [] });
    }
  });
});
