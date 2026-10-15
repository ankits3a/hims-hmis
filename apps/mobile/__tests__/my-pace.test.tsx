import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import { I18nProvider, translate } from "../src/i18n";
import { PACE_INK, PaceCard } from "../src/home/pace";
import { loadHome } from "../src/home/load";
import { MyPaceScreen } from "../src/screens/my-pace";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
import { SessionProvider, useSession } from "../src/session";
import { color } from "../src/theme";
import { paceShares, paceWholeMinutes } from "../../../packages/contracts/src/my-pace";
import type { MyPace, PaceBlock } from "../../../packages/contracts/src/my-pace";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "dr.chandan", since: "2026-10-07T03:30:00.000Z" })]]);
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

/**
 * "MY PACE" on the phone (owner 2026-10-09). The figures and the floors are the server's; what is
 * under test here is what a person READS: their own number, two averages, words where the server
 * withheld one — and that nothing about it is coloured as good or bad, because time per patient is
 * not a quality score.
 */
const BLOCK = (over: Partial<PaceBlock> = {}): PaceBlock => ({
  own: { enough: true, meanMin: 8.2, medianMin: 7, n: 212 },
  department: { enough: true, meanMin: 9.4, medianMin: 8 },
  all: { enough: true, meanMin: 11.2, medianMin: 10 },
  excluded: { paper: 14, abandoned: 2, outOfBounds: 3 },
  ...over,
});
const PACE = (over: Partial<PaceBlock> = {}, period: MyPace["period"] = "30d"): MyPace => ({ period, from: "2026-05-17", to: "2026-06-15", consultation: BLOCK(over), vitals: null });
const WITHHELD = { enough: false, meanMin: null, medianMin: null };
const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<string, unknown>;

type Route = { status: number; body?: unknown };
function server(perms: string[], routes: Record<string, Route | ((query: string) => Route)>) {
  const calls: string[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const [bare, query = ""] = path.split("?");
    const key = `${init?.method ?? "GET"} ${bare ?? path}`;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-doc" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(query) : hit;
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}
function Gate({ page }: { page: boolean }) { const { state } = useSession(); return state.status !== "signedIn" ? null : page ? <MyPaceScreen /> : <SeatHome />; }
const mount = async (fetcher: typeof fetch, page: boolean) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate page={page} /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);
const DOCTOR = { id: "doc1", userId: "u-doc", displayName: "Dr. Chandan Kumar", departmentId: "dep1" };

