import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyRetail } from "./pharmacy-retail";
import type { WireRetailPreview, WireRetailSale, WireRetailShelfEntry, WireRetailState } from "../lib/pharmacy-api";

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
const AZEE: WireRetailShelfEntry = { ...CROCIN, medicineId: "m-azee", brandName: "Azee 500", scheduleFlag: "H1", itemId: "i-azee", itemCode: "AZEE500" };
const previewOf = (over: Partial<WireRetailPreview> = {}): WireRetailPreview => ({
  licence: CURRENT, prescriptionRequired: false,
  lines: [{ lineIdx: 0, medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC", itemId: "i-croc", batchId: "b1", batchNo: "R-1", expiryDate: "2027-06-30", qtyBase: 10, fefoOverride: false }],
  totals: { grossPaise: 12000, discountPaise: 0, taxPaise: 1286, netPayablePaise: 12000 },
  checks: null, ...over,
});
const SALE: WireRetailSale = {
  id: "s1", soldAt: "2026-09-17T05:00:00.000Z", soldBy: "u-ph", soldByName: "Rohit Mehta",
  patient: { id: "p-new", uhid: "U0000123", name: "Ramesh Patil", phone: "9822001122", registeredHere: true },
  invoiceId: "inv-1", invoiceNo: "INV-26-000123", netPaise: 12000, scheduled: false, prescription: null, pharmacistRegNo: null,
  lines: [{ lineIdx: 0, medicineId: "m-croc", drugName: "Crocin 500 500 mg tablet", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin", batchId: "b1", batchNo: "R-1", expiryDate: "2027-06-30", qtyBase: 10, baseUom: "tablet", unitPaise: 1200, scheduleFlag: "OTC", fefoOverride: false }],
};

async function addToCart(entry: WireRetailShelfEntry, qty: string): Promise<void> {
  await userEvent.type(screen.getByRole("textbox", { name: "Medicine name, item code, or scan the pack" }), entry.brandName.slice(0, 4));
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  const results = await screen.findByRole("list", { name: "On the walk-in shelf" });
  await userEvent.click(within(results).getByRole("button", { name: "Add" }));
  await userEvent.type(screen.getByRole("textbox", { name: `Quantity of ${entry.brandName}` }), qty);
}

async function newCustomer(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "New customer" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Ramesh Patil");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sex" }), "male");
  await userEvent.type(screen.getByRole("textbox", { name: "Age" }), "52");
  await userEvent.type(screen.getByRole("textbox", { name: "Mobile" }), "9822001122");
  await userEvent.click(screen.getByRole("button", { name: "Use" }));
}

/**
 * PHARMACY P19 — the walk-in counter: shut without a licence, and one sale top to bottom.
 */
describe("PharmacyRetail (P19)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("says the counter is shut, and why, while no licence is current", async () => {
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: { ...CURRENT, state: "lapsed", daysLeft: -3, licence: { ...CURRENT.licence, validTo: "2026-09-14" } } },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
    });
    renderWithProviders(<PharmacyRetail />);
    expect(await screen.findByTestId("retail-shut")).toHaveTextContent("the retail licence ended on 2026-09-14");
    expect(screen.getByText("No walk-in sale yet today.")).toBeInTheDocument();
  });

  it("lists the day's sales in the hospital's time", async () => {
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [
        { id: "s1", soldAt: "2026-09-17T09:00:00.000Z", soldBy: "u", invoiceId: "inv-1", invoiceNo: "INV-26-000123", netPaise: 12000, scheduled: true, lineCount: 1, registeredHere: false },
      ] } },
    });
    renderWithProviders(<PharmacyRetail />);
    expect(await screen.findByTestId("retail-row-s1")).toHaveTextContent("14:30INV-26-000123₹120.00on prescription");
  });

  it("registers a new customer, prices the cart, takes cash with change, and offers the bill", async () => {
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/retail/shelf": { status: 200, body: { items: [CROCIN] } },
      "POST /api/pharmacy/retail/preview": { status: 201, body: previewOf() },
      "POST /api/pharmacy/retail/sales": { status: 201, body: SALE },
    });
    renderWithProviders(<PharmacyRetail />);
    await screen.findByRole("button", { name: "New customer" });
    await newCustomer();
    expect(screen.getByTestId("retail-customer")).toHaveTextContent("Ramesh Patil (registered when the sale is made)");
    await addToCart(CROCIN, "10");
    await userEvent.click(screen.getByRole("button", { name: "Price the cart" }));
    expect(await screen.findByTestId("retail-total")).toHaveTextContent("To pay: ₹120.00");
    expect(screen.getByText("A new customer has no allergies on record yet: ask before you sell.")).toBeInTheDocument();
    expect(screen.queryByTestId("retail-rx")).toBeNull();
    // A new customer's preview names nobody: the server has no one to check against yet.
    expect(bodiesOf("POST", "/pharmacy/retail/preview")).toEqual([{ lines: [{ medicineId: "m-croc", qtyBase: 10 }] }]);

    const amount = screen.getByRole("textbox", { name: "Amount (₹)" });
    await userEvent.clear(amount);
    await userEvent.type(amount, "200");
    expect(screen.getByTestId("retail-change")).toHaveTextContent("Change to give: ₹80.00");
    await userEvent.click(screen.getByRole("button", { name: "Take payment and sell" }));

    expect(await screen.findByTestId("retail-sold")).toHaveTextContent("Sold: bill INV-26-000123, ₹120.00, to Ramesh Patil.");
    expect(screen.getByText("Registered as U0000123.")).toBeInTheDocument();
    expect(bodiesOf("POST", "/pharmacy/retail/sales")).toEqual([{
      customer: { register: { name: "Ramesh Patil", sex: "male", ageYears: 52, phone: "9822001122" } },
      lines: [{ medicineId: "m-croc", qtyBase: 10 }],
      tenders: [{ mode: "cash", amountPaise: 20000 }],
      changeGivenPaise: 8000,
    }]);
    const call = vi.mocked(fetch).mock.calls.find(([input, init]) => init?.method === "POST" && String(input).endsWith("/pharmacy/retail/sales"));
    expect(new Headers(call?.[1]?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print bill" })).toBeInTheDocument();
  });

  it("asks for the outside prescription on a Schedule H1 line, and will not sell until it is complete", async () => {
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/retail/shelf": { status: 200, body: { items: [AZEE] } },
      "POST /api/pharmacy/retail/preview": { status: 201, body: previewOf({ prescriptionRequired: true }) },
    });
    renderWithProviders(<PharmacyRetail />);
    await screen.findByRole("button", { name: "New customer" });
    await newCustomer();
    await addToCart(AZEE, "3");
    expect(within(screen.getByTestId("cart-0")).getByText("Schedule H1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Price the cart" }));
    const rx = await screen.findByTestId("retail-rx");
    await userEvent.type(within(rx).getByRole("textbox", { name: "Prescriber's name" }), "Dr R. Joshi");
    await userEvent.type(within(rx).getByRole("textbox", { name: "Registration no." }), "MMC-2011-04417");
    await userEvent.type(within(rx).getByRole("textbox", { name: "Prescriber's address" }), "FC Road, Pune");
    // No photo yet: the sale stays closed.
    expect(screen.getByRole("button", { name: "Take payment and sell" })).toBeDisabled();
    expect(bodiesOf("POST", "/pharmacy/retail/sales")).toEqual([]);
  });

  it("shows who already matches, and sells to the one the pharmacist picks", async () => {
    let calls = 0;
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/retail/shelf": { status: 200, body: { items: [CROCIN] } },
      "POST /api/pharmacy/retail/preview": { status: 201, body: previewOf() },
      "POST /api/pharmacy/retail/sales": () => {
        calls += 1;
        return calls === 1
          ? { status: 409, body: { statusCode: 409, code: "duplicate_suspected", message: "x", detail: { candidates: [{ id: "p-old", uhid: "U0000007", name: "Ramesh Patil", phone: "9822001122", matchedOn: ["mobile"] }] } } }
          : { status: 409, body: { statusCode: 409, code: "allergy_block", message: "x" } };
      },
    });
    renderWithProviders(<PharmacyRetail />);
    await screen.findByRole("button", { name: "New customer" });
    await newCustomer();
    await addToCart(CROCIN, "10");
    await userEvent.click(screen.getByRole("button", { name: "Price the cart" }));
    await screen.findByTestId("retail-total");
    await userEvent.click(screen.getByRole("button", { name: "Take payment and sell" }));
    const matches = await screen.findByTestId("retail-matches");
    expect(matches).toHaveTextContent("Ramesh Patil · U0000007 · 9822001122");
    await userEvent.click(within(matches).getByRole("button", { name: "Use this person" }));
    expect(screen.getByTestId("retail-customer")).toHaveTextContent("Ramesh Patil · U0000007");
    // Choosing a person re-prices the cart against their record before anything is sold.
    await userEvent.click(screen.getByRole("button", { name: "Price the cart" }));
    await waitFor(() => { expect(bodiesOf("POST", "/pharmacy/retail/preview")).toHaveLength(2); });
    expect(bodiesOf("POST", "/pharmacy/retail/preview")[1]).toEqual({ patientId: "p-old", lines: [{ medicineId: "m-croc", qtyBase: 10 }] });
    await screen.findByTestId("retail-total");
    await userEvent.click(screen.getByRole("button", { name: "Take payment and sell" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recorded allergy that no prescriber has overridden");
    expect((bodiesOf("POST", "/pharmacy/retail/sales")[1] as { customer: unknown }).customer).toEqual({ existingId: "p-old" });
  });
});
