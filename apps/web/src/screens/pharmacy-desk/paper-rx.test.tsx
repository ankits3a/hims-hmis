import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { prefillFrom } from "./register-sheet";

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

  /* Owner, staging 2026-10-01: "I am not seeing any suggested patient name as I type." */
  it("suggests registered patients as the name is typed; a tap finds that patient and offers the paper door", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/find/suggest": { status: 200, body: { items: [{ ...PATIENT, restricted: false, hint: "female · 40y · ••3344" }] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "sun");
    const row = await screen.findByTestId("desk-suggest-U0011");
    expect(row).toHaveTextContent("Sunita Devi");
    expect(row).toHaveTextContent("••3344");
    await userEvent.click(row);
    const asked = vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((u) => u.includes("/pharmacy/find?"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("q=U0011");
    expect(await screen.findByTestId("desk-paper-door")).toHaveTextContent("Sunita Devi");
  });

  /* Owner ruling 2026-10-02 — quick desk mode: found → medicines → bill, with no photo asked for. */
  it("quick desk mode: a found patient opens the sheet at once, the unit filter narrows the doctors, and an H1 line saves with no photo", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/settings": { status: 200, body: { settings: { quickDesk: true, updatedBy: "u-admin", updatedAt: "2026-10-02T05:00:00.000Z" } } },
      "GET /api/pharmacy/paper-rx/context": { status: 200, body: { ...CONTEXT, visits: [], doctors: [
        { id: "doc1", displayName: "Dr Sen", registrationNo: "BMC/12345", departmentId: "dep-med", departmentName: "Medicine" },
        { id: "doc2", displayName: "Dr Rao", registrationNo: "BMC/777", departmentId: "dep-ent", departmentName: "ENT" },
      ] } },
      "POST /api/pharmacy/paper-rx": { status: 201, body: TICKET },
      "GET /api/pharmacy/dispenses/d9": { status: 200, body: TICKET },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    expect(await screen.findByTestId("desk-quick-mode")).toHaveTextContent("Quick desk mode");
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "U0011{enter}");
    const sheet = await screen.findByTestId("paper-rx-sheet"); // no door to press
    await userEvent.selectOptions(await within(sheet).findByTestId("paper-rx-unit"), "dep-ent");
    const doctor = within(sheet).getByTestId("paper-rx-doctor");
    expect(within(doctor).queryByRole("option", { name: /Dr Sen/ })).toBeNull();
    await userEvent.selectOptions(doctor, "doc2");
    await userEvent.type(within(sheet).getByPlaceholderText(/Search the shelf/), "aze");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Azee/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Qty Azee" }), "3");
    expect(within(sheet).queryByText("required — a Schedule H or H1 medicine")).toBeNull();
    await userEvent.click(within(sheet).getByTestId("paper-rx-save"));
    await waitFor(() => expect(posted("/pharmacy/paper-rx")).toEqual([{
      patientId: "p1", doctorId: "doc2", rxDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown,
      lines: [{ itemId: "i-azee", qtyBase: 3 }],
    }]));
  });

  /* Owner, staging 2026-10-02: a billed patient kept opening the finished ticket — "no way to restart a fresh billing cycle". */
  it("a patient already handed over today: the desk says so, offers a new paper bill, and can still open the last ticket", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/find": { status: 200, body: { kind: "none", door: "uhid", reason: "no_prescription_today", patient: PATIENT, lastDispenseId: "d-old" } },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "U0011{enter}");
    expect(await screen.findByText("Today's medicines for that patient are already handed over.")).toBeInTheDocument();
    const door = await screen.findByTestId("desk-paper-door");
    expect(door).toHaveTextContent("Sunita Devi already collected today's medicines");
    expect(within(door).getByRole("button", { name: "Dispense from a paper prescription" })).toBeEnabled();
    await userEvent.click(within(door).getByTestId("desk-see-last"));
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d-old" } });
  });

  it("nobody found → Register (prefilled with the typed name) → the paper sheet opens on the new patient, with a no-fee visit", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/find": { status: 200, body: { kind: "none", door: "uhid", reason: "not_found" } },
      "POST /api/patients": { status: 201, body: { patient: { id: "p2", uhid: "U0099", name: "Ramesh Kulkarni", dob: null, phone: "9811122233", addressLine: null } } },
      "GET /api/pharmacy/paper-rx/context": { status: 200, body: { ...CONTEXT, patient: { id: "p2", uhid: "U0099", name: "Ramesh Kulkarni" }, visits: [] } },
      "POST /api/pharmacy/paper-rx": { status: 201, body: TICKET },
      "GET /api/pharmacy/dispenses/d9": { status: 200, body: TICKET },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "Ramesh Kulkarni{enter}");
    expect(await screen.findByText("Nobody found for that.")).toBeInTheDocument();
    expect(screen.queryByTestId("desk-paper-door")).toBeNull();
    const door = await screen.findByTestId("desk-register-door");
    await userEvent.click(within(door).getByRole("button", { name: "Register and dispense from a paper prescription" }));
    const reg = await screen.findByTestId("desk-register-sheet");
    expect(within(reg).getByTestId("register-name")).toHaveValue("Ramesh Kulkarni");
    expect(within(reg).getByTestId("register-save")).toBeDisabled(); // age and sex still to come
    await userEvent.type(within(reg).getByTestId("register-mobile"), "9811122233");
    await userEvent.type(within(reg).getByTestId("register-age"), "54");
    await userEvent.click(within(reg).getByRole("radio", { name: "Male" }));
    await userEvent.click(within(reg).getByTestId("register-save"));
    await waitFor(() => expect(posted("/patients")).toEqual([{ name: "Ramesh Kulkarni", sex: "male", phone: "9811122233", ageYears: 54 }]));

    const sheet = await screen.findByTestId("paper-rx-sheet");
    expect(within(sheet).getByTestId("paper-rx-patient")).toHaveTextContent("U0099");
    await waitFor(() => expect(within(sheet).getByTestId("paper-rx-visit")).toHaveTextContent("opens a no-fee pharmacy visit"));
    await userEvent.selectOptions(within(sheet).getByTestId("paper-rx-doctor"), "doc1");
    await userEvent.type(within(sheet).getByPlaceholderText(/Search the shelf/), "cro");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Crocin 500 mg/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Qty Crocin" }), "10");
    await userEvent.click(within(sheet).getByTestId("paper-rx-save"));
    await waitFor(() => expect(posted("/pharmacy/paper-rx")).toEqual([{
      patientId: "p2", doctorId: "doc1", rxDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown, lines: [{ itemId: "i-croc", qtyBase: 10 }],
    }]));
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d9" } });
  });

  it("a mobile typed at the find goes to the mobile field; a close match is offered before a second record is made", async () => {
    expect(prefillFrom("98111 22233")).toEqual({ name: "", phone: "9811122233" });
    expect(prefillFrom("Sunita Devi")).toEqual({ name: "Sunita Devi", phone: "" });
    mockRoutes(base({
      "GET /api/pharmacy/find": { status: 200, body: { kind: "none", door: "uhid", reason: "not_found" } },
      "POST /api/patients": { status: 409, body: { statusCode: 409, code: "duplicate_suspected", message: "1 match", detail: { candidates: [
        { id: "p1", uhid: "U0011", name: "Sunita Devi", phone: "9822233344", administrativeGender: "female", dob: null, isConfidential: false, hasPhoto: false },
      ] } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "9822233344{enter}");
    await userEvent.click(within(await screen.findByTestId("desk-register-door")).getByRole("button"));
    const reg = await screen.findByTestId("desk-register-sheet");
    expect(within(reg).getByTestId("register-mobile")).toHaveValue("9822233344");
    await userEvent.type(within(reg).getByTestId("register-name"), "Sunita");
    await userEvent.type(within(reg).getByTestId("register-age"), "40");
    await userEvent.click(within(reg).getByRole("radio", { name: "Female" }));
    await userEvent.click(within(reg).getByTestId("register-save"));
    const matches = await within(reg).findByTestId("register-matches");
    await userEvent.click(within(matches).getByRole("button", { name: /Sunita Devi/ }));
    const sheet = await screen.findByTestId("paper-rx-sheet");
    expect(within(sheet).getByTestId("paper-rx-patient")).toHaveTextContent("U0011");
    expect(posted("/patients")).toHaveLength(1); // no second record
  });

  it("an OUTSIDE doctor: H1 needs the name, registration number and address; the body names the outside doctor, no hospital doctor", async () => {
    mockRoutes(base({
      "POST /api/pharmacy/paper-rx": { status: 201, body: TICKET },
      "GET /api/pharmacy/dispenses/d9": { status: 200, body: TICKET },
    }));
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByTestId("paper-rx-mode-outside"));
    await userEvent.type(within(sheet).getByPlaceholderText(/Search the shelf/), "aze");
    await userEvent.click(await within(sheet).findByRole("button", { name: /Azee/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Qty Azee" }), "3");
    await userEvent.upload(within(sheet).getByTestId("paper-rx-photo"), new File([new Uint8Array([0xff, 0xd8])], "rx.jpg", { type: "image/jpeg" }));
    await userEvent.type(within(sheet).getByTestId("paper-rx-outside-name"), "Dr Suresh Rao");
    expect(within(sheet).getByTestId("paper-rx-prescriber-hint")).toHaveTextContent("registration number and address are all required");
    await waitFor(() => expect(within(sheet).getByTestId("paper-rx-photo-state")).toHaveTextContent("photo attached"));
    expect(within(sheet).getByTestId("paper-rx-save")).toBeDisabled();
    await userEvent.type(within(sheet).getByTestId("paper-rx-outside-reg"), "KMC/55555");
    expect(within(sheet).getByTestId("paper-rx-save")).toBeDisabled();
    await userEvent.type(within(sheet).getByTestId("paper-rx-outside-address"), "12 MG Road, Bengaluru");
    await waitFor(() => expect(within(sheet).getByTestId("paper-rx-save")).toBeEnabled());
    await userEvent.click(within(sheet).getByTestId("paper-rx-save"));
    await waitFor(() => expect(posted("/pharmacy/paper-rx")).toEqual([expect.objectContaining({
      patientId: "p1", outside: { name: "Dr Suresh Rao", registrationNo: "KMC/55555", address: "12 MG Road, Bengaluru" },
      lines: [{ itemId: "i-azee", qtyBase: 3 }],
    })]));
    expect(posted("/pharmacy/paper-rx")[0]).not.toHaveProperty("doctorId");
  });
});
