import { screen } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { CounterDayStrip } from "./counter-day-strip";
import type { WireCounterSummary } from "../lib/pharmacy-api";

const DAY: WireCounterSummary = {
  day: "2026-08-17", handedOver: 42, medianMinutes: { queueToHandover: 11, claimToHandover: 6 }, billedPaise: 1234500,
  open: { queued: 2, claimed: 1, verified: 1, picked: 0, billed: 1 },
  declinedLines: 3, declinedTop: [{ reason: "out of stock", lines: 2 }],
  substitutions: 4, cancelled: 1, refundedAfterBilling: 1, returns: 2, partlyCheckedLines: 0, scheduledHandovers: 7,
};

/** PHARMACY P7 — the strip says the day in one line, and nothing when the read fails. */
describe("CounterDayStrip (P7)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("summarises the day", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(DAY), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderWithProviders(<CounterDayStrip />);
    const strip = await screen.findByTestId("counter-day-strip");
    expect(strip).toHaveTextContent("handed over 42 · median wait 11 min · open 5");
    expect(strip).toHaveTextContent("declined 3 · mostly: out of stock · returns 2 · refunds 1");
    expect(strip).not.toHaveTextContent("partly checked");
    expect(strip).toHaveTextContent("H1 7");
  });

  it("shows nothing when the summary cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const { container } = renderWithProviders(<CounterDayStrip />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("[data-testid=counter-day-strip]")).toBeNull();
  });
});
