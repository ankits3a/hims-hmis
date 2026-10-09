import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attendanceTodaySummary } from "../src/attendance/api";
import { AttendanceManage } from "../src/screens/attendance-manage";
import { AttendancePerson } from "../src/screens/attendance-person";
import { mount, nowMs, server } from "../testing/attendance";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "committee.one", since: "2026-10-14T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

const ALL = ["attendance.all.read"];
const row = (pin: string, name: string, dept: string, status: string | null, firstIn: string | null, hasLogin = true) =>
  ({ pin, name, dept, post: "Staff", status, known: true, firstIn, lastOut: null, onDuty: firstIn !== null, hasLogin });
const PEOPLE = [
  row("101", "Dr. Chandan Kumar", "Medicine", "on_time", "08:51"),
  row("102", "Pooja Kumari", "Slip desk", "late", "09:34"),
  row("103", "Dr. Kishore Kunal", "Orthopaedics", "absent", null),
  row("104", "R. Mishra", "College", "on_time", "08:40", false),
  row("105", "Dr. P. Singh", "Medicine", "approved_leave", null),
  row("106", "Anita Thomas", "Nursing", null, null, false),
];
const TODAY_LIST = { date: "2026-10-14", configured: true, people: PEOPLE, summary: { total: 6, byStatus: {}, byDept: [] } };
const SYNC = { configured: true, enabled: true, cursor: 1, onDutyAsOf: "2026-10-14 10:42:00", lastErrorClass: null, stages: { today: { lastAttemptAt: "2026-10-14T05:12:00.000Z", lastOkAt: "2026-10-14T05:12:00.000Z", lastOutcome: "ok" } } };
const queue = (id: string, over: Record<string, unknown> = {}) => ({
  id, date: "2026-10-09", reasonCode: "one_punch_only", note: null, status: "open", createdAt: "2026-10-14T02:30:00.000Z", closedAt: null, closeNote: null,
  name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof", ageHours: 3, seenAt: null, ...over,
});
const SELF_ROUTES = ["GET /attendance/me", "GET /attendance/me/punches", "GET /attendance/me/requests"];
const order = (): string[] => screen.getAllByTestId(/^att-person-/).map((n) => String(n.props.testID).slice("att-person-".length));

