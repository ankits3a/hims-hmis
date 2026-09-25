import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice, PharmacyOfficeReports } from "./pharmacy-office";
import type { WireActivity, WireGstr2b, WireNonMoving, WireSalesRegister, WireSalesRow } from "../../lib/reports-api";

/**
 * PHARMACY PARITY P5 — the office's Reports: the owner (who buys nothing) lands on them; a number
 * opens a report; the sales register shows each bill with its totals row and opens to its batch
 * lines; profit only for the margin reader, and the Margin report only offered to one; E exports the
 * table as the person sees it; the non-moving list carries the agent's suggestion; a GSTR-2B file is
 * read and set against the books, bucket by bucket; the activity view shows an edit before and after.
 */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path: raw.includes("?") ? `${path}?${raw.split("?")[1]!}` : path, body });
    if (path === "/auth/me") {
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
    { at: "2026-09-24T05:30:00.000Z", name: "supplier_bill.drafted", actorId: "u-ph", actorName: "pharm.one", status: "draft", changes: [], facts: { billNo: "MSB2609240001", source: "agent" } },
    { at: "2026-09-24T05:40:00.000Z", name: "supplier_bill.updated", actorId: "u-ph", actorName: "pharm.one", status: "draft", facts: { billNo: "MSB2609240001" }, changes: [
      { field: "lines.i-croc.ratePaise", label: "Crocin 500 · Rate", before: 2_500, after: 2_600 },
      { field: "totalPaise", label: "Total", before: 28_000, after: 29_120 },
    ] },
  ],
};

describe("the office's reports (parity P5)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the owner, who buys nothing, lands on the reports; 1 opens the sales register with its totals, lines and profit", async () => {
    const calls = mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": register(true) }, OWNER);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    const list = await screen.findByTestId("reports-view");
    expect(screen.queryByTestId("office-view-buy")).toBeNull();
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

  it("E exports the table as seen, totals row included", async () => {
    mock({ "GET /pharmacy/office/reports/stores": STORES, "GET /pharmacy/office/reports/sales": register(true) }, OWNER);
    const made: Blob[] = [];
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return "blob:x"; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-sales"));
    await screen.findByTestId("sales-table");
    await userEvent.keyboard("e");
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
});
