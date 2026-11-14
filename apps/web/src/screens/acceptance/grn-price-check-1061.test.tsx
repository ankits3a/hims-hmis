import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { DRAFT_KEY, RATE_BASIS_KEY, StockEntryView } from "../pharmacy-office/stock-entry";
import type { WireStockItem } from "../../lib/stock-entry-api";

/**
 * ACCEPTANCE — issue #1061, spec docs/specs/1061-grn-price-check.md (owner APPROVED 2026-11-14, ruling 0096): the
 * web half. D1's screen (an amber line shows the last receipts and the capture waits for a reason) and D7's (the
 * supplier's unused credit is shown at capture). The server half: apps/core/src/modules/pharmacy/acceptance/grn-price-check-1061.test.ts.
 */
const DOLO: WireStockItem = {
  itemId: "it-dolo", code: "DOLO650", name: "Dolo 650 tablet", baseUom: "tablet",
  packs: [{ uom: "tablet", multiplier: 1 }, { uom: "strip", multiplier: 15 }], gstRateBps: 500, hsnCode: "3004",
  onSale: true, active: true, strength: "650 mg", form: "tablet", schedule: "OTC", rack: "A1", mrpPaise: 3360, mrpUom: "strip",
};
const PERMS = ["materials.grn.capture", "materials.items.manage", "pharmacy.sale_items.manage", "formulary.read"];

type Call = { method: string; path: string; body: unknown };
type SentRow = { batch: string; packs: string; packSize: string; priceReason?: string };

/** The invoice check as the server gives it: one Dolo row at 168 paise a tablet, 5% above the last receipt (160). */
function invoiceCheck(body: unknown): unknown {
  const b = body as { header: { vendorId: string | null }; rows: SentRow[] };
  const rows = b.rows.map((r, i) => ({
    line: i + 1, brand: "", itemCode: "DOLO650", itemName: "Dolo 650 tablet", batch: r.batch, expiryDate: "2027-08-31",
    packs: Number(r.packs), packSize: 15, uom: "strip", newUom: false, near: false, mrpPaise: 3360, costPerBasePaise: 168,
    rack: "", reasons: [], freePacks: 0, ratePaise: 2520, discountBps: 0, estimatedCost: false,
    priceCheck: {
      status: "amber", refKind: "last_receipt", refPaisePerBase: 160, riseBps: 500, contract: null,
      receipts: [
        { grnNo: "GRN-0040", postedOn: "2026-11-12", vendorId: "v2", vendorName: "Apex Pharma", paisePerBase: 160 },
        { grnNo: "GRN-0031", postedOn: "2026-11-05", vendorId: "v1", vendorName: "Medline Distributors", paisePerBase: 158 },
      ],
      cheaper: { vendorId: "v1", vendorName: "Medline Distributors", paisePerBase: 158 },
    },
  }));
  const headerReasons = b.header.vendorId === null ? ["choose the supplier"] : [];
  return {
    headerReasons, rows, refusals: 0, units: 60, newUoms: 0, costPaise: 10_080, duplicateOf: null, authority: [],
    unusedCreditPaise: b.header.vendorId === "v1" ? 11_200 : 0,
  };
}

function mock(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.replace(/^.*\/api/, "");
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: PERMS, scoped: { department: {}, floor: {} } } });
    if (path === "/pharmacy/opening-stock/items") return json({ items: url.includes("dolo") ? [DOLO] : [] });
    if (path === "/pharmacy/opening-stock/suppliers") return json({ suppliers: [{ id: "v1", code: "MEDLINE", name: "Medline Distributors" }] });
    if (path === "/pharmacy/opening-stock/invoice/stores") return json({ stores: [{ id: "s1", code: "PHARM-OPD", name: "OPD pharmacy" }] });
    if (path === "/materials/purchase-orders") return json({ purchaseOrders: [] });
    if (path === "/pharmacy/opening-stock/invoice/check") return json(invoiceCheck(body));
    if (path === "/pharmacy/opening-stock/invoice/capture") return json({ grnId: "g9", grnNo: "GRN-0099", lines: 1, uomsAdded: 0 });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); window.localStorage.removeItem(DRAFT_KEY); window.sessionStorage.removeItem(RATE_BASIS_KEY); });
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.removeItem(DRAFT_KEY); window.sessionStorage.removeItem(RATE_BASIS_KEY); });

async function typeInvoice(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByTestId("se-mode-invoice"));
  await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "dolo");
  await within(await screen.findByTestId("se-brand-list-0")).findByText("Dolo 650 tablet");
  await user.keyboard("{Enter}");
  await user.type(screen.getByLabelText("Batch · row 1"), "B1");
  await user.type(screen.getByLabelText("Expiry · row 1"), "08/27");
  await user.type(screen.getByLabelText("Packs · row 1"), "4");
  await user.type(screen.getByLabelText("Rate ₹/pack · row 1"), "25.20");
  await user.selectOptions(screen.getByTestId("se-invoice-vendor"), "v1");
  await user.type(screen.getByTestId("se-invoice-no"), "SI/26/12");
  fireEvent.change(screen.getByTestId("se-invoice-date"), { target: { value: "2026-11-10" } });
}

describe("#1061 — purchase price check (web)", () => {
  it("spec #1061 D1: an amber line shows the last receipts and the capture waits for a reason", async () => {
    const calls = mock();
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await typeInvoice(user);

    const note = await screen.findByTestId("se-price-0", {}, { timeout: 3000 });
    expect(note).toHaveTextContent("5% above the last purchase (₹1.60/unit)");
    expect(note).toHaveTextContent("Apex Pharma ₹1.60");
    expect(note).toHaveTextContent("Medline Distributors ₹1.58");
    expect(screen.getByTestId("se-capture")).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Reason for the price · row 1"), "urgent_buy");
    await waitFor(() => expect(screen.getByTestId("se-capture")).toBeEnabled(), { timeout: 3000 });
    await user.click(screen.getByTestId("se-capture"));
    expect(await screen.findByTestId("se-invoice-result")).toHaveTextContent("GRN-0099");
    const sent = calls.find((c) => c.path === "/pharmacy/opening-stock/invoice/capture")!.body as { rows: SentRow[] };
    expect(sent.rows[0]!.priceReason).toBe("urgent_buy");
  });

  it("spec #1061 D7: the supplier's unused credit is shown at capture", async () => {
    mock();
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await typeInvoice(user);
    expect(await screen.findByTestId("se-invoice-credit", {}, { timeout: 3000 })).toHaveTextContent("₹112.00 unused credit from this supplier");
  });
});