describe("staff attendance for those who may see it (board frames 4 and 6)", () => {
  beforeEach(() => { mockPush.mockClear(); });

  it("COMMITTEE, today: everyone on the machine, 'Not in' first, times and Late shown, 'no login' marked, as of the last sync", async () => {
    const s = server(ALL, { "GET /attendance/today": { status: 200, body: TODAY_LIST }, "GET /attendance/sync-state": { status: 200, body: SYNC } });
    await mount(s.fetcher, <AttendanceManage />);
    await screen.findByTestId("att-today-list");
    // Not in first (by name), then who came with the latest first-in on top, then leave.
    expect(order()).toEqual(["106", "103", "102", "101", "104", "105"]);
    expect(screen.getByTestId("att-person-103")).toHaveTextContent(/^Dr\. Kishore KunalOrthopaedicsNot in$/);
    expect(screen.getByTestId("att-person-102")).toHaveTextContent(/^Pooja KumariSlip desk09:34Late$/);
    expect(screen.getByTestId("att-person-101")).toHaveTextContent(/^Dr\. Chandan KumarMedicine08:51$/);
    expect(screen.getByTestId("att-person-104")).toHaveTextContent(/^R\. MishraCollege · no login08:40$/);
    expect(screen.getByTestId("att-person-106")).toHaveTextContent(/^Anita ThomasNursing · no loginNot in$/);
    expect(screen.getByTestId("att-person-105")).toHaveTextContent(/^Dr\. P\. SinghMedicineLeave$/);
    expect(screen.getByTestId("att-count-in")).toHaveTextContent(/^3In$/);
    expect(screen.getByTestId("att-count-notIn")).toHaveTextContent(/^2Not in$/);
    expect(screen.getByTestId("att-count-late")).toHaveTextContent(/^1Late$/);
    expect(screen.getByTestId("att-count-leave")).toHaveTextContent(/^1Leave$/);
    expect(screen.getByTestId("att-as-of")).toHaveTextContent("as of 10:42");
    expect(screen.queryByTestId("att-not-connected")).toBeNull();
    // A manager's screen asks nothing about the manager's own attendance.
    expect(s.keys().filter((k) => SELF_ROUTES.includes(k))).toEqual([]);
  });

  it("a department chip and the name search narrow the list — and the counts with it", async () => {
    const s = server(ALL, { "GET /attendance/today": { status: 200, body: TODAY_LIST }, "GET /attendance/sync-state": { status: 200, body: SYNC } });
    await mount(s.fetcher, <AttendanceManage />);
    fireEvent.press(await screen.findByTestId("att-dept-Medicine"));
    await waitFor(() => expect(order()).toEqual(["101", "105"]));
    expect(screen.getByTestId("att-count-in")).toHaveTextContent(/^1In$/);
    // The search narrows within the chosen department: no Kumari works in Medicine.
    fireEvent.changeText(screen.getByTestId("att-search"), "kumari");
    await waitFor(() => expect(screen.getByTestId("att-today-list")).toHaveTextContent("Nobody matches"));
    fireEvent.press(screen.getByTestId("att-dept-all"));
    await waitFor(() => expect(order()).toEqual(["102"]));
    expect(s.sent("GET /attendance/today")).toHaveLength(1); // narrowed on the phone, not asked again
  });

  it("a row opens that person; the machine not connected is said plainly, with no 'as of'", async () => {
    const s = server(ALL, { "GET /attendance/today": { status: 200, body: { ...TODAY_LIST, configured: false } }, "GET /attendance/sync-state": { status: 200, body: { ...SYNC, configured: false } } });
    await mount(s.fetcher, <AttendanceManage />);
    expect(await screen.findByTestId("att-not-connected")).toHaveTextContent("Machine not connected");
    expect(screen.queryByTestId("att-as-of")).toBeNull();
    fireEvent.press(screen.getByTestId("att-person-104"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/attendance-person", params: { pin: "104", name: "R. Mishra" } });
  });

  it("COMMITTEE, requests: open ones with name · day · reason · age; Seen moves it; Close takes an optional note", async () => {
    const state = { open: [queue("r1"), queue("r2", { name: "Sunita Devi", date: "2026-10-06", ageHours: 52, note: "Forgot" })] as ReturnType<typeof queue>[], seen: [] as ReturnType<typeof queue>[], closed: [] as ReturnType<typeof queue>[] };
    const s = server(ALL, {
      "GET /attendance/today": { status: 200, body: TODAY_LIST }, "GET /attendance/sync-state": { status: 200, body: SYNC },
      "GET /attendance/requests": (_b, url) => { const k = (/status=(\w+)/.exec(url)?.[1] ?? "open") as "open" | "seen" | "closed"; return { status: 200, body: { status: k, requests: state[k] } }; },
      "POST /attendance/requests/r1/seen": () => { state.seen = [{ ...state.open[0]!, status: "seen" }]; state.open = state.open.slice(1); return { status: 200, body: { request: state.seen[0] } }; },
      "POST /attendance/requests/r2/close": (body) => { state.closed = [{ ...state.open[0]!, status: "closed", closeNote: (body as { note?: string }).note ?? null }]; state.open = []; return { status: 200, body: { request: state.closed[0] } }; },
    });
    await mount(s.fetcher, <AttendanceManage tab="requests" />);
    expect(await screen.findByTestId("att-request-r1")).toHaveTextContent(/^Dr A Kumar3 hFri 9 · Only one punch that daySeenClose$/);
    expect(screen.getByTestId("att-request-r2")).toHaveTextContent(/^Sunita Devi2 dTue 6 · Only one punch that dayForgotSeenClose$/);

    fireEvent.press(screen.getByTestId("att-request-seen-r1"));
    await waitFor(() => expect(screen.queryByTestId("att-request-r1")).toBeNull());
    expect(s.sent("POST /attendance/requests/r1/seen")).toHaveLength(1);

    fireEvent.press(screen.getByTestId("att-request-close-r2"));
    fireEvent.changeText(await screen.findByTestId("att-request-note"), "  Met on Monday  ");
    await waitFor(() => expect(screen.getByTestId("att-request-note").props.value).toBe("  Met on Monday  "));
    fireEvent.press(screen.getByTestId("att-request-close-confirm"));
    expect(await screen.findByTestId("att-req-none")).toHaveTextContent("No requests");
    expect(s.sent("POST /attendance/requests/r2/close").map((c) => c.body)).toEqual([{ note: "Met on Monday" }]);

    fireEvent.press(screen.getByTestId("att-req-seen"));
    expect(await screen.findByTestId("att-request-r1")).toHaveTextContent(/Dr A Kumar.*Close$/); // seen: only Close is left
    expect(screen.queryByTestId("att-request-seen-r1")).toBeNull();
    fireEvent.press(screen.getByTestId("att-req-closed"));
    expect(await screen.findByTestId("att-request-close-note-r2")).toHaveTextContent("Met on Monday");
    expect(screen.queryByTestId("att-request-close-r2")).toBeNull(); // closed: nothing left to do
  });

  it("closing with no note sends none; a refusal is said and nothing is lost", async () => {
    const s = server(ALL, {
      "GET /attendance/requests": { status: 200, body: { status: "open", requests: [queue("r1")] } },
      "POST /attendance/requests/r1/close": { status: 500, body: { message: "boom" } },
    });
    await mount(s.fetcher, <AttendanceManage tab="requests" />);
    fireEvent.press(await screen.findByTestId("att-request-close-r1"));
    fireEvent.press(await screen.findByTestId("att-request-close-confirm"));
    expect(await screen.findByTestId("att-req-failed")).toHaveTextContent("Not saved — try again");
    expect(s.sent("POST /attendance/requests/r1/close").map((c) => c.body)).toEqual([{}]);
    expect(screen.getByTestId("att-request-r1")).toBeTruthy();
  });

  it("A HEAD sees ONLY their team: no tabs, no 'today', no requests — and asks for neither", async () => {
    const team = { date: "2026-10-14", summary: { total: 4, linked: 3 }, members: [
      { userId: "u1", name: "Dr. Ritu Kumari", linked: true, pin: "201", today: { status: "on_time", known: true, firstIn: "08:49", lastOut: null, onDuty: true } },
      { userId: "u2", name: "Dr. Anand Rao", linked: true, pin: "202", today: { status: "late", known: true, firstIn: "09:18", lastOut: null, onDuty: true } },
      { userId: "u3", name: "Dr. S. Verma", linked: true, pin: "203", today: { status: "absent", known: true, firstIn: null, lastOut: null, onDuty: false } },
      { userId: "u4", name: "Dr. New Joiner", linked: false, pin: null, today: null },
    ] };
    const s = server(["roster.read"], { "GET /attendance/team/today": { status: 200, body: team } });
    await mount(s.fetcher, <AttendanceManage lead />);
    await screen.findByTestId("att-team-list");
    expect(screen.getByTestId("attendance-manage")).toHaveTextContent(/^My team/);
    expect(screen.queryByTestId("att-tab-today")).toBeNull();
    expect(screen.queryByTestId("att-tab-requests")).toBeNull();
    expect(screen.getAllByTestId(/^att-member-/).map((n) => String(n.props.testID).slice(11))).toEqual(["u4", "u3", "u2", "u1"]);
    expect(screen.getByTestId("att-member-u2")).toHaveTextContent(/^Dr\. Anand Rao09:18Late$/);
    expect(screen.getByTestId("att-member-u3")).toHaveTextContent(/^Dr\. S\. VermaNot in$/);
    expect(screen.getByTestId("att-member-u4")).toHaveTextContent(/^Dr\. New JoinerNot linked—$/);
    expect(screen.getByTestId("att-count-in")).toHaveTextContent(/^2 \/ 4In$/);
    expect(screen.getByTestId("att-count-late")).toHaveTextContent(/^1Late$/);
    expect(s.keys().filter((k) => k.startsWith("GET /attendance"))).toEqual(["GET /attendance/team/today"]);
    fireEvent.press(screen.getByTestId("att-member-u2"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/attendance-person", params: { pin: "202", name: "Dr. Anand Rao" } });
  });

  it("somebody who may see everyone AND leads a team gets all three tabs", async () => {
    const s = server(ALL, { "GET /attendance/today": { status: 200, body: TODAY_LIST }, "GET /attendance/sync-state": { status: 200, body: SYNC }, "GET /attendance/team/today": { status: 200, body: { date: "2026-10-14", summary: { total: 0, linked: 0 }, members: [] } } });
    await mount(s.fetcher, <AttendanceManage lead />);
    await screen.findByTestId("att-today-list");
    fireEvent.press(screen.getByTestId("att-tab-team"));
    expect(await screen.findByTestId("att-team-list")).toHaveTextContent("Nobody in your team yet");
    expect(screen.getByTestId("att-tab-requests")).toBeTruthy();
  });

  it("the loader the owner's home will call: four counts and whether the machine is connected — or null, never a zero", async () => {
    const ok = server(ALL, { "GET /attendance/today": { status: 200, body: TODAY_LIST } });
    const call = async <T,>(_m: string, path: string): Promise<T> => (await (await ok.fetcher(`https://x/api${path}`)).json()) as T;
    expect(await attendanceTodaySummary(call as never)).toEqual({ in: 3, notIn: 2, late: 1, leave: 1, total: 6, date: "2026-10-14", configured: true });
    const refused = async (): Promise<never> => { throw new Error("403"); };
    expect(await attendanceTodaySummary(refused as never)).toBeNull();
  });

  it("in Hindi", async () => {
    const s = server(ALL, { "GET /attendance/today": { status: 200, body: TODAY_LIST }, "GET /attendance/sync-state": { status: 200, body: SYNC } });
    await mount(s.fetcher, <AttendanceManage />, "hi");
    expect(await screen.findByTestId("att-person-102")).toHaveTextContent(/09:34देर से$/);
    expect(screen.getByTestId("att-person-103")).toHaveTextContent(/नहीं आए$/);
    expect(screen.getByTestId("att-person-104")).toHaveTextContent(/लॉगिन नहीं/);
  });
});

describe("one person, for a manager (board frame 5)", () => {
  const full = (date: string, status: string, firstIn: string | null, lastOut: string | null, hours: number | null) => ({ date, firstIn, lastOut, hoursWorked: hours, status, known: true, shiftName: "OPD day", locked: false });
  const DAYS = [
    full("2026-10-01", "on_time", "08:55", "17:02", 8), full("2026-10-02", "late", "09:34", "17:10", 7.5), full("2026-10-03", "weekly_off", null, null, 0),
    full("2026-10-05", "absent", null, null, 0), full("2026-10-06", "single_punch", "08:59", null, 0), full("2026-10-07", "approved_leave", null, null, 0),
    full("2026-10-12", "late", "09:20", "17:00", 7.5), full("2026-10-13", "on_time", "08:50", "17:05", 8), full("2026-10-14", "on_time", "08:58", null, 0),
  ];
  const personRoute = (): Parameters<typeof server>[1][string] => (_b, url) => {
    const from = /from=(\d{4}-\d{2}-\d{2})/.exec(url)![1]!, to = /to=(\d{4}-\d{2}-\d{2})/.exec(url)![1]!;
    return { status: 200, body: { detail: "full", person: { pin: "102", name: "Pooja Kumari", dept: "Slip desk", post: "Clerk" }, from, to, days: DAYS.filter((d) => d.date >= from && d.date <= to) } };
  };

  it("MONTH: present n / m, Late counted, a late day marked — the machine's full detail", async () => {
    const s = server(ALL, { "GET /attendance/person/102": personRoute() });
    await mount(s.fetcher, <AttendancePerson pin="102" name="Pooja Kumari" nowMs={nowMs} />);
    expect(await screen.findByTestId("att-month")).toBeTruthy();
    expect(screen.getByTestId("att-person-name")).toHaveTextContent("Pooja Kumari");
    await waitFor(() => expect(screen.getByTestId("att-count-present")).toHaveTextContent(/^5 \/ 7Present$/));
    expect(screen.getByTestId("att-count-late")).toHaveTextContent(/^2Late$/);
    expect(screen.getByTestId("att-count-absent")).toHaveTextContent(/^1Absent$/);
    expect(screen.getByTestId("att-count-leave")).toHaveTextContent(/^1Leave$/);
    expect(s.sent("GET /attendance/person/102").map((c) => c.url)).toEqual(["/attendance/person/102?from=2026-10-01&to=2026-10-14"]);
  });

  it("WEEK and DAY: times, hours and Late — a manager sees them (the words-only rule is for a person's own screens)", async () => {
    const s = server(ALL, { "GET /attendance/person/102": personRoute() });
    await mount(s.fetcher, <AttendancePerson pin="102" nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-view-week"));
    expect(await screen.findByTestId("att-day-2026-10-12")).toHaveTextContent(/^Mon 12Present09:20–17:00Late$/);
    expect(screen.getByTestId("att-day-2026-10-13")).toHaveTextContent(/^Tue 13Present08:50–17:05$/);
    expect(screen.getByTestId("att-day-2026-10-14")).toHaveTextContent(/^Wed 14Present08:58$/);
    fireEvent.press(screen.getByTestId("att-prev"));
    expect(await screen.findByTestId("att-day-2026-10-06")).toHaveTextContent(/^Tue 6Partial08:59One punch$/); // the machine's own word, not "Confirm"
    fireEvent.press(screen.getByTestId("att-next"));
    fireEvent.press(await screen.findByTestId("att-day-2026-10-12"));
    expect(await screen.findByTestId("att-day-times")).toHaveTextContent(/^In09:20Out17:00Hours7\.5 h$/);
    expect(screen.getByTestId("att-day")).toHaveTextContent(/PresentLate/);
  });

  it("when the server answers with the words-only shape (somebody's own pin), the screen draws words and no time", async () => {
    const s = server([], { "GET /attendance/person/304": { status: 200, body: { detail: "self", showsTimes: false, person: { pin: "304", name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof" }, from: "2026-10-01", to: "2026-10-14", days: [{ date: "2026-10-13", status: "present" }, { date: "2026-10-09", status: "confirm", reason: "one_punch_only" }] } } });
    await mount(s.fetcher, <AttendancePerson pin="304" nowMs={nowMs} />);
    expect(await screen.findByTestId("att-month")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("att-cell-2026-10-13").props.accessibilityLabel).toBe("Tue 13 Present"));
    expect(screen.queryByTestId("att-count-late")).toBeNull();
    expect(screen.getByTestId("attendance-person")).not.toHaveTextContent(/\d{1,2}:\d{2}/);
  });

  it("a pin the caller may not open says so and draws nothing", async () => {
    const s = server([], { "GET /attendance/person/999": { status: 403, body: { statusCode: 403, message: "Forbidden" } } });
    await mount(s.fetcher, <AttendancePerson pin="999" nowMs={nowMs} />);
    expect(await screen.findByTestId("att-failed")).toHaveTextContent("Could not load");
    expect(screen.queryByTestId("att-month")).toBeNull();
  });
});
