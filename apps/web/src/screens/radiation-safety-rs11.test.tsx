import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiationSafety } from "./radiation-safety";

/**
 * 18-S RS11 — the Radiation safety station's new views: TLD import (dry run → confirm), Incidents,
 * Pregnant workers, the QA due list, and the station's ONE list ("Needs you").
 *
 * What is asserted is that the SERVER's verdict reaches the RSO: the refused line and its reason,
 * no confirm button while any line is refused, the close refusal in the server's own words, the
 * reassign prompt for a declared-pregnant worker, and the blocked machine above the QA book.
 */
type Reply = { status: number; body: unknown };
type Call = { key: string; body: unknown };

function mockRoutes(handlers: Record<string, Reply | ((body: unknown) => Reply)>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ key, body });
    const h = handlers[key];
    const reply = typeof h === "function" ? h(body) : h;
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const BADGES = { status: 200, body: { rows: [], gaps: [], reads: [], limits: { annualMsv: 30, fiveYearAverageMsv: 20, fiveYearTotalMsv: 100 }, investigationLevelMsvPerMonth: 1, canManage: true } };
const BASE = {
  "GET /api/aerb/licences": { status: 200, body: { rows: [], canManage: true } },
  "GET /api/aerb/licences/gaps": { status: 200, body: { rows: [] } },
  "GET /api/aerb/badges": BADGES,
};

const row = (over: Record<string, unknown>) => ({
  line: 2, badgeNo: "JH-40118", wearer: "Ravi Tudu", userId: "U2", userName: "Ravi Tudu", badgeId: "B2",
  periodStart: "2026-04-01", periodEnd: "2026-06-30", hp10Msv: 3.4, hp007Msv: 3.6, remarks: null,
  errors: [], warnings: [], overInvestigationLevel: true, investigationLevelMsv: 2.99, yearTotalMsv: 3.4,
  projectedAnnualMsv: 13.6, overAnnualProjection: false, overAnnualLimit: false, overFoetalLimit: false, ...over,
});

const incident = (over: Record<string, unknown> = {}) => ({
  id: "I1", incidentNo: "INC-26-008", kind: "repeat_over_threshold", occurredAt: "2026-09-26T10:10:00.000Z",
  deviceCode: "CT-1", deviceName: "CT scanner", affectedType: "patient", affectedLabel: "Laxmi Oraon", uhid: "HMS-1",
  restricted: false, estimatedDoseMsv: "12.000", doseNote: null, description: "CECT repeated", immediateAction: "Told the patient",
  rootCause: "ROI on the IVC", correctiveActions: [{ action: "Second tech checks the ROI", owner: "Bikash Mondal", doneOn: null }],
  significantlyAboveIntended: false, notifyRequired: false, notifiedOn: null, notificationRef: null, notifyDueAt: null,
  notifyOverdue: false, state: "investigated", createdAt: "2026-09-26T12:00:00.000Z", closedAt: null, closureNote: null, ...over,
});

