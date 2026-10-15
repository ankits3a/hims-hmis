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
  { line: 1, brand: "Brufen 400", manufacturer: "Abbott", composition: "Ibuprofen 400 mg", pack: "10x15", best: cand("m-bru", "Brufen 400", "H"), alternatives: [cand("m-ibu", "Ibugesic 400", null, 60)], existing: null, twin: null, variant: null, outer: 10, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: null },
  { line: 2, brand: "Crocin 500", manufacturer: "GSK", composition: "Paracetamol 500 mg", pack: "10x15", best: cand("m-cro", "Crocin 500"), alternatives: [], existing: { itemId: "i-1", code: "CROC500", name: "Crocin 500 tablet" }, twin: null, variant: null, outer: 10, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 3000 },
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
    expect(await screen.findByTestId("price-summary")).toHaveTextContent("2 rows · 2 matched in the catalogue · 0 to add as new brands · 1 already in your item master · 0 ticked to create");
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
    // A packing of 10*15: what the MRP column prices is asked once, and Create waits for the answer.
    expect(screen.getByTestId("price-basis-needed")).toBeInTheDocument();
    expect(screen.getByTestId("price-create")).toBeDisabled();
    await user.click(screen.getByTestId("price-basis-pack"));
    await user.type(screen.getByTestId("price-mrp-1"), "42.10");
    await user.click(screen.getByTestId("price-create"));
    await waitFor(() => expect(posted.find((p) => p.path.endsWith("/import"))?.body).toEqual({ rows: [
      { line: 1, medicineId: "m-bru", twin: false, variant: null, brand: "Brufen 400", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210, storage: "ambient" },
    ] }));
    expect(await screen.findByTestId("price-result-1")).toHaveTextContent("Created · BRUFEN400");
    expect(screen.getByTestId("price-done")).toHaveTextContent("1 created, 0 not created");
  });

  /* Owner 2026-10-04 — the directions on the screen, a sample to download, and a check of every column. */
  it("shows the directions, downloads a sample CSV, skips a title above the headings, and says what each missing column means", async () => {
    mockRoutes({});
    const user = userEvent.setup();
    const made: Blob[] = [];
    const names: string[] = [];
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return "blob:x"; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    renderWithProviders(<PriceListImport />);
    expect(screen.getByTestId("price-howto")).toHaveTextContent("How to import a vendor's drug list");
    expect(screen.getByTestId("price-howto")).toHaveTextContent("Only the brand name is needed");
    await user.click(screen.getByTestId("price-sample"));
    URL.createObjectURL = real.create; URL.revokeObjectURL = real.revoke; click.mockRestore();
    expect(names).toEqual(["price-list-sample.csv"]);
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(made[0]!); });
    expect(text).toContain("Manufacturer,Brand Name,Composition,Packing,HSN,GST %,MRP,Rate");

    await user.click(screen.getByTestId("price-paste"));
    await user.paste("Shree Ram Pharma\nBrand Name\tPacking\nDolo 650\t15 Tab");
    await user.click(screen.getByTestId("price-paste-read"));
    const check = await screen.findByTestId("price-column-check");
    expect(check).toHaveTextContent("1 line above the headings was skipped");
    expect(screen.getByTestId("price-check-col-brand")).toHaveTextContent("✓ Brand name (needed) ← “Brand Name”");
    expect(screen.getByTestId("price-check-col-mrp")).toHaveTextContent("You type the MRP on each row before creating.");
    expect(screen.getByTestId("price-match")).toBeEnabled();
  });

  it("a list with no brand column cannot be matched, and says why", async () => {
    mockRoutes({});
    const user = userEvent.setup();
    renderWithProviders(<PriceListImport />);
    await user.click(screen.getByTestId("price-paste"));
    await user.paste("Item Code\tQty\nA1\t10");
    await user.click(screen.getByTestId("price-paste-read"));
    expect(await screen.findByTestId("price-check-col-brand")).toHaveTextContent("Cannot import — every row needs a brand.");
    expect(screen.getByTestId("price-match")).toBeDisabled();
  });

  /* Owner 2026-10-04 — the Aptus Drugs list: brands the catalogue lacks, an MRP for the whole packing, a drug in two kinds. */
  it("a brand the catalogue lacks is added from its composition; an MRP for the whole packing is divided; two kinds make the person choose", async () => {
    const tw = (id: string, name: string, newName: string, form: string) => ({ medicineId: id, name, form, schedule: "H", salts: ["x"], newName });
    mockRoutes({
      "POST /pharmacy/opening-stock/price-list/match": { status: 200, body: { rows: [
        { line: 1, brand: "SAZOTEL-40", manufacturer: "Hauz", composition: "TELMISARTAN 40MG", pack: "10*15", best: null, alternatives: [], existing: null,
          twin: { ...tw("m-telmi", "Telmisartan 40 mg oral tablet", "Sazotel-40 (telmisartan 40 mg oral tablet)", "Oral tablet"), ambiguous: false, others: [] },
          variant: null, outer: 10, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 106_000 },
        { line: 2, brand: "EMOPRED 40", manufacturer: "Hauz", composition: "METHYLPREDNISOLONE 40 MG", pack: "1'S", best: null, alternatives: [], existing: null,
          twin: { ...tw("m-acet", "Methylprednisolone acetate 40 mg/mL suspension for injection", "Emopred 40 (methylprednisolone acetate 40 mg/mL suspension for injection)", "Suspension for injection"),
            ambiguous: true, others: [tw("m-succ", "Solu-medrol (methylprednisolone sodium succinate) 40 mg/1 vial powder", "Emopred 40 (methylprednisolone sodium succinate) 40 mg/1 vial powder", "Powder for solution for injection")] },
          variant: null, outer: 1, packType: "vial", packSize: 1, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4800 },
      ] } },
      "POST /pharmacy/opening-stock/price-list/import": { status: 200, body: { results: [{ line: 1, ok: true, itemId: "i-1", code: "SAZOTEL40", name: "Sazotel-40" }, { line: 2, ok: true, itemId: "i-2", code: "EMOPRED40", name: "Emopred 40" }] } },
    });
    const user = userEvent.setup();
    renderWithProviders(<PriceListImport />);
    await user.click(screen.getByTestId("price-paste"));
    await user.paste("Brand\tComposition\tPacking\tMRP\nSAZOTEL-40\tTELMISARTAN 40MG\t10*15\t1060\nEMOPRED 40\tMETHYLPREDNISOLONE 40 MG\t1'S\t48");
    await user.click(screen.getByTestId("price-paste-read"));
    await user.click(await screen.findByTestId("price-match"));
    expect(await screen.findByTestId("price-guide-twin")).toHaveTextContent("2 brands are not in the drug catalogue");
    expect(screen.getByTestId("price-guide-choose")).toHaveTextContent("1 row matches the drug in more than one kind");
    expect(screen.getByTestId("price-new-1")).toHaveTextContent("New to the catalogue");
    expect(screen.getByTestId("price-pick-1")).toHaveValue("twin:m-telmi");
    // Two kinds of methylprednisolone 40 (a depot suspension, a powder for IV): not picked for the person.
    expect(screen.getByTestId("price-pick-2")).toHaveValue("");
    expect(screen.getByTestId("price-choose-2")).toHaveTextContent("2 different kinds");
    expect(screen.getByTestId("price-outer-1")).toHaveTextContent("10 of these in the packing");
    // ₹1,060 for a strip of 15 telmisartan is ₹70 a tablet: the screen suggests the whole packing, with the sums.
    expect(screen.getByTestId("price-basis-example")).toHaveTextContent("Per strip of 15 tablets that is ₹1060.00 if the MRP is for one pack, or ₹106.00 if it is for the whole packing of 10");
    expect(screen.getByTestId("price-basis")).toHaveTextContent("the whole packing as written (10*15 = 10 strips) — suggested from the prices");
    await user.click(screen.getByTestId("price-basis-packing"));
    expect(screen.getByTestId("price-mrp-1")).toHaveValue("106.00");
    expect(screen.getByTestId("price-mrp-2")).toHaveValue("48.00"); // a single vial is its own packing
    await user.selectOptions(screen.getByTestId("price-pick-2"), "twin:m-succ");
    await user.click(within(screen.getByTestId("price-row-2")).getByRole("checkbox", { name: "Create EMOPRED 40" }));
    await user.click(screen.getByTestId("price-create"));
    await waitFor(() => expect(posted.find((p) => p.path.endsWith("/import"))?.body).toEqual({ rows: [
      { line: 1, medicineId: "m-telmi", twin: true, variant: null, brand: "SAZOTEL-40", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 10_600, storage: "ambient" },
      { line: 2, medicineId: "m-succ", twin: true, variant: null, brand: "EMOPRED 40", packType: "vial", packSize: 1, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4800, storage: "ambient" },
    ] }));
  });

  /* Owner 2026-10-04 — step 2: the list's rate column becomes the vendor's contract, per pack and before GST. */
  it("keeps the vendor's quoted rates — divided like the MRP, GST taken out — for new items and items already stocked", async () => {
    const tw = { medicineId: "m-telmi", name: "Telmisartan 40 mg oral tablet", form: "Oral tablet", schedule: "H", salts: ["x"], newName: "Sazotel-40 (telmisartan 40 mg oral tablet)" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
      if (init?.body !== undefined) posted.push({ path, body: JSON.parse(String(init.body)) });
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: ["materials.items.manage", "materials.vendors.manage", "materials.po.raise"], scoped: { department: {}, floor: {} } } });
      if (path === "/materials/purchase-vendors") return json({ vendors: [{ id: "v-aptus", code: "APTUS", name: "Aptus Drugs" }] });
      if (path.endsWith("/match")) return json({ rows: [
        { line: 1, brand: "SAZOTEL-40", manufacturer: "Hauz", composition: "TELMISARTAN 40MG", pack: "10*15", best: null, alternatives: [], existing: null,
          twin: { ...tw, ambiguous: false, others: [] }, variant: null, outer: 10, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 106_000 },
        { line: 2, brand: "SEYTRI 1GM", manufacturer: "Hauz", composition: "CEFTRIAXONE 1000MG", pack: "1'S", best: null, alternatives: [], existing: { itemId: "i-sey", code: "SEYTRI1G", name: "Seytri 1 g vial" },
          twin: null, variant: null, outer: 1, packType: "vial", packSize: 1, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 6_700 },
      ] });
      if (path.endsWith("/import")) return json({ results: [{ line: 1, ok: true, itemId: "i-saz", code: "SAZOTEL40", name: "Sazotel-40" }] });
      if (path === "/materials/vendors/v-aptus/rates") return json({ results: [{ itemId: "i-saz", ok: true, changed: true }, { itemId: "i-sey", ok: true, changed: true }] });
      return new Response("{}", { status: 404 });
    }));
    posted.length = 0;
    const user = userEvent.setup();
    renderWithProviders(<PriceListImport />);
    await user.click(screen.getByTestId("price-paste"));
    await user.paste("Brand\tComposition\tPacking\tMRP\tRate incl GST\nSAZOTEL-40\tTELMISARTAN 40MG\t10*15\t1060\t310\nSEYTRI 1GM\tCEFTRIAXONE 1000MG\t1'S\t67\t26");
    await user.click(screen.getByTestId("price-paste-read"));
    expect(await screen.findByTestId("price-check-col-rate")).toHaveTextContent("Rate incl GST");
    await user.click(screen.getByTestId("price-match"));
    await user.selectOptions(await screen.findByTestId("price-vendor"), "v-aptus");
    expect(screen.getByTestId("price-incl-gst")).toBeChecked(); // the heading said so
    await user.click(screen.getByTestId("price-basis-packing"));
    // ₹310 for ten strips including 5% GST: ₹31 a strip, ₹29.52 before GST. One vial at ₹26: ₹24.76.
    expect(screen.getByTestId("price-rate-1")).toHaveValue("29.52");
    expect(screen.getByTestId("price-rate-2")).toHaveValue("24.76");
    await user.click(screen.getByTestId("price-create"));
    await waitFor(() => expect(posted.find((p) => p.path === "/materials/vendors/v-aptus/rates")?.body).toEqual({
      source: "Price list import",
      rates: [
        { itemId: "i-saz", packSize: 15, ratePaise: 2_952, gstRateBps: 500, mrpPaise: 10_600 },
        { itemId: "i-sey", packSize: 1, ratePaise: 2_476, gstRateBps: 500, mrpPaise: 6_700 },
      ],
    }));
    expect(await screen.findByTestId("price-rates-saved")).toHaveTextContent("2 rates kept as Aptus Drugs's contract.");
  });
});
