import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  allocations, billingConfig, cashierSessions, creditNoteLines, creditNotes, dailyCloses,
  documentSeries, enteredInErrorMarks, invoiceLines, invoices, patients, receiptTenders, receipts,
  reconBatches, refundVouchers,
} from "./index";
import type { Db } from "../client";

let db: Db;
let teardown: () => Promise<void>;

const AT = new Date("2026-08-18T04:30:00.000Z"); // IST 2026-08-18 10:00
const DAY = "2026-08-18";

beforeAll(async () => {
  ({ db, teardown } = await setupTestDb());
});
afterAll(async () => teardown());
beforeEach(async () => truncateAll(db));

async function seedPatient(id = "p1"): Promise<string> {
  await db.insert(patients).values({ id, uhid: `UH-${id}`, name: "Test Patient", sex: "female", createdBy: "t", updatedBy: "t" });
  return id;
}

async function seedSession(id = "cs1", cashierUserId = "u-cashier", status = "open"): Promise<string> {
  await db.insert(cashierSessions).values({ id, cashierUserId, status, openedAt: AT, openingFloatPaise: 200_000 });
  return id;
}

async function seedInvoice(id = "inv1", invoiceNo = "INV/26-27/000001", patientId = "p1"): Promise<string> {
  await db.insert(invoices).values({
    id, invoiceNo, patientId, encounterId: "enc1", tariffVersionId: "v1",
    grossPaise: 60_000, discountPaise: 0, taxableBasePaise: 60_000, cgstPaise: 3600, sgstPaise: 3600,
    rawTotalPaise: 67_200, roundingPaise: 0, netPayablePaise: 67_200,
    issuedBy: "u-cashier", issuedAt: AT, serviceDay: DAY,
  });
  return id;
}

async function seedInvoiceLine(id = "il1", invoiceId = "inv1", lineNo = 1): Promise<string> {
  await db.insert(invoiceLines).values({
    id, invoiceId, lineNo, serviceId: "s1", serviceName: "OPD consultation", category: "consultation",
    qty: 1, unitPaise: 60_000, grossPaise: 60_000, candidates: [{ ruleKey: "R1", amountPaise: 0 }],
    discountPaise: 0, taxableBasePaise: 60_000, sacCode: "9993", rateBps: 1200, exempt: false,
    cgstPaise: 3600, sgstPaise: 3600, netPaise: 67_200,
  });
  return id;
}

async function seedReceipt(id = "rcp1", receiptNo = "RCP/26-27/000001", patientId = "p1", cashierSessionId = "cs1"): Promise<string> {
  await db.insert(receipts).values({
    id, receiptNo, patientId, cashierSessionId, receivedBy: "u-cashier", receivedAt: AT,
    serviceDay: DAY, totalPaise: 67_200,
  });
  return id;
}

