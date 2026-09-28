import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReception } from "./radiology-reception";

/**
 * PLAN 18a T9 — imaging reception.
 *
 * **The assertion that matters is what this desk CANNOT do.** `radiology_receptionist` holds
 * `radiology.schedule` and not `radiology.gates.satisfy`, so the screen books, moves and checks in
 * — and when the gate set opens it can only display it. A "clear" button here would be the first
 * separation in `manifest.ts` undone in the client.
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const ROW = {
  studyId: "S1", accessionNo: "X2608310001", status: "scheduled", priority: "routine",
  studyTypeCode: "USG-OBS-ANOMALY", scheduledAt: null, deviceResourceId: null,
  encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: true, restricted: true,
};

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("checks a patient in and DISPLAYS the gate set it cannot clear", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "POST /api/radiology/studies/S1/check-in": {
      status: 201,
      body: {
        studyId: "S1", status: "checked_in", policySource: "default", pregnancyReason: "not_ionising",
        gates: ["chaperone_present", "form_f", "identity_two_factor"],
      },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByRole("button", { name: "Check in" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent("Form F (PCPNDT)");
  expect(status).toHaveTextContent("Chaperone");

  /** THE SEPARATION: no control on this screen satisfies a gate. */
  expect(screen.queryByRole("button", { name: /Satisfy|Waive|Override/ })).not.toBeInTheDocument();
  expect(calls.some((c) => c.includes("/gates/"))).toBe(false);
});

it("books a slot and walks a patient in", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "POST /api/radiology/studies/S1/schedule": { status: 201, body: {} },
    "POST /api/radiology/studies/S1/walk-in": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByRole("button", { name: "Book" }));
  await userEvent.click(screen.getByRole("button", { name: "Walk in" }));
  expect(calls).toContain("POST /api/radiology/studies/S1/schedule");
  expect(calls).toContain("POST /api/radiology/studies/S1/walk-in");
});

/**
 * `slot_taken` is a 409 a receptionist acts on by picking another time — so the desk sees the
 * server's own words rather than "could not complete".
 */
it("shows a slot clash with the server's own message", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "POST /api/radiology/studies/S1/schedule": {
      status: 409,
      body: { statusCode: 409, message: "device D1 already has a live booking at that time", code: "slot_taken" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByRole("button", { name: "Book" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already has a live booking.*slot_taken/);
});

/**
 * PLAN 18-S RS2 — the ordering door is the seat's CENTRE (18a-iv D1: at the top of reception, not a
 * new screen), and the right-hand list stays the queue alone ("nothing duplicates the right list").
 */
it("mounts the ordering door in the centre, never in the right-hand queue", async () => {
  mockRoutes({ "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } } });
  renderWithProviders(<RadiologyReception />);
  const door = await screen.findByTestId("imaging-desk-door");
  expect(screen.getByTestId("station-right")).not.toContainElement(door);
  expect(screen.getByLabelText("Visit number")).toBeInTheDocument();
});

/**
 * PLAN 18-S RS2b P5 — THE BEDSIDE BOOKING WRITER. The desk picks a MACHINE from `GET /radiology/
 * devices` (code · name · room, "portable" and "not licensed" marked by the server's own facts)
 * instead of typing a ULID, and a portable machine opens an "At the bedside" field whose value is
 * sent as `bedsideLocation`. The refusal is the server's, in its own words.
 */
const DEVICES = {
  devices: [
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 4", portable: false, status: "available", ionising: true, licensedNow: true },
    { id: "D-PX", code: "PX-1", name: "Portable X-ray", modality: "xray", room: null, portable: true, status: "available", ionising: true, licensedNow: false },
    { id: "D-UP", code: "USG-P1", name: "Portable ultrasound", modality: "usg", room: null, portable: true, status: "available", ionising: false, licensedNow: null },
  ],
};

function bodiesOf(key: string): unknown[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

it("RS2b: the machine is picked from the device list, marked portable and not licensed — no id box", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
  });
  renderWithProviders(<RadiologyReception />);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await waitFor(() => { expect(within(select).getAllByRole("option")).toHaveLength(4); });
  expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Choose a machine",
    "CT-1 · CT scanner · Room 4",
    "PX-1 · Portable X-ray · portable · not licensed",
    "USG-P1 · Portable ultrasound · portable",
  ]);
  expect(screen.queryByRole("textbox", { name: "Machine" })).not.toBeInTheDocument();
});

it("RS2b: a portable machine opens the bedside field and books with bedsideLocation", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S1/schedule": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /PX-1/ });
  expect(screen.queryByLabelText("At the bedside")).not.toBeInTheDocument();
  await userEvent.selectOptions(select, "D-PX");
  await userEvent.type(screen.getByLabelText("At the bedside"), "Ward 3 · bed 12");
  await userEvent.click(screen.getByRole("button", { name: "Book" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/schedule")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/schedule")[0]).toMatchObject({
    deviceResourceId: "D-PX", bedsideLocation: "Ward 3 · bed 12",
  });
});

it("RS2b: a department machine shows no bedside field and sends no bedsideLocation", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S1/schedule": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /CT-1/ });
  await userEvent.selectOptions(select, "D-CT");
  expect(screen.queryByLabelText("At the bedside")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Book" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/schedule")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/schedule")[0]).not.toHaveProperty("bedsideLocation");
});

it("RS2b: device_not_portable is shown in the server's plain words", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S1/schedule": {
      status: 422,
      body: { statusCode: 422, code: "device_not_portable", message: "CT-1 (CT scanner) is not a portable unit and cannot be taken to a bedside" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /CT-1/ });
  await userEvent.selectOptions(select, "D-CT");
  await userEvent.click(screen.getByRole("button", { name: "Book" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/not a portable unit.*device_not_portable/);
});
