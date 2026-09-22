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
const posted = (path: string): number => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path)).length;

const ME = "u-anita";
const CET = { id: "m-cet", brandName: "Cetzine 10", strengthLabel: "10 mg", form: "tablet", scheduleFlag: "OTC" };
const LINE: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Cetzine 10", medicineId: "m-cet", dose: "1 tab", route: "oral", frequency: "0-0-1", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 5, scheduleFlag: "OTC", orderedMedicine: CET, dispensedMedicine: CET,
  item: { id: "it", code: "CETZ010", name: "Cetzine 10 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 200,
  batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
  fefoOverride: false, pickNote: null, partlyChecked: false, batches: [{ batchId: "b", batchNo: "CETZ-1", expiryDate: "2028-09-19", available: 200 }], pickedBatch: null,
};
function dispense(over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status: "claimed", dispenseNo: null, orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    transcribedBy: "u-scribe", transcribedByName: "Rakesh Kale", slipConfirmedBy: null,
    patient: { id: "p1", uhid: "U011", name: "Sushila Devi", alias: null, restricted: false }, allergies: [], lines: [LINE], ...over,
  };
}
const SLIP = { id: "doc1", encounterId: "e1", kind: "consult_prescription", mimeType: "image/jpeg", byteSize: 1234, note: null, capturedBy: "u-scribe", capturedAt: "2026-09-19T05:36:00.000Z" };
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  ...extra,
});

describe("the slip (PD-8)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("E28 — a ticket typed from paper asks for the cross-check FIRST, and holds the ticks until it is given", async () => {
    let current = dispense();
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/confirm-slip": () => { current = dispense({ slipConfirmedBy: ME }); return { status: 201, body: { slipConfirmedBy: ME, slipConfirmedAt: "x" } }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const owed = await screen.findByTestId("desk-slip-owed");
    expect(owed).toHaveTextContent("Typed from the doctor's paper by Rakesh Kale");
    expect(screen.getAllByRole("button", { name: /See the slip/ })).toHaveLength(1); // one control, in the banner
    expect(screen.queryByRole("checkbox", { name: /Cetzine 10/ })).toBeNull(); // not worked until confirmed
    await userEvent.click(within(owed).getByRole("button", { name: "Confirmed against the slip" }));
    await waitFor(() => expect(screen.queryByTestId("desk-slip-owed")).toBeNull());
    expect(posted("/d1/confirm-slip")).toBe(1);
    expect(screen.getByRole("checkbox", { name: /Cetzine 10/ })).toBeEnabled();
  });

  it("S shows the photograph filed against THIS visit; Esc closes only the sheet", async () => {
    mockRoutes(base(() => dispense(), {
      "GET /api/patients/p1/documents": { status: 200, body: { items: [{ ...SLIP, id: "other", encounterId: "e0" }, SLIP] } },
      "GET /api/patients/documents/doc1": { status: 200, body: { mimeType: "image/jpeg", imageBase64: "AAAA" } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-slip-owed");
    await userEvent.keyboard("s");
    const sheet = await screen.findByRole("dialog", { name: "What the scribe photographed" });
    expect(await within(sheet).findByRole("img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("E30 — no slip filed, or a store that cannot read it, is a SENTENCE and never an error box", async () => {
    mockRoutes(base(() => dispense(), {
      "GET /api/patients/p1/documents": { status: 200, body: { items: [SLIP] } },
      "GET /api/patients/documents/doc1": { status: 500, body: { statusCode: 500, message: "ENOENT /var/lib/hmis/documents" } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await within(await screen.findByTestId("desk-slip-owed")).findByRole("button", { name: /See the slip/ }));
    const body = await screen.findByTestId("slip-body");
    expect(await within(body).findByText(/document store is not set up/)).toBeInTheDocument();
    expect(body).not.toHaveTextContent("ENOENT");
  });

  it("E30 — a visit with no slip filed says so", async () => {
    mockRoutes(base(() => dispense(), { "GET /api/patients/p1/documents": { status: 200, body: { items: [] } } }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-slip-owed");
    await userEvent.keyboard("s");
    const body = await screen.findByTestId("slip-body");
    expect(await within(body).findByText(/No photograph of this visit's slip was filed/)).toBeInTheDocument();
    expect(body).not.toHaveTextContent(/PHI-access/); // nothing was opened, so nothing was written
  });

  it("a prescription the doctor wrote on screen has no paper: no slip keycap is drawn and S does nothing", async () => {
    mockRoutes(base(() => dispense({ transcribedBy: null, transcribedByName: null })));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-ticket");
    expect(screen.queryByRole("button", { name: /See the slip/ })).toBeNull();
    await userEvent.keyboard("s");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
