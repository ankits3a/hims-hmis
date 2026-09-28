import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import type { WireOfficeNeeds } from "../../lib/office-needs-api";
import type { WireOfficeToday, WirePo, WirePoSummary, WirePurchasePlan } from "../../lib/purchase-api";

/**
 * PHARMACY PARITY P2 — the back office: what needs this person today, the order sheet with its keys
 * (⏎ opens, A approves, R rejects with a reason, Esc closes), and the agent's plan made into drafts
 * by a person's press.
 */
type Call = { method: string; path: string; body: unknown };

const EMPTY_NEEDS: WireOfficeNeeds = { rows: [], sides: ["BUY"], money: null, copilot: { po: null, pay: null, returns: null } };

/** B2 — the Buy side is the header menu's second item now; the office opens on Today. */
async function openBuy(): Promise<void> {
  await userEvent.click(await screen.findByTestId("office-view-buy"));
}

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-head" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const key = `${method} ${path}`;
    if (key === "GET /pharmacy/office/needs" && !(key in routes)) {
      return new Response(JSON.stringify(EMPTY_NEEDS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const summary = (over: Partial<WirePoSummary>): WirePoSummary => ({
  id: "po-1", poNo: "MPO2609240001", status: "pending_approval", source: "agent", vendorId: "v-1", vendorCode: "ACME", vendorName: "Acme Distributors",
  storeResourceId: "s-1", storeCode: "PHARM-OPD", expectedDate: "2026-09-27", subtotalPaise: 44_200, gstPaise: 5_304, totalPaise: 49_504, lineCount: 1,
  approvalId: "ap-1", approvalTier: "head", rejectionNote: null, createdBy: "u-ph", createdAt: "2026-09-24T05:00:00Z", submittedAt: "2026-09-24T05:05:00Z",
  approvedBy: null, approvedAt: null, sentAt: null, ...over,
});

const po = (over: Partial<WirePo> = {}): WirePo => ({
  ...summary({}), terms: null, note: "Drafted by the pharmacy agent", storeName: "OPD pharmacy", vendorGstin: null, cancelReason: null, names: {},
  approval: { status: "pending", approverRole: "materials_head", requesterId: "u-ph", decidedBy: null, decisionNote: null },
  lines: [{
    id: "l-1", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", uom: "strip", multiplier: 10,
    qtyPacks: 17, freePacks: 0, ratePaise: 2_600, gstRateBps: 1200, gstPaise: 5_304, mrpPaise: null, lineTotalPaise: 44_200,
    orderedBase: 170, receivedBase: 0, freeReceivedBase: 0, remainingBase: 170,
  }],
  ...over,
});

const today = (over: Partial<WireOfficeToday> = {}): WireOfficeToday => ({
  awaitingYou: [summary({})], drafts: [summary({ id: "po-2", poNo: "MPO2609240002", status: "draft", approvalId: null, approvalTier: null, vendorName: "Beta Pharma" })],
  waiting: [], toReceive: [], overdue: [],
  shortages: [{ id: "sb-1", drugName: "Montair LC", itemId: null, qtyWanted: null, notedAt: "2026-09-24T04:00:00Z", notedByName: "ph" }],
  plan: { orders: 1, lines: 2, unassigned: 1, unmatched: 1, alreadyDrafted: 1 },
  ...over,
});

const RAISE = ["materials.po.raise", "materials.stock.read", "approvals.requests.decide"];

describe("PharmacyOffice (parity P2)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("opens on what needs you, and ⏎ opens an order; A approves it and Esc closes", async () => {
    const calls = mock({
      "GET /pharmacy/office/today": today(),
      "GET /materials/purchase-orders/po-1": { purchaseOrder: po() },
      "POST /materials/purchase-orders/po-1/decision": { purchaseOrder: po({ status: "approved", approvedBy: "u-head" }) },
    }, RAISE);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await openBuy();
    expect(await screen.findByTestId("count-awaitingYou")).toHaveTextContent("1");
    expect(screen.getByTestId("count-shortages")).toHaveTextContent("1");
    expect(screen.getByTestId("office-agent")).toHaveTextContent("orders: 1 · lines: 2 · need a vendor: 1");
    expect(screen.getByTestId("office-agent")).toHaveTextContent("1 short-book drug is not stocked");

    const row = within(screen.getByTestId("section-awaitingYou")).getByTestId("po-row-MPO2609240001");
    row.focus();
    await userEvent.keyboard("{Enter}");
    const sheet = await screen.findByTestId("po-sheet");
    expect(await within(sheet).findByTestId("po-line-CROC500")).toHaveTextContent("strip × 10");
    expect(within(sheet).getByTestId("po-totals")).toHaveTextContent("₹495.04");

    sheet.focus();
    await userEvent.keyboard("a");
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/materials/purchase-orders/po-1/decision")).toBe(true));
    expect(calls.find((c) => c.path === "/materials/purchase-orders/po-1/decision")!.body).toEqual({ verdict: "approve", note: "Approved" });
    await waitFor(() => expect(screen.queryByTestId("po-sheet")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Approved.");

    // Esc closes a sheet without acting.
    within(screen.getByTestId("section-drafts")).getByTestId("po-row-MPO2609240002").focus();
    await userEvent.keyboard("{Enter}");
    const again = await screen.findByTestId("po-sheet");
    again.focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("po-sheet")).toBeNull());
  });

  it("R asks for the reason first, and a reject without one does not go", async () => {
    const calls = mock({
      "GET /pharmacy/office/today": today(),
      "GET /materials/purchase-orders/po-1": { purchaseOrder: po() },
      "POST /materials/purchase-orders/po-1/decision": { purchaseOrder: po({ status: "draft", rejectionNote: "rate above contract" }) },
    }, RAISE);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await openBuy();
    await userEvent.click(within(await screen.findByTestId("section-awaitingYou")).getByTestId("po-row-MPO2609240001"));
    const sheet = await screen.findByTestId("po-sheet");
    await within(sheet).findByTestId("po-line-CROC500");
    sheet.focus();
    await userEvent.keyboard("r");
    const reason = await within(sheet).findByLabelText("Why is it returned?");
    await userEvent.click(within(sheet).getByRole("button", { name: /Reject/ }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Say why the order is returned.");
    expect(calls.some((c) => c.path.endsWith("/decision"))).toBe(false);
    await userEvent.type(reason, "rate above contract{Enter}");
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/decision"))?.body).toEqual({ verdict: "reject", note: "rate above contract" }));
  });

  it("a draft's lines are typed in place and Submit saves them first", async () => {
    const draft = po({ id: "po-2", poNo: "MPO2609240002", status: "draft", approvalId: null, approvalTier: null, approval: null });
    const calls = mock({
      "GET /pharmacy/office/today": today({ awaitingYou: [] }),
      "GET /materials/purchase-orders/po-2": { purchaseOrder: draft },
      "PATCH /materials/purchase-orders/po-2": { purchaseOrder: draft },
      "POST /materials/purchase-orders/po-2/submit": { purchaseOrder: { ...draft, status: "pending_approval" } },
    }, RAISE);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await openBuy();
    await userEvent.click(within(await screen.findByTestId("section-drafts")).getByTestId("po-row-MPO2609240002"));
    const sheet = await screen.findByTestId("po-sheet");
    const qty = await within(sheet).findByLabelText("Qty CROC500");
    await userEvent.clear(qty);
    await userEvent.type(qty, "20");
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/purchase-orders/po-2/submit")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({ lines: [{ itemId: "i-croc", uom: "strip", qtyPacks: 20, ratePaise: 2_600, gstRateBps: 1200 }] });
    expect(calls.findIndex((c) => c.method === "PATCH")).toBeLessThan(calls.findIndex((c) => c.path.endsWith("/submit")));
  });

  it("the agent's plan is reviewed and a person makes the drafts, giving an unassigned item a vendor", async () => {
    const plan: WirePurchasePlan = {
      storeResourceId: "s-1", storeCode: "PHARM-OPD", expectedDate: "2026-09-27",
      groups: [{ vendorId: "v-2", vendorCode: "BETA", vendorName: "Beta Pharma", subtotalPaise: 44_200, gstPaise: 5_304, totalPaise: 49_504, lines: [
        { itemId: "i-croc", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", uom: "strip", multiplier: 10, needBase: 170, qtyPacks: 17, ratePaise: 2_600, gstRateBps: 1200, mrpPaise: null, lineTotalPaise: 44_200, reasons: ["reorder"], shortBookIds: [], lastGrnNo: "GRN1" },
      ] }],
      unassigned: [{ itemId: "i-azee", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", uom: "strip", multiplier: 10, needBase: 25, qtyPacks: 3, ratePaise: 0, gstRateBps: 500, mrpPaise: null, lineTotalPaise: 0, reasons: ["short_book"], shortBookIds: ["sb-2"], lastGrnNo: null, why: "no_history" }],
      unmatched: [{ shortBookId: "sb-1", drugName: "Montair LC" }], alreadyDrafted: [],
    };
    const calls = mock({
      "GET /pharmacy/office/today": today({ awaitingYou: [], drafts: [] }),
      "GET /pharmacy/office/plan": plan,
      "GET /materials/purchase-vendors": { vendors: [{ id: "v-1", code: "ACME", name: "Acme Distributors" }, { id: "v-2", code: "BETA", name: "Beta Pharma" }] },
      "POST /pharmacy/office/draft-orders": { drafts: [po({ id: "po-9", status: "draft" }), po({ id: "po-10", status: "draft" })] },
      "GET /materials/purchase-orders/po-9": { purchaseOrder: po({ id: "po-9", status: "draft" }) },
    }, RAISE);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await openBuy();
    await userEvent.click(await screen.findByRole("button", { name: "Review and make drafts" }));
    const sheet = await screen.findByTestId("plan-sheet");
    expect(await within(sheet).findByTestId("plan-BETA")).toHaveTextContent("17 strip");
    expect(within(sheet).getByText(/Not stocked, so not ordered: Montair LC/)).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).getByLabelText("Vendor for AZEE500")).toHaveTextContent("Acme Distributors"));
    await userEvent.selectOptions(within(sheet).getByLabelText("Vendor for AZEE500"), "v-1");
    await userEvent.type(within(sheet).getByLabelText("Rate per pack for AZEE500"), "300");
    await userEvent.click(within(sheet).getByRole("button", { name: "Make the drafts" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/pharmacy/office/draft-orders")?.body).toEqual({ assign: [{ itemId: "i-azee", vendorId: "v-1", ratePaise: 30_000 }] }));
    expect(await screen.findByRole("status")).toHaveTextContent("2 drafts made");
    // The first draft opens for review.
    expect(await screen.findByTestId("po-sheet")).toBeInTheDocument();
  });

  it("an order waiting on somebody else says who, and offers no decision", async () => {
    mock({
      "GET /pharmacy/office/today": today({ awaitingYou: [], waiting: [summary({ approvalTier: "owner" })] }),
      "GET /materials/purchase-orders/po-1": { purchaseOrder: po({ approvalTier: "owner" }) },
    }, ["materials.po.raise", "materials.stock.read"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await openBuy();
    await userEvent.click(within(await screen.findByTestId("section-waiting")).getByTestId("po-row-MPO2609240001"));
    const sheet = await screen.findByTestId("po-sheet");
    expect(await within(sheet).findByText("Waiting on the owner.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});

/**
 * GAP-CLOSURE B2 — the office board's Main artboard: the office opens on TODAY, one ranked list from
 * `/pharmacy/office/needs`; the seven tabs became the header menu; a row goes into the left lane with
 * its facts and why; A does its act in the EXISTING sheet for that document; Esc clears the lane.
 */
const NEEDS: WireOfficeNeeds = {
  sides: ["BUY", "PAY", "LAW", "PEOPLE"],
  money: { dueThisWeekPaise: 15_100_000, overduePaise: 0, msmeDueThisWeek: 2 },
  copilot: { po: { orders: 2, lines: 13, unassigned: 0, unmatched: 0, alreadyDrafted: 0 }, pay: null, returns: null },
  rows: [
    { id: "law:retail", source: "LAW", kind: "retail_licence_lapsing", tier: 1, params: { form20: "F20-RJ-2231", until: "2026-10-04", days: 6 },
      clock: { code: "days_left", n: 6, tone: "rd" }, ref: { kind: "retailLicence", id: "lic" },
      facts: [{ k: "form20", v: "F20-RJ-2231", as: "text" }, { k: "validTo", v: "2026-10-04", as: "date" }] },
    { id: "pay:msme", source: "PAY", kind: "pay_msme_due", tier: 2, params: { count: 2, total: 15_100_000, until: "2026-10-02", days: 4, vendors: "Sun Pharma · Medplus" },
      clock: { code: "days_left", n: 4, tone: "gd" }, ref: { kind: "payRun", id: null }, facts: [{ k: "total", v: 15_100_000, as: "money" }] },
    { id: "buy:po:po-1", source: "BUY", kind: "po_approve", tier: 3, params: { poNo: "MPO2609240001", vendor: "Medplus Distributors", total: 11_280_000, lines: 9, tier: "owner" },
      clock: { code: "waited", n: 150, tone: "no" }, ref: { kind: "po", id: "po-1" },
      facts: [{ k: "vendor", v: "Medplus Distributors", as: "text" }, { k: "lines", v: 9, as: "count" }, { k: "value", v: 11_280_000, as: "money" }] },
    { id: "pay:bill:b9", source: "PAY", kind: "bill_held", tier: 4, params: { billNo: "MSB2609270004", vendor: "Anand Medical Agencies", over: 121_200 },
      clock: { code: "days_ago", n: 1, tone: "no" }, ref: { kind: "bill", id: "b9" }, facts: [] },
    { id: "people:u-kj", source: "PEOPLE", kind: "pharmacist_trial", tier: 7, params: { name: "Kavita Joshi", username: "kavita.joshi", no: "TRIAL-KJ-0001" },
      clock: { code: "open", tone: "gd" }, ref: { kind: "pharmacist", id: "u-kj" }, facts: [] },
  ],
};
const OFFICE_HEAD = ["materials.po.raise", "materials.bills.manage", "materials.stock.read", "approvals.requests.decide", "pharmacy.retail.manage", "pharmacy.pharmacists.manage"];

describe("PharmacyOffice — Today (gap-closure B2)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("opens on one ranked list, most urgent first, with the header menu in place of the tabs", async () => {
    mock({ "GET /pharmacy/office/needs": NEEDS }, OFFICE_HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await screen.findByTestId("need-law:retail");
    const list = screen.getByTestId("needs-list");
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["need-law:retail", "need-pay:msme", "need-buy:po:po-1", "need-pay:bill:b9", "need-people:u-kj"]);
    expect(rows[0]).toHaveTextContent("Retail drug licence (Form 20 / 21) lapses on Sun 4 Oct");
    expect(rows[0]).toHaveTextContent("6 d");
    expect(rows[0]).toHaveTextContent("Record renewal →");
    expect(rows[1]).toHaveTextContent("2 MSME bills cross 45 days on Fri 2 Oct — ₹1,51,000");
    expect(rows[2]).toHaveTextContent("2 h 30 m");
    expect(screen.getByTestId("needs-sub")).toHaveTextContent("5 things, most urgent first · buying, paying, law, people in one list");
    // No filter tabs: the header menu, by grant.
    expect(screen.queryByRole("tablist")).toBeNull();
    const menu = screen.getByRole("navigation", { name: "Office" });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Buy", "Pay", "Stock", "Law"]);
    expect(screen.getByTestId("pill-due")).toHaveTextContent("₹1,51,000 due this week");
    expect(screen.getByTestId("pill-law")).toHaveTextContent("licence lapses in 6 d");
    expect(screen.getByTestId("in-hand")).toHaveTextContent("Nothing in hand");
    expect(screen.getByTestId("copilot-po")).toHaveTextContent("2 purchase orders from the reorder list and the short book · 13 lines");
  });

  it("↓ and ⏎ put a row in hand with its facts and why; A opens the existing order sheet; Esc clears the lane", async () => {
    const calls = mock({ "GET /pharmacy/office/needs": NEEDS, "GET /materials/purchase-orders/po-1": { purchaseOrder: po({ poNo: "MPO2609240001" }) } }, OFFICE_HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await screen.findByTestId("need-buy:po:po-1");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.getByTestId("need-buy:po:po-1")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const lane = screen.getByTestId("in-hand");
    expect(within(lane).getByTestId("in-hand-head")).toHaveTextContent("Approve a purchase order");
    expect(lane).toHaveTextContent("VendorMedplus Distributors");
    expect(lane).toHaveTextContent("Value₹1,12,800");
    expect(within(lane).getByTestId("in-hand-why")).toHaveTextContent("approver ≠ GRN receiver");
    expect(within(lane).getByTestId("in-hand-pri")).toHaveTextContent("Approve MPO2609240001");
    expect(screen.getByTestId("need-buy:po:po-1")).toHaveClass("sel");

    await userEvent.keyboard("a");
    const sheet = await screen.findByTestId("po-sheet");
    expect(await within(sheet).findByTestId("po-line-CROC500")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/materials/purchase-orders/po-1")).toBe(true);
    sheet.focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("po-sheet")).toBeNull());
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("in-hand")).toHaveTextContent("Nothing in hand");
  });

  it("the secondary act on an order to approve opens the sheet already asking why it is returned", async () => {
    mock({ "GET /pharmacy/office/needs": NEEDS, "GET /materials/purchase-orders/po-1": { purchaseOrder: po() } }, OFFICE_HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("need-buy:po:po-1"));
    await userEvent.click(screen.getByTestId("in-hand-sec"));
    const sheet = await screen.findByTestId("po-sheet");
    expect(await within(sheet).findByLabelText("Why is it returned?")).toBeInTheDocument();
  });

  it("a held bill's act opens the Pay side on that bill's sheet", async () => {
    const calls = mock({ "GET /pharmacy/office/needs": NEEDS, "GET /pharmacy/office/pay": { toMatch: [], drafts: [], held: [], matched: [], dueThisWeek: [], overdue: [], runs: [], outstandingPaise: 0, overduePaise: 0,
      plan: { vendors: 0, bills: 0, totalPaise: 0, blocked: 0, until: "2026-10-04", creditPaise: 0, covered: 0 } } }, OFFICE_HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("need-pay:bill:b9"));
    expect(screen.getByTestId("in-hand-head")).toHaveTextContent("A bill does not match its delivery");
    await userEvent.click(screen.getByTestId("in-hand-pri"));
    expect(await screen.findByTestId("pay-view")).toBeInTheDocument();
    expect(await screen.findByTestId("bill-sheet")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/supplier-bills/b9")).toBe(true));
    expect(screen.getByTestId("office-view-pay")).toHaveAttribute("aria-current", "page");
  });

  it("the copilot's purchase orders are reviewed in the existing plan sheet", async () => {
    mock({ "GET /pharmacy/office/needs": NEEDS, "GET /pharmacy/office/plan": { storeResourceId: "s", storeCode: "PHARM-OPD", expectedDate: "2026-09-30", groups: [], unassigned: [], unmatched: [], alreadyDrafted: [] },
      "GET /materials/purchase-vendors": { vendors: [] } }, OFFICE_HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(within(await screen.findByTestId("copilot-po")).getByRole("button", { name: "Review" }));
    expect(await screen.findByTestId("plan-sheet")).toBeInTheDocument();
  });

  it("on a phone: OFFICE · TODAY with a Menu, and a row opens full screen with its act pinned", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    mock({ "GET /pharmacy/office/needs": NEEDS }, OFFICE_HEAD);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await screen.findByTestId("need-law:retail");
    expect(screen.getByText("OFFICE · TODAY")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("office-menu"));
    expect(screen.getByTestId("office-view-pay")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("office-menu"));
    expect(screen.getByTestId("office-copilot")).toHaveTextContent("Copilot drafted 2 purchase orders");
    await userEvent.click(screen.getByTestId("need-law:retail"));
    const full = await screen.findByRole("dialog", { name: "Retail drug licence (Form 20 / 21) lapses on Sun 4 Oct" });
    expect(within(full).getByTestId("in-hand-pri")).toHaveTextContent("Record the renewed licence");
    expect(screen.queryByText("OFFICE · TODAY")).toBeNull();
    await userEvent.click(within(full).getByTestId("in-hand-back"));
    expect(await screen.findByText("OFFICE · TODAY")).toBeInTheDocument();
  });
});
