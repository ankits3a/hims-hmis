import { StyleSheet } from "react-native";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { MyAttendance } from "../src/screens/my-attendance";
import { WEEK, meRoute, mount, nowMs, server } from "../testing/attendance";

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
const mockBack = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: mockBack }) }));

const TIME = /\d{1,2}:\d{2}/;
const request = (over: Record<string, unknown> = {}) => ({ id: "r1", date: "2026-10-09", reasonCode: "one_punch_only", note: null, status: "open", createdAt: "2026-10-14T05:00:00.000Z", closedAt: null, closeNote: null, ...over });
/** The same days WITH the time keys — what the server sends once `ATTENDANCE_SELF_SHOWS_TIMES` is on. */
const TIMED = WEEK.map((d) => ({ ...d, firstIn: ["present", "partial", "confirm"].includes(d.status) ? "08:58" : null, lastOut: d.status === "present" ? "17:05" : null, hoursWorked: d.status === "present" ? 8 : 0 }));

describe("My attendance (board frames 2 and 3)", () => {
  it("a week that crosses a month names both months; the 'n / m' tile is the wide one (360 px clipped it to '7 /…')", async () => {
    const s = server([], { "GET /attendance/me": meRoute() });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    await screen.findByTestId("att-word-2026-10-12");
    fireEvent.press(screen.getByTestId("att-prev"));
    await waitFor(() => expect(screen.getByTestId("att-period")).toHaveTextContent("5 – 11 October"));
    fireEvent.press(screen.getByTestId("att-prev"));
    await waitFor(() => expect(screen.getByTestId("att-period")).toHaveTextContent(/^28 September – 4 October$/));
    const basis = (id: string): number => (StyleSheet.flatten(screen.getByTestId(id).props.style) as { flexBasis: number }).flexBasis;
    expect(basis("att-count-present")).toBeGreaterThanOrEqual(1.5 * basis("att-count-partial"));
  });

  it("WEEK: Monday to Sunday, one word a day, '—' for the days ahead — and no time anywhere", async () => {
    const s = server([], { "GET /attendance/me": meRoute() });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    expect(await screen.findByTestId("att-word-2026-10-12")).toHaveTextContent("Present");
    expect(screen.getByTestId("att-day-2026-10-12")).toHaveTextContent(/^Mon 12Present$/);
    expect(screen.getByTestId("att-word-2026-10-14")).toHaveTextContent("Partial");
    for (const ahead of ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]) expect(screen.getByTestId(`att-word-${ahead}`)).toHaveTextContent("—");
    expect(screen.getByTestId("att-period")).toHaveTextContent("12 – 18 October");
    expect(screen.getByTestId("att-count-present")).toHaveTextContent(/^2 \/ 3Present$/);
    expect(screen.getByTestId("att-count-partial")).toHaveTextContent(/^1Partial$/);
    expect(screen.getByTestId("my-attendance")).not.toHaveTextContent(TIME);
    // It asked for Monday to TODAY — never for a day ahead.
    expect(s.sent("GET /attendance/me").map((c) => c.url)).toEqual(["/attendance/me?from=2026-10-12&to=2026-10-14"]);
    // "Next" stops at the week today is in; "Previous" goes back.
    expect(screen.getByTestId("att-next").props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(screen.getByTestId("att-prev"));
    expect(await screen.findByTestId("att-word-2026-10-08")).toHaveTextContent("Absent");
    expect(screen.getByTestId("att-word-2026-10-07")).toHaveTextContent("Leave");
    expect(screen.getByTestId("att-word-2026-10-11")).toHaveTextContent("Off");
    expect(screen.getByTestId("att-word-2026-10-09")).toHaveTextContent("⚠ Confirm");
    expect(screen.getByTestId("att-count-confirm")).toHaveTextContent(/^1Confirm$/);
    expect(screen.getByTestId("att-next").props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("a LATE day is simply Present to its own person — the app has no 'Late' to show them", async () => {
    const s = server([], { "GET /attendance/me": meRoute() });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    await screen.findByTestId("att-word-2026-10-12");
    expect(screen.getByTestId("my-attendance")).not.toHaveTextContent(/Late/i);
  });

  it("MONTH: a calendar coloured by the same words, and the five counts", async () => {
    const s = server([], { "GET /attendance/me": meRoute() });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-view-month"));
    expect(await screen.findByTestId("att-month")).toBeTruthy();
    expect(screen.getByTestId("att-period")).toHaveTextContent("October 2026");
    await waitFor(() => expect(screen.getByTestId("att-count-present")).toHaveTextContent(/^4Present$/));
    expect(screen.getByTestId("att-count-partial")).toHaveTextContent(/^2Partial$/);
    expect(screen.getByTestId("att-count-absent")).toHaveTextContent(/^1Absent$/);
    expect(screen.getByTestId("att-count-leave")).toHaveTextContent(/^1Leave$/);
    expect(screen.getByTestId("att-count-off")).toHaveTextContent(/^1Off$/);
    expect(screen.getByTestId("att-cell-2026-10-08").props.accessibilityLabel).toBe("Thu 8 Absent");
    expect(screen.getByTestId("att-cell-2026-10-09").props.accessibilityLabel).toBe("Fri 9 ⚠ Confirm");
    expect(screen.getByTestId("att-cell-2026-10-20").props.accessibilityLabel).toBe("Tue 20 —"); // ahead of today
    expect(s.sent("GET /attendance/me").map((c) => c.url)).toContain("/attendance/me?from=2026-10-01&to=2026-10-14");
    expect(screen.getByTestId("att-next").props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByTestId("my-attendance")).not.toHaveTextContent(TIME);
  });

  it("DAY, times OFF (the owner's default): the word and nothing else — no in/out block, no punches asked for", async () => {
    const s = server([], { "GET /attendance/me": meRoute(), "GET /attendance/me/punches": { status: 200, body: { linked: true, date: "2026-10-13", showsTimes: false, status: "present" } } });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    fireEvent.press(await screen.findByTestId("att-day-2026-10-13"));
    expect(await screen.findByTestId("att-day-word")).toHaveTextContent("Present");
    expect(screen.getByTestId("att-period")).toHaveTextContent("Tue 13 October");
    expect(screen.queryByTestId("att-day-times")).toBeNull();
    expect(screen.queryByTestId("att-day-punches")).toBeNull();
    expect(screen.getByTestId("my-attendance")).not.toHaveTextContent(TIME);
    expect(s.sent("GET /attendance/me/punches")).toEqual([]);
  });

  it("DAY, times ON (the server sends them): in, out, hours and the day's punches — and the week still does not crash", async () => {
    const s = server([], {
      "GET /attendance/me": meRoute({ showsTimes: true, days: TIMED }),
      "GET /attendance/me/punches": { status: 200, body: { linked: true, date: "2026-10-13", showsTimes: true, status: "present", punches: [{ time: "08:58:12", direction: "in", device: "OPD", verify: "face" }, { time: "17:05:40", direction: "in", device: "OPD", verify: "face" }] } },
    });
    await mount(s.fetcher, <MyAttendance nowMs={nowMs} />);
    expect(await screen.findByTestId("att-word-2026-10-12")).toHaveTextContent("Present");
    expect(screen.getByTestId("att-day-2026-10-12")).not.toHaveTextContent(TIME); // the week is words, whatever arrives
    fireEvent.press(screen.getByTestId("att-day-2026-10-13"));
    expect(await screen.findByTestId("att-day-times")).toHaveTextContent(/In08:58Out17:05Hours8 h/);
    expect(await screen.findByTestId("att-day-punches")).toHaveTextContent(/Punches08:58 · OPD17:05 · OPD/);
    expect(s.sent("GET /attendance/me/punches").map((c) => c.url)).toEqual(["/attendance/me/punches?date=2026-10-13"]);
  });

  it("an unlinked person is told so", async () => {
    const a = server([], { "GET /attendance/me": { status: 200, body: { linked: false, reason: "no_match", configured: true, leadsTeam: false } } });
    await mount(a.fetcher, <MyAttendance nowMs={nowMs} />);
    expect(await screen.findByTestId("att-not-linked")).toHaveTextContent("Attendance not linked");
    expect(screen.queryByTestId("att-day-2026-10-12")).toBeNull();
  });

  it("a failed read says so and draws no days", async () => {
    const b = server([], { "GET /attendance/me": "offline" });
    await mount(b.fetcher, <MyAttendance nowMs={nowMs} />);
    expect(await screen.findByTestId("att-failed")).toHaveTextContent("No network");
    expect(screen.queryByTestId("att-day-2026-10-12")).toBeNull();
  });

  describe("the Confirm sheet", () => {
    const world = (requests: unknown[] = [], post: Parameters<typeof server>[1][string] = { status: 200, body: { created: true, request: request() } }) => {
      const state = { requests };
      const s = server([], {
        "GET /attendance/me": meRoute(),
        "GET /attendance/me/requests": () => ({ status: 200, body: { requests: state.requests } }),
        "POST /attendance/me/requests": post,
      });
      return { ...s, state };
    };
    const openFriday = async () => {
      fireEvent.press(await screen.findByTestId("att-prev"));
      fireEvent.press(await screen.findByTestId("att-day-2026-10-09"));
      return screen.findByTestId("confirm-sheet");
    };

    it("a Confirm day opens the sheet: the date, the reason in fixed words, and ONE tap raises exactly ONE request", async () => {
      const w = world();
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
      const sheet = await openFriday();
      expect(screen.getByTestId("confirm-date")).toHaveTextContent("Fri 9 October");
      expect(screen.getByTestId("confirm-reason")).toHaveTextContent("⚠ Only one punch that day");
      expect(sheet).not.toHaveTextContent(TIME);
      expect(screen.queryByTestId("confirm-state")).toBeNull();
      fireEvent.press(await screen.findByTestId("confirm-ask"));
      expect(await screen.findByTestId("confirm-state-word")).toHaveTextContent("Request sent");
      expect(w.sent("POST /attendance/me/requests").map((c) => c.body)).toEqual([{ date: "2026-10-09" }]);
      // Sent: the button is gone, so a second tap cannot raise a second one.
      expect(screen.queryByTestId("confirm-ask")).toBeNull();
    });

    it("a request already waiting is shown as it stands — Seen — with no button to ask again", async () => {
      const w = world([request({ status: "seen" })]);
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
      await openFriday();
      expect(await screen.findByTestId("confirm-state-word")).toHaveTextContent("Seen");
      expect(screen.queryByTestId("confirm-ask")).toBeNull();
      expect(w.sent("POST /attendance/me/requests")).toEqual([]);
    });

    it("Closed shows the manager's note, and the day (still Confirm) may be asked about again", async () => {
      const w = world([request({ status: "closed", closedAt: "2026-10-13T09:00:00.000Z", closeNote: "Met on Monday" })]);
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
      await openFriday();
      expect(await screen.findByTestId("confirm-state-word")).toHaveTextContent("Closed");
      expect(screen.getByTestId("confirm-close-note")).toHaveTextContent("Met on Monday");
      expect(screen.getByTestId("confirm-ask")).toBeTruthy();
    });

    it("a LOST ANSWER is settled by re-reading, never by sending again: the request landed, so it reads 'Request sent'", async () => {
      const w = world([], () => { w.state.requests = [request()]; return "offline"; });
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
      await openFriday();
      fireEvent.press(await screen.findByTestId("confirm-ask"));
      expect(await screen.findByTestId("confirm-state-word")).toHaveTextContent("Request sent");
      expect(w.sent("POST /attendance/me/requests")).toHaveLength(1); // not resent
      expect(w.sent("GET /attendance/me/requests")).toHaveLength(2); // once on opening, once to settle
      expect(screen.queryByTestId("confirm-error")).toBeNull();
    });

    it("a lost answer whose request did NOT land says so and leaves the button — the person decides", async () => {
      const w = world([], "offline");
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
      await openFriday();
      fireEvent.press(await screen.findByTestId("confirm-ask"));
      expect(await screen.findByTestId("confirm-error")).toHaveTextContent("Not sent — try again");
      expect(w.sent("POST /attendance/me/requests")).toHaveLength(1);
      expect(screen.getByTestId("confirm-ask")).toBeTruthy();
      expect(screen.queryByTestId("confirm-state")).toBeNull();
    });

    it("the server's refusals are said in fixed words", async () => {
      const w = world([], { status: 429, body: { code: "too_many_open_requests", max: 5 } });
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />);
      await openFriday();
      fireEvent.press(await screen.findByTestId("confirm-ask"));
      expect(await screen.findByTestId("confirm-error")).toHaveTextContent("Too many open requests");
    });

    it("opened from the home warning (`?confirm=`) it is that day's sheet at once", async () => {
      const w = world();
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} openDay="2026-10-09" />);
      expect(await screen.findByTestId("confirm-date")).toHaveTextContent("Fri 9 October");
      expect(screen.getByTestId("confirm-reason")).toHaveTextContent("⚠ Only one punch that day");
    });

    it("opened from a 'Request closed' notice it finds the day that request was about", async () => {
      const w = world([request({ id: "r9", status: "closed", closeNote: "Sorted" })]);
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} openRequest="r9" />);
      expect(await screen.findByTestId("confirm-date")).toHaveTextContent("Fri 9 October");
      expect(await screen.findByTestId("confirm-close-note")).toHaveTextContent("Sorted");
    });

    it("in Hindi", async () => {
      const w = world();
      await mount(w.fetcher, <MyAttendance nowMs={nowMs} />, "hi");
      await openFriday();
      expect(screen.getByTestId("confirm-date")).toHaveTextContent("शुक्र 9 अक्टूबर");
      expect(screen.getByTestId("confirm-reason")).toHaveTextContent("⚠ उस दिन केवल एक पंच");
      fireEvent.press(await screen.findByTestId("confirm-ask"));
      expect(await screen.findByTestId("confirm-state-word")).toHaveTextContent("अनुरोध भेजा गया");
    });
  });
});
