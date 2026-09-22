import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaterialsTransfers } from "./materials-transfers";
import type { WireTransferView } from "../lib/materials-api";

type Reply = { status: number; body: unknown };
type Handler = unknown | ((init?: RequestInit) => unknown);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const out = typeof h === "function" ? (h as (i?: RequestInit) => unknown)(init) : h;
    const reply = (out !== null && typeof out === "object" && "status" in out && "body" in out) ? out as Reply : { status: 200, body: out };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const posted = (path: string): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).endsWith(path))
  .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
const asked = (fragment: string): boolean => vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(fragment));
const me = (hospital: string[]) => ({ actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });

const STORES = [
  { id: "s-main", code: "MAIN", name: "Main store", status: "active" },
  { id: "s-retail", code: "PHARM-RETAIL", name: "Walk-in retail pharmacy", status: "active" },
];
const CROCIN = {
  id: "i-croc", code: "CROC500", name: "Crocin 500 tablet", class: "drug", formularyMedicineId: "m1", hsnCode: null, gstRateBps: 500,
  baseUom: "tablet", batchTracked: true, serialTracked: false, storageClass: "ambient", shelfLifeDays: null, abcClass: null, vedClass: null, active: true,
};
const INBOUND: WireTransferView = {
  id: "01TRANSFER0000000000ABC123", ref: "TR-ABC123", status: "in_transit", note: "retail shelf top-up",
  from: { id: "s-main", code: "MAIN", name: "Main store" }, to: { id: "s-retail", code: "PHARM-RETAIL", name: "Walk-in retail pharmacy" },
  issuedBy: { id: "u-sk", name: "Suresh (storekeeper)" }, issuedAt: "2026-09-17T04:30:00.000Z", receivedBy: null, receivedAt: null,
  lines: [
    { id: "l1", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", batchId: "b1", batchNo: "CR-1", expiryDate: "2027-06-30", qtyIssued: 100, qtyReceived: null, discrepancyReason: null },
    { id: "l2", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", batchId: "b2", batchNo: "CR-2", expiryDate: "2027-09-30", qtyIssued: 50, qtyReceived: null, discrepancyReason: null },
  ],
};
const SHORT: WireTransferView = {
  ...INBOUND, id: "01TRANSFER0000000000XYZ789", ref: "TR-XYZ789", status: "discrepancy", note: null,
  receivedBy: { id: "u-ph", name: "Meena (pharmacist)" }, receivedAt: "2026-09-16T09:00:00.000Z",
  lines: [{ ...INBOUND.lines[0]!, qtyIssued: 30, qtyReceived: 28, discrepancyReason: "short_2" }],
};

/** The transfer screen (2026-09-17): send stock from one store to another, and confirm what arrived. */
describe("MaterialsTransfers", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends stock: the source's available quantity is shown, and the issue carries only whole positive quantities", async () => {
    mockRoutes({
      "GET /api/auth/me": me(["materials.stock.read", "materials.stock.issue", "materials.items.read"]),
      "GET /api/materials/stores": { stores: STORES },
      "GET /api/materials/transfers/worklist": { awaiting: [], recent: [] },
      "GET /api/materials/items": { items: [CROCIN] },
      "GET /api/materials/stock/balances": { balances: [
        { resourceId: "s-main", itemId: "i-croc", batchId: "b1", qtyOnHand: 120, qtyReserved: 10, qtyFrozen: 0 },
        { resourceId: "s-main", itemId: "i-croc", batchId: "b2", qtyOnHand: 50, qtyReserved: 0, qtyFrozen: 50 },
      ] },
      "POST /api/materials/transfers": { transferId: "01TRANSFER0000000000NEW001", lines: [{ transferLineId: "l9", batchId: "b1", qtyIssued: 100 }] },
    });
    renderWithProviders(<MaterialsTransfers />);
    const send = await screen.findByTestId("transfer-send");
    await userEvent.selectOptions(within(send).getByRole("combobox", { name: "From" }), "s-main");
    await userEvent.selectOptions(within(send).getByRole("combobox", { name: "To" }), "s-retail");
    await userEvent.type(within(send).getByRole("textbox", { name: "Item name or code" }), "croc");
    await userEvent.click(within(send).getByRole("button", { name: "Find" }));
    await userEvent.click(await within(send).findByRole("button", { name: "Add" }));
    // 120 on hand less 10 reserved, and the frozen batch is not available at all.
    expect(await within(send).findByTestId("send-line-0")).toHaveTextContent("110 tablet available");
    await waitFor(() => { expect(asked("/api/materials/stock/balances?resourceId=s-main&itemId=i-croc")).toBe(true); });
    const issue = within(send).getByRole("button", { name: "Issue stock" });
    await userEvent.type(within(send).getByRole("textbox", { name: "Quantity, CROC500" }), "0");
    expect(issue).toBeDisabled();
    await userEvent.clear(within(send).getByRole("textbox", { name: "Quantity, CROC500" }));
    await userEvent.type(within(send).getByRole("textbox", { name: "Quantity, CROC500" }), "100");
    await userEvent.type(within(send).getByRole("textbox", { name: "Note" }), "retail shelf top-up");
    await userEvent.click(issue);
    expect(await screen.findByTestId("transfer-sent")).toHaveTextContent("Sent TR-NEW001 to Walk-in retail pharmacy. It is in transit until the receiving store confirms it.");
    expect(posted("/materials/transfers")).toEqual([{
      fromResourceId: "s-main", toResourceId: "s-retail", note: "retail shelf top-up", lines: [{ itemId: "i-croc", qtyBase: 100 }],
    }]);
  });

  it("confirms what arrived: the quantities start at what was sent, a shortfall is sent as counted, and a refusal is a sentence", async () => {
    let tries = 0;
    mockRoutes({
      "GET /api/auth/me": me(["materials.stock.read", "materials.stock.receive"]),
      "GET /api/materials/stores": { stores: STORES },
      "GET /api/materials/transfers/worklist": { awaiting: [INBOUND], recent: [INBOUND, SHORT] },
      "POST /api/materials/transfers/01TRANSFER0000000000ABC123/receive": () => {
        tries += 1;
        return tries === 1
          ? { status: 409, body: { statusCode: 409, code: "not_store_keeper", message: "x" } }
          : { status: 201, body: { status: "discrepancy", shortfalls: [{ transferLineId: "l2", qtyShort: 5 }] } };
      },
    });
    renderWithProviders(<MaterialsTransfers />);
    // No issue permission: no send form.
    const inbound = await screen.findByTestId("awaiting-TR-ABC123");
    expect(screen.queryByTestId("transfer-send")).toBeNull();
    expect(inbound).toHaveTextContent("Main store → Walk-in retail pharmacy");
    expect(inbound).toHaveTextContent("sent by Suresh (storekeeper) at 10:00");
    const second = within(inbound).getByRole("textbox", { name: "Received, batch CR-2" });
    expect(second).toHaveValue("50");
    await userEvent.clear(second);
    await userEvent.type(second, "45");
    expect(inbound).toHaveTextContent("5 short");
    await userEvent.click(within(inbound).getByRole("button", { name: "Confirm receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the receiving store's own staff confirm what reached it.");
    await userEvent.click(within(inbound).getByRole("button", { name: "Confirm receipt" }));
    expect(await screen.findByTestId("transfer-received")).toHaveTextContent("TR-ABC123 received with a shortfall of 5. It stays on the discrepancy list for the materials head.");
    expect(posted("/transfers/01TRANSFER0000000000ABC123/receive")[1]).toEqual({ lines: [{ lineId: "l1", qtyReceived: 100 }, { lineId: "l2", qtyReceived: 45 }] });

    // The recent list names people and stores, and shows the shortfall.
    const recent = screen.getByTestId("recent-TR-XYZ789");
    expect(recent).toHaveTextContent("Short");
    expect(recent).toHaveTextContent("received by Meena (pharmacist)");
    expect(recent).toHaveTextContent("CROC500 · CR-1 · 28 of 30");
  });

  it("narrows both lists to one store", async () => {
    mockRoutes({
      "GET /api/auth/me": me(["materials.stock.read"]),
      "GET /api/materials/stores": { stores: STORES },
      "GET /api/materials/transfers/worklist": { awaiting: [], recent: [] },
    });
    renderWithProviders(<MaterialsTransfers />);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Store" }), "s-retail");
    await waitFor(() => { expect(asked("/api/materials/transfers/worklist?storeId=s-retail")).toBe(true); });
    expect(screen.getByText("Nothing is in transit.")).toBeInTheDocument();
  });
});
