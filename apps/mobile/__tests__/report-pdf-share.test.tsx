import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { QuickReports } from "../src/screens/lab-qreports";
import { SessionProvider, useSession } from "../src/session";
import { phoneReportHtml } from "../src/lab/report-html";
import { API_BASE } from "../src/config";
import type { QuickReport } from "../src/lab/api";

/**
 * OWNER 2026-10-12 — SHARE PDF ON THE PHONE (spec `SPEC-phone-report-pdf-share-2026-10-12.md`). The
 * phone renders the desk's printed page (the shared template) to a PDF, names it `<UHID>-<sample
 * no>.pdf`, opens the share sheet, records the share on the server, and deletes the file — also
 * when the share fails. No button without the print grant.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "lab.tech", since: new Date().toISOString() })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));

/** The file system: which files exist in the fake cache, and what was moved or deleted. */
const mockFsLog: string[] = [];
const mockFsFiles = new Set<string>();
jest.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/").replace(/([^:/])\/{2,}/g, "$1/");
    }
    get exists(): boolean { return mockFsFiles.has(this.uri); }
    moveSync(dest: { uri: string }): void { mockFsLog.push(`move ${this.uri} -> ${dest.uri}`); mockFsFiles.delete(this.uri); mockFsFiles.add(dest.uri); this.uri = dest.uri; }
    delete(): void { mockFsLog.push(`delete ${this.uri}`); if (!mockFsFiles.delete(this.uri)) throw new Error("no such file"); }
  }
  return { File, Paths: { cache: { uri: "file:///cache" } } };
});
const mockPrintToFile = jest.fn(async (_o: { html: string }) => { mockFsFiles.add("file:///cache/Print/abc.pdf"); return { uri: "file:///cache/Print/abc.pdf", numberOfPages: 1 }; });
jest.mock("expo-print", () => ({ printToFileAsync: (o: { html: string }) => mockPrintToFile(o) }));
const mockShareAsync = jest.fn(async (_uri: string, _o: unknown) => undefined);
const mockIsAvailable = jest.fn(async () => true);
jest.mock("expo-sharing", () => ({ shareAsync: (u: string, o: unknown) => mockShareAsync(u, o), isAvailableAsync: () => mockIsAvailable() }));

