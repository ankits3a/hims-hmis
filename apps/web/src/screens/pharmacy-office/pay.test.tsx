import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import { PayView } from "./pay";
import type {
  WireBill, WireBillDraft, WireBillSummary, WireLedger, WireOfficePay, WirePayableRow, WirePayables, WireRun,
} from "../../lib/payables-api";

/**
 * PHARMACY PARITY P3 — the office pays: a bill the agent prefilled from a GRN (⏎ saves and matches),
 * the match per line and the head's accept-the-difference, the payment-run grid with its Full ticks,
 * recording a vendor paid (a bank mode needs its UTR), and payables → supplier summary → ledger.
 */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[], me = "u-head"): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: me }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const HEAD = [
  "materials.po.raise", "materials.stock.read", "materials.bills.manage", "materials.bills.accept_difference",
  "materials.payments.prepare", "materials.payments.record",
];

const billSummary = (over: Partial<WireBillSummary> = {}): WireBillSummary => ({
  id: "b-1", billNo: "MSB2609250001", status: "held_for_match", vendorId: "v-1", vendorCode: "ACME", vendorName: "Acme Distributors", msme: false,
  vendorBillNo: "INV/26-27/0042", billDate: "2026-09-25", fy: "2026-27", purchaseOrderId: "po-1", interState: false,
  taxablePaise: 260_000, cgstPaise: 15_600, sgstPaise: 15_600, igstPaise: 0, roundOffPaise: 0, totalPaise: 291_200, expectedTotalPaise: 280_000,
  paidPaise: 0, outstandingPaise: 291_200, heldReason: "1 line(s) outside the match", acceptanceDate: null, dueDate: null, differenceReason: null,
  createdBy: "u-ph", createdAt: "2026-09-25T05:00:00Z", acceptedBy: null, acceptedAt: null, ...over,
});

const bill = (over: Partial<WireBill> = {}): WireBill => ({
  ...billSummary(), note: null, poNo: "MPO2609240001", cancelReason: null, differenceAcceptedBy: null, names: {},
  lines: [{
    id: "bl-1", grnId: "g-1", grnNo: "GRN2609250001", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", uom: "strip", multiplier: 10,
    qtyPacks: 10, ratePaise: 26_000, taxablePaise: 260_000, gstRateBps: 1200, cgstPaise: 15_600, sgstPaise: 15_600, igstPaise: 0, totalPaise: 291_200,
    expectedBase: 100, expectedPacks: 10, expectedRatePaise: 25_000, expectedTaxablePaise: 250_000, expectedGstRateBps: 1200, differencePaise: 10_000,
    mismatch: ["rate", "value"], out: true,
  }],
  unbilled: [], payments: [], ...over,
});

