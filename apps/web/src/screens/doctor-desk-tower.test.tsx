import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouterState } from "@tanstack/react-router";
import { setToken } from "../lib/api";
import { renderWithProviders, renderWithRouter } from "../test-utils";
import { DoctorDeskTower } from "./doctor-desk-tower";
import { DoctorDeskBriefs } from "./doctor-desk-briefs";
import { DoctorLanding, LANDED_KEY } from "./doctor-desk-landing";
import type { WireBrief, WireTower } from "../lib/doctor-desk-api";

/**
 * DD-0 (#626) — the Tower and AI Briefs against the server's wire. 10:00 IST, Tuesday 6 October: an
 * OPD-day SR of General Medicine Unit II with a critical potassium, a CT unread, a visit to finish,
 * two owed rows in the unit and a login brief just shown.
 */
const AT = "2026-10-06T04:30:00.000Z";
const BRIEF: WireBrief = {
  id: "b1", kind: "login", windowFrom: "2026-10-05T12:40:00.000Z", windowTo: AT, createdAt: AT,
  shownAt: AT, seenAt: null, stage: "highlight",
  facts: [
    { key: "brief.lab_critical", params: { analyte: "Potassium", value: "6.4", unit: "mmol/L" }, patient: { id: "pa", uhid: "HMS-1", name: "Patient Alpha", restricted: false }, source: { module: "lab", ref: "r1" }, href: "/patients/pa" },
    { key: "brief.papersToSign", params: { n: 1 }, patient: null, source: null, href: null },
  ],
};
const TOWER: WireTower = {
  at: AT, istDate: "2026-10-06",
  you: { userId: "sr", name: "Dr. Test Senior", grade: "senior_resident" },
  unit: { teamId: "u2", name: "General Medicine Unit II", short: "Unit II", departmentName: "General Medicine" },
  mode: "opd_day",
  tiles: { booked: 31, seen: 12, waiting: 9, longestWaitMinutes: 41, resultsToReview: 1, papersToSign: 1 },
  attention: [
    { key: "lab_critical:c1", kind: "lab_critical", tab: "critical", patient: { id: "pa", uhid: "HMS-1", name: "Patient Alpha", restricted: false }, params: { analyte: "Potassium", value: "6.4", unit: "mmol/L" }, at: "2026-10-06T04:20:00.000Z", goneHome: false, source: { module: "lab", ref: "r1" }, href: "/patients/pa" },
    { key: "imaging_unread:rep1", kind: "imaging_unread", tab: "pending", patient: { id: "pb", uhid: "HMS-2", name: "Patient Beta", restricted: false }, params: { study: "CT abdomen" }, at: "2026-10-06T03:00:00.000Z", goneHome: false, source: { module: "radiology", ref: "rep1" }, href: "/opd/consult" },
    { key: "visit_open:e1", kind: "visit_open", tab: "pending", patient: { id: "pc", uhid: "HMS-3", name: null, restricted: true }, params: { date: "2026-10-05", visitNo: "V2610050007" }, at: "2026-10-05T05:00:00.000Z", goneHome: false, source: { module: "opd", ref: "e1" }, href: "/opd/consult/e1" },
  ],
  tabCounts: { all: 3, critical: 1, change: 0, new: 0, pending: 2 },
  unitOverview: [
    { userId: "sr", name: "Dr. Test Senior", session: "in", booked: 31, seen: 12, waiting: 9, inConsult: 1, longestWaitMinutes: 41 },
    { userId: "ap", name: "Dr. Test Faculty", session: "in", booked: 18, seen: 14, waiting: 4, inConsult: 0, longestWaitMinutes: 12 },
  ],
  clocks: [
    { key: "lab_critical:c9", kind: "lab_critical", what: "lab_critical", holder: { userId: "jr", name: "Dr. Test Junior" }, since: "2026-10-06T04:05:00.000Z", dueAt: "2026-10-06T04:20:00.000Z", nudgedByMe: false },
    { key: "visit:e7", kind: "visit_open", what: "visit_open", holder: { userId: "jr2", name: "Dr. Test Resident" }, since: "2026-10-04T18:30:00.000Z", dueAt: "2026-10-05T18:30:00.000Z", nudgedByMe: true },
    { key: "alert:a1", kind: "alert", what: "respond_overdue", holder: { userId: "sr", name: "Dr. Test Senior" }, since: "2026-10-06T04:25:00.000Z", dueAt: "2026-10-06T04:40:00.000Z", nudgedByMe: false },
  ],
  schedule: [{ kind: "opd", session: "in", booked: 31, waiting: 9 }],
  team: [
    { userId: "hd", name: "Dr. Test Head", role: "head", officiating: false, onDutyUntil: null, holds: 0 },
    { userId: "sr", name: "Dr. Test Senior", role: "senior_resident", officiating: false, onDutyUntil: "2026-10-06T11:30:00.000Z", holds: 1 },
    { userId: "jr", name: "Dr. Test Junior", role: "junior_resident", officiating: false, onDutyUntil: "2026-10-06T11:30:00.000Z", holds: 3 },
  ],
  brief: BRIEF,
  briefsWaiting: 2,
  agentRuns: [{ id: "run1", agent: "login_brief", outcome: "ok", summaryKey: "briefBuilt", params: { lines: 1 }, ranAt: AT }],
};

