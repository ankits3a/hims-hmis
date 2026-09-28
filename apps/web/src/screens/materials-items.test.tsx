import { screen, waitFor } from "@testing-library/react";
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
    await user.type(screen.getByLabelText("Supplier lead time (days)"), "5");
    await user.click(screen.getByLabelText("Look-alike / sound-alike (LASA)"));
    await user.click(screen.getByLabelText("High-alert medicine"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("CROC500 saved.")).toBeInTheDocument();
    expect(bodiesOf("PATCH", "/materials/items/it-1")).toEqual([{
      hsnCode: "30049011", storageClass: "cold_2_8", shelfLifeDays: 1095, manufacturer: null, leadTimeDays: 5, lasa: true, highAlert: true,
    }]);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/formulary/medicines/"))).toBe(false);
  });
});
