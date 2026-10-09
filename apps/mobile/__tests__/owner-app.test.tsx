import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider, translate } from "../src/i18n";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import { coldOf } from "../src/home/cache";
import { buildHome } from "../src/home/model";
import {
  addDayIso, arrowCount, arrowPercent, buildOwnerTiles, coldOwnerTiles, drawerWords, istDayOf, monthSoFar, ownerRange, ownerTilesFor, rangeProblem,
  rupeesShort, type OwnerReads,
} from "../src/owner/model";
import { subText } from "../src/owner/tiles";
import { OwnerPage } from "../src/screens/owner-page";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
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
const mockPush = jest.fn();
const mockParams: { page: string } = { page: "money" };
jest.mock("expo-router", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    useRouter: () => ({ push: mockPush, back: jest.fn() }),
    useLocalSearchParams: () => mockParams,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

/**
 * THE OWNER'S SCREENS (owner 2026-10-09: "Home as seven tiles (drawn)" · "Medical Superintendent too but
 * Money page for owner alone" · "Staff page without attendance … acceptable for now").
 *
 * Every page test hands the screen its clock (`NOW`), so no date here depends on the day the suite
 * runs. The home reads the real clock, and its expectations are derived from that same clock.
 */
const OWNER = ["approvals.requests.read", "approvals.requests.decide", "staff.reports.read", "staff.reports.history.full", "opd.reports.read", "roster.read", "billing.reports.read", "billing.session.read", "pharmacy.reports.read", "opd.masters.manage"];
const MS = ["approvals.requests.read", "approvals.requests.decide", "staff.reports.read", "staff.reports.history.full", "opd.reports.read", "roster.read", "patients.read"];
const DOCTOR = ["opd.consult", "opd.queue.read", "opd.queue.operate", "roster.read"];
const CASHIER = ["billing.session.own", "billing.receipt.record", "billing.invoice.issue"];
const SUPERVISOR = ["staff.reports.read", "staff.reports.history.year", "opd.reports.read", "roster.read", "opd.visits.open"];

/** A Friday. Handed to every page; the server's month block is written to match it. */
const NOW = Date.parse("2026-10-09T10:00:00+05:30");
const clock = (): number => NOW;

type Route = { status: number; body?: unknown } | "offline";
function server(perms: string[], routes: Record<string, Route | ((path: string) => Route)>, user = "u-owner") {
  const calls: { key: string; path: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.split("?")[0] ?? path}`;
    calls.push({ key, path });
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: user }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(path) : hit;
    if (r === "offline") throw new TypeError("Network request failed");
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, sent: (key: string) => calls.filter((c) => c.key === key).map((c) => c.path) };
}
function Gate({ children }: { children: React.ReactNode }) { const { state } = useSession(); return state.status === "signedIn" ? <>{children}</> : null; }
async function mount(fetcher: typeof fetch, node: React.ReactNode, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate>{node}</Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

const C = { opened: 80, consulted: 70, onScreen: 38, onPaper: 32, photographed: 23, typed: 19, issued: 38, issuedLines: 90, toType: 4, notRecorded: 9, stillOpen: 8 };
const RECORDING = {
  from: "2026-10-09", to: "2026-10-09", period: "day", anchor: "2026-10-09", scope: "hospital", totals: C, mine: null, days: [], departments: [],
  doctors: [
    { ...C, id: "d1", name: "Dr. Chandan Kumar", consulted: 22, notRecorded: 0 },
    { ...C, id: "d2", name: "Dr. Saurabh Ranjan", consulted: 18, notRecorded: 5 },
  ],
};
const MONEY = {
  from: "2026-10-09", to: "2026-10-09", collectedPaise: 1_430_000, receipts: 31, byMode: { cash: 810_000, upi: 540_000, card: 80_000 },
  previous: { from: "2026-10-02", to: "2026-10-02", collectedPaise: 1_276_800 },
  month: { now: { from: "2026-10-01", to: "2026-10-09", collectedPaise: 14_200_000 }, before: { from: "2026-09-01", to: "2026-09-09", collectedPaise: 13_148_000 } },
  cashiers: [
    { name: "Asha Devi", openedDay: "2026-10-09", collectedPaise: 920_000, state: "exact", variancePaise: 0 },
    { name: "Suresh Pillai", openedDay: "2026-10-09", collectedPaise: 510_000, state: "open", variancePaise: null },
    { name: "Ritu Kumari", openedDay: "2026-10-09", collectedPaise: 0, state: "short", variancePaise: -12_000 },
    { name: "Mohan Lal", openedDay: "2026-10-09", collectedPaise: 0, state: "excess", variancePaise: 5_000 },
  ],
  refunds: { count: 2, amountPaise: 120_000 }, discountsPaise: 45_000, letThroughUnpaid: 3,
};
const APPTS = {
  from: "2026-10-09", to: "2026-10-09", total: 18, came: 14, toCome: 2, missed: 0, needRebooking: 2, cancelled: 1,
  previous: { from: "2026-10-02", to: "2026-10-02", total: 15 },
  doctors: [{ id: "d1", name: "Dr. Chandan Kumar", total: 7, came: 6 }, { id: "d2", name: "Dr. Nitish Kumar Jha", total: 6, came: 5 }],
};
const PHARMACY = {
  from: "2026-10-09", to: "2026-10-09", bills: 41, salesPaise: 892_000, refundsPaise: 0,
  previous: { from: "2026-10-02", to: "2026-10-02", bills: 39, salesPaise: 857_700 },
  split: [{ key: "dispense", bills: 30, salesPaise: 630_000 }, { key: "walk_in", bills: 11, salesPaise: 262_000 }],
  prescriptions: { reached: 38, served: 33 },
  stock: { low: 3, expiring60: 7, askedOut: 2, askedNames: ["Pantoprazole 40", "ORS"] },
};
const PHARMACY_MS = { ...PHARMACY, salesPaise: null, refundsPaise: null, previous: { ...PHARMACY.previous, salesPaise: null }, split: PHARMACY.split.map((s) => ({ ...s, salesPaise: null })) };
const STAFF = {
  day: "2026-10-09", onDuty: 46, onLeave: [{ userId: "u1", name: "Dr. Sonam Kumari" }, { userId: "u2", name: "Vivek Kumar" }],
  gaps: [{ department: "Orthopaedics", from: "2026-10-09T14:30:00.000Z", what: "Senior resident" }],
  waiting: { cover: 1, coverLines: [{ department: "Orthopaedics", day: "2026-10-10" }], leave: 2 },
};
const LEARNING = {
  on: false, mayUndo: true, tapped: { accepted: 71, acted: 100 }, misses: 12,
  nicknames: [
    { id: "n1", nickname: "pan forty", medicine: "Pan 40 mg tablet", detail: "40 mg · tablet", state: "suggested", removedBy: null, doctors: 2, taps: 4, changedAt: "2026-10-08T05:00:00.000Z" },
    { id: "n2", nickname: "dolo six fifty", medicine: "Dolo 650 mg tablet", detail: null, state: "trusted", removedBy: null, doctors: 3, taps: 12, changedAt: "2026-10-07T05:00:00.000Z" },
    { id: "n3", nickname: "telma h", medicine: "Telma H", detail: null, state: "removed", removedBy: "doctors", doctors: 2, taps: 1, changedAt: "2026-10-06T05:00:00.000Z" },
    { id: "n4", nickname: "aug six two five", medicine: "Augmentin 625", detail: null, state: "suggested", removedBy: null, doctors: 1, taps: 1, changedAt: "2026-10-06T04:00:00.000Z" },
  ],
};
const TILE_ROUTES = ["GET /billing/reports/owner-money", "GET /staff/range", "GET /opd/reports/appointments-summary", "GET /pharmacy/office/reports/owner-summary", "GET /roster/staff-today", "GET /opd/reports/learning"];
/** The home's reads, answered for the day the suite runs (the home reads the real clock). */
function homeRoutes(over: Record<string, Route | ((path: string) => Route)> = {}, pharmacy: unknown = PHARMACY) {
  const today = istDayOf(Date.now());
  return {
    "GET /billing/reports/owner-money": { status: 200, body: MONEY },
    "GET /staff/range": { status: 200, body: { rows: [{ key: { day: today }, measures: { "opd.visitsOpened": 74 } }, { key: { day: addDayIso(today, -7) }, measures: { "opd.visitsOpened": 68 } }] } },
    "GET /opd/reports/recording": { status: 200, body: RECORDING },
    "GET /opd/reports/appointments-summary": { status: 200, body: APPTS },
    "GET /pharmacy/office/reports/owner-summary": { status: 200, body: pharmacy },
    "GET /roster/staff-today": { status: 200, body: STAFF },
    "GET /opd/reports/learning": { status: 200, body: LEARNING },
    "GET /approvals": { status: 200, body: { items: [{ id: "a1", typeKey: "billing_refund_owner", amountPaise: 3_200_000, requestedAt: new Date(Date.now() - 600_000).toISOString(), dueAt: null, requesterName: "Asha Devi", requestNote: null, patient: null }] } },
    ...over,
  } as Record<string, Route | ((path: string) => Route)>;
}
type Host = { children: (Host | string)[] };
const textOf = (node: Host | string): string => (typeof node === "string" ? node : node.children.map(textOf).join(""));
const pageText = (id = "owner-scroll"): string => textOf(screen.getByTestId(id) as unknown as Host);
const tileText = (key: string): [string, string] => [
  textOf(screen.getByTestId(`owner-tile-value-${key}`) as unknown as Host), textOf(screen.getByTestId(`owner-tile-sub-${key}`) as unknown as Host),
];

describe("the owner's home — seven tiles", () => {
  beforeEach(() => { _forgetHomeForTests(); mockPush.mockClear(); });

  it("the owner sees seven tiles, each with its number from one read, under an untouched 'Needs you now'", async () => {
    const { fetcher, sent } = server(OWNER, homeRoutes());
    await mount(fetcher, <SeatHome />);
    await screen.findByTestId("owner-tiles");
    expect(tileText("money")).toEqual(["₹14,300", "▲ 12%"]);
    expect(tileText("opd")).toEqual(["74", "▲ 6"]);
    expect(tileText("recorded")).toEqual(["61 / 70", "9 missing"]);
    expect(tileText("appointments")).toEqual(["18", "2 to rebook"]);
    expect(tileText("pharmacy")).toEqual(["₹8,920", "3 low stock"]);
    expect(tileText("staff")).toEqual(["46", "1 gap"]);
    expect(tileText("learning")).toEqual(["4", "switched off"]);
    /* One request per tile; Recorded is the read the home already made for everybody. */
    for (const key of [...TILE_ROUTES, "GET /opd/reports/recording"]) expect({ key, n: sent(key).length }).toEqual({ key, n: 1 });
    const today = istDayOf(Date.now()), lastWeek = addDayIso(today, -7);
    expect(sent("GET /billing/reports/owner-money")[0]).toBe(`/billing/reports/owner-money?from=${today}&to=${today}&cfrom=${lastWeek}&cto=${lastWeek}`);
    /* What the tiles replaced is gone; what was to stay has stayed. */
    for (const gone of ["home-departments", "home-on-duty", "home-30", "home-recorded", "tile-opdToday", "tile-collected", "tile-approvals"]) expect(screen.queryByTestId(gone)).toBeNull();
    expect(screen.getByTestId("need-approval")).toHaveTextContent(/Refund/);
    expect(screen.getByTestId("seat-onNow")).toBeTruthy();
    expect(screen.getByTestId("signed-in-as")).toHaveTextContent("Hospital · all departments");
    await fireEvent.press(screen.getByTestId("owner-tile-money"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/owner/[page]", params: { page: "money" } });
  });

  it("the Medical Superintendent sees six — no Money tile, no money asked for, no rupee on the screen", async () => {
    const { fetcher, sent } = server(MS, homeRoutes({ "GET /billing/reports/owner-money": { status: 403, body: { message: "missing permission billing.reports.read" } } }, PHARMACY_MS));
    await mount(fetcher, <SeatHome />);
    await screen.findByTestId("owner-tiles");
    expect(screen.queryByTestId("owner-tile-money")).toBeNull();
    for (const key of ["opd", "recorded", "appointments", "pharmacy", "staff", "learning"]) expect(screen.getByTestId(`owner-tile-${key}`)).toBeTruthy();
    expect(sent("GET /billing/reports/owner-money")).toEqual([]);
    /* The pharmacy tile is the bill count for her, with the same exception line. */
    expect(tileText("pharmacy")).toEqual(["41", "3 low stock"]);
    /* Her approvals still carry their amounts ("Needs you now" is untouched); the tiles carry none. */
    expect(pageText("owner-tiles")).not.toMatch(/₹/);
  });

  it("a doctor, a cashier and a supervisor keep the home they had — no tile, and none of the tiles' reads is asked", async () => {
    expect([ownerTilesFor(DOCTOR), ownerTilesFor(CASHIER), ownerTilesFor(SUPERVISOR)]).toEqual([null, null, null]);
    expect(ownerTilesFor(OWNER)).toEqual(["money", "opd", "recorded", "appointments", "pharmacy", "staff", "learning"]);
    expect(ownerTilesFor(MS)).toEqual(["opd", "recorded", "appointments", "pharmacy", "staff", "learning"]);

    /* The cashier: the same three tiles as before, Collected still locked behind the count. */
    const cashier = server(CASHIER, homeRoutes({
      "GET /me/brief": { status: 200, body: { totals: { "billing.receipts": 12 }, clauses: [] } },
      "GET /me/desk": { status: 200, body: { cards: [{ key: "billing.myCollections", stats: [{ key: "desk.billing.receipts", value: "12" }] }] } },
    }), "u-cashier");
    const a = await mount(cashier.fetcher, <SeatHome />);
    await screen.findByTestId("tile-collected");
    expect(screen.queryByTestId("owner-tiles")).toBeNull();
    expect(screen.getByTestId("tile-locked")).toBeTruthy();
    expect(screen.getByTestId("tile-billing.receipts")).toHaveTextContent(/^12/);
    for (const key of TILE_ROUTES.filter((k) => k !== "GET /staff/range")) expect({ key, sent: cashier.sent(key) }).toEqual({ key, sent: [] });
    await a.unmount();
    _forgetHomeForTests();

    /* The doctor: the line's three tiles, and the doctor's own Recorded card. */
    const queue = { session: { id: "s1" }, counts: { waiting: 3, done: 9 }, ordered: [] };
    const doctor = server(DOCTOR, homeRoutes({
      "GET /opd/doctors/me": { status: 200, body: { id: "d1", userId: "u-doc", displayName: "Dr. Chandan Kumar", departmentId: "dep1" } },
      "GET /opd/doctors/d1/queue": { status: 200, body: queue },
      "GET /opd/reports/recording": { status: 200, body: { ...RECORDING, scope: "mine", doctors: null } },
    }), "u-doc");
    await mount(doctor.fetcher, <SeatHome />);
    await screen.findByTestId("home-recorded");
    expect(screen.queryByTestId("owner-tiles")).toBeNull();
    for (const key of TILE_ROUTES) expect({ key, sent: doctor.sent(key) }).toEqual({ key, sent: [] });
  });

  it("a tile whose read failed shows — and still opens its page; the others are untouched", async () => {
    const { fetcher } = server(OWNER, homeRoutes({ "GET /pharmacy/office/reports/owner-summary": { status: 500, body: { message: "boom" } }, "GET /roster/staff-today": "offline" }));
    await mount(fetcher, <SeatHome />);
    await screen.findByTestId("owner-tiles");
    expect(tileText("pharmacy")).toEqual(["—", " "]);
    expect(tileText("staff")).toEqual(["—", " "]);
    expect(tileText("money")).toEqual(["₹14,300", "▲ 12%"]);
    expect(screen.getByTestId("home-as-of")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("owner-tile-pharmacy"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/owner/[page]", params: { page: "pharmacy" } });
  });

  it("says the same in Hindi, one line each", async () => {
    const { fetcher } = server(OWNER, homeRoutes());
    await mount(fetcher, <SeatHome />, "hi");
    await screen.findByTestId("owner-tiles");
    expect(tileText("recorded")).toEqual(["61 / 70", "9 बाकी"]);
    expect(screen.getByTestId("owner-tile-money")).toHaveTextContent(/पैसा/);
    for (const key of ["money", "opd", "recorded", "appointments", "pharmacy", "staff", "learning"]) {
      expect(screen.getByTestId(`owner-tile-sub-${key}`).props.numberOfLines).toBe(1);
      expect(screen.getByTestId(`owner-tile-value-${key}`).props.numberOfLines).toBe(1);
    }
  });
});

describe("what the phone keeps of the owner's tiles", () => {
  const reads: OwnerReads = { money: MONEY as OwnerReads["money"], opd: { today: 74, lastWeek: 68 }, recorded: RECORDING as OwnerReads["recorded"], appointments: APPTS as OwnerReads["appointments"], pharmacy: PHARMACY as OwnerReads["pharmacy"], staff: STAFF, learning: LEARNING as OwnerReads["learning"] };
  const base = { nowMs: NOW, permissions: OWNER, seats: [], hospital: { byDepartment: [], collectedTodayPaise: null, collections: [] } };

  it("a key and a number per tile — no name, no sub-line; and no rupee at all on a phone that is not the owner's", () => {
    const owner = coldOf("u-owner", NOW, buildHome(base), coldOwnerTiles(buildOwnerTiles(ownerTilesFor(OWNER)!, reads)));
    expect(owner.tiles.map((t) => Object.keys(t).sort())).toEqual(Array.from({ length: 7 }, () => ["key", "labelKey", "value"]));
    expect(owner.tiles.find((t) => t.key === "money")?.value).toBe("₹14,300");
    expect(JSON.stringify(owner)).not.toMatch(/Asha|Sonam|Vivek|Chandan|pan forty|Pantoprazole|Orthopaedics/);

    const msReads: OwnerReads = { ...reads, money: undefined, pharmacy: PHARMACY_MS as OwnerReads["pharmacy"] };
    const ms = coldOf("u-ms", NOW, buildHome({ ...base, permissions: MS }), coldOwnerTiles(buildOwnerTiles(ownerTilesFor(MS)!, msReads)));
    expect(ms.tiles.map((t) => t.key)).toEqual(["opd", "recorded", "appointments", "pharmacy", "staff", "learning"]);
    expect(JSON.stringify(ms)).not.toMatch(/₹|money|Paise|14,300|8,920/);
  });
});

describe("a page behind a tile", () => {
  beforeEach(() => { mockPush.mockClear(); });
  const PERIODIC: [page: "money" | "appointments" | "pharmacy" | "recorded" | "opd", key: string, body: unknown][] = [
    ["money", "GET /billing/reports/owner-money", MONEY],
    ["appointments", "GET /opd/reports/appointments-summary", APPTS],
    ["pharmacy", "GET /pharmacy/office/reports/owner-summary", PHARMACY],
    ["recorded", "GET /opd/reports/recording", RECORDING],
    ["opd", "GET /staff/range", { rows: [{ key: { departmentId: "dep1", day: "2026-10-09" }, measures: { "opd.visitsOpened": 28 } }] }],
  ];

  it.each(PERIODIC)("%s: each chip asks for its own days, and the line under the headline says what it is compared with", async (page, key, body) => {
    const { fetcher, sent } = server(OWNER, { [key]: { status: 200, body }, "GET /opd/departments": { status: 200, body: [{ id: "dep1", name: "General Medicine" }] } });
    await mount(fetcher, <OwnerPage page={page} now={clock} />);
    await screen.findByTestId("owner-head");
    const asked = (): string => sent(key).join(" | ");
    expect(asked()).toContain("from=2026-10-09&to=2026-10-09");
    expect(asked()).toContain("2026-10-02"); // the same weekday last week
    expect(screen.getByTestId("owner-compare")).toHaveTextContent(/vs same day last week$/);
    expect(screen.getByTestId("owner-range")).toHaveTextContent("9 Oct");

    await fireEvent.press(screen.getByTestId("owner-period-week"));
    await waitFor(() => expect(asked()).toContain("from=2026-10-05&to=2026-10-09"));
    expect(asked()).toMatch(/from=2026-09-28&c?to=2026-10-02/); // Monday to the same weekday, a week back
    await waitFor(() => expect(screen.getByTestId("owner-compare")).toHaveTextContent(/vs last week to date$/));
    expect(screen.getByTestId("owner-range")).toHaveTextContent("5 Oct – 9 Oct");

    await fireEvent.press(screen.getByTestId("owner-period-month"));
    await waitFor(() => expect(asked()).toContain("from=2026-10-01&to=2026-10-09"));
    expect(asked()).toMatch(/from=2026-09-01&c?to=2026-09-09/); // last month to the same day number
    await waitFor(() => expect(screen.getByTestId("owner-compare")).toHaveTextContent(/vs last month to date$/));

    /* Custom: nothing is asked until two good dates are given; then those days, compared with nothing. */
    const before = sent(key).length;
    await fireEvent.press(screen.getByTestId("owner-period-custom"));
    await screen.findByTestId("owner-custom");
    expect(screen.queryByTestId("owner-head")).toBeNull();
    await fireEvent.changeText(screen.getByTestId("owner-custom-from"), "2026-06-01");
    await fireEvent.changeText(screen.getByTestId("owner-custom-to"), "2026-10-09");
    await fireEvent.press(screen.getByTestId("owner-custom-apply"));
    expect(screen.getByTestId("owner-custom-error")).toHaveTextContent("At most 92 days");
    await fireEvent.changeText(screen.getByTestId("owner-custom-from"), "2026-10-05");
    await fireEvent.changeText(screen.getByTestId("owner-custom-to"), "2026-10-10");
    await fireEvent.press(screen.getByTestId("owner-custom-apply"));
    expect(screen.getByTestId("owner-custom-error")).toHaveTextContent("Not after today");
    await fireEvent.changeText(screen.getByTestId("owner-custom-to"), "2026-10-01");
    await fireEvent.press(screen.getByTestId("owner-custom-apply"));
    expect(screen.getByTestId("owner-custom-error")).toHaveTextContent("To is before From");
    expect(sent(key).length).toBe(before);
    await fireEvent.changeText(screen.getByTestId("owner-custom-from"), "2026-09-20");
    await fireEvent.changeText(screen.getByTestId("owner-custom-to"), "2026-10-03");
    await fireEvent.press(screen.getByTestId("owner-custom-apply"));
    await screen.findByTestId("owner-head");
    const last = sent(key).slice(before);
    expect(last.length).toBeGreaterThan(0);
    for (const path of last) { expect(path).toContain("from=2026-09-20&to=2026-10-03"); expect(path).not.toContain("cfrom"); }
    expect(screen.queryByTestId("owner-compare")).toBeNull();
    expect(screen.queryByTestId("owner-custom-error")).toBeNull();
  });

  it("money: the comparison, the month against last month, the split, and every drawer said in words", async () => {
    const { fetcher } = server(OWNER, { "GET /billing/reports/owner-money": { status: 200, body: MONEY } });
    await mount(fetcher, <OwnerPage page="money" now={clock} />);
    await screen.findByTestId("owner-head");
    expect(screen.getByTestId("owner-head-value")).toHaveTextContent("₹14,300");
    expect(screen.getByTestId("owner-compare")).toHaveTextContent("▲ 12% · vs same day last week");
    expect(screen.getByTestId("owner-money-month")).toHaveTextContent(/Month so far.*₹1\.42 L.*▲ 8% vs Sep/);
    expect(screen.getByTestId("owner-money-cash")).toHaveTextContent(/Cash.*₹8,100/);
    expect(screen.getByTestId("owner-cashier-0")).toHaveTextContent(/Asha Devi.*₹9,200.*counted · exact/);
    expect(screen.getByTestId("owner-cashier-1")).toHaveTextContent(/Suresh Pillai.*₹5,100.*open · not counted/);
    expect(screen.getByTestId("owner-cashier-2")).toHaveTextContent(/Ritu Kumari.*counted · short ₹120/);
    expect(screen.getByTestId("owner-cashier-3")).toHaveTextContent(/Mohan Lal.*counted · excess ₹50/);
    expect(screen.getByTestId("owner-money-rest")).toHaveTextContent(/Refunds.*₹1,200.*2 paid.*Discounts.*₹450.*Let through unpaid.*3/);
    expect(drawerWords("short", -12_000)).toEqual({ key: "owner.money.drawer.short", vars: { amount: "₹120" } });
  });

  it("a read that failed says so, offers to try again, and draws no number in its place", async () => {
    let fail = true;
    const { fetcher } = server(OWNER, { "GET /pharmacy/office/reports/owner-summary": () => (fail ? { status: 500, body: { message: "boom" } } : { status: 200, body: PHARMACY }) });
    await mount(fetcher, <OwnerPage page="pharmacy" now={clock} />);
    expect(await screen.findByTestId("owner-failed")).toHaveTextContent("This part did not load");
    expect(screen.queryByTestId("owner-head")).toBeNull();
    fail = false;
    await fireEvent.press(screen.getByTestId("owner-again"));
    expect(await screen.findByTestId("owner-head-value")).toHaveTextContent("₹8,920");
    expect(screen.queryByTestId("owner-failed")).toBeNull();
  });

  it("recorded: on record of consulted, per doctor, and how each consultation got onto the record", async () => {
    const { fetcher } = server(OWNER, { "GET /opd/reports/recording": { status: 200, body: RECORDING } });
    await mount(fetcher, <OwnerPage page="recorded" now={clock} />);
    expect(await screen.findByTestId("owner-head-value")).toHaveTextContent("61 of 70");
    expect(screen.getByTestId("owner-recorded-doctor-d1")).toHaveTextContent(/Dr\. Chandan Kumar.*22 \/ 22/);
    expect(screen.getByTestId("owner-recorded-doctor-d2")).toHaveTextContent(/Dr\. Saurabh Ranjan.*13 \/ 18.*5 not recorded/);
    expect(screen.getByTestId("owner-recorded-how")).toHaveTextContent(/On screen.*38.*Paper, typed.*19.*Paper, photo only.*4.*Not recorded.*9/);
  });

  it("appointments and pharmacy: counts as sent; the Medical Superintendent's pharmacy page carries no rupee", async () => {
    const a = server(OWNER, { "GET /opd/reports/appointments-summary": { status: 200, body: APPTS } });
    const first = await mount(a.fetcher, <OwnerPage page="appointments" now={clock} />);
    expect(await screen.findByTestId("owner-head-value")).toHaveTextContent("18");
    expect(screen.getByTestId("owner-compare")).toHaveTextContent("▲ 3 · vs same day last week");
    expect(screen.getByTestId("owner-appointments-status")).toHaveTextContent(/Came.*14.*To come.*2.*Missed.*0.*Need rebooking.*2.*Cancelled.*1/);
    expect(screen.getByTestId("owner-appointments-doctors")).toHaveTextContent(/Dr\. Chandan Kumar.*7.*6 came/);
    expect(pageText()).not.toMatch(/Tele|tele/); // no tele line: the data has no channel
    await first.unmount();

    const p = server(OWNER, { "GET /pharmacy/office/reports/owner-summary": { status: 200, body: PHARMACY } });
    const second = await mount(p.fetcher, <OwnerPage page="pharmacy" now={clock} />);
    expect(await screen.findByTestId("owner-head-value")).toHaveTextContent("₹8,920");
    expect(screen.getByTestId("owner-pharmacy-sales")).toHaveTextContent(/Bills.*41.*₹218 each.*Prescriptions.*₹6,300.*Walk-in sales.*₹2,620/);
    expect(screen.getByTestId("owner-pharmacy-served")).toHaveTextContent(/33 \/ 38/);
    expect(screen.getByTestId("owner-pharmacy-stock")).toHaveTextContent(/Low stock.*3.*Expiring in 60 days.*7.*Out of stock, asked for.*2.*Pantoprazole 40, ORS/);
    await second.unmount();

    const m = server(MS, { "GET /pharmacy/office/reports/owner-summary": { status: 200, body: { ...PHARMACY_MS, stock: null } } }, "u-ms");
    await mount(m.fetcher, <OwnerPage page="pharmacy" now={clock} />);
    expect(await screen.findByTestId("owner-head")).toHaveTextContent(/Bills.*41/);
    expect(pageText()).not.toMatch(/₹/);
    expect(screen.queryByTestId("owner-pharmacy-stock")).toBeNull(); // no stock read: the lines are not drawn
  });

  it("staff: on duty, on leave by name, gaps, what waits — never 'absent'; a gap opens the roster board", async () => {
    const { fetcher } = server(OWNER, { "GET /roster/staff-today": { status: 200, body: STAFF } });
    await mount(fetcher, <OwnerPage page="staff" now={clock} />);
    expect(await screen.findByTestId("owner-head")).toHaveTextContent(/On duty now.*46/);
    expect(screen.queryByTestId("owner-periods")).toBeNull();
    expect(screen.getByTestId("owner-staff-leave")).toHaveTextContent(/On leave today.*2.*Dr\. Sonam Kumari.*Vivek Kumar/);
    expect(screen.getByTestId("owner-staff-gaps")).toHaveTextContent(/Orthopaedics.*20:00.*Senior resident/);
    expect(screen.getByTestId("owner-staff-waiting")).toHaveTextContent(/Cover requests.*1.*Orthopaedics · 10 Oct.*Leave requests.*2/);
    expect(pageText()).not.toMatch(/[Aa]bsent/);
    await fireEvent.press(screen.getByTestId("owner-gap-0"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "onNow" } });
  });

  it("learning: Undo calls the existing route once and the row flips to Put back; a reader without the grant gets no button", async () => {
    const { fetcher, sent } = server(OWNER, {
      "GET /opd/reports/learning": { status: 200, body: LEARNING },
      "POST /opd/consult/nicknames/n1/undo": { status: 201, body: { ok: true } },
      "POST /opd/consult/nicknames/n1/restore": { status: 201, body: { ok: true } },
    });
    const first = await mount(fetcher, <OwnerPage page="learning" now={clock} />);
    expect(await screen.findByTestId("owner-learning-on")).toHaveTextContent("Nickname learning is switched off");
    expect(screen.getByTestId("owner-nickname-what-n1")).toHaveTextContent("Pan 40 mg tablet · 2 doctors");
    expect(screen.getByTestId("owner-nickname-what-n2")).toHaveTextContent("Dolo 650 mg tablet · trusted");
    expect(screen.getByTestId("owner-nickname-what-n3")).toHaveTextContent("removed · crossed off");
    expect(screen.getByTestId("owner-nickname-act-n3")).toHaveTextContent("Put back");
    expect(screen.getByTestId("owner-learning-numbers")).toHaveTextContent(/Suggestions tapped.*71%.*Words not understood.*12/);

    await fireEvent.press(screen.getByTestId("owner-nickname-act-n1"));
    await waitFor(() => expect(screen.getByTestId("owner-nickname-act-n1")).toHaveTextContent("Put back"));
    expect(screen.getByTestId("owner-nickname-what-n1")).toHaveTextContent("removed");
    expect(sent("POST /opd/consult/nicknames/n1/undo")).toHaveLength(1);
    expect(sent("GET /opd/reports/learning")).toHaveLength(1);
    await fireEvent.press(screen.getByTestId("owner-nickname-act-n1"));
    await waitFor(() => expect(screen.getByTestId("owner-nickname-act-n1")).toHaveTextContent("Undo"));
    expect(sent("POST /opd/consult/nicknames/n1/restore")).toHaveLength(1);
    await first.unmount();

    const ro = server(MS, { "GET /opd/reports/learning": { status: 200, body: { ...LEARNING, mayUndo: false, tapped: null } } }, "u-ms");
    await mount(ro.fetcher, <OwnerPage page="learning" now={clock} />);
    await screen.findByTestId("owner-nickname-n1");
    expect(screen.queryByTestId("owner-nickname-act-n1")).toBeNull();
    expect(screen.queryByTestId("owner-learning-tapped")).toBeNull(); // nothing acted on: the share is not drawn
  });

  it("the owner's Learning page shows Undo — the server says who may, and the owner's role now holds the grant (owner 2026-10-09)", async () => {
    /* `mayUndo` is the server's answer for this login (`opd.masters.manage`); the page draws the button from it and from nothing else. */
    const { fetcher } = server(OWNER, { "GET /opd/reports/learning": { status: 200, body: { ...LEARNING, mayUndo: true } } });
    await mount(fetcher, <OwnerPage page="learning" now={clock} />);
    expect(await screen.findByTestId("owner-nickname-act-n1")).toHaveTextContent("Undo");
    expect(screen.getByTestId("owner-nickname-act-n2")).toHaveTextContent("Undo");
    expect(screen.getByTestId("owner-nickname-act-n3")).toHaveTextContent("Put back");
    expect(OWNER).toContain("opd.masters.manage");
    expect(MS).not.toContain("opd.masters.manage");
  });

  it("a refused undo changes nothing on the screen and says so", async () => {
    const { fetcher } = server(OWNER, { "GET /opd/reports/learning": { status: 200, body: LEARNING }, "POST /opd/consult/nicknames/n1/undo": { status: 403, body: { message: "missing permission opd.masters.manage" } } });
    await mount(fetcher, <OwnerPage page="learning" now={clock} />);
    await fireEvent.press(await screen.findByTestId("owner-nickname-act-n1"));
    expect(await screen.findByTestId("owner-said")).toHaveTextContent("Not saved — try again");
    expect(screen.getByTestId("owner-nickname-act-n1")).toHaveTextContent("Undo");
  });

  it("OPD: visits by department and who is on duty now — the blocks the home gave up", async () => {
    const { fetcher } = server(OWNER, {
      "GET /staff/range": (path) => (path.includes("groupBy=departmentId")
        ? { status: 200, body: { rows: [{ key: { departmentId: "dep1" }, measures: { "opd.visitsOpened": 28 } }, { key: { departmentId: "dep2" }, measures: { "opd.visitsOpened": 46 } }] } }
        : { status: 200, body: { rows: [{ key: { day: "2026-10-02" }, measures: { "opd.visitsOpened": 68 } }] } }),
      "GET /opd/departments": { status: 200, body: [{ id: "dep1", name: "General Medicine" }, { id: "dep2", name: "Obs & Gynae" }] },
      "GET /roster/on-now": { status: 200, body: { departments: [{ name: "Medicine", unitOnTake: { name: "Unit I" }, inTheBuilding: [{ name: "Dr. Chandan Kumar" }], inOpd: null }], holes: [] } },
    });
    await mount(fetcher, <OwnerPage page="opd" now={clock} />);
    expect(await screen.findByTestId("owner-head-value")).toHaveTextContent("74");
    expect(screen.getByTestId("owner-compare")).toHaveTextContent("▲ 6 · vs same day last week");
    expect(screen.getByTestId("owner-opd-departments")).toHaveTextContent(/Obs & Gynae.*46.*General Medicine.*28/);
    expect(screen.getByTestId("owner-opd-duty")).toHaveTextContent(/Medicine · Unit I.*Dr\. Chandan Kumar/);
  });
});

describe("who may open a page", () => {
  const routeFor = async (perms: string[], page: string) => {
    mockParams.page = page;
    const { fetcher, calls } = server(perms, { "GET /billing/reports/owner-money": { status: 200, body: MONEY }, "GET /roster/staff-today": { status: 200, body: STAFF } });
    const view = await mount(fetcher, <Page />);
    await waitFor(() => expect(screen.queryByTestId("redirect") ?? screen.queryByTestId("owner-title")).not.toBeNull());
    const out = { redirected: screen.queryByTestId("redirect") !== null, asked: calls.map((c) => c.key).filter((k) => k !== "GET /auth/me") };
    await view.unmount();
    return out;
  };

  it("a doctor and a cashier are sent home from every page; the Medical Superintendent from Money alone — and nothing is asked", async () => {
    for (const page of ["money", "staff", "learning", "pharmacy"]) {
      expect({ page, ...(await routeFor(DOCTOR, page)) }).toEqual({ page, redirected: true, asked: [] });
      expect({ page, ...(await routeFor(CASHIER, page)) }).toEqual({ page, redirected: true, asked: [] });
    }
    expect(await routeFor(MS, "money")).toEqual({ redirected: true, asked: [] });
    expect(await routeFor(MS, "nonsense")).toEqual({ redirected: true, asked: [] });
    expect((await routeFor(MS, "staff")).redirected).toBe(false);
    expect((await routeFor(OWNER, "money")).redirected).toBe(false);
  });
});

describe("the rules behind the pages", () => {
  it("a period's days and what it is compared with — Monday starts a week; a month compares to the same day number", () => {
    expect(ownerRange("today", "2026-10-09")).toEqual({ from: "2026-10-09", to: "2026-10-09", compare: { from: "2026-10-02", to: "2026-10-02" } });
    expect(ownerRange("week", "2026-10-09")).toEqual({ from: "2026-10-05", to: "2026-10-09", compare: { from: "2026-09-28", to: "2026-10-02" } });
    expect(ownerRange("week", "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-05", compare: { from: "2026-09-28", to: "2026-09-28" } });
    expect(ownerRange("week", "2026-10-11")).toMatchObject({ from: "2026-10-05", to: "2026-10-11" }); // a Sunday ends its week
    expect(ownerRange("month", "2026-10-09")).toEqual({ from: "2026-10-01", to: "2026-10-09", compare: { from: "2026-09-01", to: "2026-09-09" } });
    expect(monthSoFar("2026-03-31").before).toEqual({ from: "2026-02-01", to: "2026-02-28" }); // February has no 31st
    expect(monthSoFar("2026-01-15").before).toEqual({ from: "2025-12-01", to: "2025-12-15" });
    expect(ownerRange("custom", "2026-10-09", { from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-01", to: "2026-09-30", compare: null });
    expect(ownerRange("custom", "2026-10-09", null)).toBeNull();
    expect(istDayOf(Date.parse("2026-10-08T19:00:00Z"))).toBe("2026-10-09"); // 00:30 IST
  });

  it("a custom range: two real dates, in order, at most 92 days, never after today", () => {
    expect(rangeProblem("2026-07-10", "2026-10-09", "2026-10-09")).toBeNull(); // exactly 92 days
    expect(rangeProblem("2026-07-09", "2026-10-09", "2026-10-09")).toBe("too_long");
    expect(rangeProblem("2026-10-09", "2026-10-10", "2026-10-09")).toBe("future");
    expect(rangeProblem("2026-10-09", "2026-10-08", "2026-10-09")).toBe("order");
    expect(rangeProblem("2026-02-30", "2026-10-09", "2026-10-09")).toBe("bad_date");
    expect(rangeProblem("9 Oct", undefined, "2026-10-09")).toBe("bad_date");
  });

  it("arrows and short rupees", () => {
    expect(arrowPercent(1_430_000, 1_276_800)).toEqual({ text: "▲ 12%", tone: "up" });
    expect(arrowPercent(96, 100)).toEqual({ text: "▼ 4%", tone: "down" });
    expect([arrowPercent(10, 0), arrowPercent(10, null), arrowCount(5, undefined)]).toEqual([null, null, null]);
    expect(arrowCount(74, 68)).toEqual({ text: "▲ 6", tone: "up" });
    expect([rupeesShort(1_430_000), rupeesShort(14_200_000), rupeesShort(1_250_000_000), rupeesShort(0)]).toEqual(["₹14,300", "₹1.42 L", "₹1.25 Cr", "₹0"]);
  });
});

describe("the text rule — one line at 360 px", () => {
  /* Letters a reader sees: combining marks (a Devanagari matra) and joiners take no width of their own. */
  const seen = (s: string): number => [...s.normalize("NFC")].filter((ch) => !/\p{M}|\p{Cf}/u.test(ch)).length;
  const VARS = { n: 99, amount: "₹1,200", month: "Sep", on: 999, of: 999 };
  const leaves = (node: unknown, pre: string): string[] => Object.entries(node as Record<string, unknown>)
    .flatMap(([k, v]) => (typeof v === "string" ? [`${pre}${k}`] : leaves(v, `${pre}${k}.`)));

  it("no new string is over its budget, in English or Hindi: 34 characters, and 14 for a tile's sub-line", () => {
    const keys = leaves((en as unknown as { owner: unknown }).owner, "owner.");
    expect(leaves((hi as unknown as { owner: unknown }).owner, "owner.")).toEqual(keys);
    expect(keys.length).toBeGreaterThan(90);
    const over: string[] = [];
    for (const lang of ["en", "hi"] as const) {
      for (const key of keys) {
        const text = translate(lang, key, VARS);
        const budget = key.startsWith("owner.sub.") ? 14 : 34;
        if (seen(text) > budget) over.push(`${lang} ${key} (${String(seen(text))}): ${text}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("every sub-line a tile can show fits fourteen characters, whichever way the numbers fall", () => {
    const worst: OwnerReads[] = [
      { money: { ...MONEY, collectedPaise: 999_999_900, previous: { ...MONEY.previous, collectedPaise: 1 } } as OwnerReads["money"], opd: { today: 9999, lastWeek: 0 }, staff: { ...STAFF, gaps: Array.from({ length: 24 }, () => STAFF.gaps[0]!) } },
      { opd: { today: 0, lastWeek: 9999 }, staff: { ...STAFF, gaps: [], onLeave: Array.from({ length: 99 }, (_, i) => ({ userId: String(i), name: "x" })) }, recorded: { ...RECORDING, totals: { ...C, consulted: 999, notRecorded: 999 } } as OwnerReads["recorded"] },
      { appointments: { ...APPTS, needRebooking: 999 } as OwnerReads["appointments"], pharmacy: { ...PHARMACY, stock: { ...PHARMACY.stock, low: 999 } } as OwnerReads["pharmacy"], learning: { ...LEARNING, on: true } as OwnerReads["learning"] },
      { pharmacy: { ...PHARMACY_MS, stock: null, previous: null } as OwnerReads["pharmacy"], staff: { ...STAFF, gaps: [], onLeave: [] }, recorded: { ...RECORDING, totals: { ...C, consulted: 0, notRecorded: 0 } } as OwnerReads["recorded"] },
    ];
    for (const lang of ["en", "hi"] as const) {
      for (const reads of worst) {
        for (const tile of buildOwnerTiles(ownerTilesFor(OWNER)!, reads)) {
          const sub = subText(tile, (k, v) => translate(lang, k, v));
          if (sub !== null) expect({ lang, key: tile.key, sub, n: seen(sub) <= 14 }).toEqual({ lang, key: tile.key, sub, n: true });
          expect({ key: tile.key, value: tile.value, fits: seen(tile.value) <= 9 }).toEqual({ key: tile.key, value: tile.value, fits: true });
        }
      }
    }
  });
});
