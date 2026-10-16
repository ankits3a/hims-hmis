import {
  applsNormalFor, ewsKindFor, ewsNextDueMinutes, ewsNotifies, meows, news2, pews,
} from "./ews";
import type { IpdEwsValues } from "./ews";

/*
  E4.1 (#733) — the early-warning tables at every band edge. Each row of each published chart is probed on both sides of
  its boundary: a one-digit slip in a table moves exactly one of these.
*/

const ADULT_NORMAL: IpdEwsValues = { respRate: 16, spo2: 97, onOxygen: false, systolic: 125, pulse: 70, consciousness: "alert", temperatureC: 37 };
const n2 = (over: Partial<IpdEwsValues>) => news2({ ...ADULT_NORMAL, ...over });

describe("NEWS2 (RCP 2017, chart 1)", () => {
  it("a normal adult scores 0, complete, low", () => {
    expect(news2(ADULT_NORMAL)).toMatchObject({ value: 0, band: "low", complete: true, singleRed: false });
  });
  it.each([
    [8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3],
  ])("respiration rate %d scores %d", (rr, p) => expect(n2({ respRate: rr }).parts.respRate).toBe(p));
  it.each([
    [91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0],
  ])("SpO2 (scale 1) %d scores %d", (s, p) => expect(n2({ spo2: s }).parts.spo2).toBe(p));
  it.each([
    [90, 3], [91, 2], [100, 2], [101, 1], [110, 1], [111, 0], [219, 0], [220, 3],
  ])("systolic %d scores %d", (bp, p) => expect(n2({ systolic: bp }).parts.systolic).toBe(p));
  it.each([
    [40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3],
  ])("pulse %d scores %d", (hr, p) => expect(n2({ pulse: hr }).parts.pulse).toBe(p));
  it.each([
    [35.0, 3], [35.1, 1], [36.0, 1], [36.1, 0], [38.0, 0], [38.1, 1], [39.0, 1], [39.1, 2],
  ])("temperature %d scores %d", (t, p) => expect(n2({ temperatureC: t }).parts.temperatureC).toBe(p));
  it("oxygen scores 2; any of new confusion, voice, pain, unresponsive scores 3", () => {
    expect(n2({ onOxygen: true }).parts.onOxygen).toBe(2);
    for (const c of ["confused", "voice", "pain", "unresponsive"] as const) expect(n2({ consciousness: c }).parts.consciousness).toBe(3);
  });
  it("bands: 0–4 low; a single 3 low–medium; 5–6 medium; 7+ high", () => {
    expect(n2({ pulse: 91, respRate: 21, spo2: 95 }).band).toBe("low"); // 1 + 2 + 1 = 4
    expect(n2({ respRate: 25 })).toMatchObject({ value: 3, band: "low_medium", singleRed: true });
    expect(n2({ pulse: 111, respRate: 21, spo2: 95 })).toMatchObject({ value: 5, band: "medium" });
    expect(n2({ pulse: 111, respRate: 21, spo2: 94, systolic: 110 })).toMatchObject({ value: 6, band: "medium" });
    expect(n2({ pulse: 111, respRate: 21, spo2: 94, systolic: 100 })).toMatchObject({ value: 7, band: "high" });
  });
  it("the doctor is told from the low–medium band up", () => {
    expect([ewsNotifies("low"), ewsNotifies("low_medium"), ewsNotifies("medium"), ewsNotifies("high")]).toEqual([false, true, true, true]);
  });
  it("a partial set is scored on what was measured and marked incomplete", () => {
    expect(news2({ pulse: 135 })).toMatchObject({ value: 3, band: "low_medium", complete: false });
  });
});

const OB_NORMAL: IpdEwsValues = { temperatureC: 37, systolic: 120, diastolic: 75, pulse: 80, respRate: 16, spo2: 98, consciousness: "alert" };
const mo = (over: Partial<IpdEwsValues>) => meows({ ...OB_NORMAL, ...over });

describe("MEOWS (CEMACH 2007; Singh et al., Anaesthesia 2012)", () => {
  it.each([
    ["temperatureC", 34.9, 3], ["temperatureC", 35.0, 1], ["temperatureC", 36.0, 1], ["temperatureC", 36.1, 0], ["temperatureC", 38.0, 0], ["temperatureC", 38.1, 3],
    ["systolic", 89, 3], ["systolic", 90, 1], ["systolic", 100, 1], ["systolic", 101, 0], ["systolic", 149, 0], ["systolic", 150, 1], ["systolic", 160, 1], ["systolic", 161, 3],
    ["diastolic", 89, 0], ["diastolic", 90, 1], ["diastolic", 100, 1], ["diastolic", 101, 3],
    ["pulse", 39, 3], ["pulse", 40, 1], ["pulse", 50, 1], ["pulse", 51, 0], ["pulse", 99, 0], ["pulse", 100, 1], ["pulse", 120, 1], ["pulse", 121, 3],
    ["respRate", 9, 3], ["respRate", 10, 0], ["respRate", 20, 0], ["respRate", 21, 1], ["respRate", 30, 1], ["respRate", 31, 3],
    ["spo2", 94, 3], ["spo2", 95, 0],
  ] as const)("%s %d → %d", (k, v, p) => expect(mo({ [k]: v }).parts[k]).toBe(p));
  it("trigger: one red or two yellows → medium; two reds → high; one yellow stays low", () => {
    expect(mo({}).band).toBe("low");
    expect(mo({ pulse: 110 })).toMatchObject({ band: "low", value: 1 });
    expect(mo({ pulse: 110, respRate: 25 })).toMatchObject({ band: "medium", value: 2 });
    expect(mo({ spo2: 93 })).toMatchObject({ band: "medium", value: 3, singleRed: true });
    expect(mo({ spo2: 93, systolic: 170 })).toMatchObject({ band: "high", value: 6 });
  });
  it("consciousness: voice is yellow, pain or unresponsive red", () => {
    expect(mo({ consciousness: "voice" }).parts.consciousness).toBe(1);
    expect(mo({ consciousness: "pain" }).parts.consciousness).toBe(3);
  });
});

