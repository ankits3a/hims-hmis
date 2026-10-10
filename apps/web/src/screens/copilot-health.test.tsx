import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { CopilotHealthScreen } from "./copilot-health";

/** E0.1 done-means 8 — the health page shows a day's totals and names nobody. */
const HEALTH = {
  date: "2026-10-10", asks: 12, askers: 4, notUnderstoodShare: 0.25, acts: 0,
  byOutcome: { answered: 8, notUnderstood: 3, notPermitted: 1, noTool: 0 },
  byRoute: {
    phrasebook: { asks: 9, p50Ms: 40, p95Ms: 120 }, chooser: { asks: 0, p50Ms: null, p95Ms: null },
    model: { asks: 0, p50Ms: null, p95Ms: null }, none: { asks: 3, p50Ms: 20, p95Ms: 30 },
  },
  modelCalls: 0, spendInr: 0, cappedAsks: 0, capInr: 5000, capped: false, halts: [],
};

describe("Copilot health", () => {
  beforeEach(() => {
    setToken("t");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(HEALTH), { status: 200 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the day's totals, routes and timings — and no per-person list", async () => {
    renderWithProviders(<CopilotHealthScreen />);
    expect(await screen.findByTestId("copilot-health-asks")).toHaveTextContent("12");
    expect(screen.getByTestId("copilot-health-askers")).toHaveTextContent("4");
    expect(screen.getByTestId("copilot-health-notUnderstoodShare")).toHaveTextContent("25%");
    expect(screen.getByText("Phrasebook").closest("tr")).toHaveTextContent("940 ms120 ms");
    expect(screen.getByText("Not understood", { selector: "td" }).closest("tr")).toHaveTextContent("3");
    expect(screen.queryByText("Not available yet")).toBeNull(); // zero rows are not listed
    const url = String(vi.mocked(fetch).mock.calls[0]![0]);
    expect(url).toMatch(/\/api\/copilot\/health\?date=\d{4}-\d{2}-\d{2}$/);
  });

  it("E0.5/E0.3: shows AI calls and ₹, says when the cap is reached, and offers only the switches this person may throw", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch({
      "GET /api/auth/me": {
        actor: { type: "user", id: "u-duty" },
        permissions: { hospital: ["copilot.health.read", "copilot.halt.set", "copilot.halt.clear"] },
      },
      "GET /api/copilot/health": {
        ...HEALTH, modelCalls: 41, spendInr: 5012.4, cappedAsks: 3, capped: true,
        halts: [{ scope: "global", haltedAt: "2026-01-01T00:00:00Z", reason: null }],
      },
      "POST /api/copilot/halt": (init?: RequestInit) => { posts.push({ url: "halt", body: JSON.parse(String(init?.body)) }); return {}; },
    });
    renderWithProviders(<CopilotHealthScreen />);
    expect(await screen.findByTestId("copilot-health-capped")).toHaveTextContent("₹5,000");
    expect(screen.getByTestId("copilot-health-modelCalls")).toHaveTextContent("41");
    expect(screen.getByTestId("copilot-health-spend")).toHaveTextContent("₹5,012.40");

    // Global is halted and this person cannot clear it: no Resume button on that row.
    await waitFor(() => { expect(within(screen.getByTestId("copilot-halt-act")).queryByRole("button", { name: "Halt" })).not.toBeNull(); });
    expect(within(screen.getByTestId("copilot-halt-global")).getByText("Halted")).toBeInTheDocument();
    expect(within(screen.getByTestId("copilot-halt-global")).queryByRole("button")).toBeNull();

    fireEvent.click(within(screen.getByTestId("copilot-halt-act")).getByRole("button", { name: "Halt" }));
    await waitFor(() => { expect(posts).toEqual([{ url: "halt", body: { scope: "act" } }]); });
  });
});
