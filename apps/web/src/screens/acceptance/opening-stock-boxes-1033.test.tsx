import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { DRAFT_KEY, StockEntryView } from "../pharmacy-office/stock-entry";
import type { WireStockItem } from "../../lib/stock-entry-api";

/**
 * ACCEPTANCE — issue #1033, spec docs/specs/1033-opening-stock-boxes.md (owner APPROVED 2026-11-06): the web half.
 * The opening-stock grid has Boxes and Per box inputs, and each row shows its total before submit.
 */
const DOLO: WireStockItem = {
  itemId: "it-dolo", code: "DOLO650", name: "Dolo 650 tablet", baseUom: "tablet",
  packs: [{ uom: "tablet", multiplier: 1 }, { uom: "strip", multiplier: 15 }], gstRateBps: 500, hsnCode: "3004",
  onSale: true, active: true, strength: "650 mg", form: "tablet", schedule: "OTC", rack: "A1", mrpPaise: 3360, mrpUom: "strip",
};

function mock(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.replace(/^.*\/api/, "");
    const path = url.split("?")[0]!;
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") {
      return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["materials.grn.capture", "formulary.read"], scoped: { department: {}, floor: {} } } });
    }
    if (path === "/pharmacy/opening-stock/items") return json({ items: url.includes("dolo") ? [DOLO] : [] });
    if (path === "/pharmacy/opening-stock/suppliers") return json({ suppliers: [] });
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); window.localStorage.removeItem(DRAFT_KEY); });
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.removeItem(DRAFT_KEY); });

describe("#1033 — opening stock counts whole boxes (web)", () => {
  it("spec #1033 D5: the grid has Boxes and Per box, and the row shows '= 34 strips · 510 tablets' before submit", async () => {
    mock();
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "dolo");
    await within(await screen.findByTestId("se-brand-list-0")).findByText("Dolo 650 tablet");
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Per pack · row 1")).toHaveValue("15");
    await user.type(screen.getByLabelText("Boxes · row 1"), "3");
    await user.type(screen.getByLabelText("Per box · row 1"), "10");
    await user.type(screen.getByLabelText("Packs · row 1"), "4");
    expect(screen.getByTestId("se-total-0")).toHaveTextContent("= 34 strips · 510 tablets");
  });
});
