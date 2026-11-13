import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyBillAnnex } from "../../components/pharmacy-bill-annex";
import { PharmacyDesk } from "../pharmacy-desk/pharmacy-desk";
import { resetDeskLog } from "../pharmacy-desk/log";
import { resetPaperNotice } from "../pharmacy-desk/paper";
import { PharmacyRetail, annexOf } from "../pharmacy-retail";
import type { WireDispense, WireDispenseLine, WirePricedDraft, WireRetailPreview, WireRetailSale, WireRetailShelfEntry, WireRetailState } from "../../lib/pharmacy-api";

/**
 * ACCEPTANCE — issue #1046, spec docs/specs/1046-pharmacy-counter-go-live.md (owner APPROVED 2026-11-13): the web half.
 */
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<typeof import("@tanstack/react-router")>()), useNavigate: () => navigate }));
vi.mock("../../lib/print-api", async (orig) => ({
  ...(await orig<typeof import("../../lib/print-api")>()),
  printInFrame: () => true,
}));

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function bodies(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

// ── the OPD desk ──
const ME = "u-anita";
const LINE: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Brufen 400", medicineId: "m", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "H",
  orderedMedicine: { id: "m", brandName: "Brufen 400", strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: "m", brandName: "Brufen 400", strengthLabel: null, form: "tablet", scheduleFlag: "H" },
  item: { id: "it", code: "BRUF400", name: "Brufen 400 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 40, batchId: "b1",
  reservationId: "r1", ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: { batchNo: "BR-1", expiryDate: "2027-12-31" },
};
function dispense(status: string, over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: "P2611130004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: true, invoiceId: status === "picked" ? null : "inv1", identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: "2026-11-13T06:14:00.000Z", billedAt: null, handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U004", name: "Kamla Bai", alias: null, restricted: false }, allergies: [], lines: [LINE], ...over,
  };
}
/** ₹33.60 of medicine: ₹34.00 in cash (0019), ₹33.60 by UPI. */
const PREVIEW: WirePricedDraft = {
  lines: [{ lineId: "l", serviceId: "s", serviceName: "Brufen 400 tablet", qty: 10, unitPaise: 336, grossPaise: 3360, discountPaise: 0, netPaise: 3360, gst: { rateBps: 1200, exempt: false } }],
  totals: { grossPaise: 3360, discountPaise: 0, cgstPaise: 180, sgstPaise: 180, rawTotalPaise: 3360, netPayablePaise: 3360, roundingPaise: 0 },
  byTender: { cash: { netPayablePaise: 3400, roundingPaise: 40 }, digital: { netPayablePaise: 3360, roundingPaise: 0 } },
};
const desk = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-11-13T03:00:00.000Z", openingFloatPaise: 200000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: PREVIEW },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/print": { status: 200, body: { jobs: [] } },
  ...extra,
});

describe("#1046 — the OPD desk", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); resetPaperNotice(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spec #1046 D1: the hand-over offers 'collected by' as the third way, and sends the attendant's name and relation", async () => {
    let current = dispense("billed");
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("handed_over"); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const box = await screen.findByTestId("desk-handover");
    await userEvent.selectOptions(within(box).getByRole("combobox", { name: "who is collecting" }), "collected_by");
    await userEvent.selectOptions(within(box).getByRole("combobox", { name: "collected by" }), "attendant");
    await userEvent.type(within(box).getByRole("textbox", { name: "attendant's name" }), "Ramesh Kumar");
    await userEvent.selectOptions(within(box).getByRole("combobox", { name: "relation" }), "son");
    await userEvent.click(within(box).getByRole("button", { name: /Handed over/ }));
    await waitFor(() => expect(bodies("POST", "/d1/handover")).toEqual([
      { identity: { via: "collected_by", who: "attendant", name: "Ramesh Kumar", relation: "son" } },
    ]));
  });

  it("spec #1046 D3: taking the payment sends the bill to the printer at once, before any hand-over", async () => {
    let current = dispense("picked");
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed"); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [
        { id: "j1", document: "pharmacy_bill", status: "queued", lastError: null, printedAt: null, createdAt: "2026-11-13T06:20:00.000Z" },
      ] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await within(rail).findByTestId("desk-payable");
    // Cash is the desk's default mode (owner, 2026-11-13, label owner-approved-checks on #1051); this check pays by UPI.
    await userEvent.click(within(rail).getByRole("radio", { name: /^UPI/ }));
    await userEvent.type(within(rail).getByRole("textbox", { name: "UPI reference (UTR)" }), "425512345678");
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹33.60/ }));
    await waitFor(() => expect(bodies("POST", "/d1/print")).toEqual([{ documents: ["pharmacy_bill"] }]));
    expect(bodies("POST", "/d1/handover")).toEqual([]);
  });

  it("spec #1046 D4: the desk's cash field starts at the exact payable after cash rounding, and taking it bills that amount", async () => {
    let current = dispense("picked");
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed"); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await within(rail).findByTestId("desk-payable");
    await userEvent.click(within(rail).getByRole("radio", { name: /Cash/ }));
    expect(within(rail).getByRole("textbox", { name: /tendered/ })).toHaveValue("34.00");
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹34.00/ }));
    await waitFor(() => expect(bodies("POST", "/d1/bill")).toEqual([{ tenders: [{ mode: "cash", amountPaise: 3400 }] }]));
  });
});

