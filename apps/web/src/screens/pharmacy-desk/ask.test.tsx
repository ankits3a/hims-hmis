import { screen, waitFor } from "@testing-library/react";
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
function asked(): { question: string; terms: string[] }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).endsWith("/copilot/ask"))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { question: string; terms: string[] });
}

const ME = "u-anita";
const CALPOL = { id: "m-calpol", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
function lineOf(idx: number, over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx: idx, rxLine: { drug: "Calpol 500", medicineId: "m-calpol", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 3, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 6, scheduleFlag: "OTC", orderedMedicine: CALPOL, dispensedMedicine: CALPOL,
    item: { id: "it-cp", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 40,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false,
    batches: [{ batchId: "b1", batchNo: "CALP500-2026001", expiryDate: "2028-09-19", available: 40 }], pickedBatch: null, ...over,
  };
}
const TICKET: WireDispense = {
  id: "d1", status: "claimed", dispenseNo: null, orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
  scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
  handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
  patient: { id: "p", uhid: "U00110123", name: "Kamla Devi", alias: null, restricted: false }, allergies: [],
  lines: [lineOf(0), lineOf(1, { rxLine: { ...lineOf(1).rxLine, drug: "Cetzine 10" }, dispensedMedicine: { ...CALPOL, brandName: "Cetzine 10" }, batches: [{ batchId: "b2", batchNo: "CETZ010-2026001", expiryDate: "2028-03-31", available: 90 }] })],
};
const base = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": { status: 200, body: TICKET },
  ...extra,
});

describe("the desk's F2 — asking the counter agent (PD-7 C8)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("F2 opens the ask box; the question goes to the shared copilot with the names on screen, and the answer is said in full", async () => {
    mockRoutes(base({
      "POST /api/copilot/ask": { status: 200, body: {
        answer: { key: "copilot.answer.stockOnShelf", params: { name: "Crocin 500", qty: 50, uom: "tablet", batch: "CR-1", expiry: "2027-03-31" } },
        source: "phrasebook", intent: "stock_on_shelf",
      } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await userEvent.keyboard("{F2}");
    const box = screen.getByRole("textbox", { name: "Ask the counter agent" });
    expect(box).toHaveFocus();
    await userEvent.type(box, "kitni crocin bachi hai{Enter}");
    expect(await screen.findByTestId("desk-answer")).toHaveTextContent("Crocin 500: 50 tablet on the shelf. The next sale takes batch CR-1, expiring 2027-03-31.");
    expect(asked()).toEqual([{ question: "kitni crocin bachi hai", terms: ["Kamla Devi"] }]);
  });

  it("'ye batch kab expire hoga' is about the ticket in hand: answered from the screen, and nothing is sent", async () => {
    mockRoutes(base());
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await userEvent.type(screen.getByRole("textbox", { name: "Ask the counter agent" }), "ye batch kab expire hoga{Enter}");
    expect(await screen.findByTestId("desk-answer")).toHaveTextContent("On this ticket: Calpol 500 — batch CALP500-2026001, expires 2028-09-19; Cetzine 10 — batch CETZ010-2026001, expires 2028-03-31.");
    expect(asked()).toEqual([]);
  });

  it("a question neither the hospital nor this screen understands is said to be not understood", async () => {
    mockRoutes(base({
      "POST /api/copilot/ask": { status: 200, body: { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await userEvent.type(screen.getByRole("textbox", { name: "Ask the counter agent" }), "what is the weather{Enter}");
    await waitFor(() => expect(asked()).toHaveLength(1));
    expect(await screen.findByTestId("desk-answer")).toHaveTextContent(/understand/i);
  });
});
