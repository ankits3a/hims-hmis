import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { QuickLabReports } from "./lab-quick-reports";

/**
 * QUICK MODE (decision 0061) — the block the patient profile and the doctor's brief show: every
 * report says "not signed"; the doctor's compact form shows only out-of-range values until opened,
 * and draws nothing when the patient has no quick report.
 */
const REPORT = {
  id: "q-1", status: "reported", encounterNo: "V2610090001",
  patient: { id: "p-1", uhid: "U23011884", display: "Farida Khatoon", administrativeGender: "female", dob: "1974-03-02" },
  tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" }],
  collectedAt: "2026-10-09T04:00:00.000Z", collectedBy: "u-1", reportedAt: "2026-10-09T09:00:00.000Z", reportedBy: "u-1",
  analyteIds: ["a-hb", "a-wbc"], groups: [{ title: "Complete blood count", analyteIds: ["a-hb", "a-wbc"] }],
  lines: [
    { analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", refText: null, flag: "L" },
    { analyteId: "a-wbc", code: "WBC", nameEn: "Total leucocyte count", unit: "/µL", value: "7000", low: "4000.0000", high: "11000.0000", refText: null, flag: "N" },
  ],
  summary: "Hb low, repeat",
};

function stub(items: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.startsWith("/api/lab/quick/patient/p-1") ? { items } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("the doctor's compact block: not signed, the low Hb, the summary only after opening", async () => {
  stub([REPORT]);
  renderWithProviders(<QuickLabReports patientId="p-1" compact />);
  const card = await screen.findByTestId("quick-report-q-1");
  expect(card).toHaveTextContent("Quick lab · not signed");
  expect(card).toHaveTextContent("Haemoglobin: 9.2 g/dL L");
  expect(card).not.toHaveTextContent("Hb low, repeat");
  await userEvent.click(screen.getByRole("button", { name: "All values" }));
  expect(card).toHaveTextContent("Total leucocyte count");
  expect(card).toHaveTextContent("Hb low, repeat");
});

it("draws nothing when the patient has no quick report (compact and hideEmpty)", async () => {
  stub([]);
  const { container } = renderWithProviders(<QuickLabReports patientId="p-1" hideEmpty />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(container.querySelector("[data-testid=quick-lab-reports]")).toBeNull();
});
