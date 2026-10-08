import * as fs from "fs";
import * as path from "path";
import {
  EMERGENCY_TILES, GLUCOSE_TIMINGS, PLUS_ORDER, ROUTINE_TILES, amendedReadings, buildBody, diffOf, emptyTiles, glucoseNeedsTiming, holdingOf,
  missingFor, parseTake, takeError, tileDeltaOf, tileSetFor, flagOf, fullRowBoxes, vitalsLayout,
} from "../src/vitals/rules";
import type { WirePreStage } from "../src/vitals/rules";

/**
 * OWNER 2026-10-08 — *"keep BP, Weight, height & Pulse as the primary and add a '+' icon to add more
 * vitals like RR, Temperature, Glucose"*; *"Move SpO2 behind '+'. Add Glucose behind '+'."* The rule
 * is ONE function in the shared file; this suite is its book, and its last block pins that the web
 * bay and the phone both call it and carry no list of their own.
 */
const pre = (over: Partial<WirePreStage>): WirePreStage => ({
  patientId: "p", ageYears: 54, band: "adult", ranges: { sbp: { min: 90, max: 180 }, spo2: { min: 90 } }, noticeRanges: {},
  gates: { adultWeightFloorKg: 20, heightDeltaCm: 5, spo2ProbeFloorPct: 70 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
  sealed: false, required: ["heightCm", "weightKg", "sbp", "dbp", "pulse"], notRoutine: [], feeUnpaid: false, feeBypass: null,
  last: null, carryCandidates: [], expectedFlags: [], ...over,
});
const ADULT = pre({});
const UNDER_SIX = pre({ ageYears: 4, band: "child_1_5", required: ["weightKg", "muacCm"], notRoutine: ["sbp", "dbp"] });

describe("the four boxes and the '+' (owner 2026-10-08)", () => {
  it("an adult opens with BP, pulse, weight, height — in that order — and '+' offers SpO₂, temperature, glucose, breathing rate", () => {
    const l = vitalsLayout(ADULT);
    expect(l.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
    expect(l.behindPlus).toEqual(["spo2", "tempC", "glucoseMgDl", "rr"]);
    expect(l.auto).toEqual([]);
    expect(l.autoWhy).toBeNull();
    expect(ROUTINE_TILES).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
  });

  it("with no pre-stage at all (it failed, or an older server) the form still asks for the routine four and never SpO₂", () => {
    expect(tileSetFor(null).required).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
    expect(vitalsLayout(null).boxes).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
    const t = emptyTiles();
    t.bp.takes = [[148, 92]]; t.pulse.takes = [84]; t.weightKg.takes = [71.5]; t.heightCm.takes = [168];
    expect(missingFor(t, tileSetFor(ADULT).required, false)).toEqual([]);   // saves without SpO₂
    expect(missingFor(t, tileSetFor(null).required, false)).toEqual([]);
  });

  it("a reading added becomes a box and leaves the '+' row; when nothing remains the row is empty", () => {
    const two = vitalsLayout(ADULT, { added: ["glucoseMgDl", "spo2"] });
    expect(two.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "glucoseMgDl"]);
    expect(two.behindPlus).toEqual(["tempC", "rr"]);
    expect(two.why.spo2).toBe("added");
    expect(vitalsLayout(ADULT, { added: ["spo2", "tempC", "glucoseMgDl", "rr"] }).behindPlus).toEqual([]);
  });

  it("a box that holds a value is on screen whether or not it was added — it cannot vanish with a number in it", () => {
    const t = emptyTiles();
    t.tempC.takes = [37.2]; t.spo2.held = [45];
    expect(holdingOf(t, { rr: "18" })).toEqual(["spo2", "tempC", "rr"]);
    const l = vitalsLayout(ADULT, { added: [], holding: holdingOf(t, { rr: "18" }) });
    expect(l.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "tempC", "rr"]);
    expect(l.why.tempC).toBe("value");
    expect(holdingOf(emptyTiles())).toEqual([]);
  });

  it("an emergency save still demands BP, pulse AND SpO₂ — and the SpO₂ it finds missing comes up without '+'", () => {
    expect(EMERGENCY_TILES).toEqual(["bp", "pulse", "spo2"]);
    const t = emptyTiles();
    t.bp.takes = [[208, 126]]; t.pulse.takes = [104];
    const miss = missingFor(t, tileSetFor(ADULT).required, true);
    expect(miss).toEqual(["spo2"]);
    const l = vitalsLayout(ADULT, { missing: miss, holding: holdingOf(t) });
    expect(l.boxes).toContain("spo2");
    expect(l.why.spo2).toBe("missing");
    expect(l.behindPlus).not.toContain("spo2");
  });

  it("a child under six: weight and the arm band are must-fill; height, pulse and temperature are on screen, optional (owner 2026-10-08)", () => {
    const l = vitalsLayout(UNDER_SIX);
    expect(l.boxes).toEqual(["weightKg", "heightCm", "pulse", "tempC", "muacCm"]);
    expect(l.why).toMatchObject({ weightKg: "required", muacCm: "required", heightCm: "asked", pulse: "asked", tempC: "asked" });
    expect(l.auto).toEqual(["weightKg", "muacCm"]);          // the amber line names only what must be filled
    expect(l.autoWhy).toBe("underSix");
    expect(l.behindPlus).toEqual(["spo2", "glucoseMgDl", "rr", "bp"]);
    expect(tileSetFor(UNDER_SIX).required).toEqual(["weightKg", "muacCm"]);
    const t = emptyTiles(); t.weightKg.takes = [9.4];
    expect(missingFor(t, tileSetFor(UNDER_SIX).required, false)).toEqual(["muacCm"]);
    t.muacCm.takes = [13.8];
    expect(missingFor(t, tileSetFor(UNDER_SIX).required, false)).toEqual([]);   // saves with no height and no pulse
    const one = vitalsLayout(pre({ ageYears: 1, band: "child_1_5", required: ["weightKg", "muacCm"], notRoutine: ["sbp", "dbp"] }));
    expect(one.boxes).toEqual(l.boxes);
    expect(vitalsLayout(pre({ ageYears: 0, band: "infant", required: ["weightKg", "muacCm"], notRoutine: ["sbp", "dbp"] })).boxes).toEqual(l.boxes);
  });

  it("six to seventeen: weight, height and pulse are must-fill; blood pressure is on screen, optional (owner 2026-10-08)", () => {
    const TEEN = pre({ ageYears: 16, band: "adult", required: ["heightCm", "weightKg", "pulse"] });
    const sixteen = vitalsLayout(TEEN);
    expect(sixteen.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
    expect(sixteen.why).toMatchObject({ bp: "asked", pulse: "required", weightKg: "required", heightCm: "required" });
    expect(sixteen.behindPlus).toEqual(["spo2", "tempC", "glucoseMgDl", "rr"]);
    expect(sixteen.autoWhy).toBeNull();
    const t = emptyTiles(); t.weightKg.takes = [54]; t.heightCm.takes = [165];
    expect(missingFor(t, tileSetFor(TEEN).required, false)).toEqual(["pulse"]);
    t.pulse.takes = [78];
    expect(missingFor(t, tileSetFor(TEEN).required, false)).toEqual([]);         // saves with no BP
    expect(missingFor(t, tileSetFor(TEEN).required, true)).toEqual(["bp", "spo2"]); // the emergency save still demands the cuff and SpO₂
    const eight = vitalsLayout(pre({ ageYears: 8, band: "child_6_12", required: ["heightCm", "weightKg", "pulse"] }));
    expect(eight.boxes).toEqual(["weightKg", "heightCm", "pulse", "tempC", "bp"]);
    expect(eight.why).toMatchObject({ bp: "asked", tempC: "asked" });
    expect(eight.autoWhy).toBe("child");
    expect(eight.auto).toEqual(["tempC"]);
    for (const age of [6, 12, 13, 17]) expect(vitalsLayout(pre({ ageYears: age, band: age < 13 ? "child_6_12" : "adult", required: ["heightCm", "weightKg", "pulse"] })).why.bp).toBe("asked");
  });

  it("eighteen and above, and an unknown age: blood pressure is must-fill, and nothing is merely 'shown'", () => {
    for (const age of [18, 54, null]) {
      const l = vitalsLayout(pre({ ageYears: age }));
      expect(l.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
      expect(l.why.bp).toBe("required");
    }
    // an OLDER server that still demands BP of a sixteen-year-old is believed: the star follows `required`
    expect(vitalsLayout(pre({ ageYears: 16 })).why.bp).toBe("required");
  });

  it("a typed BP on a sixteen-year-old keeps its range flag", () => {
    const band = { key: "adult" as const, upToAgeYears: null, required: [], notRoutine: [], ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 } }, noticeRanges: {} };
    expect(flagOf("bp", [190, 100], band, null)).toBe("danger");
    expect(flagOf("bp", [120, 80], band, null)).toBeNull();
  });

  it("whatever the server's protocol requires comes up without '+', and so does a reading the last chart flagged", () => {
    const asksRr = vitalsLayout(pre({ required: [...ADULT.required, "rr", "spo2"] }));
    expect(asksRr.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "rr"]);
    expect(asksRr.auto).toEqual(["spo2", "rr"]);
    expect(asksRr.autoWhy).toBe("protocol");
    const flagged = vitalsLayout(pre({ expectedFlags: [{ vital: "spo2", value: 86, bound: "min", limit: 90 }] }));
    expect(flagged.boxes).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2"]);
    expect(flagged.why.spo2).toBe("flagged");
    expect(flagged.auto).toEqual([]);                       // shown, not demanded
  });

  it("MUAC is never offered behind '+': required under six, meaningless over it", () => {
    expect(PLUS_ORDER).not.toContain("muacCm");
    expect(vitalsLayout(ADULT).behindPlus).not.toContain("muacCm");
  });
});

