import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DoctorDeskReport } from "./doctor-desk-report";
import type { WireDepartmentReport, WireHospitalReport, WireUnitReport, WireUnitReports } from "../lib/doctor-desk-api";

/** DD-report v0 — the 08:00 unit report page against the server's wire: counts only, floors honoured, neutral. */
const R1: WireUnitReport = {
  id: "run1", teamId: "u2", unitName: "General Medicine Unit II", short: "Unit II", departmentName: "General Medicine",
  reportDate: "2026-10-06", windowFrom: "2026-10-05T02:30:00.000Z", windowTo: "2026-10-06T02:30:00.000Z", sentAt: "2026-10-06T02:30:04.000Z",
  critical: { acts: 5, median: 8, over: 1, longest: 20, overMinutes: 15 },
  compare: { department: 9, hospital: null },
  opd: { date: "2026-10-05", seen: 142, doctors: 4 },
  owed: { open: 4, past: 2, criticalsWithoutAct: 1 },
};
const DEPT: WireDepartmentReport = {
  id: "d1", departmentId: "med", departmentName: "General Medicine", reportDate: "2026-10-06",
  windowFrom: "2026-10-05T02:30:00.000Z", windowTo: "2026-10-06T02:30:00.000Z", sentAt: "2026-10-06T02:30:05.000Z",
  units: [
    { teamId: "u1", short: "Unit I", acts: 2, median: null, over: 0, owedOpen: 3, owedPast: 1, opdSeen: 96 },
    { teamId: "u2", short: "Unit II", acts: 5, median: 8, over: 1, owedOpen: 4, owedPast: 2, opdSeen: 142 },
  ],
  median: null, hospital: 9, totals: { acts: 7, over: 1, owedOpen: 7, owedPast: 3, opdSeen: 238 },
};
const HOSP: WireHospitalReport = {
  id: "h1", reportDate: "2026-10-05", windowFrom: "2026-09-28T02:30:00.000Z", windowTo: "2026-10-05T02:30:00.000Z", sentAt: "2026-10-05T02:30:06.000Z", days: 7,
  departments: [{ departmentId: "med", departmentName: "General Medicine", units: 3, acts: 31, median: 9, over: 4, opdSeen: 812, owedOpen: 7, owedPast: 3 }],
  median: 10, totals: { acts: 31, over: 4, opdSeen: 812, owedOpen: 7, owedPast: 3 },
};
const R0: WireUnitReport = { ...R1, id: "run0", reportDate: "2026-10-05", critical: { acts: 3, median: null, over: 0, longest: 12, overMinutes: 15 } };

describe("Doctor Desk unit report (DD-report v0)", () => {
  let body: WireUnitReports;
  beforeEach(() => {
    setToken("t");
    body = { scope: { level: "unit", officiating: false, departmentId: "med", departmentName: "General Medicine" }, reports: [R1, R0], departments: [], hospital: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const b = raw.endsWith("/auth/me") ? { actor: { type: "user", id: "hd" }, permissions: { hospital: ["opd.consult"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/doctor-desk/reports") ? body : {};
      return new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("draws the newest report's counts; the department average beside it, the hospital's absent below its floor", async () => {
    renderWithProviders(<DoctorDeskReport />);
    expect(await screen.findByTestId("dd-report-critical")).toHaveTextContent("8 min median5 acts · 1 over 15 min");
    expect(screen.getByTestId("dd-report-longest")).toHaveTextContent("20 min");
    expect(screen.getByTestId("dd-report-compare")).toHaveTextContent("9 min · —");
    expect(screen.getByTestId("dd-report-owed")).toHaveTextContent("Items the unit owed at 08:0042 past their time");
    expect(screen.getByTestId("dd-report-opd")).toHaveTextContent("OPD on 2026-10-05142 seen4 doctors with a session");
    expect(screen.getByTestId("dd-report")).toHaveTextContent("Unit report · General Medicine · Unit II · 2026-10-06");
    await userEvent.click(screen.getByTestId("dd-report-tab-run0"));
    expect(screen.getByTestId("dd-report-critical")).toHaveTextContent("3 actstoo few to average · 0 over 15 min");
  });

  it("names no patient or person, carries no money, and has no colour of judgement", async () => {
    const { container } = renderWithProviders(<DoctorDeskReport />);
    await screen.findByTestId("dd-report");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Dr\.|Patient|HMS-/);
    expect(text).not.toMatch(/fee|paid|price|₹|rupee|bill/i);
    expect(container.querySelector("[data-testid='dd-report'] .dd-red, [data-testid='dd-report'] .dd-amber")).toBeNull();
  });

  it("someone who receives no report is told where it goes", async () => {
    body = { ...body, scope: { ...body.scope, level: "member" }, reports: [] };
    renderWithProviders(<DoctorDeskReport />);
    expect(await screen.findByTestId("dd-report-none")).toHaveTextContent("The unit report goes at 08:00 to the unit head");
  });

  it("the HOD reads the department's units side by side; the MS the hospital's week — counts only, medians below the floor drawn as —", async () => {
    body = { ...body, scope: { level: "hospital", officiating: false, departmentId: null, departmentName: null }, departments: [DEPT], hospital: [HOSP] };
    const { container } = renderWithProviders(<DoctorDeskReport />);
    expect(await screen.findByTestId("dd-hosp-report")).toHaveTextContent("Hospital report · the week to 2026-10-05");
    expect(screen.getByTestId("dd-hosp-dept-med")).toHaveTextContent("General Medicine3 units319 min47381");
    expect(screen.getByTestId("dd-hosp-median")).toHaveTextContent("10 min");
    await userEvent.click(screen.getByTestId("dd-report-kind-department"));
    expect(screen.getByTestId("dd-dept-unit-u1")).toHaveTextContent("Unit I2—03196");
    expect(screen.getByTestId("dd-dept-unit-u2")).toHaveTextContent("Unit II58 min142142");
    expect(screen.getByTestId("dd-dept-median")).toHaveTextContent("— · 9 min");
    await userEvent.click(screen.getByTestId("dd-report-kind-unit"));
    expect(await screen.findByTestId("dd-report")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/Dr\.|Patient|HMS-|fee|paid|₹|rupee/);
  });
});
