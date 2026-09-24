import { describe, expect, it } from "vitest";
import { briefRefill, briefResults, shortDay } from "./brief-history";
import type { WirePatientDispense, WirePatientImaging, WirePatientResult } from "./brief-history";

/** The board's own example patient (T-12): last seen 12 Aug; an ECG that day, LDL and creatinine on 19 Sep. */
const ldl: WirePatientResult = { orderableName: "Lipid profile", analyteName: "LDL", value: "162", unit: "mg/dL", flag: "H", verifiedAt: "2026-09-19T05:00:00.000Z" };
const creat: WirePatientResult = { orderableName: "KFT", analyteName: "Creatinine", value: "1.0", unit: "mg/dL", flag: null, verifiedAt: "2026-09-19T04:00:00.000Z" };
const hba1c: WirePatientResult = { orderableName: "HbA1c", analyteName: "HbA1c", value: "8.1", unit: "%", flag: "H", verifiedAt: "2026-06-03T05:00:00.000Z" };
const ecg: WirePatientImaging = { studyName: "ECG", impression: "normal sinus rhythm", criticalCategory: null, signedAt: "2026-08-12T08:00:00.000Z" };

describe("briefResults — the board's SINCE THEN · LAB AND RADIOLOGY", () => {
  it("lists what came on or after the last visit's day, newest first, abnormal flagged", () => {
    const r = briefResults([creat, ldl, hba1c], [ecg], "2026-08-12");
    expect(r.noneSince).toBe(false);
    expect(r.lines.map((l) => l.what)).toEqual(["LDL 162 mg/dL", "Creatinine 1.0 mg/dL", "ECG: normal sinus rhythm"]);
    expect(r.lines.map((l) => l.abnormal)).toEqual([true, false, false]);
    expect(r.lines.map((l) => l.kind)).toEqual(["lab", "lab", "radiology"]);
  });

  it("nothing since → the last value on file, marked none since (the board's T-14: HbA1c 8.1 · lab 3 Jun · none since)", () => {
    const r = briefResults([hba1c], [], "2026-09-10");
    expect(r.noneSince).toBe(true);
    expect(r.lines).toEqual([{ what: "HbA1c 8.1 %", kind: "lab", day: "2026-06-03", abnormal: true }]);
  });

  it("a first visit shows what is on file; nothing at all is an empty list", () => {
    expect(briefResults([hba1c], [ecg], null).lines).toHaveLength(2);
    expect(briefResults([], [], "2026-08-12")).toEqual({ lines: [], noneSince: false });
  });

  it("counts the day in IST: a result at 23:30 IST on the last visit's day is 'since then', one at 23:30 IST the day before is not", () => {
    const late = { ...creat, verifiedAt: "2026-08-12T18:00:00.000Z" }; // 12 Aug 23:30 IST
    const before = { ...creat, analyteName: "Urea", verifiedAt: "2026-08-11T18:00:00.000Z" }; // 11 Aug 23:30 IST
    expect(briefResults([late, before], [], "2026-08-12").lines.map((l) => l.what)).toEqual(["Creatinine 1.0 mg/dL"]);
  });

  it("a critical imaging report is abnormal; one with no impression shows the study name", () => {
    const r = briefResults([], [{ studyName: "CT head", impression: null, criticalCategory: "red", signedAt: "2026-09-01T05:00:00.000Z" }], null);
    expect(r.lines[0]).toMatchObject({ what: "CT head", abnormal: true });
  });
});

describe("briefRefill — the board's 'Pharmacy: 30 days bought on 12 Aug · none since (due 11 Sep)'", () => {
  const d = (at: string, days: (number | null)[], rx = "rx-1"): WirePatientDispense => ({
    prescriptionId: rx, handedOverAt: at, lines: days.map((n, i) => ({ drug: `d${String(i)}`, durationDays: n, qtyBase: 10 })),
  });

  it("one purchase: the longest line is the cover, and the due day is the purchase day plus it", () => {
    const r = briefRefill("rx-1", [d("2026-08-12T06:00:00.000Z", [5, 30])]);
    expect(r).toEqual({ kind: "bought", times: 1, lastDay: "2026-08-12", days: 30, dueDay: "2026-09-11" });
    expect(shortDay("2026-08-12")).toBe("12 Aug");
    expect(shortDay("2026-09-11")).toBe("11 Sep");
  });

  it("refills count; only this prescription's dispenses count; no duration means no due day", () => {
    const r = briefRefill("rx-1", [d("2026-08-12T06:00:00.000Z", [30]), d("2026-09-10T06:00:00.000Z", [null]), d("2026-09-15T06:00:00.000Z", [30], "rx-other")]);
    expect(r).toEqual({ kind: "bought", times: 2, lastDay: "2026-09-10", days: null, dueDay: null });
  });

  it("never handed over → none", () => {
    expect(briefRefill("rx-1", [d("2026-09-15T06:00:00.000Z", [30], "rx-other")])).toEqual({ kind: "none" });
  });
});