describe("PEWS (Brighton; APLS normal ranges)", () => {
  it("APLS bands by age", () => {
    expect(applsNormalFor(0.5).pulse).toEqual([110, 160]);
    expect(applsNormalFor(1).pulse).toEqual([100, 150]);
    expect(applsNormalFor(4).respRate).toEqual([25, 30]);
    expect(applsNormalFor(8).pulse).toEqual([80, 120]);
    expect(applsNormalFor(15).respRate).toEqual([15, 20]);
  });
  it("cardiovascular at the edges for an 8-year-old (normal pulse 80–120)", () => {
    const cv = (pulse: number) => pews({ pulse, consciousness: "alert", respRate: 22 }, 8).parts.cardiovascular;
    expect([cv(79), cv(80), cv(139), cv(140), cv(149), cv(150)]).toEqual([3, 0, 0, 2, 2, 3]);
    expect([3, 4, 5].map((c) => pews({ capRefillSec: c }, 8).parts.cardiovascular)).toEqual([1, 2, 3]);
  });
  it("respiratory at the edges for an 8-year-old (normal RR 20–25)", () => {
    const rs = (respRate: number) => pews({ respRate, consciousness: "alert", pulse: 100 }, 8).parts.respiratory;
    expect([rs(15), rs(16), rs(35), rs(36), rs(45), rs(46)]).toEqual([3, 0, 0, 1, 1, 2]);
    expect(pews({ respRate: 22, onOxygen: true }, 8).parts.respiratory).toBe(1);
  });
  it("bands: 0–2 low; a single 3 low–medium; 3–4 medium; 5+ high", () => {
    expect(pews({ consciousness: "voice", pulse: 100, respRate: 22, onOxygen: true }, 8)).toMatchObject({ value: 2, band: "low" });
    expect(pews({ consciousness: "pain", pulse: 100, respRate: 22 }, 8)).toMatchObject({ value: 3, band: "medium", singleRed: true });
    expect(pews({ consciousness: "alert", pulse: 100, respRate: 15 }, 8)).toMatchObject({ value: 3, band: "medium" });
    expect(pews({ consciousness: "alert", pulse: 140, respRate: 36 }, 8)).toMatchObject({ value: 3, band: "medium" });
    expect(pews({ consciousness: "pain", pulse: 140, respRate: 22 }, 8)).toMatchObject({ value: 5, band: "high" });
  });
});

describe("which chart, and when the next set is due", () => {
  const base = { ageYears: 40, sex: "male", obstetric: null, department: null, bedClass: "general" } as const;
  it("under 16 PEWS; pregnant or postpartum MEOWS; an OBG or labour-bed woman MEOWS unless she answered none; else NEWS2", () => {
    expect(ewsKindFor({ ...base, ageYears: 15 })).toBe("pews");
    expect(ewsKindFor({ ...base, ageYears: 16 })).toBe("news2");
    expect(ewsKindFor({ ...base, ageYears: null })).toBe("news2");
    expect(ewsKindFor({ ...base, sex: "female", obstetric: "pregnant" })).toBe("meows");
    expect(ewsKindFor({ ...base, sex: "female", obstetric: "postpartum" })).toBe("meows");
    expect(ewsKindFor({ ...base, sex: "female", department: "OBG" })).toBe("meows");
    expect(ewsKindFor({ ...base, sex: "female", bedClass: "ldr" })).toBe("meows");
    expect(ewsKindFor({ ...base, sex: "female", department: "OBG", obstetric: "none" })).toBe("news2");
    expect(ewsKindFor({ ...base, sex: "male", department: "OBG" })).toBe("news2");
  });
  it("next set: no set 60 min; NEWS2 0 → 12 h; 1–4 → 4 h; single 3 or 5–6 → 1 h; 7+ → 15 min", () => {
    expect(ewsNextDueMinutes(null)).toBe(60);
    expect(ewsNextDueMinutes({ value: 0, band: "low" })).toBe(720);
    expect(ewsNextDueMinutes({ value: 4, band: "low" })).toBe(240);
    expect(ewsNextDueMinutes({ value: 3, band: "low_medium" })).toBe(60);
    expect(ewsNextDueMinutes({ value: 6, band: "medium" })).toBe(60);
    expect(ewsNextDueMinutes({ value: 7, band: "high" })).toBe(15);
  });
});
