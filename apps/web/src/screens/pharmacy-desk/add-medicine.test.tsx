import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import type { WireDispense, WireDispenseLine, WireRetailShelfEntry } from "../../lib/pharmacy-api";

/** Spec #1055 D5 — after the acceptance check: a line added by hand is worked like any other, and H1 asks for its prescriber. */
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
const posted = (path: string): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
  .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);

const ME = "u-anita";
function lineOf(lineIdx: number, drug: string, over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  const m = { id: `m${String(lineIdx)}`, brandName: drug, strengthLabel: null, form: "tablet", scheduleFlag: "OTC" };
  return {
    lineIdx, rxLine: { drug, medicineId: m.id, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "OTC", orderedMedicine: m, dispensedMedicine: m,
    item: { id: `it${String(lineIdx)}`, code: `C${String(lineIdx)}`, name: drug, baseUom: "tablet", uoms: [] }, saleable: true, available: 50,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false,
    batches: [{ batchId: `b${String(lineIdx)}`, batchNo: `B-${String(lineIdx)}`, expiryDate: "2028-01-31", available: 50 }], pickedBatch: null, ...over,
  };
}
const dispense = (lines: WireDispenseLine[]): WireDispense => ({
  id: "d1", status: "claimed", dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
  scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null, handedOverAt: null,
  cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
  patient: { id: "p1", uhid: "U001", name: "Sunita Devi", alias: null, restricted: false }, allergies: [], lines,
});
const AZEE: WireRetailShelfEntry = {
  medicineId: "m-aze", brandName: "Azee 500", strengthLabel: null, form: "tablet", scheduleFlag: "H1", itemId: "i-aze", itemCode: "AZEE500",
  itemName: "Azee 500 tablet", baseUom: "tablet", available: 30, scannedBatchId: null,
};

describe("a medicine added by hand, at the desk (spec #1055)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("an H1 medicine on paper asks for the prescriber's name and registration number, then the added line is ticked and checked with the rest", async () => {
    let current = dispense([lineOf(0, "Crocin 500")]);
    mockRoutes({
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
      "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current }),
      "GET /api/pharmacy/settings": { status: 200, body: { settings: { quickDesk: true, updatedBy: null, updatedAt: null } } },
      "GET /api/pharmacy/paper-rx/shelf": { status: 200, body: { items: [AZEE] } },
      "POST /api/pharmacy/dispenses/d1/lines": () => {
        current = dispense([...current.lines, lineOf(1, "Azee 500", {
          scheduleFlag: "H1", qtyBase: 3,
          added: { reason: "paper", by: ME, byName: "Anita Verma", at: "2026-11-13T05:00:00.000Z", documentId: null, prescriberName: "Dr Rao", prescriberRegNo: "MMC-4411" },
        })]);
        return { status: 201, body: current };
      },
      "POST /api/pharmacy/dispenses/d1/verify": () => ({ status: 201, body: { ...current, status: "verified" } }),
    });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await userEvent.keyboard("a"); // the key the button draws
    const sheet = await screen.findByRole("dialog", { name: /Add a medicine/ });
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Medicine" }), "aze");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Azee 500/ }));
    await userEvent.click(within(sheet).getByRole("radio", { name: /doctor wrote it on paper/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Quantity" }), "3");
    const add = within(sheet).getByRole("button", { name: /Add to the ticket/ });
    expect(add).toBeDisabled(); // quick desk mode: no photo asked — but H1 needs its prescriber
    await userEvent.type(within(sheet).getByRole("textbox", { name: /Prescriber/ }), "Dr Rao");
    await userEvent.type(within(sheet).getByRole("textbox", { name: /Registration/ }), "MMC-4411");
    await userEvent.click(add);
    await waitFor(() => expect(posted("/d1/lines")).toEqual([{ itemId: "i-aze", reason: "paper", qtyBase: 3, prescriber: { name: "Dr Rao", registrationNo: "MMC-4411" } }]));
    expect(await screen.findByTestId("desk-line-1-added")).toHaveTextContent("added at the counter by Anita Verma · the doctor wrote it on paper · Dr Rao");
    expect(screen.getByTestId("desk-settled")).toHaveTextContent("0 of 2 settled");

    await userEvent.click(within(screen.getByTestId("desk-line-0")).getByRole("checkbox"));
    const added = within(screen.getByTestId("desk-line-1")).getByRole("checkbox");
    expect(added).toBeEnabled();
    await userEvent.click(added);
    await waitFor(() => expect(posted("/d1/verify")).toEqual([{ lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 3 }] }]));
  });
});
