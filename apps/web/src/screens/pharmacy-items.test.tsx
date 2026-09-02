import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyItems } from "./pharmacy-items";

type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function bodiesOf(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const REGISTERED = [{
  itemId: "it-1", code: "AZI500", name: "Azithromycin 500 tablet", baseUom: "tablet", gstRateBps: 500,
  serviceId: "svc-1", serviceCode: "RX-AZI500", category: "pharmacy_5", active: true, itemActive: true,
}];
const CANDIDATES = [{ id: "it-2", code: "PARA500", name: "Paracetamol 500 tablet", baseUom: "tablet", gstRateBps: 1200 }];

describe("PharmacyItems (16c T2)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists the registered sale items and the candidates, and registers one with its item id", async () => {
    let registered = REGISTERED;
    let candidates = CANDIDATES;
    mockRoutes({
      "GET /api/pharmacy/sale-items": () => ({ status: 200, body: { items: registered } }),
      "GET /api/pharmacy/sale-items/candidates": () => ({ status: 200, body: { items: candidates } }),
      "POST /api/pharmacy/sale-items": () => {
        registered = [...registered, { ...REGISTERED[0]!, itemId: "it-2", code: "PARA500", serviceCode: "RX-PARA500", category: "pharmacy", gstRateBps: 1200 }];
        candidates = [];
        return { status: 201, body: { itemId: "it-2", serviceId: "svc-2", serviceCode: "RX-PARA500", category: "pharmacy" } };
      },
    });
    renderWithProviders(<PharmacyItems />);
    expect(await screen.findByText("RX-AZI500")).toBeInTheDocument();
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(await screen.findByText(/PARA500/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Register for sale" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/sale-items")).toEqual([{ itemId: "it-2" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("PARA500 registered as RX-PARA500");
    expect(await screen.findByText("RX-PARA500")).toBeInTheDocument();
    expect(screen.getByText("Every active drug is registered.")).toBeInTheDocument();
  });

  it("renders a refusal code as the locale's sentence, and withdraws with active:false", async () => {
    mockRoutes({
      "GET /api/pharmacy/sale-items": { status: 200, body: { items: REGISTERED } },
      "GET /api/pharmacy/sale-items/candidates": { status: 200, body: { items: CANDIDATES } },
      "POST /api/pharmacy/sale-items": { status: 409, body: { statusCode: 409, code: "gst_slab_unknown", message: "x" } },
      "PATCH /api/pharmacy/sale-items/it-1": { status: 200, body: { ok: true } },
    });
    renderWithProviders(<PharmacyItems />);
    await userEvent.click(await screen.findByRole("button", { name: "Register for sale" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GST rate is not a medicine slab");

    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(bodiesOf("PATCH", "/pharmacy/sale-items/it-1")).toEqual([{ active: false }]));
  });
});
