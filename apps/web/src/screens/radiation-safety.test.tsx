import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiationSafety } from "./radiation-safety";

/**
 * PLAN 18c T1 — the radiation-safety register.
 *
 * **What is asserted is that the GAP is rendered and cannot be dismissed.** The register's value is
 * not the licences it holds but the machines it cannot account for, and a screen that only listed
 * rows would show an empty, reassuring table to a hospital running an unlicensed CT. So the gap
 * block is the first assertion here, and the second is that the server decides what is in it — the
 * screen never computes which modalities AERB licences.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const licence = (over: Record<string, unknown> = {}) => ({
  id: "L1", deviceResourceId: "D1", deviceCode: "CT-1", deviceName: "CT machine", modality: "ct",
  licenceType: "licence", licenceNo: "AERB/CT/2026/1", eloraRef: "ELORA-778",
  typeApprovalRef: "TA/CT/91", layoutApprovalRef: "LAY/2025/12",
  validFrom: "2026-01-01", validTo: "2026-12-31", status: "active",
  rsoUserId: "U1", rsoName: "Manoj Bhat", decommissionedAt: null, decommissionRef: null,
  remarks: null, ...over,
});

const LICENCES = "GET /api/aerb/licences";
const GAPS = "GET /api/aerb/licences/gaps";
const PERSONS = "GET /api/aerb/persons";
const QA = "GET /api/aerb/qa";
const DOSES = "GET /api/aerb/doses";
const BADGES = "GET /api/aerb/badges";
const CALENDAR = "GET /api/aerb/calendar";

describe("the radiation-safety register (18c T1)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("renders the licence file with the machine, the number, the window and the RSO", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()] } },
      [GAPS]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    await waitFor(() => { expect(screen.getByTestId("aerb-licence-L1")).toBeInTheDocument(); });
    const row = screen.getByTestId("aerb-licence-L1");
    expect(row).toHaveTextContent("CT-1");
    expect(row).toHaveTextContent("AERB/CT/2026/1");
    expect(row).toHaveTextContent("2026-01-01");
    expect(row).toHaveTextContent("2026-12-31");
    expect(row).toHaveTextContent("Manoj Bhat");
  });

  /**
   * THE ONE THAT MATTERS. A machine emitting with nothing on file is an alert, above the file,
   * every time the server reports one — not a filter a busy RSO can leave switched off.
   */
  it("puts the unlicensed machine ABOVE the file, as an alert, and names it", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()] } },
      [GAPS]: { status: 200, body: { rows: [{ deviceResourceId: "D2", code: "DR-1", name: "DR machine", modality: "xray" }] } },
    });
    renderWithProviders(<RadiationSafety />);
    const gaps = await screen.findByTestId("aerb-gaps");
    expect(gaps).toHaveTextContent("DR-1");
    expect(gaps).toHaveTextContent("xray");
    expect(gaps).toHaveAttribute("role", "alert");
  });

  it("shows no gap block when the server reports none — the alert is the server's word, not a default", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()] } },
      [GAPS]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    await waitFor(() => { expect(screen.getByTestId("aerb-licences")).toBeInTheDocument(); });
    expect(screen.queryByTestId("aerb-gaps")).not.toBeInTheDocument();
  });

  it("an empty register says so rather than rendering a blank table", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    expect(await screen.findByTestId("aerb-licences-empty")).toBeInTheDocument();
  });

  it("surfaces the server's own refusal code, not a friendlier sentence", async () => {
    mockRoutes({
      [LICENCES]: { status: 403, body: { statusCode: 403, message: "forbidden", code: "permission_denied" } },
      [GAPS]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    await waitFor(() => { expect(screen.getAllByRole("alert").length).toBeGreaterThan(0); });
    expect(screen.getAllByRole("alert").some((n) => n.textContent?.includes("permission_denied"))).toBe(true);
  });

  /* ═════════════════════ PLAN 18c T3 — THE DOSE TAB ═════════════════════ */

  const doseRow = (over: Record<string, unknown> = {}) => ({
    id: "R1", source: "imaging", sourceRef: "S1", patientId: "P1", patientName: "Asha Devi",
    uhid: "HMS-00000001-5", deviceCode: "CT-1", modality: "ct", procedureCode: "CT-HEAD",
    doseCtdivol: "42.000", doseDlp: "1200.000", doseDap: null, fluoroSeconds: null,
    doseManual: false, drlQuantity: "dlp", drlValue: "1000.000", overDrl: true,
    occurredAt: "2026-06-15T09:00:00.000Z", ...over,
  });

  /**
   * THREE STATES, NOT TWO. `overDrl === null` means no published reference level, and rendering it
   * as "within DRL" would be a claim of compliance nobody measured — the same distinction the
   * register's own CHECK enforces one layer down.
   */
  it("renders over, within and NO LEVEL as three different things", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [DOSES]: { status: 200, body: { rows: [
        doseRow({ id: "R1", overDrl: true }),
        doseRow({ id: "R2", overDrl: false }),
        doseRow({ id: "R3", overDrl: null, drlQuantity: null, drlValue: null }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-dose"));
    expect(await screen.findByTestId("aerb-dose-R1")).toHaveTextContent("over DRL");
    expect(screen.getByTestId("aerb-dose-R2")).toHaveTextContent("within DRL");
    const noLevel = screen.getByTestId("aerb-dose-R3");
    expect(noLevel).toHaveTextContent("no level published");
    expect(noLevel).not.toHaveTextContent("within DRL");
  });

  /** 18b's close review found a DAP figure with a unit the tree never named. These are the names. */
  it("renders every dose with its own unit, and DAP is not measured in DLP's", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [DOSES]: { status: 200, body: { rows: [
        doseRow({ id: "R1", doseCtdivol: "42.000", doseDlp: "1200.000" }),
        doseRow({ id: "R2", doseCtdivol: null, doseDlp: null, doseDap: "3.400", drlQuantity: null, drlValue: null, overDrl: null }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-dose"));
    const r1 = await screen.findByTestId("aerb-dose-R1");
    expect(r1).toHaveTextContent("CTDIvol 42.000 mGy");
    expect(r1).toHaveTextContent("DLP 1200.000 mGy·cm");
    expect(screen.getByTestId("aerb-dose-R2")).toHaveTextContent("DAP 3.400 Gy·cm²");
  });

  it("the people tab lists the appointment, and an open-ended one says so", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PERSONS]: { status: 200, body: { rows: [
        { id: "P1", userId: "U1", userName: "Manoj Bhat", personRole: "rso", approvalRef: "AERB/RSO/17",
          qualification: "BSc Radiography", validFrom: "2026-01-01", validTo: null, active: true },
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-people"));
    const row = await screen.findByTestId("aerb-person-P1");
    expect(row).toHaveTextContent("Manoj Bhat");
    expect(row).toHaveTextContent("AERB/RSO/17");
    expect(row).toHaveTextContent("open-ended");
  });

  /** T5 — every register the inspector asks for is now built; no tab is disabled. */
  it("all five registers are reachable", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    for (const k of ["licences", "people", "qa", "dose", "badges", "calendar"]) {
      expect(await screen.findByTestId(`aerb-tab-${k}`)).not.toBeDisabled();
    }
  });

  /* ═════════════════════ PLAN 18c T5 — THE CALENDAR ═════════════════════ */

  const calRow = (over: Record<string, unknown> = {}) => ({
    kind: "licence", subject: "CT-1 — CT machine", detail: "AERB/CT/2026/1",
    dueOn: "2026-06-01", state: "overdue", daysOverdue: 14, ref: "L1", ...over,
  });

  /**
   * The three states read as three different sentences. "14 days overdue" and "due in 9 days" are
   * different instructions; a screen that rendered both as a date would make the RSO do the
   * subtraction, which is the arithmetic a calendar exists to have already done.
   */
  it("says how late each thing is, in words, and never just a date", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [CALENDAR]: { status: 200, body: { rows: [
        calRow({ ref: "L1", state: "overdue", daysOverdue: 14 }),
        calRow({ ref: "Q1", kind: "qa", state: "due", daysOverdue: -9 }),
        calRow({ ref: "A1", kind: "appointment", state: "due", daysOverdue: 0 }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-calendar"));
    expect(await screen.findByTestId("aerb-calendar-L1")).toHaveTextContent("14 days overdue");
    expect(screen.getByTestId("aerb-calendar-Q1")).toHaveTextContent("due in 9 days");
    expect(screen.getByTestId("aerb-calendar-A1")).toHaveTextContent("due today");
  });

  /** A badge nobody has read has no date to be late against, and must not render as blank. */
  it("renders the badge with no reading as `never read` rather than an empty cell", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [CALENDAR]: { status: 200, body: { rows: [
        calRow({ ref: "B1", kind: "badge", subject: "A. Devi", detail: "TLD-002", dueOn: null, daysOverdue: 200 }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-calendar"));
    const row = await screen.findByTestId("aerb-calendar-B1");
    expect(row).toHaveTextContent("never read");
    expect(row).toHaveTextContent("TLD-002");
  });

  it("a clean file says so rather than showing an empty table", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [CALENDAR]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-calendar"));
    expect(await screen.findByTestId("aerb-calendar-empty")).toBeInTheDocument();
  });

  /**
   * D12 — the inspector's file is the SAME list with everything shown. Pressing print switches the
   * view to the whole file first, because a file that omitted the licences that are in date would
   * be exactly the wrong half to hand an inspector.
   */
  it("printing switches to the whole file first, then prints", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [CALENDAR]: { status: 200, body: { rows: [calRow()] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-calendar"));
    expect(screen.getByTestId("aerb-calendar-include-ok")).not.toBeChecked();
    await userEvent.click(screen.getByTestId("aerb-print"));
    expect(screen.getByTestId("aerb-calendar-include-ok")).toBeChecked();
    await waitFor(() => { expect(print).toHaveBeenCalled(); });
  });

  /* ═════════════════════ PLAN 18c T4 — THE BADGES TAB ═════════════════════ */

  const badge = (over: Record<string, unknown> = {}) => ({
    badgeId: "B1", userId: "U1", userName: "R. Singh", badgeNo: "TLD-001",
    issuedOn: "2026-01-01", returnedOn: null, status: "active",
    lastPeriodEnd: "2026-03-31", lastHp10Msv: "1.400", lastInvestigation: false,
    ytdMsv: "1.400", fiveYearMsv: "1.400", overAnnualLimit: false, overFiveYearLimit: false,
    readCount: 1, ...over,
  });

  const badgeBook = (over: Record<string, unknown> = {}) => ({
    rows: [badge()], gaps: [], reads: [],
    limits: { annualMsv: 30, fiveYearAverageMsv: 20, fiveYearTotalMsv: 100 },
    investigationLevelMsvPerMonth: 1, ...over,
  });

  /**
   * THE ONE THAT MATTERS. A badge nobody is reading is a person whose occupational exposure is
   * unknown, and a book that listed only the readings it HAS could never show one.
   */
  it("names the badges nobody is reading, above the book", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: badgeBook({ gaps: [
        { badgeId: "B2", userId: "U2", userName: "A. Devi", badgeNo: "TLD-002",
          issuedOn: "2026-01-01", lastPeriodEnd: null, daysSince: 134 },
      ] }) },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    const gaps = await screen.findByTestId("aerb-badge-gaps");
    expect(gaps).toHaveTextContent("A. Devi");
    expect(gaps).toHaveTextContent("TLD-002");
    expect(gaps).toHaveTextContent("never read");
  });

  /**
   * The screen states the limits the SERVER sent, never its own. A number a screen invented is a
   * number an inspector was shown that nothing in the system stands behind.
   */
  it("states the statutory limits and the investigation level from the server", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: badgeBook({ investigationLevelMsvPerMonth: 0.4 }) },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    const limits = await screen.findByTestId("aerb-badge-limits");
    expect(limits).toHaveTextContent("30 mSv");
    expect(limits).toHaveTextContent("100 mSv");
    expect(limits).toHaveTextContent("0.4 mSv per month");
  });

  it("marks a reading that met the investigation level, and a year over the statutory limit", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: badgeBook({ rows: [
        badge({ badgeId: "B1", lastHp10Msv: "3.200", lastInvestigation: true }),
        badge({ badgeId: "B2", userName: "S. Iyer", badgeNo: "TLD-002", ytdMsv: "31.000", overAnnualLimit: true }),
      ] }) },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    expect(await screen.findByTestId("aerb-badge-B1")).toHaveTextContent("investigate");
    expect(screen.getByTestId("aerb-badge-B2")).toHaveTextContent("over the statutory limit");
  });

  /* ═════════════════════ PLAN 18c T2 — THE QA TAB ═════════════════════ */

  const qaRow = (over: Record<string, unknown> = {}) => ({
    id: "Q1", deviceResourceId: "D1", deviceCode: "CT-1", deviceName: "CT machine",
    deviceStatus: "available", qaType: "AERB annual QA", result: "pass",
    performedBy: "S. Iyer", performedOn: "2026-06-15", agencyRef: "QA/2026/117",
    nextDueOn: "2027-06-15", blockApplied: false, releasedAt: null, remarks: null, ...over,
  });

  /**
   * THE ONE THAT MATTERS HERE. A machine the system has taken out of service is the state a QA
   * register exists to make impossible to miss, so it is an alert above the book — the licence
   * gap's shape, and the same argument.
   */
  it("names the machines currently stopped by a failed QA, above the book", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [QA]: { status: 200, body: { rows: [
        qaRow({ id: "Q1", result: "fail", blockApplied: true, deviceStatus: "qa_blocked" }),
        qaRow({ id: "Q2", deviceCode: "DR-1", deviceStatus: "available" }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    const blocked = await screen.findByTestId("aerb-qa-blocked");
    expect(blocked).toHaveTextContent("CT-1");
    expect(blocked).not.toHaveTextContent("DR-1");
  });

  it("shows no stopped-machine alert when every machine is running", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [QA]: { status: 200, body: { rows: [qaRow()] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    await waitFor(() => { expect(screen.getByTestId("aerb-qa")).toBeInTheDocument(); });
    expect(screen.queryByTestId("aerb-qa-blocked")).not.toBeInTheDocument();
  });

  /**
   * The record says what happened ON THE DAY; the machine's status says where it is now. A block
   * that was later released must read as neither "stopped" nor "nothing happened".
   */
  it("distinguishes a machine stopped now from one stopped and released", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [QA]: { status: 200, body: { rows: [
        qaRow({ id: "Q1", result: "fail", blockApplied: true, releasedAt: null, deviceStatus: "qa_blocked" }),
        qaRow({ id: "Q2", result: "fail", blockApplied: true, releasedAt: "2026-06-20T00:00:00.000Z" }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    expect(await screen.findByTestId("aerb-qa-Q1")).toHaveTextContent("machine stopped");
    expect(screen.getByTestId("aerb-qa-Q2")).toHaveTextContent("stopped, then released");
  });
});
