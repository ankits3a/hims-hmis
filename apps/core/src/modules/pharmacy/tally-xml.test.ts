import { allNamed as all, childText as child, parseXml, tallyPaise as paiseOf } from "../../../test/helpers/xml";
import { DEFAULT_TALLY_LEDGERS, buildVouchers, cleanLedgers, mastersXml, tallyAmount, vouchersXml, xmlEscape } from "./tally";
import type { TallySource, TallyVoucherKind } from "./tally";

/**
 * ═══ PHARMACY PARITY P5 — THE TALLYPRIME XML, PURE ═══
 *
 * Every voucher type the export writes, built from documents with awkward paise (odd tax splits, a
 * negative and a positive rounding, a round-off on a supplier bill, a split tender) — then the FILE
 * is parsed back as XML by a strict reader (`test/helpers/xml.ts`) and every VOUCHER in it is summed: Tally rejects a
 * voucher whose amounts do not add to zero, so the file itself is what is checked, not the builder's
 * own arithmetic. A debit is ISDEEMEDPOSITIVE Yes with a negative AMOUNT, on every entry.
 */

const ACME = { name: "ACME Pharma & Sons <Pune>", gstin: "27AAACA1234A1Z5" };
const DELHI = { name: "Delhi Drug House", gstin: "07AAACD1234A1Z5" };
const RAMESH = { name: "Ramesh \"Ramu\" Patil", uhid: "UH0001" };

const SOURCE: TallySource = {
  sales: [
    { id: "inv-1", no: "INV/26-27/000001", date: "2026-09-25", ref: "P2609250001", patient: RAMESH, taxablePaise: 4_286, cgstPaise: 107, sgstPaise: 107, roundingPaise: 0, netPaise: 4_500 },
    // one bill rounded up by a paisa to the rupee, one rounded down by two
    { id: "inv-2", no: "INV/26-27/000002", date: "2026-09-25", ref: null, patient: RAMESH, taxablePaise: 10_714, cgstPaise: 642, sgstPaise: 643, roundingPaise: 1, netPaise: 12_000 },
    { id: "inv-3", no: "INV/26-27/000003", date: "2026-09-26", ref: null, patient: RAMESH, taxablePaise: 8_931, cgstPaise: 535, sgstPaise: 536, roundingPaise: -2, netPaise: 10_000 },
  ],
  salesReturns: [
    { id: "cn-1", no: "CN/26-27/000001", date: "2026-09-26", invoiceNo: "INV/26-27/000001", patient: RAMESH, taxablePaise: 4_286, cgstPaise: 107, sgstPaise: 107, roundingPaise: 0, netPaise: 4_500 },
    { id: "cn-2", no: "CN/26-27/000002", date: "2026-09-26", invoiceNo: "INV/26-27/000002", patient: RAMESH, taxablePaise: 1_071, cgstPaise: 64, sgstPaise: 65, roundingPaise: 0, netPaise: 1_200 },
  ],
  receipts: [{ id: "rcp-1", no: "RCP/26-27/000001", date: "2026-09-25", patient: RAMESH, invoiceNos: ["INV/26-27/000001", "INV/26-27/000002"], cashPaise: 4_500, bankPaise: 12_000 }],
  refunds: [{ id: "rfv-1", no: "RFV/26-27/000001", date: "2026-09-27", patient: RAMESH, invoiceNo: "INV/26-27/000001", amountPaise: 4_500, cash: true }],
  purchases: [
    { id: "b-1", no: "MSB2609240001", date: "2026-09-24", vendorBillNo: "ACME/0042", vendor: ACME, taxablePaise: 250_000, cgstPaise: 15_000, sgstPaise: 15_000, igstPaise: 0, roundOffPaise: 0, totalPaise: 280_000 },
    { id: "b-2", no: "MSB2609240002", date: "2026-09-24", vendorBillNo: "DDH/77", vendor: DELHI, taxablePaise: 100_333, cgstPaise: 0, sgstPaise: 0, igstPaise: 12_040, roundOffPaise: -73, totalPaise: 112_300 },
    { id: "b-3", no: "MSB2609240003", date: "2026-09-24", vendorBillNo: "ACME/0043", vendor: ACME, taxablePaise: 9_999, cgstPaise: 600, sgstPaise: 600, igstPaise: 0, roundOffPaise: 1, totalPaise: 11_200 },
  ],
  debitNotes: [{ id: "r-1", no: "MDN2609250001", date: "2026-09-25", returnNo: "MRT2609250001", vendor: ACME, taxablePaise: 5_000, cgstPaise: 300, sgstPaise: 300, igstPaise: 0, totalPaise: 5_600 }],
  supplierPayments: [
    { id: "p-1", no: "MPV2609280001", date: "2026-09-28", vendor: ACME, mode: "neft", reference: "UTR123", amountPaise: 274_400, bills: ["MSB2609240001 (ACME/0042)"] },
    { id: "p-2", no: "MPV2609280002", date: "2026-09-28", vendor: DELHI, mode: "cash", reference: null, amountPaise: 9_999, bills: ["MSB2609240002 (DDH/77)"] },
  ],
  adjustments: [
    { kind: "short_credit", id: "cr-1", no: "MCN2609270001", date: "2026-09-27", ref: "MDN2609250001", reason: "vendor allowed the net only", vendor: ACME, amountPaise: 600 },
    { kind: "closed", id: "r-2", no: "MRT2609200001", date: "2026-09-27", ref: "MDN2609200001", reason: "vendor shut down", vendor: DELHI, amountPaise: 3_360 },
  ],
};

