import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { PharmacyAuthorise } from "../pharmacy-authorise";
import { resetDeskLog } from "./log";
import type { WireDispense, WireDispenseLine, WireLineAuthorisation } from "../../lib/pharmacy-api";

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
    patient: { id: "p", uhid: "U00110065", name: "Vijay Mahto", alias: null, restricted: false }, allergies: [{ substance: "Paracetamol", severity: null }], lines: [line],
  };
}
const asked = (over: Partial<WireLineAuthorisation> = {}): WireLineAuthorisation => ({
  id: "a1", book: "allergy", about: "Paracetamol", status: "pending", requestNote: "tolerated last year", decisionReason: null,
  requestedAt: "2026-09-19T08:35:00.000Z", decidedAt: null, ...over,
});
const BLOCKED = { lines: [{ lineIdx: 0, verdict: "blocked", blocks: [{ book: "allergy", about: "Paracetamol", key: "Paracetamol" }] }] };
const base = (current: () => WireDispense, precheck: () => unknown, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME }, permissions: { hospital: ["pharmacy.dispense.place"], scoped: { department: {}, floor: {} } } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/precheck": () => ({ status: 200, body: precheck() }),
  ...extra,
});

describe("the counter asks the prescriber (PD-9)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a line the check will stop can be put to the prescriber BY NAME, with a note; the line then says it is waiting on them", async () => {
    let current = ticket(lineOf());
    mockRoutes(base(() => current, () => BLOCKED, {
      "POST /api/pharmacy/dispenses/d1/lines/0/authorisations": () => { current = ticket(lineOf({ authorisations: [asked()] })); return { status: 201, body: asked() }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await screen.findByTestId("desk-line-0-precheck");
    await userEvent.click(within(row).getByRole("button", { name: /What else for/ }));
    await userEvent.click(await within(row).findByRole("button", { name: "Ask Dr Sen to authorise" }));
    await userEvent.type(within(row).getByRole("textbox", { name: "What Dr Sen should know" }), "tolerated last year");
    await userEvent.click(within(row).getByRole("button", { name: "Send to Dr Sen" }));
    await waitFor(() => expect(posted("/lines/0/authorisations")).toEqual([{ book: "allergy", about: "Paracetamol", note: "tolerated last year" }]));
    expect(await within(row).findByTestId("desk-line-0-auth")).toHaveTextContent("Waiting for Dr Sen to authorise");
    expect(within(row).queryByRole("button", { name: "Ask Dr Sen to authorise" })).toBeNull();
  });

  it("the prescriber's answer is said on the line — authorised with the reason, or declined with it", async () => {
    mockRoutes(base(() => ticket(lineOf({ authorisations: [asked({ status: "authorised", decisionReason: "mild rash only", decidedAt: "2026-09-19T08:40:00.000Z" })] })), () => ({ lines: [{ lineIdx: 0, verdict: "clear", blocks: [] }] })));
    const first = renderWithProviders(<PharmacyDesk ticketId="d1" />);
    expect(await screen.findByTestId("desk-line-0-auth")).toHaveTextContent("Dr Sen authorised it: mild rash only");
    first.unmount();
    mockRoutes(base(() => ticket(lineOf({ authorisations: [asked({ status: "declined", decisionReason: "anaphylaxis on record", decidedAt: "2026-09-19T08:40:00.000Z" })] })), () => BLOCKED));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    expect(await screen.findByTestId("desk-line-0-auth")).toHaveTextContent("Dr Sen declined: anaphylaxis on record");
  });
});

describe("the prescriber decides (PD-9)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const DETAIL = {
    authorisation: { ...asked(), dispenseId: "d1", lineIdx: 0, requestedBy: ME },
    requestedByName: "Anita Verma", dispenseNo: "P2609190004",
    patient: { name: "Vijay Mahto", alias: null, uhid: "U00110065", restricted: false },
    line: { drug: "Crocin 500", dose: "1 tab", frequency: "1-0-1", durationDays: 3, instructions: null },
  };

  it("shows what is asked, needs a reason, and records the decision", async () => {
    let detail: unknown = DETAIL;
    mockRoutes({
      "GET /api/pharmacy/authorisations/a1": () => ({ status: 200, body: detail }),
      "POST /api/pharmacy/authorisations/a1/decision": () => { detail = { ...DETAIL, authorisation: { ...DETAIL.authorisation, status: "authorised", decisionReason: "mild rash only" } }; return { status: 201, body: asked({ status: "authorised" }) }; },
    });
    renderWithProviders(<PharmacyAuthorise authorisationId="a1" />);
    const page = await screen.findByTestId("pharmacy-authorise");
    expect(page).toHaveTextContent("Vijay Mahto");
    expect(page).toHaveTextContent("P-4");
    expect(page).toHaveTextContent("Crocin 500");
    expect(page).toHaveTextContent("recorded allergy · Paracetamol");
    expect(page).toHaveTextContent("Anita Verma: tolerated last year");
    const authorise = within(page).getByRole("button", { name: "Authorise dispensing" });
    expect(authorise).toBeDisabled();
    await userEvent.type(within(page).getByRole("textbox", { name: "Your reason" }), "mild rash only");
    await userEvent.click(authorise);
    await waitFor(() => expect(posted("/authorisations/a1/decision")).toEqual([{ authorise: true, reason: "mild rash only" }]));
    expect(await within(page).findByRole("status")).toHaveTextContent("You authorised it: mild rash only");
  });
});
