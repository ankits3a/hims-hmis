import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyH1Register } from "./pharmacy-h1-register";
import type { WireH1Register } from "../lib/pharmacy-api";

const AUGUST: WireH1Register = {
  period: { from: "2026-08-01", to: "2026-08-31" },
  rows: [
    {
      entryNo: 41, dispensedAt: "2026-08-17T04:40:00.000Z", patientId: "p1", patientName: "Farida Khatoon", patientAddress: "12 MG Road, Pune",
      restricted: false, prescriberName: "Dr Sen", prescriberRegNo: "MMC-2011-4471", drugName: "Azee 500 500 mg tablet",
      batchNo: "AZ-1", qtyBase: 3, unit: "tablet", pharmacistRegNo: "MSPC-123456",
    },
    {
      entryNo: 42, dispensedAt: "2026-08-18T18:45:00.000Z", patientId: "p2", patientName: "Patient R-17", patientAddress: null,
      restricted: true, prescriberName: "Dr Sen", prescriberRegNo: null, drugName: "Azee 500 500 mg tablet",
      batchNo: "AZ-1", qtyBase: 3, unit: "tablet", pharmacistRegNo: "MSPC-123456",
    },
  ],
};

/** PHARMACY P9 — a month of the Schedule H1 register, as an inspector reads it. */
describe("PharmacyH1Register (P9)", () => {
  const asked: string[] = [];
  beforeEach(() => {
    setToken("t");
    asked.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      asked.push(raw);
      const body = raw.includes("from=2026-08-01") ? AUGUST : { period: { from: "", to: "" }, rows: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("asks for the chosen month's whole span and prints the register's columns, with a sealed row marked", async () => {
    renderWithProviders(<PharmacyH1Register />);
    fireEvent.change(await screen.findByTestId("h1-month"), { target: { value: "2026-08" } });

    const first = await screen.findByTestId("h1-row-41");
    expect(asked.some((u) => u.includes("/api/pharmacy/registers/h1?from=2026-08-01&to=2026-08-31"))).toBe(true);
    expect(first).toHaveTextContent("17-08-2026 10:10");
    expect(first).toHaveTextContent("Farida Khatoon12 MG Road, Pune");
    expect(first).toHaveTextContent("Dr Sen, MMC-2011-4471");
    expect(first).toHaveTextContent("3 tablet");
    expect(first).toHaveTextContent("MSPC-123456");
    // 18:45 UTC on the 18th is 00:15 IST on the 19th.
    const sealed = screen.getByTestId("h1-row-42");
    expect(sealed).toHaveTextContent("19-08-2026 00:15");
    expect(sealed).toHaveTextContent("Patient R-17(sealed record)");
    expect(screen.getByText(/unredacted copy needs the patients.confidential.read grant/)).toBeInTheDocument();
    expect(screen.getByText("Period: 01-08-2026 to 31-08-2026")).toBeInTheDocument();
    expect(screen.getByText(/Drug licence no\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print register" })).toBeEnabled();
  });

  it("says so when the month is empty, and ends February on its last day", async () => {
    renderWithProviders(<PharmacyH1Register />);
    fireEvent.change(await screen.findByTestId("h1-month"), { target: { value: "2028-02" } });
    await waitFor(() => { expect(asked.some((u) => u.includes("from=2028-02-01&to=2028-02-29"))).toBe(true); });
    expect(await screen.findByText("No Schedule H1 supply in this month.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print register" })).toBeDisabled();
  });
});
