import { colName, crc32, toXlsx, toXlsxBook, zipStored } from "./xlsx";

/** STAGE C — the minimal .xlsx writer: the ZIP's checksum and layout, the column letters, the cells. */
describe("the .xlsx writer", () => {
  it("CRC-32 is the IEEE one (the check value of \"123456789\" is CBF43926)", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("a stored ZIP: local headers, then the central directory, then the end record counting the entries", () => {
    const z = zipStored([{ name: "a.txt", data: new TextEncoder().encode("hello") }, { name: "b/c.xml", data: new TextEncoder().encode("<x/>") }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cdOffset = v.getUint32(end + 16, true);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(cdOffset + v.getUint32(end + 12, true)).toBe(end);
    // The second entry's offset in the central directory points at its local header.
    const second = cdOffset + 46 + "a.txt".length;
    expect(v.getUint32(v.getUint32(second + 42, true), true)).toBe(0x04034b50);
  });

  it("column letters run A…Z, AA…", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("cells: text stays text (a leading zero, an e-notation batch), numbers are numbers, XML is escaped, empties are left out", () => {
    const bytes = toXlsx({ name: "GST: a/b [test]", header: ["Code", "Qty", "Amount"], rows: [["007", 3, 12.5], ["1E5 <&>", null, 0]], money: [false, false, true] });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">007</t></is></c>');
    expect(text).toContain('<c r="B2"><v>3</v></c><c r="C2" s="2"><v>12.5</v></c>');
    expect(text).toContain("1E5 &lt;&amp;&gt;");
    expect(text).not.toContain('r="B3"');
    expect(text).toContain('<sheet name="GST  a b  test" sheetId="1"');
  });

  /* Owner 2026-10-03 — the accounts' Export all: one workbook, one sheet per section, names unique. */
  it("a workbook of several sheets: one part and one workbook entry per sheet, a repeated name made unique", () => {
    const text = new TextDecoder().decode(toXlsxBook([
      { name: "Summary", header: ["Item", "Amount"], rows: [["Sales", 100]], money: [false, true] },
      { name: "Documents", header: ["No"], rows: [["INV-1"]] },
      { name: "Summary", header: ["X"], rows: [] },
    ]));
    expect(text).toContain('<sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Documents" sheetId="2" r:id="rId2"/><sheet name="Summary 2" sheetId="3" r:id="rId3"/>');
    for (const n of [1, 2, 3]) expect(text).toContain(`xl/worksheets/sheet${String(n)}.xml`);
    expect(text).toContain('Target="styles.xml"');
    expect(text).toContain("INV-1");
  });
});
