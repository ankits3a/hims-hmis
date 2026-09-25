import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import { ReturnsView } from "./returns";
import type {
  WireExpiryReport, WireExpiryRow, WireOfficeReturns, WireRecall, WireReturn, WireReturnPlan, WireWriteOff,
} from "../../lib/returns-api";

/**
 * PHARMACY PARITY P4 — the office returns: the expiry report (presets, Item-wise | Supplier-wise,
 * OPENING STOCK shown as such, the return window and the "return raised" flag), the agent's drafts
 * (one per vendor ticked), a return approved by the head and not by its drafter, the vendor's short
 * credit with its reason, the destruction write-off from the "cannot go back" list with its manifest,
 * and a recall: raised by batch, its callback list read-only, one tap into a return.
 */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[], me = "u-head"): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path: raw.includes("?") && method === "GET" ? `${path}?${raw.split("?")[1]!}` : path, body });
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
  "materials.po.raise", "materials.stock.read", "materials.bills.manage", "materials.bills.accept_difference", "materials.returns.manage",
  "materials.returns.approve", "materials.writeoffs.manage", "materials.recall.manage", "materials.items.read",
];
const PHARMACIST = ["materials.po.raise", "materials.stock.read", "materials.bills.manage", "materials.returns.manage"];

const office = (over: Partial<WireOfficeReturns> = {}): WireOfficeReturns => ({
  expiring: { expired: 2, d30: 1, d60: 1, d90: 3, expiredValuePaise: 12_500, d30ValuePaise: 25_000, d60ValuePaise: 25_000, d90ValuePaise: 40_000 },
  plan: { vendors: 2, lines: 3, taxablePaise: 35_000, toDestroy: 1, toDestroyValuePaise: 12_500 },
  drafts: [], toDispatch: [], awaitingCredit: [], writeOffsAwaiting: [], writeOffsToPost: [], openRecalls: [], creditPaise: 0,
  ...over,
});

const row = (over: Partial<WireExpiryRow> = {}): WireExpiryRow => ({
  storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet",
  baseUom: "tablet", batchId: "b-1", batchNo: "CR-1", expiryDate: "2026-10-20", daysToExpiry: 25, qtyBase: 104, pack: { uom: "strip", multiplier: 10 },
  packs: 10, loose: 4, mrpPaise: 3_500, mrpUom: "strip", landedCostPaise: 250, costValuePaise: 26_000, vendorId: "v-acme", supplierName: "Acme Distributors",
  supplierKind: "supplier", ownership: "owned", recalled: false, reserved: 0, frozen: 0, returnableUntil: "2027-01-18", returnable: true,
  returnRaised: null, writeOffRaised: null, ...over,
});

const report: WireExpiryReport = {
  asOf: "2026-09-25", preset: "90", from: "2026-09-25", to: "2026-12-24",
  rows: [
    row(),
    row({ batchId: "b-2", batchNo: "OPEN-7", vendorId: "v-open", supplierName: "OPENING STOCK", supplierKind: "opening", returnableUntil: null, returnable: false, costValuePaise: 12_500, qtyBase: 50, packs: 5, loose: 0 }),
    row({ batchId: "b-3", batchNo: "CR-2", returnRaised: { returnId: "ret-1", returnNo: "MRT2609250001", status: "draft" } }),
  ],
  suppliers: [
    { vendorId: "v-acme", supplierName: "Acme Distributors", supplierKind: "supplier", rows: 2, qtyBase: 208, costValuePaise: 52_000, returnableValuePaise: 52_000 },
    { vendorId: "v-open", supplierName: "OPENING STOCK", supplierKind: "opening", rows: 1, qtyBase: 50, costValuePaise: 12_500, returnableValuePaise: 0 },
  ],
  costValuePaise: 64_500, truncated: false,
};

