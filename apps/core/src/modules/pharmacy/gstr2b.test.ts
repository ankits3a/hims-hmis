import { TOLERANCE_PAISE, isoDateOf, matchGstr2b, parseGstr2bCsv, parseGstr2bJson } from "./gstr2b";
import type { ReconBill } from "../materials";

/**
 * ═══ PHARMACY PARITY P5 — GSTR-2B AGAINST THE BOOKS, PURE ═══
 *
 * The portal's JSON and the Excel's B2B sheet saved as CSV both read to the same documents; the
 * match puts every document in exactly one bucket, and the ₹1 tolerance is inclusive: 100 paise apart
 * is matched, 101 is a mismatch.
 */
const bill = (over: Partial<ReconBill> = {}): ReconBill => ({
  id: "b-1", billNo: "MSB2609240001", vendorId: "v-acme", vendorName: "ACME Pharma", gstin: "27AAACA1234A1Z5", vendorBillNo: "ACME/0042",
  billDate: "2026-09-24", status: "accepted", taxablePaise: 250_000, cgstPaise: 15_000, sgstPaise: 15_000, igstPaise: 0, totalPaise: 280_000, ...over,
});

const PORTAL = JSON.stringify({
  chksum: "x",
  data: {
    gstin: "27AABCH1234H1Z1", rtnprd: "092026", version: "1.0", gendt: "14-10-2026",
    docdata: {
      b2b: [
        { ctin: "27AAACA1234A1Z5", trdnm: "ACME PHARMA", supprd: "092026", inv: [
          { inum: "acme 0042", typ: "R", dt: "24-09-2026", val: 2800, pos: "27", rev: "N", itcavl: "Y", txval: 2500, igst: 0, cgst: 150, sgst: 150, cess: 0 },
          { inum: "ACME/0043", typ: "R", dt: "25-09-2026", val: 1120, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 12, txval: 1000, igst: 0, cgst: 60, sgst: 60, cess: 0 }] },
        ] },
      ],
      cdnr: [{ ctin: "27AAACA1234A1Z5", trdnm: "ACME PHARMA", nt: [{ ntnum: "ACME-CN-7", typ: "C", dt: "26-09-2026", val: 56, txval: 50, igst: 0, cgst: 3, sgst: 3 }] }],
    },
  },
});

