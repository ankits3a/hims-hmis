import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { hindiRefusal, hindiSig } from "./phrasebook";
import { HandOver } from "./ticket";
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

const ME = "u-anita";
const CALPOL = { id: "m-calpol", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
const ITEM = { id: "it-cp", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", uoms: [] };
function lineOf(idx: number, over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx: idx, rxLine: { drug: "Calpol 500", medicineId: "m-calpol", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 3, instructions: "after food", noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 6, scheduleFlag: "OTC", orderedMedicine: CALPOL, dispensedMedicine: CALPOL,
    item: ITEM, saleable: true, available: 40, batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null,
    unitPaise: null, priceWinner: null, fefoOverride: false, pickNote: null, partlyChecked: false,
    batches: [{ batchId: "b1", batchNo: "CP-1", expiryDate: "2028-09-19", available: 40 }], pickedBatch: null, ...over,
  };
}
function dispense(status: string, lines: WireDispenseLine[], over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: status === "claimed" ? null : "P2609190004", orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U012", name: "Kamla Devi", alias: null, restricted: false }, allergies: [], lines, ...over,
  };
}
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  ...extra,
});

describe("the hand-over sentence, from a phrasebook — never generated (PD-7 C10)", () => {
  it("says a triplet slot by slot, then the days, then an instruction the book knows", () => {
    expect(hindiSig({ dose: "1 tab", frequency: "1-0-1", durationDays: 5, instructions: "after food" })).toBe("सुबह एक गोली, रात एक गोली — 5 दिन, खाने के बाद");
    expect(hindiSig({ dose: "1 cap", frequency: "1-1-1", durationDays: 5, instructions: null })).toBe("सुबह एक कैप्सूल, दोपहर एक कैप्सूल, रात एक कैप्सूल — 5 दिन");
    expect(hindiSig({ dose: "1 tab", frequency: "0-0-1", durationDays: 7, instructions: "" })).toBe("रात एक गोली — 7 दिन");
    expect(hindiSig({ dose: "1 tab", frequency: "2-0-2", durationDays: 3, instructions: "Before Food" })).toBe("सुबह दो गोली, रात दो गोली — 3 दिन, खाने से पहले");
    expect(hindiSig({ dose: "10 ml", frequency: "1-1-1", durationDays: 5, instructions: null })).toBe("सुबह 10 ml, दोपहर 10 ml, रात 10 ml — 5 दिन");
  });

  it("says the abbreviations a doctor writes, and a course with no length says none", () => {
    expect(hindiSig({ dose: "1 tab", frequency: "OD", durationDays: 3, instructions: "one hour before food" })).toBe("एक गोली, दिन में एक बार — 3 दिन, खाने से एक घंटा पहले");
    expect(hindiSig({ dose: "1 tab", frequency: "BD", durationDays: 5, instructions: null })).toBe("एक गोली, दिन में दो बार — 5 दिन");
    expect(hindiSig({ dose: "1 tab", frequency: "tds", durationDays: 5, instructions: null })).toBe("एक गोली, दिन में तीन बार — 5 दिन");
    expect(hindiSig({ dose: "1 tab", frequency: "SOS", durationDays: null, instructions: null })).toBe("एक गोली, ज़रूरत पड़ने पर");
  });

  it("says NOTHING it cannot say exactly: a weight-based dose, a taper, an instruction not in the book, a multiple of a measured dose", () => {
    expect(hindiSig({ dose: "15 mg/kg", frequency: "TDS", durationDays: 5, instructions: null })).toBeNull();
    expect(hindiSig({ dose: "1 tab", frequency: "1-0-1 for 3 days then 1-0-0", durationDays: 6, instructions: null })).toBeNull();
    expect(hindiSig({ dose: "1 tab", frequency: "1-0-1", durationDays: 5, instructions: "with warm water, not with milk" })).toBeNull();
    expect(hindiSig({ dose: "10 ml", frequency: "2-0-2", durationDays: 5, instructions: null })).toBeNull();
    expect(hindiSig({ dose: "1 tab", frequency: "1-0-0-1", durationDays: 5, instructions: null })).toBeNull();
  });

  it("C4 — a refusal the book knows is said in Hindi; a reason it does not know is not translated at all", () => {
    expect(hindiRefusal("out of stock")).toBe("यह दवा अभी स्टॉक में नहीं है");
    expect(hindiRefusal("  Not stocked here ")).toBe("यह दवा हमारे यहाँ नहीं रखी जाती");
    expect(hindiRefusal("patient has it at home")).toBe("आपने बताया यह दवा घर पर है, इसलिए नहीं दी");
    expect(hindiRefusal("out of stock, try Apollo on the corner")).toBeNull();
  });

  it("at the hand-over the agent says it, on pine; a line it cannot say is left to the pharmacist, in the doctor's words", () => {
    const given = { pickedBatch: { batchNo: "CP-1", expiryDate: "2028-09-19" }, batchId: "b1" };
    renderWithProviders(<HandOver
      dispense={dispense("billed", [
        lineOf(0, given),
        lineOf(1, { ...given, rxLine: { ...lineOf(1).rxLine, drug: "Syp Ascoril", dose: "5 ml", frequency: "TDS", instructions: "shake well before use" }, dispensedMedicine: { ...CALPOL, brandName: "Ascoril LS" } }),
        lineOf(2, { status: "declined", declinedReason: "not stocked" }),
      ])}
      busy={false} error={null} onHandOver={() => {}}
    />);
    const say = screen.getByTestId("desk-say");
    expect(say).toHaveClass("agchip");
    expect(say).toHaveTextContent("Calpol 500: सुबह एक गोली, रात एक गोली — 3 दिन, खाने के बाद");
    expect(say).toHaveTextContent("Ascoril LS: say it in the doctor's words — 5 ml · TDS × 3d · shake well before use");
    expect(within(say).getAllByRole("listitem")).toHaveLength(2); // a declined line is not handed over
  });

  it("C4 — and says what was NOT given, and why, for every declined line", () => {
    const given = { pickedBatch: { batchNo: "CP-1", expiryDate: "2028-09-19" }, batchId: "b1" };
    renderWithProviders(<HandOver
      dispense={dispense("billed", [
        lineOf(0, given),
        lineOf(1, { status: "declined", declinedReason: "out of stock", rxLine: { ...lineOf(1).rxLine, drug: "Amlong 5" } }),
        lineOf(2, { status: "declined", declinedReason: "the doctor will change it", rxLine: { ...lineOf(2).rxLine, drug: "Ascoril LS syrup" } }),
      ])}
      busy={false} error={null} onHandOver={() => {}}
    />);
    const notGiven = screen.getByTestId("desk-say-not-given");
    expect(notGiven).toHaveTextContent("Amlong 5: यह दवा अभी स्टॉक में नहीं है");
    expect(notGiven).toHaveTextContent("Ascoril LS syrup: tell them why, in your words — the doctor will change it");
  });
});

