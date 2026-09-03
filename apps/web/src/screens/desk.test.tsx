import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { router } from "../router";
import "../lib/i18n";

/**
 * PLAN 07c T4 — MY DESK, AND `/` STOPS BEING SOMEBODY ELSE'S SCREEN.
 *
 * These render through the REAL router at `/` rather than mounting the component directly, because
 * the assertion this task exists for is about the ROUTE: the index route was an unconditional
 * `throw redirect({ to: "/registration" })` and every authenticated user in the hospital — doctor,
 * cashier, storekeeper, administrator — landed on the patient registration desk. A test that
 * rendered `<Desk />` in isolation would pass with that redirect fully intact.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static reset(): void { FakeWebSocket.instances = []; }
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  simulateOpen(): void { this.readyState = 1; this.onopen?.(); }
  simulateMessage(obj: unknown): void { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const h = handlers[key];
      if (h === undefined) return new Response("{}", { status: 404 });
      const { status, body } = typeof h === "function" ? h() : h;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const HALL = {
  key: "opd.hall",
  band: "now",
  titleKey: "desk.opd.hall",
  topics: ["queue:doc-1:2026-08-29"],
  stats: [
    { key: "desk.opd.waiting", value: "12", href: "/opd/desk" },
    { key: "desk.opd.withVitals", value: "4", href: "/opd/vitals" },
  ],
  rows: [
    { id: "doc-1", badge: "!", title: "Dr Meera Rao", subtitle: "desk.opd.notStarted", severity: "warn", href: "/opd/desk" },
  ],
};
const MY_VISITS = {
  key: "opd.myVisits",
  band: "today",
  titleKey: "desk.opd.myVisits",
  stats: [
    { key: "desk.opd.opened", value: "46", href: "/my-day" },
    { key: "desk.opd.stillHere", value: "3", href: "/opd/desk" },
  ],
};

function renderAt(path: string, cards: unknown[], hospital: string[] = ["opd.queue.read"]): void {
  mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } } },
    "GET /api/ops/mode": { status: 200, body: { mode: "commissioning" } },
    "GET /api/alerts": { status: 200, body: { items: [] } },
    "GET /api/patients/search": { status: 200, body: { items: [] } },
    "GET /api/me/desk": { status: 200, body: { date: "2026-08-29", cards } },
  });
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

/** Bring the fake socket up to the point `RealtimeClient` calls itself connected. */
function connect(): void {
  act(() => {
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[0]!.simulateMessage({ type: "authed", userId: "u1" });
  });
}

