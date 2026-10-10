import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { MyAttendance } from "../src/screens/my-attendance";
import { AttendanceManage } from "../src/screens/attendance-manage";
import { AttendancePerson } from "../src/screens/attendance-person";
import { MarkAttendance } from "../src/attendance/mark-button";
import { readOnce } from "../src/attendance/location";
import { attendanceApi } from "../src/attendance/api";
import { TODAY, meRoute, mount, nowMs, server, type Route } from "../testing/attendance";
import { useSession } from "../src/session";
import { useI18n } from "../src/i18n";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "a.kumar", since: "2026-10-14T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }), useLocalSearchParams: () => ({}) }));
const mockLoc = {
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "undetermined" })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getCurrentPositionAsync: jest.fn(async (): Promise<unknown> => ({ coords: { latitude: 25.69, longitude: 85.23 }, mocked: false })),
  watchPositionAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
};
jest.mock("expo-location", () => ({
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  Accuracy: { High: 4 },
  getForegroundPermissionsAsync: (...a: unknown[]) => (mockLoc.getForegroundPermissionsAsync as (...x: unknown[]) => unknown)(...a),
  requestForegroundPermissionsAsync: (...a: unknown[]) => (mockLoc.requestForegroundPermissionsAsync as (...x: unknown[]) => unknown)(...a),
  getCurrentPositionAsync: (...a: unknown[]) => (mockLoc.getCurrentPositionAsync as (...x: unknown[]) => unknown)(...a),
  watchPositionAsync: (...a: unknown[]) => (mockLoc.watchPositionAsync as (...x: unknown[]) => unknown)(...a),
  startLocationUpdatesAsync: (...a: unknown[]) => (mockLoc.startLocationUpdatesAsync as (...x: unknown[]) => unknown)(...a),
  requestBackgroundPermissionsAsync: (...a: unknown[]) => (mockLoc.requestBackgroundPermissionsAsync as (...x: unknown[]) => unknown)(...a),
}));

const TIME = /\d{1,2}:\d{2}/;
type Mark = { date: string; kind: "in" | "out"; place: string };
/** `/attendance/me` with this person's own marks (words only, as the server sends them). */
const meWith = (marks: () => Mark[]): Route => (b, url) => {
  const r = (meRoute() as (b: unknown, u: string) => { status: number; body: Record<string, unknown> })(b, url);
  return { ...r, body: { ...r.body, marks: marks() } };
};
/** A server that keeps the marks posted to it, and answers like the real one: the kind by count, the place by what was sent. */
function world(start: Mark[] = [], post?: Route) {
  const marks = [...start];
  const s = server([], {
    "GET /attendance/me": meWith(() => marks),
    "POST /attendance/me/marks": post ?? ((body) => {
      const loc = (body as { location: { mocked: boolean } | null }).location;
      const m: Mark = { date: TODAY, kind: marks.filter((x) => x.date === TODAY).length % 2 === 0 ? "in" : "out", place: loc === null ? "not_shared" : loc.mocked ? "doubtful" : "inside" };
      marks.push(m);
      return { status: 200, body: { created: true, mark: m } };
    }),
  });
  return { ...s, marks };
}

beforeEach(() => {
  mockLoc.getForegroundPermissionsAsync.mockImplementation(async () => ({ status: "undetermined" }));
  mockLoc.requestForegroundPermissionsAsync.mockImplementation(async () => ({ status: "granted" }));
  mockLoc.getCurrentPositionAsync.mockImplementation(async () => ({ coords: { latitude: 25.69, longitude: 85.23 }, mocked: false }));
  for (const f of Object.values(mockLoc)) f.mockClear();
});

