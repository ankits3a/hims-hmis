import fs from "node:fs";
import path from "node:path";
import {
  ambiguousMessage, buildBody, classifyDoor, emptyTiles, applyTake, missMessage, missingFor, parseTake, resolveDoor, takeError, tempNote,
  tileSetFor,
} from "../src/vitals/rules";
import type { WireBenchRow, WirePreStage } from "../src/vitals/rules";

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

describe("the doors — whatever is typed or scanned resolves on the bench (owner 2026-10-06)", () => {
  const row = (over: Partial<WireBenchRow>): WireBenchRow => ({
    encounterId: "e1", entryId: "q1", tokenNo: 1, seq: 1, visitNo: "V2610060001", departmentCode: "MED",
    doctorId: "d1", doctorName: "Dr. Nitish Kumar Jha", serviceDate: "2026-10-06",
    patient: { requestedId: "p1", id: "p1", uhid: "U00110049", name: "Ankit Kumar", alias: null, restricted: false, administrativeGender: "male", dob: null },
    benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
    ...over,
  });
  const BENCH = [row({}), row({ encounterId: "e2", entryId: "q2", tokenNo: 4, visitNo: "V2610060007", departmentCode: "ORT", doctorId: "d2", patient: { ...row({}).patient!, id: "p2", requestedId: "p2", uhid: "U00110060" } })];
  const who = (raw: string) => { const r = resolveDoor(BENCH, raw); return r.outcome === "row" ? r.row.encounterId : r.outcome; };

  it("reads digits as a token, a card payload as a scan, a visit number as a visit, anything else as a UHID", () => {
    expect(classifyDoor(" 14 ")).toEqual({ kind: "token", tokenNo: 14 });
    expect(classifyDoor("q1.abc.def")).toEqual({ kind: "scan", payload: "q1.abc.def" });
    expect(classifyDoor("v2610060001")).toEqual({ kind: "visit", visitNo: "V2610060001" });
    expect(classifyDoor("ort-4")).toEqual({ kind: "token", tokenNo: 4, departmentCode: "ORT" });
    expect(classifyDoor("u00110049")).toEqual({ kind: "uhid", uhid: "U00110049" });
    expect(classifyDoor("  ")).toBeNull();
  });

  it.each(["V2610060001", "v2610060001", " V 2610 060001 ", "Visit: V2610060001", "https://hmis.crkmch.com/v/V2610060001"])(
    "the visit number on the slip — %s — finds the patient", (raw) => { expect(who(raw)).toBe("e1"); });

  it("the prescription sheet's QR (the bare visit number) and a printed e-prescription's QR both find the visit", () => {
    expect(who("V2610060007")).toBe("e2");
    expect(who("rx1.RX9.e2.1.sig")).toBe("e2");
  });

  it.each(["1", "#1", "T-1", "MED-1", "med 1", "MED1"])("the token as typed or as the slip prints it — %s", (raw) => { expect(who(raw)).toBe("e1"); });

  it.each(["U00110049", "u00110049", "00110049", "110049"])("the UHID in any case, with or without its prefix — %s", (raw) => { expect(who(raw)).toBe("e1"); });

  it("a patient card goes to the server first", () => {
    expect(resolveDoor(BENCH, "q1.p1.U00110049.1.sig")).toEqual({ outcome: "verify", payload: "q1.p1.U00110049.1.sig" });
  });

  it("never guesses between two doctors' token 4 — it says how the slip spells it", () => {
    const two = [...BENCH, row({ encounterId: "e3", entryId: "q3", tokenNo: 4, visitNo: "V2610060009", departmentCode: "MED" })];
    const r = resolveDoor(two, "4");
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    expect(ambiguousMessage(r.door, r.rows)).toEqual({ key: "ambiguous", vars: { token: "#4", count: "2", example: "ORT-4" } });
    expect(resolveDoor(two, "MED-4")).toMatchObject({ outcome: "row", row: { encounterId: "e3" } });
  });

  it("a miss names what was understood, and a visit's reason when the server gave one", () => {
    const miss = resolveDoor(BENCH, "V2610050003");
    expect(miss).toEqual({ outcome: "miss", door: { kind: "visit", visitNo: "V2610050003" } });
    if (miss.outcome !== "miss") return;
    expect(missMessage(miss.door)).toEqual({ key: "visit.plain", vars: { visitNo: "V2610050003" } });
    expect(missMessage(miss.door, { onBench: false, visitNo: "V2610050003", reason: "other_day", serviceDate: "2026-10-05" }))
      .toEqual({ key: "visit.other_day", vars: { visitNo: "V2610050003", date: "05-Oct-2026" } });
    expect(missMessage({ kind: "token", tokenNo: 99 })).toEqual({ key: "token", vars: { token: "#99" } });
    expect(missMessage({ kind: "uhid", uhid: "U999" })).toEqual({ key: "uhid", vars: { uhid: "U999" } });
  });

  it("an older server's bench (no visit number on the row) still resolves tokens and UHIDs", () => {
    const old = BENCH.map(({ visitNo: _v, departmentCode: _d, ...r }) => r);
    expect(resolveDoor(old, "1")).toMatchObject({ outcome: "row" });
    expect(resolveDoor(old, "V2610060001")).toMatchObject({ outcome: "miss", door: { kind: "visit" } });
  });
});
