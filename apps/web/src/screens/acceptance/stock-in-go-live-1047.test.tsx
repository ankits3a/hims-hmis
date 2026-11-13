import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { packOf } from "../pharmacy-desk/work";
import { DRAFT_KEY, StockEntryView } from "../pharmacy-office/stock-entry";
import type { WireStockItem } from "../../lib/stock-entry-api";

/**
 * ACCEPTANCE — issue #1047, spec docs/specs/1047-pharmacy-stock-in-go-live.md (owner APPROVED 2026-11-13): the web half.
 * D1's desk side (the counter pack the desk counts in) and D5 (the recount's control file, which never leaves the browser).
 * The server half: apps/core/src/modules/pharmacy/acceptance/stock-in-go-live-1047.test.ts.
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

describe("#1047 — pharmacy stock-in go-live (web)", () => {
  it("spec #1047 D1: the desk counts in the item's issue pack, as the server does — not its largest pack", () => {
    const uoms = [
      { uom: "tablet", toBaseMultiplier: 1, isIssueUom: true },
      { uom: "strip10", toBaseMultiplier: 10, isIssueUom: false },
      { uom: "strip15", toBaseMultiplier: 15, isIssueUom: true },
      { uom: "box150", toBaseMultiplier: 150, isIssueUom: false },
    ];
    expect(packOf({ uoms })?.uom).toBe("strip15");
    // No issue pack named: the smallest pack above one unit, the server's bill rows' reading.
    const unflagged = uoms.map((u) => ({ uom: u.uom, toBaseMultiplier: u.toBaseMultiplier }));
    expect(packOf({ uoms: unflagged })?.uom).toBe("strip10");
  });

  it("spec #1047 D5: with a control file loaded, the grid flags a medicine whose entered total differs from the control", async () => {
    mock();
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "dolo");
    await within(await screen.findByTestId("se-brand-list-0")).findByText("Dolo 650 tablet");
    await user.keyboard("{Enter}");
    // 4 strips of 15 counted on the shelf: 60 tablets.
    await user.type(screen.getByLabelText("Packs · row 1"), "4");
    await user.upload(screen.getByLabelText("Control file"), new File(["item,quantity\nDOLO650,70\n"], "control.csv", { type: "text/csv" }));
    const row = await screen.findByTestId("se-recount-DOLO650");
    expect(row).toHaveAttribute("data-differs", "true");
    expect(row).toHaveTextContent("60");
    expect(row).toHaveTextContent("70");
  });
});
