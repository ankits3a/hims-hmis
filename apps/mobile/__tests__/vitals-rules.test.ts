import fs from "node:fs";
import path from "node:path";
import {
  buildBody, classifyDoor, emptyTiles, applyTake, missingFor, parseTake, takeError, tempNote, tileSetFor,
} from "../src/vitals/rules";
import type { WirePreStage } from "../src/vitals/rules";

const WEB = path.join(__dirname, "../../web/src");

describe("the vitals rules are ONE file, shared with the web bay", () => {
  it("the web bay re-exports the shared source and defines no parser of its own", () => {
    const capture = fs.readFileSync(path.join(WEB, "screens/vitals-bay-capture.tsx"), "utf8");
    expect(capture).toContain('export * from "../../../../packages/contracts/src/vitals-entry"');
    for (const name of ["parseTake", "tempNote", "applyTake", "buildBody", "missingFor", "flagOf", "mirrorFor"]) {
      expect(capture).not.toMatch(new RegExp(`export function ${name}\\b`));
    }
    const rules = fs.readFileSync(path.join(__dirname, "../src/vitals/rules.ts"), "utf8");
    expect(rules).toContain('export * from "../../../../packages/contracts/src/vitals-entry"');
  });

  it("the shared file imports nothing, so neither app needs the other's dependencies", () => {
    const shared = fs.readFileSync(path.join(__dirname, "../../../packages/contracts/src/vitals-entry.ts"), "utf8");
    expect(shared).not.toMatch(/^import /m);
    expect(shared).not.toMatch(/\brequire\(/);
  });
});

describe("a BP typed on a phone's number pad", () => {
  it.each(["150/90", "150-90", "150,90", "150.90", "150 90", " 150 - 90 "])("reads %s as 150/90", (raw) => {
    expect(parseTake("bp", raw)).toEqual([150, 90]);
  });
  it("refuses the numbers swapped, and says which mistake it is", () => {
    expect(parseTake("bp", "80-120")).toBeNull();
    expect(takeError("bp", "80-120")).toBe("bpOrder");
    expect(parseTake("bp", "150")).toBeNull();
    expect(takeError("bp", "150")).toBe("bpBoth");
  });
});

describe("a temperature, °F or °C, sensed from the number", () => {
  it("charts a °F thermometer in °C", () => {
    expect(tempNote("98.6")).toEqual({ unit: "F", f: 98.6, c: 37 });
    expect(tempNote("101")).toEqual({ unit: "F", f: 101, c: 38.3 });
    expect(parseTake("tempC", "101.2")).toBe(38.4);
  });
  it("keeps a °C reading as typed", () => {
    expect(tempNote("37")).toEqual({ unit: "C", c: 37, f: 98.6 });
    expect(parseTake("tempC", "37.2")).toBe(37.2);
  });
  it("refuses a number in neither band", () => {
    expect(parseTake("tempC", "50")).toBeNull();
    expect(takeError("tempC", "50")).toBe("tempUnit");
  });
});

describe("what the band requires", () => {
  const pre = (required: WirePreStage["required"]): WirePreStage => ({
    patientId: "p", ageYears: 8, band: "child_6_12", ranges: {}, noticeRanges: {},
    gates: { adultWeightFloorKg: 20, heightDeltaCm: 5, spo2ProbeFloorPct: 70 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
    sealed: false, required, notRoutine: [], feeUnpaid: false, feeBypass: null, last: null, carryCandidates: [], expectedFlags: [],
  });
  it("is the server's list: a child's band without BP asks for no BP, and nobody is asked for a temperature", () => {
    const set = tileSetFor(pre(["pulse", "spo2", "weightKg"]));
    expect(set.required).toEqual(["pulse", "spo2", "weightKg"]);
    let tiles = emptyTiles();
    for (const [k, v] of [["pulse", 96], ["spo2", 98], ["weightKg", 24]] as const) {
      tiles = applyTake(tiles, k, "typed", v, { ageYears: 8, ranges: null, last: null }).tiles;
    }
    expect(missingFor(tiles, set.required, false)).toEqual([]);
    const body = buildBody(tiles, { emergency: false, chips: [] });
    expect(body.readings).toEqual({
      pulse: { takes: [96], source: "typed" }, spo2: { takes: [98], source: "typed" }, weightKg: { takes: [24], source: "typed" },
    });
  });
  it("still asks an adult for BP", () => {
    const set = tileSetFor(pre(["sbp", "dbp", "pulse", "spo2", "weightKg"]));
    expect(set.required).toContain("bp");
    expect(missingFor(emptyTiles(), set.required, false)).toContain("bp");
  });
});

describe("the three doors", () => {
  it("digits are a token, a card payload is a scan, anything else is a UHID", () => {
    expect(classifyDoor(" 14 ")).toEqual({ kind: "token", tokenNo: 14 });
    expect(classifyDoor("q1.abc.def")).toEqual({ kind: "scan", payload: "q1.abc.def" });
    expect(classifyDoor("u00110049")).toEqual({ kind: "uhid", uhid: "U00110049" });
    expect(classifyDoor("  ")).toBeNull();
  });
});
