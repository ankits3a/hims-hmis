import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyRetail } from "./pharmacy-retail";
import type { WireRetailPreview, WireRetailShelfEntry, WireRetailState } from "../lib/pharmacy-api";

type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  handlers = { "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-me" }, permissions: { hospital: ["pharmacy.retail.sell"], scoped: { department: {}, floor: {} } } } }, ...handlers };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function bodiesOf(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const CURRENT: WireRetailState = {
  storeCode: "PHARM-RETAIL", storePresent: true, state: "current", daysLeft: 400,
  licence: { id: "l1", form20No: "F20", form21No: "F21", validFrom: "2026-01-01", validTo: "2027-10-22", pharmacistInCharge: "A. Kulkarni", note: null, recordedBy: "u", recordedAt: "2026-01-01T00:00:00.000Z" },
};
const CROCIN: WireRetailShelfEntry = {
  medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC",
  itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", available: 50, scannedBatchId: null,
};
const previewOf = (over: Partial<WireRetailPreview> = {}): WireRetailPreview => ({
  licence: CURRENT, prescriptionRequired: false,
  lines: [{ lineIdx: 0, medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC", itemId: "i-croc", batchId: "b1", batchNo: "R-1", expiryDate: "2027-06-30", qtyBase: 10, fefoOverride: false,
    price: { unitPaise: 1200, grossPaise: 12000, discountPaise: 0, taxPaise: 1286, gstRateBps: 1200, amountPaise: 12000 } }],
  totals: { grossPaise: 12000, discountPaise: 0, taxPaise: 1286, netPayablePaise: 12000 },
  checks: null, ...over,
});

/* UX-AUDIT 2026-09-28 — a typeahead: typing lists the shelf, a pick adds it. No Find button. */
async function addToCart(entry: WireRetailShelfEntry, qty: string): Promise<void> {
  await userEvent.type(screen.getByRole("combobox", { name: "Medicine name, item code, or scan the pack" }), entry.brandName.slice(0, 4));
  const results = await screen.findByRole("listbox", { name: "On the walk-in shelf" });
  await userEvent.click(within(results).getByRole("option", { name: new RegExp(entry.brandName) }));
  await userEvent.type(screen.getByRole("textbox", { name: `Quantity of ${entry.brandName}` }), qty);
}


/**
 * #638 (UX audit §5.9) — the walk-in desk's gaps: a manual batch and the item's shelf on each cart line; the customer's
 * allergies and current medicines in the lane; "your day" as counts only (the blind count keeps the money); the copilot
 * dock answering from the screen.
 */
describe("the walk-in desk's gaps (#638)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const BASE = {
    "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
    "GET /api/pharmacy/retail/shelf": { status: 200, body: { items: [CROCIN] } },
    "POST /api/pharmacy/retail/preview": { status: 201, body: previewOf() },
    "GET /api/pharmacy/retail/batches": { status: 200, body: { location: "rack 3 · shelf 2", batches: [
      { batchId: "b-soon", batchNo: "SOON", expiryDate: "2027-06-30", available: 20 },
      { batchId: "b-late", batchNo: "LATE", expiryDate: "2028-03-31", available: 30 },
    ] } },
  };

  it("a cart line names the item's shelf and lets the pharmacist choose a batch; the chosen batch goes to the server", async () => {
    mockRoutes({ ...BASE, "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } } });
    renderWithProviders(<PharmacyRetail />);
    await screen.findByRole("button", { name: "New customer" });
    await addToCart(CROCIN, "10");
    expect(await screen.findByTestId("cart-shelf-0")).toHaveTextContent("Shelf: rack 3 · shelf 2");
    const pick = await screen.findByRole("combobox", { name: "Batch for Crocin 500" });
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Earliest expiry (automatic)", "SOON · exp 30 Jun 2027 · 20 left", "LATE · exp 31 Mar 2028 · 30 left",
    ]);
    await userEvent.selectOptions(pick, "b-late");
    await userEvent.click(screen.getByRole("button", { name: "Price the cart" }));
    await screen.findByTestId("retail-total");
    expect(bodiesOf("POST", "/pharmacy/retail/preview").at(-1)).toEqual({ lines: [{ medicineId: "m-croc", qtyBase: 10, batchId: "b-late" }] });
  });

  it("an existing customer brings their allergies and current medicines into the lane", async () => {
    mockRoutes({
      ...BASE, "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/patients/search": { status: 200, body: { items: [{ id: "p-1", uhid: "U0000007", name: "Asha Devi", phone: "9876500000", sex: "female", dob: "1990-04-02T00:00:00.000Z", isConfidential: false, hasPhoto: false }] } },
      "GET /api/pharmacy/retail/patients/p-1/context": { status: 200, body: {
        allergies: [{ substance: "Penicillin", reaction: "rash", severity: "moderate" }],
        currentMedicines: [{ drug: "Azee 500 tablet", dose: "1 tab", frequency: "OD", durationDays: 30, issuedAt: "2026-09-10T05:00:00.000Z", assumedCurrent: false }],
      } },
    });
    renderWithProviders(<PharmacyRetail />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Search" }), "Asha");
    await userEvent.click(await screen.findByRole("button", { name: /Asha Devi/ }));
    expect(await screen.findByTestId("retail-allergies")).toHaveTextContent("Allergic to Penicillin · rash");
    expect(screen.getByTestId("retail-current-meds")).toHaveTextContent("Azee 500 tablet · 1 tab · OD");
  });

  it("a restricted customer's allergies are not shown, and the lane says they are withheld", async () => {
    mockRoutes({
      ...BASE, "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/patients/search": { status: 200, body: { items: [{ id: "p-9", uhid: "U0000009", name: "Patient R", phone: null, sex: "female", dob: null, isConfidential: true, hasPhoto: false }] } },
      // The patient gate answers 404 for a restricted record this seat may not open.
      "GET /api/pharmacy/retail/patients/p-9/context": { status: 404, body: { message: "unknown patient p-9" } },
    });
    renderWithProviders(<PharmacyRetail />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Search" }), "Patient");
    await userEvent.click(await screen.findByRole("button", { name: /Patient R/ }));
    expect(await screen.findByTestId("retail-allergies-withheld")).toHaveTextContent("Allergies withheld — restricted record");
    expect(screen.queryByTestId("retail-current-meds")).toBeNull();
  });

  it("your day counts your own sales and lines, never the money; the copilot answers it from the screen", async () => {
    mockRoutes({
      ...BASE,
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [
        { id: "s1", soldAt: "2026-09-17T09:00:00.000Z", soldBy: "u-me", invoiceId: "i1", invoiceNo: "INV-1", netPaise: 12000, scheduled: true, lineCount: 2, registeredHere: false, customer: null },
        { id: "s2", soldAt: "2026-09-17T08:00:00.000Z", soldBy: "u-me", invoiceId: "i2", invoiceNo: "INV-2", netPaise: 5000, scheduled: false, lineCount: 1, registeredHere: false, customer: null },
        { id: "s3", soldAt: "2026-09-17T07:00:00.000Z", soldBy: "u-other", invoiceId: "i3", invoiceNo: "INV-3", netPaise: 9000, scheduled: false, lineCount: 4, registeredHere: false, customer: null },
      ] } },
    });
    renderWithProviders(<PharmacyRetail />);
    const day = await screen.findByTestId("retail-your-day");
    await waitFor(() => expect(day).toHaveTextContent("Your day: 2 sales · 3 lines · 1 on prescription"));
    expect(day.textContent ?? "").not.toMatch(/₹/);
    await userEvent.type(screen.getByTestId("agent-ask"), "how is my day{Enter}");
    // Scoped to the dock: the claim is about the ANSWER, which names counts and never money.
    const dock = within(screen.getByTestId("agent-dock"));
    expect(await dock.findByText(/Your day: 2 sales · 3 lines · 1 on prescription/)).toBeInTheDocument();
    expect(screen.getByTestId("agent-dock").textContent ?? "").not.toMatch(/₹/);
  });
});
