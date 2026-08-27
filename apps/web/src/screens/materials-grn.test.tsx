import { screen, waitFor } from "@testing-library/react";
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
  await screen.findByRole("option", { name: "ACME" });
  await screen.findByRole("option", { name: "MAIN" });
  await screen.findByRole("option", { name: "CROC500" });
  await user.selectOptions(screen.getByLabelText("Vendor"), "v-1");
  await user.selectOptions(screen.getByLabelText("Store"), "st-1");
  await user.type(screen.getByLabelText(/^Challan no\.$/), "CH/1");
  await user.type(screen.getByLabelText(/^Challan date/), "2026-08-27");
  await user.selectOptions(screen.getByLabelText("Item"), "it-1");
  await user.type(screen.getByLabelText("Unit"), "box");
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
    await user.type(screen.getByLabelText("MRP per"), "strip");
    await user.type(screen.getByLabelText(/Landed cost per base unit/), "7");
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
    expect(screen.getByLabelText(/Landed cost per base unit/)).toBeDisabled();
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

  /** DD16's second tab: the two worklists are tables here, not screens of their own. */
  it("the second tab carries the expiring and discrepancy worklists", async () => {
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
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Worklists" }));

    expect(await screen.findByText(/B-OLD/)).toBeInTheDocument();
    expect(screen.getByText(/19 days left/)).toBeInTheDocument();
    expect(screen.getByText(/42 on hand/)).toBeInTheDocument();
    expect(screen.getByText(/tr-1/)).toBeInTheDocument();
    expect(screen.getByText(/short line/)).toBeInTheDocument();
  });
});
