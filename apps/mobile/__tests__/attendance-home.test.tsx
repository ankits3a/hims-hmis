import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
import { NOW, TODAY, me, mount, server } from "../testing/attendance";

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
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

const STAFF = ["roster.read", "opd.vitals.record"];
const MANAGER_ROUTES = ["GET /attendance/today", "GET /attendance/team/today", "GET /attendance/requests", "GET /attendance/sync-state", "GET /attendance/summary"];
const TIME = /\d{1,2}:\d{2}/;

describe("the home card — Attendance (board frame 1)", () => {
  // The home reads the clock through `Date.now`; the suite's "now" is Wednesday 14 Oct 2026, 11:00 IST.
  let clock: jest.SpyInstance;
  beforeEach(() => { _forgetHomeForTests(); mockPush.mockClear(); clock = jest.spyOn(Date, "now").mockReturnValue(NOW); });
  // Only the clock is restored: `restoreAllMocks` would also empty the secure-store mock's functions.
  afterEach(() => { clock.mockRestore(); });

  it.each([
    ["not_checked_in", null, "Not checked in"],
    ["checked_in", null, "✓ Checked in"],
    ["checked_out", "present", "Checked out"],
  ] as const)("a linked person, state %s: one card, one request, and no time on it", async (state, status, label) => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ state, status }) } });
    await mount(s.fetcher, <SeatHome />);
    expect(await screen.findByTestId("attendance-state")).toHaveTextContent(label);
    const card = screen.getByTestId("attendance-card");
    expect(card).toHaveTextContent(/Attendance/i);
    // The day's word appears only once checked out.
    if (status === null) expect(screen.queryByTestId("attendance-word")).toBeNull();
    else expect(screen.getByTestId("attendance-word")).toHaveTextContent("Present");
    expect(card).not.toHaveTextContent(TIME);
    expect(screen.queryByTestId("attendance-confirm")).toBeNull();
    // ONE request for it, for today and the 31 days behind.
    expect(s.sent("GET /attendance/me").map((c) => c.url)).toEqual([`/attendance/me?from=2026-09-13&to=${TODAY}`]);
    fireEvent.press(screen.getByTestId("attendance-open"));
    expect(mockPush).toHaveBeenCalledWith("/attendance");
  });

  it("the card draws no time even when the server sends times in today (the switch is on)", async () => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ state: "checked_out", status: "present", showsTimes: true, today: { firstIn: "08:58", lastOut: "17:05", inSince: null } }) } });
    await mount(s.fetcher, <SeatHome />);
    expect(await screen.findByTestId("attendance-state")).toHaveTextContent("Checked out");
    expect(screen.getByTestId("attendance-card")).not.toHaveTextContent(TIME);
  });

  it("days that need Confirm: an amber row naming the most recent, '+2' for the rest; a tap opens THAT day's sheet", async () => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ needsConfirm: ["2026-09-30", "2026-10-09", "2026-10-02"] }) } });
    await mount(s.fetcher, <SeatHome />);
    const row = await screen.findByTestId("attendance-confirm");
    expect(row).toHaveTextContent(/^⚠ Confirm · Fri 9\+2›$/);
    expect(screen.getByTestId("attendance-confirm-more")).toHaveTextContent("+2");
    fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/attendance", params: { confirm: "2026-10-09" } });
  });

  it("one day to confirm shows no '+n'", async () => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ needsConfirm: ["2026-10-09"] }) } });
    await mount(s.fetcher, <SeatHome />);
    expect(await screen.findByTestId("attendance-confirm")).toHaveTextContent(/^⚠ Confirm · Fri 9›$/);
    expect(screen.queryByTestId("attendance-confirm-more")).toBeNull();
  });

  it("NOT LINKED: a quiet line, no card", async () => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body: { linked: false, reason: "no_match", configured: true, leadsTeam: false } } });
    await mount(s.fetcher, <SeatHome />);
    expect(await screen.findByTestId("attendance-not-linked")).toHaveTextContent("Attendance not linked");
    expect(screen.queryByTestId("attendance-card")).toBeNull();
  });

  it.each([
    ["a linked person", me({ configured: false })],
    ["an unlinked person", { linked: false, reason: "no_match", configured: false, leadsTeam: false }],
  ])("NOT CONFIGURED (%s): nothing at all", async (_who, body) => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body } });
    await mount(s.fetcher, <SeatHome />);
    await screen.findByTestId("home");
    await waitFor(() => expect(s.sent("GET /attendance/me")).toHaveLength(1));
    expect(screen.queryByTestId("attendance-card")).toBeNull();
    expect(screen.queryByTestId("attendance-not-linked")).toBeNull();
  });

  it.each([
    ["an older server (404)", undefined],
    ["a server error", { status: 500, body: { message: "boom" } }],
    ["no network for that one read", "offline" as const],
  ])("the read FAILS SOFT — %s leaves the rest of home as it was", async (_name, reply) => {
    const s = server(STAFF, reply === undefined ? {} : { "GET /attendance/me": reply });
    await mount(s.fetcher, <SeatHome />);
    expect(await screen.findByTestId("home")).toBeTruthy();
    await waitFor(() => expect(s.sent("GET /attendance/me")).toHaveLength(1));
    expect(screen.queryByTestId("attendance-card")).toBeNull();
    expect(screen.queryByTestId("attendance-not-linked")).toBeNull();
    expect(screen.getByTestId("seat-vitals")).toBeTruthy();
  });

  it("a cold start with no network shows ONLY today's state word — no day's word, no warning", async () => {
    const first = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ state: "checked_in", needsConfirm: ["2026-10-09"] }) } });
    const view = await mount(first.fetcher, <SeatHome />);
    await screen.findByTestId("attendance-confirm");
    view.unmount();
    const { attendanceCache } = jest.requireActual<typeof import("../src/attendance/home-card")>("../src/attendance/home-card");
    const kept = await attendanceCache.load("u-me", TODAY);
    expect(kept).toEqual({ user: "u-me", date: TODAY, state: "checked_in" });
    expect(Object.keys(kept!).sort()).toEqual(["date", "state", "user"]);
    expect(await attendanceCache.load("u-somebody-else", TODAY)).toBeNull();
    expect(await attendanceCache.load("u-me", "2026-10-15")).toBeNull(); // yesterday's state is not today's
    // The app is opened again and the read cannot be made: the state word, and nothing else.
    const second = server(STAFF, { "GET /attendance/me": "offline" });
    await mount(second.fetcher, <SeatHome />);
    expect(await screen.findByTestId("attendance-state")).toHaveTextContent("✓ Checked in");
    expect(screen.queryByTestId("attendance-confirm")).toBeNull();
    expect(screen.queryByTestId("attendance-word")).toBeNull();
  });

  describe("who is offered Staff attendance", () => {
    it("a plain member of staff: no row, and NO manager request is made for them", async () => {
      const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ leadsTeam: false }) } });
      await mount(s.fetcher, <SeatHome />);
      await screen.findByTestId("attendance-card");
      expect(screen.queryByTestId("attendance-manage-open")).toBeNull();
      expect(s.keys().filter((k) => MANAGER_ROUTES.includes(k) || k.startsWith("GET /attendance/person"))).toEqual([]);
    });

    it("a head: the row says 'My team today' and opens the team — and home itself still asks no manager route", async () => {
      const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ leadsTeam: true }) } });
      await mount(s.fetcher, <SeatHome />);
      const row = await screen.findByTestId("attendance-manage-open");
      expect(row).toHaveTextContent(/Staff attendance.*My team today/);
      fireEvent.press(row);
      expect(mockPush).toHaveBeenCalledWith({ pathname: "/attendance-staff", params: { lead: "1" } });
      expect(s.keys().filter((k) => MANAGER_ROUTES.includes(k))).toEqual([]);
    });

    it("a committee member with no login-link of their own: the row, 'Everyone today · requests', and the quiet not-linked line", async () => {
      const s = server([...STAFF, "attendance.all.read"], { "GET /attendance/me": { status: 200, body: { linked: false, reason: "no_mobile_or_aadhaar", configured: true, leadsTeam: false } } });
      await mount(s.fetcher, <SeatHome />);
      const row = await screen.findByTestId("attendance-manage-open");
      expect(row).toHaveTextContent(/Staff attendance.*Everyone today · requests/);
      fireEvent.press(row);
      expect(mockPush).toHaveBeenCalledWith({ pathname: "/attendance-staff", params: {} });
      expect(screen.getByTestId("attendance-not-linked")).toBeTruthy();
    });
  });

  it("in Hindi", async () => {
    const s = server(STAFF, { "GET /attendance/me": { status: 200, body: me({ state: "checked_out", status: "present", needsConfirm: ["2026-10-09"] }) } });
    await mount(s.fetcher, <SeatHome />, "hi");
    expect(await screen.findByTestId("attendance-state")).toHaveTextContent("चेक-आउट हो गया");
    expect(screen.getByTestId("attendance-word")).toHaveTextContent("उपस्थित");
    expect(screen.getByTestId("attendance-confirm")).toHaveTextContent(/⚠ पुष्टि करें · शुक्र 9/);
  });
});