describe("the TallyPrime XML (parity P5)", () => {
  it("writes every voucher type, balanced, and the file parses as XML with each VOUCHER summing to zero", () => {
    const l = cleanLedgers({ ...DEFAULT_TALLY_LEDGERS, companyName: "Sunrise Hospital Pvt Ltd" });
    const { vouchers } = buildVouchers(SOURCE, l);
    const kinds = new Set<TallyVoucherKind>(vouchers.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(["credit_shortfall", "purchase", "purchase_return", "receipt", "refund", "return_closed", "sale", "sales_return", "supplier_payment"]);
    const doc = parseXml(vouchersXml(vouchers, l));
    expect(doc.name).toBe("ENVELOPE");
    expect(child(all(doc, "HEADER")[0]!, "TALLYREQUEST")).toBe("Import Data");
    expect(child(all(doc, "REQUESTDESC")[0]!, "REPORTNAME")).toBe("Vouchers");
    expect(child(all(doc, "STATICVARIABLES")[0]!, "SVCURRENTCOMPANY")).toBe("Sunrise Hospital Pvt Ltd");
    const parsed = all(doc, "VOUCHER");
    expect(parsed).toHaveLength(vouchers.length);
    for (const v of parsed) {
      const entries = all(v, "ALLLEDGERENTRIES.LIST");
      expect(entries.length).toBeGreaterThanOrEqual(2);
      const amounts = entries.map((e) => paiseOf(child(e, "AMOUNT")));
      expect({ number: child(v, "VOUCHERNUMBER"), sum: amounts.reduce((s, a) => s + a, 0) }).toEqual({ number: child(v, "VOUCHERNUMBER"), sum: 0 });
      for (const e of entries) expect(child(e, "ISDEEMEDPOSITIVE")).toBe(paiseOf(child(e, "AMOUNT")) < 0 ? "Yes" : "No");
      expect(child(v, "DATE")).toMatch(/^2026092\d$/);
      expect(v.attrs.VCHTYPE).toBe(child(v, "VOUCHERTYPENAME"));
      expect(v.attrs.REMOTEID).toMatch(/^hmis:[a-z_]+:/);
    }
    // One of each, read off the file: the sale's party is debited the bill, sales and GST credited.
    const sale = parsed.find((v) => child(v, "VOUCHERNUMBER") === "INV/26-27/000002")!;
    expect(sale.attrs.VCHTYPE).toBe("Sales");
    expect(all(sale, "ALLLEDGERENTRIES.LIST").map((e) => [child(e, "LEDGERNAME"), child(e, "AMOUNT")])).toEqual([
      ["Ramesh \"Ramu\" Patil (UH0001)", "-120.00"], ["Pharmacy Sales", "107.14"], ["Output CGST", "6.42"], ["Output SGST", "6.43"], ["Round Off", "0.01"],
    ]);
    const igstBill = parsed.find((v) => child(v, "VOUCHERNUMBER") === "MSB2609240002")!;
    expect([igstBill.attrs.VCHTYPE, child(igstBill, "REFERENCE")]).toEqual(["Purchase", "DDH/77"]);
    expect(all(igstBill, "ALLLEDGERENTRIES.LIST").map((e) => [child(e, "LEDGERNAME"), child(e, "AMOUNT")])).toEqual([
      ["Purchase — Medicines", "-1003.33"], ["Input IGST", "-120.40"], ["Round Off", "0.73"], ["Delhi Drug House", "1123.00"],
    ]);
    const cashPay = parsed.find((v) => child(v, "VOUCHERNUMBER") === "MPV2609280002")!;
    expect(all(cashPay, "ALLLEDGERENTRIES.LIST").map((e) => [child(e, "LEDGERNAME"), child(e, "AMOUNT")])).toEqual([["Delhi Drug House", "-99.99"], ["Cash", "99.99"]]);
    const receipt = parsed.find((v) => v.attrs.VCHTYPE === "Receipt")!;
    expect(all(receipt, "ALLLEDGERENTRIES.LIST").map((e) => [child(e, "LEDGERNAME"), child(e, "AMOUNT")])).toEqual([["Cash", "-45.00"], ["Bank", "-120.00"], ["Ramesh \"Ramu\" Patil (UH0001)", "165.00"]]);
    expect(parsed.filter((v) => v.attrs.VCHTYPE === "Journal").map((v) => child(v, "VOUCHERNUMBER"))).toEqual(["MCN2609270001", "MRT2609200001"]);
  });

  it("the masters file names every ledger the vouchers use, each under its group, the vendors with their GSTIN", () => {
    const { vouchers, parties } = buildVouchers(SOURCE, DEFAULT_TALLY_LEDGERS);
    const doc = parseXml(mastersXml(vouchers, parties, DEFAULT_TALLY_LEDGERS));
    expect(child(all(doc, "REQUESTDESC")[0]!, "REPORTNAME")).toBe("All Masters");
    const ledgers = new Map(all(doc, "LEDGER").map((n) => [n.attrs.NAME!, n] as const));
    const used = new Set(vouchers.flatMap((v) => v.entries.map((e) => e.ledger)));
    expect([...ledgers.keys()].sort()).toEqual([...used].sort());
    expect(child(ledgers.get("Output CGST")!, "PARENT")).toBe("Duties & Taxes");
    expect(child(ledgers.get("Cash")!, "PARENT")).toBe("Cash-in-Hand");
    expect(child(ledgers.get("ACME Pharma & Sons <Pune>")!, "PARENT")).toBe("Sundry Creditors");
    expect(child(ledgers.get("ACME Pharma & Sons <Pune>")!, "PARTYGSTIN")).toBe("27AAACA1234A1Z5");
    expect(child(ledgers.get("Ramesh \"Ramu\" Patil (UH0001)")!, "PARENT")).toBe("Sundry Debtors");
  });

  it("one patients ledger when the accountant asks for it; a renamed ledger is used everywhere", () => {
    const l = cleanLedgers({ ...DEFAULT_TALLY_LEDGERS, patientParty: "single", patientLedger: "Pharmacy Patients", bank: "  HDFC   Current A/c " });
    const { vouchers } = buildVouchers(SOURCE, l);
    expect(new Set(vouchers.filter((v) => ["sale", "sales_return", "receipt", "refund"].includes(v.kind)).map((v) => v.party))).toEqual(new Set(["Pharmacy Patients"]));
    expect(vouchers.find((v) => v.kind === "supplier_payment" && v.number === "MPV2609280001")!.entries.map((e) => e.ledger)).toEqual(["ACME Pharma & Sons <Pune>", "HDFC Current A/c"]);
    expect(() => cleanLedgers({ ...DEFAULT_TALLY_LEDGERS, cash: "  " })).toThrow(expect.objectContaining({ code: "invalid_tally_ledgers" }));
  });

  it("refuses the whole file when a voucher would not balance", () => {
    const broken: TallySource = { ...SOURCE, sales: [{ ...SOURCE.sales[0]!, netPaise: 4_501 }] };
    expect(() => buildVouchers(broken, DEFAULT_TALLY_LEDGERS)).toThrow(expect.objectContaining({ code: "tally_unbalanced", detail: expect.objectContaining({ sum: 1 }) }));
  });

  it("Tally's amount: a debit negative, two decimals; names escaped", () => {
    expect([tallyAmount(12_345), tallyAmount(-12_345), tallyAmount(5), tallyAmount(-100), tallyAmount(0)]).toEqual(["-123.45", "123.45", "-0.05", "1.00", "0.00"]);
    expect(xmlEscape(`A&B <"C"> 'D'\u0007`)).toBe("A&amp;B &lt;&quot;C&quot;&gt; &apos;D&apos;");
  });
});
