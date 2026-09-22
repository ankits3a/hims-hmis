import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { addDays, istToday } from "./work";
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
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const TODAY = istToday();
const ME = "u-anita";
const STRIP = [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 10 }];
const NEAR = { batchId: "near", batchNo: "AMC-4471", expiryDate: addDays(TODAY, 30), available: 40 };
const LATE = { batchId: "late", batchNo: "AMC-4520", expiryDate: "2028-03-02", available: 120 };
function lineOf(over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  const med = { id: "m-aug", brandName: "Augmentin 625", strengthLabel: "625 mg", form: "tablet", scheduleFlag: "H" };
  return {
    lineIdx: 0, rxLine: { drug: "Augmentin 625", medicineId: "m-aug", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "H", orderedMedicine: med, dispensedMedicine: med,
    item: { id: "it-aug", code: "AUG625", name: "Augmentin 625 tablet", baseUom: "tablet", uoms: STRIP }, saleable: true, available: 160, location: "Rack B2 · shelf 3",
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false, salt: "Amoxicillin + Clavulanic acid",
    batches: [NEAR, LATE], pickedBatch: null, ...over,
  };
}
function dispense(status: string, lines: WireDispenseLine[]): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p1", uhid: "U001", name: "Ramkishan Yadav", alias: null, restricted: false }, allergies: [], lines,
  };
}
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "POST /api/pharmacy/dispenses/d1/verify": () => ({ status: 201, body: dispense("verified", current().lines) }),
  "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", current().lines) }),
  ...extra,
});

/**
 * THE LINE AS THE BOARD DRAWS IT (owner, 2026-09-22: "keep it minimal and in flow"). The row carries
 * the tick, what the doctor wrote (brand · sig · salt), what is given (drug, one badge, the FEFO chip,
 * one note), qty in strips and tablets, the amount, and ⋯. Every exception act is behind ⋯.
 */
describe("the decluttered line (the Desk board)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a working line has no field of its own: salt under the brand, strips over tablets, the amount under its header", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf({ quote: { batchId: "near", batchNo: "AMC-4471", expiryDate: NEAR.expiryDate, unitPaise: 1450, pack: { uom: "strip", multiplier: 10, paise: 14500 }, lastKnown: false } as never })])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(within(row).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(row).queryAllByRole("spinbutton")).toHaveLength(0);
    expect(within(row).getByTestId("desk-line-0-salt")).toHaveTextContent("Amoxicillin + Clavulanic acid");
    expect(within(row).getByTestId("desk-line-0-qty")).toHaveTextContent("1 strip");
    expect(within(row).getByTestId("desk-line-0-qty")).toHaveTextContent("10 tablets");
    expect(within(row).getByTestId("desk-line-0-money")).toHaveTextContent("₹145.00");
    expect(screen.getByTestId("desk-lines")).toHaveTextContent("amount");
    // the buttons on a quiet line: the chip and ⋯, nothing else
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      expect.stringMatching(/^Batch AMC-4471/), "What else for Augmentin 625 1-0-1 × 5d",
    ]);
  });

  it("every exception is one tap behind ⋯ — batch, quantity, an equivalent, where it sits, decline", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf()]), {
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME }, permissions: { hospital: ["pharmacy.dispense.place", "pharmacy.sale_items.manage"], scoped: { department: {}, floor: {} } } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Augmentin 625/ }));
    const menu = within(row).getByTestId("desk-line-0-menu");
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Batch & shelfB", "Change the quantity", "give an equivalent", "change where it sits", "Decline this line",
    ]);
    await userEvent.keyboard("{Escape}");
    expect(within(row).queryByTestId("desk-line-0-menu")).toBeNull();
    expect(navigate).not.toHaveBeenCalled(); // Esc closed the menu, not the desk
  });

  it("ONE scan box for the ticket: a pack of a later batch goes to its own line, names its batch, and ticks it", async () => {
    const other = lineOf({ lineIdx: 1, rxLine: { ...lineOf().rxLine, drug: "Pan 40" }, batches: [{ batchId: "p1", batchNo: "PTP-5510", expiryDate: "2027-06-30", available: 240 }] });
    mockRoutes(base(() => dispense("claimed", [lineOf(), other])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    expect(screen.getAllByRole("textbox", { name: "Scan a pack — it finds its line" })).toHaveLength(1);
    await userEvent.type(screen.getByRole("textbox", { name: "Scan a pack — it finds its line" }), "(01)08901234567890(10)AMC-4520{enter}");
    expect(within(screen.getByTestId("desk-line-0")).getByRole("checkbox")).toBeChecked();
    expect(within(screen.getByTestId("desk-line-0")).getByTestId("desk-line-0-batch")).toHaveTextContent("later batch");
    await userEvent.click(within(screen.getByTestId("desk-line-1")).getByRole("checkbox"));
    await waitFor(() => expect(posted("/pick")).toEqual([{ lines: [{ lineIdx: 0, batchId: "late", scan: "(01)08901234567890(10)AMC-4520" }, { lineIdx: 1 }] }]));
  });
});
