import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyDowntime } from "./pharmacy-downtime";
import type { WireRetailPreview, WireRetailSale, WireRetailShelfEntry } from "../lib/pharmacy-api";

type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const bodiesOf = (method: string, path: string): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
  .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
const urlsOf = (path: string): string[] => vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((u) => u.split("?")[0]!.endsWith(path));

const CROCIN: WireRetailShelfEntry = {
  medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC",
  itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin", baseUom: "tablet", available: 40, scannedBatchId: null,
};
const PREVIEW: WireRetailPreview = {
  licence: { storeCode: "PHARM-RETAIL", storePresent: true, state: "missing", licence: null, daysLeft: null },
  prescriptionRequired: false,
  lines: [{ lineIdx: 0, medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC", itemId: "i-croc", batchId: "b-7", batchNo: "CR-7", expiryDate: "2027-06-30", qtyBase: 10, fefoOverride: false }],
  totals: { grossPaise: 12000, discountPaise: 0, taxPaise: 1286, netPayablePaise: 12000 },
  checks: { allergies: [{ lineIdx: 0, substance: "Paracetamol" }], interactions: [], duplicates: 0, partlyCheckedLineIdxs: [] },
};
const SALE = {
  id: "s-9", soldAt: "2026-08-17T04:30:00.000Z", soldBy: "u-ph", soldByName: "Rohit Mehta", channel: "downtime",
  sheet: { kitId: "k1", serial: 1, desk: "pharmacy-counter" }, patient: { id: "p1", uhid: "U0000001", name: "Asha Devi", phone: null, registeredHere: false },
  invoiceId: "inv-9", invoiceNo: "INV-26-000900", netPaise: 12000, scheduled: false, prescription: null, pharmacistRegNo: null, lines: [],
} as WireRetailSale;

/**
 * PHARMACY P20 — a sheet, entered as it was written.
 */
describe("PharmacyDowntime (P20)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("checks the sheet, then enters it with the counter, the time in IST, who handed it over, the batch and the money", async () => {
    mockRoutes({
      "GET /api/pharmacy/downtime/staff": { status: 200, body: { items: [
        { userId: "u-ph", fullName: "Rohit Mehta", username: "ph.mehta", registered: true },
        { userId: "u-aide", fullName: "Ravi", username: "aide.ravi", registered: false },
      ] } },
      "GET /api/pharmacy/downtime/dispenses": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/downtime/sheet": { status: 200, body: { valid: true, desk: "pharmacy-counter", serial: 1, kitGeneratedAt: "2026-08-17T03:30:00.000Z", enteredSaleId: null } },
      "GET /api/pharmacy/downtime/shelf": { status: 200, body: { items: [CROCIN] } },
      "GET /api/pharmacy/downtime/batches": { status: 200, body: { items: [{ batchId: "b-7", batchNo: "CR-7", expiryDate: "2027-06-30", onHand: 40, available: 40, recalled: false }] } },
      "POST /api/pharmacy/downtime/preview": { status: 201, body: PREVIEW },
      "POST /api/pharmacy/downtime/dispenses": { status: 201, body: SALE },
      "GET /api/patients/search": { status: 200, body: { items: [] } },
    });
    renderWithProviders(<PharmacyDowntime />);
    expect(await screen.findByText("No paper dispense entered yet.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Scan the QR on the receipt sheet" }), "dtk1.k1.receipt.1.sig");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByTestId("sheet-status")).toHaveTextContent("Receipt sheet 1 from pharmacy-counter — not yet entered.");

    await userEvent.type(screen.getByLabelText("Time on the sheet"), "2026-08-17T10:00");
    const by = screen.getByRole("combobox", { name: "Handed over by" });
    expect(within(by).getByRole("option", { name: "Ravi (no council registration)" })).toBeInTheDocument();
    await userEvent.selectOptions(by, "u-ph");

    await userEvent.click(screen.getByRole("button", { name: "New customer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Asha Devi");
    await userEvent.click(screen.getByRole("button", { name: "Use" }));

    await userEvent.type(screen.getByRole("textbox", { name: "Medicine name, item code, or scan the pack" }), "croc");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await userEvent.click(within(await screen.findByRole("list", { name: "Held at this counter" })).getByRole("button", { name: "Add" }));
    const price = screen.getByRole("button", { name: "Price the cart" });
    await userEvent.type(await screen.findByRole("textbox", { name: "Quantity of Crocin 500" }), "10");
    // No batch yet: a paper line is not priced without the batch written on the sheet.
    expect(price).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Batch of Crocin 500" }), "b-7");
    await userEvent.click(price);

    expect(await screen.findByTestId("paper-preview")).toHaveTextContent("The bill for this sheet: ₹120.00");
    expect(screen.getByText(/Recorded allergic to Paracetamol. This is recorded, not refused/)).toBeInTheDocument();
    expect(bodiesOf("POST", "/pharmacy/downtime/preview")).toEqual([{
      storeCode: "PHARM-OPD", occurredAt: "2026-08-17T10:00:00+05:30", lines: [{ medicineId: "m-croc", qtyBase: 10, batchId: "b-7" }],
    }]);
    expect(urlsOf("/pharmacy/downtime/batches")).toEqual(["/api/pharmacy/downtime/batches?store=PHARM-OPD&itemId=i-croc"]);

    await userEvent.click(screen.getByRole("button", { name: "Enter this sheet" }));
    expect(await screen.findByTestId("paper-done")).toHaveTextContent("Sheet 1 entered: bill INV-26-000900, ₹120.00.");
    expect(bodiesOf("POST", "/pharmacy/downtime/dispenses")).toEqual([{
      sheetQr: "dtk1.k1.receipt.1.sig", storeCode: "PHARM-OPD", occurredAt: "2026-08-17T10:00:00+05:30", dispensedBy: "u-ph",
      customer: { register: { name: "Asha Devi", sex: "female" } },
      lines: [{ medicineId: "m-croc", qtyBase: 10, batchId: "b-7" }],
      tenders: [{ mode: "cash", amountPaise: 12000 }],
    }]);
  });

  it("says a sheet was already entered, and offers nothing to type against it", async () => {
    mockRoutes({
      "GET /api/pharmacy/downtime/staff": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/downtime/dispenses": { status: 200, body: { items: [
        { id: "s-9", channel: "downtime", soldAt: "2026-08-17T04:30:00.000Z", soldBy: "u-ph", enteredAt: "2026-08-17T07:00:00.000Z", invoiceId: "inv-9", invoiceNo: "INV-26-000900", netPaise: 12000, scheduled: false, lineCount: 1, registeredHere: false, sheet: { desk: "pharmacy-counter", serial: 1 } },
      ] } },
      "GET /api/pharmacy/downtime/sheet": { status: 200, body: { valid: true, desk: "pharmacy-counter", serial: 1, kitGeneratedAt: "2026-08-17T03:30:00.000Z", enteredSaleId: "s-9" } },
    });
    renderWithProviders(<PharmacyDowntime />);
    expect(await screen.findByTestId("paper-row-s-9")).toHaveTextContent("pharmacy-counter #1");
    await userEvent.type(screen.getByRole("textbox", { name: "Scan the QR on the receipt sheet" }), "dtk1.k1.receipt.1.sig");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByTestId("sheet-status")).toHaveTextContent("Sheet 1 has already been entered.");
    expect(screen.queryByLabelText("Time on the sheet")).toBeNull();
  });
});
