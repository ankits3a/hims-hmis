import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyLeakage } from "./pharmacy-leakage";
import type { WireLeakageReport } from "../lib/pharmacy-api";

const REPORT: WireLeakageReport = {
  day: "2026-08-17", store: { code: "PHARM-OPD", name: "OPD pharmacy" },
  dispensed: { lines: 2, units: 30 },
  mismatches: [{ dispenseId: "d2", dispenseNo: "P2608170002", itemCode: "CROC500", batchNo: "CR-1", issued: 10, returned: 0, billed: 10, credited: 3, unbilledUnits: 3, unbilledPaise: 3600 }],
  otherConsumption: [{ itemCode: "CROC500", batchNo: "CR-1", units: 4, refType: "ward_emergency", refId: "slip-7", actorId: "ph.mehta", occurredAt: "2026-08-17T07:40:00.000Z" }],
  counted: { counts: 1, varianceUnits: -2, variancePaise: -1000, lines: [{ countId: "c1", itemCode: "CROC500", batchNo: "CR-1", varianceQty: -2, variancePaise: -1000 }] },
  summary: { unbilledUnits: 3, unbilledPaise: 3600, otherUnits: 4, countVarianceUnits: -2, countVariancePaise: -1000 },
};
const QUIET: WireLeakageReport = {
  ...REPORT, day: "2026-08-18", dispensed: { lines: 0, units: 0 }, mismatches: [], otherConsumption: [],
  counted: { counts: 0, varianceUnits: 0, variancePaise: 0, lines: [] },
  summary: { unbilledUnits: 0, unbilledPaise: 0, otherUnits: 0, countVarianceUnits: 0, countVariancePaise: 0 },
};

/** PHARMACY P12 — the day's triangle, as the billing supervisor reads it. */
describe("PharmacyLeakage (P12)", () => {
  const asked: string[] = [];
  beforeEach(() => {
    setToken("t");
    asked.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      asked.push(raw);
      const body = raw.includes("day=2026-08-17") ? REPORT : QUIET;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the unpaid stock, the consumption with no dispense, and the count, for the chosen day", async () => {
    renderWithProviders(<PharmacyLeakage />);
    fireEvent.change(await screen.findByLabelText("Day"), { target: { value: "2026-08-17" } });
    expect(await screen.findByTestId("leak-P2608170002")).toHaveTextContent("P2608170002CROC500CR-11001033₹36.00");
    expect(asked.some((u) => u.includes("/api/pharmacy/leakage?day=2026-08-17"))).toBe(true);
    expect(screen.getByTestId("leakage-summary")).toHaveTextContent("Unbilled 3 units");
    expect(screen.getByTestId("leakage-summary")).toHaveTextContent("consumed outside a dispense 4 units · counted -2 units");
    expect(screen.getByTestId("leak-other")).toHaveTextContent("13:10 · CROC500 · Batch CR-1 · 4 Units · Reference ward_emergency slip-7 · Posted by ph.mehta");
    expect(screen.getByTestId("leak-counted")).toHaveTextContent("CROC500 · Batch CR-1 · Variance -2");
  });

  it("says a quiet day is quiet", async () => {
    renderWithProviders(<PharmacyLeakage />);
    fireEvent.change(await screen.findByLabelText("Day"), { target: { value: "2026-08-18" } });
    await waitFor(() => expect(screen.getByText("Every dispensed line's stock and bill agree.")).toBeInTheDocument());
    expect(screen.getByText("Nothing left the shelf except through dispenses.")).toBeInTheDocument();
    expect(screen.getByText("No count was taken this day.")).toBeInTheDocument();
    expect(screen.queryByTestId("leak-other")).toBeNull();
  });
});
