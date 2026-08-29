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