test("all fourteen billing tables accept a row and select it back", async () => {
  await seedPatient();
  await seedSession();
  await seedInvoice();
  await seedInvoiceLine();
  await seedReceipt();
  await db.insert(billingConfig).values({
    id: "main", cashWarnPaise: 15_000_000, cashBlockPaise: 20_000_000, panThresholdPaise: 5_000_000,
    refundBankAbovePaise: 1_000_000, creditCapPaise: 5_000_000, outstandingCapPaise: 10_000_000,
    feeBps: { upi: 0, card: 150 }, reconTolerancePaise: 100,
    seriesPrefixes: { invoice: "INV", receipt: "RCP", creditNote: "CN", voucher: "RFV" },
    chargeRules: { opdConsult: { new: "s1", renewal: "s2" } }, updatedAt: AT,
  });
  await db.insert(documentSeries).values({ seriesKey: "invoice", fy: "2026-27" });
  await db.insert(creditNotes).values({
    id: "cn1", creditNoteNo: "CN/26-27/000001", invoiceId: "inv1", kind: "refund", reason: "duplicate charge",
    issuedBy: "u-cashier", issuedAt: AT, grossPaise: 60_000, discountPaise: 0, taxableBasePaise: 60_000,
    cgstPaise: 3600, sgstPaise: 3600, roundingPaise: 0, netPaise: 67_200,
  });
  await db.insert(creditNoteLines).values({
    id: "cnl1", creditNoteId: "cn1", invoiceLineId: "il1", qty: 1,
    grossPaise: 60_000, discountPaise: 0, taxableBasePaise: 60_000, cgstPaise: 3600, sgstPaise: 3600,
  });
  await db.insert(receiptTenders).values({ id: "rt1", receiptId: "rcp1", mode: "cash", amountPaise: 67_200 });
  await db.insert(allocations).values({
    id: "al1", receiptId: "rcp1", invoiceId: "inv1", amountPaise: 67_200, kind: "apply", actorId: "u-cashier", at: AT,
  });
  await db.insert(refundVouchers).values({
    id: "rv1", voucherNo: "RFV/26-27/000001", patientId: "p1", kind: "invoice_refund", creditNoteId: "cn1",
    invoiceId: "inv1", amountPaise: 67_200, method: "cash", reasonClass: "mistake", reason: "billed twice",
    guardFlags: [], approvalId: "ap1", requestedBy: "u-cashier", issuedAt: AT,
  });
  await db.insert(enteredInErrorMarks).values({ id: "eie1", docType: "receipt", docId: "rcp1", reason: "wrong patient", markedBy: "u-cashier", markedAt: AT });
  await db.insert(reconBatches).values({ id: "rb1", uploadedBy: "u-mgr", uploadedAt: AT, source: "upi", rowsTotal: 3, rowsMatched: 2, rowsMismatched: 1, rowsUnmatched: 0 });
  await db.insert(dailyCloses).values({ day: DAY, closedAt: AT, totals: { cashPaise: 67_200 } });

  // Unrolled on purpose: a loop over a UNION of table types does not typecheck against
  // drizzle's from() overloads (the tariff.test.ts precedent).
  expect((await db.select().from(billingConfig)).length).toBe(1);
  expect((await db.select().from(documentSeries))[0]?.nextNo).toBe(1);
  expect((await db.select().from(invoices))[0]?.invoiceNo).toBe("INV/26-27/000001");
  expect((await db.select().from(invoiceLines))[0]?.sacCode).toBe("9993");
  expect((await db.select().from(creditNotes))[0]?.kind).toBe("refund");
  expect((await db.select().from(creditNoteLines))[0]?.qty).toBe(1);
  expect((await db.select().from(receipts))[0]?.serviceDay).toBe(DAY); // date mode:'string' round-trip
  expect((await db.select().from(receiptTenders))[0]?.state).toBe("captured"); // E-25 default
  expect((await db.select().from(allocations))[0]?.kind).toBe("apply");
  expect((await db.select().from(refundVouchers))[0]?.status).toBe("issued");
  expect((await db.select().from(cashierSessions))[0]?.status).toBe("open");
  expect((await db.select().from(enteredInErrorMarks))[0]?.docId).toBe("rcp1");
  expect((await db.select().from(reconBatches))[0]?.rowsUnmatched).toBe(0);
  expect((await db.select().from(dailyCloses))[0]?.day).toBe(DAY);
});

test("bigint paise columns round-trip as JS numbers (never strings, never floats)", async () => {
  await seedPatient();
  await seedSession();
  await seedInvoice();
  const invoice = (await db.select().from(invoices))[0];
  expect(invoice?.grossPaise).toBe(60_000);
  expect(invoice?.cgstPaise).toBe(3600);
  expect(invoice?.netPayablePaise).toBe(67_200);
  expect(typeof invoice?.grossPaise).toBe("number");
  expect(typeof invoice?.netPayablePaise).toBe("number");
  expect(Number.isInteger(invoice?.netPayablePaise)).toBe(true);
});

test("crore-scale paise (10^12) round-trips through bigint mode:number as a JS number", async () => {
  // ₹10,00,00,00,000 (₹1,000 crore) = 10^12 paise — well inside Number.MAX_SAFE_INTEGER, and
  // the reason money is bigint and not integer. Verify-by-execution flag ④.
  const crore = 1_000_000_000_000;
  await seedPatient();
  await seedSession();
  await db.insert(invoices).values({
    id: "inv-big", invoiceNo: "INV/26-27/000009", patientId: "p1", tariffVersionId: "v1",
    grossPaise: crore, discountPaise: 0, taxableBasePaise: crore, cgstPaise: 0, sgstPaise: 0,
    rawTotalPaise: crore, roundingPaise: 0, netPayablePaise: crore,
    issuedBy: "u-cashier", issuedAt: AT, serviceDay: DAY,
  });
  const big = (await db.select().from(invoices))[0];
  expect(big?.grossPaise).toBe(crore);
  expect(big?.netPayablePaise).toBe(crore);
  expect(typeof big?.netPayablePaise).toBe("number");
  expect(big?.netPayablePaise).toBeLessThan(Number.MAX_SAFE_INTEGER);
});

