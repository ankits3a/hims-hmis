import { screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyReorder } from "./pharmacy-reorder";
import type { WireReorderAdvice } from "../lib/pharmacy-api";

function mockAdvice(body: WireReorderAdvice): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.split("?")[0]!.endsWith("/api/pharmacy/reorder")) {
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
}

/** PHARMACY P4 — the reorder list, as the server ranked it. */
describe("PharmacyReorder (P4)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows each line's status, cover and suggestion, and where to get it or that it must be bought", async () => {
    mockAdvice({
      asOf: "2026-09-16T06:00:00.000Z",
      window: { days: 30, minCoverDays: 3, targetCoverDays: 7, nearExpiryDays: 90 },
      items: [
        { itemId: "i1", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", status: "stock_out", available: 0, usedInWindow: 10, daysOfCover: 0, unsoldByExpiry: 0, suggestBase: 10, suggestPacks: "1 strip", source: null },
        { itemId: "i2", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", status: "reorder", available: 2, usedInWindow: 38, daysOfCover: 1.6, unsoldByExpiry: 0, suggestBase: 10, suggestPacks: "1 strip", source: { storeCode: "MAIN-STORE", storeName: "Main store", available: 50 } },
        { itemId: "i3", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", status: "no_movement", available: 30, usedInWindow: 0, daysOfCover: null, unsoldByExpiry: 0, suggestBase: 0, suggestPacks: null, source: null },
      ],
      expiring: [],
      expiredOnShelf: [],
    });
    renderWithProviders(<PharmacyReorder />);
    expect(await screen.findByText(/under 3 days of cover/)).toBeInTheDocument();
    const calpol = await screen.findByTestId("reorder-CALP500");
    expect(calpol).toHaveTextContent("Out of stock");
    expect(calpol).toHaveTextContent("10 tablet (1 strip)");
    expect(within(calpol).getByText("Purchase")).toBeInTheDocument();
    expect(calpol).not.toHaveTextContent("expire unsold");
    const azee = screen.getByTestId("reorder-AZEE500");
    expect(azee).toHaveTextContent("Reorder");
    expect(azee).toHaveTextContent("1.6");
    expect(azee).toHaveTextContent("Main store (has 50)");
    const crocin = screen.getByTestId("reorder-CROC500");
    expect(crocin).toHaveTextContent("No use");
    expect(crocin).not.toHaveTextContent("Purchase");
    expect(screen.getByRole("button", { name: "Print requisition" })).toBeInTheDocument();
    expect(screen.getByTestId("reorder-expiring")).toHaveTextContent("Nothing on the counter's shelf expires in the next 90 days.");
    expect(screen.queryByTestId("reorder-expired")).toBeNull();
  });

  /** PHARMACY P8 — what will expire unsold, what sells in time, and what is already past its date. */
  it("lists near-expiry batches with what to do, and the expired stock still on the shelf", async () => {
    mockAdvice({
      asOf: "2026-09-16T06:00:00.000Z",
      window: { days: 30, minCoverDays: 3, targetCoverDays: 7, nearExpiryDays: 90 },
      items: [
        { itemId: "i2", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", status: "ok", available: 90, usedInWindow: 90, daysOfCover: 20, unsoldByExpiry: 30, suggestBase: 0, suggestPacks: null, source: null },
      ],
      expiring: [
        { itemId: "i2", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", batchId: "b1", batchNo: "AZ-SOON", expiryDate: "2026-09-25", daysLeft: 9, available: 60, unsoldByExpiry: 30, action: "move_back" },
        { itemId: "i1", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", batchId: "b2", batchNo: "CP-1", expiryDate: "2026-09-16", daysLeft: 0, available: 2, unsoldByExpiry: 0, action: "sell_first" },
      ],
      expiredOnShelf: [
        { itemId: "i1", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", batchId: "b3", batchNo: "CP-OLD", expiryDate: "2026-09-10", onHand: 12 },
      ],
    });
    renderWithProviders(<PharmacyReorder />);
    expect(await screen.findByTestId("reorder-AZEE500")).toHaveTextContent("30 will expire unsold");
    expect(screen.getByText("Near expiry at the counter (next 90 days)")).toBeInTheDocument();
    const soon = screen.getByTestId("expiring-AZ-SOON");
    expect(soon).toHaveTextContent("2026-09-25");
    expect(soon).toHaveTextContent("30 tablet");
    expect(soon).toHaveTextContent("Send back");
    const last = screen.getByTestId("expiring-CP-1");
    expect(last).toHaveTextContent("last day today");
    expect(last).toHaveTextContent("Sells in time");
    expect(screen.getByTestId("expired-CP-OLD")).toHaveTextContent("Batch CP-OLD · Expires 2026-09-10 · On hand 12 tablet");
  });
});

/**
 * PARITY P1 — the short book sits at the top of the reorder list: what the counter said it was out
 * of, who said so and when, and the counter's act of closing a row (ordered, received, dismissed).
 */
describe("PharmacyReorder — the short book (parity P1)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists the open shortages first, a drug the hospital does not stock marked so, and closes one as ordered", async () => {
    const resolved: unknown[] = [];
    let open = [
      { id: "sb1", storeResourceId: "s", itemId: null, drugName: "Pan 40", qtyWanted: null, source: "agent", dispenseId: null, notedBy: "u1", notedAt: "2026-09-19T05:00:00.000Z", resolvedAt: null, resolvedBy: null, resolution: null, notedByName: "Kavita Joshi" },
      { id: "sb2", storeResourceId: "s", itemId: "i1", drugName: "Calpol 500 tablet", qtyWanted: 30, source: "desk", dispenseId: "d1", notedBy: "u1", notedAt: "2026-09-19T06:00:00.000Z", resolvedAt: null, resolvedBy: null, resolution: null, notedByName: "Kavita Joshi" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).split("?")[0]!;
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (raw.endsWith("/api/auth/me")) return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["pharmacy.dispense.place", "pharmacy.dispense.read"], scoped: { department: {}, floor: {} } } });
      if (raw.endsWith("/api/pharmacy/short-book")) return json({ entries: open });
      if (raw.endsWith("/api/pharmacy/short-book/sb1/resolve")) {
        resolved.push(JSON.parse(String(init?.body)));
        open = open.filter((e) => e.id !== "sb1");
        return json({ ...open[0], resolvedAt: "x" });
      }
      if (raw.endsWith("/api/pharmacy/reorder")) return json({ asOf: "2026-09-19T06:00:00.000Z", window: { days: 30, minCoverDays: 3, targetCoverDays: 7, nearExpiryDays: 90 }, items: [], expiring: [], expiredOnShelf: [] });
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<PharmacyReorder />);
    const book = await screen.findByTestId("reorder-short-book");
    expect(book).toHaveTextContent("Short book · 2 open");
    const pan = await within(book).findByTestId("short-sb1");
    expect(pan).toHaveTextContent("Pan 40");
    expect(pan).toHaveTextContent("not stocked");
    expect(pan).toHaveTextContent("Kavita Joshi");
    expect(pan).toHaveTextContent("agent draft");
    expect(within(book).getByTestId("short-sb2")).toHaveTextContent("30");
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(await within(pan).findByRole("button", { name: "Ordered" }));
    await waitFor(() => expect(resolved).toEqual([{ resolution: "ordered" }]));
    await waitFor(() => expect(screen.queryByTestId("short-sb1")).toBeNull());
  });
});
