import { antibioticsFor, astForSave, cleanAstRows, fillPanel, isNoGrowth, panelCodes } from "./lab-ast";

/** Owner 2026-10-12 — the antibiotic table's shared rules (spec SPEC-lab-ast-table-2026-10-12.md). */
describe("antibiotic sensitivity rules", () => {
  it("urine-only drugs are offered on a urine culture alone", () => {
    expect(panelCodes("ent_urine", "CS_URINE")).toEqual(expect.arrayContaining(["NIT", "FOS"]));
    expect(panelCodes("ent_urine", "CS_BLOOD")).not.toEqual(expect.arrayContaining(["NIT"]));
    expect(panelCodes("staph_ent", "CS_PUS")).not.toContain("NIT");
    expect(antibioticsFor("CS_BLOOD").filter((c) => c === "NIT" || c === "FOS")).toEqual([]);
    expect(panelCodes("ent_other", "CS_BLOOD")).toEqual(expect.arrayContaining(["CSL", "TGC", "IPM"]));
    expect(panelCodes("ent_other", "CS_BLOOD")).not.toContain("CZO");
  });

  it("drops blank rows, refuses a result other than S/I/R and a non-numeric MIC, naming the row", () => {
    expect(cleanAstRows([{ antibiotic: "AMP", result: "", mic: "4" }, { antibiotic: "CIP", result: "R", mic: " 0.5 " }]))
      .toEqual({ ok: true, rows: [{ antibiotic: "CIP", result: "R", mic: "0.5" }] });
    expect(cleanAstRows([{ antibiotic: "AMP", result: "S", mic: null }, { antibiotic: "CIP", result: "s", mic: null }]))
      .toEqual({ ok: false, problem: { index: 2, antibiotic: "CIP", reason: "result" } });
    for (const mic of ["≤0.25", ">32", "1/2", "0.5mg"]) {
      expect(cleanAstRows([{ antibiotic: "MEM", result: "S", mic }])).toEqual({ ok: false, problem: { index: 1, antibiotic: "MEM", reason: "mic" } });
    }
    expect(cleanAstRows([{ antibiotic: "AMP", result: "S", mic: null }, { antibiotic: "amp", result: "R", mic: null }]).ok).toBe(false);
  });

  it("a panel keeps what was marked; No growth sends no rows", () => {
    const rows = fillPanel([{ antibiotic: "CIP", result: "R", mic: null }, { antibiotic: "PEN", result: "", mic: null }], "ent_urine", "CS_URINE");
    expect(rows.find((r) => r.antibiotic === "CIP")?.result).toBe("R");
    expect(rows.some((r) => r.antibiotic === "PEN")).toBe(false);
    expect(isNoGrowth("  No Growth after 48 h")).toBe(true);
    expect(isNoGrowth("Sterile")).toBe(true);
    expect(isNoGrowth("E. coli")).toBe(false);
    const tests = [{ serviceId: "u", code: "CS_URINE" }, { serviceId: "f", code: "FUNG_CUL" }];
    expect(astForSave(tests, { u: rows }, "No growth")).toEqual([{ serviceId: "u", rows: [] }]);
    expect(astForSave(tests, { u: rows }, "E. coli")).toEqual([{ serviceId: "u", rows: [{ antibiotic: "CIP", result: "R", mic: null }] }]);
  });
});
