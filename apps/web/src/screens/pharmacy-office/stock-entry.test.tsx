import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { DRAFT_KEY, StockEntryView, blankRow, rowEconomics } from "./stock-entry";
import type { WireStockItem } from "../../lib/stock-entry-api";

/**
 * STOCK ENTRY ON SCREEN (2026-09-29) — the grid the owner enters the real shelf in: pick the brand from the item
 * master, type across the row (Enter walks it, a new row appears at the end), see the cost per unit and margin
 * live, see the SERVER's reasons under each row before capture, capture as GRNs and be told plainly that a second
 * person (the pharmacist) QCs and posts them in the GRN worklist. A new drug is one sheet and one call. The rows
 * are a draft that survives a reload.
 */
type Call = { method: string; path: string; url: string; body: unknown };
function mock(routes: Record<string, unknown | ((body: unknown, url: string) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.replace(/^.*\/api/, "");
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, url, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown, u: string) => unknown)(body, url) : v;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const DOLO: WireStockItem = {
  itemId: "it-dolo", code: "DOLO650", name: "Dolo 650 tablet", baseUom: "tablet",
  packs: [{ uom: "tablet", multiplier: 1 }, { uom: "strip", multiplier: 15 }], gstRateBps: 500, hsnCode: "3004",
  onSale: true, active: true, strength: "650 mg", form: "tablet", schedule: "OTC", rack: "A1", mrpPaise: 3360, mrpUom: "strip",
};
const PERMS = ["materials.grn.capture", "materials.items.manage", "pharmacy.sale_items.manage", "formulary.read"];

type SentRow = { itemId: string; batch: string; expiry: string; mrpPerPack: string; packs: string; ratePerPack: string; discountPct: string; packSize: string };
/** The server's judgement, as the planner would give it: a batch "BAD" is refused, everything else passes. */
function judge(body: unknown): unknown {
  const rows = (body as { rows: SentRow[] }).rows;
  const out = rows.map((r, i) => ({
    line: i + 1, brand: "", itemCode: "DOLO650", itemName: "Dolo 650 tablet", batch: r.batch, expiryDate: "2027-08-31",
    packs: Number(r.packs), packSize: Number(r.packSize), uom: "strip", newUom: false, near: false, mrpPaise: 3360, costPerBasePaise: 160,
    rack: "", reasons: r.batch === "BAD" ? ["expired 2020-01-31 — segregate it; expired stock is not received"] : [], freePacks: 0, ratePaise: 2400, discountBps: 0,
  }));
  const refusals = out.filter((r) => r.reasons.length > 0).length;
  return {
    fileHash: "abc", rows: out, grns: [{ challanNo: "OPENING/abc", near: false, lines: out.length, state: "new", grnNo: null }],
    refusals, units: 150, newUoms: 0, needsVendor: false, zeroCost: 0, racks: 0, authority: [],
  };
}
const ROUTES = {
  "GET /pharmacy/opening-stock/suppliers": { suppliers: [{ id: "v1", code: "MEDLINE", name: "Medline Distributors" }] },
  "GET /pharmacy/opening-stock/items": (_b: unknown, url: string) => ({ items: url.includes("dolo") ? [DOLO] : [] }),
  "POST /pharmacy/opening-stock/check": judge,
  "POST /pharmacy/opening-stock/capture": { captured: [{ grnId: "g1", grnNo: "GRN-0007", challanNo: "OPENING/abc", near: false, lines: 1 }], alreadyOnBooks: 0, uomsAdded: 0, vendorCreated: true, racksSet: 0, racksLeft: 0 },
};

beforeEach(() => { setToken("t"); window.localStorage.removeItem(DRAFT_KEY); });
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.removeItem(DRAFT_KEY); });

async function pickDolo(user: ReturnType<typeof userEvent.setup>, row = 0): Promise<void> {
  const brand = await screen.findByRole("combobox", { name: `Brand · row ${String(row + 1)}` });
  await user.type(brand, "dolo");
  const list = await screen.findByTestId(`se-brand-list-${String(row)}`);
  await within(list).findByText("Dolo 650 tablet");
  await user.keyboard("{Enter}");
}

