import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { DeskOne } from "../src/screens/desk-one";
import { todayIst } from "../src/vitals/rules";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  let v: string | null = JSON.stringify({ token: "t1", username: "asha.devi" });
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async () => v),
    setItemAsync: jest.fn(async (_k: string, val: string) => { v = val; }),
    deleteItemAsync: jest.fn(async () => { v = null; }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
let scanned: ((data: string) => void) | null = null;
jest.mock("../src/vitals/scanner", () => ({
  Scanner: ({ open, onRead }: { open: boolean; onRead: (d: string) => void }) => { scanned = open ? onRead : null; return null; },
}));

type Reply = { status: number; body?: unknown } | "offline";
type Route = (body: unknown, url: string) => Reply;
type Call = { key: string; body: unknown; idem: string | null; url: string };

function server(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ key, body, idem: headers["Idempotency-Key"] ?? null, url: path });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, path);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const CASHIER = ["patients.read", "patients.register", "opd.visits.open", "opd.visits.read", "opd.queue.read", "opd.masters.read", "opd.paper.reprint", "roster.read", "billing.invoice.read", "billing.invoice.issue", "billing.session.own"];
const FRONT_OFFICE = ["patients.read", "patients.register", "opd.visits.open", "opd.visits.read", "opd.queue.read", "opd.masters.read", "opd.paper.reprint"];
const me = (hospital: string[]) => ({ actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });

import { addDaysIso, slotClock, weekdayOf } from "../src/counter/appointment-rules";

const TODAY = todayIst();
const D1 = addDaysIso(TODAY, 1), D2 = addDaysIso(TODAY, 2), D3 = addDaysIso(TODAY, 3);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (date: string, utc: string): string => `${date}T${utc}:00.000Z`;
const BOOKER = [...FRONT_OFFICE, "roster.read", "opd.appointments.read", "opd.appointments.manage"];
const CASH_BOOKER = [...CASHIER, "opd.appointments.read", "opd.appointments.manage"];
const READER = [...FRONT_OFFICE, "opd.appointments.read"];

const HIT = { id: "p1", uhid: "U00110049", name: "Geeta Devi", phone: "9876543210", administrativeGender: "female", dob: "1984-03-14T00:00:00.000Z", isConfidential: false, matchedOn: ["mobile"] };
const DOCTORS = [
  { id: "d1", userId: "u-d1", displayName: "Dr. Chandan Kumar", departmentId: "med", active: true, designation: "Assistant Professor" },
  { id: "d2", userId: "u-d2", displayName: "Dr. Nitish Kumar Jha", departmentId: "med", active: true, designation: "Assistant Professor" },
  { id: "d3", userId: "u-d3", displayName: "Dr. Kishore Kunal", departmentId: "ort", active: true, designation: "Guest Faculty" },
  { id: "d9", userId: "u-d9", displayName: "Dr. Gone Away", departmentId: "med", active: false },
];
const tpl = (id: string, doctorId: string, date: string, startTime: string, endTime: string) => ({ id, doctorId, weekday: weekdayOf(date), startTime, endTime, roomId: "r5", validFrom: "2026-01-01", validTo: null, active: true });
const appt = (over: Record<string, unknown> = {}) => ({
  id: "a1", appointmentNo: "A2610080003", patientId: "p1", doctorId: "d2", departmentId: "med", serviceDate: D1, slotStart: at(D1, "04:00"), slotEnd: at(D1, "04:15"),
  status: "booked", note: null, encounterId: null, rescheduledToId: null, rescheduledFromId: null, cancelReason: null, ...over,
});
const slot = (date: string, utc: string, over: Record<string, unknown> = {}) => ({ start: at(date, utc), end: new Date(new Date(at(date, utc)).getTime() + 15 * 60_000).toISOString(), roomId: "r5", scheduleId: "t1", booked: false, past: false, ...over });
const QUOTE9 = {
  encounterId: "e9", visitType: "new", free: false, feeServiceId: "svc", freeReason: null, attributionCode: null, intendedPayer: "self",
  draft: { lines: [{ lineId: "l1", serviceId: "svc", serviceName: "OPD consultation — new", qty: 1, grossPaise: 30000, discountPaise: 0, winner: null }], totals: { cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPayablePaise: 30000 } },
  visit: { visitNo: "V2610070009", serviceDate: TODAY, status: "registered", tokenNo: 9, departmentCode: "MED", feeStatus: "unsettled" }, alreadyBilled: null,
};

