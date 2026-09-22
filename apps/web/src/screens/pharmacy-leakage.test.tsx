import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyLeakage } from "./pharmacy-leakage";
import type { WireLeakageReport } from "../lib/pharmacy-api";

const REPORT: WireLeakageReport = {
  day: "2026-08-17", store: { code: "PHARM-OPD", name: "OPD pharmacy" },
  dispensed: { lines: 2, units: 30 },
  mismatches: [{ source: "dispense", dispenseId: "d2", dispenseNo: "P2608170002", saleId: null, invoiceNo: null, itemCode: "CROC500", batchNo: "CR-1", issued: 10, returned: 0, billed: 10, credited: 3, unbilledUnits: 3, unbilledPaise: 3600 }],
  otherConsumption: [{ itemCode: "CROC500", batchNo: "CR-1", units: 4, refType: "ward_emergency", refId: "slip-7", actorId: "01M2PBFFV4ZJBY236NN0N7Z5JQ", actorName: "Meena Joshi", occurredAt: "2026-08-17T07:40:00.000Z" }],
  counted: { counts: 1, varianceUnits: -2, variancePaise: -1000, lines: [{ countId: "c1", itemCode: "CROC500", batchNo: "CR-1", varianceQty: -2, variancePaise: -1000 }] },
  summary: { unbilledUnits: 3, unbilledPaise: 3600, otherUnits: 4, countVarianceUnits: -2, countVariancePaise: -1000 },
};
const QUIET: WireLeakageReport = {
  ...REPORT, day: "2026-08-18", dispensed: { lines: 0, units: 0 }, mismatches: [], otherConsumption: [],
  counted: { counts: 0, varianceUnits: 0, variancePaise: 0, lines: [] },
  summary: { unbilledUnits: 0, unbilledPaise: 0, otherUnits: 0, countVarianceUnits: 0, countVariancePaise: 0 },
};

const RETAIL: WireLeakageReport = {
  ...REPORT, store: { code: "PHARM-RETAIL", name: "Walk-in retail pharmacy" }, otherConsumption: [],
  mismatches: [{
    source: "walk_in", dispenseId: null, dispenseNo: null, saleId: "s9", invoiceNo: "INV-26-000123", itemCode: "CROC500", batchNo: "R-1",
    issued: 10, returned: 0, billed: 10, credited: 3, unbilledUnits: 3, unbilledPaise: 3600,
  }],
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
      const body = raw.includes("store=PHARM-RETAIL") ? RETAIL : raw.includes("day=2026-08-17") ? REPORT : QUIET;
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
    expect(screen.getByTestId("leakage-summary")).toHaveTextContent("consumed outside a dispense or sale 4 units · counted -2 units");
    expect(screen.getByTestId("leak-other")).toHaveTextContent("13:10 · CROC500 · Batch CR-1 · 4 units · Reference ward_emergency slip-7 · Posted by Meena Joshi");
    expect(screen.getByTestId("leak-other")).not.toHaveTextContent("01M2PBFFV4ZJBY236NN0N7Z5JQ");
    expect(screen.getByTestId("leak-counted")).toHaveTextContent("CROC500 · Batch CR-1 · Variance -2");
  });

  it("says a quiet day is quiet", async () => {
    renderWithProviders(<PharmacyLeakage />);
    fireEvent.change(await screen.findByLabelText("Day"), { target: { value: "2026-08-18" } });
    await waitFor(() => expect(screen.getByText("Every dispensed or sold line's stock and bill agree.")).toBeInTheDocument());
    expect(screen.getByText("Nothing left the shelf except through dispenses and sales.")).toBeInTheDocument();
    expect(screen.getByText("No count was taken this day.")).toBeInTheDocument();
    expect(screen.queryByTestId("leak-other")).toBeNull();
  });

  it("reads the walk-in counter's store, and names a walk-in line by its bill (P19b)", async () => {
    renderWithProviders(<PharmacyLeakage />);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Counter" }), "PHARM-RETAIL");
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-08-17" } });
    expect(await screen.findByTestId("leak-INV-26-000123")).toHaveTextContent("Walk-in sale INV-26-000123CROC500R-11001033₹36.00");
    expect(asked.some((u) => u.includes("store=PHARM-RETAIL") && u.includes("day=2026-08-17"))).toBe(true);
  });
});