const plan: WireReturnPlan = {
  asOf: "2026-09-25", alreadyHeld: 0, taxablePaise: 35_000,
  groups: [
    { vendorId: "v-acme", vendorCode: "ACME", vendorName: "Acme Distributors", gstin: "10AAACA1234A1Z5", taxablePaise: 26_000, lines: [
      { itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", hsnCode: "30049099", batchId: "b-1", batchNo: "CR-1", expiryDate: "2026-10-20", storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", reason: "near_expiry", qtyBase: 104, baseUom: "tablet", pack: { uom: "strip", multiplier: 10 }, ratePaise: 250, gstRateBps: 1200, taxablePaise: 26_000, returnableUntil: "2027-01-18" },
    ] },
    { vendorId: "v-del", vendorCode: "DELHI", vendorName: "Delhi Pharma", gstin: "07AAACD1234A1Z5", taxablePaise: 9_000, lines: [
      { itemId: "i-pan", itemCode: "PAN40", itemName: "Pan 40", hsnCode: null, batchId: "b-9", batchNo: "PN-9", expiryDate: "2026-08-01", storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", reason: "expired", qtyBase: 60, baseUom: "tablet", pack: null, ratePaise: 150, gstRateBps: 1200, taxablePaise: 9_000, returnableUntil: "2026-10-30" },
    ] },
  ],
  toDestroy: [
    { itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", batchId: "b-2", batchNo: "OPEN-7", expiryDate: "2026-06-30", storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", qtyBase: 50, baseUom: "tablet", valuePaise: 12_500, supplierName: "OPENING STOCK", why: "no_supplier" },
  ],
};

const ret = (over: Partial<WireReturn> = {}): WireReturn => ({
  id: "ret-1", returnNo: "MRT2609250001", status: "draft", source: "agent", vendorId: "v-acme", vendorCode: "ACME", vendorName: "Acme Distributors",
  recallId: null, lineCount: 1, interState: false, taxablePaise: 26_000, cgstPaise: 1_560, sgstPaise: 1_560, igstPaise: 0, totalPaise: 29_120, creditedPaise: 0,
  debitNoteNo: null, debitNoteDate: null, createdBy: "u-ph", createdAt: "2026-09-25T05:00:00Z", approvedBy: null, approvedAt: null, dispatchedBy: null, dispatchedAt: null,
  note: null, vendorGstin: "10AAACA1234A1Z5", closeReason: null, cancelReason: null, recallNo: null, names: { "u-ph": "Pharm One", "u-head": "Mat Head" },
  lines: [{
    id: "rl-1", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", hsnCode: "30049099", baseUom: "tablet", pack: { uom: "strip", multiplier: 10 },
    batchId: "b-1", batchNo: "CR-1", expiryDate: "2026-10-20", storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy",
    reason: "near_expiry", qtyBase: 104, ratePaise: 250, taxablePaise: 26_000, gstRateBps: 1200, cgstPaise: 1_560, sgstPaise: 1_560, igstPaise: 0, totalPaise: 29_120, ledgerEntryId: null,
  }],
  credit: null, ...over,
});

describe("the office returns (parity P4)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the office switches to Returns: the expiring cards with their value, and the agent's card", async () => {
    mock({
      "GET /pharmacy/office/today": { awaitingYou: [], drafts: [], waiting: [], toReceive: [], overdue: [], shortages: [], plan: { orders: 0, lines: 0, unassigned: 0, unmatched: 0, alreadyDrafted: 0 } },
      "GET /pharmacy/office/returns": office({ creditPaise: 11_200 }),
    }, HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("office-view-returns"));
    expect(await screen.findByTestId("returns-count-expired")).toHaveTextContent("2");
    expect(screen.getByTestId("returns-count-expired")).toHaveTextContent("₹125.00");
    expect(screen.getByTestId("returns-count-d30")).toHaveTextContent("1");
    expect(screen.getByTestId("returns-agent")).toHaveTextContent("vendors: 2 · batches: 3");
    expect(screen.getByTestId("returns-agent")).toHaveTextContent("1 batch can only be destroyed");
    expect(screen.getByTestId("returns-credit")).toHaveTextContent("₹112.00");
  });

  it("E opens the expiry report: presets, OPENING STOCK as such, the return window, the raised return; Supplier-wise groups them", async () => {
    const calls = mock({ "GET /pharmacy/office/returns": office(), "GET /materials/expiry-report": report }, HEAD);
    renderWithRouter(<ReturnsView />);
    const view = await screen.findByTestId("returns-view");
    await screen.findByTestId("returns-counts");
    view.focus();
    await userEvent.keyboard("e");
    const sheet = await screen.findByTestId("expiry-sheet");
    const items = await within(sheet).findByTestId("expiry-items");
    expect(within(items).getByTestId("expiry-row-CR-1")).toHaveTextContent("10 strip + 4 tablet");
    expect(within(items).getByTestId("expiry-row-CR-1")).toHaveTextContent("2027-01-18");
    expect(within(items).getByTestId("expiry-row-OPEN-7")).toHaveTextContent("OPENING STOCK");
    expect(within(items).getByTestId("expiry-row-OPEN-7")).toHaveTextContent("destroy only");
    expect(within(items).getByTestId("expiry-row-CR-2")).toHaveTextContent("MRT2609250001 (Draft)");
    await userEvent.click(within(sheet).getByTestId("expiry-preset-30"));
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/expiry-report?preset=30")).toBe(true));
    await userEvent.click(within(sheet).getByTestId("expiry-tab-suppliers"));
    const bySupplier = await within(sheet).findByTestId("expiry-suppliers");
    expect(within(bySupplier).getByTestId("expiry-supplier-Acme Distributors")).toHaveTextContent("can go back: ₹520.00");
    expect(within(bySupplier).getByTestId("expiry-supplier-opening")).toHaveTextContent("OPENING STOCK");
  });

  it("D reviews the agent's plan; an unticked vendor is left out of the drafts", async () => {
    const calls = mock({
      "GET /pharmacy/office/returns": office(),
      "GET /materials/supplier-returns/plan": plan,
      "POST /pharmacy/office/returns/draft": { drafts: [ret()] },
      "GET /materials/supplier-returns/ret-1": { return: ret() },
    }, HEAD);
    renderWithRouter(<ReturnsView />);
    const view = await screen.findByTestId("returns-view");
    await screen.findByTestId("returns-agent");
    view.focus();
    await userEvent.keyboard("d");
    const sheet = await screen.findByTestId("return-plan-sheet");
    expect(await within(sheet).findByTestId("return-plan-ACME")).toHaveTextContent("10 strip + 4 tablet");
    expect(within(sheet).getByTestId("return-plan-destroy")).toHaveTextContent("no supplier to return to");
    await userEvent.click(within(sheet).getByLabelText("Draft a return to Delhi Pharma"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Make 1 draft" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/pharmacy/office/returns/draft")?.body).toEqual({ vendorIds: ["v-acme"] }));
    expect(await screen.findByTestId("return-sheet")).toBeTruthy();
  });

  it("the head approves a return the pharmacist drafted (A); its drafter is not offered the approval", async () => {
    // The server's state: the sheet refetches after the act, so the GET answers what the POST made.
    let current = ret();
    const calls = mock({
      "GET /pharmacy/office/returns": office({ drafts: [ret()] }),
      "GET /materials/supplier-returns/ret-1": () => ({ return: current }),
      "POST /materials/supplier-returns/ret-1/approve": () => { current = ret({ status: "approved", approvedBy: "u-head", approvedAt: "2026-09-25T06:00:00Z" }); return { return: current }; },
    }, HEAD);
    renderWithRouter(<ReturnsView />);
    await userEvent.click(within(await screen.findByTestId("returns-section-drafts")).getByTestId("return-row-MRT2609250001"));
    const sheet = await screen.findByTestId("return-sheet");
    expect(await within(sheet).findByTestId("return-totals")).toHaveTextContent("₹291.20");
    await userEvent.keyboard("a");
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/supplier-returns/ret-1/approve")).toBe(true));
    // The approver is not offered the dispatch.
    expect(await within(sheet).findByText("You approved this return; somebody else dispatches it.")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /Dispatch/ })).toBeNull();
  });

  it("the drafter sees no approval button", async () => {
    mock({ "GET /pharmacy/office/returns": office({ drafts: [ret()] }), "GET /materials/supplier-returns/ret-1": { return: ret() } }, HEAD, "u-ph");
    renderWithRouter(<ReturnsView />);
    await userEvent.click(within(await screen.findByTestId("returns-section-drafts")).getByTestId("return-row-MRT2609250001"));
    const sheet = await screen.findByTestId("return-sheet");
    expect(await within(sheet).findByText("You drafted this return; the head approves it.")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("a dispatched return shows its debit note; a short credit waits for its reason, then records", async () => {
    const sent = ret({ status: "dispatched", approvedBy: "u-head", dispatchedBy: "u-ph", debitNoteNo: "MDN2609250001", debitNoteDate: "2026-09-25", dispatchedAt: "2026-09-25T07:00:00Z" });
    const calls = mock({
      "GET /pharmacy/office/returns": office({ awaitingCredit: [sent] }),
      "GET /materials/supplier-returns/ret-1": { return: sent },
      "POST /materials/supplier-returns/ret-1/credit-note": { return: { ...sent, status: "credited", creditedPaise: 26_000 } },
    }, HEAD);
    renderWithRouter(<ReturnsView />);
    await userEvent.click(within(await screen.findByTestId("returns-section-awaitingCredit")).getByTestId("return-row-MRT2609250001"));
    const sheet = await screen.findByTestId("return-sheet");
    expect(await within(sheet).findByTestId("return-debit-note")).toHaveTextContent("MDN2609250001");
    const form = within(sheet).getByTestId("return-credit-form");
    await userEvent.type(within(form).getByLabelText("Vendor's credit note no."), "CN/26/118");
    await userEvent.clear(within(form).getByLabelText("Amount ₹"));
    await userEvent.type(within(form).getByLabelText("Amount ₹"), "260");
    const save = within(form).getByRole("button", { name: "Record the credit note" });
    expect(save).toBeDisabled(); // short by ₹31.20: the reason first
    await userEvent.type(within(form).getByLabelText("Why the credit is short"), "GST not reversed by vendor");
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/credit-note"))?.body).toMatchObject({
      vendorCreditNoteNo: "CN/26/118", amountPaise: 26_000, differenceReason: "GST not reversed by vendor",
    }));
  });

  it("W raises a destruction write-off from what cannot go back; once granted it is handed over with its manifest", async () => {
    const raised: WireWriteOff = {
      id: "w-1", writeOffNo: "MWO2609250001", status: "requested", reason: "expiry", storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy",
      totalValuePaise: 12_500, lineCount: 1, approvalId: "ap-9", approvalStatus: "granted", disposalAgency: null, manifestNo: null, disposalDate: null,
      requestedBy: "u-head", requestedAt: "2026-09-25T05:00:00Z", postedBy: null, postedAt: null, note: null, names: { "u-head": "Mat Head" },
      lines: [{ id: "wl-1", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", hsnCode: null, baseUom: "tablet", batchId: "b-2", batchNo: "OPEN-7", expiryDate: "2026-06-30", supplierName: "OPENING STOCK", qtyBase: 50, valuePaise: 12_500, ledgerEntryId: null }],
      approval: { status: "granted", approverRole: "medical_superintendent", decidedBy: "u-ms", decisionNote: "condemned" },
    };
    let current: WireWriteOff = raised;
    const calls = mock({
      "GET /pharmacy/office/returns": office(),
      "GET /materials/supplier-returns/plan": plan,
      "POST /materials/write-offs": { writeOff: raised },
      "GET /materials/write-offs/w-1": () => ({ writeOff: current }),
      "POST /materials/write-offs/w-1/post": () => { current = { ...raised, status: "posted", disposalAgency: "BioCare CBWTF", manifestNo: "M-77", disposalDate: "2026-09-25" }; return { writeOff: current }; },
    }, HEAD);
    renderWithRouter(<ReturnsView />);
    const view = await screen.findByTestId("returns-view");
    await screen.findByTestId("returns-counts");
    view.focus();
    await userEvent.keyboard("w");
    const sheet = await screen.findByTestId("new-writeoff-sheet");
    expect(await within(sheet).findByTestId("new-writeoff-lines")).toHaveTextContent("OPEN-7");
    await userEvent.click(within(sheet).getByRole("button", { name: "Send to the medical superintendent" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/materials/write-offs")?.body).toMatchObject({
      storeResourceId: "s-opd", reason: "expiry", lines: [{ batchId: "b-2", qtyBase: 50 }],
    }));
    const w = await screen.findByTestId("writeoff-sheet");
    const handover = await within(w).findByTestId("writeoff-handover");
    await userEvent.type(within(handover).getByLabelText("Disposal agency"), "BioCare CBWTF");
    await userEvent.type(within(handover).getByLabelText("Manifest / challan no."), "M-77");
    await userEvent.click(within(handover).getByRole("button", { name: "Hand over and write off" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/materials/write-offs/w-1/post")?.body).toMatchObject({ disposalAgency: "BioCare CBWTF", manifestNo: "M-77" }));
    expect(await within(w).findByTestId("writeoff-posted")).toHaveTextContent("M-77");
  });

  it("R raises a recall on a batch; its sheet lists who it was dispensed to (read-only) and one tap drafts its return", async () => {
    const recall: WireRecall = {
      id: "rc-1", recallNo: "MRC2609250001", status: "open", source: "cdsco", reference: "CDSCO/NSQ/2026/09", reason: "not of standard quality",
      batchId: "b-1", batchNo: "CR-1", expiryDate: "2026-10-20", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet",
      vendorId: "v-acme", supplierName: "Acme Distributors", supplierKind: "supplier", onHand: 104, raisedBy: "u-head", raisedAt: "2026-09-25T05:00:00Z", closedAt: null,
      closeNote: null, closedBy: null, names: {},
      locations: [{ storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", onHand: 104, reserved: 0, frozen: 104 }],
      dispensed: [{ ledgerEntryId: "l-1", storeResourceId: "s-opd", patientId: "p-1", encounterId: "V2609200001", qtyBase: 10, occurredAt: "2026-09-20T05:00:00Z", refType: "dispense_line", refId: "dl-1" }],
      returns: [], writeOffs: [],
      patients: { "p-1": { uhid: "CRK000123", name: "Ramesh Kumar", phone: "9876543210", restricted: false } },
    };
    const calls = mock({
      "GET /pharmacy/office/returns": office(),
      "GET /materials/items": { items: [{ id: "i-croc", code: "CROC500", name: "Crocin 500 tablet", class: "drug", formularyMedicineId: "m-1", hsnCode: null, gstRateBps: 1200, baseUom: "tablet", batchTracked: true, serialTracked: false, storageClass: "ambient", shelfLifeDays: null, abcClass: null, vedClass: null, active: true }] },
      "GET /materials/recalls/batches": { batches: [{ batchId: "b-1", batchNo: "CR-1", expiryDate: "2026-10-20", onHand: 104, recalled: false, supplierName: "Acme Distributors" }] },
      "POST /materials/recalls": { recall, locations: [{ storeResourceId: "s-opd", qtyFrozen: 104 }] },
      "GET /pharmacy/office/recalls/rc-1": recall,
      "POST /pharmacy/office/recalls/rc-1/return": { return: ret({ source: "recall", recallId: "rc-1", recallNo: "MRC2609250001" }) },
      "GET /materials/supplier-returns/ret-1": { return: ret({ source: "recall", recallId: "rc-1", recallNo: "MRC2609250001" }) },
    }, HEAD);
    renderWithRouter(<ReturnsView />);
    const view = await screen.findByTestId("returns-view");
    await screen.findByTestId("returns-counts");
    view.focus();
    await userEvent.keyboard("r");
    const sheet = await screen.findByTestId("new-recall-sheet");
    await userEvent.type(within(sheet).getByLabelText("Find the item (2+ letters)"), "croc");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Crocin 500 tablet/ }));
    await waitFor(() => expect(within(sheet).getByLabelText("Batch")).toBeTruthy());
    await userEvent.selectOptions(await within(sheet).findByLabelText("Batch"), "b-1");
    await userEvent.type(within(sheet).getByLabelText("Alert reference"), "CDSCO/NSQ/2026/09");
    await userEvent.type(within(sheet).getByLabelText("Why it is recalled"), "not of standard quality");
    await userEvent.click(within(sheet).getByRole("button", { name: "Freeze the batch everywhere" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/materials/recalls")?.body).toEqual({
      batchId: "b-1", source: "cdsco", reference: "CDSCO/NSQ/2026/09", reason: "not of standard quality",
    }));
    const rs = await screen.findByTestId("recall-sheet");
    const dispensed = await within(rs).findByTestId("recall-dispensed");
    expect(dispensed).toHaveTextContent("Ramesh Kumar");
    expect(dispensed).toHaveTextContent("9876543210");
    expect(within(dispensed).queryByRole("button")).toBeNull(); // read-only
    await userEvent.click(within(rs).getByRole("button", { name: "Return it to the supplier" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/recalls/rc-1/return")).toBe(true));
    expect(await within(await screen.findByTestId("return-sheet")).findByText("Recall MRC2609250001")).toBeTruthy();
  });

  it("a pharmacist without the approval grant sees the plan card but no approve", async () => {
    mock({ "GET /pharmacy/office/returns": office({ drafts: [ret({ createdBy: "u-other" })] }), "GET /materials/supplier-returns/ret-1": { return: ret({ createdBy: "u-other" }) } }, PHARMACIST, "u-ph");
    renderWithRouter(<ReturnsView />);
    expect(await screen.findByTestId("returns-agent")).toBeTruthy();
    await userEvent.click(within(screen.getByTestId("returns-section-drafts")).getByTestId("return-row-MRT2609250001"));
    const sheet = await screen.findByTestId("return-sheet");
    expect(await within(sheet).findByText("Waiting for the materials head to approve it.")).toBeTruthy();
  });
});
