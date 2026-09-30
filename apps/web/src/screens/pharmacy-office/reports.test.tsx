import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice, PharmacyOfficeReports } from "./pharmacy-office";
import { crc32 } from "../../lib/xlsx";
import type {
  WireActivity, WireCatalogue, WireDailyStock, WireGstr2b, WireLossRegister, WireNonMoving, WireSalesRegister, WireSalesRow, WireTopSelling,
} from "../../lib/reports-api";

/**
 * PHARMACY PARITY P5 — the office's Reports: the owner (who buys nothing) lands on them; a number
 * opens a report; the sales register shows each bill with its totals row and opens to its batch
 * lines; profit only for the margin reader, and the Margin report only offered to one; E exports the
 * table as the person sees it; the non-moving list carries the agent's suggestion; a GSTR-2B file is
 * read and set against the books, bucket by bucket; the activity view shows an edit before and after.
 */
type Call = { method: string; path: string; body: unknown };

/** `authDelayMs` answers `/auth/me` late, as a real network does: a screen mounts before it knows its grants. */
function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[], authDelayMs = 0): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path: raw.includes("?") ? `${path}?${raw.split("?")[1]!}` : path, body });
    if (path === "/auth/me") {
      if (authDelayMs > 0) await new Promise((r) => setTimeout(r, authDelayMs));
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const OWNER = ["pharmacy.reports.read", "pharmacy.reports.margin"];
const ACCOUNTS = ["pharmacy.reports.read"];
const STORES = { stores: [{ code: "PHARM-OPD", name: "OPD pharmacy" }, { code: "PHARM-RETAIL", name: "Walk-in retail pharmacy" }] };

const sale = (over: Partial<WireSalesRow> = {}): WireSalesRow => ({
  kind: "sale", id: "inv-1", docNo: "INV/26-27/000001", invoiceId: "inv-1", invoiceNo: "INV/26-27/000001", date: "2026-09-25", at: "2026-09-25T05:00:00.000Z",
  source: "dispense", ref: "P2609250001", storeCode: "PHARM-OPD", patientId: "p-1", patientName: "Ramesh Patil", uhid: "UH0001", prescriber: "Dr Sen",
  operatorName: "ph.mehta", tender: "cash", grossPaise: 4_500, discountPaise: 0, taxablePaise: 4_286, cgstPaise: 107, sgstPaise: 107, roundingPaise: 0,
  netPaise: 4_500, outstandingPaise: 0, costPaise: 1_500, profitPaise: 2_786, marginBps: 6_500,
  lines: [{ itemId: "i-az", itemCode: "AZEE500", itemName: "Azee 500 tablet", batchId: "b-az", batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 3, hsn: "3004", rateBps: 500, discountPaise: 0, taxablePaise: 4_286, cgstPaise: 107, sgstPaise: 107, netPaise: 4_500, costPaise: 1_500, profitPaise: 2_786 }],
  ...over,
});

const register = (margin: boolean): WireSalesRegister => {
  const strip = (r: WireSalesRow): WireSalesRow => (margin ? r : { ...r, costPaise: null, profitPaise: null, marginBps: null, lines: r.lines.map((l) => ({ ...l, costPaise: null, profitPaise: null })) });
  return {
    from: "2026-09-25", to: "2026-09-25", preset: "today", groupBy: "document", storeCode: null, margin,
    rows: [strip(sale()), strip(sale({ kind: "refund", id: "cn-1", docNo: "CN/26-27/000001", tender: null, outstandingPaise: null, netPaise: 1_500, taxablePaise: 1_429, cgstPaise: 36, sgstPaise: 35, costPaise: 500, profitPaise: 929 }))],
    groups: [],
    totals: {
      sales: { count: 1, grossPaise: 4_500, discountPaise: 0, taxablePaise: 4_286, cgstPaise: 107, sgstPaise: 107, roundingPaise: 0, netPaise: 4_500 },
      refunds: { count: 1, grossPaise: 1_500, discountPaise: 0, taxablePaise: 1_429, cgstPaise: 36, sgstPaise: 35, roundingPaise: 0, netPaise: 1_500 },
      net: { taxablePaise: 2_857, cgstPaise: 71, sgstPaise: 72, netPaise: 3_000 },
      costPaise: margin ? 1_000 : null, profitPaise: margin ? 1_857 : null, marginBps: margin ? 6_500 : null,
    },
  };
};

const nonMoving: WireNonMoving = {
  asOf: "2026-09-25", days: 90, since: "2026-06-27", truncated: false,
  rows: [
    { storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", itemId: "i-slow", itemCode: "SLOW", itemName: "Slowcin 10", baseUom: "tablet", batchId: "b-s", batchNo: "SL-1", expiryDate: "2026-11-30", ownership: "owned", recalled: false, qtyBase: 99, landedCostPaise: 250, costValuePaise: 24_750, lastMovedAt: "2026-06-01T06:00:00.000Z", idleDays: 116, vendorId: "v-1", supplierName: "Acme Distributors", supplierKind: "supplier", suggestion: "return", returnableUntil: "2027-02-28" },
    { storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", itemId: "i-old", itemCode: "OLD", itemName: "Oldmycin", baseUom: "tablet", batchId: "b-o", batchNo: "OL-1", expiryDate: "2028-01-31", ownership: "owned", recalled: false, qtyBase: 40, landedCostPaise: 100, costValuePaise: 4_000, lastMovedAt: null, idleDays: null, vendorId: "v-1", supplierName: "Acme Distributors", supplierKind: "supplier", suggestion: "watch", returnableUntil: null },
  ],
  totals: { batches: 2, items: 2, costValuePaise: 28_750, returnValuePaise: 24_750, writeOffValuePaise: 0 },
};

const recon: WireGstr2b = {
  from: "2026-09-01", to: "2026-09-25", preset: "month", period: "092026", gstin: "27AABCH1234H1Z1",
  counts: { matched: 1, mismatch: 1, only_2b: 1, only_books: 0 },
  rows: [
    { bucket: "mismatch", gstin: "27AAACA1234A1Z5", supplier: "ACME Pharma", invoiceNo: "ACME/0043", twoB: { date: "2026-09-25", taxablePaise: 100_000, igstPaise: 0, cgstPaise: 6_000, sgstPaise: 6_000, valuePaise: 112_000 }, books: { billId: "b-2", billNo: "MSB2609250001", date: "2026-09-26", status: "accepted", taxablePaise: 100_000, igstPaise: 0, cgstPaise: 6_000, sgstPaise: 6_000, totalPaise: 112_000 }, diffs: [{ field: "date", twoB: "2026-09-25", books: "2026-09-26" }] },
    { bucket: "only_2b", gstin: "27AAACB9999B1Z5", supplier: "Beta Drugs", invoiceNo: "BD-77", twoB: { date: "2026-09-20", taxablePaise: 50_000, igstPaise: 0, cgstPaise: 3_000, sgstPaise: 3_000, valuePaise: 56_000 }, books: null, diffs: [] },
    { bucket: "matched", gstin: "27AAACA1234A1Z5", supplier: "ACME Pharma", invoiceNo: "acme 0042", twoB: { date: "2026-09-24", taxablePaise: 250_000, igstPaise: 0, cgstPaise: 15_000, sgstPaise: 15_000, valuePaise: 280_000 }, books: { billId: "b-1", billNo: "MSB2609240001", date: "2026-09-24", status: "accepted", taxablePaise: 250_000, igstPaise: 0, cgstPaise: 15_000, sgstPaise: 15_000, totalPaise: 280_000 }, diffs: [] },
  ],
  totals: { twoB: { taxablePaise: 400_000, igstPaise: 0, cgstPaise: 24_000, sgstPaise: 24_000 }, books: { taxablePaise: 350_000, igstPaise: 0, cgstPaise: 21_000, sgstPaise: 21_000 } },
  notes: { count: 1, valuePaise: 5_600, rows: [] },
};

const timeline: WireActivity = {
  kind: "supplier_bill", id: "b-1", no: "MSB2609240001", label: "ACME Pharma · ACME/0042",
  entries: [
    { at: "2026-09-24T05:30:00.000Z", name: "supplier_bill.drafted", actorId: "u-ph", actorName: "pharm.one", status: "draft", changes: [], facts: { billNo: "MSB2609240001", source: "agent" },
      state: { status: "draft", totalPaise: 28_000, vendorBillNo: "ACME/0042" } },
    { at: "2026-09-24T05:40:00.000Z", name: "supplier_bill.updated", actorId: "u-ph", actorName: "pharm.one", status: "draft", facts: { billNo: "MSB2609240001" }, changes: [
      { field: "lines.i-croc.ratePaise", label: "Crocin 500 · Rate", before: 2_500, after: 2_600 },
      { field: "totalPaise", label: "Total", before: 28_000, after: 29_120 },
    ], state: { status: "draft", totalPaise: 29_120, vendorBillNo: "ACME/0042", "lines.i-croc.ratePaise": 2_600 } },
  ],
  labels: { status: "Status", totalPaise: "Total", vendorBillNo: "Vendor bill no.", "lines.i-croc.ratePaise": "Crocin 500 · Rate" },
};

describe("the office's reports (parity P5)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the owner, who buys nothing, lands on the reports; 1 opens the sales register with its totals, lines and profit", async () => {
    const calls = mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": register(true) }, OWNER, 150);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    const list = await screen.findByTestId("reports-view");
    expect(screen.queryByTestId("office-view-buy")).toBeNull();
    // …and never asks for the buying side's day, which its grants would refuse (found by the browser walk).
    expect(calls.some((c) => c.path === "/pharmacy/office/today")).toBe(false);
    // B2 — nor for the Today list, none of whose sides it holds.
    expect(calls.some((c) => c.path === "/pharmacy/office/needs")).toBe(false);
    expect(within(list).getByTestId("report-margin")).toBeTruthy();
    list.focus();
    await userEvent.keyboard("1");
    const table = await screen.findByTestId("sales-table");
    expect(within(table).getByTestId("sales-table-row-inv-1")).toHaveTextContent("INV/26-27/000001");
    expect(within(table).getByTestId("sales-table-row-inv-1")).toHaveTextContent("Ramesh Patil");
    expect(within(table).getByTestId("sales-table-row-inv-1")).toHaveTextContent("Cash");
    expect(within(table).getByTestId("sales-table-row-cn-1")).toHaveTextContent("-15.00");
    expect(within(table).getByTestId("sales-table-totals")).toHaveTextContent("30.00");
    expect(within(table).getByText("Profit")).toBeTruthy();
    expect(within(table).getByTestId("sales-table-totals")).toHaveTextContent("18.57");
    await userEvent.click(within(within(table).getByTestId("sales-table-row-inv-1")).getByRole("button", { name: "Lines" }));
    expect(await screen.findByTestId("sales-lines-inv-1")).toHaveTextContent("AZ-1");
    // T switches the range; W the week.
    await userEvent.click(screen.getByTestId("preset-week"));
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/pharmacy/office/reports/sales?preset=week&groupBy=document"))).toBe(true));
  });

  it("without the margin permission: no Margin report, no profit column", async () => {
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": register(false) }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    const list = await screen.findByTestId("reports-view");
    expect(within(list).queryByTestId("report-margin")).toBeNull();
    await userEvent.click(within(list).getByTestId("report-sales"));
    const table = await screen.findByTestId("sales-table");
    expect(within(table).queryByText("Profit")).toBeNull();
    expect(within(table).queryByText("Margin %")).toBeNull();
  });

  it("C exports the table as seen as CSV, totals row included", async () => {
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": register(true) }, OWNER);
    const made: Blob[] = [];
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return "blob:x"; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-sales"));
    await screen.findByTestId("sales-table");
    await userEvent.keyboard("c");
    await waitFor(() => expect(made).toHaveLength(1));
    URL.createObjectURL = real.create;
    URL.revokeObjectURL = real.revoke;
    click.mockRestore();
    const csv = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(made[0]!); });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toContain("Date,Time,Document,Type,Patient,UHID");
    expect(lines[1]).toContain("INV/26-27/000001");
    expect(lines[2]).toContain("-15.00");
    expect(lines[3]).toMatch(/^Total,.*,30\.00,/);
  });

  it("non-moving: the agent's card and each batch's suggestion; 30 days asks again", async () => {
    const calls = mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/non-moving": nonMoving }, OWNER);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-nonMoving"));
    expect(await screen.findByTestId("non-moving-agent")).toHaveTextContent("2 batches worth 287.50 have not moved. It would send 247.50 back to suppliers");
    const table = screen.getByTestId("non-moving-table");
    expect(within(table).getByTestId("non-moving-table-row-s-opd-b-s")).toHaveTextContent("Return to supplier");
    expect(within(table).getByTestId("non-moving-table-row-s-opd-b-o")).toHaveTextContent("never");
    await userEvent.click(screen.getByTestId("days-30"));
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/reports/non-moving?days=30")).toBe(true));
  });

  it("GSTR-2B: the portal's JSON is trimmed, read and set against the books; a bucket filters the rows", async () => {
    const calls = mock({ "GET /pharmacy/office/reports/stores": STORES, "POST /pharmacy/office/reports/gstr2b": recon }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-gstr2b"));
    const portal = JSON.stringify({ data: { rtnprd: "092026", docdata: { b2b: [{ ctin: "27AAACA1234A1Z5", inv: [{ inum: "ACME/0042", dt: "24-09-2026", txval: 2500, irn: "a".repeat(64), itcavl: "Y" }] }] } } });
    await userEvent.upload(await screen.findByTestId("gstr2b-file"), new File([portal], "GSTR2B_092026.json", { type: "application/json" }));
    const sent = await waitFor(() => { const c = calls.find((x) => x.path === "/pharmacy/office/reports/gstr2b"); expect(c).toBeTruthy(); return c!; });
    expect(sent.body).toMatchObject({ format: "json", preset: "month" });
    expect((sent.body as { content: string }).content).not.toContain("irn");
    expect((sent.body as { content: string }).content).toContain("ACME/0042");
    expect(await screen.findByTestId("bucket-mismatch")).toHaveTextContent("1");
    expect(screen.getByTestId("bucket-only_2b")).toHaveTextContent("In 2B, not in our books");
    const table = screen.getByTestId("gstr2b-table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3 + 1);
    await userEvent.click(screen.getByTestId("bucket-only_2b"));
    expect(within(screen.getByTestId("gstr2b-table")).getAllByRole("row")).toHaveLength(1 + 1 + 1);
    expect(screen.getByTestId("gstr2b-table")).toHaveTextContent("BD-77");
  });

  it("activity: a document number opens its timeline, and an edit shows before and after", async () => {
    const calls = mock({
      "GET /pharmacy/office/reports/stores": STORES,
      "GET /pharmacy/office/reports/activity": { from: "2026-09-22", to: "2026-09-25", rows: [{ at: "2026-09-24T05:40:00.000Z", name: "supplier_bill.updated", actorName: "pharm.one", docNo: "MSB2609240001", amountPaise: 29_120 }] },
      "GET /pharmacy/office/reports/activity/document": timeline,
    }, OWNER);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-activity"));
    expect(await screen.findByTestId("activity-feed")).toHaveTextContent("Supplier bill edited");
    await userEvent.type(screen.getByTestId("activity-no"), "MSB2609240001{Enter}");
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/reports/activity/document?no=MSB2609240001")).toBe(true));
    const changes = await screen.findByTestId("activity-changes-1");
    expect(changes).toHaveTextContent("Crocin 500 · Rate");
    expect(changes).toHaveTextContent("25.00");
    expect(changes).toHaveTextContent("26.00");
    expect(changes).toHaveTextContent("291.20");
  });

  it("GAP A4 — GSTR-3B is report 8 for the owner: the return's rows in order, the cash to pay, and 0 opens the tenth report", async () => {
    const heads = (taxable: number, cgst: number, sgst: number) => ({ taxablePaise: taxable, igstPaise: 0, cgstPaise: cgst, sgstPaise: sgst });
    const setOff = (l: number, own: number, cash: number) => ({ liabilityPaise: l, byIgstPaise: 0, byOwnPaise: own, cashPaise: cash, carryForwardPaise: 0 });
    const g3b = {
      from: "2026-09-01", to: "2026-09-28", preset: "month",
      outward: { taxable: heads(100_000, 2_500, 2_500), nilExempt: { taxablePaise: 500_000 }, byRate: [{ rateBps: 500, taxablePaise: 100_000, cgstPaise: 2_500, sgstPaise: 2_500 }] },
      itc: { available: heads(40_000, 1_000, 1_000), reversed: heads(0, 0, 0), net: { igstPaise: 0, cgstPaise: 1_000, sgstPaise: 1_000 }, bills: 2, debitNotes: 0 },
      creditNotesUnsplitPaise: 0,
      payable: { igst: setOff(0, 0, 0), cgst: setOff(2_500, 1_000, 1_500), sgst: setOff(2_500, 1_000, 1_500), cashPaise: 3_000 },
    };
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/gstr3b": g3b }, [...OWNER, "pharmacy.tally.export"]);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    const list = await screen.findByTestId("reports-view");
    expect(within(within(list).getByTestId("report-gstr3b")).getByText("8")).toBeTruthy();
    list.focus();
    await userEvent.keyboard("8");
    const table = await screen.findByTestId("gstr3b-table");
    const rows = within(table).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows.findIndex((r) => r.includes("3.1(a)"))).toBeLessThan(rows.findIndex((r) => r.includes("4(A)(5)")));
    expect(rows.some((r) => r.includes("2 supplier bills booked"))).toBe(true);
    expect(screen.getByTestId("gstr3b-cash")).toHaveTextContent("30.00");
    await userEvent.keyboard("{Escape}");
    const back = await screen.findByTestId("reports-view");
    expect(within(within(back).getByTestId("report-tally")).getByText("0")).toBeTruthy();
  });
});