describe("Mark attendance (decision 0061) — the staff app's backup to the machine", () => {
  it("no mark yet today: 'Mark attendance · In'; one tap reads the position ONCE and sends it; the answer is words, never a time", async () => {
    const w = world();
    await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
    const button = await screen.findByTestId("att-mark-button");
    expect(button).toHaveTextContent("Mark attendance · In");
    expect(screen.queryByTestId("att-mark-last")).toBeNull();
    fireEvent.press(button);
    expect(await screen.findByTestId("att-mark-last")).toHaveTextContent("Marked in · inside premises");
    await waitFor(() => expect(screen.getByTestId("att-mark-button")).toHaveTextContent("Mark attendance · Out"));
    expect(w.sent("POST /attendance/me/marks").map((c) => c.body)).toEqual([{ location: { latitude: 25.69, longitude: 85.23, mocked: false } }]);
    expect(mockLoc.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    // Foreground only: nothing watches, nothing runs in the background, background permission is never asked.
    expect(mockLoc.watchPositionAsync).not.toHaveBeenCalled();
    expect(mockLoc.startLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(mockLoc.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId("att-mark")).not.toHaveTextContent(TIME);
    // The day's word is the machine's: the mark does not make it "Present".
    expect(screen.getByTestId("att-word-2026-10-14")).toHaveTextContent("Partial");
  });

  it("marked In already today: the button is 'Out', and the last mark shows", async () => {
    const w = world([{ date: TODAY, kind: "in", place: "outside" }]);
    await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
    expect(await screen.findByTestId("att-mark-button")).toHaveTextContent("Mark attendance · Out");
    expect(screen.getByTestId("att-mark-last")).toHaveTextContent("Marked in · outside premises");
  });

  it("permission refused: the mark is still sent, with no reading — the server saves 'location not shared'", async () => {
    mockLoc.requestForegroundPermissionsAsync.mockImplementation(async () => ({ status: "denied" }));
    const w = world();
    await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-mark-button"));
    expect(await screen.findByTestId("att-mark-last")).toHaveTextContent("Marked in · location not shared");
    expect(w.sent("POST /attendance/me/marks").map((c) => c.body)).toEqual([{ location: null }]);
    expect(mockLoc.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it("a past week has no button — a mark is for today", async () => {
    const w = world();
    await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
    await screen.findByTestId("att-mark-button");
    fireEvent.press(screen.getByTestId("att-prev"));
    await screen.findByTestId("att-word-2026-10-08");
    expect(screen.queryByTestId("att-mark")).toBeNull();
  });

  it("the day view lists that day's own marks as words", async () => {
    const w = world([{ date: "2026-10-13", kind: "in", place: "inside" }, { date: "2026-10-13", kind: "out", place: "doubtful" }]);
    await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-day-2026-10-13"));
    expect(await screen.findByTestId("att-day-mark-0")).toHaveTextContent("Marked in · inside premises");
    expect(screen.getByTestId("att-day-mark-1")).toHaveTextContent("Marked out · location doubtful");
    expect(screen.getByTestId("my-attendance")).not.toHaveTextContent(TIME);
  });

  it("the server's refusals are said in fixed words", async () => {
    const w = world([], { status: 429, body: { code: "too_many_marks" } });
    await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-mark-button"));
    expect(await screen.findByTestId("att-mark-error")).toHaveTextContent("Too many marks today");
  });

  it("an unlinked person has no button", async () => {
    const s = server([], { "GET /attendance/me": { status: 200, body: { linked: false, reason: "no_match", configured: true, leadsTeam: false } } });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    await screen.findByTestId("att-not-linked");
    expect(screen.queryByTestId("att-mark")).toBeNull();
  });
});

describe("the permission sentence", () => {
  function Harness({ os }: { os: string }) {
    const { call, state } = useSession();
    const { t } = useI18n();
    if (state.status !== "signedIn") return null;
    return <MarkAttendance t={t} call={call} today={TODAY} marks={[]} onMarked={() => undefined} os={os} />;
  }

  it("Android, never asked: our sentence first; Cancel sends nothing; Continue asks and marks", async () => {
    const w = world();
    await mount(w.fetcher, <Harness os="android" />);
    fireEvent.press(await screen.findByTestId("att-mark-button"));
    expect(await screen.findByTestId("att-mark-why-text")).toHaveTextContent("HMIS checks your location once when you mark attendance, to confirm you are on hospital premises.");
    fireEvent.press(screen.getByTestId("att-mark-cancel"));
    await waitFor(() => expect(screen.queryByTestId("att-mark-why")).toBeNull());
    expect(mockLoc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    fireEvent.press(await screen.findByTestId("att-mark-button"));
    fireEvent.press(await screen.findByTestId("att-mark-continue"));
    expect(await screen.findByTestId("att-mark-last")).toHaveTextContent("Marked in · inside premises");
    expect(w.sent("POST /attendance/me/marks")).toHaveLength(1);
  });

  it("Android, asked before: no sentence again", async () => {
    mockLoc.getForegroundPermissionsAsync.mockImplementation(async () => ({ status: "granted" }));
    const w = world();
    await mount(w.fetcher, <Harness os="android" />);
    fireEvent.press(await screen.findByTestId("att-mark-button"));
    expect(await screen.findByTestId("att-mark-last")).toBeTruthy();
    expect(screen.queryByTestId("att-mark-why")).toBeNull();
  });

  it("iPhone: the system prompt carries the sentence, so the app shows none of its own", async () => {
    const w = world();
    await mount(w.fetcher, <Harness os="ios" />);
    fireEvent.press(await screen.findByTestId("att-mark-button"));
    expect(await screen.findByTestId("att-mark-last")).toBeTruthy();
    expect(screen.queryByTestId("att-mark-why")).toBeNull();
    expect(w.sent("POST /attendance/me/marks")).toHaveLength(1);
  });
});

describe("readOnce — one reading, or none", () => {
  it("passes Android's mocked flag through, and nothing else", async () => {
    mockLoc.getCurrentPositionAsync.mockImplementation(async () => ({ coords: { latitude: 1, longitude: 2, accuracy: 5, altitude: 3 }, mocked: true, timestamp: 9 }));
    expect(await readOnce()).toEqual({ latitude: 1, longitude: 2, mocked: true });
  });
  it("no fix in time, or an error, is no reading", async () => {
    mockLoc.getCurrentPositionAsync.mockImplementation(() => new Promise(() => undefined));
    expect(await readOnce(20)).toBeNull();
    mockLoc.getCurrentPositionAsync.mockImplementation(async () => { throw new Error("Location services are disabled"); });
    expect(await readOnce()).toBeNull();
  });
});

describe("managers see the marks beside the machine", () => {
  const row = (pin: string, name: string, appMark: unknown) => ({ pin, name, dept: "Medicine", post: "Staff", status: pin === "103" ? "absent" : "on_time", known: true, firstIn: pin === "103" ? null : "08:51", lastOut: null, onDuty: pin !== "103", hasLogin: true, appMark });
  it("today list: a tag for the newest app mark — an absent person marked outside reads 'Not in' AND 'App: outside'", async () => {
    const people = [row("101", "Dr. Chandan Kumar", { date: TODAY, time: "08:50", kind: "in", place: "inside", distanceM: 30 }), row("103", "Dr. Kishore Kunal", { date: TODAY, time: "09:10", kind: "in", place: "outside", distanceM: 900 }), row("104", "R. Mishra", null)];
    const s = server(["attendance.all.read"], {
      "GET /attendance/today": { status: 200, body: { date: TODAY, configured: true, people, summary: { total: 3, byStatus: {}, byDept: [] } } },
      "GET /attendance/sync-state": { status: 200, body: { configured: true, enabled: true, onDutyAsOf: null, lastErrorClass: null, stages: {} } },
    });
    await mount(s.fetcher, <AttendanceManage />);
    expect(await screen.findByTestId("att-place-101-mark")).toHaveTextContent("App ✓");
    expect(screen.getByTestId("att-person-103")).toHaveTextContent(/Not in.*App: outside/);
    expect(screen.queryByTestId("att-place-104-mark")).toBeNull();
  });

  it("one person's day: each mark with its time, place and metres, under the machine's in / out", async () => {
    const s = server(["attendance.all.read"], {
      "GET /attendance/person/304": { status: 200, body: { detail: "full", person: { pin: "304", name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof" }, from: TODAY, to: TODAY,
        days: [{ date: TODAY, firstIn: null, lastOut: null, hoursWorked: null, status: "absent", known: true, shiftName: null, locked: false }],
        marks: [{ date: TODAY, time: "09:02", kind: "in", place: "outside", distanceM: 412 }, { date: "2026-10-13", time: "17:00", kind: "out", place: "inside", distanceM: 20 }] } },
    });
    await mount(s.fetcher, <AttendancePerson pin="304" nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-view-day"));
    expect(await screen.findByTestId("att-day-marks")).toHaveTextContent(/^App marks09:02 Inoutside premises412 m$/);
    expect(screen.getByTestId("att-day-word")).toHaveTextContent("Absent");
  });
});

it("api: the mark route is a POST of the reading and nothing else", async () => {
  const calls: unknown[] = [];
  await attendanceApi((async (m: string, p: string, b?: unknown) => { calls.push([m, p, b]); return {}; }) as never).mark(null);
  expect(calls).toEqual([["POST", "/attendance/me/marks", { location: null }]]);
});
