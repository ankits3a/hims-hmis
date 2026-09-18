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
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ME = "u-anita";
const AMLONG = { id: "m-amlong", brandName: "Amlong 5", strengthLabel: "5 mg", form: "tablet", scheduleFlag: "H" };
function amlongLine(over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx: 0, rxLine: { drug: "Amlong 5", medicineId: "m-amlong", dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 30, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 30, scheduleFlag: "H", orderedMedicine: AMLONG, dispensedMedicine: AMLONG,
    item: { id: "it-amlong", code: "AMLG005", name: "Amlong 5 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 0,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false, batches: [], pickedBatch: null, ...over,
  };
}
function dispense(status: string, lines: WireDispenseLine[]): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: true, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U003", name: "Shanti Devi", alias: null, restricted: false }, allergies: [], lines,
  };
}
const ALTS = [
  { medicineId: "m-amlodac", brandName: "Amlodac 5", strengthLabel: "5 mg", form: "tablet", itemId: "it-ad", itemCode: "AMLD005", available: 120 },
  { medicineId: "m-amlopres", brandName: "Amlopres 5", strengthLabel: "5 mg", form: "tablet", itemId: "it-ap", itemCode: "AMLP005", available: 0 },
];
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/lines/0/alternatives": { status: 200, body: { items: ALTS } },
  ...extra,
});

describe("give something else for this line (PD-5)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("out of stock → an equivalent with CONSENT → the check is told the substitute and the consent", async () => {
    let current = dispense("claimed", [amlongLine()]);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", current.lines); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", current.lines) }),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(within(row).getByRole("checkbox")).toBeDisabled(); // nothing on the shelf
    await userEvent.click(within(row).getByRole("button", { name: "give an equivalent" }));

    const sheet = await screen.findByRole("dialog", { name: "Give something else for Amlong 5" });
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Amlodac 5/ }));
    expect(within(sheet).getByRole("radio", { name: /Amlopres 5/ })).toBeDisabled(); // none on the shelf
    const put = within(sheet).getByRole("button", { name: "Put Amlodac 5 on the ticket" });
    expect(put).toBeDisabled(); // PD-D11 — no consent, no substitute
    await userEvent.click(within(sheet).getByRole("checkbox"));
    await userEvent.click(put);

    expect(within(row).getByTestId("desk-line-0-sub")).toHaveTextContent("Amlodac 5");
    expect(within(row).getByTestId("desk-line-0-sub")).toHaveTextContent("instead of Amlong 5");
    await userEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(posted("/pick")).toHaveLength(1));
    expect(posted("/verify")).toEqual([{ lines: [{ lineIdx: 0, qtyBase: 30, dispensedMedicineId: "m-amlodac", patientConsent: true }] }]);
  });

  it("WALK FINDING — once checked, the line says the SERVER'S substitution: the substitute, instead of the original", async () => {
    const CALPOL = { id: "m-calpol", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
    const CROCIN = { id: "m-crocin", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet" };
    mockRoutes(base(() => dispense("picked", [amlongLine({
      rxLine: { ...amlongLine().rxLine, drug: "Crocin 500" }, orderedMedicine: CROCIN, dispensedMedicine: CALPOL, substitutionType: "generic",
      batchId: "b", pickedBatch: { batchNo: "CALP500-2026001", expiryDate: "2028-09-19" }, available: 185,
    })])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const sub = await screen.findByTestId("desk-line-0-sub");
    expect(sub).toHaveTextContent("Calpol 500");
    expect(sub).toHaveTextContent("instead of Crocin 500");
    expect(within(screen.getByTestId("desk-line-0")).queryByRole("button", { name: "give an equivalent" })).toBeNull();
  });

  it("E16 — a no-substitution line offers no equivalent, and says why", async () => {
    mockRoutes(base(() => dispense("claimed", [amlongLine({ available: 50, batches: [{ batchId: "b", batchNo: "AM-1", expiryDate: "2028-01-31", available: 50 }], rxLine: { ...amlongLine().rxLine, noSubstitution: true } })])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Amlong 5/ }));
    expect(within(row).getByRole("button", { name: "give an equivalent" })).toBeDisabled();
    expect(row).toHaveTextContent("The doctor wrote no substitution on this line");
  });

  it("Esc closes the sheet and ONLY the sheet — the ticket in hand stays", async () => {
    mockRoutes(base(() => dispense("claimed", [amlongLine()])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: "give an equivalent" }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("desk-ticket")).toBeInTheDocument();
  });

  it("E14 — a substitute that trips the patient's allergy is stopped at the check, on its line", async () => {
    const current = dispense("claimed", [amlongLine()]);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": {
        status: 409, body: { statusCode: 409, code: "allergy_block", message: "…", detail: { hits: [{ lineIdx: 0, substance: "amlodipine" }] } },
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: "give an equivalent" }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Amlodac 5/ }));
    await userEvent.click(within(sheet).getByRole("checkbox"));
    await userEvent.click(within(sheet).getByRole("button", { name: /Put Amlodac 5/ }));
    await userEvent.click(within(row).getByRole("checkbox"));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/allergy/i);
  });
});
