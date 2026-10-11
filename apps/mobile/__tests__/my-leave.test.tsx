import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { MyLeaveScreen, dayFromTyped } from "../src/screens/my-leave";
import { SessionProvider, useSession } from "../src/session";
import { openWaiting } from "../src/waiting/card";
import { PUSH_LINK_ROUTE } from "../src/notifications";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import webEn from "../../web/src/locales/en.json";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "jr", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }), useLocalSearchParams: () => ({}) }));

/**
 * E2.2 (decision 0069) — My leave on the phone: the same routes and words as the web. No clock is
 * pinned: "today" is computed from a `nowMs` passed in.
 */
const NOW = Date.parse("2026-10-20T04:00:00.000Z"); // 09:30 IST, 20 Oct
const MINE = [
  { id: "a1", kind: "CL", from: "2026-11-02", to: "2026-11-03", days: 2, status: "rejected", reason: null, refusal: "OPD short that week", decidedBy: "Dr. R. Prasad", decidedAt: "2026-10-12T05:00:00.000Z", canCancel: false },
  { id: "a2", kind: "EL", from: "2026-11-10", to: "2026-11-10", days: 1, status: "requested", reason: null, refusal: null, decidedBy: null, decidedAt: null, canCancel: true },
];
const THEIRS = [{ id: "b1", userId: "x", name: "Dr. Sandeep Yadav", department: "General Medicine", kind: "ML", from: "2026-11-05", to: "2026-11-07", days: 3, reason: "fever", requestedAt: "2026-10-19T05:00:00.000Z" }];

const posted: { key: string; body: unknown }[] = [];
function server(toDecide: unknown[]) {
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "jr" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200 });
    if (key === "GET /roster/leave/mine") return new Response(JSON.stringify(MINE), { status: 200 });
    if (key === "GET /roster/leave/to-decide") return new Response(JSON.stringify(toDecide), { status: 200 });
    if (init?.method === "POST") {
      posted.push({ key, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      if (key === "POST /roster/leave" && (JSON.parse(String(init.body)) as { from: string }).from === "2026-11-02") {
        return new Response(JSON.stringify({ statusCode: 409, code: "leave_overlaps" }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, absenceId: "n1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return f as unknown as typeof fetch;
}
function Gate() { const { state } = useSession(); return state.status !== "signedIn" ? null : <MyLeaveScreen nowMs={() => NOW} />; }
const mount = async (fetcher: typeof fetch) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);

beforeEach(() => { posted.length = 0; mockPush.mockReset(); });

describe("E2.2 my leave — phone", () => {
  it("lists my requests; a refused one says who and why; a waiting one can be taken back", async () => {
    await mount(server([]));
    expect(await screen.findByTestId("my-leave-a1-status", {}, { timeout: 5000 })).toHaveTextContent("Not approved");
    expect(screen.getByTestId("my-leave-a1-refusal")).toHaveTextContent("Not approved by Dr. R. Prasad: OPD short that week");
    expect(screen.queryByTestId("my-leave-a1-cancel")).toBeNull();
    expect(screen.queryByTestId("leave-to-decide")).toBeNull();
    await fireEvent.press(screen.getByTestId("my-leave-a2-cancel"));
    expect(posted.map((p) => p.key)).toEqual(["POST /roster/leave/a2/cancel"]);
  });

  it("asks: kind, first day typed as 12/11, a number of days; the server's refusal is said in the web's words", async () => {
    await mount(server([]));
    await screen.findByTestId("leave-send", {}, { timeout: 5000 });
    await fireEvent.press(screen.getByTestId("leave-kind-EL"));
    await fireEvent.changeText(screen.getByTestId("leave-from"), "12/11");
    await fireEvent.press(screen.getByTestId("leave-days-3"));
    await fireEvent.press(screen.getByTestId("leave-send"));
    expect(posted[0]).toEqual({ key: "POST /roster/leave", body: { kind: "EL", from: "2026-11-12", to: "2026-11-14" } });
    await fireEvent.changeText(screen.getByTestId("leave-from"), "2/11");
    await fireEvent.press(screen.getByTestId("leave-send"));
    expect(await screen.findByTestId("my-leave-problem")).toHaveTextContent((webEn as { roster: { refusal: Record<string, string> } }).roster.refusal.leave_overlaps!);
  });

  it("a decider approves, or refuses only once a reason is written", async () => {
    await mount(server(THEIRS));
    await screen.findByTestId("decide-b1", {}, { timeout: 5000 });
    expect(screen.getByText("Reason: fever")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("decide-b1-refuse"));
    await fireEvent.press(screen.getByTestId("decide-b1-refuse-send"));
    expect(posted).toEqual([]);
    await fireEvent.changeText(screen.getByTestId("decide-b1-note"), "OPD short");
    await fireEvent.press(screen.getByTestId("decide-b1-refuse-send"));
    expect(posted).toEqual([{ key: "POST /roster/leave/b1/decide", body: { approve: false, note: "OPD short" } }]);
  });

  it("reads a typed first day as the next such day on or after today, and refuses a non-day", () => {
    expect(dayFromTyped("12/11", NOW)).toBe("2026-11-12");
    expect(dayFromTyped("1-10", NOW)).toBe("2027-10-01");
    expect(dayFromTyped("31/2", NOW)).toBeNull();
    expect(dayFromTyped("tomorrow", NOW)).toBeNull();
  });

  it("both leave lines and the leave notices open My leave; its words are in English and Hindi, as the web says them", () => {
    for (const k of ["roster.leaveToDecide", "roster.leaveRefused"] as const) { mockPush.mockReset(); openWaiting(mockPush, k); expect(mockPush).toHaveBeenLastCalledWith("/my-leave"); }
    expect(PUSH_LINK_ROUTE.myLeave).toBe("myLeave");
    expect(Object.keys((en as { myLeave: object }).myLeave)).toEqual(Object.keys((hi as { myLeave: object }).myLeave));
    const refusal = (l: unknown) => (l as { roster: { refusal: Record<string, string> } }).roster.refusal;
    for (const code of ["leave_in_past", "leave_overlaps", "absence_self_approval"]) expect(refusal(en)[code]).toBe(refusal(webEn)[code]);
  });
});