describe("Doctor Desk Tower (DD-0)", () => {
  const posted: { url: string; body: unknown }[] = [];
  const asked: string[] = [];
  let tower: WireTower = TOWER;
  let hospital: string[] = ["opd.consult", "roster.read"];
  let landing = { tower: true };
  beforeEach(() => {
    setToken("t");
    tower = TOWER;
    hospital = ["opd.consult", "roster.read"];
    landing = { tower: true };
    posted.length = 0;
    asked.length = 0;
    try { sessionStorage.clear(); } catch { /* jsdom */ }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      asked.push(raw);
      if (init?.method === "POST") posted.push({ url: raw, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const body = raw.endsWith("/auth/me") ? { actor: { type: "user", id: "sr" }, permissions: { hospital, scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/doctor-desk/tower") ? tower
            : raw.endsWith("/doctor-desk/landing") ? landing
              : raw.endsWith("/doctor-desk/briefs") ? { briefs: [{ ...BRIEF, stage: "archived" }] }
                : raw.endsWith("/doctor-desk/clocks/nudge") ? { nudgeId: "n1" }
                  : {};
      return new Response(init?.method === "POST" && raw.endsWith("/seen") ? null : JSON.stringify(body), { status: init?.method === "POST" && raw.endsWith("/seen") ? 204 : 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the summary tiles are the server's figures, and the tabs count their rows", async () => {
    renderWithProviders(<DoctorDeskTower />);
    expect(await screen.findByTestId("dd-tile-booked")).toHaveTextContent("31Booked today");
    expect(screen.getByTestId("dd-tile-seen")).toHaveTextContent("12Seen");
    expect(screen.getByTestId("dd-tile-waiting")).toHaveTextContent("9Waitinglongest 41 min");
    expect(screen.getByTestId("dd-tile-papers")).toHaveTextContent("1Visits to finish");
    expect(screen.getByTestId("dd-tab-all")).toHaveTextContent("All3");
    expect(screen.getByTestId("dd-tab-pending")).toHaveTextContent("Pending2");
    const rows = within(screen.getByTestId("dd-attention"));
    expect(rows.getByTestId("dd-row-lab_critical:c1")).toHaveTextContent("Potassium 6.4 mmol/L");
    expect(rows.getByTestId("dd-row-visit_open:e1")).toHaveTextContent("Confidential patient");
    expect(rows.getByTestId("dd-open-lab_critical:c1")).toHaveAttribute("href", "/patients/pa");
    await userEvent.click(screen.getByTestId("dd-tab-critical"));
    expect(rows.queryByTestId("dd-row-imaging_unread:rep1")).toBeNull();
    expect(rows.getByTestId("dd-row-lab_critical:c1")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("dd-tab-new"));
    expect(screen.getByTestId("dd-attention-empty")).toHaveTextContent("New admissions to your unit will show here once the wards are on HMIS.");
  });

  it("without an OPD session the OPD tiles are absent, not zero", async () => {
    tower = { ...TOWER, mode: "plain", tiles: { ...TOWER.tiles, booked: null, seen: null, waiting: null, longestWaitMinutes: null } };
    renderWithProviders(<DoctorDeskTower />);
    expect(await screen.findByTestId("dd-tile-results")).toBeInTheDocument();
    expect(screen.queryByTestId("dd-tile-booked")).toBeNull();
    expect(screen.getByTestId("dd-summary")).toHaveTextContent("No OPD session for you today");
  });

  it("Clocks Running is the first card of the rail; Nudge sends the row's key once; my own row has no button", async () => {
    renderWithProviders(<DoctorDeskTower />);
    const clocks = await screen.findByTestId("dd-clocks");
    const rail = clocks.closest("aside")!;
    expect(rail.firstElementChild).toBe(clocks);
    expect(screen.getByTestId("dd-clocks-late")).toHaveTextContent("2 past their time");
    expect(screen.getByTestId("dd-clock-lab_critical:c9")).toHaveTextContent("10 min over");
    expect(screen.getByTestId("dd-nudge-visit:e7")).toBeDisabled();
    expect(screen.getByTestId("dd-nudge-visit:e7")).toHaveTextContent("Nudged");
    expect(screen.queryByTestId("dd-nudge-alert:a1")).toBeNull();
    expect(screen.getByTestId("dd-clock-alert:a1")).toHaveTextContent("You");
    await userEvent.click(screen.getByTestId("dd-nudge-lab_critical:c9"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/doctor-desk/clocks/nudge", body: { rowKey: "lab_critical:c9" } }));
  });

  it("the Unit Team and AI Agent Activity are collapsed; the summary line names who holds the most", async () => {
    renderWithProviders(<DoctorDeskTower />);
    expect(await screen.findByTestId("dd-team-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("dd-team-rows")).toBeNull();
    expect(screen.getByTestId("dd-team-summary")).toHaveTextContent("3 doctors · 2 on duty now · Dr. Test Junior holds 3");
    expect(screen.getByTestId("dd-agents-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("dd-agents-summary")).toHaveTextContent("nothing failed");
    await userEvent.click(screen.getByTestId("dd-team-toggle"));
    expect(screen.getByTestId("dd-team-rows")).toHaveTextContent("Unit Head");
  });

  it("the login brief is highlighted with Got it; Got it marks it seen", async () => {
    renderWithProviders(<DoctorDeskTower />);
    const brief = await screen.findByTestId("dd-brief");
    expect(brief).toHaveAttribute("data-stage", "highlight");
    expect(brief).toHaveTextContent("Patient Alpha: critical Potassium 6.4 mmol/L");
    expect(brief).toHaveTextContent("1 visits wait for you to finish");
    await userEvent.click(screen.getByTestId("dd-brief-got"));
    await waitFor(() => expect(posted.map((p) => p.url)).toContain("/api/doctor-desk/briefs/b1/seen"));
  });

  it("the menu lists only built places, with the AI Briefs count; Quick Actions only open screens that exist", async () => {
    renderWithProviders(<DoctorDeskTower />);
    const menu = await screen.findByTestId("desk-menu");
    await waitFor(() => expect(within(menu).getByTestId("desk-menu-dashboard")).toHaveAttribute("aria-current", "page"));
    const hrefs = within(menu).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/doctor-desk", "/opd/consult", "/roster/my-duties", "/roster/month", "/roster/on-now", "/doctor-desk/briefs"]);
    expect(within(menu).getByTestId("desk-menu-aiBriefs-n")).toHaveTextContent("2");
    expect(menu).toHaveTextContent("CRKMEDICAL COLLEGE & HOSPITAL");
    const quick = screen.getByTestId("dd-quick").querySelectorAll("a");
    expect([...quick].map((a) => a.getAttribute("href"))).toEqual(["/opd/consult", "/roster/my-duties", "/roster/on-now", "/doctor-desk/briefs"]);
  });

  it("shows no money: no paid, unpaid, fee or rupee word anywhere on the Tower (decision 0058)", async () => {
    renderWithProviders(<DoctorDeskTower />);
    await screen.findByTestId("dd-clocks");
    expect(document.body.textContent ?? "").not.toMatch(/\bpaid\b|unpaid|\bfee\b|₹|rupee|bill/i);
  });

  it("AI Briefs lists every brief, opens the chosen one with its lines, and prints", async () => {
    renderWithProviders(<DoctorDeskBriefs />);
    const sel = await screen.findByTestId("dd-brief-selected");
    expect(sel).toHaveTextContent("Since you left at");
    expect(screen.getByTestId("dd-fact-0")).toHaveAttribute("href", "/patients/pa");
    expect(screen.getByTestId("dd-filter-all")).toHaveAttribute("aria-pressed", "true");
    // Opening an archived, unseen brief counts as seeing it (the menu's count goes down).
    await waitFor(() => expect(posted.map((p) => p.url)).toContain("/api/doctor-desk/briefs/b1/seen"));
    const print = vi.fn();
    vi.stubGlobal("print", print);
    await userEvent.click(screen.getByTestId("dd-brief-print"));
    expect(print).toHaveBeenCalled();
  });
});

describe("Doctor Desk landing (DD-0.1, owner R5)", () => {
  let hospital: string[] = ["opd.consult"];
  let landing = { tower: true };
  const asked: string[] = [];
  function Where(): React.ReactElement {
    const path = useRouterState({ select: (s) => s.location.pathname });
    return <div data-testid="where">{path}</div>;
  }
  beforeEach(() => {
    setToken("t");
    asked.length = 0;
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      asked.push(raw);
      const body = raw.endsWith("/auth/me") ? { actor: { type: "user", id: "sr" }, permissions: { hospital, scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/doctor-desk/landing") ? landing : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a unit doctor landing on / goes to the Tower, once per browser session", async () => {
    hospital = ["opd.consult"];
    landing = { tower: true };
    renderWithRouter(<DoctorLanding><Where /></DoctorLanding>, "/");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/doctor-desk"));
    expect(sessionStorage.getItem(LANDED_KEY)).toBe("1");
  });

  it("a doctor in no unit stays on the Desk", async () => {
    landing = { tower: false };
    renderWithRouter(<DoctorLanding><Where /></DoctorLanding>, "/");
    await waitFor(() => expect(asked.some((u) => u.endsWith("/doctor-desk/landing"))).toBe(true));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("someone without opd.consult is never asked", async () => {
    hospital = ["registration.desk"];
    renderWithRouter(<DoctorLanding><Where /></DoctorLanding>, "/");
    await waitFor(() => expect(asked.some((u) => u.endsWith("/auth/me"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.some((u) => u.endsWith("/doctor-desk/landing"))).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("a second visit to / in the same session stays on the Desk", async () => {
    sessionStorage.setItem(LANDED_KEY, "1");
    hospital = ["opd.consult"];
    renderWithRouter(<DoctorLanding><Where /></DoctorLanding>, "/");
    await waitFor(() => expect(asked.some((u) => u.endsWith("/auth/me"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.some((u) => u.endsWith("/doctor-desk/landing"))).toBe(false);
  });
});
