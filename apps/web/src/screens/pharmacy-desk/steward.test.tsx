import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import type { WireDispense, WireDispenseLine, WireStewardLine } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

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

const ME = "u-anita";
const CROCIN = { id: "m-crocin", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
function lineOf(over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx: 0, rxLine: { drug: "Crocin 500", medicineId: "m-crocin", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 3, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 6, scheduleFlag: "OTC", orderedMedicine: CROCIN, dispensedMedicine: CROCIN,
    item: { id: "it-cr", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 40, location: null,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false, authorisations: [],
    batches: [{ batchId: "b1", batchNo: "CROC500-1", expiryDate: "2028-09-19", available: 40 }], pickedBatch: null, ...over,
  };
}
function ticket(line: WireDispenseLine): WireDispense {
  return {
    id: "d1", status: "claimed", dispenseNo: "P2609190004", orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma", prescriberName: "Dr Sen",
    patient: { id: "p", uhid: "U00110065", name: "Vijay Mahto", alias: null, restricted: false }, allergies: [], lines: [line],
  };
}
let steward: () => WireStewardLine[] = () => [];
const base = (current: () => WireDispense, precheck: () => unknown, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME }, permissions: { hospital: ["pharmacy.dispense.place"], scoped: { department: {}, floor: {} } } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/precheck": () => ({ status: 200, body: precheck() }),
  "GET /api/pharmacy/dispenses/d1/steward": () => ({ status: 200, body: { lines: steward() } }),
  ...extra,
});

const CLEAR = { lines: [{ lineIdx: 0, verdict: "clear", blocks: [] }] };
const state = (over: Partial<WireStewardLine> = {}): WireStewardLine => ({ lineIdx: 0, drug: "Crocin 500", appointed: true, status: "none", approvalId: null, decisionNote: null, ...over });

describe("the counter asks the antimicrobial steward (pharmacy stage D5)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); steward = () => []; });

  it("a restricted line says so, and ⋯ asks the steward with the indication, whether a culture was sent and the planned days", async () => {
    let now = state();
    steward = () => [now];
    const current = ticket(lineOf());
    mockRoutes(base(() => current, () => CLEAR, {
      "POST /api/pharmacy/dispenses/d1/lines/0/steward": () => { now = state({ status: "pending", approvalId: "ap1" }); return { status: 201, body: { status: "pending", approvalId: "ap1" } }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(await within(row).findByTestId("desk-line-0-steward")).toHaveTextContent("Crocin 500 is a restricted antimicrobial");
    await userEvent.click(within(row).getByRole("button", { name: /What else for/ }));
    await userEvent.click(await within(row).findByRole("button", { name: "Ask the antimicrobial steward" }));
    // The planned days start from the prescription's own course.
    expect(within(row).getByTestId("desk-line-0-steward-days")).toHaveValue("3");
    await userEvent.type(within(row).getByTestId("desk-line-0-steward-indication"), "culture-proven ESBL UTI");
    await userEvent.click(within(row).getByTestId("desk-line-0-steward-culture"));
    await userEvent.clear(within(row).getByTestId("desk-line-0-steward-days"));
    await userEvent.type(within(row).getByTestId("desk-line-0-steward-days"), "7");
    await userEvent.click(within(row).getByRole("button", { name: "Send to the steward" }));
    await waitFor(() => expect(posted("/pharmacy/dispenses/d1/lines/0/steward")).toEqual([{ indication: "culture-proven ESBL UTI", cultureSent: true, plannedDays: 7 }]));
    await waitFor(() => expect(within(row).getByTestId("desk-line-0-steward")).toHaveTextContent("Waiting for the antimicrobial steward on Crocin 500"));
  });

  it("with nobody appointed the line says so and offers no ask", async () => {
    steward = () => [state({ appointed: false })];
    const current = ticket(lineOf());
    mockRoutes(base(() => current, () => CLEAR));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(await within(row).findByTestId("desk-line-0-steward")).toHaveTextContent("nobody is appointed antimicrobial steward");
    await userEvent.click(within(row).getByRole("button", { name: /What else for/ }));
    expect(within(row).queryByRole("button", { name: "Ask the antimicrobial steward" })).toBeNull();
  });

  it("a grant the prescriber gave themselves is asked again; an incomplete ask is not sent", async () => {
    steward = () => [state({ status: "self_approved", approvalId: "ap1" })];
    const current = ticket(lineOf());
    mockRoutes(base(() => current, () => CLEAR));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(await within(row).findByTestId("desk-line-0-steward")).toHaveTextContent("approved by the prescribing doctor themselves");
    await userEvent.click(within(row).getByRole("button", { name: /What else for/ }));
    await userEvent.click(await within(row).findByRole("button", { name: "Ask the antimicrobial steward" }));
    await userEvent.click(within(row).getByRole("button", { name: "Send to the steward" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Say the indication");
    expect(posted("/pharmacy/dispenses/d1/lines/0/steward")).toEqual([]);
  });
});