function world(over: { perms?: string[]; theirs?: () => unknown[]; day?: () => unknown[]; terms?: unknown; routes?: Record<string, Route> } = {}) {
  return server({
    "GET /auth/me": () => ({ status: 200, body: me(over.perms ?? BOOKER) }),
    "GET /opd/config": () => ({ status: 200, body: { counterSequence: "queue_first", tokenLane: "token_first" } }),
    "GET /opd/departments": () => ({ status: 200, body: { items: [{ id: "med", code: "MED", name: "General Medicine", active: true }, { id: "ort", code: "ORT", name: "Orthopaedics", active: true }, { id: "eye", code: "EYE", name: "Ophthalmology", active: true }] } }),
    "GET /billing/consult-terms": () => ({ status: 200, body: over.terms ?? { consultFeeOff: false, paise: { new: 30000, renewal: 15000, revisit: null } } }),
    "GET /roster/doctor-units": () => ({ status: 200, body: [{ userId: "u-d2", short: "Unit I" }] }),
    "GET /opd/queues/summary": () => ({ status: 200, body: { items: [] } }),
    "GET /patients/search": () => ({ status: 200, body: { items: [HIT] } }),
    "GET /patients/p1": () => ({ status: 200, body: { patient: { uhid: "U00110049", name: "Geeta Devi", alias: null, dob: "1984-03-14T00:00:00.000Z", phone: "9876543210", addressLine: "Hajipur", administrativeGender: "female" } } }),
    "GET /patients/p1/linked": () => ({ status: 200, body: { numbers: [], total: 0, items: [] } }),
    "GET /opd/patients/p1/timeline": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/doctors": () => ({ status: 200, body: { items: DOCTORS } }),
    "GET /opd/rooms": () => ({ status: 200, body: { items: [{ id: "r5", code: "R5", name: "Room 5", active: true }] } }),
    // d2 sits on tomorrow's weekday (two sessions) and the day after's; d3 on tomorrow's only.
    "GET /opd/doctors/d2/schedules": () => ({ status: 200, body: { items: [tpl("t1", "d2", D1, "09:00:00", "11:00:00"), tpl("t2", "d2", D1, "13:00:00", "15:00:00"), tpl("t3", "d2", D2, "09:00:00", "11:00:00")] } }),
    "GET /opd/doctors/d3/schedules": () => ({ status: 200, body: { items: [tpl("t4", "d3", D1, "10:00:00", "12:00:00")] } }),
    "GET /opd/doctors/d1/schedules": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/leaves": (_b, url) => ({ status: 200, body: { items: url.includes("doctorId=d2") ? [{ id: "lv", doctorId: "d2", fromDate: D2, toDate: D2, reason: "conference at Patna", status: "scheduled" }] : [] } }),
    "GET /opd/slots": (_b, url) => ({ status: 200, body: { slots: url.includes(`date=${D1}`) ? [slot(D1, "03:30", { booked: true }), slot(D1, "04:00"), slot(D1, "04:15"), slot(D1, "07:30")] : [] } }),
    "GET /opd/appointments": (_b, url) => ({ status: 200, body: { items: url.includes("patientId=") ? (over.theirs ?? (() => []))() : (over.day ?? (() => []))() } }),
    ...(over.routes ?? {}),
  });
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <DeskOne /> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi" = "en") {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
  await screen.findByTestId("counter-query", {}, { timeout: 5_000 });
}
async function findAndHold() {
  await fireEvent.changeText(screen.getByTestId("counter-query"), "98765 43210");
  await fireEvent.press(screen.getByTestId("counter-find"));
  await fireEvent.press(await screen.findByTestId("hit-p1"));
  await screen.findByTestId("counter-person");
}
/** Person in hand → the booking screen → General Medicine → Dr. Nitish → (tomorrow is picked) → morning → 09:30. */
async function toConfirm() {
  await fireEvent.press(await screen.findByTestId("person-book"));
  await fireEvent.press(await screen.findByTestId("book-dept-med"));
  await fireEvent.press(await screen.findByTestId("book-doctor-d2"));
  await fireEvent.press(await screen.findByTestId("book-part-morning"));
  await fireEvent.press(await screen.findByTestId("book-slot-09:30"));
  await screen.findByTestId("book-confirm");
}

