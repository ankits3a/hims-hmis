import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RosterMonth } from "./roster-month";
import type { WireMonthFinding, WireUnitMonth } from "../lib/roster-api";

const UNITS = [{ departmentId: "d-med", code: "MED", name: "General Medicine", units: [{ teamId: "u2", code: "MED-U2", name: "Medicine Unit II", confirmed: true }] }];

const night = { assignmentId: "a-night", userId: "kavita", name: "Dr. Kavita Rao", positionKey: "ward_jr", startsAt: "2026-10-12T14:30:00.000Z", endsAt: "2026-10-13T02:30:00.000Z", istDate: "2026-10-12", night: true, mode: "presence", kind: "duty" };
const morning = { assignmentId: "a-morning", userId: "kavita", name: "Dr. Kavita Rao", positionKey: "ward_jr", startsAt: "2026-10-13T03:30:00.000Z", endsAt: "2026-10-13T11:30:00.000Z", istDate: "2026-10-13", night: false, mode: "presence", kind: "duty" };

const REST: WireMonthFinding = {
  ruleKey: "rest_after_duty", severity: "block", userId: "kavita", name: "Dr. Kavita Rao", assignmentId: "a-morning",
  istDate: "2026-10-13", params: { restHours: 1, minHours: 12 }, blocking: true, accepted: null,
};
const OFF: WireMonthFinding = {
  ruleKey: "weekly_off", severity: "warn", userId: "sandeep", name: "Dr. Sandeep Yadav", assignmentId: null,
  istDate: "2026-10-05", params: { from: "2026-10-05", to: "2026-10-11", perDays: 7 }, blocking: false, accepted: null,
};

const month = (over: Partial<WireUnitMonth> = {}): WireUnitMonth => ({
  unit: { teamId: "u2", code: "MED-U2", name: "Medicine Unit II", confirmed: true, departmentId: "d-med", departmentName: "General Medicine" },
  month: "2026-10", startsAt: "2026-09-30T18:30:00.000Z", endsAt: "2026-10-31T18:30:00.000Z",
  days: Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`),
  period: { periodId: "p1", version: 1, status: "draft", origin: "machine", title: "2026-10 — Medicine Unit II", contentHash: "h1", publishedAt: null },
  positions: [{ key: "ward_jr", label: "Ward junior resident" }],
  people: [
    { userId: "kavita", name: "Dr. Kavita Rao", positionKey: "ward_jr", grade: "jr3" },
    { userId: "sandeep", name: "Dr. Sandeep Yadav", positionKey: "ward_jr", grade: "jr2" },
  ],
  assignments: [night, morning],
  findings: [REST, OFF],
  counts: { blocking: 1, warnings: 1, info: 0 },
  fairness: [{ userId: "kavita", name: "Dr. Kavita Rao", nights: 10, sundays: 1, holidays: 0 }],
  youMay: { draft: false, edit: true, acceptWarning: true, publish: true },
  ...over,
});

describe("RosterMonth (20-U U5b)", () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let current: WireUnitMonth;
  let afterWrite: WireUnitMonth;

  beforeEach(() => {
    setToken("t");
    calls.length = 0;
    current = month();
    afterWrite = month({ assignments: [night, { ...morning, userId: null, name: null }], findings: [OFF], counts: { blocking: 0, warnings: 1, info: 0 } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/roster/units")) return json(UNITS);
      if (method === "GET") return json(current);
      current = afterWrite;
      return json(afterWrite);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("publish is disabled, and says why, while a must-fix finding stands — and the finding is a sentence naming the person and the day", async () => {
    renderWithProviders(<RosterMonth team="u2" month="2026-10" />);
    const panel = await screen.findByTestId("before-you-publish");
    const button = within(panel).getByTestId("publish");
    expect(button).toBeDisabled();
    expect(within(panel).getByTestId("publish-why")).toHaveTextContent(/One thing stops this from publishing/);
    expect(within(panel).getByTestId("count-line")).toHaveTextContent("1 must fix · 1 to look at");
    const rest = within(panel).getByTestId("finding-rest_after_duty");
    expect(rest).toHaveTextContent("Dr. Kavita Rao gets only 1 hours' rest before the duty on 13 Oct, and needs at least 12 after a duty.");
    expect(rest).toHaveTextContent("MUST FIX");
  });

  it("the one-tap fix leaves that duty vacant through the server, and publish then sends the hash it was shown", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterMonth team="u2" month="2026-10" />);
    const rest = await screen.findByTestId("finding-rest_after_duty");
    await user.click(within(rest).getByRole("button", { name: /leave it vacant/ }));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ body: { userId: null } });
    expect(calls.find((c) => c.method === "PUT")!.url).toMatch(/\/roster\/slots\/a-morning$/);

    const button = await screen.findByRole("button", { name: "Publish October 2026 for Medicine Unit II" });
    expect(button).toBeEnabled();
    expect(screen.queryByTestId("publish-why")).toBeNull();
    await user.click(button);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/roster/periods/p1/publish"));
    expect(post?.body).toEqual({ expectedContentHash: "h1" });
  });

  it("a warning is accepted only with a reason", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterMonth team="u2" month="2026-10" />);
    const off = await screen.findByTestId("finding-weekly_off");
    await user.click(within(off).getByRole("button", { name: /I'll note why/ }));
    const accept = within(off).getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    await user.type(within(off).getByPlaceholderText("Why it is fine"), "festival week, agreed with the unit");
    await user.click(accept);
    const post = calls.find((c) => c.url.endsWith("/roster/periods/p1/findings/accept"));
    expect(post?.body).toEqual({ ruleKey: "weekly_off", assignmentId: null, userId: "sandeep", reason: "festival week, agreed with the unit" });
  });

  it("a reader sees the month and the problems, but no fix, no accept, and publish says whose it is", async () => {
    current = month({ youMay: { draft: false, edit: false, acceptWarning: false, publish: false }, findings: [OFF], counts: { blocking: 0, warnings: 1, info: 0 } });
    renderWithProviders(<RosterMonth team="u2" month="2026-10" />);
    const panel = await screen.findByTestId("before-you-publish");
    expect(within(panel).queryByRole("button", { name: /leave it vacant|I'll note why/ })).toBeNull();
    expect(within(panel).getByTestId("publish")).toBeDisabled();
    expect(within(panel).getByTestId("publish-why")).toHaveTextContent(/Only the unit's head or the medical superintendent/);
    expect(screen.queryByTestId("slot-a-night")).toBeNull();
  });

  it("an undrafted month offers the proposer's draft to whoever may draft it", async () => {
    current = month({ period: null, assignments: [], findings: [], counts: { blocking: 0, warnings: 0, info: 0 }, youMay: { draft: true, edit: false, acceptWarning: true, publish: false } });
    const user = userEvent.setup();
    renderWithProviders(<RosterMonth team="u2" month="2026-10" />);
    const none = await screen.findByTestId("no-draft");
    expect(none).toHaveTextContent("Nobody has drafted October 2026 for Medicine Unit II yet.");
    await user.click(within(none).getByRole("button", { name: "Draft it for me" }));
    expect(calls.find((c) => c.method === "POST")?.url).toMatch(/\/roster\/units\/u2\/months\/2026-10\/draft$/);
  });
});
