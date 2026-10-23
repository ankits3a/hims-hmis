import { mapSlipRows, normaliseUnit, slipCounts, slipKey } from "./slip-map";
import { ageChip, chipsFor, nameChip, normaliseSlipId, parseSlipAge, preselectIndex, printedAtOf, slipIdOf, trigramSimilarity } from "./slip-match";
import { parseSlipReply } from "./slip-reader";
import type { SlipAnalyte, SlipMapContext } from "./slip-map";
import type { SlipChips } from "./slip-match";
import type { SlipReply } from "./slip-reader";

/**
 * #934 — the pure halves of the slip scan: keys, units, the checks, and the patient chips. The DB-backed
 * paths are `acceptance/slip-scan-934.test.ts`.
 */
const A = (code: string, unit: string | null, o: Partial<SlipAnalyte> = {}): SlipAnalyte =>
  ({ id: code, code, nameEn: code, unit, resultType: "numeric", absurdLow: null, absurdHigh: null, formula: null, ...o });
const ctx = (codes: [string, string, string | null][], o: Partial<SlipMapContext> = {}): SlipMapContext => ({
  codes: new Map(codes.map(([c, a, u]) => [c, { analyteId: a, unit: u, factor: "1" }])),
  ignored: new Map(), report: null, prior: new Map(),
  analytes: new Map([
    A("HB", "g/dL", { absurdLow: "1", absurdHigh: "25" }), A("HCT", "%"), A("RBC", "10^6/uL"), A("MCHC", "g/dL"), A("MCV", "fL"), A("MCH", "pg"),
    A("WBC", "10^3/uL"), A("LYMPH", "%"), A("GRAN", "%"), A("MID", "%"),
    A("LYMPH_ABS", "10^3/uL", { resultType: "formula", formula: "WBC * LYMPH / 100" }),
  ].map((a) => [a.id, a])),
  ...o,
});
const reply = (rows: [string, string | null, string | null, ("clear" | "unsure" | "unreadable")?][]): SlipReply => ({
  slipKind: "analyser_result", analyserText: null,
  header: { name: null, patientId: null, sampleId: null, gender: null, age: null, printedAt: null },
  rows: rows.map(([code, value, unit, legible]) => ({ code, value, unit, flag: null, legible: legible ?? "clear" })),
});

describe("slip keys and units", () => {
  it("keeps # % - significant, unifies dashes and case, reads O as zero only among digits", () => {
    expect(slipKey("Lym#")).not.toBe(slipKey("Lym%"));
    expect(slipKey("RDW-CV")).not.toBe(slipKey("RDW-SD"));
    expect(slipKey("rdw – cv")).toBe("RDW-CV");
    expect(slipKey("C1O")).toBe("C10");
    expect(slipKey("MONO")).toBe("MONO");
  });

  it("compares units without converting them", () => {
    expect(normaliseUnit("×10⁹/L")).toBe(normaliseUnit("10^9/L"));
    expect(normaliseUnit("x10^9/L")).toBe("10^9/l");
    expect(normaliseUnit("10*9/L")).toBe("10^9/l");
    expect(normaliseUnit("10^3/µL")).toBe(normaliseUnit("10^3/uL"));
    expect(normaliseUnit("g/L")).not.toBe(normaliseUnit("g/dL"));
  });
});

describe("mapSlipRows", () => {
  it("places, cross-checks, flags unsure and no-value rows, refuses the absurd, and counts every row once", () => {
    const out = mapSlipRows(reply([
      ["HGB", "10.6", "g/dL", "unsure"], ["Lym#", "1.09", "10^9/L"], ["XYZ", "1", "%"], ["HCT", "----", "%"], ["HGB2", "92", "g/dL"],
    ]), ctx([["HGB", "HB", "g/dL"], ["Lym#", "LYMPH_ABS", "10^9/L"], ["HCT", "HCT", "%"], ["HGB2", "HB", "g/dL"]]));
    const by = new Map(out.rows.map((r) => [r.code, r]));
    expect(by.get("HGB")).toMatchObject({ placement: "placed", checks: ["unsure_read"], placedValue: "10.6" });
    expect(by.get("Lym#")).toMatchObject({ placement: "cross_check", analyteId: "LYMPH_ABS" });
    expect(by.get("XYZ")).toMatchObject({ placement: "not_placed", reason: "unmapped" });
    expect(by.get("HCT")).toMatchObject({ placement: "not_placed", reason: "no_value", checks: ["no_value"] });
    expect(by.get("HGB2")).toMatchObject({ placement: "not_placed", reason: "not_possible" });
    const c = slipCounts(out.rows);
    expect(c.placed + c.crossCheck + c.notPlaced + c.ignored + c.ignoredBySetting).toBe(5);
  });

  it("a digit misread shows up as indices that do not add up", () => {
    // MCHC printed 37.1 for 32.1: HGB 10.6 / HCT 33.0 × 100 = 32.1.
    const out = mapSlipRows(reply([["HGB", "10.6", "g/dL"], ["HCT", "33.0", "%"], ["RBC", "3.90", "10^12/L"], ["MCHC", "37.1", "g/dL"], ["MCV", "84.6", "fL"], ["MCH", "27.2", "pg"]]),
      ctx([["HGB", "HB", "g/dL"], ["HCT", "HCT", "%"], ["RBC", "RBC", "10^12/L"], ["MCHC", "MCHC", "g/dL"], ["MCV", "MCV", "fL"], ["MCH", "MCH", "pg"]]));
    expect(out.rows.find((r) => r.code === "MCHC")?.checks).toContain("index_mismatch");
    expect(out.rows.find((r) => r.code === "MCV")?.checks).not.toContain("index_mismatch");
  });

  it("a differential that does not sum to 100 is flagged on every % row", () => {
    const out = mapSlipRows(reply([["Lym%", "30.1", "%"], ["Gran%", "68.2", "%"], ["Mid%", "9.7", "%"]]),
      ctx([["Lym%", "LYMPH", "%"], ["Gran%", "GRAN", "%"], ["Mid%", "MID", "%"]]));
    for (const r of out.rows) expect(r.checks).toContain("index_mismatch");
  });

  it("an unmapped duplicate is a duplicate; the ignore list wins over the map; missing mapped codes are listed", () => {
    const out = mapSlipRows(reply([["WBC", "3.63", "10^9/L"], ["WBC", "3.68", "10^9/L"], ["PCT", "0.124", "%"]]),
      ctx([["WBC", "WBC", "10^9/L"], ["HGB", "HB", "g/dL"], ["PCT", "HB", "%"]], { ignored: new Map([["PCT", "plateletcrit"]]) }));
    expect(out.rows.filter((r) => r.checks.includes("duplicate_row"))).toHaveLength(2);
    expect(out.rows[2]).toMatchObject({ placement: "ignored_setting", settingReason: "plateletcrit", analyteId: null });
    expect(out.rowsMissing).toEqual(["HGB"]);
  });
});

