import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaterialsGrn } from "./materials-grn";

/**
 * PLAN 14 T9 — the GRN gate.
 *
 * T9's acceptance: **one refusal path, asserted as the LOCALE STRING.** Here it is
 * `mrp_below_cost` — DD8 rule 6 — and it arrives not as an HTTP error but as a per-LINE VERDICT,
 * which is the shape that matters: a delivery of twelve lines has eleven good ones, and the
 * storekeeper needs to see which one is wrong and why.
 *
 * **The screen renders `t("materialsGrn.rule_mrp_below_cost")`, never the code.** A storekeeper
 * reading `mrp_below_cost` learns nothing actionable; "check the price or the pack size" names the
 * next step. That is the whole reason `RuleCode` is a closed union.
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

const VENDORS = [{
  id: "v-1", code: "ACME", legalName: "Acme Pharma Pvt Ltd", tradeName: null,
  gstin: null, pan: null, msmeClass: null, paymentTermsDays: null, classFlags: {},
  bank: null, firstPaymentAllowedAt: null, status: "active" as const,
  blacklistUntil: null, blacklistReason: null,
}];
const STORES = [{ id: "st-1", code: "MAIN", name: "Main store", status: "available" }];
const ITEMS = [{
  id: "it-1", code: "CROC500", name: "Crocin 500mg tablet", class: "drug",
  formularyMedicineId: "med-1", hsnCode: null, gstRateBps: null,
  baseUom: "tablet", batchTracked: true, serialTracked: false,
  storageClass: "ambient", shelfLifeDays: 1095, abcClass: null, vedClass: null, active: true,
}];

/** A GRN whose one line was REJECTED by rule 6 — the discriminating verdict for this screen. */
function grnWith(rejectReason: string | null, nearExpiry = false) {
  return {
    id: "g-1", grnNo: "GRN2608270001", vendorId: "v-1", source: "challan",
    challanNo: "CH/1", challanDate: "2026-08-27", invoiceNo: null,
    storeResourceId: "st-1", status: rejectReason === null ? "accepted" : "rejected",
    capturedBy: "u", qcBy: "u", postedAt: null, approvalId: null,
    lines: [{
      id: "l-1", itemId: "it-1", uom: "box", qtyInUom: 3, qtyBase: 300,
      batchNo: "B-001", mfgDate: null, expiryDate: "2028-06-30",
      mrpPaise: 500, mrpUom: "strip", unitCostPaise: 700, freeGoods: false,
      qtyAcceptedBase: rejectReason === null ? 300 : 0,
      qtyRejectedBase: rejectReason === null ? 0 : 300,
      rejectReason, nearExpiry, batchId: null,
    }],
  };
}

function baseRoutes(): Record<string, Handler> {
  return {
    "GET /api/materials/vendors": { status: 200, body: { vendors: VENDORS } },
    "GET /api/materials/stores": { status: 200, body: { stores: STORES } },
    "GET /api/materials/items": { status: 200, body: { items: ITEMS } },
    // B5 — the item's own units: Unit and "MRP per" are picked from these, never typed.
    "GET /api/materials/items/it-1": { status: 200, body: { item: { ...ITEMS[0], uoms: [
      { id: "u-box", itemId: "it-1", uom: "box", toBaseMultiplier: 100 },
      { id: "u-strip", itemId: "it-1", uom: "strip", toBaseMultiplier: 10 },
    ], barcodes: [] } } },
    "GET /api/materials/grns": { status: 200, body: { grns: [] } },
  };
}


/**
 * Fill the header and the first line. **It waits for the option to EXIST before selecting it** —
 * `findByLabelText` resolves the moment the `<select>` renders, which is before its query has
 * resolved and while it holds only the `—` placeholder. Selecting then throws, and the message is
 * about a missing option rather than about a pending query, which is exactly the sort of failure
 * that gets "fixed" with a `waitFor` around the wrong thing.
 */
async function fillHeaderAndLine(
  user: ReturnType<typeof userEvent.setup>,
  over: { qty?: string } = {},
): Promise<void> {
  // B5 — receiving a delivery is a sheet over the list, opened by the page's one "new" act.
  await user.click(await screen.findByRole("button", { name: "Receive a delivery" }));
  await screen.findByRole("option", { name: "ACME" });
  await screen.findByRole("option", { name: "MAIN" });
  await screen.findByRole("option", { name: "CROC500 · Crocin 500mg tablet" });
  await user.selectOptions(screen.getByLabelText("Vendor"), "v-1");
  await user.selectOptions(screen.getByLabelText("Store"), "st-1");
  await user.type(screen.getByLabelText(/^Challan no\.$/), "CH/1");
  await user.type(screen.getByLabelText(/^Challan date/), "2026-08-27");
  await user.selectOptions(screen.getByLabelText("Item"), "it-1");
  await within(screen.getByLabelText("Unit")).findByRole("option", { name: "box (100 tablet)" });
  await user.selectOptions(screen.getByLabelText("Unit"), "box");
  await user.type(screen.getByLabelText("Quantity"), over.qty ?? "3");
}

