import { describe, expect, it } from "vitest";
import { emptyTiles, rangeLabelOf, sourcePillOf, tileDeltaOf } from "./vitals-bay-capture";
import type { Tile, Tiles } from "./vitals-bay-capture";
import type { WirePreStage } from "../lib/opd-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE TILE'S THREE DERIVATIONS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The re-skin of Bay One added a source pill, a range label and a delta line to every capture tile.
 * Two of the three are arithmetic over the PREVIOUS chart, and arithmetic on a monitor across a bay
 * has one property that makes it dangerous: a wrong answer is indistinguishable from a right one.
 * "Jun 132/84 → +26/+12" is exactly as legible when the sign is inverted.
 *
 * So they are pure functions, and this is the file that reads them. The screen tests below in
 * `vitals-bay-capture.test.tsx` prove the tile RENDERS them; these prove they are TRUE.
 */

/** PRE_A's twin, and deliberately the same numbers the build spec's own worked example uses. */
const PRE: WirePreStage = {
  patientId: "P-A", ageYears: 55, band: "adult",
  ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } },
  noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 },
  muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,
  required: ["heightCm", "weightKg", "sbp", "dbp", "pulse", "spo2", "tempC"], notRoutine: [],
  last: { vitalsId: "V-A0", recordedAt: "2026-06-11T04:00:00.000Z", serviceDate: "2026-06-11", heightCm: 151, weightKg: 62, sbp: 132, dbp: 84, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, muacCm: null },
  carryCandidates: ["heightCm"], expectedFlags: [],
};

const withTake = (key: keyof Tiles, take: Tile["takes"][number], over: Partial<Tile> = {}): Tiles => {
  const tiles = emptyTiles();
  tiles[key] = { ...tiles[key], takes: [take], ...over };
  return tiles;
};

describe("sourcePillOf — where the number came from, on the tile", () => {
  it("calls a device-sourced PULSE what it is: a number that rode the cuff", () => {
    /*
      This is the clinically load-bearing one. An oscillometric cuff reports a pulse WITH the
      pressure — one capture, two vitals — so a device pulse beside a device BP is not two
      instruments agreeing. A nurse who reads it as corroboration is reading a single measurement
      twice, and the tile is the only place that can say so.
    */
    expect(sourcePillOf("pulse", "device")).toBe("rodeCuff");
  });

  it("calls every other device reading AUTO", () => {
    expect(sourcePillOf("spo2", "device")).toBe("auto");
    expect(sourcePillOf("bp", "device")).toBe("auto");
  });

  it("distinguishes a counted respiration rate from a typed one", () => {
    /* The RR counter is a nurse and a stopwatch; typed RR is a nurse and a guess. Not the same. */
    expect(sourcePillOf("rr", "counted")).toBe("counted");
    expect(sourcePillOf("rr", "typed")).toBe("typed");
  });
});

describe("rangeLabelOf — the band's own limits, so nobody has to remember the band", () => {
  it("prints a two-bounded range as a range", () => {
    expect(rangeLabelOf("pulse", PRE)).toBe("50–120");
  });

  it("prints a one-bounded range as the bound it actually has", () => {
    /*
      SpO₂ has a floor and no ceiling, and inventing "90–100" would be a fabricated clinical limit
      on a screen a nurse trusts. `≥ 90` is the whole truth.
    */
    expect(rangeLabelOf("spo2", PRE)).toBe("≥ 90");
  });

  it("folds the two BP wire keys into the one tile that shows them", () => {
    expect(rangeLabelOf("bp", PRE)).toBe("90–180 / 60–110");
  });

  it("says nothing when the band says nothing, rather than guessing", () => {
    expect(rangeLabelOf("muacCm", PRE)).toBeNull();
    expect(rangeLabelOf("pulse", null)).toBeNull();
  });
});

describe("tileDeltaOf — the trend, which is the reading a single number cannot give", () => {
  /**
   * ═══ THE WORKED EXAMPLE FROM THE BUILD SPEC, ARITHMETIC AND ALL ═══
   *
   * 158/96 today against 132/84 in June. A 158/96 alone is "high, recheck sometime". A 158/96 that
   * has moved 26 systolic points since the last visit is a different sentence about the same person.
   */
  it("reads 158/96 against June's 132/84 as +26/+12, and marks it hot", () => {
    const d = tileDeltaOf("bp", withTake("bp", [158, 96]).bp, PRE);
    expect(d).toEqual({ serviceDate: "2026-06-11", from: "132/84", delta: "+26/+12", hot: true });
  });

  it("marks a fall as hot too — a pressure that has DROPPED 20 points is not reassuring", () => {
    const d = tileDeltaOf("bp", withTake("bp", [112, 74]).bp, PRE);
    expect(d?.delta).toBe("-20/-10");
    expect(d?.hot).toBe(true);
  });

  /**
   * The thresholds are asymmetric on purpose (>15 systolic, >10 diastolic): systolic wanders more
   * across a day, a cuff and a season. These two cases sit either side of the diastolic line and
   * are the reason the rule is not "either moved by 15".
   */
  it("leaves an ordinary day's drift cool: 15 systolic and 10 diastolic are both within tolerance", () => {
    expect(tileDeltaOf("bp", withTake("bp", [147, 94]).bp, PRE)?.hot).toBe(false);
  });

  it("goes hot on 11 diastolic points even though systolic barely moved", () => {
    const d = tileDeltaOf("bp", withTake("bp", [134, 95]).bp, PRE);
    expect(d?.delta).toBe("+2/+11");
    expect(d?.hot).toBe(true);
  });

  it("carries one decimal for a vital that has one, and does not invent float noise", () => {
    /* 37.4 − 36.8 is 0.6000000000000014 in IEEE 754. A tile that prints that is a broken tile. */
    expect(tileDeltaOf("tempC", withTake("tempC", 37.4).tempC, PRE)?.delta).toBe("+0.6");
  });

  it("shows a scalar's previous value and its movement", () => {
    expect(tileDeltaOf("pulse", withTake("pulse", 82).pulse, PRE)).toEqual({
      serviceDate: "2026-06-11", from: "78", delta: "+4", hot: false,
    });
  });

  it("is silent for a first visit, an untaken tile, and a vital the last chart did not carry", () => {
    expect(tileDeltaOf("bp", withTake("bp", [158, 96]).bp, { ...PRE, last: null })).toBeNull();
    expect(tileDeltaOf("pulse", emptyTiles().pulse, PRE)).toBeNull();
    /* MUAC was null on the last chart — there is no delta, and "0" would be a lie. */
    expect(tileDeltaOf("muacCm", withTake("muacCm", 12.1).muacCm, PRE)).toBeNull();
  });
});
