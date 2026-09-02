import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth";
import { PatientInHandProvider } from "../lib/patient-in-hand";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { router } from "../router";
import { CounterFigures } from "./counter-figures";
import { RegistrationCounter } from "./registration-counter";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import type { WireDeskCard, WireReport } from "../lib/desk-api";

/**
 * FD-1 T4 — "your figures" composes rails that exist (`/me/desk`, `/me/brief`, `/me/report`) and
 * invents nothing: every figure on screen is the server's. Two clerks: clerk B's page carries none
 * of clerk A's figures (phase doc D8). One `.print-doc`. Escape returns to the seat.
 */
const cardsA: WireDeskCard[] = [
  { key: "patients.registration", band: "today", titleKey: "desk.patients.registration", stats: [
    { key: "desk.patients.registered", value: "38", href: "/registration" }, { key: "desk.patients.noMobile", value: "2", href: "/registration" }, { key: "desk.patients.duplicatesPending", value: "1", href: "/merge" } ] },
  { key: "patients.cameBack", band: "today", titleKey: "desk.patients.cameBack", stats: [
    { key: "desk.patients.duplicatesConfirmed", value: "3", href: "/merge" }, { key: "desk.patients.noMobileMonth", value: "11", href: "/registration" }, { key: "desk.patients.amendedWeek", value: "8", href: "/registration" } ] },
  { key: "opd.appointments", band: "now", titleKey: "desk.appointments.title", stats: [
    { key: "desk.appointments.dueToday", value: "12", href: "/opd/appointments" }, { key: "desk.appointments.checkedIn", value: "7", href: "/opd/appointments" }, { key: "desk.appointments.missed", value: "1", href: "/opd/appointments" }, { key: "desk.appointments.needsRebooking", value: "2", href: "/opd/appointments" } ] },
  { key: "billing.myCollections", band: "today", titleKey: "desk.billing.myCollections", stats: [
    { key: "desk.billing.collected", value: "₹1,900.00", href: "/billing/session" }, { key: "desk.billing.receipts", value: "38", href: "/my-day" }, { key: "desk.billing.cash", value: "₹1,550.00", href: "/billing/session" },
    { key: "desk.billing.float", value: "₹2,250.00", href: "/billing/session" }, { key: "desk.billing.expectedCash", value: "₹3,800.00", href: "/billing/session" } ] },
];
const cardsB: WireDeskCard[] = [
  { key: "patients.registration", band: "today", titleKey: "desk.patients.registration", stats: [
    { key: "desk.patients.registered", value: "5", href: "/registration" }, { key: "desk.patients.noMobile", value: "0", href: "/registration" }, { key: "desk.patients.duplicatesPending", value: "0", href: "/merge" } ] },
  { key: "patients.cameBack", band: "today", titleKey: "desk.patients.cameBack", stats: [
    { key: "desk.patients.duplicatesConfirmed", value: "0", href: "/merge" }, { key: "desk.patients.noMobileMonth", value: "1", href: "/registration" }, { key: "desk.patients.amendedWeek", value: "0", href: "/registration" } ] },
];
const reportA: WireReport = { date: "2026-09-02", provisional: true, sections: [
  { key: "opd.myVisits", titleKey: "report.opd.myVisits", columnKeys: ["report.col.time", "report.col.uhid"], rows: [["09:12", "UH-23-04417"]], totals: ["", "1"] } ] };

