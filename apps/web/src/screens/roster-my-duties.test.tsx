import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RosterMyDuties, weekOf, whyNot } from "./roster-my-duties";
import type { WireCoverOptions, WireCoverRequest, WireMyDuties } from "../lib/roster-api";

/** Tuesday 6 October 2026, 07:40 IST — the board's own instant. */
const AT = "2026-10-06T02:10:00.000Z";
const ist = (s: string): string => new Date(`${s}:00+05:30`).toISOString();
const duty = (id: string, from: string, to: string, over: Partial<WireMyDuties["duties"][number]> = {}): WireMyDuties["duties"][number] => ({
  assignmentId: id, userId: "me", positionKey: "ward_jr", positionLabel: "Ward junior resident",
  startsAt: ist(from), endsAt: ist(to), istDate: from.slice(0, 10), night: from.slice(0, 10) !== to.slice(0, 10),
  mode: "presence", kind: "duty", departmentId: "d-ortho", teamId: "u2", teamName: "Orthopaedics Unit II",
  activities: [], upcoming: true, ...over,
});
const SAT = duty("sat", "2026-10-10T20:00", "2026-10-11T08:00");

const MINE: WireMyDuties = {
  at: AT, days: ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"],
  you: { name: "Dr. Meena Joshi", grade: "jr1", positionKey: "ward_jr", unitName: "Orthopaedics Unit II", departmentName: "Orthopaedics" },
  duties: [
    duty("tue", "2026-10-06T08:30", "2026-10-06T14:00", { activities: ["elective_ot", "take"] }),
    duty("wed", "2026-10-07T20:00", "2026-10-08T08:00"),
    duty("fri", "2026-10-09T08:30", "2026-10-09T14:00", { activities: ["elective_ot"] }),
    SAT,
  ],
  onTake: { teamId: "u3", name: "Orthopaedics Unit III", endsAt: ist("2026-10-07T08:00") },
  mySr: { userId: "sr", name: "Dr. Pooja Mishra", phone: "9876500011" },
  requests: [],
};

const OPTIONS: WireCoverOptions = {
  duty: SAT, ownerName: "Dr. Meena Joshi", openRequestId: null,
  canTake: [{
    userId: "rohit", name: "Dr. Rohit Bansal", grade: "jr2", teamId: "u1", teamName: "Orthopaedics Unit I", crossUnit: true,
    nextDay: { istDate: "2026-10-11", duty: null }, swaps: [],
  }],
  cannot: [
    { userId: "sandeep", name: "Dr. Sandeep Yadav", grade: "jr1", teamId: "u2", teamName: "Orthopaedics Unit II", reason: { ruleKey: "night_one_in_three", severity: "warn", params: {} }, near: { istDate: "2026-10-11", night: true } },
    { userId: "aman", name: "Dr. Aman Gupta", grade: "jr1", teamId: "u3", teamName: "Orthopaedics Unit III", reason: { ruleKey: "unavailable", severity: "unavailable", params: {} }, near: null },
  ],
};

const ASKED: WireCoverRequest = {
  requestId: "rq1", kind: "cover", status: "asked", crossUnit: true,
  owner: { userId: "me", name: "Dr. Meena Joshi" }, counterpart: { userId: "rohit", name: "Dr. Rohit Bansal" }, requestedBy: { userId: "me", name: "Dr. Meena Joshi" },
  duty: SAT, give: null, note: null, requestedAt: AT, answeredAt: null, decidedBy: null, decidedAt: null, refusedRule: null, check: null,
  youMay: { answer: false, approve: false, withdraw: true },
};

