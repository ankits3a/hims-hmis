import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StaffReports } from "./staff-reports";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * PLAN 07c T9 / DD14 — **WHAT, NOT WHOM**, on the screen.
 *
 * The server is what makes the figures unable to carry a patient (they are integers). What this
 * screen owes is the other half of DD14: that the drill is visibly a deliberate, explained act
 * rather than a link, and that a supervisor who holds only the read permission is not shown a
 * control the server would refuse.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>, seen?: { url: string; body?: string }[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen?.push({ url: raw, body: init?.body as string | undefined });
      const h = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
      if (h === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const STAFF = { items: [{ id: "u-clerk", username: "asha", fullName: "Asha Devi" }] };
const BRIEF = {
  period: "week", from: "2026-08-23", to: "2026-08-29", subjectUserId: "u-clerk",
  daysWithActivity: 5, totals: { "opd.visitsOpened": 61 }, totalsToday: { "opd.visitsOpened": 12 },
  clauses: [{ key: "brief.visits.compared", values: { total: "61", median: "48" } }],
};
const me = (hospital: string[]): Reply => ({
  status: 200, body: { actor: { type: "user", id: "sup" }, permissions: { hospital, scoped: { department: {}, floor: {} } } },
});

function mount(hospital: string[], extra: Record<string, Reply> = {}, seen?: { url: string; body?: string }[]): void {
  mockRoutes({
    "GET /api/auth/me": me(hospital),
    "GET /api/staff": { status: 200, body: STAFF },
    "GET /api/staff/u-clerk/brief": { status: 200, body: BRIEF },
    ...extra,
  }, seen);
  setToken("t-1");
  renderWithProviders(<StaffReports />);
}

afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

describe("07c T9 — the supervisor's named-staff view", () => {
  it("shows a person's figures, and says in words that it does not list patients", async () => {
    mount(["staff.reports.read"]);
    await waitFor(() => { expect(screen.getByRole("option", { name: "Asha Devi" })).toBeInTheDocument(); });

    await userEvent.selectOptions(screen.getByLabelText("Staff member"), "u-clerk");

    expect(await screen.findByText("61 visits opened, against a median of 48.")).toBeInTheDocument();
    // DD14's constraint, said where somebody would wonder about it rather than only in a document.
    expect(screen.getByText(/It does not list patients/i)).toBeInTheDocument();
  });

  /**
   * A supervisor holding only `staff.reports.read` is not shown the drill at all. The server would
   * refuse it (a 403 the e2e pins), so this is courtesy rather than security — but a control that
   * refuses everyone who can see it is how people learn to ignore refusals.
   */
  it("A3: the drill control is absent for somebody who holds only the read permission", async () => {
    mount(["staff.reports.read"]);
    await userEvent.selectOptions(await screen.findByLabelText("Staff member"), "u-clerk");
    await waitFor(() => { expect(screen.getByText(/It does not list patients/i)).toBeInTheDocument(); });

    expect(screen.queryByRole("button", { name: "Open the rows" })).not.toBeInTheDocument();
  });

  /**
   * A2 — THE REASON IS THE CONTROL, and the screen must not let it be a formality. The button is
   * disabled until a real reason is typed, and the warning says what pressing it does BEFORE it is
   * pressed: a person should know they are being recorded when they decide, not six weeks later.
   */
  it("A2: the drill needs a real reason, and says it is recorded before it is used", async () => {
    mount(["staff.reports.read", "staff.reports.drill"]);
    await userEvent.selectOptions(await screen.findByLabelText("Staff member"), "u-clerk");

    expect(await screen.findByText(/recorded against your account/i)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Open the rows" });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Why are you opening these rows/i), "short");
    expect(button).toBeDisabled();
  });

  it("A2: a drill POSTs the reason and renders the rows it gets back", async () => {
    const seen: { url: string; body?: string }[] = [];
    mount(["staff.reports.read", "staff.reports.drill"], {
      "POST /api/staff/u-clerk/drill": {
        status: 200,
        body: {
          subjectUserId: "u-clerk", date: "2026-08-29",
          sections: [{
            key: "opd.myVisits", titleKey: "report.opd.myVisits",
            columnKeys: ["report.col.time", "report.col.patient"],
            rows: [["09:30", "Guest One"]],
          }],
        },
      },
    }, seen);
    await userEvent.selectOptions(await screen.findByLabelText("Staff member"), "u-clerk");
    await userEvent.type(screen.getByLabelText(/Why are you opening these rows/i), "variance review for the 17th");
    await userEvent.click(screen.getByRole("button", { name: "Open the rows" }));

    expect(await screen.findByText("Guest One")).toBeInTheDocument();
    const post = seen.find((c) => c.url.includes("/drill"));
    expect(post?.body).toContain("variance review for the 17th");
  });

  it("a refused drill says so rather than appearing to have returned nothing", async () => {
    mount(["staff.reports.read", "staff.reports.drill"], {
      "POST /api/staff/u-clerk/drill": { status: 403, body: { message: "no" } },
    });
    await userEvent.selectOptions(await screen.findByLabelText("Staff member"), "u-clerk");
    await userEvent.type(screen.getByLabelText(/Why are you opening these rows/i), "variance review for the 17th");
    await userEvent.click(screen.getByRole("button", { name: "Open the rows" }));

    expect(await screen.findByText(/The rows could not be opened/i)).toBeInTheDocument();
  });
});
