import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider, translate } from "../src/i18n";
import { WaitingCard, openWaiting } from "../src/waiting/card";
import { OpenLoopsScreen } from "../src/screens/open-loops";
import { SessionProvider, useSession } from "../src/session";
import { WAITING_KINDS, waitingLines } from "../../../packages/contracts/src/waiting";
import { WAITING_EXPECTED, WAITING_FIXTURE } from "../../../packages/contracts/src/waiting-fixture";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }), useLocalSearchParams: () => mockParams }));

/**
 * E1.4 / E1.5 — "Waiting for me" on the phone (spec /opt/hmis-context/SPEC-morning-card-2026-10-11.md).
 * Done-means 3: the phone draws the shared fixture as `WAITING_EXPECTED`, exactly as the web test
 * does (apps/web/src/components/waiting-for-me.test.tsx). Done-means 2: every line opens its screen
 * in one tap. No clock is pinned: ages are computed from a `nowMs` passed in.
 */
const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const seenKeys: string[] = [];

function server(waiting: unknown) {
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    seenKeys.push(key);
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-dr" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200 });
    if (key === "GET /me/waiting") return new Response(JSON.stringify(waiting), { status: 200 });
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return f as unknown as typeof fetch;
}
function Gate() { const { state } = useSession(); return state.status !== "signedIn" ? null : <OpenLoopsScreen nowMs={() => NOW} />; }
const mountLoops = async (fetcher: typeof fetch) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);

beforeEach(() => { mockPush.mockReset(); mockParams = {}; });

describe("E1.4 / E1.5 waiting for me — phone", () => {
  // First in the file: it mounts the session, and a session mounted after the bare card renders
  // above did not reach sign-in inside this file (order effect seen 2026-10-11, not chased).
  it("Open loops reads GET /me/waiting and lists the same lines; computer-only work says where", async () => {
    mockParams = { kind: "lab.reportsBack" };
    await mountLoops(server(WAITING_FIXTURE));
    await screen.findByTestId("waiting-line-lab.criticalsMine", {}, { timeout: 5000 });
    const drawn = screen.getAllByTestId(/^waiting-line-/).map((n) => n.props.testID.replace("waiting-line-", ""));
    expect(drawn).toEqual(WAITING_EXPECTED.map(([k]) => k));
    expect(screen.getByTestId("waiting-where-lab.reportsBack")).toHaveTextContent("On computer · Consult");
    expect(seenKeys).toContain("GET /me/waiting");
    fireEvent.press(screen.getByTestId("waiting-line-alerts.unanswered"));
    expect(mockPush).toHaveBeenLastCalledWith("/alerts");
  });

  it("the home card draws the shared fixture as the shared expected list (same as the web)", async () => {
    await render(<WaitingCard t={t} lines={waitingLines(WAITING_FIXTURE)} push={mockPush} nowMs={NOW} />);
    const drawn = screen.getAllByTestId(/^waiting-line-/).map((n) => n.props.testID.replace("waiting-line-", ""));
    expect(drawn).toEqual(WAITING_EXPECTED.map(([k]) => k));
    expect(screen.getByText("Lab reports back")).toBeTruthy();
    expect(screen.queryByText(/billing/i)).toBeNull();
  });

  it("each line opens its screen in one tap; the heading opens Open loops", async () => {
    await render(<WaitingCard t={t} lines={waitingLines(WAITING_FIXTURE)} push={mockPush} nowMs={NOW} />);
    fireEvent.press(screen.getByTestId("waiting-line-alerts.unanswered"));
    expect(mockPush).toHaveBeenLastCalledWith("/alerts");
    fireEvent.press(screen.getByTestId("waiting-line-reminders.today"));
    expect(mockPush).toHaveBeenLastCalledWith("/reminders");
    fireEvent.press(screen.getByTestId("waiting-line-roster.dutiesToday"));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: "/seat/[key]", params: { key: "myDuties" } });
    fireEvent.press(screen.getByTestId("waiting-line-lab.reportsBack"));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: "/loops", params: { kind: "lab.reportsBack" } });
    fireEvent.press(screen.getByTestId("waiting-card-all"));
    expect(mockPush).toHaveBeenLastCalledWith("/loops");
    expect(mockPush).toHaveBeenCalledTimes(5);
  });

  it("every kind has a one-tap target", () => {
    for (const k of WAITING_KINDS) { mockPush.mockReset(); openWaiting(mockPush, k); expect(mockPush).toHaveBeenCalledTimes(1); }
  });

  it("nothing waiting: no card on the home", async () => {
    await render(<WaitingCard t={t} lines={[]} push={mockPush} />);
    expect(screen.queryByTestId("waiting-card")).toBeNull();
  });

  it("every kind has its words in English and Hindi", () => {
    for (const lang of ["en", "hi"] as const) {
      for (const k of WAITING_KINDS) {
        expect(translate(lang, `openLoops.kind.${k}`, { count: 2 })).not.toBe(`openLoops.kind.${k}`);
      }
    }
    expect(Object.keys((en as { openLoops: object }).openLoops)).toEqual(Object.keys((hi as { openLoops: object }).openLoops));
  });
});