describe("the ticket says what was not checked, and when the hold ends (PD-7 C11, C6)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("C11 — the header counts the lines the books could read only in part, so silence is not read as clean", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf(0, { partlyChecked: true }), lineOf(1, { partlyChecked: true }), lineOf(2)])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    expect(await screen.findByTestId("desk-not-checked")).toHaveTextContent("2 lines the books could read only in part — no warning there is not a clean result");
  });

  it("C11 — and says nothing when every line was read in full", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf(0)])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    expect(screen.queryByTestId("desk-not-checked")).toBeNull();
  });

  it("WALK FINDING — a PAID ticket's rail says what is left to do: hand it over, not take the money", async () => {
    const given = { pickedBatch: { batchNo: "CP-1", expiryDate: "2028-09-19" }, batchId: "b1" };
    mockRoutes(base(() => dispense("billed", [lineOf(0, given)])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-handover");
    expect(screen.getByTestId("desk-flow")).toHaveTextContent("hand it over");
  });

  it("C6 — once the strips are held, the dock says until WHEN, not for how long", async () => {
    let current = dispense("claimed", [lineOf(0)]);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", current.lines); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => {
        current = dispense("picked", [lineOf(0, { pickedBatch: { batchNo: "CP-1", expiryDate: "2028-09-19" }, batchId: "b1" })], { pickedAt: "2026-09-19T07:43:00.000Z" });
        return { status: 201, body: current };
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(screen.getByTestId("desk-ticker")).toHaveTextContent("holding one line until 13:43"));
  });

  it("C3b — before any tick, a line the check will stop SAYS so, with the book; a clear line says nothing", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf(0, { rxLine: { ...lineOf(0).rxLine, drug: "Mox 500" } }), lineOf(1)]), {
      "GET /api/pharmacy/dispenses/d1/precheck": { status: 200, body: { lines: [
        { lineIdx: 0, verdict: "blocked", blocks: [{ book: "allergy", about: "Amoxicillin" }] },
        { lineIdx: 1, verdict: "clear", blocks: [] },
      ] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const stop = await screen.findByTestId("desk-line-0-precheck");
    expect(stop).toHaveTextContent("The check will stop this line: allergy Amoxicillin. Decline it, or back to the doctor — before anyone walks to the shelf.");
    expect(within(screen.getByTestId("desk-line-1")).queryByTestId("desk-line-1-precheck")).toBeNull();
  });

  it("C3b — once the check has refused the line, its refusal is said once, not twice", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf(0)]), {
      "GET /api/pharmacy/dispenses/d1/precheck": { status: 200, body: { lines: [{ lineIdx: 0, verdict: "blocked", blocks: [{ book: "allergy", about: "Paracetamol" }] }] } },
      "POST /api/pharmacy/dispenses/d1/verify": { status: 409, body: { statusCode: 409, code: "allergy_block", message: "…", detail: { hits: [{ lineIdx: 0, substance: "Paracetamol" }] } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await screen.findByTestId("desk-line-0-precheck");
    await userEvent.click(within(row).getByRole("checkbox"));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/allergy/i);
    expect(within(row).queryByTestId("desk-line-0-precheck")).toBeNull();
  });
});