beforeEach(() => {
  FakeWebSocket.reset();
  resetRealtimeClientForTests();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

const REGISTRATION = {
  key: "patients.registration", band: "today", titleKey: "desk.patients.registration",
  stats: [{ key: "desk.patients.registered", value: "38", href: "/counter" }, { key: "desk.patients.noMobile", value: "2", href: "/counter" }, { key: "desk.patients.duplicatesPending", value: "1", href: "/merge" }],
};
const CAME_BACK = {
  key: "patients.cameBack", band: "today", titleKey: "desk.patients.cameBack",
  stats: [{ key: "desk.patients.duplicatesConfirmed", value: "3", href: "/merge" }, { key: "desk.patients.noMobileMonth", value: "11", href: "/counter" }, { key: "desk.patients.amendedWeek", value: "8", href: "/counter" }],
};
const APPOINTMENTS = {
  key: "opd.appointments", band: "now", titleKey: "desk.appointments.title", topics: ["queue:doc-1:2026-08-29"],
  stats: [{ key: "desk.appointments.dueToday", value: "12", href: "/opd/appointments" }, { key: "desk.appointments.needsRebooking", value: "2", href: "/opd/appointments" }],
  rows: [{ id: "doc-2", badge: "2", title: "Dr Sneha Toppo", subtitle: "desk.appointments.rebookRow", severity: "warn", href: "/opd/appointments" }],
};

describe("FD-1 T5 — the three tiles on the front door, rendered by the home screen unchanged", () => {
  it("registration, what came back and appointments render with their words, their figures as doors, and the rebooking doctor as a row", async () => {
    renderAt("/", [APPOINTMENTS, HALL, REGISTRATION, CAME_BACK, MY_VISITS]);
    expect(await screen.findByText("Registration")).toBeInTheDocument();
    expect(screen.getByText("What came back — last 30 days")).toBeInTheDocument();
    expect(screen.getByText("Appointments")).toBeInTheDocument();
    // a stat with an href renders as a LINK (A2), so the figure is found by its words
    const figure = (card: string, value: string): HTMLElement => within(screen.getByTestId(`stats-${card}`)).getByText(value);
    expect(figure("patients.registration", "38").closest("a")?.getAttribute("href")).toBe("/counter");
    expect(figure("patients.cameBack", "3").closest("a")?.getAttribute("href")).toBe("/merge");
    expect(figure("opd.appointments", "12").closest("a")?.getAttribute("href")).toBe("/opd/appointments");
    expect(screen.getByText("Turned out to be duplicates")).toBeInTheDocument();
    expect(screen.getByText("Registered by me")).toBeInTheDocument();
    expect(screen.getByText("Dr Sneha Toppo")).toBeInTheDocument();
    expect(screen.getByText("patients to rebook — doctor on leave")).toBeInTheDocument();
    expect(screen.getByTestId("stats-patients.registration")).toBeInTheDocument();
    expect(screen.getByTestId("stats-opd.appointments")).toBeInTheDocument();
  });
});

describe("07c T4 — the desk is the front door", () => {
  it("A1: `/` renders the desk, and NOT the registration screen it used to redirect to", async () => {
    renderAt("/", [HALL, MY_VISITS]);

    expect(await screen.findByRole("heading", { name: "My desk" })).toBeInTheDocument();
    // The registration desk's own search box is its signature. Its ABSENCE is the defect being
    // closed: this element was on screen for every doctor and cashier in the hospital.
    expect(document.querySelector("[data-search-input]")).toBeNull();
  });

  it("A1b: the cards the server sent are the cards on screen, in their bands", async () => {
    renderAt("/", [HALL, MY_VISITS]);

    await waitFor(() => { expect(screen.getByText("OPD hall")).toBeInTheDocument(); });
    expect(screen.getByText("Visits I opened")).toBeInTheDocument();
    expect(screen.getByText("Now")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    // The one row the hall names is a DOCTOR, and its subtitle is a key that got translated.
    expect(screen.getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(screen.getByText("Session not started")).toBeInTheDocument();
  });

  /**
   * A2 — EVERY FIGURE IS A DOOR. A number nobody can open is decoration, and decoration on a home
   * screen sends a clerk to find the rows on another screen — the three route changes per patient
   * this plan series exists to delete.
   */
  it("A2: every figure the provider gave an href to is a link to exactly that path", async () => {
    renderAt("/", [HALL, MY_VISITS]);

    await waitFor(() => { expect(screen.getByRole("link", { name: "12" })).toBeInTheDocument(); });
    expect(screen.getByRole("link", { name: "12" })).toHaveAttribute("href", "/opd/desk");
    expect(screen.getByRole("link", { name: "4" })).toHaveAttribute("href", "/opd/vitals");
    expect(screen.getByRole("link", { name: "46" })).toHaveAttribute("href", "/my-day");
    expect(screen.getByRole("link", { name: "3" })).toHaveAttribute("href", "/opd/desk");
  });

  /**
   * A3 / DD11 — a dashboard that silently goes on showing a dropped socket's last value is worse
   * than one showing nothing, because nobody distrusts it.
   */
  it("A3: a disconnected socket says so and visibly dims the counts", async () => {
    renderAt("/", [HALL, MY_VISITS]);
    await waitFor(() => { expect(screen.getByTestId("stats-opd.hall")).toBeInTheDocument(); });

    connect();
    await waitFor(() => { expect(screen.getByTestId("desk-live")).toHaveTextContent("Live"); });
    expect(screen.getByTestId("stats-opd.hall").className).not.toContain("opacity-40");

    act(() => { FakeWebSocket.instances[0]!.close(); });

    await waitFor(() => { expect(screen.getByTestId("desk-live")).toHaveTextContent("Not live"); });
    expect(screen.getByTestId("stats-opd.hall").className).toContain("opacity-40");
  });

  it("A3b: the desk subscribes to the union of the topics the CARDS declare, not to a fixed list", async () => {
    renderAt("/", [HALL, MY_VISITS]);
    await waitFor(() => { expect(screen.getByText("OPD hall")).toBeInTheDocument(); });
    connect();

    await waitFor(() => {
      const subs = FakeWebSocket.instances[0]!.sent
        .map((s) => JSON.parse(s) as { type: string; topics?: string[] })
        .filter((f) => f.type === "subscribe")
        .flatMap((f) => f.topics ?? []);
      expect(subs).toContain("queue:doc-1:2026-08-29");
    });
  });

  /** E-1 — "the app is broken" and "my account has no access" go to different people. */
  it("E-1: a person with no cards is TOLD SO rather than shown a blank page", async () => {
    renderAt("/", [], []);
    expect(await screen.findByText(/Nothing is on your desk yet/i)).toBeInTheDocument();
    // …and the way to their own day is still offered: a day with nothing in it is still an answer.
    expect(screen.getByRole("link", { name: /My day/i })).toHaveAttribute("href", "/my-day");
  });
});
