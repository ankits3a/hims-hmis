import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdAppointments } from "./opd-appointments";

// 2026-08-18T04:00:00.000Z + 5:30 = 2026-08-18 09:30 IST — same IST calendar day.
const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

const DEPARTMENTS = [
  { id: "dep-1", code: "MED", name: "General medicine", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];
const DOCTOR_1 = {
  id: "doc-1", userId: "u-9", displayName: "Dr Meera Rao", registrationNo: "NMC-4411", departmentId: "dep-1",
  specialty: "Cardiology", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};
const DOCTOR_2 = {
  id: "doc-2", userId: "u-8", displayName: "Dr Anil Verma", registrationNo: "NMC-1234", departmentId: "dep-2",
  specialty: "Orthopaedics", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};
const ROOMS = [
  { id: "room-1", code: "12", name: "Consulting 12", floor: "1", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];

// 6 slots, 10 minutes apart — the hand-derived IST pair the brief pins: 03:30Z → 09:00, 04:00Z → 09:30.
const SLOTS = [
  { start: "2026-08-18T03:30:00.000Z", end: "2026-08-18T03:40:00.000Z", roomId: "room-1", scheduleId: "sch-1", booked: false, past: false },
  { start: "2026-08-18T03:40:00.000Z", end: "2026-08-18T03:50:00.000Z", roomId: "room-1", scheduleId: "sch-1", booked: false, past: true },
  { start: "2026-08-18T03:50:00.000Z", end: "2026-08-18T04:00:00.000Z", roomId: "room-1", scheduleId: "sch-1", booked: true, past: false },
  { start: "2026-08-18T04:00:00.000Z", end: "2026-08-18T04:10:00.000Z", roomId: "room-1", scheduleId: "sch-1", booked: false, past: false },
  { start: "2026-08-18T04:10:00.000Z", end: "2026-08-18T04:20:00.000Z", roomId: "room-1", scheduleId: "sch-1", booked: false, past: false },
  { start: "2026-08-18T04:20:00.000Z", end: "2026-08-18T04:30:00.000Z", roomId: "room-1", scheduleId: "sch-1", booked: false, past: false },
];

const SEARCH_HIT = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000", sex: "female",
  dob: null, isConfidential: false, hasPhoto: false,
};

function apt(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ap-x", patientId: "p-1", doctorId: "doc-1", departmentId: "dep-1", serviceDate: TODAY,
    slotStart: "2026-08-18T03:30:00.000Z", slotEnd: "2026-08-18T03:40:00.000Z", status: "booked", source: "desk",
    note: null, encounterId: null, rescheduledToId: null, rescheduledFromId: null, cancelReason: null, leaveId: null,
    bookedBy: "u-1", bookedAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
    patient: { requestedId: "p-1", id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", alias: null, restricted: false, sex: "female", dob: null },
    ...overrides,
  };
}

function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { url, path: url.split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodyOf(method: string, path: string): Record<string, unknown> {
  return JSON.parse(callsTo(method, path)[0]?.body ?? "{}") as Record<string, unknown>;
}

async function pickDeptAndDoctor(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const departmentSelect = await screen.findByLabelText("Department");
  /*
    FD-23 — the option now reads "MED · General medicine". The CODE was added deliberately: it is
    the prefix the department token series prints on the slip (FD-20), and a clerk who sees "MED-4"
    called should be able to find MED in this list without translating a name into a code. A
    substring matcher keeps the test about "the department is listed" rather than about its exact
    label, which is what it was always trying to say.
  */
  await waitFor(() => expect(within(departmentSelect).getByText(/General medicine/)).toBeInTheDocument());
  await user.selectOptions(departmentSelect, "dep-1");
  const doctorSelect = await screen.findByLabelText("Doctor");
  await waitFor(() => expect(within(doctorSelect).getByText("Dr Meera Rao")).toBeInTheDocument());
  await user.selectOptions(doctorSelect, "doc-1");
}

describe("OpdAppointments", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads GET /opd/slots for the picked department+doctor+date and renders IST-labelled buttons, booked disabled, past dimmed", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_1] },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/slots": { slots: SLOTS },
      "GET /api/opd/appointments": { items: [] },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();

    await pickDeptAndDoctor(user);

    await waitFor(() => expect(callsTo("GET", "/api/opd/slots")).toHaveLength(1));
    expect(callsTo("GET", "/api/opd/slots")[0]!.url).toBe("/api/opd/slots?doctorId=doc-1&date=2026-08-18");

    const onTheHour = screen.getByTestId("slot-2026-08-18T03:30:00.000Z");
    expect(onTheHour).toHaveTextContent("09:00"); // 03:30Z → 09:00 IST
    expect(onTheHour).not.toBeDisabled();
    expect(onTheHour).not.toHaveClass("opacity-50");

    const pastSlot = screen.getByTestId("slot-2026-08-18T03:40:00.000Z");
    expect(pastSlot).toHaveTextContent("09:10");
    expect(pastSlot).toHaveClass("opacity-50"); // past — dimmed, not blocked
    expect(pastSlot).not.toBeDisabled();

    const bookedSlot = screen.getByTestId("slot-2026-08-18T03:50:00.000Z");
    expect(bookedSlot).toHaveTextContent("09:20");
    expect(bookedSlot).toBeDisabled(); // booked — blocked

    const halfPastNine = screen.getByTestId("slot-2026-08-18T04:00:00.000Z");
    expect(halfPastNine).toHaveTextContent("09:30"); // 04:00Z → 09:30 IST

    expect(screen.getAllByTestId(/^slot-2026-08-18T/)).toHaveLength(6);
  });

  it("picking a patient then clicking a slot posts { patientId, doctorId, slotStart } and refreshes the day list", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_1] },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/slots": { slots: SLOTS },
      "GET /api/opd/appointments": { items: [] },
      "GET /api/patients/search": { items: [SEARCH_HIT] },
      "POST /api/opd/appointments": { appointment: apt({ id: "ap-9" }) },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();

    await pickDeptAndDoctor(user);
    await screen.findByTestId("slot-2026-08-18T03:30:00.000Z");

    await user.type(screen.getByLabelText("Search"), "98765");
    await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
    expect(await screen.findByText(/Selected patient: Asha Devi/)).toBeInTheDocument();

    await waitFor(() => expect(callsTo("GET", "/api/opd/appointments").length).toBeGreaterThanOrEqual(1));
    const before = callsTo("GET", "/api/opd/appointments").length;

    await user.click(screen.getByTestId("slot-2026-08-18T03:30:00.000Z"));

    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/appointments")).toEqual({
      patientId: "p-1", doctorId: "doc-1", slotStart: "2026-08-18T03:30:00.000Z",
    });
    await waitFor(() => expect(callsTo("GET", "/api/opd/appointments").length).toBeGreaterThan(before));
  });

  it("the day list renders patient/time/status, Reschedule posts a new slot, and Cancel requires a reason", async () => {
    const booked = apt({ id: "ap-1" });
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_1] },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/slots": { slots: SLOTS },
      "GET /api/opd/appointments": { items: [booked] },
      "POST /api/opd/appointments/ap-1/reschedule": { from: booked, to: apt({ id: "ap-10", slotStart: "2026-08-18T04:10:00.000Z" }) },
      "POST /api/opd/appointments/ap-1/cancel": { appointment: apt({ id: "ap-1", status: "cancelled" }) },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();

    await pickDeptAndDoctor(user);

    expect(await screen.findByText("Asha Devi")).toBeInTheDocument();
    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();
    // Scoped to the day-list TABLE: the left-hand slot grid ALSO has a "09:00" button at this point.
    const dayTable = screen.getByRole("table");
    expect(within(dayTable).getByText("09:00")).toBeInTheDocument(); // the row's own slot time, 03:30Z
    expect(within(dayTable).getByText("Booked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reschedule" }));
    const dialog = await screen.findByRole("dialog");
    const newSlot = await within(dialog).findByTestId("slot-2026-08-18T04:10:00.000Z");
    await user.click(newSlot);

    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments/ap-1/reschedule")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/appointments/ap-1/reschedule")).toEqual({
      slotStart: "2026-08-18T04:10:00.000Z", doctorId: "doc-1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const cancelDialog = await screen.findByRole("dialog");
    await user.type(within(cancelDialog).getByLabelText("Reason"), "Patient requested");
    await user.click(within(cancelDialog).getByRole("button", { name: "Confirm cancel" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments/ap-1/cancel")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/appointments/ap-1/cancel")).toEqual({ reason: "Patient requested" });
  });

  it("the needs-rebooking tab lists across doctors from GET /opd/appointments?needsRebooking=true with a one-tap Reschedule", async () => {
    const needsRebooking = apt({
      id: "ap-3", patientId: "p-3", doctorId: "doc-2", departmentId: "dep-2", serviceDate: "2026-08-20",
      status: "needs_rebooking", leaveId: "lv-1",
      patient: { requestedId: "p-3", id: "p-3", uhid: "HMS0000009999", name: "Sunita Kumar", alias: null, restricted: false, sex: "female", dob: null },
    });
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_2] }, // the unfiltered "all doctors" lookup (departmentId never selected in this test)
      "GET /api/opd/rooms": { items: [] },
      "GET /api/opd/appointments": { items: [needsRebooking] },
      "GET /api/opd/slots": { slots: SLOTS },
      "POST /api/opd/appointments/ap-3/reschedule": { from: needsRebooking, to: apt({ id: "ap-11" }) },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Needs rebooking" }));

    await waitFor(() => expect(callsTo("GET", "/api/opd/appointments")).toHaveLength(1));
    expect(callsTo("GET", "/api/opd/appointments")[0]!.url).toBe("/api/opd/appointments?needsRebooking=true");

    expect(await screen.findByText("Sunita Kumar")).toBeInTheDocument();
    expect(screen.getByText("HMS0000009999")).toBeInTheDocument();
    expect(screen.getByText("Dr Anil Verma")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reschedule" }));
    const dialog = await screen.findByRole("dialog");
    const slotBtn = await within(dialog).findByTestId("slot-2026-08-18T03:30:00.000Z");
    await user.click(slotBtn);

    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments/ap-3/reschedule")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/appointments/ap-3/reschedule")).toEqual({
      slotStart: "2026-08-18T03:30:00.000Z", doctorId: "doc-2",
    });
  });

  it("K42: check-in posts to /opd/appointments/:id/check-in and renders the TokenSlip, but only for today's row — a non-today row's button is disabled", async () => {
    const todayRow = apt({ id: "ap-1", serviceDate: TODAY });
    const otherDayRow = apt({
      id: "ap-2", serviceDate: "2026-08-19", patientId: "p-4",
      patient: { requestedId: "p-4", id: "p-4", uhid: "HMS0000005678", name: "Ravi Kumar", alias: null, restricted: false, sex: "male", dob: null },
    });
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_1] },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/slots": { slots: SLOTS },
      "GET /api/opd/appointments": { items: [todayRow, otherDayRow] },
      "POST /api/opd/appointments/ap-1/check-in": { tokenNo: 7, roomId: "room-1", visitType: "new", encounter: { id: "enc-7", visitNo: "V2608180007" } },
      "GET /api/patients/p-1/qr": { payload: "1.p-1.HMS0000001234.3.6f2a9c", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null },
    });
    const { container } = renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();

    await pickDeptAndDoctor(user);
    await screen.findByText("Asha Devi");

    const todayCheckIn = screen.getByTestId("checkin-ap-1");
    const otherCheckIn = screen.getByTestId("checkin-ap-2");
    // K42: the ONLY difference between these two rows is serviceDate — same status, same shape.
    expect(otherCheckIn).toBeDisabled();
    expect(todayCheckIn).not.toBeDisabled();

    await user.click(todayCheckIn);

    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments/ap-1/check-in")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("visit-no")).toHaveTextContent("V2608180007"));
    await waitFor(() => expect(callsTo("GET", "/api/patients/p-1/qr")).toHaveLength(1));

    expect(await screen.findByTestId("token-no")).toHaveTextContent("MED-7"); // FD-20 grammar
    // Scoped to the slip itself: the header's own Doctor <select> also contains "Dr Meera Rao".
    const slipDoc = container.querySelector("[data-testid='token-card']") as HTMLElement;
    expect(slipDoc).not.toBeNull();
    expect(within(slipDoc).getByText("MED · General medicine")).toBeInTheDocument();
    expect(within(slipDoc).getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(within(slipDoc).getByText("Room: 12")).toBeInTheDocument();
  });

  /**
   * FD-23 — the redesign's two structural claims, asserted rather than eyeballed: this screen wears
   * the counter's design scope, and the agent is on it. Without these a later refactor could quietly
   * drop either and every behavioural test above would stay green.
   */
  it("wears the counter's paper-pine scope and carries the desk agent", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_1] },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/slots": { slots: SLOTS },
      "GET /api/opd/appointments": { items: [] },
    });
    renderWithProviders(<OpdAppointments />);
    await screen.findByLabelText("Department");
    expect(document.querySelector(".pp")).not.toBeNull();
    expect(screen.getByTestId("agent-dock")).toBeInTheDocument();
    expect(screen.getByTestId("agent-ticker")).toHaveTextContent(/I read the filters/);
  });
});
