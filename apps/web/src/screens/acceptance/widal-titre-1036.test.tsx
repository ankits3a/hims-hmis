import { draftSummary, refText } from "../../lib/lab-quick-api";
import { parseTitre, widalFlag } from "../../../../../packages/contracts/src/lab-titre";
import type { QuickLine } from "../../lib/lab-quick-api";
import { quickReportHtml } from "../../../../../packages/contracts/src/lab-report-html";
import type { ReportHtmlInput } from "../../../../../packages/contracts/src/lab-report-html";

/**
 * ACCEPTANCE — issue #1036, spec docs/specs/1036-widal-titre.md (owner APPROVED 2026-11-06): the web half.
 * A positive Widal titre is named in the summary. The titre grid was removed 2026-11-10 (owner).
 */
const RANGE = { analyteId: "WIDAL_TO", low: null, high: null, text: "Non-Reactive", criticalLow: null, criticalHigh: null, note: null };
const line = (code: string, nameEn: string, value: string, flag: QuickLine["flag"]): QuickLine => ({
  analyteId: code, code, nameEn, unit: null, value, low: null, high: null, refText: "Non-Reactive", flag,
});

describe("#1036 — Widal titres (web)", () => {
  it("spec #1036 D1: the bench shows a Widal antigen's range as 'Non-Reactive'", () => {
    expect(refText(RANGE)).toBe("Non-Reactive");
  });

  it("spec #1036 D3: the draft summary names a flagged Widal line and does not call it in range", () => {
    const s = draftSummary([line("WIDAL_TO", "S. typhi O", "1:160", "A"), line("WIDAL_AH", "S. Paratyphi AH", "Non-Reactive", "N")]);
    expect(s).toContain("S. typhi O is abnormal: 1:160");
    expect(s).not.toContain("All reported parameters are within the reference range");
    expect([widalFlag("WIDAL_TO", "1:80"), widalFlag("WIDAL_TH", "1:80"), widalFlag("WIDAL_TH", "1:160")]).toEqual(["A", "N", "A"]);
  });

  it("owner 2026-11-10: no titre grid; the typed result reads like the reference report", () => {
    expect([parseTitre("Reactive up to titre 1:320"), parseTitre("non reactive"), parseTitre("Reactive")]).toEqual([
      { ok: true, value: "1:320", dilution: 320 }, { ok: true, value: "Non-Reactive", dilution: 0 }, { ok: false },
    ]);
  });

  it("owner 2026-11-10: the printed report writes 'Reactive up to titre' and the short note under a Widal table only", () => {
    const report = (code: string): ReportHtmlInput => ({
      patient: { uhid: "HMS-1", display: "Test", administrativeGender: "female", dob: null }, encounterNo: null,
      tests: [{ serviceId: "s", code: "T", nameEn: "Test" }], collectedAt: "2026-11-10T06:00:00Z", reportedAt: null,
      groups: [{ title: "Test", analyteIds: ["a"] }],
      lines: [{ analyteId: "a", code, nameEn: "Line", unit: null, value: "1:80", low: null, high: null, refText: null, flag: null }],
      summary: "", reportedByName: null, visitQrSvg: null,
      hospital: { name: "", address: "", hotline: "", emergency: "", email: "", website: "" },
    });
    const o = { printedBy: null, logoUrl: "x", now: new Date("2026-11-10T06:00:00Z") };
    const widal = quickReportHtml(report("WIDAL_TO"), o);
    expect(widal).toContain("Reactive up to titre 1:80");
    expect(widal).toContain("Confirm by blood culture before starting antibiotics.");
    const other = quickReportHtml(report("HB"), o);
    expect(other).not.toContain("blood culture");
    expect(other).not.toContain("Reactive up to titre");
  });
});
