import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { LabelsView } from "./labels";
import type { WireLabelCandidate } from "../../lib/labels-api";

/**
 * GAP A6 — rack and strip labels as an office page under Items: a store's items with their rack and
 * held batches, copies typed per item (rack) and per batch (strip), two print buttons and no tabs. The
 * server queues them for the label printer or hands the stickers back for this browser to print.
 */
const printed = vi.fn();
vi.mock("../../lib/print-api", async (orig) => ({
  ...(await orig<typeof import("../../lib/print-api")>()),
  printInFrame: (doc: { html: string }) => { printed(doc.html); return true; },
}));

type Call = { method: string; path: string; query: string; body: unknown };
function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [p, query = ""] = raw.split("?");
    const path = p!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, query, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["pharmacy.sale_items.manage"], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const STORES = [{ id: "s-opd", code: "PHARM-OPD", name: "OPD pharmacy" }, { id: "s-main", code: "MAIN", name: "Main store" }];
const ROWS: WireLabelCandidate[] = [
  { itemId: "i-cr", code: "CROC500", name: "Crocin 500", baseUom: "tablet", rack: "R-12-B", packs: [{ uom: "strip", toBase: 10 }],
    batches: [
      { batchId: "b-1", batchNo: "CR-1", expiryDate: "2027-01-31", mrpPaise: 2550, mrpUom: "strip", qtyOnHand: 100 },
      { batchId: "b-0", batchNo: "CR-0", expiryDate: "2027-03-31", mrpPaise: null, mrpUom: null, qtyOnHand: 10 },
    ] },
  { itemId: "i-az", code: "AZI500", name: "Azithral 500", baseUom: "tablet", rack: null, packs: [], batches: [] },
];
const candidates = (): { stores: typeof STORES; rows: WireLabelCandidate[] } => ({ stores: STORES, rows: ROWS });

beforeEach(() => { setToken("t"); printed.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("rack and strip labels (gap A6)", () => {
  it("opens on the first store; an item with no rack cannot take a rack label, a batch with no MRP no strip label", async () => {
    const calls = mock({ "GET /pharmacy/labels": candidates });
    renderWithRouter(<LabelsView />);
    const row = await screen.findByTestId("labels-row-CROC500");
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/labels" && c.query === "store=s-opd")).toBe(true));
    expect(row).toHaveTextContent("R-12-B");
    expect(row).toHaveTextContent("Exp 01/2027");
    expect(screen.getByTestId("labels-rack-AZI500")).toBeDisabled();
    expect(screen.getByTestId("labels-row-AZI500")).toHaveTextContent("no rack");
    expect(screen.getByTestId("labels-strip-CR-0")).toBeDisabled();
    expect(screen.getByTestId("labels-print-rack")).toBeDisabled();
    expect(screen.getByTestId("labels-print-strip")).toBeDisabled();
  });

  it("prints the typed strip copies; with no relay the stickers print from this browser and it says so", async () => {
    const calls = mock({
      "GET /pharmacy/labels": candidates,
      "POST /pharmacy/labels/print": { via: "browser", document: { html: "<div class=\"lab\">CR-1</div>", title: "Strip labels", page: { widthMm: 50, heightMm: 25 } } },
    });
    renderWithRouter(<LabelsView />);
    await userEvent.type(await screen.findByTestId("labels-strip-CR-1"), "3");
    const button = screen.getByTestId("labels-print-strip");
    expect(button).toHaveTextContent("Print 3 strip labels");
    await userEvent.click(button);
    await waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ kind: "strip", storeResourceId: "s-opd", lines: [{ itemId: "i-cr", batchId: "b-1", copies: 3 }] });
    expect(screen.getByTestId("labels-notice")).toHaveTextContent("3 labels printed from this browser");
  });

  it("\"one rack label for every item shown\" fills only the racked items and queues them to the label printer", async () => {
    const calls = mock({
      "GET /pharmacy/labels": candidates,
      "POST /pharmacy/labels/print": { via: "relay", job: { id: "j-1", status: "queued", createdAt: "2026-09-29T10:00:00.000Z" } },
    });
    renderWithRouter(<LabelsView />);
    await screen.findByTestId("labels-row-CROC500");
    await userEvent.click(screen.getByTestId("labels-every-rack"));
    await userEvent.click(screen.getByTestId("labels-print-rack"));
    await waitFor(() => expect(within(screen.getByTestId("labels-view")).getByTestId("labels-notice")).toHaveTextContent("1 label sent to the label printer"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ kind: "rack", storeResourceId: "s-opd", lines: [{ itemId: "i-cr", copies: 1 }] });
    expect(printed).not.toHaveBeenCalled();
  });

  it("says the server's refusal in the counter's words", async () => {
    mock({
      "GET /pharmacy/labels": candidates,
      "POST /pharmacy/labels/print": () => new Response(JSON.stringify({ code: "invalid_label", message: "no rack" }), { status: 400, headers: { "Content-Type": "application/json" } }),
    });
    renderWithRouter(<LabelsView />);
    await userEvent.type(await screen.findByTestId("labels-rack-CROC500"), "2");
    await userEvent.click(screen.getByTestId("labels-print-rack"));
    expect(await screen.findByTestId("labels-notice")).toHaveTextContent("The books cannot back this label");
  });
});
