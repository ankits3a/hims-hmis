import { hkInspectionScore, hkMonthOf, hkMonthWindow } from "@hmis/contracts";
import { istMidnights } from "../ipd";
import { median, p90 } from "./reports";

/** HK-2 (#974) — the pure pieces of the reports: percentiles, the IST month, the midnight census, the inspection score. */
describe("HK-2 report arithmetic", () => {
  it("median takes the middle (the mean of the two middles, rounded) and p90 the nearest rank", () => {
    expect(median([])).toBeNull();
    expect(median([40, 20])).toBe(30);
    expect(median([5, 1, 9])).toBe(5);
    expect(p90([])).toBeNull();
    expect(p90([20, 40])).toBe(40);
    expect(p90(Array.from({ length: 10 }, (_, i) => i + 1))).toBe(9);
    expect(p90(Array.from({ length: 11 }, (_, i) => i + 1))).toBe(10);
  });

  it("an IST month runs 00:00 IST to 00:00 IST, and the month of an instant is read in IST", () => {
    const { start, end } = hkMonthWindow("2024-02");
    expect(start.toISOString()).toBe("2024-01-31T18:30:00.000Z");
    expect(end.toISOString()).toBe("2024-02-29T18:30:00.000Z");
    expect(hkMonthOf(new Date("2024-01-31T18:29:59.000Z"))).toBe("2024-01");
    expect(hkMonthOf(new Date("2024-01-31T18:30:00.000Z"))).toBe("2024-02");
    expect(hkMonthWindow("2024-12").end.toISOString()).toBe("2024-12-31T18:30:00.000Z");
  });

  it("the midnight census counts each 00:00 IST in the window, never one after now", () => {
    const { start, end } = hkMonthWindow("2024-02");
    expect(istMidnights(start, end, new Date("2030-01-01T00:00:00Z"))).toHaveLength(29);
    // Partway through: the 1st's and 2nd's midnights only.
    expect(istMidnights(start, end, new Date("2024-02-02T00:00:00Z")).map((d) => d.toISOString()))
      .toEqual(["2024-01-31T18:30:00.000Z", "2024-02-01T18:30:00.000Z"]);
  });

  it("an inspection's score is the whole-per-cent share of Yes", () => {
    expect(hkInspectionScore([])).toBe(0);
    expect(hkInspectionScore([{ ok: true }, { ok: true }, { ok: true }, { ok: false }])).toBe(75);
    expect(hkInspectionScore([{ ok: true }, { ok: false }, { ok: false }])).toBe(33);
  });
});
