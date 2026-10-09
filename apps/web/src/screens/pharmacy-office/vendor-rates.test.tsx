import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { VendorRatesView } from "./vendor-rates";

/** Owner 2026-10-04 — step 2: a vendor's contracted rates, and a draft order at them. */
const posted: { path: string; body: unknown }[] = [];
function mock(perms: string[]): void {
  posted.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    if (init?.body !== undefined) posted.push({ path, body: JSON.parse(String(init.body)) });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/materials/purchase-vendors") return json({ vendors: [{ id: "v-aptus", code: "APTUS", name: "Aptus Drugs" }] });
    if (method === "GET" && path === "/pharmacy/office/vendor-rates/v-aptus") {
      return json({ lines: [{
        id: "r-1", itemId: "i-saz", itemCode: "SAZOTEL40", itemName: "Sazotel-40 tablet", baseUom: "tablet", uom: "strip", multiplier: 15,
        ratePaise: 2_952, gstRateBps: 500, mrpPaise: 10_600, validFrom: "2026-10-04", validTo: null, source: "Price list import",
        lastPaidPaise: 2_500, lastVendorId: "v-other",
      }] });
    }
    if (path === "/pharmacy/office/order-from-rates") return json({ order: { id: "po-1", poNo: "PO-0042", totalPaise: 309_960 } });
    return new Response("{}", { status: 404 });
  }));
}

describe("vendor rates (owner 2026-10-04)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows a vendor's contract beside the MRP and the last price paid, and makes a draft order the server prices", async () => {
    mock(["materials.po.raise"]);
    const user = userEvent.setup();
    renderWithProviders(<VendorRatesView />);
    await user.selectOptions(await screen.findByTestId("rates-vendor"), "v-aptus");
    const row = await screen.findByTestId("rates-row-SAZOTEL40");
    // ₹29.52 + 5% = ₹30.99 against an MRP of ₹106: 71% margin; dearer than the ₹25 last paid, so marked.
    expect(row).toHaveTextContent("strip of 15 tablet");
    expect(row).toHaveTextContent("₹29.52");
    expect(row).toHaveTextContent("71%");
    expect(row).toHaveTextContent("until replaced");
    expect(screen.queryByTestId("rates-end-SAZOTEL40")).toBeNull(); // ending a rate is the vendor-keeper's act
    expect(screen.getByTestId("rates-order")).toBeDisabled();
    await user.type(screen.getByTestId("rates-packs-SAZOTEL40"), "100");
    await user.type(screen.getByTestId("rates-free-SAZOTEL40"), "10");
    expect(screen.getByTestId("rates-total")).toHaveTextContent("1 item · ₹2952.00 + GST ₹147.60 = ₹3099.60");
    await user.click(screen.getByTestId("rates-order"));
    await waitFor(() => expect(posted.find((p) => p.path === "/pharmacy/office/order-from-rates")?.body).toEqual({
      vendorId: "v-aptus", lines: [{ itemId: "i-saz", qtyPacks: 100, freePacks: 10 }],
    }));
    expect(await screen.findByTestId("rates-made")).toHaveTextContent("Draft order PO-0042 made");
  });
});
