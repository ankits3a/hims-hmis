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
 * THE OPD DAY REPORT — owner request 2026-09-19: *"an option in the dashboard to download the day
 * report"*, department-wise, as PDF and CSV. What the screen owes: the figures and both downloads ON
 * the dashboard, yesterday one tap away, and a department's patients one tap from its row.
 */
type Reply = { status: number; body: unknown };

const TODAY = "2026-09-19";
const DAY = {
  date: TODAY, generatedAt: "2026-09-19T12:00:00.000Z", provisional: true,
  hospital: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR"] },
  departments: [
    { departmentId: "d-med", code: "MED", name: "General Medicine", booked: 20, consulted: 17, new: 5, revisit: 8, renewal: 4, stillOpen: 2 },
    { departmentId: "d-ped", code: "PED", name: "Paediatrics", booked: 6, consulted: 5, new: 2, revisit: 2, renewal: 1, stillOpen: 0 },
  ],
  totals: { booked: 26, consulted: 22, new: 7, revisit: 10, renewal: 5, stillOpen: 2 },
  patientsConsulted: 21, newPatients: 6,
};
const YESTERDAY = { ...DAY, date: "2026-09-18", provisional: false, totals: { ...DAY.totals, consulted: 40, stillOpen: 0 } };
const MED = {
  date: TODAY, generatedAt: DAY.generatedAt, provisional: true, hospital: DAY.hospital, department: DAY.departments[0],
  rows: [
    { visitNo: "V1", time: "10:10", name: "Ramesh Kumar", restricted: false, uhid: "CRK0000011", age: "36 Y", gender: "M", shortAddress: "Rampur, Vaishali", patientType: "new", doctor: "Dr Anil" },
    { visitNo: "V2", time: "10:20", name: "Patient VIP-7", restricted: true, uhid: "CRK0000029", age: "52 Y", gender: "F", shortAddress: "—", patientType: "revisit", doctor: "Dr Anil" },
  ],
};

