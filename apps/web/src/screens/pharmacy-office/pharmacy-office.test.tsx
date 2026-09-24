import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import type { WireOfficeToday, WirePo, WirePoSummary, WirePurchasePlan } from "../../lib/purchase-api";

/**
 * PHARMACY PARITY P2 — the back office: what needs this person today, the order sheet with its keys
 * (⏎ opens, A approves, R rejects with a reason, Esc closes), and the agent's plan made into drafts
 * by a person's press.
 */
type Call = { method: string; path: string; body: unknown };

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
    await userEvent.click(within(await screen.findByTestId("section-waiting")).getByTestId("po-row-MPO2609240001"));
    const sheet = await screen.findByTestId("po-sheet");
    expect(await within(sheet).findByText("Waiting on the owner.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});
