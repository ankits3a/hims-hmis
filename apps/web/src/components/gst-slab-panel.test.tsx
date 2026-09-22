import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { GstSlabPanel } from "./gst-slab-panel";
import type { WireGstPlanRow } from "../lib/pharmacy-api";

const PLAN: WireGstPlanRow[] = [
  { itemId: "i1", code: "AZEE500", name: "Azee 500 tablet", current: 500, suggested: 500, basis: "5%", verdict: "ok", categoryStale: false },
  { itemId: "i2", code: "CALP500", name: "Calpol 500 tablet", current: 1200, suggested: 500, basis: "5%", verdict: "differs", categoryStale: false },
  { itemId: "i3", code: "CROC500", name: "Crocin 500 tablet", current: 500, suggested: 500, basis: "5%", verdict: "ok", categoryStale: true },
  { itemId: "i4", code: "DARZ400", name: "Darzalex 400 mg vial", current: null, suggested: 0, basis: "nil: Daratumumab", verdict: "set", categoryStale: false },
];

/** PHARMACY P16 — the slabs that need a hand, and the one button that applies them. */
describe("GstSlabPanel (P16)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists only what needs doing, and applies with or without replacing the slabs that differ", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ slabsSet: 2, categoriesSynced: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/pharmacy/sale-items/gst-plan")) return new Response(JSON.stringify({ items: PLAN }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<GstSlabPanel />);
    const panel = await screen.findByTestId("gst-slab-panel");
    expect(within(panel).queryByTestId("gst-AZEE500")).toBeNull();
    expect(within(panel).getByTestId("gst-CALP500")).toHaveTextContent("12%5%Differs — replaced only if ticked");
    expect(within(panel).getByTestId("gst-CROC500")).toHaveTextContent("sale item still bills at its old rate");
    expect(within(panel).getByTestId("gst-DARZ400")).toHaveTextContent("—nilBlank — will be set");

    await userEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(posted).toEqual([{ overwrite: false }]));
    expect(await within(panel).findByRole("status")).toHaveTextContent("Slabs set: 2. Sale items brought to their slab: 1.");
    await userEvent.click(within(panel).getByRole("checkbox", { name: /Also replace slabs/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(posted).toEqual([{ overwrite: false }, { overwrite: true }]));
  });

  it("says so when every slab matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [PLAN[0]] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderWithProviders(<GstSlabPanel />);
    expect(await screen.findByText("All 1 drug items have a slab that matches, and every sale item follows it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});