// ═══════════════════════════════════ STAGE C — the reports still missing ═══════════════════════════════════

/** The entries of a ZIP of STORED parts, read back from its local headers (with each CRC checked). */
function unzipStored(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    expect(view.getUint16(at + 8, true)).toBe(0); // stored
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    at += 30 + nameLen + size;
  }
  expect(view.getUint32(at, true)).toBe(0x02014b50); // the central directory follows the last entry
  return out;
}

const topSelling: WireTopSelling = {
  from: "2026-09-01", to: "2026-09-28", preset: "month", storeCode: null,
  byValue: [
    { rank: 1, itemId: "i-cr", itemCode: "CROC500", itemName: "Crocin 500 tablet", qtyBase: 250, valuePaise: 70_000, unitShareBps: 8_333, valueShareBps: 7_000, cumulativeValueBps: 7_000, abc: "A" },
    { rank: 2, itemId: "i-az", itemCode: "AZEE500", itemName: "Azee 500 tablet", qtyBase: 50, valuePaise: 30_000, unitShareBps: 1_667, valueShareBps: 3_000, cumulativeValueBps: 10_000, abc: "C" },
  ],
  byUnits: [
    { rank: 1, itemId: "i-cr", itemCode: "CROC500", itemName: "Crocin 500 tablet", qtyBase: 250, valuePaise: 70_000, unitShareBps: 8_333, valueShareBps: 7_000, cumulativeValueBps: 7_000, abc: "A" },
    { rank: 2, itemId: "i-az", itemCode: "AZEE500", itemName: "Azee 500 tablet", qtyBase: 50, valuePaise: 30_000, unitShareBps: 1_667, valueShareBps: 3_000, cumulativeValueBps: 10_000, abc: "C" },
  ],
  totals: { items: 2, qtyBase: 300, valuePaise: 100_000 },
  classes: { A: { items: 1, valuePaise: 70_000 }, B: { items: 0, valuePaise: 0 }, C: { items: 1, valuePaise: 30_000 } },
};

