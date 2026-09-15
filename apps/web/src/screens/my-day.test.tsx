import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MyDay } from "./my-day";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { todayIst } from "../lib/opd-api";

/**
 * PLAN 07c T2/T3/T5 — MY DAY: the screen, the paper and the file are ONE model (DD5).
 *
 * The assertions that matter here are not about layout. They are: the day says whether it is
 * finished; there is exactly ONE printable node, because `.print-doc` is `position: fixed` at the
 * origin and two of them OVERPRINT rather than making two pages (the 07a/07b close named this); and
 * the export leaves through the one door with the server's own filename on it.
 */
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const h = handlers[key];
      if (h === undefined) return new Response("{}", { status: 404 });
      return new Response(typeof h.body === "string" ? h.body : JSON.stringify(h.body), {
        status: h.status,
        headers: { "Content-Type": "application/json", ...h.headers },
      });
    }),
  );
}

const SECTION = {
  key: "opd.myVisits",
  titleKey: "report.opd.myVisits",
  columnKeys: ["report.col.time", "report.col.visitNo", "report.col.uhid", "report.col.patient", "report.col.type", "report.col.status"],
  rows: [["09:30", "V2608290011", "HMS0000001234", "Asha Devi", "new", "completed"]],
  totals: ["", "", "", "", "", "1"],
};

/**
 * The signed-in fixture. `hospital` is the permission list, and after the 2026-09-14 horizon ruling
 * it decides which PERIODS this screen offers: holding neither `staff.reports.history.*` string is
 * the three-month floor.
 */
const meHolding = (...hospital: string[]) => ({
  status: 200,
  body: { actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } },
});
const ME = meHolding();

const EMPTY_BRIEF = { period: "week", from: "2026-08-23", to: "2026-08-29", clauses: [], totals: {}, daysWithActivity: 0 };

function mount(
  report: { date: string; provisional: boolean; sections: unknown[] },
  extra: Record<string, Reply> = {},
  me: Reply = ME,
): void {
  mockRoutes({
    "GET /api/auth/me": me,
    "GET /api/me/report": { status: 200, body: report },
    "GET /api/me/brief": { status: 200, body: EMPTY_BRIEF },
    ...extra,
  });
  setToken("t-1");
  renderWithProviders(<MyDay />);
}

/** jsdom has no object-URL plumbing; the download hook needs both halves to exist. */
function stubObjectUrls(): { created: Blob[]; revoked: string[] } {
  const created: Blob[] = [];
  const revoked: string[] = [];
  vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, {
    createObjectURL: (b: Blob) => { created.push(b); return "blob:my-day"; },
    revokeObjectURL: (u: string) => { revoked.push(u); },
  }) as unknown as typeof URL);
  return { created, revoked };
}

/**
 * ═══ THE CLOCK IS FROZEN, AND IT IS A FIX RATHER THAN A CONVENIENCE ═══
 *
 * `MyDay` takes its date from the REAL clock — `useState(todayIst())`, and `todayIst` is arithmetic
 * over `new Date()`. Every fixture in this file is dated 2026-08-29 and two assertions read that
 * date back out of the request URL. **So this suite passed for eighteen and a half hours a day and
 * failed for five and a half**: after 18:30 UTC the IST calendar date rolls over, the screen
 * correctly asks for the NEXT day, and the assertions for `date=2026-08-29` fail. Four consecutive
 * commits went CI-red that way on 2026-08-29 — none of which touched `apps/web` — and every commit
 * pushed in that window would have.
 *
 * **The SCREEN is right and the TEST froze a day.** At 00:50 IST the user's day IS the new one, and
 * a "my day" screen that showed yesterday because a test preferred it would be the real defect. So
 * the clock is driven here, which is Plan 07c's own recorded resolution of the same class of flake
 * ("fixed by driving the clock in the test, not by a seam in the component") and the shape
 * `opd-appointments.test.tsx` and `alerts-bell.test.tsx` already use.
 *
 * Midday IST, deliberately: far from both boundaries, so neither a UTC nor an IST rollover can
 * reach it.
 */
const NOW_ISO = "2026-08-29T06:30:00.000Z"; // 12:00 IST on 2026-08-29
const FIXTURE_DAY = "2026-08-29";

