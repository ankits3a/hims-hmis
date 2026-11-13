import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { resetPaperNotice } from "./paper";
import { identityOf } from "./ticket";
import type { WireDispense, WireDispenseLine, WirePricedDraft } from "../../lib/pharmacy-api";

/** Spec #1046 — the desk's side of the counter's exceptions, beyond the locked acceptance checks. */
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../lib/print-api", async (orig) => ({ ...(await orig<typeof import("../../lib/print-api")>()), printInFrame: () => true }));

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
const gets = (path: string): number => vi.mocked(fetch).mock.calls.filter(([input, init]) => (init?.method ?? "GET") === "GET" && String(input).split("?")[0]!.endsWith(path)).length;

const ME = "u-anita";
const line = (lineIdx: number, drug: string, over: Partial<WireDispenseLine> = {}): WireDispenseLine => ({
  lineIdx, rxLine: { drug, medicineId: `m-${drug}`, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "OTC",
  orderedMedicine: { id: `m-${drug}`, brandName: drug, strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: `m-${drug}`, brandName: drug, strengthLabel: null, form: "tablet", scheduleFlag: "OTC" },
  item: { id: `it-${drug}`, code: drug.toUpperCase(), name: `${drug} tablet`, baseUom: "tablet", uoms: [] }, saleable: true, available: 40, batchId: "b1",
  reservationId: "r1", ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: { batchNo: "B-1", expiryDate: "2027-12-31" }, ...over,
});
function dispense(status: string, lines: WireDispenseLine[], over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: "P2611130004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: status === "picked" ? null : "inv1", identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: "2026-11-13T06:14:00.000Z", billedAt: null, handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U004", name: "Kamla Bai", alias: null, restricted: false }, allergies: [], lines, ...over,
  };
}
const PREVIEW: WirePricedDraft = {
  lines: [{ lineId: "l", serviceId: "s", serviceName: "Crocin tablet", qty: 10, unitPaise: 120, grossPaise: 1200, discountPaise: 0, netPaise: 1200, gst: { rateBps: 1200, exempt: false } }],
  totals: { grossPaise: 1200, discountPaise: 0, cgstPaise: 64, sgstPaise: 64, rawTotalPaise: 1200, netPayablePaise: 1200, roundingPaise: 0 },
};
const desk = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-11-13T03:00:00.000Z", openingFloatPaise: 0, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: PREVIEW },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/print": { status: 200, body: { jobs: [] } },
  ...extra,
});

describe("the counter's exceptions at the desk (spec #1046)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); resetPaperNotice(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("D2 — at the bill, ⋯ on a collected line drops it with a reason, and the bill is priced again", async () => {
    let current = dispense("picked", [line(0, "Crocin"), line(1, "Cetzine")]);
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/lines/1/decline": () => {
        current = dispense("picked", [line(0, "Crocin"), line(1, "Cetzine", { status: "declined", declinedReason: "patient has it at home" })]);
        return { status: 201, body: current };
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-1");
    await within(screen.getByTestId("desk-bill")).findByTestId("desk-payable");
    const before = gets("/d1/bill/preview");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Cetzine/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Drop this line" }));
    const sheet = await screen.findByRole("dialog", { name: "Drop Cetzine from the bill" });
    await userEvent.click(within(sheet).getByRole("button", { name: "patient has it at home" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Drop it" }));
    await waitFor(() => expect(bodies("POST", "/lines/1/decline")).toEqual([{ reason: "patient has it at home" }]));
    await waitFor(() => expect(gets("/d1/bill/preview")).toBeGreaterThan(before));
    // the other line has nothing to drop until it is the bill's turn; nothing to drop once paid
    expect(within(screen.getByTestId("desk-line-0")).getByRole("button", { name: /What else for Crocin/ })).toBeInTheDocument();
  });

  it("D3 — after the bill printed at payment here, the hand-over sends the labels alone", async () => {
    let current = dispense("picked", [line(0, "Crocin")]);
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed", [line(0, "Crocin")]); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("handed_over", [line(0, "Crocin")]); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await within(rail).findByTestId("desk-payable");
    await userEvent.type(within(rail).getByRole("textbox", { name: "UPI reference (UTR)" }), "425512345678");
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹12.00/ }));
    await waitFor(() => expect(bodies("POST", "/d1/print")).toEqual([{ documents: ["pharmacy_bill"] }]));
    await userEvent.click(await screen.findByRole("button", { name: /Handed over/ }));
    await waitFor(() => expect(bodies("POST", "/d1/print")).toEqual([{ documents: ["pharmacy_bill"] }, { documents: ["pharmacy_labels"] }]));
  });

  it("D6 — a finished ticket that still owes says what, and opens the balance as a new ticket taken here", async () => {
    const owed = { lines: [{ lineIdx: 0, drug: "Crocin", qtyBase: 10, unit: "tablet" }], until: "2026-12-13T06:40:00.000Z" };
    mockRoutes(desk(() => dispense("handed_over", [line(0, "Crocin", { owedQtyBase: 10 })], { balanceOwed: owed }), {
      "GET /api/pharmacy/dispenses/d1/closing": { status: 404, body: {} },
      "POST /api/pharmacy/dispenses/d1/balance": { status: 201, body: dispense("queued", [], { id: "d2", balanceOf: "d1" }) },
      "POST /api/pharmacy/dispenses": { status: 201, body: dispense("claimed", [line(0, "Crocin")], { id: "d2", balanceOf: "d1" }) },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const box = await screen.findByTestId("desk-balance");
    expect(box).toHaveTextContent("Balance owed: Crocin × 10 tablet · until 13 Dec");
    await userEvent.click(within(box).getByRole("button", { name: "Open the balance ticket" }));
    await waitFor(() => expect(bodies("POST", "/pharmacy/dispenses")).toEqual([{ dispenseId: "d2", door: "uhid" }]));
    expect(bodies("POST", "/d1/balance")).toEqual([{}]);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d2" } }));
  });

  it("D1 — the identity is complete only when its way is: a value, the patient, or an attendant with a name and a relation", () => {
    expect(identityOf("token", " 14 ", "", "", "")).toEqual({ via: "token", value: "14" });
    expect(identityOf("phone_last4", "  ", "", "", "")).toBeNull();
    expect(identityOf("collected_by", "", "", "", "")).toBeNull();
    expect(identityOf("collected_by", "", "self", "", "")).toEqual({ via: "collected_by", who: "self" });
    expect(identityOf("collected_by", "", "attendant", "Ramesh", "")).toBeNull();
    expect(identityOf("collected_by", "", "attendant", " Ramesh ", "son")).toEqual({ via: "collected_by", who: "attendant", name: "Ramesh", relation: "son" });
  });
});
