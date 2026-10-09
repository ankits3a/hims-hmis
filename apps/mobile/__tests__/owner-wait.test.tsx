import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider, translate } from "../src/i18n";
import { buildOwnerTiles, isWideTile, ownerTilesFor, type FlowFinding, type FlowReport, type OwnerReads } from "../src/owner/model";
import { subText } from "../src/owner/tiles";
import { OwnerPage } from "../src/screens/owner-page";
import { findingWords, waitDelta } from "../src/screens/owner-wait";
import { SessionProvider, useSession } from "../src/session";
import Page from "../app/owner/[page]";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "abhay", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
const mockParams: { page: string } = { page: "wait" };
jest.mock("expo-router", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => mockParams,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

/**
 * THE "WAIT" TILE AND PAGE (owner 2026-10-09: "how much time … from registration desk to Vital desk and
 * then … from vitals to getting consulted … per department … day, week, month, custom … comparison …
 * show suggestions to improve"). The page is handed its clock; the server is a stub that answers what a
 * real `/opd/reports/flow` answers. No patient or staff name is ever in a wait payload, so none is here.
 */
const OWNER = ["approvals.requests.read", "staff.reports.read", "staff.reports.history.full", "opd.reports.read", "roster.read", "billing.reports.read", "opd.masters.manage"];
const MS = ["approvals.requests.read", "staff.reports.read", "staff.reports.history.full", "opd.reports.read", "roster.read", "patients.read"];
const DOCTOR = ["opd.consult", "opd.queue.read", "opd.queue.operate", "roster.read"];
const DESK = ["opd.visits.open", "patients.register", "opd.queue.read"];
const NOW = Date.parse("2026-10-09T10:00:00+05:30"); // a Friday
const clock = (): number => NOW;

const STAT = (avg: number | null, n = 40) => ({ n, avg, median: avg, p90: avg === null ? null : avg + 10 });
const CELL = (a: number | null, b: number | null) => ({ deskToVitals: STAT(a), vitalsToDoctor: STAT(b), deskToDoctor: STAT(a === null || b === null ? null : a + b) });
const FINDING: FlowFinding = {
  id: "f1", type: "bay_peak", departmentId: "dep1", department: "General Medicine", leg: "deskToVitals", weekday: 0, hourFrom: 10, hourTo: 12,
  observed: 32, baseline: 18, patients: 10, minutesLost: 140, firstSeen: "2026-10-05", lastSeen: "2026-10-09", state: "open",
  triedOn: null, before: null, after: null, resolvedOn: null, minutesWon: null,
};
const FIXED: FlowFinding = { ...FINDING, id: "f9", type: "doctor_start_late", leg: "vitalsToDoctor", weekday: 2, hourFrom: 9, hourTo: 10, state: "resolved", triedOn: "2026-09-20", before: 24, after: 18, resolvedOn: "2026-10-04", minutesWon: 312 };
function report(over: Partial<FlowReport> = {}): FlowReport {
  return {
    from: "2026-10-09", to: "2026-10-09", groupBy: "department", departmentId: null,
    hospital: CELL(9, 15), previous: { from: "2026-10-02", to: "2026-10-02", ...CELL(8, 13) },
    groups: [
      { key: "dep2", name: "Orthopaedics", cell: CELL(14, 22) },
      { key: "dep1", name: "General Medicine", cell: CELL(9, 15) },
      { key: "dep3", name: "ENT", cell: { deskToVitals: STAT(null, 3), vitalsToDoctor: STAT(null, 3), deskToDoctor: STAT(null, 3) } },
    ],
    drops: { guardian: 2, left: 1, paperNoStart: 0, reEntry: 0, outOfRange: 1 },
    findings: [FINDING, { ...FINDING, id: "f2", type: "dept_outlier", leg: "vitalsToDoctor", weekday: null, hourFrom: null, hourTo: null, department: "Orthopaedics", observed: 22, baseline: 14, minutesLost: 90 }],
    fixed: [FIXED], mayAct: true, learning: true, ...over,
  };
}
const HOURS = Array.from({ length: 13 }, (_, i) => ({ key: String(8 + i).padStart(2, "0"), name: null, cell: i === 12 ? CELL(null, null) : CELL(5 + i, 10 + i) }));
const DAYS = Array.from({ length: 7 }, (_, i) => ({ key: String(i), name: null, cell: i === 6 ? CELL(null, null) : CELL(8 + i, 12 + i) }));

type Route = { status: number; body?: unknown };
function server(perms: string[], answer: (path: string, method: string) => Route | undefined) {
  const calls: { method: string; path: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (path === "/auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    const r = answer(path, method);
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, flow: () => calls.filter((c) => c.path.startsWith("/opd/reports/flow?")).map((c) => c.path) };
}
const flowStub = (over: Partial<FlowReport> = {}) => (path: string, method: string): Route | undefined => {
  if (method === "POST" && /\/opd\/reports\/flow\/findings\/[^/]+\/(dismiss|tried)$/.test(path)) return { status: 200, body: { ok: true } };
  if (!path.startsWith("/opd/reports/flow?")) return undefined;
  if (path.includes("groupBy=hour")) return { status: 200, body: report({ ...over, groupBy: "hour", groups: HOURS }) };
  if (path.includes("groupBy=weekday")) return { status: 200, body: report({ ...over, groupBy: "weekday", groups: DAYS }) };
  return { status: 200, body: report(over) };
};
function Gate({ children }: { children: React.ReactNode }) { const { state } = useSession(); return state.status === "signedIn" ? <>{children}</> : null; }
async function mount(fetcher: typeof fetch, node: React.ReactNode, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate>{node}</Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
type Host = { children: (Host | string)[] };
const textOf = (node: Host | string): string => (typeof node === "string" ? node : node.children.map(textOf).join(""));
const text = (id: string): string => textOf(screen.getByTestId(id) as unknown as Host);
const seen = (s: string): number => [...s.normalize("NFC")].filter((ch) => !/\p{M}|\p{Cf}/u.test(ch)).length;

describe("the Wait tile", () => {
  it("today's desk → doctor Avg; '▲ 3 min' against the same weekday last week, or how many are open to fix — never a red or green arrow", () => {
    const keys = ownerTilesFor(OWNER)!;
    const tile = (wait: OwnerReads["wait"]) => buildOwnerTiles(keys, { wait }).find((x) => x.key === "wait")!;
    const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
    const r = report({ hospital: CELL(10, 17), previous: { from: "2026-10-02", to: "2026-10-02", ...CELL(9, 15) }, findings: [] });
    expect([tile(r).value, subText(tile(r), t), tile(r).tone]).toEqual(["27", "▲ 3 min", "plain"]);
    const down = report({ hospital: CELL(7, 12), findings: [] });
    expect([tile(down).value, subText(tile(down), t), tile(down).tone]).toEqual(["19", "▼ 2 min", "plain"]);
    expect([tile(report()).value, subText(tile(report()), t)]).toEqual(["24", "2 to fix"]);
    expect([tile(report({ hospital: CELL(null, null), findings: [] })).value, subText(tile(report({ hospital: CELL(null, null), findings: [] })), t)]).toEqual(["—", null]);
    expect(tile(null)).toMatchObject({ value: "—", failed: true });
  });

  it("the grid stays even: the owner's eight are four rows; the Medical Superintendent's seven end with Learning across", () => {
    const owner = ownerTilesFor(OWNER)!, ms = ownerTilesFor(MS)!;
    expect([owner.length, owner.filter((k) => isWideTile(k, owner)).length]).toEqual([8, 0]);
    expect([ms.length, ms.filter((k) => isWideTile(k, ms))]).toEqual([7, ["learning"]]);
    expect([ownerTilesFor(DOCTOR), ownerTilesFor(DESK)]).toEqual([null, null]);
  });
});

describe("the Wait page", () => {
  it("Today: three numbers each against the same weekday last week; departments ranked under the hospital's line; hours 08–20; weekdays", async () => {
    const { fetcher, flow } = server(OWNER, flowStub());
    await mount(fetcher, <OwnerPage page="wait" now={clock} />);
    await screen.findByTestId("wait-head");
    expect(flow().sort()).toEqual(["/opd/reports/flow?period=today&groupBy=department", "/opd/reports/flow?period=today&groupBy=hour", "/opd/reports/flow?period=today&groupBy=weekday"]);
    expect(text("owner-title")).toBe("How long patients wait");
    expect([text("wait-leg-value-deskToVitals"), text("wait-leg-value-vitalsToDoctor"), text("wait-leg-value-deskToDoctor")]).toEqual(["9", "15", "24"]);
    expect(text("wait-leg-sub-deskToDoctor")).toBe("40 patients · ▲ 3 min · vs same day last week");
    expect(text("wait-leg-sub-deskToVitals")).toBe("40 patients · ▲ 1 min · vs same day last week");
    /* Ranked as the server sent them, the hospital first; a department under the floor says so. */
    const depts = screen.getByTestId("wait-departments");
    expect(textOf(depts as unknown as Host)).toMatch(/^By department · desk → doctorHospital24Orthopaedics36.*General Medicine24.*ENT—Fewer than 5 patients$/);
    expect(screen.getAllByTestId(/^wait-hour-\d\d$/).map((n) => n.props.testID)).toEqual(HOURS.map((h) => `wait-hour-${h.key}`));
    expect(text("wait-hour-08")).toBe("508");
    expect(text("wait-hour-20")).toBe("—20");
    await fireEvent.press(screen.getByTestId("wait-hour-leg-vitalsToDoctor"));
    expect(text("wait-hour-08")).toBe("1008");
    expect(screen.getAllByTestId(/^wait-weekday-\d$/)).toHaveLength(7);
    expect(text("wait-weekday-0")).toMatch(/^Mon20/);
    expect(text("wait-dropped")).toBe("4 visits left out");
    /* Waits are told in ink, never in red or green; red is only a finding card's border. */
    for (const l of ["deskToVitals", "vitalsToDoctor", "deskToDoctor"]) expect(screen.getByTestId(`wait-leg-value-${l}`)).toHaveStyle({ color: "#132420" });
    expect(screen.getByTestId("wait-finding-f1")).toHaveStyle({ borderColor: "#b23a30" });
  });

  it("Week and Month are asked on the server's clock and compared like with like; Custom spells its days and compares with nothing", async () => {
    const { fetcher, flow } = server(OWNER, flowStub());
    await mount(fetcher, <OwnerPage page="wait" now={clock} />);
    await screen.findByTestId("wait-head");
    await fireEvent.press(screen.getByTestId("owner-period-month"));
    await waitFor(() => expect(flow().some((p) => p === "/opd/reports/flow?period=month&groupBy=department")).toBe(true));
    await waitFor(() => expect(text("wait-leg-sub-deskToDoctor")).toMatch(/vs last month to date$/));
    await fireEvent.press(screen.getByTestId("owner-period-week"));
    await waitFor(() => expect(flow().some((p) => p === "/opd/reports/flow?period=week&groupBy=hour")).toBe(true));
    await fireEvent.press(screen.getByTestId("owner-period-custom"));
    await fireEvent.changeText(screen.getByTestId("owner-custom-from"), "2026-09-01");
    await fireEvent.changeText(screen.getByTestId("owner-custom-to"), "2026-09-30");
    await fireEvent.press(screen.getByTestId("owner-custom-apply"));
    await waitFor(() => expect(flow().some((p) => p === "/opd/reports/flow?from=2026-09-01&to=2026-09-30&groupBy=department")).toBe(true));
    for (const p of flow().filter((x) => x.includes("from="))) expect(p).not.toContain("cfrom");
    await waitFor(() => expect(text("wait-leg-sub-deskToDoctor")).toBe("40 patients"));
  });

  it("To improve: each card in its fixed words and numbers; × hides it once, 'Tried it' stamps the day; Fixed shows minutes won", async () => {
    const { fetcher, calls } = server(OWNER, flowStub());
    await mount(fetcher, <OwnerPage page="wait" now={clock} />);
    await screen.findByTestId("wait-improve");
    expect(text("wait-finding-title-f1")).toBe("Slow vitals Mon 10–12");
    expect(text("wait-finding-vs-f1")).toBe("32 min vs 18 usual");
    expect(text("wait-finding-try-f1")).toBe("Add one person at the bay 10–12 Mon");
    expect(text("wait-finding-f1")).toContain("General Medicine");
    expect(text("wait-finding-title-f2")).toBe("Long wait for the doctor");
    expect(text("wait-finding-try-f2")).toBe("Review doctor slots: 57% over the hospital");
    expect(screen.getByTestId("wait-finding-title-f1").props.numberOfLines).toBe(1);
    expect(screen.getByTestId("wait-finding-try-f1").props.numberOfLines).toBe(2);
    expect(text("wait-fixed-f9")).toBe("Slow first hour WedFixed: −6 minGeneral Medicine · 312 patient-minutes saved");

    await fireEvent.press(screen.getByTestId("wait-dismiss-f1"));
    await waitFor(() => expect(screen.queryByTestId("wait-finding-f1")).toBeNull());
    expect(text("wait-said")).toBe("Hidden for 28 days");
    await fireEvent.press(screen.getByTestId("wait-tried-f2"));
    await waitFor(() => expect(text("wait-finding-f2")).toContain("Tried on 9 Oct"));
    expect(screen.queryByTestId("wait-tried-f2")).toBeNull();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/opd/reports/flow/findings/f1/dismiss", "/opd/reports/flow/findings/f2/tried"]);
  });

  it("a refused act changes nothing and says so; a reader the server says may not act gets no buttons; learning off says so", async () => {
    const refusing = server(OWNER, (p, m) => (m === "POST" ? { status: 403, body: { message: "no" } } : flowStub()(p, m)));
    const a = await mount(refusing.fetcher, <OwnerPage page="wait" now={clock} />);
    await screen.findByTestId("wait-improve");
    await fireEvent.press(screen.getByTestId("wait-dismiss-f1"));
    await waitFor(() => expect(text("wait-said")).toBe("Not saved — try again"));
    expect(screen.getByTestId("wait-finding-f1")).toBeTruthy();
    await a.unmount();
    const reader = server(MS, flowStub({ mayAct: false }));
    const b = await mount(reader.fetcher, <OwnerPage page="wait" now={clock} />);
    await screen.findByTestId("wait-improve");
    expect([screen.queryByTestId("wait-dismiss-f1"), screen.queryByTestId("wait-tried-f1")]).toEqual([null, null]);
    await b.unmount();
    const off = server(OWNER, flowStub({ learning: false, findings: [], fixed: [] }));
    await mount(off.fetcher, <OwnerPage page="wait" now={clock} />);
    await screen.findByTestId("wait-improve");
    expect(text("wait-improve")).toContain("Learning is switched off");
  });

  it("says the same in Hindi, every label one line", async () => {
    const { fetcher } = server(OWNER, flowStub());
    await mount(fetcher, <OwnerPage page="wait" now={clock} />, "hi");
    await screen.findByTestId("wait-head");
    expect(text("owner-title")).toBe("मरीज़ कितनी देर रुकते हैं");
    expect(text("wait-finding-title-f1")).toBe("वाइटल्स धीमे सोम 10–12");
    expect(text("wait-finding-vs-f1")).toBe("32 मिनट, आम तौर पर 18");
    expect(text("wait-finding-try-f1")).toBe("सोम 10–12 वाइटल्स पर एक व्यक्ति और लगाएँ");
    expect(text("wait-leg-sub-deskToDoctor")).toBe("40 मरीज़ · ▲ 3 मिनट · पिछले हफ़्ते इसी दिन से");
  });

  it("a doctor and the desk are sent home from the page, and nothing is asked; the Medical Superintendent opens it", async () => {
    for (const perms of [DOCTOR, DESK]) {
      const { fetcher, calls } = server(perms, flowStub());
      const v = await mount(fetcher, <Page />);
      await screen.findByTestId("redirect");
      expect(calls.filter((c) => c.path !== "/auth/me")).toEqual([]);
      await v.unmount();
    }
    const { fetcher } = server(MS, flowStub());
    await mount(fetcher, <Page />);
    await screen.findByTestId("wait-head");
  });
});

describe("the words — fixed templates, one line at 360 px", () => {
  const T = (lang: "en" | "hi") => (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  it("every finding type, in English and Hindi, at its widest: a title of at most 34, a try-line of at most 60, the numbers line at most 34", () => {
    const widest: FlowFinding[] = (["bay_peak", "doctor_start_late", "dept_outlier", "week_regression"] as const).flatMap((type) =>
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ ...FINDING, type, weekday, hourFrom: 18, hourTo: 20, observed: 480, baseline: 1, patients: 9999 })));
    const over: string[] = [];
    for (const lang of ["en", "hi"] as const) {
      for (const f of widest) {
        const w = findingWords(f, T(lang));
        if (seen(w.title) > 34) over.push(`${lang} title ${w.title}`);
        if (seen(w.tryLine) > 60) over.push(`${lang} try ${w.tryLine}`);
        if (seen(w.vs) > 34) over.push(`${lang} vs ${w.vs}`);
        expect(`${w.title}${w.tryLine}${w.vs}`).not.toMatch(/\{\{|undefined|NaN/);
      }
    }
    expect(over).toEqual([]);
    expect(waitDelta(STAT(20), STAT(20), T("en"))).toBe("same");
    expect(waitDelta(STAT(20), STAT(null), T("en"))).toBeNull();
  });
});
