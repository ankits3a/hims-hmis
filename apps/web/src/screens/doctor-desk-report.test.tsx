import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DoctorDeskReport } from "./doctor-desk-report";
import type { WireUnitReport, WireUnitReports } from "../lib/doctor-desk-api";

/** DD-report v0 — the 08:00 unit report page against the server's wire: counts only, floors honoured, neutral. */
const R1: WireUnitReport = {
  id: "run1", teamId: "u2", unitName: "General Medicine Unit II", short: "Unit II", departmentName: "General Medicine",
  reportDate: "2026-10-06", windowFrom: "2026-10-05T02:30:00.000Z", windowTo: "2026-10-06T02:30:00.000Z", sentAt: "2026-10-06T02:30:04.000Z",
  critical: { acts: 5, median: 8, over: 1, longest: 20, overMinutes: 15 },
  compare: { department: 9, hospital: null },
  opd: { date: "2026-10-05", seen: 142, doctors: 4 },
  owed: { open: 4, past: 2, criticalsWithoutAct: 1 },
};
const R0: WireUnitReport = { ...R1, id: "run0", reportDate: "2026-10-05", critical: { acts: 3, median: null, over: 0, longest: 12, overMinutes: 15 } };

describe("Doctor Desk unit report (DD-report v0)", () => {
  let body: WireUnitReports;
  beforeEach(() => {
    setToken("t");
    body = { scope: { level: "unit", officiating: false, departmentId: "med", departmentName: "General Medicine" }, reports: [R1, R0] };
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
    expect(await screen.findByTestId("dd-report-none")).toHaveTextContent("It is sent at 08:00 to the unit head");
  });
});
