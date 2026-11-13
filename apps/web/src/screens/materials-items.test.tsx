import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaterialsItems } from "./materials-items";

/**
 * PLAN 14 T9 — the item master screen.
 *
 * T9's acceptance: **exercise ONE refusal path and assert the LOCALE STRING, not the code.** Here it
 * is `drug_needs_medicine` — DD3's rule, refused by the server and rendered as the sentence the
 * server wrote. The screen does NOT re-derive the rule: a client copy of the error catalogue would
 * be §2.54's mechanism pointed at a screen.
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status, headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function bodiesOf(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => {
      const raw = String(input);
      return (init?.method ?? "GET") === method && raw.split("?")[0]!.endsWith(path);
    })
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ITEMS = [
  {
    id: "it-1", code: "CROC500", name: "Crocin 500mg tablet", class: "drug",
    formularyMedicineId: "med-1", hsnCode: "30049099", gstRateBps: 1200,
    baseUom: "tablet", batchTracked: true, serialTracked: false,
    storageClass: "ambient", shelfLifeDays: 1095, abcClass: null, vedClass: null, active: true,
  },
];

describe("MaterialsItems", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists the item master", async () => {
    mockRoutes({ "GET /api/materials/items": { status: 200, body: { items: ITEMS } } });
    renderWithProviders(<MaterialsItems />);
    expect(await screen.findByText("CROC500")).toBeInTheDocument();
    expect(screen.getByText("Crocin 500mg tablet")).toBeInTheDocument();
  });

  /**
   * **THE REFUSAL PATH — and see `materials-vendors.test.tsx` for why this now asserts a LOCALE
   * string rather than the server's sentence (close review m6).**
   *
   * A `drug` with no formulary medicine: the server answers 409 with `drug_needs_medicine`. The
   * screen renders `materialsErrors.drug_needs_medicine`, which is translated; the server's own
   * sentence — English, always — never reaches the DOM.
   */
  it("renders the LOCALE string for a drug with no medicine — not the code, not the server's sentence", async () => {
    mockRoutes({
      "GET /api/materials/items": { status: 200, body: { items: [] } },
      "POST /api/materials/items": {
        status: 409,
        body: {
          statusCode: 409, code: "drug_needs_medicine",
          message: "a drug-class item must name the formulary medicine it stocks — composition, "
            + "salts and the schedule flag live there and are never copied onto the item (DD3)",
        },
      },
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();

    // B5 — registering is a sheet over the list, opened by the page's one "new" act.
    await user.click(await screen.findByRole("button", { name: "Register an item" }));
    await user.type(await screen.findByLabelText(/^Code$/), "NOMED");
    await user.type(screen.getByLabelText(/^Name$/), "a drug with no medicine");
    await user.selectOptions(screen.getByLabelText(/^Class$/), "drug");
    await user.type(screen.getByLabelText(/^Base unit$/), "tablet");
    await user.click(screen.getByRole("button", { name: "Register" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A drug-class item must name the formulary medicine it stocks");
    // NOT the bare code…
    expect(alert).not.toHaveTextContent("drug_needs_medicine");
    /**
     * …and not the server's sentence either. The two texts overlap on the phrase "must name the
     * formulary medicine", which is why the ORIGINAL assertion survived the fix unchanged and
     * proved nothing. The tail is what tells them apart, so the tail is what is asserted.
     */
    expect(alert).not.toHaveTextContent(/salts and the schedule flag live there/);
  });

  /**
   * DD3 made visible: the medicine field EXISTS only for a drug. The screen declines to construct
   * the refusable state; the server still refuses it independently (A1), which is why the leg above
   * exists as well as this one.
   */
  it("shows the formulary-medicine field only for a drug-class item", async () => {
    mockRoutes({ "GET /api/materials/items": { status: 200, body: { items: [] } } });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Register an item" }));
    expect(screen.queryByLabelText(/^Formulary medicine$/)).not.toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText(/^Class$/), "drug");
    expect(screen.getByLabelText(/^Formulary medicine$/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^Class$/), "consumable");
    expect(screen.queryByLabelText(/^Formulary medicine$/)).not.toBeInTheDocument();
  });

  /**
   * DD7 — the pack is sent as a MULTIPLIER of the base unit, and `qtyBase` is never computed here.
   * A screen that multiplied would be a second place a multiplier lives (A2).
   */
  it("sends the pack as a multiplier of the base unit, and computes no quantity itself", async () => {
    mockRoutes({
      "GET /api/materials/items": { status: 200, body: { items: [] } },
      "POST /api/materials/items": { status: 201, body: { itemId: "it-new" } },
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Register an item" }));
    await user.type(await screen.findByLabelText(/^Code$/), "GLV-M");
    await user.type(screen.getByLabelText(/^Name$/), "Nitrile glove M");
    await user.type(screen.getByLabelText(/^Base unit$/), "each");
    await user.type(screen.getByLabelText(/^Pack unit$/), "box");
    await user.type(screen.getByLabelText(/^Base units per pack$/), "100");
    await user.click(screen.getByRole("button", { name: "Register" }));

    await waitFor(() => { expect(bodiesOf("POST", "/materials/items")).toHaveLength(1); });
    const sent = bodiesOf("POST", "/materials/items")[0] as {
      baseUom: string; batchTracked: boolean; uoms?: { uom: string; toBaseMultiplier: number }[];
    };
    expect(sent.baseUom).toBe("each");
    expect(sent.uoms).toEqual([{ uom: "box", toBaseMultiplier: 100 }]);
    // A `consumable` is not batch-tracked; a drug is. The class decides, per DD3/DD8 rule 3.
    expect(sent.batchTracked).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent("GLV-M registered");
    // The sheet closes on a registration; the list is what is left.
    expect(screen.queryByTestId("item-new-sheet")).toBeNull();
  });

  /** B5 — no form above the list: the page opens on the list, and N opens the register sheet. */
  it("opens on the one list with no form above it; N opens the register sheet", async () => {
    mockRoutes({ "GET /api/materials/items": { status: 200, body: { items: ITEMS } } });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    expect(await screen.findByText("CROC500")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Code$/)).not.toBeInTheDocument();
    await user.keyboard("n");
    expect(await screen.findByTestId("item-new-sheet")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Code$/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("item-new-sheet")).toBeNull();
  });

  /**
   * GAP CLOSURE A2 — the edit panel. It patches the item's own fields in one PATCH, with an empty
   * manufacturer sent as null. The drug's schedule is the formulary's: without `formulary.manage` it is
   * shown and cannot be changed, and no formulary PATCH is sent.
   */
  it("edits HSN, storage, manufacturer, lead time and the LASA / high-alert flags; the schedule is read-only without formulary.manage", async () => {
    mockRoutes({
      "GET /api/materials/items": { status: 200, body: { items: ITEMS } },
      "GET /api/materials/items/it-1": {
        status: 200,
        body: { item: { ...ITEMS[0], uoms: [], barcodes: [], manufacturer: null, leadTimeDays: null, lasa: false, highAlert: false, medicineName: "Crocin 500", scheduleFlag: "OTC" } },
      },
      "PATCH /api/materials/items/it-1": { status: 200, body: { ok: true } },
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit CROC500" }));
    const hsn = await screen.findByLabelText("HSN code");
    await waitFor(() => { expect(hsn).toHaveValue("30049099"); });
    expect(screen.getByLabelText("Schedule of Crocin 500")).toBeDisabled();
    expect(screen.getByText(/only someone who manages the formulary can change it/)).toBeInTheDocument();

    await user.clear(hsn);
    await user.type(hsn, "30049011");
    await user.selectOptions(screen.getByLabelText("Storage"), "cold_2_8");
    await user.type(screen.getByLabelText("Manufacturer"), "Cipla Ltd");
    await user.type(screen.getByLabelText("Marketed by"), "Cipla Health Ltd");
    await user.type(screen.getByLabelText("Manufacturing licence no."), "M/563/2010");
    await user.type(screen.getByLabelText("Pharmacopoeia"), "IP");
    await user.type(screen.getByLabelText("Store below (°C)"), "25");
    await user.type(screen.getByLabelText("LASA warning (the names it is confused with)"), "aciCLOVIR vs ganCICLOVIR");
    await user.type(screen.getByLabelText("Supplier lead time (days)"), "5");
    await user.click(screen.getByLabelText("Look-alike / sound-alike (LASA)"));
    await user.click(screen.getByLabelText("High-alert medicine"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("CROC500 saved.")).toBeInTheDocument();
    expect(bodiesOf("PATCH", "/materials/items/it-1")).toEqual([{
      hsnCode: "30049011", storageClass: "cold_2_8", shelfLifeDays: 1095, manufacturer: "Cipla Ltd", marketedBy: "Cipla Health Ltd",
      mfgLicenceNo: "M/563/2010", pharmacopoeia: "IP", storageMaxC: 25, lasaNote: "aciCLOVIR vs ganCICLOVIR", leadTimeDays: 5, lasa: true, highAlert: true,
    }]);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/formulary/medicines/"))).toBe(false);
  });

  /**
   * STOCK ENTRY (2026-09-29) — the edit panel is opened from a stock-entry row to fix a drug's GST or add a pack.
   * The slab goes through the sale-item route that moves the bill's GST category with it (never a bare item PATCH),
   * and a pack is a NEW unit posted to the item's uoms.
   */
  it("sets a drug's GST slab through the sale-item route and adds a pack size as a new unit", async () => {
    mockRoutes({
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: ["materials.items.manage", "pharmacy.sale_items.manage"], scoped: { department: {}, floor: {} } } } },
      "GET /api/materials/items": { status: 200, body: { items: ITEMS } },
      "GET /api/materials/items/it-1": {
        status: 200,
        body: { item: { ...ITEMS[0], uoms: [{ id: "u-1", itemId: "it-1", uom: "tablet", toBaseMultiplier: 1 }, { id: "u-2", itemId: "it-1", uom: "strip", toBaseMultiplier: 10 }], barcodes: [], manufacturer: null, leadTimeDays: null, lasa: false, highAlert: false, medicineName: "Crocin 500", scheduleFlag: "OTC" } },
      },
      "PATCH /api/materials/items/it-1": { status: 200, body: { ok: true } },
      "PUT /api/pharmacy/sale-items/it-1/gst-slab": { status: 200, body: { categoryChanged: true } },
      "POST /api/materials/items/it-1/uoms": { status: 200, body: { itemUomId: "u-3" } },
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit CROC500" }));
    const gst = await screen.findByTestId("item-edit-gst");
    await waitFor(() => { expect(gst).toHaveValue("1200"); });
    expect(screen.getByTestId("item-edit-packs")).toHaveTextContent("tablet · strip × 10 tablet");
    await user.selectOptions(gst, "500");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("CROC500 saved.")).toBeInTheDocument();
    expect(bodiesOf("PUT", "/pharmacy/sale-items/it-1/gst-slab")).toEqual([{ rateBps: 500 }]);
    expect(bodiesOf("PATCH", "/materials/items/it-1")[0]).not.toHaveProperty("gstRateBps");

    await user.type(screen.getByLabelText("New pack name"), "strip15");
    await user.type(screen.getByLabelText("tablet in the pack"), "15");
    await user.click(screen.getByRole("button", { name: "Add pack size" }));
    expect(await screen.findByText("Pack strip15 of 15 added.")).toBeInTheDocument();
    expect(bodiesOf("POST", "/materials/items/it-1/uoms")).toEqual([{ uom: "strip15", toBaseMultiplier: 15, isPurchaseUom: true, isIssueUom: true }]);
  });

  /** #1047 — the loader's `strip10` was really a strip of 15: the pack is CORRECTED in place; a pack in use is refused, in words. */
  it("corrects a pack in place, and says so in words when the pack is in use", async () => {
    let refuse = false;
    mockRoutes({
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: ["materials.items.manage"], scoped: { department: {}, floor: {} } } } },
      "GET /api/materials/items": { status: 200, body: { items: ITEMS } },
      "GET /api/materials/items/it-1": {
        status: 200,
        body: { item: { ...ITEMS[0], uoms: [{ id: "u-1", itemId: "it-1", uom: "tablet", toBaseMultiplier: 1 }, { id: "u-2", itemId: "it-1", uom: "strip10", toBaseMultiplier: 10 }], barcodes: [], manufacturer: null, leadTimeDays: null, lasa: false, highAlert: false, medicineName: "Crocin 500", scheduleFlag: "OTC" } },
      },
      "POST /api/materials/items/it-1/uoms/replace": () => (refuse
        ? { status: 409, body: { statusCode: 409, code: "pack_in_use", message: "strip10 is in use (batch B1)" } }
        : { status: 201, body: { itemUomId: "u-2", repointed: [] } }),
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit CROC500" }));
    await user.click(await screen.findByTestId("item-edit-correct-strip10"));
    const name = screen.getByLabelText("Correct pack name");
    await user.clear(name);
    await user.type(name, "strip15");
    const size = screen.getByLabelText("tablet in the correct pack");
    await user.clear(size);
    await user.type(size, "15");
    await user.click(screen.getByTestId("item-edit-correct-save"));
    expect(await screen.findByText("strip10 is now strip15 of 15.")).toBeInTheDocument();
    expect(bodiesOf("POST", "/materials/items/it-1/uoms/replace")).toEqual([{ fromUom: "strip10", uom: "strip15", toBaseMultiplier: 15 }]);

    refuse = true;
    await user.click(await screen.findByTestId("item-edit-correct-strip10"));
    await user.click(screen.getByTestId("item-edit-correct-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This pack is in use");
  });

  const EDIT_ROUTES = (replace: Handler): Record<string, Handler> => ({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: ["materials.items.manage", "materials.stock.read"], scoped: { department: {}, floor: {} } } } },
    "GET /api/materials/items": { status: 200, body: { items: ITEMS } },
    "GET /api/materials/items/it-1": {
      status: 200,
      body: { item: { ...ITEMS[0], uoms: [{ id: "u-1", itemId: "it-1", uom: "tablet", toBaseMultiplier: 1 }, { id: "u-2", itemId: "it-1", uom: "strip10", toBaseMultiplier: 10 }], barcodes: [], manufacturer: null, leadTimeDays: null, lasa: false, highAlert: false, medicineName: "Crocin 500", scheduleFlag: "OTC" } },
    },
    "POST /api/materials/items/it-1/uoms/replace": replace,
  });

  it("walk 2026-11-13: a pack in use names what holds it, beside the button; both pack forms have a heading and visible labels", async () => {
    mockRoutes(EDIT_ROUTES({
      status: 409, body: { statusCode: 409, code: "pack_in_use", message: "strip10 is in use", detail: { uom: "strip10", batches: ["B1"], grns: ["GRN2611130001"], purchaseOrders: [] } },
    }));
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit CROC500" }));
    // The sheet names the item once, and starts below the environment banner.
    expect(await screen.findAllByText(/CROC500 · Crocin 500mg tablet/)).toHaveLength(1);
    expect(screen.getByTestId("item-edit-sheet-backdrop").style.top).toBe("var(--env-banner-h, 0px)");
    await user.click(await screen.findByTestId("item-edit-correct-strip10"));
    const form = screen.getByTestId("item-edit-correct-form");
    expect(within(form).getByRole("heading", { name: "Correct strip10" })).toBeInTheDocument();
    expect(within(form).getByText("Correct pack name").tagName).toBe("LABEL");
    const add = screen.getByTestId("item-edit-add-pack");
    expect(within(add).getByRole("heading", { name: "Add a pack size" })).toBeInTheDocument();
    expect(within(add).getByText("New pack name").tagName).toBe("LABEL");

    await user.click(screen.getByTestId("item-edit-correct-save"));
    const why = await within(form).findByRole("alert");
    expect(why).toHaveTextContent("This pack is in use");
    expect(why).toHaveTextContent("batch B1");
    expect(why).toHaveTextContent("GRN GRN2611130001");
  });

  it("walk 2026-11-13: a drug's formulary medicine is picked by name, as + New drug picks it — never typed as an id", async () => {
    mockRoutes({
      "GET /api/materials/items": { status: 200, body: { items: [] } },
      "GET /api/formulary/medicines/search": { status: 200, body: { items: [{ id: "med-para", name: "Paracetamol 650 mg oral tablet", form: "tablet", strength: "650 mg", code: "D0230", routeClass: "systemic", salts: ["Paracetamol"], prefix: true, reviewed: true }] } },
      "POST /api/materials/items": { status: 201, body: { itemId: "it-new" } },
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Register an item" }));
    await user.type(await screen.findByLabelText(/^Code$/), "DOLO650");
    await user.type(screen.getByLabelText(/^Name$/), "Dolo 650 tablet");
    await user.selectOptions(screen.getByLabelText(/^Class$/), "drug");
    await user.type(screen.getByLabelText(/^Base unit$/), "tablet");
    await user.type(screen.getByLabelText(/^Formulary medicine$/), "para 650");
    await user.click(await screen.findByText("Paracetamol 650 mg oral tablet"));
    expect(screen.getByTestId("item-medicine-picked")).toHaveTextContent("Paracetamol 650 mg oral tablet");
    await user.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => { expect(bodiesOf("POST", "/materials/items")).toHaveLength(1); });
    expect(bodiesOf("POST", "/materials/items")[0]).toMatchObject({ class: "drug", formularyMedicineId: "med-para" });
  });

  it("walk 2026-11-13: Retire asks first and says how much stock the item still holds; nothing changes until it is confirmed", async () => {
    mockRoutes({
      ...EDIT_ROUTES({ status: 404, body: {} }),
      "GET /api/materials/stock/balances": { status: 200, body: { balances: [
        { itemId: "it-1", resourceId: "s1", batchId: "b1", qtyOnHand: 80, qtyReserved: 0, qtyFrozen: 0 },
        { itemId: "it-1", resourceId: "s2", batchId: "b2", qtyOnHand: 40, qtyReserved: 0, qtyFrozen: 0 },
      ] } },
      "PATCH /api/materials/items/it-1": { status: 200, body: { ok: true } },
    });
    renderWithProviders(<MaterialsItems />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retire CROC500" }));
    const ask = await screen.findByTestId("item-retire-confirm");
    expect(await within(ask).findByText(/120 tablets still on hand/)).toBeInTheDocument();
    expect(bodiesOf("PATCH", "/materials/items/it-1")).toHaveLength(0);
    await user.click(within(ask).getByRole("button", { name: "Retire it" }));
    await waitFor(() => { expect(bodiesOf("PATCH", "/materials/items/it-1")).toEqual([{ active: false }]); });
  });

  it("re-walk 2026-11-13: the stock on hand is counted in words — one tablet, a unit with no plural kept as it is", async () => {
    const balances = (qty: number): Handler => ({ status: 200, body: { balances: [{ itemId: "it-1", resourceId: "s1", batchId: "b1", qtyOnHand: qty, qtyReserved: 0, qtyFrozen: 0 }] } });
    mockRoutes({ ...EDIT_ROUTES({ status: 404, body: {} }), "GET /api/materials/stock/balances": balances(1) });
    const { unmount } = renderWithProviders(<MaterialsItems />);
    await userEvent.click(await screen.findByRole("button", { name: "Retire CROC500" }));
    expect(await within(await screen.findByTestId("item-retire-confirm")).findByText("1 tablet still on hand across the stores.")).toBeInTheDocument();
    unmount();

    mockRoutes({
      ...EDIT_ROUTES({ status: 404, body: {} }),
      "GET /api/materials/items": { status: 200, body: { items: [{ ...ITEMS[0]!, baseUom: "ml" }] } },
      "GET /api/materials/stock/balances": balances(500),
    });
    renderWithProviders(<MaterialsItems />);
    await userEvent.click(await screen.findByRole("button", { name: "Retire CROC500" }));
    expect(await within(await screen.findByTestId("item-retire-confirm")).findByText("500 ml still on hand across the stores.")).toBeInTheDocument();
  });

  it("walk 2026-11-13: on a phone each item is a card with its acts, every cell under its column's name", async () => {
    mockRoutes({ "GET /api/materials/items": { status: 200, body: { items: ITEMS } } });
    renderWithProviders(<MaterialsItems />);
    const row = (await screen.findByText("CROC500")).closest("tr")!;
    expect(row.closest("table")).toHaveClass("item-rows");
    expect(within(row).getAllByRole("cell").slice(0, 5).map((c) => c.getAttribute("data-label"))).toEqual(["Code", "Name", "Class", "Base unit", "Status"]);
  });
});