const losses: WireLossRegister = {
  from: "2026-09-01", to: "2026-09-28", truncated: false,
  rows: [
    { source: "write_off", docId: "w-1", docNo: "MWO2609250001", date: "2026-09-25", at: "2026-09-25T08:30:00.000Z", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", itemId: "i-cr", itemCode: "CROC", itemName: "Crocin 500", batchId: "b-1", batchNo: "CR-1", expiryDate: "2028-06-30", qtyBase: 5, valuePaise: 1_250, reason: "damage", requestedBy: "ph.incharge", approvedBy: "the.ms", postedBy: "ph.incharge", disposalAgency: "BioCare CBWTF", manifestNo: "M-77", note: null },
    { source: "count", docId: "a-1", docNo: null, date: "2026-09-26", at: "2026-09-26T05:30:00.000Z", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", itemId: "i-cr", itemCode: "CROC", itemName: "Crocin 500", batchId: "b-1", batchNo: "CR-1", expiryDate: "2028-06-30", qtyBase: 4, valuePaise: 1_000, reason: "shrinkage", requestedBy: "mat.head", approvedBy: "the.ms", postedBy: "mat.head", disposalAgency: null, manifestNo: null, note: "four short" },
  ],
  byReason: [{ reason: "damage", lines: 1, qtyBase: 5, valuePaise: 1_250 }, { reason: "shrinkage", lines: 1, qtyBase: 4, valuePaise: 1_000 }],
  totals: { lines: 2, qtyBase: 9, valuePaise: 2_250 },
};

const daily: WireDailyStock = {
  from: "2026-09-25", to: "2026-09-26", truncated: false,
  rows: [{
    itemId: "i-cr", itemCode: "CROC", itemName: "Crocin 500", baseUom: "tablet", openingQty: 100,
    in: { grn: 0, transferIn: 0, saleReturn: 2, adjustIn: 0 }, inQty: 2, out: { sale: 7, transferOut: 10, supplierReturn: 20, writeOff: 9 }, outQty: 46, closingQty: 56,
  }],
  totals: { items: 1, openingQty: 100, inQty: 2, outQty: 46, closingQty: 56 },
};

const catalogue = (store: string): WireCatalogue => ({
  storeCode: store === "" ? null : store, truncated: false,
  rows: [{
    id: "i-cr", code: "CROC", name: "Crocin 500", class: "consumable", hsnCode: "30049099", gstRateBps: 1200, baseUom: "tablet", storageClass: "cold_2_8",
    manufacturer: "GSK", leadTimeDays: 3, lasa: true, highAlert: false, schedule: "OTC", packs: [{ uom: "strip", toBase: 10 }],
    levels: store === "" ? [{ storeResourceId: "s-1", storeCode: "PHARM-OPD", minBase: 20, reorderBase: 50, maxBase: 200 }, { storeResourceId: "s-2", storeCode: "WARD-3", minBase: 5, reorderBase: 10, maxBase: 40 }]
      : [{ storeResourceId: "s-1", storeCode: "PHARM-OPD", minBase: 20, reorderBase: 50, maxBase: 200 }],
    racks: [{ storeCode: "PHARM-OPD", location: "R-12" }],
  }],
});

describe("the office's reports — stage C", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });
  const ALL = [...OWNER, "pharmacy.tally.export"];

  it("fourteen reports: after 0 the list goes on in letters, and A opens top-selling — by value with its ABC classes, then by units", async () => {
    const calls = mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/top-selling": topSelling }, ALL);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    const list = await screen.findByTestId("reports-view");
    expect(within(list).getAllByRole("button").map((b) => b.querySelector("kbd")?.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "A", "D", "F", "G"]);
    expect(within(within(list).getByTestId("report-catalogue")).getByText("G")).toBeTruthy();
    list.focus();
    await userEvent.keyboard("a");
    const table = await screen.findByTestId("top-table");
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/reports/top-selling?preset=month")).toBe(true));
    expect(within(table).getByTestId("top-table-row-i-cr")).toHaveTextContent("Crocin 500 tablet");
    expect(within(table).getByTestId("top-table-row-i-cr")).toHaveTextContent("700.00");
    expect(within(table).getByTestId("top-table-row-i-cr")).toHaveTextContent("70.0%");
    expect(within(table).getByTestId("top-table-row-i-az")).toHaveTextContent("C");
    expect(within(table).getByTestId("top-table-totals")).toHaveTextContent("1,000.00");
    expect(screen.getByTestId("abc-A")).toHaveTextContent("Class A · 1 item");
    expect(screen.getByTestId("abc-C")).toHaveTextContent("300.00");
    await userEvent.selectOptions(screen.getByTestId("top-by"), "units");
    expect(within(screen.getByTestId("top-table")).getAllByRole("row")[1]).toHaveTextContent("250");
  });

  it("the loss register: each loss with its reason and approver, a count variance named as one, totals by reason", async () => {
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/losses": losses }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-losses"));
    const table = await screen.findByTestId("loss-table");
    const wo = within(table).getByTestId("loss-table-row-write_off-w-1-b-1");
    expect(wo).toHaveTextContent("MWO2609250001");
    expect(wo).toHaveTextContent("Damaged");
    expect(wo).toHaveTextContent("the.ms");
    expect(wo).toHaveTextContent("BioCare CBWTF · M-77");
    expect(within(table).getByTestId("loss-table-row-count-a-1-b-1")).toHaveTextContent("Count variance");
    expect(within(table).getByTestId("loss-table-totals")).toHaveTextContent("22.50");
    expect(screen.getByTestId("loss-reason-shrinkage")).toHaveTextContent("Shrinkage · 1 line · 10.00");
  });

  it("daily stock: opening, each kind of in and out, closing, per item, with a store narrowing it", async () => {
    const calls = mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/daily-stock": daily }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-dailyStock"));
    const table = await screen.findByTestId("daily-stock-table");
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Item", "Code", "Unit", "Opening", "GRN", "Transfer in", "Patient returns", "Found / adjusted in", "Total in", "Sold / dispensed", "Transfer out", "To supplier", "Written off / short", "Total out", "Closing"]);
    const row = within(table).getByTestId("daily-stock-table-row-i-cr");
    expect(Array.from(row.querySelectorAll("td")).map((td) => td.textContent)).toEqual(["Crocin 500", "CROC", "tablet", "100", "0", "0", "2", "0", "2", "7", "10", "20", "9", "46", "56"]);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Store" }), "PHARM-OPD");
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/reports/daily-stock?preset=today&store=PHARM-OPD")).toBe(true));
  });

  it("the item catalogue: the master's facts; all stores shows each store's levels, one store its own min, reorder and max", async () => {
    const calls = mock({
      "GET /pharmacy/office/reports/stores": STORES,
      "GET /pharmacy/office/reports/catalogue": () => catalogue(calls.at(-1)!.path.includes("store=") ? "PHARM-OPD" : ""),
    }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-catalogue"));
    const row = await screen.findByTestId("catalogue-table-row-i-cr");
    for (const text of ["CROC", "30049099", "12%", "OTC", "Cold 2–8 °C", "GSK", "Yes"]) expect(row).toHaveTextContent(text);
    // Packs, levels and racks are one entry to a line, each unbroken — joined with " · " they wrapped
    // mid-entry at 1440 ("PHARM-OPD R-" / "12-B"). The export still carries the joined text.
    expect(Array.from(row.querySelectorAll("td > div.whitespace-nowrap"), (d) => d.textContent))
      .toEqual(["1 tablet", "strip = 10", "PHARM-OPD 20/50/200", "WARD-3 5/10/40", "PHARM-OPD R-12"]);
    await userEvent.selectOptions(screen.getByTestId("catalogue-store"), "PHARM-OPD");
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/reports/catalogue?store=PHARM-OPD")).toBe(true));
    await waitFor(() => expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining(["Min", "Reorder", "Max", "Rack"])));
    expect(screen.getByTestId("catalogue-table-row-i-cr")).not.toHaveTextContent("WARD-3");
    await userEvent.type(screen.getByTestId("catalogue-find"), "zzz");
    expect(screen.queryByTestId("catalogue-table-row-i-cr")).toBeNull();
  });

  it("E exports a real .xlsx: a zip of the workbook's parts, the header bold, text as text and money as rupee numbers", async () => {
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": register(true) }, OWNER);
    const made: Blob[] = [];
    const names: string[] = [];
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return "blob:x"; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-sales"));
    await screen.findByTestId("sales-table");
    await userEvent.keyboard("e");
    await waitFor(() => expect(made).toHaveLength(1));
    URL.createObjectURL = real.create;
    URL.revokeObjectURL = real.revoke;
    click.mockRestore();
    expect(names).toEqual(["sales-register-2026-09-25-2026-09-25.xlsx"]);
    expect(made[0]!.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result as ArrayBuffer); r.readAsArrayBuffer(made[0]!); }));
    const parts = unzipStored(bytes);
    expect([...parts.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = parts.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Date</t></is></c>');
    expect(sheet).toContain("<t xml:space=\"preserve\">INV/26-27/000001</t>");
    // The bill's ₹45.00 is the number 45 in a money cell; the refund's is −15. (Column Q since the 2026-09-30 money
    // rulings put MRP before the discount and Rounding before the total, so a row adds up.)
    expect(sheet).toMatch(/<c r="Q2" s="2"><v>45<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="Q3" s="2"><v>-15<\/v><\/c>/);
    expect(sheet).toContain('<c r="P1" t="inlineStr" s="1"><is><t xml:space="preserve">Rounding</t></is></c>');
    // The totals row is bold, and its money bold money.
    expect(sheet).toMatch(/<row r="4"><c r="A4" t="inlineStr" s="1">.*<c r="Q4" s="3"><v>30<\/v><\/c>/);
    expect(parts.get("xl/workbook.xml")).toContain('name="Sales register"');
  });

  it("activity: an edit's two versions side by side, every field on both, the changed ones marked", async () => {
    mock({
      "GET /pharmacy/office/reports/stores": STORES,
      "GET /pharmacy/office/reports/activity": { from: "2026-09-22", to: "2026-09-25", rows: [] },
      "GET /pharmacy/office/reports/activity/document": timeline,
    }, OWNER);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-activity"));
    await userEvent.type(await screen.findByTestId("activity-no"), "MSB2609240001{Enter}");
    await screen.findByTestId("activity-changes-1");
    // The draft changed nothing, so it offers no comparison.
    expect(screen.queryByTestId("activity-compare-0")).toBeNull();
    await userEvent.click(screen.getByTestId("activity-compare-1"));
    const before = await screen.findByTestId("version-before");
    const after = screen.getByTestId("version-after");
    expect(before).toHaveTextContent("Supplier bill entered");
    expect(after).toHaveTextContent("Supplier bill edited");
    for (const side of ["before", "after"] as const) {
      const rows = within(side === "before" ? before : after).getAllByRole("row").map((r) => r.getAttribute("data-testid"));
      expect(rows).toEqual([`version-${side}-status`, `version-${side}-totalPaise`, `version-${side}-vendorBillNo`, `version-${side}-lines.i-croc.ratePaise`]);
    }
    expect(screen.getByTestId("version-before-totalPaise")).toHaveAttribute("data-changed", "yes");
    expect(screen.getByTestId("version-before-totalPaise")).toHaveTextContent("280.00");
    expect(screen.getByTestId("version-after-totalPaise")).toHaveTextContent("291.20");
    expect(screen.getByTestId("version-before-lines.i-croc.ratePaise")).toHaveTextContent("Crocin 500 · Rate25.00");
    expect(screen.getByTestId("version-after-lines.i-croc.ratePaise")).toHaveTextContent("26.00");
    expect(screen.getByTestId("version-after-vendorBillNo")).toHaveAttribute("data-changed", "no");
    expect(screen.getByTestId("version-after-vendorBillNo")).toHaveTextContent("ACME/0042");
  });
});