type Reply = { status: number; body?: unknown };
function server(perms: string[], routes: Record<string, (body: unknown) => Reply>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    if (key === "GET /auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, of: (key: string) => calls.filter((c) => c.key === key) };
}
function Gate({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  return state.status === "signedIn" ? <>{children}</> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate><QuickReports /></Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const SITA = { id: "p2", uhid: "UH00002", display: "Sita Devi", administrativeGender: "female", dob: "1990-05-05" };
const ROW = {
  id: "r2", status: "reported", patient: SITA, encounterNo: "V-1", tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" }],
  collectedAt: ago(30), collectedBy: "u-p", reportedAt: ago(5), reportedBy: null,
  orderId: "o1", orderNo: "LO-1", sampleNo: "S0000000042", handedOverAt: null, handedOverBy: null,
};
const CBC = {
  ...ROW, analyteIds: ["a-hb", "a-wbc"], groups: [{ title: "Complete blood count", analyteIds: ["a-hb", "a-wbc"] }],
  lines: [
    { analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", refText: null, flag: "L" },
    { analyteId: "a-wbc", code: "WBC", nameEn: "Total leucocyte count", unit: "/µL", value: "7000", low: "4000.0000", high: "11000.0000", refText: null, flag: "N" },
  ],
  summary: "Hb low", collectedByName: null, reportedByName: "Pravin Kumar Verma",
  hospital: { name: "CRK Medical College & Hospital", address: "Hajipur, Bihar", hotline: "+91 77648 88189", emergency: "1068", email: "info@crkmch.com", website: "www.crkmch.com" },
  visitQrSvg: '<svg data-qr="V-1"></svg>',
};
const URINE = {
  ...CBC, tests: [{ serviceId: "s-cs", code: "CS_URINE", nameEn: "Urine culture & sensitivity" }],
  analyteIds: ["a-org"], groups: [{ title: "Urine culture & sensitivity", analyteIds: ["a-org"] }],
  lines: [{ analyteId: "a-org", code: "MIC_ORG", nameEn: "Organism isolated", unit: null, value: "Escherichia coli", low: null, high: null, refText: null, flag: null }],
  ast: [{ serviceId: "s-cs", rows: [{ antibiotic: "AMP", result: "R", mic: "32" }, { antibiotic: "NIT", result: "S", mic: null }] }],
};

function world(perms: string[], report: unknown = CBC, shared: Reply = { status: 201, body: { ok: true } }) {
  return server(perms, {
    "GET /lab/quick/ready": () => ({ status: 200, body: { ready: [ROW], handedOverToday: [] } }),
    "GET /lab/quick/ready/r2": () => ({ status: 200, body: report }),
    "POST /lab/quick/reports/r2/shared": () => shared,
  });
}
const printedLine = /<span class="num">Printed[^<]*(<strong>[^<]*<\/strong>)?[^<]*<\/span>/;

beforeEach(() => { mockFsLog.length = 0; mockFsFiles.clear(); mockPrintToFile.mockClear(); mockShareAsync.mockClear(); mockIsAvailable.mockClear(); mockIsAvailable.mockResolvedValue(true); mockShareAsync.mockResolvedValue(undefined); });

describe("Share PDF on Quick Reports (owner 2026-10-12)", () => {
  it("renders the desk's page to a PDF named <UHID>-<sample no>.pdf, shares it, records the share, deletes the file", async () => {
    const w = world(["lab.reports.print"]);
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await fireEvent.press(await screen.findByTestId("qr-share"));
    await waitFor(() => expect(w.of("POST /lab/quick/reports/r2/shared")).toHaveLength(1));

    expect(mockPrintToFile).toHaveBeenCalledTimes(1);
    const html = mockPrintToFile.mock.calls[0]![0].html;
    /** THE desk template, given the same report, the same user and the same logo origin. */
    const desk = phoneReportHtml(CBC as unknown as QuickReport, "lab.tech", API_BASE, new Date());
    expect(html.replace(printedLine, "")).toBe(desk.replace(printedLine, ""));
    expect(html).toContain("Printed by <strong>lab.tech</strong>");
    expect(html).toMatch(/<td class="val ab">9\.2<\/td>.*<td class="c flag ab">Low<\/td>/s);
    expect(html).toContain('<div class="ft ftfix">');
    expect(html).not.toContain("<script");

    expect(mockShareAsync).toHaveBeenCalledWith("file:///cache/UH00002-S0000000042.pdf", expect.objectContaining({ mimeType: "application/pdf", UTI: "com.adobe.pdf" }));
    expect(mockFsLog).toEqual(["move file:///cache/Print/abc.pdf -> file:///cache/UH00002-S0000000042.pdf", "delete file:///cache/UH00002-S0000000042.pdf"]);
    expect(mockFsFiles.size).toBe(0);
    expect(w.of("POST /lab/quick/reports/r2/hand-over")).toHaveLength(0);
  });

  it("a urine culture's PDF carries its antibiotic table, the R row in bold", async () => {
    const w = world(["lab.reports.print"], URINE);
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await fireEvent.press(await screen.findByTestId("qr-share"));
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    const html = mockPrintToFile.mock.calls[0]![0].html;
    expect(html).toContain("Antibiotic sensitivity — Urine culture &amp; sensitivity");
    expect(html).toContain('<tr class="ast-R"><td class="name"><b>Ampicillin</b></td><td class="c"><b>Resistant (R)</b></td><td class="c"><b>32</b></td></tr>');
  });

  it("a failed share records nothing and still deletes the file", async () => {
    mockShareAsync.mockRejectedValueOnce(new Error("boom"));
    const w = world(["lab.reports.print"]);
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await fireEvent.press(await screen.findByTestId("qr-share"));
    expect(await screen.findByTestId("qr-share-note")).toBeTruthy();
    expect(w.of("POST /lab/quick/reports/r2/shared")).toHaveLength(0);
    expect(mockFsFiles.size).toBe(0);
  });

  it("no share sheet on this phone: a short note, no PDF made", async () => {
    mockIsAvailable.mockResolvedValue(false);
    const w = world(["lab.reports.print"]);
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await fireEvent.press(await screen.findByTestId("qr-share"));
    expect(await screen.findByTestId("qr-share-note")).toBeTruthy();
    expect(mockPrintToFile).not.toHaveBeenCalled();
  });

  it("without the print grant there is no Share PDF", async () => {
    const w = world(["lab.results.enter"]);
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await screen.findByTestId("qr-preview");
    expect(screen.queryByTestId("qr-share")).toBeNull();
  });

  it("speaks Hindi", async () => {
    const w = world(["lab.reports.print"]);
    await mount(w.fetcher, "hi");
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    expect(await screen.findByTestId("qr-share")).not.toHaveTextContent(/Share PDF/);
  });
});
