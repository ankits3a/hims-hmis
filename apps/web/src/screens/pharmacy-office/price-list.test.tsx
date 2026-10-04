import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PriceListImport } from "./price-list";

type Reply = { status: number; body: unknown };
const posted: { path: string; body: unknown }[] = [];
function mockRoutes(routes: Record<string, Reply>): void {
  posted.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    if (init?.body !== undefined) posted.push({ path, body: JSON.parse(String(init.body)) });
    const r = routes[`${init?.method ?? "GET"} ${path}`];
    return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 404, headers: { "Content-Type": "application/json" } });
  }));
}

const cand = (id: string, name: string, schedule: string | null = null, score = 90) => ({ medicineId: id, name, form: "tablet", strength: "400 mg", salts: ["Ibuprofen"], schedule, score });
const MATCHED = { rows: [
  { line: 1, brand: "Brufen 400", manufacturer: "Abbott", composition: "Ibuprofen 400 mg", pack: "10x15", best: cand("m-bru", "Brufen 400", "H"), alternatives: [cand("m-ibu", "Ibugesic 400", null, 60)], existing: null, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: null },
  { line: 2, brand: "Crocin 500", manufacturer: "GSK", composition: "Paracetamol 500 mg", pack: "10x15", best: cand("m-cro", "Crocin 500"), alternatives: [], existing: { itemId: "i-1", code: "CROC500", name: "Crocin 500 tablet" }, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 3000 },
] };

describe("import a vendor's price list (owner 2026-10-04)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("paste the vendor's rows, match them, fill the MRP, create the ticked one, and read each row's result", async () => {
    mockRoutes({
      "POST /pharmacy/opening-stock/price-list/match": { status: 200, body: MATCHED },
      "POST /pharmacy/opening-stock/price-list/import": { status: 200, body: { results: [{ line: 1, ok: true, itemId: "i-9", code: "BRUFEN400", name: "Brufen 400 tablet" }] } },
    });
    const user = userEvent.setup();
    renderWithProviders(<PriceListImport />);
    const paste = screen.getByTestId("price-paste");
    await user.click(paste);
    await user.paste("Manufacturer\tBrand Name\tComposition\tPacking\nAbbott\tBrufen 400\tIbuprofen 400 mg\t10x15\nGSK\tCrocin 500\tParacetamol 500 mg\t10x15");
    await user.click(screen.getByTestId("price-paste-read"));
    expect(await screen.findByTestId("price-columns")).toHaveTextContent("2 rows");
    expect(screen.getByTestId("price-col-brand")).toHaveValue("1");
    await user.click(screen.getByTestId("price-match"));
    await waitFor(() => expect(posted.find((p) => p.path.endsWith("/match"))?.body).toEqual({ rows: [
      { brand: "Brufen 400", manufacturer: "Abbott", composition: "Ibuprofen 400 mg", pack: "10x15" },
      { brand: "Crocin 500", manufacturer: "GSK", composition: "Paracetamol 500 mg", pack: "10x15" },
    ] }));
    expect(await screen.findByTestId("price-summary")).toHaveTextContent("2 rows · 2 matched in the catalogue · 1 already in your item master · 0 ticked to create");
    expect(screen.getByTestId("price-existing-2")).toHaveTextContent("Already an item (CROC500)");
    expect(screen.queryByTestId("price-check-1")).toBeNull(); // a confident match (score 90) is not flagged
    await user.selectOptions(screen.getByTestId("price-pick-1"), "m-ibu");
    expect(screen.getByTestId("price-check-1")).toHaveTextContent("Check this match"); // a weak one is
    await user.selectOptions(screen.getByTestId("price-pick-1"), "m-bru");
    // Brufen has no MRP in the list: tick it, and the create button waits for the MRP.
    await user.click(within(screen.getByTestId("price-row-1")).getByRole("checkbox", { name: "Create Brufen 400" }));
    expect(screen.getByTestId("price-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("price-create")).toBeDisabled();
    await user.type(screen.getByTestId("price-mrp-1"), "42.10");
    await user.click(screen.getByTestId("price-create"));
    await waitFor(() => expect(posted.find((p) => p.path.endsWith("/import"))?.body).toEqual({ rows: [
      { line: 1, medicineId: "m-bru", brand: "Brufen 400", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210, storage: "ambient" },
    ] }));
    expect(await screen.findByTestId("price-result-1")).toHaveTextContent("Created · BRUFEN400");
    expect(screen.getByTestId("price-done")).toHaveTextContent("1 created, 0 not created");
  });
});