describe("MaterialsGrn", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * **THE REFUSAL PATH, as a per-line verdict.** The line comes back with
   * `rejectReason: "mrp_below_cost"` and the screen renders the SENTENCE.
   */
  it("renders a rejected line's RULE as its locale string, never as the code", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: grnWith("mrp_below_cost") } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();

    await fillHeaderAndLine(user);
    await user.click(screen.getByRole("button", { name: "Capture" }));

    // THE SENTENCE the storekeeper can act on…
    expect(await screen.findByText(/check the price or the pack size/)).toBeInTheDocument();
    // …and NOT the raw code.
    expect(screen.queryByText("mrp_below_cost")).not.toBeInTheDocument();
  });

  /**
   * DD7 — money is typed in RUPEES and sent in integer PAISE, and the conversion happens in exactly
   * one place on this screen. A line typed as ₹85.00 must reach the wire as 8500.
   */
  it("converts rupees to integer paise, and sends qtyInUom — never a computed qtyBase", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: grnWith(null) } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();

    await fillHeaderAndLine(user);
    await user.type(screen.getByLabelText(/^MRP \(₹\)$/), "85");
    await user.selectOptions(screen.getByLabelText("MRP per"), "strip");
    await user.type(screen.getByLabelText("Cost of ONE tablet (₹)"), "7");
    await user.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => { expect(bodiesOf("POST", "/materials/grns")).toHaveLength(1); });
    const sent = bodiesOf("POST", "/materials/grns")[0] as {
      lines: { qtyInUom: number; mrpPaise: number; unitCostPaise: number; qtyBase?: number }[];
    };
    expect(sent.lines[0]?.mrpPaise).toBe(8500);
    expect(sent.lines[0]?.unitCostPaise).toBe(700);
    expect(sent.lines[0]?.qtyInUom).toBe(3);
    // **`qtyBase` NEVER crosses the wire on the way in** — the server computes it from the item's
    // own UoM table, which is DD7's one-conversion rule (A2).
    expect(sent.lines[0]?.qtyBase).toBeUndefined();
  });

  /**
   * PARITY P2 — a delivery received AGAINST an order: picking the order fills the store and the
   * lines with what is still owed, at the order's rate per base unit, and the capture names the order.
   */
  it("picks the vendor's open order, prefills what is owed, and captures against it", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/materials/purchase-orders": { status: 200, body: { purchaseOrders: [{ id: "po-1", poNo: "MPO2609240001", expectedDate: "2026-09-27", status: "sent" }] } },
      "GET /api/materials/purchase-orders/po-1/receivable": { status: 200, body: {
        purchaseOrder: { id: "po-1", poNo: "MPO2609240001", storeResourceId: "st-1", status: "sent" },
        lines: [{ itemId: "it-1", itemCode: "CROC500", itemName: "Crocin", uom: "strip", multiplier: 10, remainingPacks: 4, remainingBase: 40, unitCostPaise: 260, mrpPaise: 3_500, freePacksRemaining: 0 }],
      } },
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: grnWith(null) } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Receive a delivery" }));
    await screen.findByRole("option", { name: "ACME" });
    await user.selectOptions(screen.getByLabelText("Vendor"), "v-1");
    await screen.findByRole("option", { name: /MPO2609240001/ });
    await user.selectOptions(screen.getByLabelText("Purchase order"), "po-1");
    await waitFor(() => expect(screen.getByLabelText("Quantity")).toHaveValue("4"));
    expect(screen.getByLabelText("Store")).toHaveValue("st-1");
    expect(screen.getByLabelText("Unit")).toHaveValue("strip");
    expect(screen.getByLabelText("Cost of ONE tablet (₹)")).toHaveValue("2.60");
    await user.type(screen.getByLabelText(/^Challan no\.$/), "CH/9");
    await user.type(screen.getByLabelText(/^Challan date/), "2026-09-26");
    await user.type(screen.getByLabelText("Batch"), "B-9");
    await user.click(screen.getByRole("button", { name: "Capture" }));
    await waitFor(() => { expect(bodiesOf("POST", "/materials/grns")).toHaveLength(1); });
    expect(bodiesOf("POST", "/materials/grns")[0]).toMatchObject({
      purchaseOrderId: "po-1", storeResourceId: "st-1",
      lines: [{ itemId: "it-1", uom: "strip", qtyInUom: 4, unitCostPaise: 260, mrpPaise: 3_500, mrpUom: "strip", batchNo: "B-9" }],
    });
  });

  /** A free-goods line is zero-cost with FULL batch discipline (DD8) — never a discount. */
  it("a free-goods line sends cost 0 and disables the cost field", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: grnWith(null) } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();

    await fillHeaderAndLine(user, { qty: "1" });
    await user.click(screen.getByLabelText("Free goods"));
    expect(screen.getByLabelText("Cost of ONE tablet (₹)")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => { expect(bodiesOf("POST", "/materials/grns")).toHaveLength(1); });
    const sent = bodiesOf("POST", "/materials/grns")[0] as {
      lines: { unitCostPaise: number; freeGoods?: boolean }[];
    };
    expect(sent.lines[0]?.unitCostPaise).toBe(0);
    expect(sent.lines[0]?.freeGoods).toBe(true);
  });

  /**
   * The near-expiry lane: the approval button appears ONLY when a line needs one, because a button
   * that is always there is a button somebody presses without reading.
   */
  it("offers the near-expiry approval only when a line actually needs it", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: grnWith(null, true) } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();
    await fillHeaderAndLine(user, { qty: "1" });
    await user.click(screen.getByRole("button", { name: "Capture" }));

    expect(await screen.findByRole("button", { name: "Request near-expiry acceptance" })).toBeInTheDocument();
    // …and the line says WHY, in words.
    expect(screen.getByText(/Short shelf life/)).toBeInTheDocument();
  });

  /**
   * THE WALK OF 2026-09-30. The second pharmacist opened a captured GRN to QC it and read a ULID where
   * the drug should be, no expiry, no MRP and no cost — nothing to hold against the strip in their
   * hand — and a green "Accepted" on every line (the expired one too) BEFORE QC had run.
   */
  it("an opened GRN names the item and shows what QC checks, and claims no verdict before QC", async () => {
    const captured = { ...grnWith(null), status: "gate_qc", qcBy: null };
    mockRoutes({
      ...baseRoutes(),
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: captured } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();
    await fillHeaderAndLine(user);
    await user.click(screen.getByRole("button", { name: "Capture" }));

    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent("CROC500 · Crocin 500mg tablet");
    expect(table).not.toHaveTextContent("it-1");
    expect(table).toHaveTextContent("2028-06-30");
    expect(table).toHaveTextContent("₹5.00 / strip");
    expect(table).toHaveTextContent("₹7.00");
    expect(table).toHaveTextContent("Awaiting QC");
    expect(table).not.toHaveTextContent("Accepted");
  });

  /**
   * B5 (the same walk) — the dates are date fields, the units are the item's own, and a strip's price
   * off the bill becomes the cost of ONE tablet on screen before anything is sent: ₹26.00 a strip of 10
   * is ₹2.60 a tablet, and the wire carries 260 paise per base unit, as it always has.
   */
  it("picks the unit from the item's own, takes dates as dates, and turns a pack price into the cost of one base unit", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/materials/grns": { status: 201, body: { grnId: "g-1", grnNo: "GRN2608270001" } },
      "GET /api/materials/grns/g-1": { status: 200, body: { grn: grnWith(null) } },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();
    await fillHeaderAndLine(user);
    expect(screen.getByLabelText(/^Challan date/)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Expiry")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Unit").tagName).toBe("SELECT");
    expect(screen.getByLabelText("MRP per").tagName).toBe("SELECT");

    await user.selectOptions(screen.getByLabelText("Unit"), "strip");
    await user.type(screen.getByLabelText("Price of one strip on the bill (₹)"), "26");
    expect(screen.getByLabelText("Cost of ONE tablet (₹)")).toHaveValue("2.60");
    expect(screen.getByTestId("grn-line-0-per-pack")).toHaveTextContent("= ₹26.00 for one strip of 10 tablet");
    await user.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => { expect(bodiesOf("POST", "/materials/grns")).toHaveLength(1); });
    const sent = bodiesOf("POST", "/materials/grns")[0] as { challanDate: string; lines: Record<string, unknown>[] };
    expect(sent.challanDate).toBe("2026-08-27");
    expect(sent.lines[0]).toMatchObject({ uom: "strip", unitCostPaise: 260 });
    expect(sent.lines[0]).not.toHaveProperty("packRupees");
  });

  /** DD16's two worklists — once a second tab, now groups of the one page under the deliveries (B5: no tabs). */
  it("shows the expiring and discrepancy worklists on the page, with no tab to find them behind", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/materials/expiring": {
        status: 200,
        body: {
          batches: [{
            batchId: "b-1", itemId: "it-1", batchNo: "B-OLD", expiryDate: "2026-09-15",
            daysRemaining: 19, qtyOnHandTotal: 42,
          }],
        },
      },
      "GET /api/materials/transfers/discrepancies": {
        status: 200,
        body: {
          transfers: [{
            id: "tr-1", fromResourceId: "st-1", toResourceId: "st-2", status: "discrepancy",
            issuedAt: "2026-08-27T06:00:00.000Z", receivedAt: "2026-08-27T08:00:00.000Z",
            lines: [{ id: "tl-1", batchId: "b-1", qtyIssued: 10, qtyReceived: 7, discrepancyReason: "short_3" }],
          }],
        },
      },
    });
    renderWithProviders(<MaterialsGrn />);
    expect(await screen.findByText(/B-OLD/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Worklists" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Gate" })).toBeNull();
    // …and no capture form above the list: it is a sheet.
    expect(screen.queryByLabelText("Vendor")).toBeNull();
    expect(screen.getByText(/19 days left/)).toBeInTheDocument();
    expect(screen.getByText(/42 on hand/)).toBeInTheDocument();
    expect(screen.getByText(/tr-1/)).toBeInTheDocument();
    expect(screen.getByText("tr-1 · 1 short line")).toBeInTheDocument();
  });

  /**
   * GAP CLOSURE A1 — the opening-stock sheet. A refused row keeps Capture disabled and says why in the
   * server's words; a clean sheet is captured, and the result says plainly that NOTHING is on the shelf
   * until the pharmacist runs QC and posts — capture is paperwork, not receipt.
   */
  it("opening stock: Check judges every row, a refused row keeps Capture off, and a clean sheet is captured for QC", async () => {
    const row = (over: Partial<Record<string, unknown>> = {}) => ({
      line: 2, brand: "Dolo 650", itemCode: "DOLO650", itemName: "Dolo 650 tablet", batch: "D1", expiryDate: "2027-08-31",
      packs: 12, packSize: 15, uom: "strip15", newUom: false, near: false, mrpPaise: 3360, costPerBasePaise: 160, rack: "A1", reasons: [],
      ...over,
    });
    const check = (rows: unknown[], refusals: number, grnState = "new") => ({
      fileHash: "abc1234567", rows, refusals, units: 180, newUoms: 0, needsVendor: false, zeroCost: 0, racks: 1,
      grns: [{ challanNo: "OPENING/abc1234567", near: false, lines: 1, state: grnState, grnNo: grnState === "new" ? null : "GRN2609280001" }],
      authority: [{ permission: "pharmacy.sale_items.manage", why: "racks", held: true }],
    });
    let checks = 0;
    const replies = [
      check([row({ reasons: ['not on the shelf: "Dolo 65O" — did you mean: Dolo 650 tablet'] })], 1),
      check([row()], 0),
      check([row()], 0, "captured"),
    ];
    mockRoutes({
      ...baseRoutes(),
      "POST /api/pharmacy/opening-stock/check": () => ({ status: 200, body: replies[Math.min(checks++, replies.length - 1)] }),
      "POST /api/pharmacy/opening-stock/capture": {
        status: 201,
        body: { captured: [{ grnId: "g-9", grnNo: "GRN2609280001", challanNo: "OPENING/abc1234567", near: false, lines: 1 }], alreadyOnBooks: 0, uomsAdded: 0, vendorCreated: false, racksSet: 1, racksLeft: 0 },
      },
    });
    renderWithProviders(<MaterialsGrn />);
    const user = userEvent.setup();

    const csv = "brand,batch,expiry,mrp_per_pack,pack_size,packs\nDolo 650,D1,08/2027,33.60,15,12\n";
    await user.upload(await screen.findByLabelText("Sheet (CSV)"), new File([csv], "shelf.csv", { type: "text/csv" }));
    const capture = screen.getByRole("button", { name: "Capture as GRNs" });
    expect(capture).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/did you mean: Dolo 650 tablet/)).toBeInTheDocument();
    expect(screen.getByText(/received whole or not at all/)).toBeInTheDocument();
    expect(capture).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => { expect(capture).toBeEnabled(); });
    await user.click(capture);
    expect(await screen.findByText(/1 GRN captured — open it, run QC and post\. Nothing is on the shelf yet\./)).toBeInTheDocument();
    expect(bodiesOf("POST", "/pharmacy/opening-stock/capture")).toEqual([{ content: csv }]);
    // After capture the re-check reports the GRN on the books, and Capture is off — the same sheet twice captures nothing.
    expect(await screen.findByText(/already captured as GRN2609280001/)).toBeInTheDocument();
    expect(capture).toBeDisabled();
  });
});
