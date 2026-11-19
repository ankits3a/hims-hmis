import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresBuy } from "./stores-buy";
import type { WirePurchaseRequest } from "@hmis/contracts";

/** STORES S5a (#1115) — Ask to buy on the phone, the HOD's approval sheet with its budget line, and bulk approval. */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | { status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path] = raw.replace(/^.*\/api/, "").split("?") as [string];
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: { d1: ["stores.purchase.request", "stores.indents.approve"] }, floor: {} } } }), { status: 200 });
    }
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response("{}", { status: 404 });
    if (typeof hit === "object" && hit !== null && "status" in hit && "body" in hit) {
      const h = hit as { status: number; body: unknown };
      return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const CTX = (over: Partial<{ ownHod: boolean; bulk: boolean }> = {}) => ({
  departments: [{ id: "d1", code: "ICU", name: "ICU", canAsk: true, canApprove: true, ownHod: over.ownHod ?? true, shelves: [{ id: "s1", name: "ICU shelf" }] }],
  can: { buying: false, masters: false, budget: false, qc: false, bulk: over.bulk ?? false },
});
const PR = (id: string, over: Partial<WirePurchaseRequest> = {}): WirePurchaseRequest => ({
  id, prNo: `MPR261110000${id.slice(-1)}`, source: "department", priority: "routine", note: null, status: "requested",
  department: { id: "d1", code: "ICU", name: "ICU" }, shelfId: "s1", raisedBy: { id: "u2", name: "Sister" }, raisedAt: "2026-11-10T06:00:00.000Z",
  lines: [{ lineIdx: 0, itemId: "i1", itemCode: "FU-WCH-0001", itemName: "Wheelchair", baseUom: "piece", qtyBase: 2, unitEstimatePaise: 800_000, estimateSource: "requester", onContract: false, equipment: false, answers: null }],
  estimatePaise: 1_600_000, band: "A", split: null, budget: { month: "2026-11", pct: 82, over: false, noBudget: false }, stamp: null, ...over,
});

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Stores S5a screens (spec #1115)", () => {
  it("Ask to buy: choose from the list, the estimate fills itself, equipment asks its three answers, Send says Request sent", async () => {
    const calls = mock({
      "GET /stores/buy/context": CTX(),
      "GET /stores/search": { items: [{ id: "i9", code: "ME-MON-0001", name: "Patient monitor", baseUom: "piece", trackMode: "tagged" }] },
      "GET /stores/purchase-requests/preview": { itemId: "i9", name: "Patient monitor", baseUom: "piece", unitEstimatePaise: 12_000_000, estimateSource: "last", equipment: true, stockItem: false },
      "POST /stores/purchase-requests": PR("p1"),
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresBuy />);
    await user.type(await screen.findByLabelText("Item"), "moni");
    await user.click(await screen.findByRole("button", { name: /Patient monitor/ }));
    expect(await screen.findByText("₹1,20,000 each")).toBeInTheDocument();
    expect(screen.getByText("Last price")).toBeInTheDocument();
    expect(screen.getByTestId("buy-send")).toBeDisabled();
    await user.type(screen.getByLabelText("Why"), "Old one failed");
    await user.type(screen.getByLabelText("Use per day"), "8 patients");
    await user.click(screen.getByTestId("buy-send"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Request sent"));
    expect(calls.find((c) => c.method === "POST" && c.path === "/stores/purchase-requests")?.body).toEqual({
      source: "department", departmentId: "d1", shelfId: "s1", priority: "routine",
      lines: [{ itemId: "i9", qtyBase: 1, equipment: { why: "Old one failed", replacesTag: null, usePerDay: "8 patients" } }],
    });
  });

  it("a stock item is refused in words before Send", async () => {
    mock({
      "GET /stores/buy/context": CTX(),
      "GET /stores/search": { items: [{ id: "i3", code: "HK-MOP-0001", name: "Wet mop refill", baseUom: "piece", trackMode: "shelf" }] },
      "GET /stores/purchase-requests/preview": { itemId: "i3", name: "Wet mop refill", baseUom: "piece", unitEstimatePaise: 250, estimateSource: "last", equipment: false, stockItem: true },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresBuy />);
    await user.type(await screen.findByLabelText("Item"), "mop");
    await user.click(await screen.findByRole("button", { name: /Wet mop refill/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Stock item, ask the store"));
  });

  it("the HOD's sheet: item · quantity · estimate, the band and budget in words; Approve in one tap; an over-budget request says so", async () => {
    const calls = mock({
      "GET /stores/buy/context": CTX(),
      "GET /stores/purchase-requests/to-approve": { requests: [PR("p1"), PR("p2", { budget: { month: "2026-11", pct: 125, over: true, noBudget: false }, band: "B", split: { prIds: ["p1", "p2"], prNos: ["a", "b"] } })] },
      "POST /stores/purchase-requests/p1/approve": PR("p1", { status: "approved" }),
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresBuy />, "/?pr=p1");
    const first = await screen.findByTestId("pr-p1");
    for (const w of ["Wheelchair", "× 2", "₹16,000", "One quote", "Budget 82% used"]) expect(within(first).getByText(w)).toBeInTheDocument();
    const second = screen.getByTestId("pr-p2");
    for (const w of ["Three quotes", "Split?", "Over budget"]) expect(within(second).getByText(w)).toBeInTheDocument();
    await user.click(within(first).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Approved"));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/stores/purchase-requests/p1/approve")).toHaveLength(1);
  });

  it("bulk: the materials head ticks two and Approve all sends both in one call", async () => {
    const calls = mock({
      "GET /stores/buy/context": CTX({ bulk: true }),
      "GET /stores/purchase-requests/to-approve": { requests: [PR("p1"), PR("p2")] },
      "POST /stores/purchase-requests/bulk-approve": { requests: [PR("p1", { status: "approved" }), PR("p2", { status: "approved" })] },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresBuy />);
    await user.click(await screen.findByRole("tab", { name: "To approve" }));
    await user.click(await screen.findByLabelText("MPR2611100001"));
    await user.click(screen.getByLabelText("MPR2611100002"));
    await user.click(screen.getByTestId("buy-approve-all"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 approved"));
    expect(calls.find((c) => c.path === "/stores/purchase-requests/bulk-approve")?.body).toEqual({ ids: ["p1", "p2"] });
  });
});
