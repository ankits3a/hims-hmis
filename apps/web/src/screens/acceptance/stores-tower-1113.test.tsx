import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresTower } from "../stores-tower";
import type { StoresTowerLane, WireTowerCard, WireTowerSummary, WireTowerView } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1113, spec docs/specs/1113-stores-control-tower.md (owner APPROVED 2026-11-18): the web half,
 * D15 and D17. The tower at 1920 × 1080 renders six lanes and the red-card strip and fits 1366 × 768 with no vertical
 * scroll (jsdom has no layout: the screen is one viewport-high box that hides overflow, and a lane shows only the
 * cards that fit and says how many more); its Stuck count equals the view's. At 390 px the owner's one line reads
 * "3 stuck · 4B, OT" with no horizontal scroll. A real-browser walk measures both (PR #1113's screenshots). The
 * server half: apps/core/src/modules/stores/acceptance/stores-s3-1113.test.ts.
 */
const card = (id: string, lane: StoresTowerLane, minutes: number): WireTowerCard => ({
  id, indentNo: `MIN26111900${id.padStart(2, "0")}`, lane, priority: "routine",
  department: { id: "d1", code: "HSK", name: "Housekeeping" }, floor: { id: "f1", code: "F1", name: "First floor" },
  holder: lane === "in_transit" ? { id: "u7", name: "Ramesh" } : null, minutes,
  clock: lane === "stuck" ? { kind: "approval", minutes } : null,
});

const many = (lane: StoresTowerLane, n: number, from: number): WireTowerCard[] => Array.from({ length: n }, (_, i) => card(String(from + i), lane, 5 + i));

const VIEW: WireTowerView = {
  at: "2026-11-19T06:30:00.000Z",
  lanes: {
    requested: many("requested", 3, 1), approved: many("approved", 2, 10), picking: many("picking", 1, 20),
    in_transit: many("in_transit", 2, 30), delivered: many("delivered", 30, 40), stuck: many("stuck", 3, 80).map((c) => ({ ...c, minutes: 61 + Number(c.id) })),
  },
  redCards: [
    { id: "r1", kind: "pass", what: "MGP2611180003", where: "Sharma Electricals", since: "2026-11-18T18:30:00.000Z", minutes: 720, clock: null, indentId: null, shelfId: null, passId: "p1" },
    { id: "r2", kind: "stuck", what: "MIN2611190080", where: "Housekeeping", since: "2026-11-19T05:20:00.000Z", minutes: 70, clock: "approval", indentId: "80", shelfId: null, passId: null },
  ],
  floors: [{ id: "f1", code: "F1", name: "First floor", departments: [{ id: "d1", code: "HSK", name: "Housekeeping", status: "out" }, { id: "d2", code: "OT", name: "Operation theatre", status: "ok" }] }],
  numbers: { ticketsToday: 41, medianApprovalMin: 22, medianDeliverMin: 95, doubleSignedPct: 100, openShorts: 1 },
};
const SUMMARY: WireTowerSummary = { stuck: 3, places: ["4B", "OT"] };

function mock(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0];
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["stores.tower.read"], scoped: { department: {}, floor: {} } } });
    if (path === "/stores/tower") return json(VIEW);
    if (path === "/stores/tower/summary") return json(SUMMARY);
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the Stores control tower (spec #1113)", () => {
  it("spec #1113 D15: at 1920 × 1080 the tower renders six lanes and the red-card strip with no vertical scroll at 1366 × 768, and its Stuck count equals towerView's", async () => {
    for (const [w, h] of [[1920, 1080], [1366, 768]] as const) {
      window.innerWidth = w;
      window.innerHeight = h;
      mock();
      const { unmount } = renderWithRouter(<StoresTower />);
      const root = await screen.findByTestId("stores-tower");
      expect(root.style.height).toBe("100vh");
      expect(root.style.overflow).toBe("hidden");
      const lanes = await screen.findAllByTestId(/^tower-lane-/);
      expect(lanes.map((l) => l.dataset.testid)).toEqual([
        "tower-lane-requested", "tower-lane-approved", "tower-lane-picking", "tower-lane-in_transit", "tower-lane-delivered", "tower-lane-stuck",
      ]);
      expect(within(screen.getByTestId("tower-lane-requested")).getByText("Requested")).toBeInTheDocument();
      expect(within(screen.getByTestId("tower-lane-stuck")).getByText("Stuck")).toBeInTheDocument();
      // The Stuck count is the view's.
      expect(screen.getByTestId("tower-count-stuck")).toHaveTextContent(String(VIEW.lanes.stuck.length));
      // A full lane shows what fits and says how many more; the page never grows a scroll.
      const delivered = screen.getByTestId("tower-lane-delivered");
      const shown = within(delivered).queryAllByTestId(/^tower-card-/).length;
      expect(shown).toBeLessThan(30);
      expect(within(delivered).getByText(`+${String(30 - shown)} more`)).toBeInTheDocument();
      // The red-card strip: at most 8, each a word, never colour alone.
      const strip = screen.getByTestId("tower-redcards");
      expect(within(strip).getAllByTestId(/^tower-red-/).length).toBe(2);
      expect(within(strip).getByText("Pass overdue")).toBeInTheDocument();
      // The floor map says a word for each department.
      expect(within(screen.getByTestId("tower-floors")).getByText("Out")).toBeInTheDocument();
      expect(within(screen.getByTestId("tower-floors")).getByText("OK")).toBeInTheDocument();
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it("spec #1113 D17: at 390 px the owner's summary reads '3 stuck · 4B, OT' on one line with no horizontal scroll, and See stuck opens the Stuck list", async () => {
    window.innerWidth = 390;
    window.innerHeight = 844;
    mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresTower />);
    const line = await screen.findByTestId("tower-summary-line");
    expect(line).toHaveTextContent("3 stuck · 4B, OT");
    expect(line.style.whiteSpace).toBe("nowrap");
    const root = screen.getByTestId("stores-tower-summary");
    expect(root.style.overflowX).toBe("hidden");
    expect(root.style.maxWidth).toBe("100%");
    await user.click(screen.getByRole("button", { name: "See stuck" }));
    const list = await screen.findByTestId("tower-stuck-list");
    expect(within(list).getAllByTestId(/^tower-card-/).length).toBe(VIEW.lanes.stuck.length);
  });
});