describe("RosterMyDuties (20-U U5c)", () => {
  const posted: { url: string; body: unknown }[] = [];
  let state: WireMyDuties;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    state = { ...MINE, requests: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
        if (raw.endsWith("/roster/covers")) state = { ...state, requests: [ASKED] };
        if (raw.includes("/answer")) state = { ...state, requests: [] };
        return new Response(JSON.stringify({ requestId: "rq1", ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.includes("/cover-options") ? OPTIONS
            : state;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("today on the dark card, the rest of the week as the board writes it, rest after a night, and I can't do this on a duty ahead", async () => {
    renderWithProviders(<RosterMyDuties />);
    expect(await screen.findByTestId("my-duties-greeting")).toHaveTextContent("Good morning, Dr. Meena");
    expect(screen.getByText("Orthopaedics · Unit II · JR-1")).toBeInTheDocument();
    const today = screen.getByTestId("my-duties-today");
    expect(today).toHaveTextContent("Theatre");
    expect(today).toHaveTextContent("08:30 to 14:00");
    expect(today).toHaveTextContent("Tonight: free");
    expect(today).toHaveTextContent("Unit III is on take");
    expect(screen.getByTestId("my-day-2026-10-07")).toHaveTextContent("WED7Ward night20:00 to 08:00");
    // The day after a night is REST, and says until when nobody may roster you.
    expect(screen.getByTestId("my-day-2026-10-08")).toHaveTextContent("RestAfter your night. Nobody can roster you before 20:00");
    expect(screen.getByTestId("my-day-2026-10-11")).toHaveTextContent("RestAfter your night");
    expect(within(screen.getByTestId("my-day-2026-10-10")).getByRole("button", { name: /I can't\s*do this/ })).toBeInTheDocument();
    expect(screen.getByTestId("call-my-sr")).toHaveAttribute("href", "tel:9876500011");
  });

  it("I can't do this → who can take it, and for everybody else why not — unavailable, never the leave; Ask sends the request and the duty stays mine", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterMyDuties />);
    await user.click(await screen.findByTestId("cant-sat"));
    const picker = await screen.findByTestId("cover-picker");
    expect(picker).toHaveTextContent("Saturday 10 Oct, night");
    expect(await screen.findByTestId("can-rohit")).toHaveTextContent("Dr. Rohit BansalJR-2 · Unit I · free Saturday, off SundayAnother unit, so the HOD also approves");
    expect(screen.getByTestId("cannot-sandeep")).toHaveTextContent("Has Sunday night. This would be a second night in three.");
    expect(screen.getByTestId("cannot-aman")).toHaveTextContent("Unavailable on those days.");
    expect(picker).not.toHaveTextContent(/leave/i);

    await user.click(screen.getByTestId("ask-rohit"));
    expect(posted).toEqual([{ url: expect.stringMatching(/\/roster\/covers$/) as unknown as string, body: { assignmentId: "sat", counterpartId: "rohit" } }]);
    const card = await screen.findByTestId("my-request-rq1");
    expect(card).toHaveTextContent("Asked: Dr. Rohit Bansal, for Saturday night");
    expect(card).toHaveTextContent("Until then, Saturday night is still yours.");
    // No second request for the same night.
    expect(within(screen.getByTestId("my-day-2026-10-10")).queryByRole("button")).toBeNull();
  });

  it("a request made OF me: what it is, that it was checked, and Yes / No", async () => {
    state = { ...MINE, requests: [{ ...ASKED, owner: { userId: "kavita", name: "Dr. Kavita Rao" }, counterpart: { userId: "me", name: "Dr. Meena Joshi" }, requestedBy: { userId: "kavita", name: "Dr. Kavita Rao" }, youMay: { answer: true, approve: false, withdraw: false } }] };
    const user = userEvent.setup();
    renderWithProviders(<RosterMyDuties />);
    const asked = await screen.findByTestId("asked-of-you-rq1");
    expect(asked).toHaveTextContent("Dr. Kavita Rao asks you to take Saturday 10 Oct, night, 20:00 to 08:00.");
    expect(asked).toHaveTextContent("Checked: you are free then, and it breaks no rule.");
    await user.click(within(asked).getByTestId("answer-yes"));
    expect(posted.map((p) => [p.url.replace(/^.*\/roster/, "/roster"), p.body])).toEqual([["/roster/covers/rq1/answer", { accept: true }]]);
  });

  it("weekOf: a day with no duty after a night is rest until twelve hours after it ends", () => {
    const w = weekOf(MINE);
    expect(w.map((d) => [d.istDate, d.duty?.assignmentId ?? (d.rest === null ? "off" : "rest")])).toEqual([
      ["2026-10-06", "tue"], ["2026-10-07", "wed"], ["2026-10-08", "rest"], ["2026-10-09", "fri"],
      ["2026-10-10", "sat"], ["2026-10-11", "rest"], ["2026-10-12", "off"],
    ]);
  });

  it("whyNot never names a leave, whatever the reason code carried", () => {
    const t = (k: string, o?: Record<string, unknown>) => `${k}${o === undefined ? "" : JSON.stringify(o)}`;
    expect(whyNot({ reason: { ruleKey: "unavailable", severity: "unavailable", params: {} }, near: { istDate: "2026-10-11", night: true } }, t, "en"))
      .toBe("rosterMyDuties.why.unavailable{\"defaultValue\":\"rosterMyDuties.why.other{\\\"rule\\\":\\\"unavailable\\\"}\"}");
  });
});
