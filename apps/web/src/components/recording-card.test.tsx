import { screen, waitFor, within } from "@testing-library/react";
import { RecordingCard, RecordingPanel } from "./recording-card";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * "RECORDED TODAY" — owner 2026-10-07. The card words the server's integers and adds none of its own:
 * the state is said in a sentence, a desk is shown no doctor's name, and a login the server answers
 * `none` gets no card at all.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
  }));
}
const ME = { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } } };
const C = { opened: 60, consulted: 48, onScreen: 9, onPaper: 39, photographed: 34, typed: 12, issued: 9, issuedLines: 21, toType: 22, notRecorded: 5, stillOpen: 10 };
const BASE = { from: "2026-10-07", to: "2026-10-07", period: "day", anchor: "2026-10-07", days: [] };
const mount = (body: unknown, ui: React.ReactElement): void => {
  mockRoutes({ "GET /api/auth/me": ME, "GET /api/opd/reports/recording": { status: 200, body } });
  setToken("t-1");
  renderWithProviders(ui);
};

describe("recording card", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a desk sees the hospital's count in words, the figures, and no doctor's name or by-doctor link", async () => {
    mount({ ...BASE, scope: "hospital", totals: C, mine: null, departments: [], doctors: null }, <RecordingCard date="2026-10-07" />);
    const card = within(await screen.findByTestId("rec-card"));
    expect(card.getByTestId("rec-lead")).toHaveTextContent("5 of 48 consultations have no record of what was prescribed.");
    expect(card.getByRole("img")).toHaveAccessibleName("43 of 48 consultations on record");
    expect(card.getByTestId("rec-facts")).toHaveTextContent("34 slips photographed");
    expect(card.getByTestId("rec-facts")).toHaveTextContent("22 photographed, waiting to be typed");
    expect(card.queryByText("See by doctor")).not.toBeInTheDocument();
  });

  it("says so calmly when everything consulted is on record, and before anything is consulted", async () => {
    mount({ ...BASE, scope: "hospital", totals: { ...C, notRecorded: 0 }, mine: null, departments: [], doctors: null }, <RecordingCard date="2026-10-07" />);
    expect(await screen.findByTestId("rec-lead")).toHaveTextContent("All 48 consultations today are on record.");
    vi.unstubAllGlobals();
  });

  it("a doctor's card is about their own patients", async () => {
    const mine = { ...C, consulted: 22, issued: 9, onPaper: 13, photographed: 10, notRecorded: 3 };
    mount({ ...BASE, scope: "mine", totals: mine, mine, departments: null, doctors: null }, <RecordingCard date="2026-10-07" />);
    const card = await screen.findByTestId("rec-card");
    expect(card).toHaveAttribute("data-scope", "mine");
    expect(within(card).getByText("Your patients on record")).toBeInTheDocument();
    expect(within(card).getByTestId("rec-lead")).toHaveTextContent("3 of 22 consultations");
  });

  it("draws nothing for a login the server answers `none`", async () => {
    mount({ ...BASE, scope: "none", totals: null, mine: null, departments: null, doctors: null }, <RecordingCard date="2026-10-07" />);
    await waitFor(() => { expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes("/opd/reports/recording"))).toBe(true); });
    expect(screen.queryByTestId("rec-card")).not.toBeInTheDocument();
  });

  it("the owner's panel lists each doctor, the not-recorded figure marked, and a week by day", async () => {
    mount({
      ...BASE, period: "week", from: "2026-10-05", scope: "hospital", totals: C, mine: null,
      days: [{ ...C, date: "2026-10-05" }, { ...C, date: "2026-10-06", notRecorded: 0 }],
      departments: [{ ...C, id: "d1", name: "General Medicine" }],
      doctors: [{ ...C, id: "x", name: "Dr. Chandan Kumar", consulted: 22, notRecorded: 4 }, { ...C, id: "y", name: "Dr. Ritu Kumari", consulted: 9, notRecorded: 0 }],
    }, <RecordingPanel sel={{ period: "week", date: "2026-10-07" }} />);
    const doctors = within(await screen.findByTestId("rec-doctors"));
    const row = doctors.getByText("Dr. Chandan Kumar").closest("tr")!;
    expect(row.lastElementChild).toHaveTextContent("4");
    expect(row.lastElementChild).toHaveClass("bad");
    expect(doctors.getByText("Dr. Ritu Kumari").closest("tr")!.lastElementChild).toHaveClass("zero");
    expect(within(screen.getByTestId("rec-days")).getByText("05-10-2026")).toBeInTheDocument();
    expect(screen.getByTestId("rec-departments")).toHaveTextContent("General Medicine");
  });
});
