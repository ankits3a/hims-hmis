import { screen, within } from "@testing-library/react";
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
      window: { days: 30, minCoverDays: 3, targetCoverDays: 7 },
      items: [
        { itemId: "i1", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", status: "stock_out", available: 0, usedInWindow: 10, daysOfCover: 0, suggestBase: 10, suggestPacks: "1 strip", source: null },
        { itemId: "i2", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", status: "reorder", available: 2, usedInWindow: 38, daysOfCover: 1.6, suggestBase: 10, suggestPacks: "1 strip", source: { storeCode: "MAIN-STORE", storeName: "Main store", available: 50 } },
        { itemId: "i3", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", status: "no_movement", available: 30, usedInWindow: 0, daysOfCover: null, suggestBase: 0, suggestPacks: null, source: null },
      ],
    });
    renderWithProviders(<PharmacyReorder />);
    expect(await screen.findByText(/under 3 days of cover/)).toBeInTheDocument();
    const calpol = await screen.findByTestId("reorder-CALP500");
    expect(calpol).toHaveTextContent("Out of stock");
    expect(calpol).toHaveTextContent("10 tablet (1 strip)");
    expect(within(calpol).getByText("Purchase")).toBeInTheDocument();
    const azee = screen.getByTestId("reorder-AZEE500");
    expect(azee).toHaveTextContent("Reorder");
    expect(azee).toHaveTextContent("1.6");
    expect(azee).toHaveTextContent("Main store (has 50)");
    const crocin = screen.getByTestId("reorder-CROC500");
    expect(crocin).toHaveTextContent("No use");
    expect(crocin).not.toHaveTextContent("Purchase");
    expect(screen.getByRole("button", { name: "Print requisition" })).toBeInTheDocument();
  });
});