test("jsonb columns round-trip structurally (line candidates, denominations, close totals)", async () => {
  await seedPatient();
  await seedSession();
  await seedInvoice();
  const candidates = [
    { ruleKey: "SENIOR", sourceKey: "rule", amountPaise: 1500, requiresApproval: false },
    { ruleKey: "MANUAL", sourceKey: "manual", amountPaise: 2000, requiresApproval: true },
  ];
  await db.insert(invoiceLines).values({
    id: "il-json", invoiceId: "inv1", lineNo: 7, serviceId: "s1", serviceName: "Svc", category: "procedure",
    qty: 2, unitPaise: 30_000, grossPaise: 60_000, candidates, winner: candidates[1],
    regulatedClamp: { ceilingPaise: 55_000, applied: true },
    discountPaise: 2000, taxableBasePaise: 58_000, sacCode: "9993", rateBps: 1200, exempt: false,
    cgstPaise: 3480, sgstPaise: 3480, netPaise: 64_960,
  });
  await db.insert(cashierSessions).values({
    id: "cs-json", cashierUserId: "u-other", status: "closed", openedAt: AT, openingFloatPaise: 0,
    denominations: { "50000": 3, "10000": 2, "500": 4 },
  });
  await db.insert(dailyCloses).values({ day: "2026-08-19", closedAt: AT, totals: { byMode: { cash: 1000, upi: 2000 }, degradedPaise: 0 } });

  const line = (await db.select().from(invoiceLines))[0];
  expect(line?.candidates).toEqual(candidates);
  expect(line?.winner).toEqual(candidates[1]);
  expect(line?.regulatedClamp).toEqual({ ceilingPaise: 55_000, applied: true });
  // Two sessions exist here (seedSession's cs1 + cs-json) and select() has no ORDER BY —
  // pick the row under test by id, never by position.
  const session = (await db.select().from(cashierSessions)).find((r) => r.id === "cs-json");
  expect(session?.denominations).toEqual({ "50000": 3, "10000": 2, "500": 4 });
  expect((await db.select().from(dailyCloses))[0]?.totals).toEqual({ byMode: { cash: 1000, upi: 2000 }, degradedPaise: 0 });
});

test("partial unique index: one LIVE session per cashier; a closed one frees the cashier", async () => {
  await seedSession("cs-open", "u-cashier", "open");
  // A second live row for the same cashier violates the invariant at the database layer.
  await expect(seedSession("cs-dup", "u-cashier", "open")).rejects.toMatchObject({ code: "23505" });
  await expect(seedSession("cs-dup2", "u-cashier", "closing")).rejects.toMatchObject({ code: "23505" });
  // A different cashier is fine, and so is a CLOSED row for the same cashier — the WHERE
  // predicate is live, not decorative.
  await seedSession("cs-other", "u-other", "open");
  await seedSession("cs-closed", "u-cashier", "closed");
  await seedSession("cs-closed2", "u-cashier", "closed");
});

test("unique index: an invoice cannot carry two lines with the same line number", async () => {
  await seedPatient();
  await seedSession();
  await seedInvoice();
  await seedInvoiceLine("il1", "inv1", 1);
  await expect(seedInvoiceLine("il-dup", "inv1", 1)).rejects.toMatchObject({ code: "23505" });
  await seedInvoiceLine("il2", "inv1", 2);
  // A second invoice restarts at line 1 — the index is per invoice.
  await seedInvoice("inv2", "INV/26-27/000002");
  await seedInvoiceLine("il3", "inv2", 1);
  // …and the document numbers themselves are unique across the series.
  await expect(seedInvoice("inv3", "INV/26-27/000002")).rejects.toMatchObject({ code: "23505" });
});

