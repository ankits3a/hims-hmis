import { describe, expect, it } from "vitest";
import { csvRupees, toCsv } from "./payables-api";

/**
 * WASA L-03, THE SECOND WRITER. The pharmacy office's CSVs (payables ageing, supplier summary, the
 * ledger, expiry returns, the reports tab) are built HERE, in the browser, not by the kernel's
 * `report/csv.ts` — so they needed the same rule: a text cell that starts `= + - @`, a tab or a CR is
 * written with a leading `'`, so a spreadsheet shows it and never evaluates it. A supplier's name or
 * bill number is typed by a person, and the file is opened by the accounts office.
 */
describe("payables CSV — a cell that would be a formula is written as text (L-03)", () => {
  it("prefixes a text cell that starts with a trigger character", () => {
    expect(toCsv(["Supplier"], [["=HYPERLINK(\"http://evil\")"], ["+cmd|' /C calc'!A0"], ["@SUM(A1)"], ["-2+3"], ["\t=1"]]))
      .toBe('Supplier\r\n"\'=HYPERLINK(""http://evil"")"\r\n\'+cmd|\' /C calc\'!A0\r\n\'@SUM(A1)\r\n\'-2+3\r\n\'\t=1\r\n');
  });

  it("leaves numbers alone — a JS number, and the rupee strings csvRupees makes for a refund", () => {
    expect(toCsv(["Amount", "Days"], [[csvRupees(-150_000), -3], ["-0.50", 12]])).toBe("Amount,Days\r\n-1500.00,-3\r\n-0.50,12\r\n");
  });

  it("quotes a CR as RFC 4180 requires, as it already did a comma, a quote and an LF", () => {
    expect(toCsv(["Note"], [["a\rb"]])).toBe('Note\r\n"a\rb"\r\n');
  });
});