/**
 * OWNER RULINGS 2026-09-30 (money) — the register gets MRP and rounding columns, so a row adds up: MRP less the
 * discount is taxable plus both heads, and with the rounding it is the total. The walk before this found
 * 32.00 + 0.80 + 0.80 = 34.00 and nothing to say where the missing 0.40 went.
 */
describe("the sales register adds up (owner rulings 2026-09-30)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("shows MRP, discount, taxable, CGST, SGST, rounding and total for each bill, and totals the rounding", async () => {
    const row = sale({ grossPaise: 3_360, discountPaise: 269, taxablePaise: 2_760, cgstPaise: 166, sgstPaise: 165, roundingPaise: -91, netPaise: 3_000, lines: [] });
    const reg: WireSalesRegister = {
      ...register(false),
      rows: [row],
      totals: {
        sales: { count: 1, grossPaise: 3_360, discountPaise: 269, taxablePaise: 2_760, cgstPaise: 166, sgstPaise: 165, roundingPaise: -91, netPaise: 3_000 },
        refunds: { count: 0, grossPaise: 0, discountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPaise: 0 },
        net: { taxablePaise: 2_760, cgstPaise: 166, sgstPaise: 165, netPaise: 3_000 },
        costPaise: null, profitPaise: null, marginBps: null,
      },
    };
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": reg }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    const list = await screen.findByTestId("reports-view");
    list.focus();
    await userEvent.keyboard("1");
    const table = await screen.findByTestId("sales-table");
    expect(within(table).getByText("MRP")).toBeTruthy();
    expect(within(table).getByText("Rounding")).toBeTruthy();
    const cells = [...within(table).getByTestId("sales-table-row-inv-1").querySelectorAll("td")].map((td) => td.textContent ?? "");
    // 33.60 − 2.69 = 27.60 + 1.66 + 1.65; + (−0.91) = 30.00
    expect(cells.join("|")).toContain("33.60|2.69|27.60|1.66|1.65|-0.91|30.00");
    const totals = [...within(table).getByTestId("sales-table-totals").querySelectorAll("td")].map((td) => td.textContent ?? "").join("|");
    expect(totals).toContain("33.60|2.69|27.60|1.66|1.65|-0.91|30.00");
  });
});