describe("GSTR-2B against the books (parity P5)", () => {
  it("reads the portal's JSON: invoice-level figures, or the items' sum; the credit notes apart", () => {
    const p = parseGstr2bJson(PORTAL);
    expect([p.period, p.gstin]).toEqual(["092026", "27AABCH1234H1Z1"]);
    expect(p.docs.map((d) => [d.gstin, d.invoiceKey, d.date, d.taxablePaise, d.cgstPaise, d.sgstPaise, d.valuePaise])).toEqual([
      ["27AAACA1234A1Z5", "ACME0042", "2026-09-24", 250_000, 15_000, 15_000, 280_000],
      ["27AAACA1234A1Z5", "ACME0043", "2026-09-25", 100_000, 6_000, 6_000, 112_000],
    ]);
    expect(p.notes.map((n) => [n.invoiceNo, n.noteType, n.valuePaise])).toEqual([["ACME-CN-7", "C", 5_600]]);
    expect(() => parseGstr2bJson("not json")).toThrow(expect.objectContaining({ code: "gst_statement_unreadable" }));
    expect(() => parseGstr2bJson("{\"data\":{}}")).toThrow(expect.objectContaining({ code: "gst_statement_unreadable" }));
  });

  it("reads the Excel's B2B sheet saved as CSV: title rows skipped, the header found, quoted cells and rupee commas read", () => {
    const csv = [
      "Goods and Services Tax - GSTR-2B,,,,,,,,,,,",
      "Taxable inward supplies received from registered persons,,,,,,,,,,,",
      "GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value(₹),Place of supply,Supply Attract Reverse Charge,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹)",
      "27AAACA1234A1Z5,\"ACME PHARMA, PUNE\",ACME/0042,Regular,24/09/2026,\"2,800.00\",Maharashtra,N,\"2,500.00\",0.00,150.00,150.00",
      "Total,,,,,,,,2500,0,150,150",
    ].join("\r\n");
    const p = parseGstr2bCsv(`﻿${csv}`);
    expect(p.docs.map((d) => [d.gstin, d.tradeName, d.invoiceKey, d.date, d.taxablePaise, d.cgstPaise, d.valuePaise])).toEqual([
      ["27AAACA1234A1Z5", "ACME PHARMA, PUNE", "ACME0042", "2026-09-24", 250_000, 15_000, 280_000],
    ]);
    expect(() => parseGstr2bCsv("a,b,c\n1,2,3")).toThrow(expect.objectContaining({ code: "gst_statement_unreadable" }));
    expect([isoDateOf("5-9-2026"), isoDateOf("2026-09-05"), isoDateOf("05-Sep-2026"), isoDateOf("soon")]).toEqual(["2026-09-05", "2026-09-05", "2026-09-05", "soon"]);
  });

  it("puts every document in one bucket: matched, amount or date mismatch, in the 2B only", () => {
    const docs = parseGstr2bJson(PORTAL).docs;
    const rows = matchGstr2b(docs, [bill(), bill({ id: "b-2", billNo: "MSB2609250001", vendorBillNo: "ACME-0043", billDate: "2026-09-26", taxablePaise: 100_000, cgstPaise: 6_000, sgstPaise: 6_000 })]);
    expect(rows.map((r) => [r.invoiceNo, r.bucket, r.books?.billNo ?? null, r.diffs.map((d) => d.field)])).toEqual([
      ["acme 0042", "matched", "MSB2609240001", []],
      ["ACME/0043", "mismatch", "MSB2609250001", ["date"]],
    ]);
    const onlyTwoB = matchGstr2b(docs, [bill({ gstin: "27AAACB9999B1Z5" })]);
    expect(onlyTwoB.map((r) => r.bucket)).toEqual(["only_2b", "only_2b"]);
    // A vendor with no GSTIN on record is never found in a 2B.
    expect(matchGstr2b(docs, [bill({ gstin: null })]).map((r) => r.bucket)).toEqual(["only_2b", "only_2b"]);
  });

  it("the ₹1 tolerance is inclusive, per head: 100 paise apart matches, 101 does not", () => {
    const doc = parseGstr2bJson(PORTAL).docs.slice(0, 1);
    expect(TOLERANCE_PAISE).toBe(100);
    expect(matchGstr2b(doc, [bill({ taxablePaise: 250_100 })])[0]!.bucket).toBe("matched");
    expect(matchGstr2b(doc, [bill({ taxablePaise: 249_900, cgstPaise: 14_900 })])[0]!.bucket).toBe("matched");
    const out = matchGstr2b(doc, [bill({ taxablePaise: 250_101 })])[0]!;
    expect([out.bucket, out.diffs]).toEqual(["mismatch", [{ field: "taxable", twoB: 250_000, books: 250_101 }]]);
    expect(matchGstr2b(doc, [bill({ sgstPaise: 14_899 })])[0]!.diffs.map((d) => d.field)).toEqual(["sgst"]);
    expect(matchGstr2b(doc, [bill({ igstPaise: 101, cgstPaise: 15_000 })])[0]!.diffs.map((d) => d.field)).toEqual(["igst"]);
  });

  it("two filings of one invoice look for one bill: the first takes it, the second is in the 2B only", () => {
    const one = parseGstr2bJson(PORTAL).docs[0]!;
    const rows = matchGstr2b([one, { ...one }], [bill()]);
    expect(rows.map((r) => r.bucket)).toEqual(["matched", "only_2b"]);
  });
});
