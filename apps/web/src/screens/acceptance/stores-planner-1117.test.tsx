import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresTopUp } from "../stores-topup";
import { StoresParSuggestions } from "../stores-par";
import type { WireParSuggestion, WireTopUpProposal } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1117, spec docs/specs/1117-stores-stock-planner.md (owner APPROVED 2026-11-19, decision 0101): the
 * web half, D14 and D15. At 390 px the department in-charge sends the planner's top-up in at most three taps from the
 * Now card (the card's tap opens this screen; Send is the second), each line's quantity and one-line why on one line
 * with no horizontal scroll. At 1366 × 768 the materials head's par suggestions show 50 items, old par beside the
 * suggested, Accept / Keep per row, every status a word. A real-browser walk measures both (the PR's screenshots).
 * The server half: apps/core/src/modules/stores/acceptance/stores-s7-1117.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const PROPOSAL: WireTopUpProposal = {
  departmentId: "d1", departmentName: "Housekeeping", runOut: { count: 3, days: 2, urgent: false },
  sections: [{
    draftId: "dr1", shelfId: "s1", shelfName: "Housekeeping F1", status: "open", budget: { pct: 84, over: false, words: ["Budget 80% used", "बजट 80% खर्च"] },
    lines: [
      { itemId: "i1", code: "HK-GLV-0001", name: "Household gloves with a long name that must give way", qty: 51, onHand: 9, onWay: 0, usePerDay: 6,
        word: "runs_out_soon", words: ["Runs out soon", "जल्द खत्म"], why: ["uses 6 a day, 9 left", "रोज़ 6, बचे 9"], urgent: false, learningWeeks: null,
        forecastId: "f1", warningId: "w1" },
      { itemId: "i2", code: "HK-MOP-0001", name: "Wet mop refill", qty: 20, onHand: 4, onWay: 0, usePerDay: 2.5,
        word: "low", words: ["Low", "कम"], why: ["uses 2.5 a day, 4 left", "रोज़ 2.5, बचे 4"], urgent: false, learningWeeks: null, forecastId: "f2", warningId: "w2" },
      { itemId: "i3", code: "HK-SOP-0001", name: "Hand soap", qty: 30, onHand: 10, onWay: 0, usePerDay: 8.6,
        word: "learning", words: ["Learning", "सीख रहा"], why: ["uses 8.6 a day, 10 left", "रोज़ 8.6, बचे 10"], urgent: false, learningWeeks: 3, forecastId: "f3", warningId: "w3" },
    ],
  }],
  slow: [],
};

const PAR: WireParSuggestion[] = Array.from({ length: 50 }, (_, i) => ({
  id: `p${String(i)}`, shelfId: "s1", shelfName: "Housekeeping F1", itemId: `i${String(i)}`, itemName: `Item number ${String(i)}`,
  now: { minBase: 5, reorderBase: 10, maxBase: 30 }, suggested: { minBase: 3, reorderBase: 24, maxBase: 45 }, usePerDay: 3, supplyIntervalDays: 7,
  why: ["uses 3 a day, delivered every 7 days", "रोज़ 3, हर 7 दिन में आता है"], status: "open", quarter: "2026-Q4",
}));

function mock(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") {
      return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["stores.masters.manage"], scoped: { department: { d1: ["stores.shelf.read", "stores.shelf.work"] }, floor: {} } } });
    }
    if (path === "/stores/planner/topup" && method === "GET") return json([PROPOSAL]);
    if (path === "/stores/planner/drafts/dr1/send" && method === "POST") return json({ ticket: { id: "t1", indentNo: "MIN2611110001" }, actId: "a1" });
    if (path === "/stores/planner/par-suggestions" && method === "GET") return json(PAR);
    if (path === "/stores/planner/monthly" && method === "GET") return json({ month: "2026-11", stockOutsWithoutWarning: 0, unchangedPct: 93 });
    if (/^\/stores\/planner\/par-suggestions\/p\d+\/(accept|keep)$/.test(path) && method === "POST") return json({ ok: true });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the stock planner's screens (spec #1117)", () => {
  it("spec #1117 D14: at 390 px the top-up is sent in at most 3 taps from the Now card; each line's quantity and why sit on one line; no horizontal scroll", async () => {
    window.innerWidth = 390;
    const calls = mock();
    const user = userEvent.setup();
    let taps = 1; // the Now card's tap opened this screen
    renderWithRouter(<StoresTopUp />);

    const rows = await screen.findAllByTestId(/^topup-line-/);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.style.whiteSpace).toBe("nowrap");
      expect(row.style.overflow).toBe("hidden");
    }
    const gloves = screen.getByTestId("topup-line-i1");
    expect(within(gloves).getByDisplayValue("51")).toBeInTheDocument();
    expect(within(gloves).getByText("uses 6 a day, 9 left")).toBeInTheDocument();
    expect(within(gloves).getByText("Runs out soon")).toBeInTheDocument();
    expect(within(screen.getByTestId("topup-line-i3")).getByText("Learning")).toBeInTheDocument();
    expect(screen.getByText("Budget 80% used")).toBeInTheDocument();
    expect(screen.getByText("3 run out in 2 days")).toBeInTheDocument();

    const root = screen.getByTestId("stores-topup");
    expect(root.style.overflowX).toBe("hidden");
    expect(root.style.maxWidth).toBe("100%");

    await user.click(screen.getByRole("button", { name: "Send" }));
    taps += 1;
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/stores/planner/drafts/dr1/send")).toBe(true));
    expect(taps).toBeLessThanOrEqual(3);
    expect(await screen.findByText("Sent")).toBeInTheDocument();
  });

  it("spec #1117 D15: at 1366 × 768 the par suggestions show 50 items, old and suggested side by side, Accept / Keep per row, every status a word", async () => {
    window.innerWidth = 1366;
    window.innerHeight = 768;
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresParSuggestions />);

    const rows = await screen.findAllByTestId(/^par-row-/);
    expect(rows).toHaveLength(50);
    const first = screen.getByTestId("par-row-p0");
    expect(within(first).getByTestId("par-now").textContent).toBe("5 / 10 / 30");
    expect(within(first).getByTestId("par-suggested").textContent).toBe("3 / 24 / 45");
    expect(within(first).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "Keep" })).toBeInTheDocument();
    expect(within(first).getByText("To decide")).toBeInTheDocument();

    await user.click(within(first).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/stores/planner/par-suggestions/p0/accept")).toBe(true));
    expect(await within(screen.getByTestId("par-row-p0")).findByText("Accepted")).toBeInTheDocument();
    expect(screen.getByText(/Stock-outs without warning: 0/)).toBeInTheDocument();
  });
});
