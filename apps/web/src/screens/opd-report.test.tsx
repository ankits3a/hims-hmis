import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { router } from "../router";
import "../lib/i18n";

/**
 * THE OPD REPORT — owner requests 2026-09-19 (*"an option in the dashboard to download the day
 * report"*) and 2026-09-20 (*"'This Week' (week starts on Monday - Saturday) and 'This Month' as
 * well along with Today and Yesterday"*).
 *
 * What the screen owes: the four periods one tap apart, the DAYS each one covered shown beside it,
 * the Sunday a week leaves out named rather than dropped, and both downloads asking for the period
 * the reader is looking at.
 */
type Reply = { status: number; body: unknown };

const TODAY = "2026-09-19"; // Saturday
const YESTERDAY = "2026-09-18";
const MONDAY = "2026-09-14";
const SUNDAY = "2026-09-20";

const hospital = { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR"] };
const DEPARTMENTS = [
  { departmentId: "d-med", code: "MED", name: "General Medicine", booked: 20, consulted: 17, new: 5, revisit: 8, renewal: 4, stillOpen: 2 },
  { departmentId: "d-ped", code: "PED", name: "Paediatrics", booked: 6, consulted: 5, new: 2, revisit: 2, renewal: 1, stillOpen: 0 },
];
const report = (over: Record<string, unknown>) => ({
  period: "day", anchor: TODAY, from: TODAY, to: TODAY, generatedAt: "2026-09-19T12:00:00.000Z", provisional: true,
  hospital, departments: DEPARTMENTS,
  totals: { booked: 26, consulted: 22, new: 7, revisit: 10, renewal: 5, stillOpen: 2 },
  patientsConsulted: 21, newPatients: 6, excludedSunday: null, ...over,
});
const DAY = report({});
const YESTERDAY_REPORT = report({ anchor: YESTERDAY, from: YESTERDAY, to: YESTERDAY, provisional: false, totals: { ...DAY.totals, consulted: 40, stillOpen: 0 } });
const WEEK = report({
  period: "week", from: MONDAY, to: TODAY,
  totals: { booked: 120, consulted: 104, new: 31, revisit: 52, renewal: 21, stillOpen: 2 },
  patientsConsulted: 96, newPatients: 29, excludedSunday: { date: SUNDAY, consulted: 3 },
});
const MONTH = report({
  period: "month", from: "2026-09-01", to: TODAY,
  totals: { booked: 402, consulted: 366, new: 98, revisit: 190, renewal: 78, stillOpen: 2 },
  patientsConsulted: 330, newPatients: 92,
});
const MED_WEEK = {
  ...WEEK, department: DEPARTMENTS[0],
  rows: [
    { visitNo: "V1", date: MONDAY, time: "10:10", name: "Ramesh Kumar", restricted: false, uhid: "CRK0000011", age: "36 Y", gender: "M", shortAddress: "Rampur, Vaishali", patientType: "new", doctor: "Dr Anil" },
    { visitNo: "V2", date: TODAY, time: "10:20", name: "Patient VIP-7", restricted: true, uhid: "CRK0000029", age: "52 Y", gender: "F", shortAddress: "—", patientType: "revisit", doctor: "Dr Anil" },
  ],
};

let seen: string[] = [];
function mount(path: string, hospitalPerms: string[]): void {
  const handlers: Record<string, Reply> = {
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: hospitalPerms, scoped: { department: {}, floor: {} } } } },
    "GET /api/ops/mode": { status: 200, body: { mode: "live" } },
    "GET /api/alerts": { status: 200, body: { items: [] } },
    "GET /api/patients/search": { status: 200, body: { items: [] } },
    "GET /api/me/desk": { status: 200, body: { date: TODAY, cards: [] } },
    "GET /api/opd/reports/consultations/document": { status: 200, body: { title: "OPD-Day-Report-2026-09-19", html: "<html><body>SHEET</body></html>", page: { widthMm: 210, heightMm: 297 } } },
  };
  const forPeriod = (url: string): unknown => {
    if (url.includes("period=week")) return WEEK;
    if (url.includes("period=month")) return MONTH;
    return url.includes(`date=${YESTERDAY}`) ? YESTERDAY_REPORT : DAY;
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(raw);
    const bare = raw.split("?")[0]!;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (bare === "/api/opd/reports/consultations") return json(forPeriod(raw));
    if (/^\/api\/opd\/reports\/consultations\/departments\/[^/]+$/.test(bare)) return json(MED_WEEK);
    if (bare.endsWith("/csv")) {
      return new Response("a,b\r\n", { status: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="OPD-Week-Report-2026-09-14-to-2026-09-19.csv"' } });
    }
    const h = handlers[`${init?.method ?? "GET"} ${bare}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
  }));
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: [path] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function mountAt(path: string, hospitalPerms: string[]): Promise<void> {
  mount(path, hospitalPerms);
  /* The router is the app's singleton; a new history alone does not move it off the last test's page. */
  await act(async () => { await router.navigate({ href: path }); });
}

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

beforeEach(() => {
  seen = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T06:00:00.000Z"));
  resetRealtimeClientForTests();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => { vi.useRealTimers(); setToken(null); vi.unstubAllGlobals(); });

describe("the OPD report on the dashboard", () => {
  it("shows today's figures and both downloads to whoever holds opd.reports.read", async () => {
    await mountAt("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("22"); });
    expect(within(panel).getByTestId("odr-fig-new")).toHaveTextContent("7");
    expect(within(panel).getByTestId("odr-provisional")).toHaveTextContent("2 patients still being seen");
    expect(within(panel).getByTestId("odr-today")).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByTestId("odr-range")).toHaveTextContent("Saturday, 19 Sept 2026");
    expect(seen).toContain(`/api/opd/reports/consultations?period=day&date=${TODAY}`);
    // A desk with no cards but this panel is not an empty desk, and must not say it is.
    expect(screen.queryByText(/Nothing is on your desk yet/)).toBeNull();
  });

  it("is not shown to anybody else", async () => {
    await mountAt("/", ["opd.visits.open"]);
    await screen.findByTestId("dashboard");
    await waitFor(() => { expect(seen.some((u) => u.startsWith("/api/me/desk"))).toBe(true); });
    expect(screen.queryByTestId("odr-panel")).toBeNull();
    expect(seen.some((u) => u.startsWith("/api/opd/reports"))).toBe(false);
  });

  it("switches to yesterday in one tap", async () => {
    await mountAt("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByTestId("odr-yesterday"));
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("40"); });
    expect(seen).toContain(`/api/opd/reports/consultations?period=day&date=${YESTERDAY}`);
    expect(within(panel).queryByTestId("odr-provisional")).toBeNull();
  });

  /** THE 2026-09-20 REQUEST. The week is the server's Monday-to-Saturday, and the screen says so. */
  it("this week shows the days it covered and names the Sunday it leaves out", async () => {
    await mountAt("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByTestId("odr-week"));
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("104"); });
    expect(seen).toContain(`/api/opd/reports/consultations?period=week&date=${TODAY}`);
    expect(within(panel).getByTestId("odr-range")).toHaveTextContent("14 Sept – 19 Sept 2026 · 6 days");
    expect(within(panel).getByTestId("odr-sunday")).toHaveTextContent(
      "3 consultations on Sunday, 20 Sept 2026 are not counted here: a week runs Monday to Saturday.",
    );
    expect(within(panel).getByTestId("odr-week")).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByTestId("odr-today")).toHaveAttribute("aria-pressed", "false");
  });

  it("this month runs from the 1st, and its downloads ask for the month", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    await mountAt("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByTestId("odr-month"));
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("366"); });
    expect(within(panel).getByTestId("odr-range")).toHaveTextContent("1 Sept – 19 Sept 2026 · 19 days");
    await userEvent.click(within(panel).getByRole("button", { name: /Download CSV/ }));
    await waitFor(() => { expect(seen).toContain(`/api/opd/reports/consultations/csv?period=month&date=${TODAY}`); });
    expect(within(panel).queryByTestId("odr-sunday")).toBeNull();
  });

  it("PDF opens the letterhead sheet in its own window and raises the print dialog", async () => {
    const doc = { write: vi.fn(), open: vi.fn(), close: vi.fn(), readyState: "complete" };
    const win = { document: doc, focus: vi.fn(), print: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    await mountAt("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByTestId("odr-week"));
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("104"); });
    await userEvent.click(within(panel).getByRole("button", { name: /Download PDF/ }));
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => { expect(doc.write).toHaveBeenCalledWith("<html><body>SHEET</body></html>"); });
    expect(seen).toContain(`/api/opd/reports/consultations/document?period=week&date=${TODAY}`);
    await waitFor(() => { expect(win.print).toHaveBeenCalled(); }, { timeout: 2000 });
  });

  it("says so, in words, when the browser blocks the window", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    await mountAt("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByRole("button", { name: /Download PDF/ }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/blocked the report window/);
  });
});

describe("the department-wise screen", () => {
  it("opens on the period it was sent, one row per department, with the definitions under the table", async () => {
    await mountAt(`/reports/opd-day?period=week&date=${TODAY}`, ["opd.reports.read"]);
    const table = await screen.findByTestId("odr-table");
    expect(seen).toContain(`/api/opd/reports/consultations?period=week&date=${TODAY}`);
    expect(screen.getByTestId("odr-range")).toHaveTextContent("14 Sept – 19 Sept 2026 · 6 days");
    expect(within(table).getByTestId("odr-row-MED")).toHaveTextContent("General Medicine");
    expect(screen.getByTestId("odr-notes")).toHaveTextContent(/first consultation at the hospital/i);
    // The week's own rule is stated on a weekly report and nowhere else.
    expect(screen.getByTestId("odr-week-rule")).toHaveTextContent(/Monday to Saturday/);
    expect(screen.getByTestId("odr-sunday")).toHaveTextContent(/not counted here/);
  });

  it("shows a department's patients on one tap, dated, with the patient type and a sealed patient marked", async () => {
    await mountAt(`/reports/opd-day?period=week&date=${TODAY}`, ["opd.reports.read"]);
    await screen.findByTestId("odr-table");
    // The patient list is a logged disclosure: it is not fetched until somebody asks for it.
    expect(seen.some((u) => u.includes("/departments/"))).toBe(false);
    await userEvent.click(screen.getByTestId("odr-toggle-MED"));
    const list = await screen.findByTestId("odr-patients-MED");
    expect(seen).toContain(`/api/opd/reports/consultations/departments/d-med?period=week&date=${TODAY}`);
    expect(within(list).getByText("Ramesh Kumar")).toBeInTheDocument();
    expect(within(list).getByText("14 Sept")).toBeInTheDocument(); // a week dates every row
    expect(within(list).getByText("New")).toBeInTheDocument();
    expect(within(list).getByText("Confidential")).toBeInTheDocument();
  });

  it("a single day needs no date column", async () => {
    await mountAt(`/reports/opd-day?period=day&date=${TODAY}`, ["opd.reports.read"]);
    await screen.findByTestId("odr-table");
    expect(screen.queryByTestId("odr-week-rule")).toBeNull();
    expect(screen.queryByTestId("odr-sunday")).toBeNull();
  });

  it("each department row downloads its own period", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    await mountAt(`/reports/opd-day?period=week&date=${TODAY}`, ["opd.reports.read"]);
    await screen.findByTestId("odr-table");
    await userEvent.click(screen.getByRole("button", { name: "Download CSV — Paediatrics" }));
    await waitFor(() => {
      expect(seen).toContain(`/api/opd/reports/consultations/departments/d-ped/csv?period=week&date=${TODAY}`);
    });
  });

  it("tells a person without the permission why they see nothing", async () => {
    await mountAt("/reports/opd-day", ["opd.visits.open"]);
    expect(await screen.findByTestId("odr-forbidden")).toBeInTheDocument();
    expect(seen.some((u) => u.startsWith("/api/opd/reports"))).toBe(false);
  });
});
