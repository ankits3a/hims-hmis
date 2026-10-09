import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  await waitFor(() => expect(within(doctorSelect).getByText(/^Dr Meera Rao/)).toBeInTheDocument());
  await user.selectOptions(doctorSelect, "doc-1");
}

async function pickPatient(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Search"), "98765");
  await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
  await waitFor(() => expect(screen.getByTestId("booking-for")).toHaveTextContent("HMS0000001234"));
}

const DAY_STUBS = {
  "GET /api/opd/departments": { items: DEPARTMENTS },
  "GET /api/opd/doctors": { items: [DOCTOR_1] },
  "GET /api/opd/rooms": { items: ROOMS },
  "GET /api/opd/slots": { slots: SLOTS },
  "GET /api/patients/search": { items: [SEARCH_HIT] },
};

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

  it("2026-10-04 — names the unit that holds the picked department's OPD on the booked day, and nothing for a department without one", async () => {
    const asked: string[] = [];
    stubFetch({
      ...DAY_STUBS,
      "GET /api/opd/appointments": { items: [] },
      "GET /api/auth/me": { actor: { type: "user", id: "u1" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } },
      "GET /api/roster/doctor-units": [{ userId: "u-9", teamId: "t-1", code: "MED-U1", unitName: "General Medicine Unit I", short: "Unit I", departmentId: "org-med", departmentName: "General Medicine", roleInTeam: "head" }],
      "GET /api/roster/opd-units": (_init?: RequestInit, url?: string) => {
        asked.push(url ?? "");
        return [{
          opdDepartmentId: "dep-1", departmentId: "org-med",
          units: [{
            teamId: "t-1", code: "MED-U1", name: "General Medicine Unit I", short: "Unit I",
            startsAt: "2026-08-18T03:30:00.000Z", endsAt: "2026-08-18T11:30:00.000Z",
            doctors: [{ userId: "u-9", name: "Dr Meera Rao", role: "head" }],
          }],
        }];
      },
    });
    setToken("t-1");
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    // No department picked: the roster is not asked.
    await screen.findByLabelText("Department");
    expect(asked).toEqual([]);
    await pickDeptAndDoctor(user);
    const line = await screen.findByTestId("appt-opd-unit-dep-1");
    // 2026-10-04 (owner) — the doctor list says each doctor's unit beside the name.
    expect(within(screen.getByLabelText("Doctor")).getByText("Dr Meera Rao · Unit I")).toBeInTheDocument();
    expect(line).toHaveTextContent("Unit I holds the OPD on Tue 18 Aug · Dr Meera Rao");
    expect(asked.some((u) => u.endsWith("/roster/opd-units?date=2026-08-18"))).toBe(true);
  });

  it("loads GET /opd/slots for the picked department+doctor+date and renders IST-labelled buttons, booked disabled, past dimmed", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/doctors": { items: [DOCTOR_1] },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/slots": { slots: SLOTS },
      "GET /api/opd/appointments": { items: [] },
      "GET /api/patients/search": { items: [SEARCH_HIT] },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();

    await pickDeptAndDoctor(user);

    await waitFor(() => expect(callsTo("GET", "/api/opd/slots")).toHaveLength(1));
    expect(callsTo("GET", "/api/opd/slots")[0]!.url).toBe("/api/opd/slots?doctorId=doc-1&date=2026-08-18");

    /*
      UX-AUDIT 2026-09-28 — "enabled" now needs a patient in hand (the slots are locked until the
      desk knows who the booking is for), and "dimmed" is the `.pp .slot.past` state rather than
      a Tailwind `opacity-50` that `.pp button`'s reset was quietly beating.
    */
    await pickPatient(user);

    const onTheHour = screen.getByTestId("slot-2026-08-18T03:30:00.000Z");
    expect(onTheHour).toHaveTextContent("09:00"); // 03:30Z → 09:00 IST
    expect(onTheHour).not.toBeDisabled();
    expect(onTheHour).not.toHaveClass("past");

    const pastSlot = screen.getByTestId("slot-2026-08-18T03:40:00.000Z");
    expect(pastSlot).toHaveTextContent("09:10");
    expect(pastSlot).toHaveClass("past"); // past — muted, not blocked
    expect(pastSlot).not.toBeDisabled();

    const bookedSlot = screen.getByTestId("slot-2026-08-18T03:50:00.000Z");
    expect(bookedSlot).toHaveTextContent("09:20");
    expect(bookedSlot).toBeDisabled(); // booked — blocked

    const halfPastNine = screen.getByTestId("slot-2026-08-18T04:00:00.000Z");
    expect(halfPastNine).toHaveTextContent("09:30"); // 04:00Z → 09:30 IST

    expect(screen.getAllByTestId(/^slot-2026-08-18T/)).toHaveLength(6);
  });

  it("picking a patient, clicking a slot and confirming posts { patientId, doctorId, slotStart } and refreshes the day list", async () => {
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

    await pickPatient(user);

    await waitFor(() => expect(callsTo("GET", "/api/opd/appointments").length).toBeGreaterThanOrEqual(1));
    const before = callsTo("GET", "/api/opd/appointments").length;

    // UX-AUDIT 2026-09-28 — the click opens a confirmation; the POST rides the Confirm, not the click.
    await user.click(screen.getByTestId("slot-2026-08-18T03:30:00.000Z"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm booking" }));

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
  /**
   * ═══ UX-AUDIT 2026-09-28 — THE BOOKING FLOW, AS A REAL-CHROMIUM WALK FOUND IT ═══
   *
   * Four defects, none of which any test above could see, because every one of them was about
   * what the screen LOOKED LIKE or the ORDER a clerk meets it in:
   *
   *   1. Free, booked and past slots rendered identically as bare text. The grid painted them with
   *      Tailwind utilities (`border`, `bg-neutral-100`, `opacity-50`) and `desk-one.css`'s
   *      `.pp button { background: none; border: none; padding: 0 }` reset out-ranks every one of
   *      them — (0,1,1) against (0,1,0), and unlayered against `@layer utilities` besides. The paint
   *      now comes from `.pp .slot` primitives, and a booked slot SAYS "Booked" in words.
   *   2. The patient search sat BELOW the grid, a slot clicked with nobody chosen did nothing and
   *      said nothing, and a slot clicked with somebody chosen booked on the spot. The patient is
   *      chosen first, the slots are locked with a hint until then, and a click asks before it posts.
   *   3. The bookings list was flex-grow divs, so a checked-in row (no actions) put its time under
   *      the Status header. It is a real <table> now.
   */
  it("a booked slot says Booked in words, and every class on a slot is a `.pp` rule the reset cannot beat", async () => {
    stubFetch({ ...DAY_STUBS, "GET /api/opd/appointments": { items: [] } });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);

    const booked = await screen.findByTestId("slot-2026-08-18T03:50:00.000Z");
    expect(booked).toBeDisabled();
    expect(booked).toHaveClass("slot", "taken");
    expect(booked).toHaveTextContent(/Booked/);
    expect(screen.getByTestId("slot-2026-08-18T03:40:00.000Z")).toHaveClass("slot", "past");
    expect(screen.getByTestId("slot-2026-08-18T03:30:00.000Z")).toHaveClass("slot", "free");

    const css = readFileSync(join(process.cwd(), "src/screens/desk-one/desk-one.css"), "utf8");
    for (const el of screen.getAllByTestId(/^slot-2026-08-18T/)) {
      for (const cls of Array.from(el.classList)) {
        // Each class a slot wears is a `.pp`-scoped rule in the paper-pine sheet — not a utility.
        expect(css, `slot class "${cls}" has no .pp rule`).toMatch(new RegExp(`\\.pp \\.(slot\\.)?${cls}[\\s,:{.]`));
      }
    }
  });

  it("the patient is chosen ABOVE the grid, and the slots are locked with a visible hint until then", async () => {
    stubFetch({ ...DAY_STUBS, "GET /api/opd/appointments": { items: [] } });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);

    const free = await screen.findByTestId("slot-2026-08-18T04:00:00.000Z");
    const search = screen.getByLabelText("Search");
    // The search comes BEFORE the grid in reading order.
    expect(search.compareDocumentPosition(free) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(free).toBeDisabled();
    expect(screen.getByTestId("slots-locked-hint")).toHaveTextContent(/Choose the patient first/);

    await pickPatient(user);
    expect(free).not.toBeDisabled();
    expect(screen.queryByTestId("slots-locked-hint")).toBeNull();
  });

  it("clicking a slot opens a confirmation naming patient, doctor, date and time — Cancel posts nothing", async () => {
    stubFetch({
      ...DAY_STUBS,
      "GET /api/opd/appointments": { items: [] },
      "POST /api/opd/appointments": { appointment: apt({ id: "ap-9" }) },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);
    await screen.findByTestId("slot-2026-08-18T04:00:00.000Z");
    await pickPatient(user);

    await user.click(screen.getByTestId("slot-2026-08-18T04:00:00.000Z"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Asha Devi")).toBeInTheDocument();
    expect(within(dialog).getByText("HMS0000001234")).toBeInTheDocument();
    expect(within(dialog).getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(within(dialog).getByText(TODAY)).toBeInTheDocument();
    expect(within(dialog).getByText("09:30")).toBeInTheDocument();
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);
  });

  it("the bookings list is a real table: a checked-in row's time sits under Time, not under Status", async () => {
    stubFetch({
      ...DAY_STUBS,
      "GET /api/opd/appointments": {
        items: [
          apt({ id: "ap-0", status: "checked_in" }),
          apt({ id: "ap-1", slotStart: "2026-08-18T03:50:00.000Z" }),
        ],
      },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);
    await screen.findByText("Checked in");

    const table = screen.getByRole("table");
    expect(table.tagName).toBe("TABLE");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    const timeCol = headers.indexOf("Time");
    expect(timeCol).toBeGreaterThanOrEqual(0);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = within(row).getAllByRole("cell");
      expect(cells).toHaveLength(headers.length);
      expect(cells[timeCol]).toHaveTextContent(/^\d\d:\d\d$/);
    }
  });

  /**
   * OWNER, 2026-10-01: *"I can see a future appointment for U00110020 in the profile screen but I
   * can't see any appointments for the same patient at /opd/appointments. Why so?"* The screen listed
   * one doctor's book for one day; with nothing chosen it listed nothing.
   */
  it("picking a patient shows the slots they still hold — with no department, doctor or date chosen", async () => {
    stubFetch({
      ...DAY_STUBS,
      "GET /api/opd/appointments": (_init?: RequestInit, url?: string) => (String(url ?? "").includes("patientId=p-1")
        ? { items: [apt({ id: "ap-7", doctorId: "doc-1", serviceDate: "2026-08-21", slotStart: "2026-08-21T06:30:00.000Z" })] }
        : { items: [] }),
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickPatient(user);

    const row = await screen.findByTestId("patient-booking-row");
    expect(row).toHaveTextContent("2026-08-21");
    expect(row).toHaveTextContent("12:00"); // 06:30Z is 12:00 IST
    expect(within(row).getByRole("button", { name: /Reschedule/ })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(callsTo("GET", "/api/opd/slots")).toHaveLength(0); // no doctor was ever chosen
  });

  it("a patient with nothing booked ahead is told so", async () => {
    stubFetch({ ...DAY_STUBS, "GET /api/opd/appointments": { items: [] } });
    renderWithProviders(<OpdAppointments />);
    await pickPatient(userEvent.setup());
    expect(await screen.findByTestId("patient-bookings-none")).toBeInTheDocument();
  });

  it("a link from the profile opens that doctor's day with the patient already in the card", async () => {
    window.history.pushState({}, "", "/opd/appointments?patientId=p-1&departmentId=dep-1&doctorId=doc-1&date=2026-08-21");
    try {
      stubFetch({
        ...DAY_STUBS,
        "GET /api/patients/p-1": { patient: { id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", administrativeGender: "female", dob: null } },
        "GET /api/opd/appointments": { items: [apt({ id: "ap-7", serviceDate: "2026-08-21", slotStart: "2026-08-21T06:30:00.000Z" })] },
      });
      renderWithProviders(<OpdAppointments />);
      await waitFor(() => expect(screen.getByTestId("booking-for")).toHaveTextContent("HMS0000001234"));
      expect(await screen.findByTestId("patient-booking-row")).toHaveTextContent("2026-08-21");
      expect(screen.getByTestId("filter-date")).toHaveValue("2026-08-21");
      // The linked doctor survives the department arriving with it, and that doctor's day is read.
      await waitFor(() => expect(callsTo("GET", "/api/opd/slots")[0]?.url).toBe("/api/opd/slots?doctorId=doc-1&date=2026-08-21"));
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  // ——— tele-call, slice 1 (owner 2026-10-09) ———

  it("TELE-CALL: the switch opens on In person; Tele-call asks for the patient's phone (pre-filled when known) and Confirm waits for a real number", async () => {
    stubFetch({ ...DAY_STUBS, "GET /api/opd/appointments": { items: [] }, "POST /api/opd/appointments": { appointment: apt({ id: "ap-9", mode: "tele", telePhone: "9876543021" }) } });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);
    await screen.findByTestId("slot-2026-08-18T03:30:00.000Z");
    await pickPatient(user);
    await user.click(screen.getByTestId("slot-2026-08-18T03:30:00.000Z"));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByRole("radio", { name: "In person" })).toBeChecked();
    expect(dialog.getByRole("radio", { name: "Tele-call" })).not.toBeChecked();
    expect(dialog.queryByLabelText("Patient's phone")).toBeNull();

    await user.click(dialog.getByRole("radio", { name: "Tele-call" }));
    const phone = dialog.getByLabelText("Patient's phone");
    expect(phone).toHaveValue("9876500000"); // the search row's own mobile
    expect(phone).toHaveAttribute("inputmode", "numeric");

    await user.clear(phone);
    expect(dialog.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
    await user.type(phone, "98765 4302");
    expect(dialog.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
    await user.clear(phone);
    await user.type(phone, "+91 98765 43021");
    expect(dialog.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);

    await user.click(dialog.getByRole("button", { name: "Confirm booking" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/appointments")).toEqual({
      patientId: "p-1", doctorId: "doc-1", slotStart: "2026-08-18T03:30:00.000Z", mode: "tele", telePhone: "9876543021",
    });
  });

  it("TELE-CALL: going back to In person lets Confirm through and sends the booking it always sent", async () => {
    stubFetch({ ...DAY_STUBS, "GET /api/opd/appointments": { items: [] }, "POST /api/opd/appointments": { appointment: apt({ id: "ap-9" }) } });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);
    await screen.findByTestId("slot-2026-08-18T03:30:00.000Z");
    await pickPatient(user);
    await user.click(screen.getByTestId("slot-2026-08-18T03:30:00.000Z"));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("radio", { name: "Tele-call" }));
    await user.clear(dialog.getByLabelText("Patient's phone"));
    expect(dialog.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
    await user.click(dialog.getByRole("radio", { name: "In person" }));
    await user.click(dialog.getByRole("button", { name: "Confirm booking" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/appointments")).toEqual({ patientId: "p-1", doctorId: "doc-1", slotStart: "2026-08-18T03:30:00.000Z" });
  });

  it("TELE-CALL: the day list and the patient's own bookings mark a tele-call with an ICON named Tele-call — no word, and nothing on an in-person row", async () => {
    stubFetch({
      ...DAY_STUBS,
      "GET /api/opd/appointments": { items: [
        apt({ id: "ap-1", mode: "in_person", telePhone: null }),
        apt({ id: "ap-2", mode: "tele", telePhone: null, slotStart: "2026-08-18T04:10:00.000Z", slotEnd: "2026-08-18T04:20:00.000Z",
          patient: { requestedId: "p-2", id: "p-2", uhid: "HMS0000005678", name: "Meena Kumari", alias: null, restricted: false, sex: "female", dob: null } }),
      ] },
    });
    renderWithProviders(<OpdAppointments />);
    const user = userEvent.setup();
    await pickDeptAndDoctor(user);
    const tele = (await screen.findByText("Meena Kumari")).closest("tr")!;
    const inPerson = (await screen.findAllByText("Asha Devi")).map((n) => n.closest("tr")).find((r) => r !== null)!;
    expect(within(tele).getByRole("img", { name: "Tele-call" })).toBeInTheDocument();
    expect(tele).not.toHaveTextContent(/tele/i);
    expect(within(inPerson).queryByRole("img", { name: "Tele-call" })).toBeNull();

    await pickPatient(user);
    const theirs = await screen.findAllByTestId("patient-booking-row");
    expect(theirs).toHaveLength(2);
    expect(theirs.filter((r) => within(r).queryByRole("img", { name: "Tele-call" }) !== null)).toHaveLength(1);
  });
});
