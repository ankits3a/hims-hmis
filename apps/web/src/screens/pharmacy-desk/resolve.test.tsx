import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { freshTick, searchSeed, verifyBody } from "./work";
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
function searched(): string[] {
  return vi.mocked(fetch).mock.calls
    .map(([input]) => String(input))
    .filter((u) => u.includes("/lines/0/shelf"))
    .map((u) => new URL(u, "http://x").searchParams.get("q") ?? "");
}

const ME = "u-anita";
const CALPOL = { id: "m-calpol", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
/** "Tab PCM 500" — a doctor's shorthand no catalogue brand is called: PD-D4's amber row. */
function pcmLine(over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx: 0, rxLine: { drug: "Tab PCM 500", medicineId: null, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 3, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 6, scheduleFlag: null, orderedMedicine: null, dispensedMedicine: null,
    item: null, saleable: false, available: null,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false, batches: [], pickedBatch: null, ...over,
  };
}
function dispense(status: string, lines: WireDispenseLine[]): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U012", name: "Kamla Devi", alias: null, restricted: false }, allergies: [], lines,
  };
}
const SHELF = [
  { medicineId: "m-calpol", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC", itemId: "it-cp", itemCode: "CALP500", itemName: "Calpol 500 tablet", baseUom: "tablet", available: 40, scannedBatchId: null },
  { medicineId: "m-crocin", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC", itemId: "it-cr", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", available: 0, scannedBatchId: null },
];
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/lines/0/shelf": { status: 200, body: { items: SHELF } },
  ...extra,
});

describe("choose what an unplaced line is (PD-5b)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the amber row offers the choice; the search starts from the doctor's words; the reading goes to the check WITHOUT consent", async () => {
    let current = dispense("claimed", [pcmLine()]);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => {
        current = dispense("verified", [pcmLine({ substitutionType: "resolved", dispensedMedicine: CALPOL, item: { id: "it-cp", code: "CALP500", name: "Calpol 500 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 40 })]);
        return { status: 201, body: current };
      },
      "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", current.lines) }),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(within(row).getByRole("checkbox")).toBeDisabled(); // nobody has placed it yet
    await userEvent.click(within(row).getByRole("button", { name: "choose what it is" }));

    const sheet = await screen.findByRole("dialog", { name: "Choose what “Tab PCM 500” is" });
    expect(within(sheet).getByRole("textbox", { name: "Search this counter's shelf" })).toHaveValue("PCM");
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Calpol 500/ }));
    expect(within(sheet).getByRole("radio", { name: /Crocin 500/ })).toBeDisabled(); // none on the shelf
    expect(searched()).toEqual(["PCM"]);
    expect(within(sheet).queryByRole("checkbox")).toBeNull(); // a reading replaces nothing the doctor named: no consent to ask
    await userEvent.click(within(sheet).getByRole("button", { name: "Put Calpol 500 on the ticket" }));

    const res = within(row).getByTestId("desk-line-0-res");
    expect(res).toHaveTextContent("Calpol 500");
    expect(res).toHaveTextContent("you chose it");
    expect(row).toHaveTextContent("tablet");
    await userEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(posted("/pick")).toHaveLength(1));
    expect(posted("/verify")).toEqual([{ lines: [{ lineIdx: 0, qtyBase: 6, dispensedMedicineId: "m-calpol" }] }]);
    // after the check the SERVER'S line is drawn — the local choice is gone with its undo
    await waitFor(() => expect(within(row).queryByTestId("desk-line-0-res")).toBeNull());
    expect(row).toHaveTextContent("Calpol 500");
  });

  it("undo gives the line back to the catalogue's amber; a new search drops a choice it no longer shows", async () => {
    mockRoutes(base(() => dispense("claimed", [pcmLine()])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: "choose what it is" }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Calpol 500/ }));
    const box = within(sheet).getByRole("textbox", { name: "Search this counter's shelf" });
    await userEvent.clear(box);
    await userEvent.type(box, "cal");
    await waitFor(() => expect(searched()).toContain("cal"));
    expect(within(sheet).getByRole("button", { name: "Put it on the ticket" })).toBeDisabled();
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Calpol 500/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Put Calpol 500 on the ticket" }));

    expect(within(row).getByRole("checkbox")).toBeEnabled();
    await userEvent.click(within(row).getByRole("button", { name: "undo" }));
    expect(within(row).queryByTestId("desk-line-0-res")).toBeNull();
    expect(within(row).getByRole("checkbox")).toBeDisabled();
    expect(row).toHaveTextContent(/the catalogue could not place this line/i);
  });

  it("a no-substitution line: choose exactly what was written; nothing matching says the words searched; Esc closes only the sheet", async () => {
    mockRoutes(base(() => dispense("claimed", [pcmLine({ rxLine: { ...pcmLine().rxLine, drug: "Ascoril LS syrup", noSubstitution: true } })]), {
      "GET /api/pharmacy/dispenses/d1/lines/0/shelf": { status: 200, body: { items: [] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    // WALK FINDING — the open line menu drew the amber note's control a second time; one act, one control
    await userEvent.click(within(row).getByRole("button", { name: /What else for Ascoril LS syrup/ }));
    expect(within(row).queryByRole("button", { name: "give an equivalent" })).toBeNull();
    expect(within(row).getAllByRole("button", { name: "choose what it is" })).toHaveLength(1);
    await userEvent.click(within(row).getByRole("button", { name: "choose what it is" }));

    const sheet = await screen.findByRole("dialog", { name: "Choose what “Ascoril LS syrup” is" });
    expect(sheet).toHaveTextContent("The doctor wrote no substitution: choose exactly the medicine written");
    expect(await within(sheet).findByText("Nothing on this shelf is named “Ascoril” — the search reads brand names and codes, not salts. Try the brand you would give; decline the line only if the medicine is not here.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("desk-ticket")).toBeInTheDocument();
  });
});

describe("the reading, as the check is told it (PD-5b)", () => {
  it("starts the search from the words without the dosage form or the numbers", () => {
    expect(searchSeed("Tab. Zincovit")).toBe("Zincovit");
    expect(searchSeed("Tab PCM 500")).toBe("PCM");
    expect(searchSeed("Ascoril LS syrup")).toBe("Ascoril");
    expect(searchSeed("  SYP. 10ml ")).toBe("");
  });

  it("names the medicine read, and never claims a consent nobody was asked for", () => {
    const l = pcmLine();
    const res = { medicineId: "m-calpol", brandName: "Calpol 500", available: 40, baseUom: "tablet" };
    expect(verifyBody([l], { 0: { ...freshTick(l), ticked: true, res } })).toEqual([{ lineIdx: 0, qtyBase: 6, dispensedMedicineId: "m-calpol" }]);
    // once the server has placed the line, a stale local reading is not re-sent
    const placed = pcmLine({ dispensedMedicine: CALPOL });
    expect(verifyBody([placed], { 0: { ...freshTick(placed), ticked: true, res } })).toEqual([{ lineIdx: 0, qtyBase: 6 }]);
  });
});