describe("Radiation safety — 18-S RS11 views", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("TLD import: a refused line is shown with its reason and there is NO confirm until the file is clean", async () => {
    const calls = mockRoutes({
      ...BASE,
      "POST /api/aerb/badges/import": { status: 200, body: {
        dryRun: true, columns: {}, errorCount: 1, imported: 0, flagged: { investigation: 1, annualProjection: 0, annualLimit: 0, foetal: 0 },
        rows: [row({}), row({ line: 3, badgeNo: "JH-99999", userName: null, errors: ["badge JH-99999 is not in the badge book"] })],
      } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-tld"));
    await userEvent.type(await screen.findByTestId("aerb-tld-csv"), "Badge No,Period From,Period To,Hp10");
    await userEvent.click(screen.getByTestId("aerb-tld-check"));
    const preview = await screen.findByTestId("aerb-tld-preview");
    expect(within(preview).getByTestId("aerb-tld-row-3")).toHaveTextContent("JH-99999 is not in the badge book");
    expect(within(preview).getByTestId("aerb-tld-row-2")).toHaveTextContent("over the investigation level");
    expect(screen.getByTestId("aerb-tld-summary")).toHaveTextContent("1 of 2 lines cannot be entered");
    expect(screen.queryByTestId("aerb-tld-confirm")).toBeNull();
    expect(calls.filter((c) => c.key === "POST /api/aerb/badges/import").map((c) => (c.body as { dryRun: boolean }).dryRun)).toEqual([true]);
  });

  it("TLD import: a clean dry run offers ONE act — enter all the readings — which posts dryRun false", async () => {
    const calls = mockRoutes({
      ...BASE,
      "POST /api/aerb/badges/import": (body) => ({ status: 200, body: {
        dryRun: (body as { dryRun: boolean }).dryRun, columns: {}, errorCount: 0,
        imported: (body as { dryRun: boolean }).dryRun ? 0 : 1, flagged: { investigation: 1, annualProjection: 0, annualLimit: 0, foetal: 0 }, rows: [row({})],
      } }),
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-tld"));
    await userEvent.type(await screen.findByTestId("aerb-tld-csv"), "x");
    await userEvent.click(screen.getByTestId("aerb-tld-check"));
    await userEvent.click(await screen.findByTestId("aerb-tld-confirm"));
    expect(await screen.findByTestId("aerb-tld-done")).toHaveTextContent("1 readings entered");
    expect(calls.filter((c) => c.key === "POST /api/aerb/badges/import").map((c) => (c.body as { dryRun: boolean }).dryRun)).toEqual([true, false]);
  });

  it("Incidents: the close refusal reaches the RSO in the server's words", async () => {
    mockRoutes({
      ...BASE,
      "GET /api/aerb/incidents": { status: 200, body: { rows: [incident()], canManage: true } },
      "POST /api/aerb/incidents/I1/close": { status: 409, body: {
        statusCode: 409, code: "incident_actions_open",
        message: "INC-26-008 has 1 corrective action still open: \"Second tech checks the ROI\" (Bikash Mondal)",
      } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-incidents"));
    const listed = await screen.findByTestId("aerb-incident-INC-26-008");
    await userEvent.click(within(listed).getByRole("button", { name: "INC-26-008" }));
    await userEvent.click(await screen.findByTestId("aerb-incident-close"));
    expect(await screen.findByTestId("aerb-incident-error")).toHaveTextContent("still open: \"Second tech checks the ROI\" (Bikash Mondal) (incident_actions_open)");
  });

  it("Incidents: an overdue AERB notification is red on the register", async () => {
    mockRoutes({
      ...BASE,
      "GET /api/aerb/incidents": { status: 200, body: { rows: [incident({ notifyRequired: true, notifyOverdue: true, state: "open" })], canManage: false } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-incidents"));
    const listed = await screen.findByTestId("aerb-incident-INC-26-008");
    expect(listed).toHaveTextContent("overdue");
    expect(listed.className).toContain("text-red-700");
    expect(screen.queryByTestId("aerb-incident-new-open")).toBeNull();
  });

  it("Pregnant workers: an active declaration says reassign or restrict, with her dose against 1 mSv", async () => {
    mockRoutes({
      ...BASE,
      "GET /api/aerb/pregnancy": { status: 200, body: { foetalLimitMsv: 1, canManage: false, rows: [{
        id: "P1", userId: "U3", userName: "Rina Devi", declaredOn: "2026-05-01", expectedOn: "2026-12-20", endedOn: null,
        endReason: null, remarks: null, active: true, lapsed: false, foetalDoseMsv: "0.400", foetalLimitMsv: 1,
        overFoetalLimit: false, readsCounted: 1,
      }] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-pregnancy"));
    const warning = await screen.findByTestId("aerb-pregnancy-warning-U3");
    expect(warning).toHaveTextContent("Rina Devi");
    expect(warning).toHaveTextContent("reassign or restrict");
    expect(warning).toHaveTextContent("0.400 of 1 mSv since 2026-05-01");
  });

  it("QA: the due list names the overdue test and the machine a QA has stopped", async () => {
    mockRoutes({
      ...BASE,
      "GET /api/aerb/qa": { status: 200, body: { rows: [], canManage: false } },
      "GET /api/aerb/qa/due": { status: 200, body: { defaultIntervalYears: 2, rows: [{
        deviceResourceId: "D1", deviceCode: "CT-1", deviceName: "CT scanner", deviceStatus: "qa_blocked", qaType: "Periodic QA",
        lastRecordId: "Q1", lastPerformedOn: "2024-09-01", lastResult: "pass", dueOn: "2026-09-01", defaultInterval: true,
        state: "overdue", daysOverdue: 28,
      }] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    expect(await screen.findByTestId("aerb-qa-due-blocked")).toHaveTextContent("CT-1 — CT scanner");
    expect(screen.getByTestId("aerb-qa-due-CT-1")).toHaveTextContent("Overdue");
    expect(screen.getByTestId("aerb-qa-due-CT-1")).toHaveTextContent("2-year default");
  });

  it("the ONE list: what waits on the RSO, and a row opens the view that fixes it", async () => {
    mockRoutes({
      ...BASE,
      "GET /api/aerb/attention": { status: 200, body: { sources: {}, rows: [
        { key: "pregnancy:P1", severity: "amber", view: "pregnancy", subject: "Rina Devi", detail: "declared pregnant worker — reassign or restrict her ionising work", ref: "P1" },
      ] } },
      "GET /api/aerb/pregnancy": { status: 200, body: { rows: [], foetalLimitMsv: 1, canManage: false } },
    });
    renderWithProviders(<RadiationSafety />);
    const item = await screen.findByTestId("aerb-attention-pregnancy:P1");
    expect(item).toHaveTextContent("reassign or restrict");
    await userEvent.click(item);
    await waitFor(() => { expect(screen.getByTestId("aerb-tab-pregnancy")).toHaveAttribute("aria-selected", "true"); });
  });
});
