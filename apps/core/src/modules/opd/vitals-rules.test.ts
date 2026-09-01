import { DEFAULT_DANGER_RANGES } from "./config";
import {
  bandFor, evaluateVitals, inputToReadings, missingRequired, muacZone, readingsToInput, validateVitalsRanges,
} from "./vitals-rules";
import { VITAL_KEYS } from "./config";
import type { Readings } from "./vitals-rules";

const cfg = DEFAULT_DANGER_RANGES;
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("vitals rules (pure)", () => {
  it("bandFor: exclusive upper bounds; unknown age → adult", () => {
    expect([0, 1, 5, 6, 12, 13, 40, null].map((a) => bandFor(a, cfg).key)).toEqual([
      "infant", "child_1_5", "child_1_5", "child_6_12", "child_6_12", "adult", "adult", "adult",
    ]);
  });
  it("missingRequired: the band's list, plus weight under 18", () => {
    expect(missingRequired({}, 40, cfg)).toEqual(["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"]);
    expect(missingRequired(adultOk, 40, cfg)).toEqual([]);
    // VD-1 T1 / D5 — MUAC joined both under-six bands' required lists, so these two rows moved.
    // The change is the point of the task and is asserted directly below; they are updated here
    // rather than relaxed, so the list this file documents stays exact.
    expect(missingRequired({ heightCm: 90, tempC: 37, spo2: 98, pulse: 100 }, 3, cfg)).toEqual(["weightKg", "muacCm"]);
    expect(missingRequired({ weightKg: 4.2, tempC: 37, spo2: 98, pulse: 120 }, 0, cfg)).toEqual(["muacCm"]);
    expect(missingRequired({ ...adultOk, weightKg: undefined }, 17, cfg)).toEqual(["weightKg"]); // the under-18 rule
    expect(missingRequired({ ...adultOk }, null, cfg)).toEqual([]); // unknown DOB: adult list, no age rule
  });
  it("evaluateVitals: inclusive bounds; each breach names vital, value, bound, limit", () => {
    const adult = bandFor(40, cfg);
    expect(evaluateVitals({ ...adultOk, sbp: 190 }, adult)).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180, severity: "danger" }]);
    expect(evaluateVitals({ ...adultOk, sbp: 180 }, adult)).toEqual([]);
    expect(evaluateVitals({ ...adultOk, sbp: 89 }, adult)).toEqual([{ vital: "sbp", value: 89, bound: "min", limit: 90, severity: "danger" }]);
    expect(evaluateVitals({ ...adultOk, spo2: 89 }, adult)).toEqual([{ vital: "spo2", value: 89, bound: "min", limit: 90, severity: "danger" }]);
    expect(evaluateVitals({ ...adultOk, tempC: 39.5 }, adult)).toEqual([]);
    expect(evaluateVitals({ ...adultOk, tempC: 39.6 }, adult)).toEqual([{ vital: "tempC", value: 39.6, bound: "max", limit: 39.5, severity: "danger" }]);
    expect(evaluateVitals({ ...adultOk, sbp: 200, spo2: 85 }, adult)).toHaveLength(2);
    expect(evaluateVitals({ pulse: 85 }, bandFor(0, cfg))).toEqual([{ vital: "pulse", value: 85, bound: "min", limit: 90, severity: "danger" }]);
    expect(evaluateVitals({ sbp: 141 }, bandFor(8, cfg))).toEqual([{ vital: "sbp", value: 141, bound: "max", limit: 140, severity: "danger" }]);
    expect(evaluateVitals({ rr: 31 }, adult)).toEqual([{ vital: "rr", value: 31, bound: "max", limit: 30, severity: "danger" }]); // optional field, still evaluated when present
  });
  it("validateVitalsRanges refuses implausible readings", () => {
    expect(() => validateVitalsRanges({ ...adultOk, spo2: 101 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges({ ...adultOk, tempC: 50 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges(adultOk)).not.toThrow();
  });
});

/**
 * ═══ VD-1 T1 — THE READING ═══
 *
 * Three properties, and each one is the reason a column was added rather than a restatement of
 * what the code does: the pair survives storage, "not routine" is not "out of range", and MUAC is
 * demanded exactly where a four-year-old is and nowhere else.
 */
describe("VD-1 T1 — the reading model", () => {
  it("readingsToInput: the OPERATIVE take is the LAST one, and the first is not lost", () => {
    const restAndRecheck: Readings = {
      bp: { takes: [[172, 104], [146, 88]], source: "device" },
      pulse: { takes: [86, 80], source: "device" },
      spo2: { takes: [96], source: "device", held: [45] },
    };
    expect(readingsToInput(restAndRecheck)).toEqual({ sbp: 146, dbp: 88, pulse: 80, spo2: 96 });
    // The pair itself is untouched by the derivation — no average has anywhere to be written.
    expect(restAndRecheck.bp!.takes).toEqual([[172, 104], [146, 88]]);
    expect(restAndRecheck.spo2!.held).toEqual([45]);
  });

  it("inputToReadings: a flat body becomes ONE typed take per vital, sbp/dbp folded into bp", () => {
    expect(inputToReadings({ sbp: 120, dbp: 80, weightKg: 60, notes: "x" })).toEqual({
      bp: { takes: [[120, 80]], source: "typed" },
      weightKg: { takes: [60], source: "typed" },
    });
    // A half-supplied BP is not a measurement and does not become one.
    expect(inputToReadings({ sbp: 120 })).toEqual({});
    expect(readingsToInput(inputToReadings(adultOk))).toEqual(
      expect.objectContaining({ sbp: 120, dbp: 80, weightKg: 60, heightCm: 165 }),
    );
  });

  it("notRoutine: an under-five BP is recorded and NOT flagged, while its SpO2 still is", () => {
    const child = bandFor(4, cfg);
    expect(child.notRoutine).toEqual(["sbp", "dbp"]);
    // 130/85 is inside the child band's own limits; 131/86 is outside them and still not flagged.
    expect(evaluateVitals({ sbp: 131, dbp: 86 }, child, cfg)).toEqual([]);
    expect(evaluateVitals({ sbp: 131, dbp: 86, spo2: 88 }, child, cfg))
      .toEqual([{ vital: "spo2", value: 88, bound: "min", limit: 90, severity: "danger" }]);
    // The same numbers on a six-year-old ARE flagged — the rule is the band's, not the value's.
    expect(evaluateVitals({ sbp: 141 }, bandFor(8, cfg), cfg)).toHaveLength(1);
  });

  it("MUAC: banded SAM / MAM / green, flagged at the zone actually breached", () => {
    const child = bandFor(4, cfg);
    expect(evaluateVitals({ muacCm: 11.4 }, child, cfg)).toEqual([{ vital: "muacCm", value: 11.4, bound: "min", limit: 11.5, severity: "danger" }]);
    expect(evaluateVitals({ muacCm: 12.4 }, child, cfg)).toEqual([{ vital: "muacCm", value: 12.4, bound: "min", limit: 12.5, severity: "danger" }]);
    expect(evaluateVitals({ muacCm: 12.5 }, child, cfg)).toEqual([]);
    expect([11.4, 12.4, 13.4].map((m) => muacZone(m, cfg))).toEqual(["sam", "mam", "green"]);
  });

  it("missingRequired: MUAC under six, never over; emergency trims; a carried key is not missing", () => {
    expect(missingRequired({}, 4, cfg)).toContain("muacCm");
    expect(missingRequired({}, 6, cfg)).not.toContain("muacCm");
    expect(missingRequired({}, 40, cfg)).not.toContain("muacCm");
    // D11 — a declared emergency needs BP + pulse + SpO2 and nothing else.
    expect(missingRequired({}, 40, cfg, { emergency: true })).toEqual(["sbp", "dbp", "spo2", "pulse"]);
    expect(missingRequired({ sbp: 208, dbp: 126, pulse: 104, spo2: 95 }, 40, cfg, { emergency: true })).toEqual([]);
    // D7 — a height carried from March is PRESENT on the chart; it was simply not measured today.
    expect(missingRequired({ ...adultOk, heightCm: undefined }, 40, cfg)).toEqual(["heightCm"]);
    expect(missingRequired({ ...adultOk, heightCm: undefined }, 40, cfg, { carriedForward: ["heightCm"] })).toEqual([]);
  });

  it("the key list and the render order agree — a vital in one and not the other is invisible", () => {
    expect(missingRequired({}, 4, cfg).every((k) => (VITAL_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(() => validateVitalsRanges({ muacCm: 3 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges({ muacCm: 11.0 })).not.toThrow();
  });

  /**
   * ═══ VD-1 CLOSE / F1 — THE PAEDIATRIC FEVER NOTICE ═══
   *
   * Aarav Kumar, 4, 38.9 °C. Demo story 6 requires that his fever reach the doctor AHEAD OF THE
   * CALL. Before this, `child_1_5`'s danger band tops out at 39.5, so 38.9 produced **nothing** —
   * no flag, no event, nothing on any screen. No test caught it because every paediatric
   * temperature in this phase's suites was 37.2, which is in band under both the right rule and
   * the wrong one: *every assertion that touched it checked a state where the two agree.*
   *
   * Found by reading the signed-off contract clause by clause against the shipped code, which is
   * the technique the 18a lane used the same day to find two defects behind 343 green tests.
   */
  it("F1: a 4-year-old at 38.9 is FLAGGED to the doctor — and the flag does not move the queue", () => {
    const child = bandFor(4, cfg);
    const flags = evaluateVitals({ tempC: 38.9 }, child, cfg);
    expect(flags).toEqual([{ vital: "tempC", value: 38.9, bound: "max", limit: 37.9, severity: "notice" }]);
    // The whole point: nothing here is a danger, so nothing here reaches `opd_queue_entries.danger`.
    expect(flags.filter((f) => f.severity !== "notice")).toEqual([]);
  });

  it("F1: the boundary is the clinical one — 38.0 is a fever, 37.9 is not", () => {
    const child = bandFor(4, cfg);
    expect(evaluateVitals({ tempC: 37.9 }, child, cfg)).toEqual([]);
    expect(evaluateVitals({ tempC: 38.0 }, child, cfg)).toHaveLength(1);
  });

  it("F1: a real paediatric danger stays a danger, and is not ALSO reported as a notice", () => {
    const child = bandFor(4, cfg);
    const flags = evaluateVitals({ tempC: 40.2 }, child, cfg);
    // One fact, not two: the notice pass skips a vital that already produced a danger flag.
    expect(flags).toEqual([{ vital: "tempC", value: 40.2, bound: "max", limit: 39.5, severity: "danger" }]);
  });

  it("F1: the notice is PAEDIATRIC — an adult at 38.2 is an ordinary chart finding", () => {
    expect(evaluateVitals({ tempC: 38.2 }, bandFor(40, cfg), cfg)).toEqual([]);
    expect(evaluateVitals({ tempC: 38.2 }, bandFor(11, cfg), cfg))
      .toEqual([{ vital: "tempC", value: 38.2, bound: "max", limit: 37.9, severity: "notice" }]);
  });
});