describe("the patient chips", () => {
  it("reads IDs, refusing to compare a machine counter", () => {
    expect(normaliseSlipId("hms 00000101-7")).toBe("HMS000001017");
    expect(slipIdOf({ name: null, patientId: "", sampleId: "0023", gender: null, age: null, printedAt: null })).toEqual({ id: "0023", counter: true });
    expect(slipIdOf({ name: null, patientId: "S2610210007", sampleId: "0023", gender: null, age: null, printedAt: null })).toEqual({ id: "S2610210007", counter: false });
  });

  it("ages in years, months or days, ±1", () => {
    expect(parseSlipAge("8 M")).toEqual({ n: 8, unit: "M" });
    expect(parseSlipAge("34 Yrs")).toEqual({ n: 34, unit: "Y" });
    const at = new Date("2026-10-21T06:00:00Z");
    expect(ageChip("36Y", "1990-03-01", at)).toBe("same");
    expect(ageChip("37Y", "1990-03-01", at)).toBe("pm1");
    expect(ageChip("60Y", "1990-03-01", at)).toBe("differs");
    expect(ageChip("20 D", "2026-10-01", at)).toBe("same");
    expect(ageChip(null, "1990-03-01", at)).toBe("unread");
  });

  it("names: same, close for a cut-off or initialled name, differs otherwise", () => {
    expect(nameChip("MR RAM KUMAR", "Ram Kumar")).toBe("same");
    expect(nameChip("RAM KUMAR", "Ram Kumar Yadav")).toBe("close");
    expect(nameChip("R K YADAV", "Ram Kumar Yadav")).toBe("close");
    expect(nameChip("SUNITA SHARMA", "Ram Kumar")).toBe("differs");
    expect(nameChip("", "Ram Kumar")).toBe("unread");
    expect(trigramSimilarity("word", "word")).toBe(1);
  });

  it("a printed time reads as IST; the chip says when the sample came before the print", () => {
    expect(printedAtOf("21/10/2026 11:20")?.toISOString()).toBe("2026-10-21T05:50:00.000Z");
    const c = chipsFor({ name: null, patientId: null, sampleId: null, gender: "M", age: null, printedAt: "2026-10-21 11:20" },
      { name: "X", administrativeGender: "male", dob: null }, new Date("2026-10-21T05:00:00Z"));
    expect(c).toMatchObject({ gender: "same", time: "before_print" });
  });

  it("pre-selects only a lone full match with no runner-up on two of three", () => {
    const full: SlipChips = { name: "same", age: "same", gender: "same", time: null };
    const weak: SlipChips = { name: "differs", age: "differs", gender: "same", time: null };
    const two: SlipChips = { name: "close", age: "differs", gender: "same", time: null };
    expect(preselectIndex([weak, full])).toBe(1);
    expect(preselectIndex([full, two])).toBeNull();
    expect(preselectIndex([full, full])).toBeNull();
  });
});

describe("parseSlipReply", () => {
  it("takes the schema's JSON, with or without a code fence, and refuses anything else", () => {
    const ok = JSON.stringify(reply([["WBC", "3.63", "10^9/L"]]));
    expect(parseSlipReply(ok)?.rows).toHaveLength(1);
    expect(parseSlipReply("```json\n" + ok + "\n```")?.rows).toHaveLength(1);
    expect(parseSlipReply('{"slipKind":"analyser_result"}')).toBeNull();
    expect(parseSlipReply("not json")).toBeNull();
  });
});