describe("stock entry on screen (2026-09-29)", () => {
  it("the cost of a unit after the trade discount, and the margin against MRP, the server's way", () => {
    expect(rowEconomics({ ...blankRow(), rate: "28.00", discount: "10", packSize: "10", mrp: "40.00" })).toEqual({ cost: 252, marginPct: 37 });
    expect(rowEconomics({ ...blankRow(), rate: "24", discount: "", packSize: "15", mrp: "35.50" })).toEqual({ cost: 160, marginPct: 32.4 });
    expect(rowEconomics({ ...blankRow(), rate: "28", discount: "100", packSize: "10", mrp: "40" })).toBeNull();
  });

  it("picks the brand, fills what the master knows, walks the row on Enter, shows cost and margin, and adds a row at the end", async () => {
    mock(ROUTES, PERMS);
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await pickDolo(user);
    // The master's pack, MRP on file, rack and GST are on the row; the batch is next.
    expect(screen.getByRole("combobox", { name: "Brand · row 1" })).toHaveValue("Dolo 650 tablet");
    expect(screen.getByLabelText("Per pack · row 1")).toHaveValue("15");
    expect(screen.getByLabelText("MRP ₹/pack · row 1")).toHaveValue("33.60");
    expect(screen.getByLabelText("Rack · row 1")).toHaveValue("A1");
    expect(screen.getByTestId("se-row-0")).toHaveTextContent("650 mg · tablet · Sch. OTC");
    expect(within(screen.getByTestId("se-row-0")).getByText("5%")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Batch · row 1")).toHaveFocus());
    await user.type(screen.getByLabelText("Batch · row 1"), "DOBS4521{Enter}");
    expect(screen.getByLabelText("Expiry · row 1")).toHaveFocus();
    await user.type(screen.getByLabelText("Expiry · row 1"), "08/27{Enter}");
    await user.type(screen.getByLabelText("Packs · row 1"), "10");
    await user.type(screen.getByLabelText("Rate ₹/pack · row 1"), "24.00");
    expect(screen.getByTestId("se-cost-0")).toHaveTextContent("₹1.60/unit");
    expect(screen.getByTestId("se-cost-0")).toHaveTextContent("28.6% margin");
    await user.type(screen.getByLabelText("Disc % · row 1"), "10");
    expect(screen.getByTestId("se-cost-0")).toHaveTextContent("₹1.44/unit");
    // A new row is always waiting at the end.
    expect(screen.getByRole("combobox", { name: "Brand · row 2" })).toHaveValue("");
    // The sale price is the MRP, said on the screen; the capture is a GRN a second person posts.
    expect(screen.getByTestId("se-mrp-note")).toHaveTextContent("No sale price or sale discount is set here");
    expect(screen.getByTestId("se-two-person")).toHaveTextContent("a second person — the pharmacist — must check (QC) and post each GRN");
  });

  it("shows the SERVER's reasons under the row before capture, keeps capture off until fixed, then captures and points to the GRN worklist", async () => {
    const calls = mock(ROUTES, PERMS);
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await pickDolo(user);
    await user.type(screen.getByLabelText("Batch · row 1"), "BAD");
    await user.type(screen.getByLabelText("Expiry · row 1"), "01/20");
    await user.type(screen.getByLabelText("Packs · row 1"), "10");
    expect(await screen.findByTestId("se-reasons-0", {}, { timeout: 3000 })).toHaveTextContent("expired 2020-01-31");
    expect(screen.getByTestId("se-capture")).toBeDisabled();
    const check = calls.filter((c) => c.path === "/pharmacy/opening-stock/check").at(-1)!;
    expect((check.body as { rows: SentRow[] }).rows).toEqual([expect.objectContaining({ itemId: "it-dolo", batch: "BAD", expiry: "01/20", packs: "10", packSize: "15", mrpPerPack: "33.60", packType: "tablet_strip" })]);

    await user.clear(screen.getByLabelText("Batch · row 1"));
    await user.type(screen.getByLabelText("Batch · row 1"), "OK1");
    await waitFor(() => expect(screen.getByTestId("se-capture")).toBeEnabled(), { timeout: 3000 });
    expect(screen.queryByTestId("se-reasons-0")).toBeNull();
    await user.click(screen.getByTestId("se-capture"));

    const result = await screen.findByTestId("se-result");
    expect(result).toHaveTextContent("1 GRN captured.");
    expect(result).toHaveTextContent("GRN-0007");
    expect(result).toHaveTextContent("Now the pharmacist must log in, open each GRN, run QC and post it.");
    expect(within(result).getByTestId("se-worklist")).toHaveAttribute("href", "/pharmacy/office?view=stock&page=grn");
    const cap = calls.find((c) => c.path === "/pharmacy/opening-stock/capture")!;
    expect((cap.body as { rows: SentRow[] }).rows[0]).toMatchObject({ itemId: "it-dolo", batch: "OK1" });
    // Captured rows leave the grid and the draft.
    expect(screen.getByRole("combobox", { name: "Brand · row 1" })).toHaveValue("");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("a row with text but no picked brand is refused here, and nothing is sent for it", async () => {
    const calls = mock(ROUTES, PERMS);
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "zzz");
    await user.type(screen.getByLabelText("Batch · row 1"), "B1");
    expect(screen.getByTestId("se-reasons-0")).toHaveTextContent("Pick the brand from the list, or add it as a new drug.");
    expect(screen.getByTestId("se-capture")).toBeDisabled();
    await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
    expect(calls.some((c) => c.path === "/pharmacy/opening-stock/check")).toBe(false);
  });

  it("keeps the rows as a draft across a reload", async () => {
    mock(ROUTES, PERMS);
    const first = renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await pickDolo(user);
    await user.type(screen.getByLabelText("Batch · row 1"), "KEEP1");
    await waitFor(() => expect(window.localStorage.getItem(DRAFT_KEY)).toContain("KEEP1"));
    first.unmount();

    renderWithRouter(<StockEntryView />);
    expect(await screen.findByLabelText("Batch · row 1")).toHaveValue("KEEP1");
    expect(screen.getByRole("combobox", { name: "Brand · row 1" })).toHaveValue("Dolo 650 tablet");
    expect(screen.getByRole("combobox", { name: "Brand · row 2" })).toHaveValue("");
  });

  it("renders a blank sheet when the browser refuses storage", async () => {
    mock(ROUTES, PERMS);
    // Only the draft's key refuses — the sign-in token still reads, as in a browser that blocks this one write.
    const get0 = Storage.prototype.getItem;
    const set0 = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k: string) { if (k === DRAFT_KEY) throw new Error("denied"); return get0.call(this, k); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) { if (k === DRAFT_KEY) throw new Error("denied"); set0.call(this, k, v); });
    try {
      renderWithRouter(<StockEntryView />);
      const user = userEvent.setup();
      await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "x");
      expect(screen.getByRole("combobox", { name: "Brand · row 2" })).toBeInTheDocument();
    } finally {
      spy.mockRestore(); set.mockRestore();
    }
  });

  it("+ New drug: from the brand list, the generic from the formulary, its schedule as the default, one call, and the drug lands on the row", async () => {
    const calls = mock({
      ...ROUTES,
      "GET /formulary/medicines/search": { items: [{ id: "m-para", name: "Paracetamol 650 mg oral tablet", form: "tablet", strength: "650 mg", code: "D0230", routeClass: "systemic", salts: ["Paracetamol"], prefix: true, reviewed: true }] },
      "GET /pharmacy/opening-stock/medicines/m-para": { id: "m-para", name: "Paracetamol 650 mg oral tablet", form: "tablet", strength: "650 mg", schedule: "H" },
      "POST /pharmacy/opening-stock/new-drug": { itemId: "it-new", code: "ZOLO650", name: "Zolo 650 tablet", uom: "strip", packSize: 15, gstRateBps: 500 },
    }, PERMS);
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "Zolo 650");
    await user.click(await screen.findByTestId("se-brand-new-0"));
    const sheet = await screen.findByTestId("se-new-drug-sheet");
    expect(within(sheet).getByTestId("nd-brand")).toHaveValue("Zolo 650");
    expect(within(sheet).getByTestId("nd-save")).toBeDisabled();
    await user.type(within(sheet).getByTestId("nd-generic"), "para 650");
    await user.click(await within(sheet).findByText("Paracetamol 650 mg oral tablet"));
    await waitFor(() => expect(within(sheet).getByTestId("nd-schedule")).toHaveValue("H"));
    expect(within(sheet).getByTestId("nd-strength")).toHaveValue("650 mg");
    expect(within(sheet).getByTestId("nd-hsn")).toHaveValue("3004");
    expect(within(sheet).getByTestId("nd-gst")).toHaveValue("500");
    await user.clear(within(sheet).getByTestId("nd-pack-size"));
    await user.type(within(sheet).getByTestId("nd-pack-size"), "15");
    await user.type(within(sheet).getByTestId("nd-mrp"), "35.50");
    await user.click(within(sheet).getByTestId("nd-save"));

    await waitFor(() => expect(screen.queryByTestId("se-new-drug-sheet")).toBeNull());
    expect(calls.find((c) => c.path === "/pharmacy/opening-stock/new-drug")?.body).toEqual({
      brandName: "Zolo 650", strength: "650 mg", medicineId: "m-para", form: "tablet", packType: "tablet_strip", packSize: 15,
      hsnCode: "3004", gstRateBps: 500, schedule: "H", mrpPerPackPaise: 3550, storage: "ambient",
    });
    expect(screen.getByRole("combobox", { name: "Brand · row 1" })).toHaveValue("Zolo 650 tablet");
    expect(screen.getByLabelText("Per pack · row 1")).toHaveValue("15");
    expect(screen.getByLabelText("MRP ₹/pack · row 1")).toHaveValue("35.50");
  });

  it("without the item master's permission there is no + New drug, only 'ask the materials head'", async () => {
    mock(ROUTES, ["materials.grn.capture"]);
    renderWithRouter(<StockEntryView />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("combobox", { name: "Brand · row 1" }), "zolo");
    expect(await screen.findByTestId("se-brand-new-0")).toHaveTextContent("ask the materials head");
    expect(screen.queryByTestId("se-new-drug")).toBeNull();
    fireEvent.mouseDown(screen.getByTestId("se-brand-new-0"));
    expect(screen.queryByTestId("se-new-drug-sheet")).toBeNull();
  });
});
