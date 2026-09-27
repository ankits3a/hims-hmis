import { contentDisposition, csvField, csvRow, toCsv } from "./csv";

/**
 * PLAN 07c T3 — THE FIRST EXPORT THIS APPLICATION HAS EVER HAD, so this file is the house pattern
 * every later module inherits. The escaping is the whole job: a naive `join(",")` shifts every
 * column after a comma by one, SILENTLY, and the file still opens — the corruption only surfaces
 * when somebody reconciles a column of money against a column of names.
 */
describe("csv (07c T3)", () => {
  describe("A1 — a field survives whatever a name can contain", () => {
    it("quotes a comma, and only then", () => {
      expect(csvField("Asha Devi")).toBe("Asha Devi");
      expect(csvField("Devi, Asha")).toBe('"Devi, Asha"');
    });

    it("doubles an embedded quote rather than dropping it", () => {
      expect(csvField('Asha "Guddi" Devi')).toBe('"Asha ""Guddi"" Devi"');
    });

    it("quotes a newline, which a note field really does contain", () => {
      expect(csvField("line one\nline two")).toBe('"line one\nline two"');
      expect(csvField("cr\r\nlf")).toBe('"cr\r\nlf"');
    });

    it("a row of them round-trips to the right number of columns", () => {
      const row = csvRow(["09:14", "V2608170001", "Devi, Asha", 'said "no"', "new"]);
      // Five fields in, five commas' worth of structure out — the two dangerous ones quoted.
      expect(row).toBe('09:14,V2608170001,"Devi, Asha","said ""no""",new');
    });
  });

  /**
   * WASA L-03 — CSV / FORMULA INJECTION. A spreadsheet EVALUATES a cell that begins `=`, `+`, `-`
   * or `@` (and one that begins with a tab or CR, which Excel strips before looking). A patient
   * registered as `=HYPERLINK("http://evil","Click")` reached `/me/report.csv` verbatim and became a
   * live link in the reconciler's Excel. OWASP's rule: prefix such a cell with `'`, which makes the
   * spreadsheet show the text and never run it. The kernel does it, so every export inherits it.
   */
  describe("L-03 — a cell that would be a formula is written as text", () => {
    it("prefixes each OWASP trigger character with a single quote", () => {
      expect(csvField("=1+1")).toBe("'=1+1");
      expect(csvField("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
      expect(csvField("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
      expect(csvField("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
      expect(csvField("\t=1+1")).toBe("'\t=1+1");
    });

    it("neutralises FIRST and quotes after, so the prefix sits inside the quotes", () => {
      // The audit's own payload: a quote inside, so the field is quoted and the quotes doubled.
      expect(csvField('=HYPERLINK("http://evil","Click")')).toBe('"\'=HYPERLINK(""http://evil"",""Click"")"');
      // A leading CR both triggers and needs quoting.
      expect(csvField("\r=1+1")).toBe('"\'\r=1+1"');
    });

    it("leaves a plain number — and the money this app formats — as a number", () => {
      // An inert numeric shape cannot call anything, and a refund column must still sum.
      for (const n of ["-150", "+5", "-0.50", "-₹150.00"]) expect(csvField(n)).toBe(n);
      // `formatPaise` groups thousands, so the comma still quotes the field — but no `'` goes in.
      expect(csvField("-₹1,500.00")).toBe('"-₹1,500.00"');
      expect(csvField("-1,23,456.78")).toBe('"-1,23,456.78"');
    });

    it("only the FIRST character decides, and an already-neutralised cell is not prefixed twice", () => {
      expect(csvField("Asha-Devi")).toBe("Asha-Devi");
      expect(csvField("a=b")).toBe("a=b");
      // `opd/report-render.ts` `sheetText` already writes `'=…`; the kernel must not add a second `'`.
      expect(csvField("'=1+1")).toBe("'=1+1");
    });

    it("a whole export carries the neutralised name in its column", () => {
      const doc = toCsv([["UHID", "Name"], ["W00110199", '=HYPERLINK("http://evil")']]);
      expect(doc).toBe('﻿UHID,Name\r\nW00110199,"\'=HYPERLINK(""http://evil"")"\r\n');
    });
  });

  describe("the document", () => {
    it("leads with a BOM, because Excel reads UTF-8 as ANSI without one", () => {
      // Half this hospital's patient names are Devanagari; without the BOM they arrive as mojibake.
      expect(toCsv([["नाम"]]).codePointAt(0)).toBe(0xFEFF);
      expect(toCsv([["नाम"]])).toContain("नाम");
    });

    it("separates rows with CRLF, as RFC 4180 says and Windows importers expect", () => {
      expect(toCsv([["a"], ["b"]])).toBe("﻿a\r\nb\r\n");
    });

    it("an empty report is still a well-formed document", () => {
      expect(toCsv([])).toBe("﻿\r\n");
    });
  });

  describe("the filename", () => {
    it("cannot steer a path or break the header", () => {
      expect(contentDisposition("my-day-2026-08-29.csv")).toBe('attachment; filename="my-day-2026-08-29.csv"');
      // A dot is legitimate in a filename and survives; the SLASH is what makes traversal possible
      // and it does not. `../x` becomes `..-x`, which names a file and cannot leave the directory.
      expect(contentDisposition("../x")).toBe('attachment; filename="..-x"');
      expect(contentDisposition("../../etc/passwd")).not.toContain("/");
      // A quote would end the header's own quoted-string and let a name inject a second parameter.
      expect(contentDisposition('a"b')).toBe('attachment; filename="a-b"');
      expect(contentDisposition('x"; filename="y')).not.toContain('"; filename="y');
    });
  });
});