const draft: WireBillDraft = {
  vendorId: "v-1", vendorName: "Acme Distributors", vendorGstin: null, msme: false, grnId: "g-1", grnNo: "GRN2609250001",
  purchaseOrderId: "po-1", poNo: "MPO2609240001", vendorBillNo: "", billDate: "2026-09-25", interState: false,
  lines: [{ grnId: "g-1", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", uom: "strip", multiplier: 10, qtyPacks: 10, ratePaise: 25_000, gstRateBps: 1200, expectedBase: 100 }],
  expectedTotalPaise: 280_000,
};

const payable = (over: Partial<WirePayableRow> = {}): WirePayableRow => ({
  ...billSummary({ id: "b-2", billNo: "MSB2609100001", status: "accepted", vendorId: "v-2", vendorCode: "SMALL", vendorName: "Small Pharma", msme: true, heldReason: null, dueDate: "2026-09-20", totalPaise: 50_000, outstandingPaise: 50_000 }),
  ageDays: 15, bucket: "0_30", overdueDays: 5, reservedPaise: 0, ...over,
});

const officePay = (over: Partial<WireOfficePay> = {}): WireOfficePay => ({
  toMatch: [{ grnId: "g-1", grnNo: "GRN2609250001", vendorId: "v-1", vendorName: "Acme Distributors", postedAt: "2026-09-25T05:00:00Z", invoiceNo: null, poNo: "MPO2609240001" }],
  drafts: [], held: [billSummary()], matched: [], dueThisWeek: [], overdue: [payable()],
  runs: [{ id: "r-1", runNo: "MPR2609250001", status: "pending_authorisation", source: "agent", totalPaise: 50_000, vendorCount: 1, billCount: 1, approvalId: "ap-1", rejectionNote: null, createdBy: "u-head", createdAt: "2026-09-25T06:00:00Z", submittedAt: "2026-09-25T06:01:00Z", authorisedBy: null, authorisedAt: null, completedAt: null }],
  outstandingPaise: 341_200, overduePaise: 50_000, plan: { vendors: 1, bills: 1, totalPaise: 50_000, blocked: 1, until: "2026-10-02", creditPaise: 0, covered: 0 },
  ...over,
});

const run = (over: Partial<WireRun> = {}): WireRun => ({
  id: "r-1", runNo: "MPR2609250001", status: "draft", source: "agent", totalPaise: 80_000, vendorCount: 1, billCount: 2, approvalId: null, rejectionNote: null,
  createdBy: "u-head", createdAt: "2026-09-25T06:00:00Z", submittedAt: null, authorisedBy: null, authorisedAt: null, completedAt: null,
  note: null, cancelReason: null, names: { "u-head": "Mat Head", "u-owner": "The Owner" }, approval: null,
  vendors: [{
    vendorId: "v-2", vendorCode: "SMALL", vendorName: "Small Pharma", msme: true, coolingOffUntil: null, payPaise: 80_000, creditPaise: 0, payment: null,
    lines: [
      { id: "rl-1", billId: "b-2", billNo: "MSB2609100001", vendorBillNo: "S-11", billDate: "2026-09-10", dueDate: "2026-09-20", msme: true, totalPaise: 50_000, prevPaidPaise: 0, creditPaise: 0, payPaise: 50_000, remainingPaise: 0, overdueDays: 5, paid: false },
      { id: "rl-2", billId: "b-3", billNo: "MSB2609120001", vendorBillNo: "S-12", billDate: "2026-09-12", dueDate: "2026-09-27", msme: true, totalPaise: 40_000, prevPaidPaise: 10_000, creditPaise: 0, payPaise: 30_000, remainingPaise: 0, overdueDays: 0, paid: false },
    ],
  }],
  ...over,
});

describe("the office pays (parity P3)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the office switches to Pay; the cards count, and MSME past its limit is called out", async () => {
    mock({ "GET /pharmacy/office/today": { awaitingYou: [], drafts: [], waiting: [], toReceive: [], overdue: [], shortages: [], plan: { orders: 0, lines: 0, unassigned: 0, unmatched: 0, alreadyDrafted: 0 } }, "GET /pharmacy/office/pay": officePay() }, HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("office-view-pay"));
    expect(await screen.findByTestId("pay-count-held")).toHaveTextContent("1");
    expect(screen.getByTestId("pay-count-overdue")).toHaveTextContent("1");
    expect(screen.getByTestId("pay-msme-overdue")).toHaveTextContent("1 MSME bill past the 45-day limit");
    expect(screen.getByTestId("pay-count-awaitingAuth")).toHaveTextContent("1");
    expect(screen.getByTestId("pay-agent")).toHaveTextContent("vendors: 1 · bills: 1");
    expect(screen.getByTestId("pay-agent")).toHaveTextContent("1 vendor left out");
  });

  it("a GRN opens the agent's bill; typing the vendor's number and ⏎ saves and matches; the held line shows why and the head accepts the difference", async () => {
    const calls = mock({
      "GET /pharmacy/office/pay": officePay(),
      "GET /pharmacy/office/bill-draft/g-1": draft,
      "POST /materials/supplier-bills": { bill: bill({ status: "draft", heldReason: null }) },
      "POST /materials/supplier-bills/b-1/match": { bill: bill() },
      "GET /materials/supplier-bills/b-1": { bill: bill() },
      "POST /materials/supplier-bills/b-1/accept-difference": { bill: bill({ status: "accepted", differenceReason: "vendor's revised rate", dueDate: "2026-10-25" }) },
    }, HEAD);
    renderWithRouter(<PayView />);
    within(await screen.findByTestId("pay-section-toMatch")).getByTestId("grn-row-GRN2609250001").focus();
    await userEvent.keyboard("{Enter}");
    const sheet = await screen.findByTestId("bill-new-sheet");
    const no = await within(sheet).findByLabelText("Vendor's bill no.");
    await userEvent.clear(within(sheet).getByLabelText("Rate ₹ CROC500"));
    await userEvent.type(within(sheet).getByLabelText("Rate ₹ CROC500"), "260");
    expect(within(sheet).getByTestId("bill-new-line-CROC500")).toHaveTextContent("+₹100.00");
    await userEvent.type(no, "INV/26-27/0042{Enter}");
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/supplier-bills/b-1/match")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/materials/supplier-bills")!.body).toEqual({
      vendorId: "v-1", vendorBillNo: "INV/26-27/0042", billDate: "2026-09-25", interState: false, roundOffPaise: 0,
      lines: [{ grnId: "g-1", itemId: "i-croc", uom: "strip", qtyPacks: 10, ratePaise: 26_000, gstRateBps: 1200 }],
    });
    const held = await screen.findByTestId("bill-sheet");
    expect(await within(held).findByTestId("bill-held")).toHaveTextContent("1 line(s) outside the match");
    expect(within(held).getByTestId("bill-line-CROC500")).toHaveTextContent("rate differs");
    expect(within(held).getByTestId("bill-line-CROC500")).toHaveTextContent("outside tolerance");
    await userEvent.type(within(held).getByLabelText("Why the difference is accepted"), "vendor's revised rate{Enter}");
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/accept-difference"))?.body).toEqual({ reason: "vendor's revised rate" }));
  });

  it("the run grid: the vendor's Full tick fills and clears every row; Submit saves the lines, then submits", async () => {
    const calls = mock({
      "GET /pharmacy/office/pay": officePay({ runs: [{ ...officePay().runs[0]!, status: "draft" }] }),
      "GET /materials/payment-runs/r-1": { run: run() },
      "PATCH /materials/payment-runs/r-1": (b: unknown) => ({ run: run({ totalPaise: ((b as { lines: { payPaise: number }[] }).lines).reduce((s, l) => s + l.payPaise, 0) }) }),
      "POST /materials/payment-runs/r-1/submit": { run: run({ status: "pending_authorisation" }) },
    }, HEAD);
    renderWithRouter(<PayView />);
    await userEvent.click(within(await screen.findByTestId("pay-section-runs")).getByTestId("run-row-MPR2609250001"));
    const sheet = await screen.findByTestId("run-sheet");
    const grid = await within(sheet).findByTestId("run-vendor-SMALL");
    expect(within(grid).getByTestId("run-line-MSB2609120001")).toHaveTextContent("₹100.00"); // paid before
    const vendorFull = within(grid).getByLabelText("Pay Small Pharma in full");
    expect(vendorFull).toBeChecked();
    await userEvent.click(vendorFull);
    expect(within(grid).getByLabelText("Pay now MSB2609100001")).toHaveValue("0.00");
    await userEvent.click(within(grid).getByLabelText("Full MSB2609100001"));
    expect(within(grid).getByLabelText("Pay now MSB2609100001")).toHaveValue("500.00");
    // A part payment on the second bill.
    await userEvent.clear(within(grid).getByLabelText("Pay now MSB2609120001"));
    await userEvent.type(within(grid).getByLabelText("Pay now MSB2609120001"), "120");
    expect(within(sheet).getByTestId("run-total")).toHaveTextContent("₹620.00");
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit for the owner" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/payment-runs/r-1/submit")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ lines: [{ billId: "b-2", payPaise: 50_000, creditPaise: 0 }, { billId: "b-3", payPaise: 12_000, creditPaise: 0 }] });
    expect(calls.findIndex((c) => c.method === "PATCH")).toBeLessThan(calls.findIndex((c) => c.path.endsWith("/submit")));
  });

  it("an authorised run records a vendor paid: a bank mode waits for its UTR; the authoriser is not offered the form", async () => {
    const authorised = run({ status: "authorised", authorisedBy: "u-owner", authorisedAt: "2026-09-25T07:00:00Z" });
    const calls = mock({
      "GET /pharmacy/office/pay": officePay(),
      "GET /materials/payment-runs/r-1": { run: authorised },
      "POST /materials/payment-runs/r-1/vendors/v-2/pay": { run: { ...authorised, status: "completed" } },
    }, HEAD);
    renderWithRouter(<PayView />);
    await userEvent.click(within(await screen.findByTestId("pay-section-runs")).getByTestId("run-row-MPR2609250001"));
    const rec = await screen.findByTestId("run-record-SMALL");
    const markPaid = within(rec).getByRole("button", { name: /Mark paid/ });
    expect(markPaid).toBeDisabled();
    await userEvent.type(within(rec).getByLabelText("Reference for Small Pharma"), "UTR12345");
    await userEvent.click(markPaid);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/vendors/v-2/pay"))?.body).toEqual({ mode: "neft", reference: "UTR12345", paidOn: null }));
  });

  it("the owner who authorised it sees no form to record it", async () => {
    mock({
      "GET /pharmacy/office/pay": officePay(),
      "GET /materials/payment-runs/r-1": { run: run({ status: "authorised", authorisedBy: "u-owner", authorisedAt: "2026-09-25T07:00:00Z" }) },
    }, HEAD, "u-owner");
    renderWithRouter(<PayView />);
    await userEvent.click(within(await screen.findByTestId("pay-section-runs")).getByTestId("run-row-MPR2609250001"));
    const rec = await screen.findByTestId("run-record-SMALL");
    expect(rec).toHaveTextContent("You authorised this run; somebody else records it paid.");
    expect(within(rec).queryByRole("button")).toBeNull();
  });

  it("P opens payables: ageing buckets, the Supplier Summary, and a supplier's ledger with its closing balance", async () => {
    const payables: WirePayables = {
      asOf: "2026-09-25", bills: [payable()], buckets: { "0_30": 50_000, "31_60": 0, "61_90": 0, "90_plus": 0 },
      suppliers: [{ vendorId: "v-2", vendorCode: "SMALL", vendorName: "Small Pharma", msme: true, phone: null, gstin: "10AAATL6484H1ZP", totalPaise: 90_000, paidPaise: 40_000, remainingPaise: 50_000, overduePaise: 50_000, buckets: { "0_30": 50_000, "31_60": 0, "61_90": 0, "90_plus": 0 }, creditPaise: 0, netPaise: 50_000 }],
      totalOutstandingPaise: 50_000, overduePaise: 50_000,
    };
    const ledger: WireLedger = {
      vendorId: "v-2", vendorCode: "SMALL", vendorName: "Small Pharma", msme: true, from: null, to: null, openingPaise: 0,
      entries: [
        { date: "2026-09-01", kind: "bill", voucherNo: "MSB2609010001", reference: "S-01", creditPaise: 40_000, debitPaise: 0, memoPaise: 0, balancePaise: 40_000, id: "b-0" },
        { date: "2026-09-10", kind: "bill", voucherNo: "MSB2609100001", reference: "S-11", creditPaise: 50_000, debitPaise: 0, memoPaise: 0, balancePaise: 90_000, id: "b-2" },
        { date: "2026-09-15", kind: "payment", voucherNo: "MPV2609150001", reference: "NEFT UTR1", creditPaise: 0, debitPaise: 40_000, memoPaise: 0, balancePaise: 50_000, id: "p-1" },
      ],
      closingPaise: 50_000, billedPaise: 90_000, paidPaise: 40_000, creditedPaise: 0,
    };
    mock({ "GET /pharmacy/office/pay": officePay(), "GET /materials/payables": payables, "GET /materials/payables/ledger/v-2": ledger }, HEAD);
    renderWithRouter(<PayView />);
    const view = await screen.findByTestId("pay-view");
    await screen.findByTestId("pay-counts");
    view.focus();
    await userEvent.keyboard("p");
    const sheet = await screen.findByTestId("payables-sheet");
    expect(await within(sheet).findByTestId("ageing-buckets")).toHaveTextContent("₹500.00");
    expect(within(sheet).getByTestId("ageing-MSB2609100001")).toHaveTextContent("5 days overdue");
    await userEvent.click(within(sheet).getByRole("button", { name: "Supplier summary" }));
    const row = within(sheet).getByTestId("supplier-SMALL");
    expect(row).toHaveTextContent("₹900.00");
    expect(row).toHaveTextContent("₹400.00");
    await userEvent.click(within(row).getByRole("button", { name: "Ledger" }));
    const l = await screen.findByTestId("ledger-sheet");
    expect(await within(l).findByTestId("ledger-closing")).toHaveTextContent("₹500.00");
    expect(within(l).getByTestId("ledger-MPV2609150001")).toHaveTextContent("NEFT UTR1");
  });

  /**
   * PARITY P4 — the vendor's accepted credit on the grid: the agent's draft set ₹112 against the first
   * bill, so it pays ₹388 and the Credit column says ₹112; a bill the credit covers whole pays ₹0 and
   * stays on the run; saving the draft carries every line's credit back.
   */
  it("the credit column: the agent's credit is shown per bill and per vendor, and saving keeps it", async () => {
    const credited = run({
      totalPaise: 38_800 + 30_000,
      vendors: [{
        ...run().vendors[0]!, payPaise: 38_800 + 30_000, creditPaise: 11_200 + 0,
        lines: [
          { ...run().vendors[0]!.lines[0]!, creditPaise: 11_200, payPaise: 38_800, remainingPaise: 0 },
          { ...run().vendors[0]!.lines[1]!, creditPaise: 0, payPaise: 30_000, remainingPaise: 0 },
        ],
      }],
    });
    const calls = mock({
      "GET /pharmacy/office/pay": officePay({ runs: [{ ...officePay().runs[0]!, status: "draft" }], plan: { vendors: 1, bills: 2, totalPaise: 68_800, blocked: 0, until: "2026-10-02", creditPaise: 11_200, covered: 0 } }),
      "GET /materials/payment-runs/r-1": { run: credited },
      "PATCH /materials/payment-runs/r-1": { run: credited },
    }, HEAD);
    renderWithRouter(<PayView />);
    expect(await screen.findByTestId("pay-agent-credit")).toHaveTextContent("₹112.00");
    await userEvent.click(within(await screen.findByTestId("pay-section-runs")).getByTestId("run-row-MPR2609250001"));
    const sheet = await screen.findByTestId("run-sheet");
    const grid = await within(sheet).findByTestId("run-vendor-SMALL");
    expect(within(grid).getByTestId("run-credit-MSB2609100001")).toHaveTextContent("₹112.00");
    expect(within(grid).getByTestId("run-vendor-credit-SMALL")).toHaveTextContent("₹112.00");
    // Full is what is left after the credit: ₹500 − ₹112.
    expect(within(grid).getByLabelText("Full MSB2609100001")).toBeChecked();
    expect(within(grid).getByLabelText("Pay now MSB2609100001")).toHaveValue("388.00");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      lines: [{ billId: "b-2", payPaise: 38_800, creditPaise: 11_200 }, { billId: "b-3", payPaise: 30_000, creditPaise: 0 }],
    });
  });

  it("the supplier summary nets the credit, and the ledger shows our debit note (a claim) and the vendor's credit note", async () => {
    const payables: WirePayables = {
      asOf: "2027-08-01", bills: [payable()], buckets: { "0_30": 50_000, "31_60": 0, "61_90": 0, "90_plus": 0 },
      suppliers: [{ vendorId: "v-2", vendorCode: "SMALL", vendorName: "Small Pharma", msme: true, phone: null, gstin: "10AAATL6484H1ZP", totalPaise: 50_000, paidPaise: 0, remainingPaise: 50_000, overduePaise: 0, buckets: { "0_30": 50_000, "31_60": 0, "61_90": 0, "90_plus": 0 }, creditPaise: 11_200, netPaise: 38_800 }],
      totalOutstandingPaise: 50_000, overduePaise: 0,
    };
    const ledger: WireLedger = {
      vendorId: "v-2", vendorCode: "SMALL", vendorName: "Small Pharma", msme: true, from: null, to: null, openingPaise: 0,
      entries: [
        { date: "2026-09-10", kind: "bill", voucherNo: "MSB2609100001", reference: "S-11", creditPaise: 50_000, debitPaise: 0, memoPaise: 0, balancePaise: 50_000, id: "b-2" },
        { date: "2027-08-01", kind: "debit_note", voucherNo: "MDN2708010001", reference: "MRT2708010001", creditPaise: 0, debitPaise: 0, memoPaise: 11_200, balancePaise: 50_000, id: "r-1" },
        { date: "2027-08-03", kind: "credit_note", voucherNo: "MCN2708030001", reference: "CN/27/118 · MDN2708010001", creditPaise: 0, debitPaise: 11_200, memoPaise: 0, balancePaise: 38_800, id: "c-1" },
      ],
      closingPaise: 38_800, billedPaise: 50_000, paidPaise: 0, creditedPaise: 11_200,
    };
    mock({ "GET /pharmacy/office/pay": officePay(), "GET /materials/payables": payables, "GET /materials/payables/ledger/v-2": ledger }, HEAD);
    renderWithRouter(<PayView />);
    const view = await screen.findByTestId("pay-view");
    await screen.findByTestId("pay-counts");
    view.focus();
    await userEvent.keyboard("p");
    const sheet = await screen.findByTestId("payables-sheet");
    await userEvent.click(await within(sheet).findByRole("button", { name: "Supplier summary" }));
    expect(within(sheet).getByTestId("supplier-net-SMALL")).toHaveTextContent("₹388.00");
    await userEvent.click(within(within(sheet).getByTestId("supplier-SMALL")).getByRole("button", { name: "Ledger" }));
    const l = await screen.findByTestId("ledger-sheet");
    expect(await within(l).findByTestId("ledger-MDN2708010001")).toHaveTextContent("Debit note");
    expect(within(l).getByTestId("ledger-MDN2708010001")).toHaveTextContent("claim ₹112.00");
    expect(within(l).getByTestId("ledger-MCN2708030001")).toHaveTextContent("Credit note");
    expect(within(l).getByTestId("ledger-closing")).toHaveTextContent("₹388.00");
  });
});
