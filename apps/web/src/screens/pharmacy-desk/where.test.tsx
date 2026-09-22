import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import type { WireDispense, WireDispenseLine } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

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
function put(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "PUT" && String(input).endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ME = "u-anita";
const CALPOL = { id: "m-calpol", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
function lineOf(over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx: 0, rxLine: { drug: "Calpol 500", medicineId: "m-calpol", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 3, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 6, scheduleFlag: "OTC", orderedMedicine: CALPOL, dispensedMedicine: CALPOL,
    item: { id: "it-cp", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 40, location: null,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false,
    batches: [{ batchId: "b1", batchNo: "CALP500-2026001", expiryDate: "2028-09-19", available: 40 }], pickedBatch: null, ...over,
  };
}
function ticket(line: WireDispenseLine): WireDispense {
  return {
    id: "d1", status: "claimed", dispenseNo: null, orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "st-opd",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U00110123", name: "Kamla Devi", alias: null, restricted: false }, allergies: [], lines: [line],
  };
}
const base = (current: () => WireDispense, permissions: string[], extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME }, permissions: { hospital: permissions, scoped: { department: {}, floor: {} } } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  ...extra,
});

describe("where the drug is, on the line (PD-D18)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the line says where to walk, beside the batch", async () => {
    mockRoutes(base(() => ticket(lineOf({ location: "R-12" })), ["pharmacy.dispense.place"]));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const where = await screen.findByTestId("desk-line-0-where");
    expect(where).toHaveTextContent("R-12");
    expect(within(screen.getByTestId("desk-line-0")).getByTestId("desk-line-0-batch")).toHaveTextContent("CALP500-2026001");
  });

  it("whoever manages the counter's items can say where it is, in place, and the line then says it", async () => {
    let current = ticket(lineOf());
    mockRoutes(base(() => current, ["pharmacy.dispense.place", "pharmacy.sale_items.manage"], {
      "PUT /api/pharmacy/sale-items/it-cp/location": () => { current = ticket(lineOf({ location: "R-7" })); return { status: 200, body: { location: "R-7" } }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Calpol 500/ }));
    await userEvent.click(within(row).getByRole("button", { name: "where is it?" }));
    await userEvent.type(within(row).getByRole("textbox", { name: "Where Calpol 500 sits" }), "R-7{Enter}");
    await waitFor(() => expect(put("/pharmacy/sale-items/it-cp/location")).toEqual([{ storeResourceId: "st-opd", location: "R-7" }]));
    expect(await within(row).findByTestId("desk-line-0-where")).toHaveTextContent("R-7");
  });

  it("the aide who picks reads the label and is offered nothing to set", async () => {
    mockRoutes(base(() => ticket(lineOf()), ["pharmacy.dispense.place"]));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Calpol 500/ }));
    expect(within(row).getByRole("button", { name: "Decline this line" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "where is it?" })).toBeNull();
    expect(within(row).queryByTestId("desk-line-0-where")).toBeNull();
  });
});
