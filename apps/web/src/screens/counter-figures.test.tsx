import { fireEvent, screen, waitFor } from "@testing-library/react";
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
    renderWithProviders(<CounterFigures onBack={onBack} />);
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
    renderWithProviders(<CounterFigures onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("figure-desk.patients.registered").textContent).toContain("5"));
    expect(screen.queryByTestId("figure-desk.appointments.dueToday")).not.toBeInTheDocument();
    expect(screen.getByTestId("drawer-none")).toBeInTheDocument();
    expect(screen.getByTestId("sentence-duplicates").textContent).toContain("0 of your registrations");
    expect(screen.getByTestId("sentence-noMobile").textContent).toContain("1 record you created");
    expect(screen.queryByText("38")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Nothing to report for this period yet — a comparison needs a fortnight of history before it can be made honestly.")).toBeInTheDocument());
  });

  it("the seat wears the door", async () => {
    const seen: string[] = [];
    stubFigures("A", seen);
    renderWithProviders(<RegistrationCounter />);
    await waitFor(() => expect(screen.getByTestId("figures-door")).toBeInTheDocument());
    expect(screen.getByTestId("figures-door").getAttribute("href")).toBe("/counter/seat/figures");
  });
});