let seen: string[] = [];
async function mount(path: string, hospital: string[]): Promise<void> {
  const handlers: Record<string, Reply> = {
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } } },
    "GET /api/ops/mode": { status: 200, body: { mode: "live" } },
    "GET /api/alerts": { status: 200, body: { items: [] } },
    "GET /api/patients/search": { status: 200, body: { items: [] } },
    "GET /api/me/desk": { status: 200, body: { date: TODAY, cards: [] } },
    "GET /api/opd/reports/day/departments/d-med": { status: 200, body: MED },
    "GET /api/opd/reports/day/document": { status: 200, body: { title: "OPD-Day-Report-2026-09-19", html: "<html><body>SHEET</body></html>", page: { widthMm: 210, heightMm: 297 } } },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(raw);
    const bare = raw.split("?")[0]!;
    if (bare === "/api/opd/reports/day") {
      const body = raw.includes("date=2026-09-18") ? YESTERDAY : DAY;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (bare.endsWith("/csv")) {
      return new Response("a,b\r\n", { status: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="OPD-Day-Report-2026-09-19.csv"' } });
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

describe("the OPD day report on the dashboard", () => {
  it("shows today's figures and both downloads to whoever holds opd.reports.read", async () => {
    await mount("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("22"); });
    expect(within(panel).getByTestId("odr-fig-new")).toHaveTextContent("7");
    expect(within(panel).getByTestId("odr-fig-revisit")).toHaveTextContent("10");
    expect(within(panel).getByTestId("odr-fig-renewal")).toHaveTextContent("5");
    expect(within(panel).getByTestId("odr-fig-booked")).toHaveTextContent("26");
    expect(within(panel).getByTestId("odr-provisional")).toHaveTextContent("2 patients still being seen");
    expect(within(panel).getByTestId("odr-today")).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByRole("button", { name: /Download PDF/ })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: /Download CSV/ })).toBeEnabled();
    // A desk with no cards but this panel is not an empty desk, and must not say it is.
    expect(screen.queryByText(/Nothing is on your desk yet/)).toBeNull();
  });

  it("is not shown to anybody else", async () => {
    await mount("/", ["opd.visits.open"]);
    await screen.findByTestId("dashboard");
    await waitFor(() => { expect(seen.some((u) => u.startsWith("/api/me/desk"))).toBe(true); });
    expect(screen.queryByTestId("odr-panel")).toBeNull();
    expect(seen.some((u) => u.startsWith("/api/opd/reports"))).toBe(false);
  });

  it("switches to yesterday in one tap", async () => {
    await mount("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByTestId("odr-yesterday"));
    await waitFor(() => { expect(within(panel).getByTestId("odr-fig-consulted")).toHaveTextContent("40"); });
    expect(seen).toContain("/api/opd/reports/day?date=2026-09-18");
    expect(within(panel).queryByTestId("odr-provisional")).toBeNull();
  });

  it("PDF opens the letterhead sheet in its own window and raises the print dialog", async () => {
    const doc = { write: vi.fn(), open: vi.fn(), close: vi.fn(), readyState: "complete" };
    const win = { document: doc, focus: vi.fn(), print: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    await mount("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByRole("button", { name: /Download PDF/ }));
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => { expect(doc.write).toHaveBeenCalledWith("<html><body>SHEET</body></html>"); });
    expect(seen).toContain("/api/opd/reports/day/document?date=2026-09-19");
    await waitFor(() => { expect(win.print).toHaveBeenCalled(); }, { timeout: 2000 });
  });

  it("says so, in words, when the browser blocks the window", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    await mount("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByRole("button", { name: /Download PDF/ }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/blocked the report window/);
  });

  it("CSV downloads the day as a file", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    await mount("/", ["opd.reports.read"]);
    const panel = await screen.findByTestId("odr-panel");
    await userEvent.click(within(panel).getByRole("button", { name: /Download CSV/ }));
    await waitFor(() => { expect(seen).toContain("/api/opd/reports/day/csv?date=2026-09-19"); });
    expect(within(panel).queryByRole("alert")).toBeNull();
  });
});

describe("the department-wise screen", () => {
  it("opens on the day it was sent, one row per department, with the definitions under the table", async () => {
    await mount("/reports/opd-day?date=2026-09-18", ["opd.reports.read"]);
    const table = await screen.findByTestId("odr-table");
    expect(seen).toContain("/api/opd/reports/day?date=2026-09-18");
    const med = within(table).getByTestId("odr-row-MED");
    expect(med).toHaveTextContent("General Medicine");
    expect(within(med).getAllByRole("cell").map((c) => c.textContent)).toEqual(
      expect.arrayContaining(["20", "17", "5", "8", "4"]),
    );
    expect(screen.getByTestId("odr-notes")).toHaveTextContent(/first consultation at the hospital/i);
  });

  it("shows a department's patients on one tap, with the patient type and a sealed patient marked", async () => {
    await mount(`/reports/opd-day?date=${TODAY}`, ["opd.reports.read"]);
    await screen.findByTestId("odr-table");
    // The patient list is a logged disclosure: it is not fetched until somebody asks for it.
    expect(seen.some((u) => u.includes("/departments/"))).toBe(false);
    await userEvent.click(screen.getByTestId("odr-toggle-MED"));
    const list = await screen.findByTestId("odr-patients-MED");
    expect(within(list).getByText("Ramesh Kumar")).toBeInTheDocument();
    expect(within(list).getByText("Rampur, Vaishali")).toBeInTheDocument();
    expect(within(list).getByText("New")).toBeInTheDocument();
    expect(within(list).getByText("Revisit")).toBeInTheDocument();
    expect(within(list).getByText("Confidential")).toBeInTheDocument();
    expect(screen.getByTestId("odr-toggle-MED")).toHaveAttribute("aria-expanded", "true");
  });

  it("each department row downloads its own CSV", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    await mount(`/reports/opd-day?date=${TODAY}`, ["opd.reports.read"]);
    await screen.findByTestId("odr-table");
    await userEvent.click(screen.getByRole("button", { name: "Download CSV — Paediatrics" }));
    await waitFor(() => { expect(seen).toContain("/api/opd/reports/day/departments/d-ped/csv?date=2026-09-19"); });
  });

  it("tells a person without the permission why they see nothing", async () => {
    await mount("/reports/opd-day", ["opd.visits.open"]);
    expect(await screen.findByTestId("odr-forbidden")).toBeInTheDocument();
    expect(seen.some((u) => u.startsWith("/api/opd/reports"))).toBe(false);
  });
});