describe("appointments on the phone's Desk One", () => {
  it("books: department → doctor (unit beside the name, the days they sit) → the first open day → morning / noon / evening → the slot — and takes no money", async () => {
    let booked: unknown[] = [];
    const s = world({ theirs: () => booked, routes: { "POST /opd/appointments": (b) => { booked = [appt({ ...(b as object) })]; return { status: 201, body: { appointment: appt() } }; } } });
    await mount(s.fetcher);
    await findAndHold();
    expect(await screen.findByTestId("appts-none")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("person-book"));
    // Only departments with an active doctor are offered; an inactive doctor is not.
    await screen.findByTestId("book-dept-med");
    expect(screen.queryByTestId("book-dept-eye")).toBeNull();
    await fireEvent.press(screen.getByTestId("book-dept-med"));
    expect(screen.queryByTestId("book-doctor-d9")).toBeNull();
    expect(await screen.findByTestId("book-doctor-d2")).toHaveTextContent(/Unit I · Asst\. Prof\./);
    await fireEvent.press(screen.getByTestId("book-doctor-d2"));
    const sits = [weekdayOf(D1), weekdayOf(D2)].sort((a, b) => a - b).map((w) => WD[w]).join(", ");
    await waitFor(() => expect(screen.getByTestId("book-sits")).toHaveTextContent(`Sits ${sits}`));
    // Today is not a sitting day, so tomorrow — the first OPEN day — is the one picked; both sessions show on its chip.
    await waitFor(() => expect(screen.getByTestId(`book-day-${D1}`).props.accessibilityState).toMatchObject({ selected: true }));
    expect(screen.getByTestId(`book-day-${D1}`)).toHaveTextContent(/09:00 · 13:00/);
    expect(screen.getByTestId(`book-day-${TODAY}`).props.accessibilityState).toMatchObject({ disabled: true });
    // The server's slots, counted per part: 09:00 is taken, so the morning has two free; no evening session.
    expect(await screen.findByTestId("book-part-free-morning")).toHaveTextContent("2 free");
    expect(screen.getByTestId("book-part-free-noon")).toHaveTextContent("1 free");
    expect(screen.getByTestId("book-part-free-evening")).toHaveTextContent("no session");
    expect(screen.getByTestId("book-go")).toHaveTextContent("Pick a time");
    await fireEvent.press(screen.getByTestId("book-part-morning"));
    expect((await screen.findByTestId("book-slot-09:00")).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByTestId("book-slot-09:30"));
    expect(await screen.findByTestId("book-confirm-when")).toHaveTextContent(/09:30–09:45/);
    expect(screen.getByTestId("book-confirm")).toHaveTextContent(/Room R5/);
    expect(screen.getByTestId("book-fee")).toHaveTextContent(/Nothing is collected now.*checks in/);
    await fireEvent.changeText(screen.getByTestId("book-note"), " needs wheelchair ");
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-done-word")).toHaveTextContent("Booked");
    expect(screen.getByTestId("book-done-no")).toHaveTextContent("A2610080003");
    expect(s.of("POST /opd/appointments")[0]!.body).toEqual({ patientId: "p1", doctorId: "d2", slotStart: at(D1, "04:00"), note: "needs wheelchair" });
    // No fee route, no bill and no paper is asked for a booking.
    expect(s.calls.some((c) => c.key.startsWith("POST /billing") || c.key.includes("fee-quote") || c.key.startsWith("POST /print"))).toBe(false);
    await fireEvent.press(screen.getByTestId("book-done-close"));
    expect(await screen.findByTestId("counter-flash")).toHaveTextContent(/Booked for .* 09:30/);
    expect(await screen.findByTestId("appt-a1")).toHaveTextContent(/09:30/);
  });

  it("a closed day is explained, never skipped silently: leave with its reason; a weekday the doctor does not sit", async () => {
    const s = world();
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("person-book"));
    await fireEvent.press(await screen.findByTestId("book-dept-med"));
    await fireEvent.press(await screen.findByTestId("book-doctor-d2"));
    await waitFor(() => expect(screen.getByTestId(`book-day-${D2}`)).toHaveTextContent(/on leave/));
    await fireEvent.press(screen.getByTestId(`book-day-${D2}`));
    expect(await screen.findByTestId("book-day-closed")).toHaveTextContent(/Dr\. Nitish Kumar Jha is on leave on .* — conference at Patna\./);
    await fireEvent.press(screen.getByTestId(`book-day-${D3}`));
    expect(screen.getByTestId("book-day-closed")).toHaveTextContent(/does not sit on .*\. Sits /);
    // The day in hand did not move, and no slot read was made for a closed day.
    expect(screen.getByTestId(`book-day-${D1}`).props.accessibilityState).toMatchObject({ selected: true });
    expect(s.of("GET /opd/slots").every((c) => c.url.includes(`date=${D1}`))).toBe(true);
    // Eight weeks sit behind one tap.
    expect(screen.queryByTestId(`book-day-${addDaysIso(TODAY, 20)}`)).toBeNull();
    await fireEvent.press(screen.getByTestId("book-more-days"));
    expect(screen.getByTestId(`book-day-${addDaysIso(TODAY, 20)}`)).toBeTruthy();
  });

  it("a day the SCREEN picked that has nothing free is stepped past to the next open day; a day the clerk tapped is shown as it is", async () => {
    // d3 sits tomorrow only (weekly): tomorrow is full, so the same weekday next week is the first day with a free slot.
    const D8 = addDaysIso(D1, 7);
    const s = world({ routes: { "GET /opd/slots": (_b, url) => ({ status: 200, body: { slots: url.includes(`date=${D1}`) ? [slot(D1, "04:30", { booked: true })] : url.includes(`date=${D8}`) ? [slot(D8, "04:30")] : [] } }) } });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("person-book"));
    await fireEvent.press(await screen.findByTestId("book-dept-ort"));
    await fireEvent.press(await screen.findByTestId("book-doctor-d3"));
    await fireEvent.press(await screen.findByTestId("book-more-days"));
    await waitFor(() => expect(screen.getByTestId(`book-day-${D8}`).props.accessibilityState).toMatchObject({ selected: true }));
    expect(await screen.findByTestId("book-slot-10:00")).toBeTruthy();
    // Tapping the full day shows it, full — the screen does not run away from the clerk's own choice.
    await fireEvent.press(screen.getByTestId(`book-day-${D1}`));
    expect(await screen.findByTestId("book-part-free-morning")).toHaveTextContent("full");
    expect(screen.getByTestId(`book-day-${D1}`).props.accessibilityState).toMatchObject({ selected: true });
  });

  it("a refusal is the server's own words, the board is read again, and nothing is locked", async () => {
    const s = world({ routes: { "POST /opd/appointments": () => ({ status: 409, body: { code: "slot_taken", message: "That slot has just been taken — pick another" } }) } });
    await mount(s.fetcher);
    await findAndHold();
    await toConfirm();
    const before = s.of("GET /opd/slots").length;
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-error")).toHaveTextContent(/just been taken/);
    await waitFor(() => expect(s.of("GET /opd/slots").length).toBe(before + 1));
    expect(screen.getByTestId("book-go")).toHaveTextContent("Pick a time");
    expect(screen.getByTestId("book-close")).toBeTruthy();
  });

  it("LOST ANSWER, and it had landed: the choice is locked, the server is READ first, and nothing is booked twice", async () => {
    let landed = false;
    const s = world({ theirs: () => (landed ? [appt()] : []), routes: { "POST /opd/appointments": () => { landed = true; return "offline"; } } });
    await mount(s.fetcher);
    await findAndHold();
    await toConfirm();
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-error")).toHaveTextContent(/NOT known whether the booking was made/);
    // Locked: another slot cannot be picked and the screen cannot be left as if nothing happened.
    expect(screen.getByTestId("book-slot-09:45").props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.queryByTestId("book-close")).toBeNull();
    expect(screen.getByTestId("book-go")).toHaveTextContent("Check again");
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-done-word")).toHaveTextContent("Booked");
    expect(s.of("POST /opd/appointments")).toHaveLength(1);
  });

  it("LOST ANSWER, and it had NOT landed: after the read finds nothing, the SAME request goes again", async () => {
    let n = 0;
    const s = world({ routes: { "POST /opd/appointments": () => (++n === 1 ? "offline" : { status: 201, body: { appointment: appt() } }) } });
    await mount(s.fetcher);
    await findAndHold();
    await toConfirm();
    await fireEvent.press(screen.getByTestId("book-go"));
    await screen.findByTestId("book-error");
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-done-word")).toHaveTextContent("Booked");
    const sent = s.of("POST /opd/appointments");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  it("consultation switched off reads ₹0 (समाज सेवा छूट) on the booking, in either language", async () => {
    const s = world({ terms: { consultFeeOff: true, paise: { new: 30000, renewal: 15000, revisit: null } } });
    await mount(s.fetcher, "hi");
    await findAndHold();
    await toConfirm();
    expect(screen.getByTestId("book-fee")).toHaveTextContent(/₹0 \(समाज सेवा छूट\)/);
    expect(screen.getByTestId("book-go")).toHaveTextContent(/09:30 · .* बुक करें/);
  });

  it("the same patient already booked that day is said before the second booking is made", async () => {
    const s = world({ theirs: () => [appt({ id: "a0", doctorId: "d1", slotStart: at(D1, "05:00") })] });
    await mount(s.fetcher);
    await findAndHold();
    await toConfirm();
    expect(screen.getByTestId("book-same-day")).toHaveTextContent(/Geeta Devi already has 1 booking that day — 10:30/);
  });

  it("CHECK-IN: today's booking becomes the visit and the desk goes on to its bill; a future booking offers no check-in", async () => {
    const today = appt({ id: "a2", serviceDate: TODAY, slotStart: at(TODAY, "04:00"), slotEnd: at(TODAY, "04:15") });
    const s = world({
      perms: CASH_BOOKER, theirs: () => [today, appt()],
      routes: {
        "POST /opd/appointments/a2/check-in": () => ({ status: 201, body: { encounter: { id: "e9", visitNo: "V2610070009", patientId: "p1", status: "registered", visitType: "new", departmentId: "med", doctorId: "d2" }, tokenNo: 9, sessionId: "s", roomId: "r5", visitType: "new" } }),
        "GET /billing/visits/e9/fee-quote": () => ({ status: 200, body: QUOTE9 }),
        "GET /billing/sessions/current": () => ({ status: 200, body: { session: { id: "cs1", status: "open", openedAt: at(TODAY, "03:30"), openingFloatPaise: 0 } } }),
        "GET /print/jobs": () => ({ status: 200, body: { jobs: [] } }),
      },
    });
    await mount(s.fetcher);
    await findAndHold();
    expect(await screen.findByTestId("appt-a2")).toHaveTextContent(/Today · 09:30/);
    expect(screen.getByTestId("appt-a2")).toHaveTextContent(/Dr\. Nitish Kumar Jha · General Medicine/);
    expect(screen.queryByTestId("appt-checkin-a1")).toBeNull();
    await fireEvent.press(screen.getByTestId("appt-checkin-a2"));
    expect(await screen.findByTestId("token-no")).toHaveTextContent("MED-9");
    expect(screen.getByTestId("counter-flash")).toHaveTextContent(/booking is now today's visit/);
    // The NORMAL bill step: the server's own quote for the visit the check-in opened.
    expect(await screen.findByTestId("bill-total")).toHaveTextContent("₹300");
    expect(screen.getByTestId("settle")).toHaveTextContent(/Collect ₹300/);
    expect(s.of("POST /opd/walk-in")).toHaveLength(0);
  });

  it("CHECK-IN, lost answer that HAD landed: the server is read, the visit it already made is opened, and nothing is re-sent", async () => {
    let landed = false;
    const row = (): unknown => appt({ id: "a2", serviceDate: TODAY, slotStart: at(TODAY, "04:00"), slotEnd: at(TODAY, "04:15"), ...(landed ? { status: "checked_in", encounterId: "e9" } : {}) });
    const s = world({
      theirs: () => [row()],
      routes: {
        "POST /opd/appointments/a2/check-in": () => { landed = true; return "offline"; },
        "GET /opd/patients/p1/timeline": () => ({ status: 200, body: { items: landed ? [{ encounterId: "e9", visitNo: "V2610070009", serviceDate: TODAY, status: "registered", visitType: "new", doctorId: "d2", doctorName: "Dr. Nitish Kumar Jha", departmentId: "med", departmentName: "General Medicine" }] : [] } }),
      },
    });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("appt-checkin-a2"));
    expect(await screen.findByTestId("appt-error-a2")).toHaveTextContent(/NOT known whether the check-in went through/);
    // Locked to the one honest act: no move, no cancel, while it is not known.
    expect(screen.queryByTestId("appt-move-a2")).toBeNull();
    expect(screen.getByTestId("appt-checkin-a2")).toHaveTextContent("Check again");
    await fireEvent.press(screen.getByTestId("appt-checkin-a2"));
    expect(await screen.findByTestId("visit-no")).toHaveTextContent("V2610070009");
    expect(s.of("POST /opd/appointments/a2/check-in")).toHaveLength(1);
  });

  it("a check-in the server refuses is said beside that booking, in the server's words", async () => {
    const s = world({
      theirs: () => [appt({ id: "a2", serviceDate: TODAY, slotStart: at(TODAY, "04:00") })],
      routes: { "POST /opd/appointments/a2/check-in": () => ({ status: 409, body: { code: "doctor_out", message: "The doctor has stepped out — the visit cannot be opened yet" } }) },
    });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("appt-checkin-a2"));
    expect(await screen.findByTestId("appt-error-a2")).toHaveTextContent(/stepped out/);
    expect(screen.getByTestId("counter-step")).toHaveTextContent(/Patient/i);
  });

  it("CANCEL is two acts and a reason: a blank one is refused here in the web's sentence and nothing is sent", async () => {
    let rows = [appt()];
    const s = world({ theirs: () => rows, routes: { "POST /opd/appointments/a1/cancel": () => { rows = []; return { status: 201, body: { appointment: appt({ status: "cancelled" }) } }; } } });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("appt-cancel-a1"));
    await fireEvent.press(await screen.findByTestId("appt-cancel-yes-a1"));
    expect(await screen.findByTestId("appt-error-a1")).toHaveTextContent("Say why the appointment is being cancelled.");
    expect(s.of("POST /opd/appointments/a1/cancel")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("appt-cancel-reason-a1"), " patient rang, travelling ");
    await fireEvent.press(screen.getByTestId("appt-cancel-yes-a1"));
    expect(await screen.findByTestId("counter-flash")).toHaveTextContent(/cancelled\. The slot is back on the board/);
    expect(s.of("POST /opd/appointments/a1/cancel")[0]!.body).toEqual({ reason: "patient rang, travelling" });
    expect(await screen.findByTestId("appts-none")).toBeTruthy();
  });

  it("MOVE to a doctor of ANOTHER department asks why first (owner 2026-10-05) and sends the reason; the same department asks nothing", async () => {
    const s = world({
      theirs: () => [appt()],
      routes: {
        "GET /opd/slots": () => ({ status: 200, body: { slots: [slot(D1, "04:30")] } }),
        "POST /opd/appointments/a1/reschedule": (b) => ({ status: 201, body: { from: appt({ status: "rescheduled", rescheduledToId: "a7" }), to: appt({ id: "a7", doctorId: (b as { doctorId: string }).doctorId, departmentId: "ort", slotStart: at(D1, "04:30"), appointmentNo: "A2610080009" }) } }),
      },
    });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("appt-move-a1"));
    // The booking's own doctor and department are in hand; the title says what is being moved.
    expect(await screen.findByTestId("book-title")).toHaveTextContent(/Moving Geeta Devi — was .* 09:30/);
    await waitFor(() => expect(screen.getByTestId("book-doctor-d2").props.accessibilityState).toMatchObject({ selected: true }));
    await fireEvent.press(await screen.findByTestId("book-slot-10:00"));
    expect(screen.queryByTestId("book-cross")).toBeNull();
    // Now another department.
    await fireEvent.press(screen.getByTestId("book-dept-ort"));
    await fireEvent.press(await screen.findByTestId("book-doctor-d3"));
    await fireEvent.press(await screen.findByTestId("book-slot-10:00"));
    expect(await screen.findByTestId("book-cross")).toHaveTextContent(/from General Medicine to Orthopaedics/);
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-error")).toHaveTextContent("Write why the patient is being moved — it is recorded.");
    expect(s.of("POST /opd/appointments/a1/reschedule")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("book-reason"), "booked in medicine by mistake");
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-done-word")).toHaveTextContent("Moved");
    expect(s.of("POST /opd/appointments/a1/reschedule")[0]!.body).toEqual({ slotStart: at(D1, "04:30"), doctorId: "d3", reason: "booked in medicine by mistake" });
  });

  it("MOVE, lost answer that had landed: the old row names its successor, and nothing is moved twice", async () => {
    let landed = false;
    const s = world({
      theirs: () => (landed ? [appt({ status: "rescheduled", rescheduledToId: "a7" }), appt({ id: "a7", slotStart: at(D1, "04:15") })] : [appt()]),
      routes: { "POST /opd/appointments/a1/reschedule": () => { landed = true; return "offline"; } },
    });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("appt-move-a1"));
    await fireEvent.press(await screen.findByTestId("book-part-morning"));
    await fireEvent.press(await screen.findByTestId("book-slot-09:45"));
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-error")).toHaveTextContent(/NOT known whether the booking was moved/);
    await fireEvent.press(screen.getByTestId("book-go"));
    expect(await screen.findByTestId("book-done-when")).toHaveTextContent("09:45");
    expect(s.of("POST /opd/appointments/a1/reschedule")).toHaveLength(1);
  });

  it("a booking a doctor's leave has stranded says so in words and leads with Re-book; it cannot be checked in", async () => {
    const s = world({ theirs: () => [appt({ id: "a5", status: "needs_rebooking", serviceDate: TODAY, slotStart: at(TODAY, "04:00") })] });
    await mount(s.fetcher);
    await findAndHold();
    expect(await screen.findByTestId("appt-stranded-a5")).toHaveTextContent(/on leave that day/);
    expect(screen.getByTestId("appt-move-a5")).toHaveTextContent("Re-book");
    expect(screen.queryByTestId("appt-checkin-a5")).toBeNull();
  });

  it("what the login may do is what is offered: read-only sees the bookings with no book / move / cancel; without the read, nothing", async () => {
    const s = world({ perms: READER, theirs: () => [appt()] });
    await mount(s.fetcher);
    await findAndHold();
    expect(await screen.findByTestId("appt-a1")).toBeTruthy();
    expect(screen.queryByTestId("person-book")).toBeNull();
    expect(screen.queryByTestId("appt-move-a1")).toBeNull();
    expect(screen.queryByTestId("appt-cancel-a1")).toBeNull();
    const none = world({ perms: FRONT_OFFICE });
    await mount(none.fetcher);
    expect(screen.queryByTestId("appts-open")).toBeNull();
    expect(none.of("GET /opd/appointments")).toHaveLength(0);
    expect(none.of("GET /opd/doctors")).toHaveLength(0);
  });

  it("the desk's day: counts, plain state words (missed is the clock's answer), a doctor filter and a search — a row takes the patient in hand", async () => {
    const past = new Date(Date.now() - 2 * 3_600_000), ahead = new Date(Date.now() + 2 * 3_600_000);
    const mk = (id: string, name: string, doctorId: string, start: Date, status = "booked") => appt({
      id, doctorId, serviceDate: TODAY, slotStart: start.toISOString(), slotEnd: new Date(start.getTime() + 15 * 60_000).toISOString(), status,
      patient: { id: id === "b1" ? "p1" : `p-${id}`, uhid: id === "b1" ? "U00110049" : `U-${id}`, name, alias: null, restricted: false }, patientId: id === "b1" ? "p1" : `p-${id}`,
    });
    const s = world({ day: () => [mk("b1", "Geeta Devi", "d2", ahead), mk("b2", "Suresh Prasad", "d2", past), mk("b3", "Meena Kumari", "d3", past, "checked_in"), mk("b4", "Old Row", "d3", past, "rescheduled")] });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("appts-open"));
    expect(await screen.findByTestId("desk-appts-counts")).toHaveTextContent(/1 arrived · 1 to arrive · 1 missed/);
    expect(s.of("GET /opd/appointments")[0]!.url).toContain(`serviceDate=${TODAY}`);
    expect(screen.getByTestId("desk-appt-state-b2")).toHaveTextContent("MISSED");
    expect(screen.getByTestId("desk-appt-state-b3")).toHaveTextContent("ARRIVED");
    expect(screen.queryByTestId("desk-appt-b4")).toBeNull(); // a moved booking is not somebody to expect
    await fireEvent.press(screen.getByTestId("desk-appts-doc-d3"));
    expect(screen.queryByTestId("desk-appt-b1")).toBeNull();
    expect(screen.getByTestId("desk-appts-counts")).toHaveTextContent(/1 arrived · 0 to arrive · 0 missed/);
    await fireEvent.press(screen.getByTestId("desk-appts-doc-all"));
    await fireEvent.changeText(screen.getByTestId("desk-appts-q"), "gee");
    expect(screen.queryByTestId("desk-appt-b2")).toBeNull();
    await fireEvent.press(screen.getByTestId("desk-appt-b1"));
    expect(await screen.findByTestId("counter-person")).toHaveTextContent(/Geeta Devi/);
    // The row carried no sex or age: the patient's own record supplies them.
    await waitFor(() => expect(screen.getByTestId("counter-person")).toHaveTextContent(/42y · F|4\dy · F/));
  });

  it("the re-booking list reads telephone numbers ONLY when it is opened, is today-forward, and Re-book opens the move with that doctor in hand", async () => {
    const stranded = appt({ id: "a5", status: "needs_rebooking", serviceDate: D2, slotStart: at(D2, "04:00"), patient: { id: "p1", uhid: "U00110049", name: "Geeta Devi", alias: null, restricted: false, phone: "9876543210" } });
    const stale = appt({ id: "a6", status: "needs_rebooking", serviceDate: "2026-01-05", slotStart: "2026-01-05T04:00:00.000Z", patient: { id: "p7", uhid: "U7", name: "Long Ago", alias: null, restricted: false, phone: null } });
    const s = world({ theirs: () => [stranded], routes: { "GET /opd/appointments": (_b, url) => ({ status: 200, body: { items: url.includes("needsRebooking=true") ? [stale, stranded] : url.includes("patientId=") ? [stranded] : [] } }) } });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("appts-open"));
    await screen.findByTestId("desk-appts-none");
    expect(s.of("GET /opd/appointments").some((c) => c.url.includes("contact=true"))).toBe(false);
    await fireEvent.press(screen.getByTestId("desk-appts-tab-rebook"));
    expect(await screen.findByTestId("rebook-count")).toHaveTextContent(/^1 booking to move/);
    expect(s.of("GET /opd/appointments").filter((c) => c.url.includes("needsRebooking=true&contact=true"))).toHaveLength(1);
    expect(screen.queryByTestId("rebook-a6")).toBeNull();
    expect(screen.getByTestId("rebook-phone-a5")).toHaveTextContent("9876543210");
    expect(screen.getByTestId("rebook-call-a5")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("rebook-go-a5"));
    expect(await screen.findByTestId("book-title")).toHaveTextContent(/Moving Geeta Devi/);
    await waitFor(() => expect(screen.getByTestId("book-doctor-d2").props.accessibilityState).toMatchObject({ selected: true }));
    // The stranded day is the leave day: it is shown closed and the first OPEN day is the one in hand.
    await waitFor(() => expect(screen.getByTestId(`book-day-${D1}`).props.accessibilityState).toMatchObject({ selected: true }));
    expect(slotClock(at(D1, "04:00"))).toBe("09:30");
  });

  it("reads in Hindi", async () => {
    const s = world({ theirs: () => [appt({ id: "a2", serviceDate: TODAY, slotStart: at(TODAY, "04:00") })] });
    await mount(s.fetcher, "hi");
    await findAndHold();
    expect(await screen.findByTestId("appt-a2")).toHaveTextContent(/आज · 09:30/);
    expect(screen.getByTestId("appt-checkin-a2")).toHaveTextContent("चेक-इन — मरीज़ आ गए हैं");
    expect(screen.getByTestId("person-book")).toHaveTextContent("अपॉइंटमेंट बुक करें");
  });
});
