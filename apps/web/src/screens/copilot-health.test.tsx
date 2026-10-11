import { screen } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { CopilotHealthScreen } from "./copilot-health";

/** E0.1 done-means 8 — the health page shows a day's totals and names nobody. */
const HEALTH = {
  date: "2026-10-10", asks: 12, askers: 4, notUnderstoodShare: 0.25, acts: 0,
  byOutcome: { answered: 8, notUnderstood: 3, notPermitted: 1, noTool: 0 },
  byRoute: {
    phrasebook: { asks: 9, p50Ms: 40, p95Ms: 120 }, chooser: { asks: 0, p50Ms: null, p95Ms: null },
    model: { asks: 0, p50Ms: null, p95Ms: null }, none: { asks: 3, p50Ms: 20, p95Ms: 30 },
  },
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
});