test("seq bigserials populate ascending on invoices, receipts and allocations (§3.26 — never ORDER BY id)", async () => {
  await seedPatient();
  await seedSession();
  // Ids deliberately out of lexical order: arrival order must come from seq, not from the id.
  await seedInvoice("zz-inv", "INV/26-27/000010");
  await seedInvoice("aa-inv", "INV/26-27/000011");
  await seedReceipt("zz-rcp", "RCP/26-27/000010");
  await seedReceipt("aa-rcp", "RCP/26-27/000011");
  await db.insert(allocations).values({ id: "zz-al", receiptId: "zz-rcp", invoiceId: "zz-inv", amountPaise: 100, kind: "apply", actorId: "u", at: AT });
  await db.insert(allocations).values({ id: "aa-al", receiptId: "aa-rcp", invoiceId: "aa-inv", amountPaise: 200, kind: "apply", actorId: "u", at: AT });

  const inv = await db.select().from(invoices);
  const first = inv.find((r) => r.id === "zz-inv");
  const second = inv.find((r) => r.id === "aa-inv");
  expect(typeof first?.seq).toBe("number");
  expect(second!.seq).toBeGreaterThan(first!.seq);
  const rcp = await db.select().from(receipts);
  expect(rcp.find((r) => r.id === "aa-rcp")!.seq).toBeGreaterThan(rcp.find((r) => r.id === "zz-rcp")!.seq);
  const alloc = await db.select().from(allocations);
  expect(alloc.find((r) => r.id === "aa-al")!.seq).toBeGreaterThan(alloc.find((r) => r.id === "zz-al")!.seq);
});

test("truncateAll empties every billing table in one statement (FK group proof — §3.12)", async () => {
  await seedPatient();
  await seedSession();
  await seedInvoice();
  await seedInvoiceLine();
  await seedReceipt();
  await db.insert(receiptTenders).values({ id: "rt1", receiptId: "rcp1", mode: "upi", amountPaise: 67_200, refText: "UPI-1" });
  await db.insert(allocations).values({ id: "al1", receiptId: "rcp1", invoiceId: "inv1", amountPaise: 67_200, kind: "apply", actorId: "u", at: AT });
  await db.insert(creditNotes).values({
    id: "cn1", creditNoteNo: "CN/26-27/000001", invoiceId: "inv1", kind: "correction", reason: "entered in error",
    issuedBy: "u", issuedAt: AT, grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPaise: 0,
  });
  await db.insert(creditNoteLines).values({ id: "cnl1", creditNoteId: "cn1", invoiceLineId: "il1", qty: 1, grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0 });
  await db.insert(refundVouchers).values({
    id: "rv1", voucherNo: "RFV/26-27/000001", patientId: "p1", kind: "advance_refund", amountPaise: 100,
    method: "bank_transfer", reasonClass: "genuine", reason: "unused advance", guardFlags: [], approvalId: "ap1",
    requestedBy: "u", issuedAt: AT,
  });
  await db.insert(billingConfig).values({
    id: "main", cashWarnPaise: 1, cashBlockPaise: 2, panThresholdPaise: 3, refundBankAbovePaise: 4,
    creditCapPaise: 5, outstandingCapPaise: 6, feeBps: {}, reconTolerancePaise: 7,
    seriesPrefixes: {}, chargeRules: {}, updatedAt: AT,
  });
  await db.insert(documentSeries).values({ seriesKey: "invoice", fy: "2026-27" });
  await db.insert(enteredInErrorMarks).values({ id: "eie1", docType: "invoice", docId: "inv1", reason: "r", markedBy: "u", markedAt: AT });
  await db.insert(reconBatches).values({ id: "rb1", uploadedBy: "u", uploadedAt: AT, source: "card", rowsTotal: 0, rowsMatched: 0, rowsMismatched: 0, rowsUnmatched: 0 });
  await db.insert(dailyCloses).values({ day: DAY, closedAt: AT, totals: {} });

  await truncateAll(db);

  expect((await db.select().from(billingConfig)).length).toBe(0);
  expect((await db.select().from(documentSeries)).length).toBe(0);
  expect((await db.select().from(invoices)).length).toBe(0);
  expect((await db.select().from(invoiceLines)).length).toBe(0);
  expect((await db.select().from(creditNotes)).length).toBe(0);
  expect((await db.select().from(creditNoteLines)).length).toBe(0);
  expect((await db.select().from(receipts)).length).toBe(0);
  expect((await db.select().from(receiptTenders)).length).toBe(0);
  expect((await db.select().from(allocations)).length).toBe(0);
  expect((await db.select().from(refundVouchers)).length).toBe(0);
  expect((await db.select().from(cashierSessions)).length).toBe(0);
  expect((await db.select().from(enteredInErrorMarks)).length).toBe(0);
  expect((await db.select().from(reconBatches)).length).toBe(0);
  expect((await db.select().from(dailyCloses)).length).toBe(0);
});