describe("glucose (owner 2026-10-08): a whole number 20–600 mg/dL, and when it was taken", () => {
  it("reads 186; refuses 700, 19, a decimal and a word — with the box's own message", () => {
    expect(parseTake("glucoseMgDl", "186")).toBe(186);
    expect(parseTake("glucoseMgDl", " 20 ")).toBe(20);
    expect(parseTake("glucoseMgDl", "600")).toBe(600);
    for (const bad of ["700", "19", "186.5", "abc", "601"]) {
      expect(parseTake("glucoseMgDl", bad)).toBeNull();
      expect(takeError("glucoseMgDl", bad)).toBe("glucoseRange");
    }
  });

  it("a value with no timing stops the save; the timing travels only beside a value", () => {
    expect(GLUCOSE_TIMINGS).toEqual(["fasting", "random", "after_food"]);
    const t = emptyTiles();
    expect(glucoseNeedsTiming(t, null)).toBe(false);
    expect(buildBody(t, { emergency: false, chips: [], glucoseTiming: "random" }).glucoseTiming).toBeUndefined();
    t.glucoseMgDl.takes = [186];
    expect(glucoseNeedsTiming(t, null)).toBe(true);
    expect(glucoseNeedsTiming(t, "random")).toBe(false);
    const body = buildBody(t, { emergency: false, chips: [], glucoseTiming: "random" });
    expect(body.glucoseTiming).toBe("random");
    expect(body.readings?.glucoseMgDl).toEqual({ takes: [186], source: "typed" });
  });

  it("is not ranged, not coloured and not compared with the last chart", () => {
    const t = emptyTiles(); t.glucoseMgDl.takes = [420];
    const band = { key: "adult" as const, upToAgeYears: null, required: [], notRoutine: [], ranges: ADULT.ranges, noticeRanges: {} };
    expect(flagOf("glucoseMgDl", 420, band, null)).toBeNull();
    expect(tileDeltaOf("glucoseMgDl", t.glucoseMgDl, pre({ last: { vitalsId: "v", recordedAt: "2026-06-11T04:00:00.000Z", serviceDate: "2026-06-11", heightCm: 168, weightKg: 70, sbp: 130, dbp: 80, pulse: 80, rr: null, spo2: 98, tempC: null, muacCm: null } }))).toBeNull();
  });

  it("an amendment diffs it like any other number, and a chart from before glucose existed diffs clean", () => {
    const old = { heightCm: 168, weightKg: 70, sbp: 130, dbp: 80, pulse: 80, rr: null, spo2: 97, tempC: null, muacCm: null };
    expect(diffOf(old, { ...old, glucoseMgDl: null })).toEqual([]);
    expect(diffOf({ ...old, glucoseMgDl: 186 }, { ...old, glucoseMgDl: 168 })).toEqual([{ key: "glucoseMgDl", from: 186, to: 168 }]);
    expect(amendedReadings({ ...old, glucoseMgDl: 186, readings: { glucoseMgDl: { takes: [186], source: "typed" } } }, { glucoseMgDl: 168 }).glucoseMgDl)
      .toEqual({ takes: [168], source: "typed" });
  });
});