function stubFigures(who: "A" | "B", seen: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    seen.push(url);
    const path = url.split("?")[0]!;
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/auth/me") return json({ actor: { type: "user", id: who === "A" ? "ramesh" : "sunil" }, permissions: { hospital: ["patients.register", "opd.visits.open"], scoped: { department: {}, floor: {} } } });
    if (path === "/api/me/desk") return json({ date: "2026-09-02", cards: who === "A" ? cardsA : cardsB });
    if (path === "/api/me/brief") {
      const period = new URL(url, "http://x").searchParams.get("period");
      return json({ period, from: "2026-08-24", to: "2026-08-29", clauses: who === "A" ? [{ key: "brief.registered.compared", values: { total: "142", median: "118" } }] : [], totals: {}, daysWithActivity: 5 });
    }
    if (path === "/api/me/report") return json(who === "A" ? reportA : { date: "2026-09-02", provisional: true, sections: [] });
    if (path === "/api/opd/config" || path === "/api/opd/queues/summary" || path === "/api/billing/sessions/current") return json({ items: [], session: null, counterSequence: "queue_first", tokenLane: "token_first" });
    void init;
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("FD-1 T4 — your figures", () => {
  it("clerk A: the brief in sentences, today so far from the three tiles, what came back as three sentences, the drawer, and ONE printable day", async () => {
    const seen: string[] = [];
    stubFigures("A", seen);
    const onBack = vi.fn();
    renderWithProviders(<CounterFigures onBack={onBack} onGo={() => {}} />);
    await waitFor(() => expect(screen.getByText("142 patients registered, against a median of 118.")).toBeInTheDocument());
    expect(screen.getByTestId("counter-figures").getAttribute("data-seat")).toBe("registration-counter");
    await waitFor(() => expect(screen.getByTestId("figure-desk.patients.registered").textContent).toContain("38"));
    expect(screen.getByTestId("figure-desk.appointments.dueToday").textContent).toContain("12");
    expect(screen.getByTestId("figure-desk.billing.collected").textContent).toContain("₹1,900.00");
    expect(screen.getByTestId("figure-desk.patients.registered").querySelector("a")!.getAttribute("href")).toBe("/registration");   // every figure is a door
    expect(screen.getByTestId("sentence-duplicates").textContent).toContain("3 of your registrations turned out to be duplicates");
    expect(screen.getByTestId("sentence-noMobile").textContent).toContain("11 records");
    expect(screen.getByTestId("sentence-amended").textContent).toContain("8 were amended within a week");
    expect(screen.getByTestId("figure-desk.billing.float").textContent).toContain("₹2,250.00");
    expect(screen.getByTestId("figure-desk.billing.expectedCash").textContent).toContain("₹3,800.00");
    await waitFor(() => expect(screen.getByText("UH-23-04417")).toBeInTheDocument());
    expect(document.querySelectorAll(".print-doc")).toHaveLength(1);
    expect(screen.getAllByText("Provisional").length).toBeGreaterThan(0);
    // the period bar re-reads the brief with the period
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() => expect(seen.some((u) => u.includes("/api/me/brief") && u.includes("period=month"))).toBe(true));
    // Escape returns to the seat — outside a field only
    const dateBox = screen.getByTestId("figures-date");
    dateBox.focus();
    fireEvent.keyDown(dateBox, { key: "Escape" });
    expect(onBack).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("figures-back"));
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it("clerk B: no billing card → 'this login holds no drawer'; no appointments card → no appointment figures; B's numbers, not A's", async () => {
    const seen: string[] = [];
    stubFigures("B", seen);
    renderWithProviders(<CounterFigures onBack={() => {}} onGo={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("figure-desk.patients.registered").textContent).toContain("5"));
    expect(screen.queryByTestId("figure-desk.appointments.dueToday")).not.toBeInTheDocument();
    expect(screen.getByTestId("drawer-none")).toBeInTheDocument();
    expect(screen.getByTestId("sentence-duplicates").textContent).toContain("0 of your registrations");
    expect(screen.getByTestId("sentence-noMobile").textContent).toContain("1 record you created");
    expect(screen.queryByText("38")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Nothing to report for this period yet — a comparison needs a fortnight of history before it can be made honestly.")).toBeInTheDocument());
  });

  it("CLOSE pass 1 CRITICAL: one query client, two logins — clerk B never sees clerk A's figures, not even before B's answer arrives", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
    const seenA: string[] = [];
    stubFigures("A", seenA);
    const mount = (): ReturnType<typeof render> => render(
      <QueryClientProvider client={qc}><AuthProvider><PatientInHandProvider><CounterFigures onBack={() => {}} onGo={() => {}} /></PatientInHandProvider></AuthProvider></QueryClientProvider>,
    );
    const a = mount();
    await waitFor(() => expect(screen.getByTestId("figure-desk.patients.registered").textContent).toContain("38"));
    a.unmount();
    // B logs in on the same tab within the stale window; the server now answers as B
    const seenB: string[] = [];
    stubFigures("B", seenB);
    setToken("t2");
    mount();
    expect(screen.queryByText("38")).not.toBeInTheDocument();                       // nothing of A is painted from the cache
    await waitFor(() => expect(screen.getByTestId("figure-desk.patients.registered").textContent).toContain("5"));
    expect(screen.queryByText("38")).not.toBeInTheDocument();
    expect(screen.queryByText("UH-23-04417")).not.toBeInTheDocument();             // A's report rows never reach B's print document
  });

  it("CLOSE pass 1: a failed report is SAID and nothing is printed; a missing stat is silence, never a sentence about 0; a cleared date box asks nothing", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
      seen.push(url);
      const path = url.split("?")[0]!;
      const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "ramesh" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/me/desk") return json({ date: "2026-09-02", cards: [{ key: "patients.cameBack", band: "today", titleKey: "desk.patients.cameBack", stats: [{ key: "desk.patients.duplicatesConfirmed", value: "2", href: "/merge" }] }] });
      if (path === "/api/me/brief") return json({ statusCode: 500, code: "boom" }, 500);
      if (path === "/api/me/report") return json({ statusCode: 500, code: "boom" }, 500);
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<CounterFigures onBack={() => {}} onGo={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("report-failed")).toBeInTheDocument());
    expect(document.querySelectorAll(".print-doc")).toHaveLength(0);
    expect(screen.queryByText("Nothing was recorded against your account on this day.")).not.toBeInTheDocument();
    expect(screen.getByTestId("figures-print")).toBeDisabled();
    await waitFor(() => expect(screen.getByText("The brief could not be read — try again, or ask an administrator.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("sentence-duplicates")).toBeInTheDocument());
    expect(screen.queryByTestId("sentence-noMobile")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sentence-amended")).not.toBeInTheDocument();
    const before = seen.length;
    fireEvent.change(screen.getByTestId("figures-date"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("figures-date"), { target: { value: "2026-1" } });
    await act(async () => { /* settle */ });
    expect(seen.slice(before).some((u) => u.includes("date="))).toBe(false);
    expect((screen.getByTestId("figures-date") as HTMLInputElement).value).toBe(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  });

  it("CLOSE pass 2: a report that was there and then fails to refetch is NOT printable — the alert and the button agree", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
      const path = url.split("?")[0]!;
      const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "ramesh" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/me/desk") return json({ date: "2026-09-02", cards: [] });
      if (path === "/api/me/brief") return json({ period: "week", from: "", to: "", clauses: [], totals: {}, daysWithActivity: 0 });
      if (path === "/api/me/report") return fail ? json({ code: "boom" }, 500) : json(reportA);
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<CounterFigures onBack={() => {}} onGo={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".print-doc")).toHaveLength(1));
    expect(screen.getByTestId("figures-print")).toBeEnabled();
    fail = true;
    // the same key refetches (a window focus, a poll) and fails: v5 keeps the old data — the screen must not print it
    fireEvent(window, new Event("focus"));
    fireEvent.change(screen.getByTestId("figures-date"), { target: { value: "2026-09-03" } });
    fireEvent.change(screen.getByTestId("figures-date"), { target: { value: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) } });
    await waitFor(() => expect(screen.getByTestId("report-failed")).toBeInTheDocument());
    expect(document.querySelectorAll(".print-doc")).toHaveLength(0);
    expect(screen.getByTestId("figures-print")).toBeDisabled();
  });

  it("CLOSE pass 2: everyone's bookings are labelled as everyone's beside my figures", async () => {
    const seen: string[] = [];
    stubFigures("A", seen);
    renderWithProviders(<CounterFigures onBack={() => {}} onGo={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("figures-hospital")).toBeInTheDocument());
    expect(screen.getByTestId("figures-hospital").getAttribute("data-scope")).toBe("hospital");
    expect(screen.getByTestId("figures-hospital").textContent).toContain("everyone's bookings");
    expect(screen.getByTestId("figures-hospital").contains(screen.getByTestId("figure-desk.appointments.dueToday"))).toBe(true);
    expect(screen.getByTestId("figures-hospital").contains(screen.getByTestId("figure-desk.patients.registered"))).toBe(false);
  });

  it("CLOSE pass 1: a figure is a client-side door, not a reload — the anchor keeps its href and hands the click to the router", async () => {
    const seen: string[] = [];
    stubFigures("A", seen);
    const onGo = vi.fn();
    renderWithProviders(<CounterFigures onBack={() => {}} onGo={onGo} />);
    await waitFor(() => expect(screen.getByTestId("figure-desk.patients.registered")).toBeInTheDocument());
    const a = screen.getByTestId("figure-desk.patients.registered").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/registration");
    const ev = fireEvent.click(a);
    expect(ev).toBe(false);                     // default prevented: no reload
    expect(onGo).toHaveBeenCalledWith("/registration");
  });

  it("the seat wears the door", async () => {
    const seen: string[] = [];
    stubFigures("A", seen);
    const onFigures = vi.fn();
    renderWithProviders(<RegistrationCounter onFigures={onFigures} />);
    await waitFor(() => expect(screen.getByTestId("figures-door")).toBeInTheDocument());
    expect(screen.getByTestId("figures-door").getAttribute("href")).toBe("/counter/figures");
    expect(fireEvent.click(screen.getByTestId("figures-door"))).toBe(false);   // handed to the router, no reload
    expect(onFigures).toHaveBeenCalledTimes(1);
  });
});

describe("FD-1 T5 (pass 1) — the round trip: figures → Escape → the seat, with the patient in hand untouched", () => {
  it("under the real router, Escape on the figures screen lands on the seat and the dossier still holds the patient", async () => {
    const seen: string[] = [];
    stubFigures("A", seen);
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "P-A", encounterId: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider><RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/counter/figures"] })} /></AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("counter-figures")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("registration-counter")).toBeInTheDocument());
    expect(screen.queryByTestId("counter-figures")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("hmis.inHand")).toContain("P-A");     // the session survived the trip
    // and the door goes back without a reload
    expect(fireEvent.click(screen.getByTestId("figures-door"))).toBe(false);
    await waitFor(() => expect(screen.getByTestId("counter-figures")).toBeInTheDocument());
  });
});