beforeEach(() => { vi.setSystemTime(new Date(NOW_ISO)); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("07c T2/T3/T5 — my day", () => {
  /**
   * THE GUARD ON THE SUITE'S OWN PREMISE. It asserts the frozen instant against the SAME function
   * the screen calls, so a future edit to `NOW_ISO` fails HERE, in one line that says why, rather
   * than in two URL assertions eighty lines apart whose message is about a missing string.
   */
  it("the frozen clock is the day these fixtures are dated", () => {
    expect(todayIst(new Date(NOW_ISO))).toBe(FIXTURE_DAY);
    expect(todayIst()).toBe(FIXTURE_DAY);
  });

  it("renders the server's sections, with the column keys translated and the totals row kept", async () => {
    mount({ date: "2026-08-29", provisional: false, sections: [SECTION] });

    await waitFor(() => { expect(screen.getByText("Visits I opened")).toBeInTheDocument(); });
    expect(screen.getByRole("columnheader", { name: "Visit no" })).toBeInTheDocument();
    expect(screen.getByText("Asha Devi")).toBeInTheDocument();
    // The totals row is the server's arithmetic, rendered rather than recomputed.
    expect(screen.getByRole("table").querySelector("tfoot")?.textContent).toContain("1");
  });

  /**
   * T2 A4 / E-5 — a report pulled at 14:00 and one pulled at 21:00 are different documents with the
   * same title and the same date, and only one of them is the close.
   */
  it("A4: a day that is still happening is marked PROVISIONAL, on the screen and on the paper", async () => {
    mount({ date: "2026-08-29", provisional: true, sections: [SECTION] });

    await waitFor(() => { expect(screen.getByText("Provisional")).toBeInTheDocument(); });
    // …and inside the printable node, because the paper is what gets filed.
    expect(document.querySelector(".print-doc")?.textContent).toContain("This day is not closed");
  });

  it("A4b: a finished day is NOT marked provisional — the flag is the server's, not a decoration", async () => {
    mount({ date: "2026-08-01", provisional: false, sections: [SECTION] });

    await waitFor(() => { expect(screen.getByText("Visits I opened")).toBeInTheDocument(); });
    expect(screen.queryByText("Provisional")).not.toBeInTheDocument();
    expect(document.querySelector(".print-doc")?.textContent).not.toContain("This day is not closed");
  });

  /**
   * THE PRINT CONSTRAINT, ASSERTED RATHER THAN COMMENTED. `.print-doc` is `position: fixed` at the
   * origin: a second printable node does not make a second page, it prints on top of the first.
   */
  it("T5: there is exactly ONE printable node, however many sections the report has", async () => {
    mount({ date: "2026-08-29", provisional: false, sections: [SECTION, { ...SECTION, key: "billing.myCollections", titleKey: "report.opd.myVisits" }] });

    await waitFor(() => { expect(screen.getAllByRole("table")).toHaveLength(2); });
    expect(document.querySelectorAll(".print-doc")).toHaveLength(1);
    // …and the signature line is part of that document, not chrome around it.
    expect(document.querySelector(".print-doc")?.textContent).toContain("Received by");
  });

  it("E-4: a day with nothing on it is an answer, not an error", async () => {
    mount({ date: "2020-01-01", provisional: false, sections: [] });
    expect(await screen.findByText(/Nothing was recorded against your account/i)).toBeInTheDocument();
  });

  /**
   * T3 — THE EXPORT. It travels through `apiDownload` in `lib/api.ts` (the one door
   * `caddyfile-parity.test.ts` pins), asks for `/me/report.csv` — its OWN path, so the audit event
   * the server appends means "a file left the building" — and wears the filename the SERVER chose.
   */
  it("T3: the export requests the CSV route for the shown date and saves it under the server's filename", async () => {
    const urls = stubObjectUrls();
    const clicked: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { clicked.push(this.download); };

    try {
      mount({ date: "2026-08-29", provisional: true, sections: [SECTION] }, {
        "GET /api/me/report.csv": {
          status: 200,
          body: "﻿report.date,2026-08-29\r\n",
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="my-day-2026-08-29.csv"' },
        },
      });
      await waitFor(() => { expect(screen.getByText("Visits I opened")).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));

      await waitFor(() => { expect(clicked).toEqual(["my-day-2026-08-29.csv"]); });
      const asked = vi.mocked(fetch).mock.calls.map(([i]) => String(i));
      expect(asked).toContain("/api/me/report.csv?date=2026-08-29");
      expect(urls.created).toHaveLength(1);
      // A blob that is never revoked is a leak that grows with every export of a long day.
      expect(urls.revoked).toEqual(["blob:my-day"]);
      // The anchor is cleaned up: a download link left in the tree is a stray control at a counter.
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it("T3: an export that fails says so instead of appearing to have worked", async () => {
    stubObjectUrls();
    mount({ date: "2026-08-29", provisional: false, sections: [SECTION] }, {
      "GET /api/me/report.csv": { status: 500, body: { message: "boom" } },
    });
    await waitFor(() => { expect(screen.getByText("Visits I opened")).toBeInTheDocument(); });

    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText(/The export could not be prepared/i)).toBeInTheDocument();
  });

  /**
   * PLAN 07c T8 / DD12 — THE BRIEF RENDERS KEYS, AND COMPOSES NO PROSE OF ITS OWN.
   *
   * Every clause arrives from the server as an i18n key plus pre-formatted values. That is what
   * makes DD12's promise enforceable rather than aspirational: there is no branch in this component
   * that could invent a comparison, because a comparison the server could not make honestly simply
   * does not arrive.
   */
  it("T8: the server's clauses become sentences, with the server's own figures in them", async () => {
    mount({ date: "2026-08-29", provisional: true, sections: [SECTION] }, {
      "GET /api/me/brief": {
        status: 200,
        body: {
          period: "week", from: "2026-08-23", to: "2026-08-29", daysWithActivity: 5,
          totals: { "opd.visitsOpened": 61 },
          clauses: [
            { key: "brief.visits.compared", values: { total: "61", median: "48" } },
            { key: "brief.collected.plain", values: { total: "₹1,20,450.00" } },
          ],
        },
      },
    });

    expect(await screen.findByText("61 visits opened, against a median of 48.")).toBeInTheDocument();
    expect(screen.getByText("₹1,20,450.00 collected.")).toBeInTheDocument();
    expect(screen.getByText("2026-08-23 to 2026-08-29")).toBeInTheDocument();
  });

  /** DD8 — a thin history produces a SHORT brief, and the screen says why rather than spinning. */
  it("T8/A4: a brief with no honest clause to make says so, in a sentence", async () => {
    mount({ date: "2026-08-29", provisional: true, sections: [SECTION] });
    expect(await screen.findByText(/a comparison needs a fortnight of history/i)).toBeInTheDocument();
  });

  it("T8: switching period asks the server for that period — the client computes nothing", async () => {
    // A YEAR-TIER CALLER, because six months is past the floor. Before the horizon this fixture held
    // nothing and still got every period, which is the capability the ruling narrowed.
    mount({ date: "2026-08-29", provisional: true, sections: [SECTION] }, {}, meHolding("staff.reports.history.year"));
    await waitFor(() => { expect(screen.getByRole("button", { name: "6 months" })).toBeInTheDocument(); });

    await userEvent.click(screen.getByRole("button", { name: "6 months" }));

    await waitFor(() => {
      const asked = vi.mocked(fetch).mock.calls.map(([i]) => String(i));
      expect(asked).toContain("/api/me/brief?period=half&date=2026-08-29");
    });
    expect(screen.getByRole("button", { name: "6 months" })).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * ═══ STAFF-REPORTS T0 — THE HISTORY HORIZON, owner ruling 2026-09-14 ═══
   *
   * THE ONE PLACE IN THIS PHASE WHERE AN EXISTING CAPABILITY NARROWS. This picker offered all five
   * periods to every signed-in user, so a front-desk clerk could pull six months of their own day.
   * The floor is now three months and it is the ABSENCE of a grant.
   *
   * The picker is CONVENIENCE and not the control — `kernel/desk/horizon.ts` refuses an over-horizon
   * window whatever the screen renders, because the route is reachable without the screen. What this
   * pair asserts is that the screen does not offer a button whose only possible answer is a refusal.
   */
  it("T0: a clerk holding neither history string is offered the floor and no further", async () => {
    mount({ date: "2026-08-29", provisional: true, sections: [SECTION] });
    await waitFor(() => { expect(screen.getByRole("button", { name: "Day" })).toBeInTheDocument(); });
    for (const within of ["Day", "Week", "Month", "3 months"]) {
      expect(screen.getByRole("button", { name: within })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "6 months" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1 year" })).not.toBeInTheDocument();
  });

  /**
   * BOTH STRINGS, because they are a lattice and `.full` implies `.year`. Asserting only the one
   * that happens to be granted in a fixture is how a tier ships working for the role it was written
   * against and refusing for the role above it.
   */
  it.each(["staff.reports.history.year", "staff.reports.history.full"])(
    "T0: %s opens the two long windows",
    async (held) => {
      mount({ date: "2026-08-29", provisional: true, sections: [SECTION] }, {}, meHolding(held));
      await waitFor(() => { expect(screen.getByRole("button", { name: "1 year" })).toBeInTheDocument(); });
      expect(screen.getByRole("button", { name: "6 months" })).toBeInTheDocument();
    },
  );
});