describe("one rule, two screens", () => {
  const WEB = path.join(__dirname, "../../web/src/screens/vitals-bay-capture.tsx");
  const PHONE = path.join(__dirname, "../src/vitals/capture.tsx");
  it("the web bay and the phone both lay their boxes out with the shared `vitalsLayout`, and neither lists tiles itself", () => {
    const shared = fs.readFileSync(path.join(__dirname, "../../../packages/contracts/src/vitals-entry.ts"), "utf8");
    expect(shared).toMatch(/export function vitalsLayout\b/);
    for (const file of [WEB, PHONE]) {
      const src = fs.readFileSync(file, "utf8");
      expect(src).toMatch(/\bvitalsLayout\(/);
      expect(src).toMatch(/\blayout\.boxes\b/);
      expect(src).toMatch(/layout\.behindPlus\b/);
      expect(src).not.toMatch(/function vitalsLayout\b/);
      // no private list of readings: a tile key appears in these files only as a single compared key, never in an array
      expect(src).not.toMatch(/\[\s*"(bp|pulse|spo2|tempC|rr|weightKg|heightCm|muacCm|glucoseMgDl)"\s*,/);
    }
  });
});

describe("two columns: which boxes take a whole row", () => {
  it("BP and glucose always; a box that would sit beside nothing; and whatever the screen says needs the row", () => {
    expect(fullRowBoxes(["bp", "pulse", "weightKg", "heightCm"])).toEqual(["bp", "heightCm"]);                       // frame A: BP, pulse|weight, height
    expect(fullRowBoxes(["bp", "pulse", "weightKg", "heightCm", "spo2", "glucoseMgDl"])).toEqual(["bp", "glucoseMgDl"]); // frame C
    expect(fullRowBoxes(["weightKg", "heightCm", "pulse", "tempC", "muacCm"])).toEqual(["muacCm"]);                  // frame D
    expect(fullRowBoxes(["bp", "pulse", "weightKg", "heightCm", "glucoseMgDl"])).toEqual(["bp", "heightCm", "glucoseMgDl"]); // no hole beside the height
    expect(fullRowBoxes(["bp", "pulse", "weightKg", "heightCm", "spo2"], (k) => k === "heightCm")).toEqual(["bp", "heightCm", "spo2"]);   // a carried height showing its reason picker
  });
});

describe("a held SpO₂ is still not skippable, though SpO₂ is no longer demanded", () => {
  it("held with no surviving take → still needed; re-clipped, confirmed or cleared → not", () => {
    const t = emptyTiles();
    t.bp.takes = [[148, 92]]; t.pulse.takes = [84]; t.weightKg.takes = [71.5]; t.heightCm.takes = [168];
    t.spo2.held = [45];
    expect(missingFor(t, tileSetFor(ADULT).required, false)).toEqual(["spo2"]);
    expect(vitalsLayout(ADULT, { holding: holdingOf(t) }).boxes).toContain("spo2");   // and its box is on screen to answer it
    t.spo2.takes = [96];
    expect(missingFor(t, tileSetFor(ADULT).required, false)).toEqual([]);
    expect(missingFor({ ...t, spo2: emptyTiles().spo2 }, tileSetFor(ADULT).required, false)).toEqual([]);
  });
});
