import { screen } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { BmwReports } from "./bmw-reports";
import type { BmwFormIvReport, BmwMonthlyReport, BmwReportLine } from "@hmis/contracts";

/** E1.7 BIO-MEDICAL WASTE (issue #724) — the two report tables render the server's figures; cytotoxic sits inside yellow. */
const line = (l: BmwReportLine["line"], g: number): BmwReportLine => ({
  line: l, subsetOf: l === "yellow_cytotoxic" ? "yellow" : null, generatedBags: 2, generatedGrams: g, handedOverBags: 1, handedOverGrams: g, treatedBags: 1, treatedGrams: g,
});
const lines = ["yellow", "yellow_cytotoxic", "red", "white_translucent", "blue"] as const;

describe("BmwReports (E1.7)", () => {
  beforeEach(() => {
    setToken("t");
    const monthly: BmwMonthlyReport = {
      month: "2026-03", lines: lines.map((l, i) => line(l, 1000 * (i + 1))),
      totals: { generatedBags: 8, generatedGrams: 13_000, handedOverBags: 4, handedOverGrams: 13_000, treatedBags: 4, treatedGrams: 13_000 },
      unweighedBags: 1, openDisputes: 0,
    };
    const grams = Object.fromEntries(lines.map((l) => [l, 500])) as Record<BmwReportLine["line"], number>;
    const form: BmwFormIvReport = {
      year: "2026", months: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, grams })),
      annualGrams: Object.fromEntries(lines.map((l) => [l, 6000])) as Record<BmwReportLine["line"], number>, annualTotalGrams: 24_000, averageGramsPerDay: 66, days: 365,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = raw.includes("/reports/monthly") ? monthly : raw.includes("/reports/form-iv") ? form
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["bmw.manage"], scoped: { department: {}, floor: {} } } } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("monthly and Form IV tables, totals and the CSV buttons", async () => {
    renderWithProviders(<BmwReports />);
    expect(await screen.findByTestId("monthly-yellow")).toHaveTextContent("Yellow2");
    expect(screen.getByTestId("monthly-yellow_cytotoxic")).toHaveClass("sub");
    expect(screen.getByTestId("monthly-total")).toHaveTextContent("13.0");
    expect(await screen.findByTestId("form-iv-total")).toHaveTextContent("24.0");
    expect(screen.getByTestId("bmw-monthly-csv")).toBeInTheDocument();
    expect(screen.getByTestId("bmw-form-iv-csv")).toBeInTheDocument();
  });
});