// ── the walk-in counter ──
const CURRENT: WireRetailState = {
  storeCode: "PHARM-RETAIL", storePresent: true, state: "current", daysLeft: 400,
  licence: { id: "l1", form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni", note: null, recordedBy: "u", recordedAt: "2026-01-01T00:00:00.000Z" },
};
const CROCIN: WireRetailShelfEntry = {
  medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC",
  itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", available: 50, scannedBatchId: null,
};
const AT3360: WireRetailPreview = {
  licence: CURRENT, prescriptionRequired: false, checks: null, discount: null,
  lines: [{ lineIdx: 0, medicineId: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC", itemId: "i-croc", batchId: "b1", batchNo: "R-7", expiryDate: "2028-03-31", qtyBase: 15, fefoOverride: false,
    price: { unitPaise: 224, grossPaise: 3360, discountPaise: 0, taxPaise: 360, gstRateBps: 1200, amountPaise: 3360 } }],
  totals: { grossPaise: 3360, discountPaise: 0, taxPaise: 360, roundingPaise: 40, netPayablePaise: 3400 },
  byTender: { cash: { netPayablePaise: 3400, roundingPaise: 40 }, digital: { netPayablePaise: 3360, roundingPaise: 0 } },
};
const SALE: WireRetailSale = {
  id: "s1", soldAt: "2026-11-13T05:00:00.000Z", soldBy: "u-ph", soldByName: "Rohit Mehta",
  patient: { id: "p-new", uhid: "U0000123", name: "Ramesh Patil", phone: "9822001122", registeredHere: true },
  invoiceId: "inv-1", invoiceNo: "INV-26-000123", netPaise: 3400, scheduled: false, prescription: null, pharmacistRegNo: null,
  lines: [{ lineIdx: 0, medicineId: "m-croc", drugName: "Crocin 500 500 mg tablet", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin", batchId: "b1", batchNo: "R-7", expiryDate: "2028-03-31", qtyBase: 15, baseUom: "tablet", unitPaise: 224, scheduleFlag: "OTC", fefoOverride: false, returnedQtyBase: 0, manufacturer: "GSK Consumer Healthcare" }],
  licence: { form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001" },
  pharmacist: { name: "Rohit Mehta", registrationNo: "MSPC-123456" },
};

describe("#1046 — the walk-in counter", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spec #1046 D4: a walk-in sale is paid part cash, part UPI, the two adding up to the cash-rounded payable", async () => {
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/retail/shelf": { status: 200, body: { items: [CROCIN] } },
      "POST /api/pharmacy/retail/preview": { status: 201, body: AT3360 },
      "POST /api/pharmacy/retail/sales": { status: 201, body: SALE },
    });
    renderWithProviders(<PharmacyRetail />);
    await userEvent.click(await screen.findByRole("button", { name: "New customer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Ramesh Patil");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sex" }), "male");
    await userEvent.type(screen.getByRole("textbox", { name: "Age" }), "52");
    await userEvent.type(screen.getByRole("textbox", { name: "Mobile" }), "9822001122");
    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    await userEvent.type(screen.getByRole("combobox", { name: "Medicine name, item code, or scan the pack" }), "Croc");
    await userEvent.click(within(await screen.findByRole("listbox", { name: "On the walk-in shelf" })).getByRole("option", { name: /Crocin 500/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Quantity of Crocin 500" }), "15");
    await userEvent.click(screen.getByRole("button", { name: "Price the cart" }));
    await screen.findByTestId("retail-total");

    await userEvent.click(screen.getByRole("radio", { name: "Cash + UPI" }));
    expect(screen.getByTestId("retail-total")).toHaveTextContent("₹34.00");
    await userEvent.type(screen.getByRole("textbox", { name: "Cash part (₹)" }), "20");
    await userEvent.type(screen.getByRole("textbox", { name: "UPI part (₹)" }), "13");
    await userEvent.type(screen.getByRole("textbox", { name: "Reference" }), "UTR-9");
    expect(screen.getByRole("button", { name: "Take payment and sell" })).toBeDisabled();
    await userEvent.clear(screen.getByRole("textbox", { name: "UPI part (₹)" }));
    await userEvent.type(screen.getByRole("textbox", { name: "UPI part (₹)" }), "14");
    await userEvent.click(screen.getByRole("button", { name: "Take payment and sell" }));
    await screen.findByTestId("retail-sold");
    expect(bodies("POST", "/pharmacy/retail/sales")[0]).toMatchObject({ tenders: [{ mode: "cash", amountPaise: 2000 }, { mode: "upi", amountPaise: 1400, refText: "UTR-9" }] });
  });

  it("spec #1046 D5: the walk-in bill shows batch, MM/YY expiry and manufacturer per line, and the licence numbers and the pharmacist's registration", () => {
    renderWithProviders(<PharmacyBillAnnex label={annexOf(SALE)} />);
    const row = screen.getByTestId("bill-batch-0");
    expect(row).toHaveTextContent("R-7");
    expect(row).toHaveTextContent("03/28");
    expect(row).toHaveTextContent("GSK Consumer Healthcare");
    expect(screen.getByTestId("bill-licence")).toHaveTextContent("RLF20-MH-PUN-1001");
    expect(screen.getByTestId("bill-licence")).toHaveTextContent("RLF21-MH-PUN-1001");
    expect(screen.getByTestId("bill-dispensed-by")).toHaveTextContent("Rohit Mehta");
    expect(screen.getByTestId("bill-dispensed-by")).toHaveTextContent("MSPC-123456");
  });
});