describe("my pace — the home card", () => {
  it("reads the own number big, then the department's and the hospital's average", async () => {
    const onOpen = jest.fn();
    await render(<PaceCard pace={PACE()} t={t} onOpen={onOpen} />);
    expect(screen.getByTestId("pace-own")).toHaveTextContent("8 min");
    expect(screen.getByTestId("pace-row-dept")).toHaveTextContent("Dept9 min");
    expect(screen.getByTestId("pace-row-hospital")).toHaveTextContent("Hospital11 min");
    expect(screen.getByText("My pace")).toBeTruthy();
    expect(screen.getByText("Avg time per consultation")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("home-pace"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("the three bars share one scale: the largest fills it", async () => {
    await render(<PaceCard pace={PACE()} t={t} onOpen={jest.fn()} />);
    expect(flat("pace-bar-hospital-fill").width).toBe("100%");
    expect(flat("pace-bar-dept-fill").width).toBe("84%");
    expect(flat("pace-bar-own-fill").width).toBe("73%");
    expect(paceShares([5, null, 10])).toEqual([0.5, null, 1]);
    expect(paceWholeMinutes(0.4)).toBe(1);
  });

  it("is neutral: no number and no bar takes a red, green or amber", async () => {
    await render(<PaceCard pace={PACE()} t={t} onOpen={jest.fn()} />);
    const loud = new Set<string>([color.green, color.greenSoft, color.greenLine, color.gold, color.goldSoft, color.goldLine, color.red, color.redSoft, color.redLine, color.mint]);
    for (const v of Object.values(PACE_INK)) expect(loud.has(v)).toBe(false);
    const allowed = new Set<string>(Object.values(PACE_INK));
    for (const id of ["pace-own", "pace-dept", "pace-hospital"]) expect(allowed.has(String(flat(id).color))).toBe(true);
    for (const id of ["pace-bar-own", "pace-bar-dept", "pace-bar-hospital", "pace-bar-own-fill", "pace-bar-dept-fill", "pace-bar-hospital-fill"]) {
      expect(allowed.has(String(flat(id).backgroundColor))).toBe(true);
    }
    // No arrow, no rank, no verdict in what is read.
    const words = (n: unknown): string[] => (typeof n === "string" ? [n] : n === null || typeof n !== "object" ? [] : Array.isArray(n) ? n.flatMap(words) : words((n as { children?: unknown }).children ?? []));
    const said = words(screen.toJSON()).join(" | ");
    expect(said).toBe("My pace | 30 days  › | Avg time per consultation | 8 min | Dept | 9 min | Hospital | 11 min");
    for (const mark of ["▲", "▼", "↑", "↓", "%", "#", "better", "worse", "faster", "slower", "rank"]) expect(said).not.toContain(mark);
  });

  it("a withheld department reads a dash, and a doctor under the floor reads 'Not enough yet'", async () => {
    await render(<PaceCard pace={PACE({ department: WITHHELD })} t={t} onOpen={jest.fn()} />);
    expect(screen.getByTestId("pace-dept")).toHaveTextContent("—");
    expect(screen.queryByTestId("pace-bar-dept-fill")).toBeNull();
    expect(screen.getByTestId("pace-hospital")).toHaveTextContent("11 min");
    await screen.unmount();
    await render(<PaceCard pace={PACE({ own: { enough: false, meanMin: null, medianMin: null, n: 4 } })} t={t} onOpen={jest.fn()} />);
    expect(screen.getByTestId("pace-own")).toHaveTextContent("Not enough yet");
    expect(screen.queryByTestId("pace-bar-own-fill")).toBeNull();
  });

  it("draws nothing for a login the server sent no measure", async () => {
    await render(<PaceCard pace={{ ...PACE(), consultation: null }} t={t} onOpen={jest.fn()} />);
    expect(screen.queryByTestId("home-pace")).toBeNull();
    await screen.unmount();
    await render(<PaceCard pace={null} t={t} onOpen={jest.fn()} />);
    expect(screen.queryByTestId("home-pace")).toBeNull();
  });

  it("every label is one short line: at most 34 characters, no sentence, in English and Hindi", () => {
    const leaves = (o: unknown): string[] => (typeof o === "string" ? [o] : Object.values(o as Record<string, unknown>).flatMap(leaves));
    for (const pack of [en.pace, hi.pace]) {
      const all = leaves(pack);
      expect(all.length).toBe(17);
      for (const s of all) {
        const shown = s.replace("{{n}}", "9999");
        expect([shown, shown.length <= 34]).toEqual([shown, true]);
        expect([shown, /[.।!?]/.test(shown)]).toEqual([shown, false]);
      }
    }
    expect(translate("hi", "pace.min", { n: 8 })).toBe("8 मिनट");
  });
});

describe("my pace — who asks", () => {
  const call = (seen: string[], doctor: boolean) => (async (method: string, path: string) => {
    seen.push(`${method} ${path}`);
    if (path === "/opd/me/doctor" && doctor) return DOCTOR;
    if (path.startsWith("/me/performance")) return PACE();
    throw new Error("not served");
  }) as never;

  it("a doctor's home asks for the 30 days", async () => {
    const seen: string[] = [];
    const loaded = await loadHome(call(seen, true), ["opd.consult"], ["consult"], Date.now());
    expect(seen).toContain("GET /me/performance?period=30d");
    expect(loaded.pace?.consultation?.own.n).toBe(212);
  });

  it("desk, cashier, slip desk, scribe and vitals homes make no request", async () => {
    for (const [perms, seats] of [
      [["opd.visits.open"], ["counter"]], [["billing.receipts.create", "opd.visits.open"], ["counter"]],
      [["opd.consult.paper"], ["slips"]], [["opd.prescription.transcribe", "opd.consult.paper"], ["slips"]],
      [["opd.vitals.record"], ["vitals"]],
    ] as const) {
      const seen: string[] = [];
      const loaded = await loadHome(call(seen, false), perms, seats, Date.now());
      expect(seen.filter((s) => s.includes("/me/performance"))).toEqual([]);
      expect(loaded.pace).toBeNull();
    }
  });

  it("the doctor's home draws the card under My day, and a tap opens the page", async () => {
    _forgetHomeForTests(); mockPush.mockClear();
    const { fetcher } = server(["opd.consult"], { "GET /opd/me/doctor": { status: 200, body: DOCTOR }, "GET /me/performance": { status: 200, body: PACE() } });
    await mount(fetcher, false);
    expect(await screen.findByTestId("home-pace")).toHaveTextContent(/8 min/);
    await fireEvent.press(screen.getByTestId("home-pace"));
    expect(mockPush).toHaveBeenCalledWith("/pace");
  });
});

describe("my pace — the page", () => {
  const routes = { "GET /me/performance": (q: string): Route => ({ status: 200, body: PACE(q.includes("7d") ? { own: { enough: true, meanMin: 6.6, medianMin: 6, n: 48 }, excluded: { paper: 0, abandoned: 0, outOfBounds: 0 } } : {}, q.includes("today") ? "today" : q.includes("7d") ? "7d" : "30d") }) };

  it("opens on 30 days with the three numbers, the count, and the paper line", async () => {
    const { fetcher, calls } = server(["opd.consult"], routes);
    await mount(fetcher, true);
    expect(await screen.findByTestId("pace-own")).toHaveTextContent("8 min");
    expect(calls).toContain("GET /me/performance?period=30d");
    expect(screen.getByTestId("pace-chip-30d").props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId("pace-count")).toHaveTextContent("212 consultations");
    expect(screen.getByTestId("pace-paper")).toHaveTextContent("Paper visits not counted");
  });

  it("a period chip changes the request, and no paper line shows when none were left out", async () => {
    const { fetcher, calls } = server(["opd.consult"], routes);
    await mount(fetcher, true);
    await screen.findByTestId("pace-own");
    await fireEvent.press(screen.getByTestId("pace-chip-7d"));
    await waitFor(() => expect(screen.getByTestId("pace-own")).toHaveTextContent("7 min"));
    expect(calls).toContain("GET /me/performance?period=7d");
    expect(screen.getByTestId("pace-count")).toHaveTextContent("48 consultations");
    expect(screen.queryByTestId("pace-paper")).toBeNull();
    await fireEvent.press(screen.getByTestId("pace-chip-today"));
    await waitFor(() => expect(calls).toContain("GET /me/performance?period=today"));
  });
});
