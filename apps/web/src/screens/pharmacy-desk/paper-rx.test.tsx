import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const PATIENT = { id: "p1", uhid: "U0011", name: "Sunita Devi", alias: null };
const shelf = (over: Record<string, unknown>) => ({
  medicineId: "m-croc", brandName: "Crocin", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC",
  itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", available: 120, scannedBatchId: null, ...over,
});
const CONTEXT = {
  patient: { id: "p1", uhid: "U0011", name: "Sunita Devi" }, rxDate: "2026-09-30",
  visits: [{ encounterId: "e1", visitNo: "V2609300012", doctorId: "doc1", doctorName: "Dr Sen", hasPrescription: false }],
  doctors: [{ id: "doc1", displayName: "Dr Sen", registrationNo: "BMC/12345" }, { id: "doc2", displayName: "Dr Rao", registrationNo: null }],
};
const TICKET = {
  id: "d9", status: "claimed", dispenseNo: "P2609300009", orderId: null, prescriptionId: "rx9", prescriptionVersion: 1, encounterId: "e1",
  storeResourceId: "s", scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null,
  billedAt: null, handedOverAt: null, cancelReason: null, patient: { ...PATIENT, restricted: false }, allergies: [], lines: [],
};
const base = (extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-anita" } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/find": { status: 200, body: { kind: "none", door: "uhid", reason: "no_prescription_today", patient: PATIENT } },
  "GET /api/pharmacy/paper-rx/context": { status: 200, body: CONTEXT },
  "GET /api/pharmacy/paper-rx/shelf": { status: 200, body: { items: [shelf({}), shelf({ medicineId: "m-azee", brandName: "Azee", itemId: "i-azee", scheduleFlag: "H1" })] } },
  ...extra,
});

async function openSheet(): Promise<HTMLElement> {
  renderWithProviders(<PharmacyDesk ticketId={null} />);
  await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "U0011{enter}");
  const door = await screen.findByTestId("desk-paper-door");
  expect(door).toHaveTextContent("No e-prescription today for Sunita Devi");
  await userEvent.click(within(door).getByRole("button", { name: "Dispense from a paper prescription" }));
  const sheet = await screen.findByTestId("paper-rx-sheet");
  await waitFor(() => expect(within(sheet).getByTestId("paper-rx-visit")).toHaveTextContent("Visit V2609300012"));
  return sheet;
}

describe("the desk's paper-prescription door (2026-09-30)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a found patient with no e-Rx is offered the door; the sheet saves one line and the desk opens the claimed ticket", async () => {
    mockRoutes(base({
      "POST /api/pharmacy/paper-rx": { status: 201, body: TICKET },
      "GET /api/pharmacy/dispenses/d9": { status: 200, body: TICKET },
    }));
    const sheet = await openSheet();
    // the visit's doctor is the prescriber until the pharmacist reads another name off the paper
    expect(within(sheet).getByTestId("paper-rx-doctor")).toHaveValue("doc1");
    await userEvent.type(within(sheet).getByPlaceholderText(/Search the shelf/), "cro");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Crocin 500 mg/ }));
    const save = within(sheet).getByTestId("paper-rx-save");
    expect(save).toBeDisabled(); // no quantity yet
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Qty Crocin" }), "15");
    await userEvent.type(within(sheet).getByPlaceholderText("1-0-1"), "1-0-1");
    await userEvent.click(save);
    await waitFor(() => expect(posted("/pharmacy/paper-rx")).toEqual([{
      patientId: "p1", doctorId: "doc1", rxDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown,
      lines: [{ itemId: "i-croc", qtyBase: 15, frequency: "1-0-1" }],
    }]));
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d9" } });
  });

  it("an H1 line needs the photo before Save; a refusal from the server is said in the pharmacist's words", async () => {
    mockRoutes(base({
      "POST /api/pharmacy/paper-rx": { status: 409, body: { statusCode: 409, code: "paper_rx_controlled", message: "…" } },
    }));
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByPlaceholderText(/Search the shelf/), "aze");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Azee/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Qty Azee" }), "3");
    expect(within(sheet).getByText("required — a Schedule H or H1 medicine")).toBeInTheDocument();
    expect(within(sheet).getByTestId("paper-rx-save")).toBeDisabled();
    await userEvent.upload(within(sheet).getByTestId("paper-rx-photo"), new File([new Uint8Array([0xff, 0xd8])], "rx.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(within(sheet).getByTestId("paper-rx-save")).toBeEnabled());
    await userEvent.click(within(sheet).getByTestId("paper-rx-save"));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("need the doctor's e-prescription");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("nobody found offers no door", async () => {
    mockRoutes(base({ "GET /api/pharmacy/find": { status: 200, body: { kind: "none", door: "uhid", reason: "not_found" } } }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "zzz{enter}");
    expect(await screen.findByText("Nobody found for that.")).toBeInTheDocument();
    expect(screen.queryByTestId("desk-paper-door")).toBeNull();
  });
});
