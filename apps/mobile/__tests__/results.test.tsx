import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactTestRendererJSON } from "react-test-renderer";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SessionProvider, useSession } from "../src/session";
import { ResultsScreen } from "../src/screens/results";
import { OpenLoopsScreen } from "../src/screens/open-loops";
import { viewerOf } from "../src/results/api";
import { WAITING_KINDS } from "../../../packages/contracts/src/waiting";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";

jest.mock("expo-secure-store", () => {
  const m = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "dr.rao" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { m.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { m.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }), useLocalSearchParams: () => mockParams }));

/**
 * #681 — a read-only phone results viewer from Open loops. The server (faked) applies the restricted-test
 * and alias rules; the phone draws what it is sent, opens a report with the read that stamps "opened"
 * (imaging: `GET /radiology/reports/:id`, as the web), and shows no money even when a payload carries it.
 */
const MONEY_EN = /₹|\b(paid|unpaid|paying|payment|fees?|dues?|bill(s|ed|ing)?|paise|outstanding)\b/i;
const MONEY_HI = /भुगतान|फ़ीस|फीस|शुल्क|बिल|बकाया/;

const IMAGING_ROWS = [
  { reportId: "r1", studyId: "s1", accessionNo: "ACC-1", studyName: "CT Head", studyTypeCode: "CT", patientId: "p1", patientName: "Patient K", uhid: "U001", version: 1, amended: false, signedAt: "2026-10-16T05:00:00Z", publishedAt: "2026-10-16T05:00:00Z", signerName: "Dr Sen", impression: "Normal", criticalCategory: "bleed", critical: { criticalId: "c1", category: "bleed", raisedAt: "2026-10-16T05:00:00Z", acknowledgedAt: null, readBack: null }, state: "unread", firstReadAt: null, chasedAt: null, acted: null, orderedByMe: true, overread: null, outstandingPaise: 90000 },
];
const IMAGING_REPORT = { reportId: "r1", studyId: "s1", accessionNo: "ACC-1", version: 1, status: "signed", templateKey: "ct", body: { technique: "Plain axial", findings: "Small bleed", impression: "Bleed" }, impression: "Small subdural bleed", laterality: null, criticalCategory: "bleed", signerId: "u9", signedAt: "2026-10-16T05:00:00Z", publishedAt: "2026-10-16T05:00:00Z", amendmentReason: null, supersedesId: null, provenance: null, patientName: "Patient K" };
const LAB_ROWS = [{ reportId: "l1", orderNo: "LO-7", encounterNo: "V1", patientName: "Patient K", uhid: "U001", publishedAt: "2026-10-16T05:00:00Z", amended: false, tests: ["Thyroid profile"], abnormal: 1 }];
const LAB_REPORT = {
  reportId: "l1", orderNo: "LO-7", encounterNo: "V1", patientName: "Patient K", uhid: "U001", publishedAt: "2026-10-16T05:00:00Z", amended: false, partial: false,
  panels: [{ name: "Thyroid profile", lines: [{ name: "TSH", value: "9.9", unit: "mIU/L", flag: "H", refLow: "0.4", refHigh: "4.0", refText: null }, { name: "T4", value: "8", unit: "µg/dL", flag: "N", refLow: "5", refHigh: "12", refText: null }] }],
  signedBy: "Dr Sen", signedAt: "2026-10-16T05:00:00Z",
  delivery: { allowed: false, reason: "unpaid_invoices", unpaidInvoiceIds: ["i1"], outstandingPaise: 50000 },
};

