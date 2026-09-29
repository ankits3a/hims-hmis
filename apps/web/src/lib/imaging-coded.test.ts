import { describe, expect, it } from "vitest";
// The contracts SOURCE by path — the server's one copy — not the package entry (see imaging-coded.ts).
import * as server from "../../../../packages/contracts/src/imaging-coded";
import * as web from "./imaging-coded";

/**
 * PLAN 18-S RS8a — the web's calculators equal the server's over their WHOLE input space: every
 * TI-RADS feature combination (with every subset of foci, at sizes across every threshold), every
 * ASPECTS subset of the ten regions, and every Fleischner row. Not a sample — all of it.
 */
const subsets = <T,>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

describe("imaging coded — the web's copy matches the server's exactly", () => {
  it("the vocabularies are identical", () => {
    expect(web.CODED_SYSTEMS).toEqual(server.CODED_SYSTEMS);
    expect(web.CODED_CATEGORIES).toEqual(server.CODED_CATEGORIES);
    expect(web.CODED_SYSTEM_NAMES).toEqual(server.CODED_SYSTEM_NAMES);
    expect(web.TIRADS_THRESHOLDS).toEqual(server.TIRADS_THRESHOLDS);
    expect(web.ASPECTS_REGIONS).toEqual(server.ASPECTS_REGIONS);
  });

  it("TI-RADS: every combination agrees", () => {
    let n = 0;
    for (const composition of Object.keys(server.TIRADS_COMPOSITION) as (keyof typeof server.TIRADS_COMPOSITION)[]) {
      for (const echogenicity of Object.keys(server.TIRADS_ECHOGENICITY) as (keyof typeof server.TIRADS_ECHOGENICITY)[]) {
        for (const shape of Object.keys(server.TIRADS_SHAPE) as (keyof typeof server.TIRADS_SHAPE)[]) {
          for (const margin of Object.keys(server.TIRADS_MARGIN) as (keyof typeof server.TIRADS_MARGIN)[]) {
            for (const foci of subsets(Object.keys(server.TIRADS_FOCI) as (keyof typeof server.TIRADS_FOCI)[])) {
              for (const sizeCm of [null, 0.4, 0.5, 1.0, 1.4, 1.5, 2.4, 2.5, 4]) {
                const i = { composition, echogenicity, shape, margin, foci, sizeCm };
                expect(web.tiradsScore(i)).toEqual(server.tiradsScore(i));
                n += 1;
              }
            }
          }
        }
      }
    }
    expect(n).toBe(4 * 4 * 2 * 4 * 16 * 9);
  });

  it("ASPECTS: every subset of the ten regions agrees", () => {
    for (const s of subsets(server.ASPECTS_REGIONS)) expect(web.aspectsScore(s)).toBe(server.aspectsScore(s));
  });

  it("Fleischner: every row agrees", () => {
    for (const type of ["solid", "ground_glass", "part_solid"] as const) {
      for (const count of ["single", "multiple"] as const) {
        for (const risk of ["low", "high"] as const) {
          for (const sizeMm of [3, 5.9, 6, 8, 8.1, 12, 29, 30, 45]) {
            for (const solidComponentMm of [null, 4, 6]) {
              const i = { type, count, risk, sizeMm, solidComponentMm };
              expect(web.fleischnerRecommendation(i)).toEqual(server.fleischnerRecommendation(i));
            }
          }
        }
      }
    }
  });

  it("membership and the printed line agree", () => {
    for (const system of server.CODED_SYSTEMS) {
      for (const v of ["0", "1", "4A", "TR4", "LR-TIV", "S", "", 8, 11]) {
        expect(web.isCodedValue(system, v)).toBe(server.isCodedValue(system, v));
        if (v !== "") expect(web.codedLine(system, v)).toBe(server.codedLine(system, v));
      }
    }
  });
});
