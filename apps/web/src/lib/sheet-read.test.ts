import { findHeaderRow, guessColumns, parseDelimited, readXlsx, sampleCsv } from "./sheet-read";
import { toXlsx } from "./xlsx";

/* Owner 2026-10-04 — a vendor's price list read in the browser: CSV, pasted Excel rows, or an .xlsx file. */
describe("reading a vendor's price list", () => {
  it("CSV with quotes, a comma inside a quoted cell, and a doubled quote", () => {
    expect(parseDelimited('Brand,Composition,Packing\n"Dolo 650","Paracetamol 650 mg",15\n"Ab ""X""","a, b",10x10\n')).toEqual([
      ["Brand", "Composition", "Packing"], ["Dolo 650", "Paracetamol 650 mg", "15"], ['Ab "X"', "a, b", "10x10"],
    ]);
  });

  it("rows pasted from Excel are tab-separated, and blank lines are dropped", () => {
    expect(parseDelimited("Manufacturer\tBrand\nMicro\tDolo 650\n\n")).toEqual([["Manufacturer", "Brand"], ["Micro", "Dolo 650"]]);
  });

  it("guesses each column from the vendor's headings", () => {
    expect(guessColumns(["Sr", "Manufacturer Name", "Brand Name", "Composition", "Packing", "M.R.P / MRP", "GST %", "HSN Code"]))
      .toEqual({ manufacturer: 1, brand: 2, composition: 3, pack: 4, mrp: 5, gst: 6, hsn: 7 });
  });

  it("reads the first sheet of an .xlsx back to text", async () => {
    const bytes = toXlsx({ name: "List", header: ["Brand", "Packing", "MRP"], rows: [["Dolo 650", "15", 30.5]] });
    expect(await readXlsx(bytes)).toEqual([["Brand", "Packing", "MRP"], ["Dolo 650", "15", "30.5"]]);
  });

  it("finds the heading row under a vendor's title and address", () => {
    const g = parseDelimited("Shree Ram Pharma Distributors\nPrice list Oct 2026,,\nSr,Brand Name,Packing,MRP\n1,Dolo 650,15 Tab,33.60\n");
    expect(findHeaderRow(g)).toBe(2);
    expect(findHeaderRow(parseDelimited("Brand,Packing\nDolo,15\n"))).toBe(0);
  });

  it("the sample CSV reads back with every column recognised", () => {
    const g = parseDelimited(sampleCsv());
    expect(guessColumns(g[0]!)).toEqual({ brand: 1, manufacturer: 0, composition: 2, pack: 3, hsn: 4, gst: 5, mrp: 6 });
    expect(g).toHaveLength(4);
  });
});