function server(perms: string[] = ["radiology.reports.read", "lab.results.read"]) {
  const calls: string[] = [];
  let read = false;
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    calls.push(key);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (key === "GET /auth/me") return ok({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (key === "GET /radiology/results") return ok({ rows: IMAGING_ROWS.map((r) => ({ ...r, state: read ? "read" : "unread" })) });
    if (key === "GET /radiology/reports/r1") { read = true; return ok({ report: IMAGING_REPORT }); }
    if (key === "GET /lab/results/mine") return ok({ items: LAB_ROWS });
    if (key === "GET /lab/results/mine/l1") return ok({ report: LAB_REPORT });
    if (key === "GET /me/waiting") return ok({ items: [
      { kind: "lab.reportsBack", count: 1, tone: "calm", oldestAt: null, href: "/opd/consult" },
      { kind: "radiology.unreadMine", count: 1, tone: "warn", oldestAt: null, href: "/opd/consult" },
      { kind: "lab.callsOpen", count: 1, tone: "hot", oldestAt: null, href: "/lab/bench" },
    ] });
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}

function Gate({ node }: { node: React.ReactNode }) { const { state } = useSession(); return state.status !== "signedIn" ? null : <>{node}</>; }
const mount = async (fetcher: typeof fetch, node: React.ReactNode = <ResultsScreen />) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate node={node} /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);
const words = (j: ReactTestRendererJSON | ReactTestRendererJSON[] | null): string => {
  if (j === null) return "";
  if (Array.isArray(j)) return j.map(words).join(" ");
  return (j.children ?? []).map((c) => (typeof c === "string" ? c : words(c))).join(" ");
};

beforeEach(() => { mockPush.mockReset(); mockParams = {}; });

describe("#681 — Open loops opens the viewer", () => {
  it("lab reports back and imaging unread open the viewer in one tap; computer-only work still says where", async () => {
    const s = server();
    await mount(s.fetcher, <OpenLoopsScreen />);
    await fireEvent.press(await screen.findByTestId("waiting-line-lab.reportsBack"));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: "/results", params: { kind: "lab" } });
    await fireEvent.press(screen.getByTestId("waiting-line-radiology.unreadMine"));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: "/results", params: { kind: "imaging" } });
    expect(screen.getByTestId("waiting-where-lab.callsOpen")).toHaveTextContent("On computer · Lab bench");
  });

  it("only the lab-back and imaging lines have a viewer", () => {
    expect(WAITING_KINDS.filter((k) => viewerOf(k) !== null)).toEqual(["radiology.criticalsMine", "lab.reportsBack", "radiology.unreadMine"]);
  });
});

describe("#681 — imaging", () => {
  it("lists the inbox by the server's alias, opens a report with the read that stamps it, and shows it read after", async () => {
    mockParams = { kind: "imaging" };
    const s = server();
    await mount(s.fetcher);
    expect(await screen.findByTestId("results-row-r1")).toHaveTextContent(/Patient K/);
    expect(screen.getByTestId("results-state-r1")).toHaveTextContent("Unread");
    expect(screen.getByTestId("results-critical-r1")).toHaveTextContent("Critical");
    await fireEvent.press(screen.getByTestId("results-row-r1"));
    expect(await screen.findByTestId("results-impression")).toHaveTextContent("Small subdural bleed");
    expect(screen.getByTestId("results-section-findings")).toHaveTextContent("Small bleed");
    expect(screen.queryByTestId("results-section-impression")).toBeNull();
    expect(screen.getByTestId("results-report-critical")).toHaveTextContent("Acknowledge on computer");
    expect(s.calls).toContain("GET /radiology/reports/r1");
    // Read-only: nothing but GETs went to the server.
    expect(s.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(words(screen.toJSON())).not.toMatch(MONEY_EN);
    await fireEvent.press(screen.getByTestId("results-back"));
    await waitFor(() => expect(screen.getByTestId("results-state-r1")).toHaveTextContent("Read"));
  });
});

describe("#681 — lab", () => {
  it("lists my reports back and opens one: values, units, flags and reference; no money though the payload carries it", async () => {
    mockParams = { kind: "lab" };
    const s = server();
    await mount(s.fetcher);
    expect(await screen.findByTestId("results-row-l1")).toHaveTextContent(/Patient K/);
    expect(screen.getByTestId("results-abnormal-l1")).toHaveTextContent("1 out of range");
    await fireEvent.press(screen.getByTestId("results-row-l1"));
    expect(await screen.findByTestId("results-line-0-0")).toHaveTextContent(/TSH.*9\.9 mIU\/L H.*0\.4–4\.0/);
    expect(screen.getByTestId("results-line-0-1")).toHaveTextContent(/T4.*8 µg\/dL.*5–12/);
    expect(screen.getByTestId("results-line-0-1")).not.toHaveTextContent(/ N/);
    expect(s.calls).toContain("GET /lab/results/mine/l1");
    expect(s.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(words(screen.toJSON())).not.toMatch(MONEY_EN);
    expect(words(screen.toJSON())).not.toMatch(/50000|500\.00|unpaid_invoices/);
  });
});

describe("#681 — the words", () => {
  it("every results label is one short line in both languages, with the same keys", () => {
    const leaves = (o: unknown, p = ""): [string, string][] => (typeof o === "string" ? [[p, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`)));
    const e = leaves((en as unknown as { results: object }).results); const h = leaves((hi as unknown as { results: object }).results);
    expect(h.map(([k]) => k)).toEqual(e.map(([k]) => k));
    for (const [, w] of [...e, ...h]) {
      expect([w, w.length <= 26]).toEqual([w, true]);
      expect([w, /[.।!]/.test(w)]).toEqual([w, false]);
      expect([w, MONEY_EN.test(w) || MONEY_HI.test(w)]).toEqual([w, false]);
    }
  });
});
