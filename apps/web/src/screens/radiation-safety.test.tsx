import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    restricted: false, occurredAt: "2026-06-15T09:00:00.000Z", ...over,
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
  /**
   * CLOSE REVIEW — the print used to fire on a `setTimeout(…, 0)` immediately after flipping the
   * flag, so the preview captured "Loading…" and a table with headers and no body. It now waits
   * for the widened file, and the assertion is that A ROW IS ON SCREEN at the moment it prints.
   */
  it("printing waits for the whole file to arrive, and prints it with rows on screen", async () => {
    const print = vi.fn(() => {
      /** The moment of truth: what the browser would have captured. */
      expect(screen.getByTestId("aerb-calendar-L1")).toBeInTheDocument();
    });
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

  /**
   * ═══ PASS 2 — THESE TWO GUARD THE REGRESSION PASS 1's FIX INTRODUCED ═══
   *
   * Pass 1 replaced a `setTimeout(print, 0)` with an effect that returned early whenever the
   * widened file was not here — with NO path out on failure. The client is `retry: false`, so one
   * 403 left the button **disabled and reading "Preparing the file…" for the life of the mount**: a
   * print that could never happen, where the defect it replaced at least always printed something.
   * Pass 2 proved both stuck paths with a probe. The test the fix shipped with was VACUOUS — in
   * jsdom the mocked fetch drains through microtasks before a `setTimeout(…, 0)` macrotask, so it
   * passed against the ORIGINAL code too.
   */
  it("a failed widened fetch releases the print button instead of stranding it", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [CALENDAR]: { status: 403, body: { statusCode: 403, message: "forbidden", code: "permission_denied" } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-calendar"));
    await userEvent.click(await screen.findByTestId("aerb-print"));
    await waitFor(() => { expect(screen.getByTestId("aerb-print")).not.toBeDisabled(); });
    expect(print).not.toHaveBeenCalled();
  });

  it("unticking the box while the file is loading releases the print button too", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [CALENDAR]: { status: 200, body: { rows: [calRow()] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-calendar"));
    await userEvent.click(await screen.findByTestId("aerb-print"));
    await userEvent.click(screen.getByTestId("aerb-calendar-include-ok"));
    await waitFor(() => { expect(screen.getByTestId("aerb-print")).not.toBeDisabled(); });
  });

  /**
   * PASS 2 — the dose register dated every row by the UTC day while SELECTING them by the IST day,
   * so a CT at 02:15 IST on 1 April was fetched as April and printed as 31 March. The register was
   * internally inconsistent about the one fact an inspector cross-checks.
   */
  it("dates a dose row by the IST day, not the UTC one", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [DOSES]: { status: 200, body: { rows: [doseRow({ occurredAt: "2026-03-31T20:45:00.000Z" })] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-dose"));
    /** 20:45 UTC on 31 March is 02:15 IST on 1 April. */
    expect(await screen.findByTestId("aerb-dose-R1")).toHaveTextContent("2026-04-01");
  });

  /**
   * PASS 2 — the alias was rendered beside the UHID, which is the hospital-wide lookup key: any
   * radiographer could paste it into patient search and recover the legal name, which is the whole
   * of what the aliasing prevents. CRITICAL 4 was only half-closed.
   */
  it("does not print the UHID of a patient whose name it is withholding", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [DOSES]: { status: 200, body: { rows: [
        doseRow({ id: "R1", patientName: "Patient A", uhid: "", restricted: true }),
        doseRow({ id: "R2", patientName: "Ravi Kumar", uhid: "HMS-00000002-3", restricted: false }),
      ] } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-dose"));
    const hidden = await screen.findByTestId("aerb-dose-R1");
    expect(hidden).toHaveTextContent("Patient A");
    expect(hidden).not.toHaveTextContent("HMS-");
    /** An ordinary patient still shows theirs — the RSO's register is not made useless. */
    expect(screen.getByTestId("aerb-dose-R2")).toHaveTextContent("HMS-00000002-3");
  });

  /* ═════════════════════ PLAN 18c T4 — THE BADGES TAB ═════════════════════ */

  const badge = (over: Record<string, unknown> = {}) => ({
    badgeId: "B1", userId: "U1", userName: "R. Singh", badgeNo: "TLD-001",
    issuedOn: "2026-01-01", returnedOn: null, status: "active",
    lastPeriodEnd: "2026-03-31", lastHp10Msv: "1.400", lastInvestigation: false,
    workerYtdMsv: "1.400", workerFiveYearMsv: "1.400",
    worstYear: "2026", worstYearMsv: "1.400",
    overAnnualLimit: false, overFiveYearLimit: false,
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
        badge({ badgeId: "B2", userName: "S. Iyer", badgeNo: "TLD-002", worstYearMsv: "31.000", overAnnualLimit: true }),
      ] }) },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    expect(await screen.findByTestId("aerb-badge-B1")).toHaveTextContent("investigate");
    const over = screen.getByTestId("aerb-badge-B2");
    expect(over).toHaveTextContent("over the statutory limit");
    /** The year that breached is named, and the number is the WORKER's, not the badge's. */
    expect(over).toHaveTextContent("2026: 31.000 mSv");
  });

  /* ═══════════ CLOSE REVIEW — THE FOUR SCREEN DEFECTS ═══════════ */

  /**
   * CRITICAL-adjacent: a compliance screen that says "nothing is due or overdue" when it could not
   * READ the register is telling an RSO the hospital is clean on the strength of a 403.
   */
  it.each([
    ["calendar", CALENDAR, "aerb-tab-calendar", "aerb-calendar-empty", /Nothing is due/],
    ["badges", BADGES, "aerb-tab-badges", "aerb-badges-empty", /No TLD badge/],
    /** PASS 2 — the guard is on all six tabs; two were tested. These are the other four. */
    ["licences", LICENCES, "aerb-tab-licences", "aerb-licences-empty", /No AERB licence/],
    ["qa", QA, "aerb-tab-qa", "aerb-qa-empty", /No quality-assurance result/],
    ["dose", DOSES, "aerb-tab-dose", "aerb-dose-empty", /No dose has been registered/],
    ["people", PERSONS, "aerb-tab-people", "aerb-people-empty", /No RSO or medical physicist/],
  ])("a failed %s fetch shows the error and NOT the all-clear sentence", async (_name, route, tab, emptyId, sentence) => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [route]: { status: 403, body: { statusCode: 403, message: "forbidden", code: "permission_denied" } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId(tab));
    await waitFor(() => {
      expect(screen.getAllByRole("alert").some((n) => n.textContent?.includes("permission_denied"))).toBe(true);
    });
    expect(screen.queryByTestId(emptyId)).not.toBeInTheDocument();
    expect(screen.queryByText(sentence)).not.toBeInTheDocument();
  });

  /**
   * The flagged reading used to be visible only while it was the LATEST one: one ordinary quarter
   * later, the flag, its level and its lab reference were unreachable from any screen.
   */
  it("keeps a flagged reading on the screen after a later normal one", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: badgeBook({
        rows: [badge({ lastHp10Msv: "1.100", lastPeriodEnd: "2026-06-30", lastInvestigation: false })],
        reads: [
          { id: "R1", badgeId: "B1", badgeNo: "TLD-001", userName: "R. Singh",
            periodStart: "2026-01-01", periodEnd: "2026-03-31", hp10Msv: "3.200", hp007Msv: "3.900",
            reportedOn: "2026-04-20", labRef: "TLD/2026/Q1", investigationFlag: true,
            investigationLevelMsv: "2.958" },
          { id: "R2", badgeId: "B1", badgeNo: "TLD-001", userName: "R. Singh",
            periodStart: "2026-04-01", periodEnd: "2026-06-30", hp10Msv: "1.100", hp007Msv: null,
            reportedOn: "2026-07-20", labRef: null, investigationFlag: false,
            investigationLevelMsv: "2.958" },
        ],
      }) },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    const flagged = await screen.findByTestId("aerb-badge-flagged");
    expect(flagged).toHaveTextContent("3.200 mSv against a level of 2.958 mSv");
    expect(flagged).toHaveTextContent("TLD/2026/Q1");
    /** The un-flagged quarter is not in the alert. */
    expect(flagged).not.toHaveTextContent("1.100");
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/*  PLAN 18c T6 — THE WRITE SURFACE                                                                */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══ WHAT THESE TESTS GUARD, AND WHY EACH ONE IS HERE ═══
 *
 * T6 exists because 18c shipped nine `aerb.registers.manage` routes and no way to reach any of
 * them. The register could be READ and not WRITTEN, which is why the phase is code-complete and
 * still cannot be deployed: an ionising study on a machine with no licence on file is refused from
 * the moment 18c lands (D3), and there was no screen to put a licence there.
 *
 * Three of these legs guard defects the two close-review passes already paid for, in the place
 * where they would come back:
 *
 *   · **the renewal that stopped the machine** — pass 2's WRONG. Filing next year's certificate
 *     must not touch this year's, so the assertion is on the ABSENCE of a status call.
 *   · **`canManage` decided by the server** — 18b's MAJOR B4, one register over.
 *   · **a refusal rendered as the server's own sentence** rather than swallowed into a green tick.
 *
 * And one leg guards a trap this form could have walked into on its own: **a badge reading of ZERO
 * is a real and common result**, so "is this field filled in" cannot be `Number(hp10) > 0`.
 */
const PICKERS = "GET /api/aerb/pickers";
const FILE_LICENCE = "POST /api/aerb/licences";
const RECORD_QA = "POST /api/aerb/qa";
const APPOINT = "POST /api/aerb/persons";
const ISSUE_BADGE = "POST /api/aerb/badges";
const RECORD_READ = "POST /api/aerb/badges/reads";
const SET_LEVEL = "POST /api/aerb/settings/investigation-level";

const PICKER_BOOK = {
  devices: [
    { resourceId: "D1", code: "CT-1", name: "CT machine", modality: "ct", status: "available", licensable: true },
    { resourceId: "D2", code: "DR-1", name: "DR machine", modality: "xray", status: "available", licensable: true },
    { resourceId: "D3", code: "MRI-1", name: "MRI", modality: "mri", status: "available", licensable: false },
  ],
  users: [
    { userId: "U1", fullName: "Manoj Bhat", aerbRole: "rso" },
    { userId: "U2", fullName: "S. Iyer", aerbRole: null },
  ],
};

const GAP_DR = { deviceResourceId: "D2", code: "DR-1", name: "DR machine", modality: "xray" };

/** The recorded requests, so a test can assert what was SENT rather than only what was rendered. */
function sentBodies(key: string): Record<string, unknown>[] {
  const mock = globalThis.fetch as unknown as {
    mock: { calls: [RequestInfo | URL, RequestInit | undefined][] };
  };
  return mock.mock.calls
    .filter(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return `${init?.method ?? "GET"} ${raw.split("?")[0]!}` === key;
    })
    .map(([, init]) => JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>);
}

/** Every request path this render made, method included — for asserting a call did NOT happen. */
function requestedKeys(): string[] {
  const mock = globalThis.fetch as unknown as {
    mock: { calls: [RequestInfo | URL, RequestInit | undefined][] };
  };
  return mock.mock.calls.map(([input, init]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
  });
}

describe("the AERB write surface (18c T6)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /* ═════════════════════ THE DOOR ═════════════════════ */

  /**
   * ═══ THE ONE THAT MATTERS MOST, AND IT IS 18b's B4 IN A SECOND PLACE ═══
   *
   * A quality manager showing an inspector the file holds `aerb.registers.read` and NOT the pen.
   * They must see a register, not five forms that 403. The screen reads no role and compares no
   * permission string: `canManage` is the server's answer and the only input to this decision.
   */
  it("renders NOT ONE write control when the server says the reader may not write", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: false } },
      [GAPS]: { status: 200, body: { rows: [GAP_DR] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
    });
    renderWithProviders(<RadiationSafety />);
    await screen.findByTestId("aerb-gaps");

    for (const id of [
      "aerb-licence-file-open", "aerb-gap-file-D2", "aerb-licence-renew-L1",
      "aerb-licence-suspend-L1", "aerb-licence-surrender-L1", "aerb-licence-status-reason",
    ]) {
      expect(screen.queryByTestId(id), id).not.toBeInTheDocument();
    }
    /** And it does not even ASK for the pickers — they are behind the pen's own permission. */
    expect(requestedKeys()).not.toContain(PICKERS);
  });

  it("renders the write controls when the server says the reader MAY write", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [GAP_DR] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
    });
    renderWithProviders(<RadiationSafety />);
    expect(await screen.findByTestId("aerb-gap-file-D2")).toBeInTheDocument();
    expect(screen.getByTestId("aerb-licence-file-open")).toBeInTheDocument();
    expect(screen.getByTestId("aerb-licence-renew-L1")).toBeInTheDocument();
  });

  /* ═════════════════════ THE LICENCE, AND THE DEPLOY BLOCKER'S OWN WORKFLOW ═════════════════════ */

  /**
   * The gap list is the landing surface (§0 of the go-live runbook): `GET /aerb/licences/gaps` must
   * come back EMPTY before 18c may be deployed, and this is the control that empties it. The
   * machine travels with the click, because an RSO working down twelve rows must not have to find
   * the right machine in a dropdown twelve times.
   */
  it("files a licence from the gap row with the machine ALREADY CHOSEN", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [GAP_DR] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [FILE_LICENCE]: { status: 201, body: { licenceId: "L9" } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-gap-file-D2"));
    await screen.findByTestId("aerb-licence-form");
    await waitFor(() => { expect(screen.getByTestId("aerb-licence-device")).toHaveValue("D2"); });

    await userEvent.type(screen.getByTestId("aerb-licence-no"), "AERB/DR/2026/9");
    fireEvent.change(screen.getByTestId("aerb-licence-valid-from"), { target: { value: "2026-09-04" } });
    fireEvent.change(screen.getByTestId("aerb-licence-valid-to"), { target: { value: "2027-09-03" } });
    await userEvent.selectOptions(screen.getByTestId("aerb-licence-rso"), "U1");
    await userEvent.click(screen.getByTestId("aerb-licence-submit"));

    await waitFor(() => { expect(sentBodies(FILE_LICENCE)).toHaveLength(1); });
    expect(sentBodies(FILE_LICENCE)[0]).toMatchObject({
      deviceResourceId: "D2", licenceNo: "AERB/DR/2026/9",
      validFrom: "2026-09-04", validTo: "2027-09-03", rsoUserId: "U1",
    });
    /** An untouched optional field goes over the wire as null, never as "". */
    expect(sentBodies(FILE_LICENCE)[0]).toMatchObject({ eloraRef: null, typeApprovalRef: null });
    expect(await screen.findByTestId("aerb-outcome")).toHaveTextContent("AERB/DR/2026/9");
  });

  /**
   * ═══ THE RSO FIELD SAYS WHO IS ACTUALLY APPOINTED ═══
   *
   * This dropdown is every active user in the hospital, `fileLicence` does not validate
   * `rsoUserId` and the column is nullish — so a statutory AERB licence could be filed naming the
   * cashier as the Radiological Safety Officer with nothing refusing and nothing warning. Measured
   * on a stand-up: a filed licence named a radiologist who held no `radiation_safety_officer` role
   * and had no appointment row at all.
   *
   * Nobody is filtered out and nothing is refused — a certificate may legitimately be filed before
   * the appointment paperwork, and `PersonForm` uses this same list to appoint the FIRST RSO, which
   * a filtered list could never do. The server states the fact and the form renders it, exactly as
   * it already does for a machine AERB does not licence.
   */
  it("marks the people with no AERB appointment in the licence form's RSO field", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [GAP_DR] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-gap-file-D2"));
    await screen.findByTestId("aerb-licence-form");

    const options = within(screen.getByTestId("aerb-licence-rso")).getAllByRole("option");
    const labelled = Object.fromEntries(
      options.filter((o) => (o as HTMLOptionElement).value).map((o) => [(o as HTMLOptionElement).value, o.textContent]),
    );
    expect(labelled.U1).toBe("Manoj Bhat");
    expect(labelled.U2).toContain("no AERB appointment on file");
    /** Marked, not removed — the appointment door needs the unappointed. */
    expect(Object.keys(labelled).sort()).toEqual(["U1", "U2"]);
  });

  /**
   * ═══ THE RENEWAL, AND THIS ASSERTION IS ON AN ABSENCE ON PURPOSE ═══
   *
   * Pass 2 of 18c's close review found pass 1's renewal fix **stopped the machine it was written to
   * keep running**: it surrendered the outgoing certificate the moment the incoming one was filed,
   * so the CT had no licence in force on 20 November and every ionising study on it was refused
   * from the day the paperwork arrived until 1 January — with no way back, because `surrendered` is
   * terminal. The regression would come back here, as a screen that "helpfully" closed the old row.
   *
   * So: the form defaults to the day AFTER the outgoing certificate expires, it says the old one
   * stays in force, and **no status call is made at all.**
   */
  it("a renewal files the NEXT window and never touches the certificate in force", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [FILE_LICENCE]: { status: 201, body: { licenceId: "L2" } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-licence-renew-L1"));

    const note = await screen.findByTestId("aerb-licence-renewal-note");
    expect(note).toHaveTextContent("AERB/CT/2026/1");
    expect(note).toHaveTextContent("2026-12-31");
    expect(note).toHaveTextContent("stays in force");
    /** The next window opens the day after this one closes — 2026-12-31 → 2027-01-01. */
    expect(screen.getByTestId("aerb-licence-valid-from")).toHaveValue("2027-01-01");

    await userEvent.type(screen.getByTestId("aerb-licence-no"), "AERB/CT/2027/1");
    fireEvent.change(screen.getByTestId("aerb-licence-valid-to"), { target: { value: "2027-12-31" } });
    await userEvent.click(screen.getByTestId("aerb-licence-submit"));

    await waitFor(() => { expect(sentBodies(FILE_LICENCE)).toHaveLength(1); });
    expect(sentBodies(FILE_LICENCE)[0]).toMatchObject({
      deviceResourceId: "D1", validFrom: "2027-01-01", validTo: "2027-12-31",
    });
    /** THE POINT: nothing was posted against the outgoing licence. */
    expect(requestedKeys()).not.toContain("POST /api/aerb/licences/L1/status");
    expect(sentBodies(FILE_LICENCE)[0]).not.toHaveProperty("supersedesLicenceId");
  });

  /**
   * `device_not_licensed` and `licence_already_active` are sentences with actions in them. A
   * console that rendered "Something went wrong" would be throwing away the only part of the
   * answer the RSO can act on.
   */
  it("shows the server's OWN refusal, code and all, and files nothing", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [FILE_LICENCE]: {
        status: 409,
        body: {
          statusCode: 409, code: "licence_already_active",
          message: "CT-1 already holds a certificate covering 2027-01-01",
        },
      },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-licence-renew-L1"));
    await screen.findByTestId("aerb-licence-form");
    await userEvent.type(screen.getByTestId("aerb-licence-no"), "AERB/CT/2027/1");
    fireEvent.change(screen.getByTestId("aerb-licence-valid-to"), { target: { value: "2027-12-31" } });
    await userEvent.click(screen.getByTestId("aerb-licence-submit"));

    const error = await screen.findByTestId("aerb-licence-error");
    expect(error).toHaveTextContent("already holds a certificate covering 2027-01-01");
    expect(error).toHaveTextContent("licence_already_active");
    /** The form is still open with the entry in it, and no success line was printed. */
    expect(screen.getByTestId("aerb-licence-form")).toBeInTheDocument();
    expect(screen.queryByTestId("aerb-outcome")).not.toBeInTheDocument();
  });

  /* ═════════════════════ THE QA REGISTER, AND THE MACHINE IT STOPS ═════════════════════ */

  /**
   * D4 — a fail drives the device to `qa_blocked` in the same transaction and only a later pass
   * returns it. Correct, and also a consequence nobody should discover after the fact.
   */
  it("warns that a FAIL takes the machine out of service, naming it, before the record is sent", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [QA]: { status: 200, body: { rows: [], canManage: true } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    await userEvent.click(await screen.findByTestId("aerb-qa-record-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-qa-device")).toBeInTheDocument(); });

    expect(screen.queryByTestId("aerb-qa-fail-warning")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId("aerb-qa-device"), "D1");
    await userEvent.selectOptions(screen.getByTestId("aerb-qa-result"), "fail");

    const warning = await screen.findByTestId("aerb-qa-fail-warning");
    expect(warning).toHaveTextContent("CT-1");
    expect(warning).toHaveTextContent("OUT OF SERVICE");
    expect(sentBodies(RECORD_QA)).toHaveLength(0);
  });

  it("records the fail and says the machine has stopped", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [QA]: { status: 200, body: { rows: [], canManage: true } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [RECORD_QA]: { status: 201, body: { recordId: "Q9", blocked: true, releasedRecordId: null } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    await userEvent.click(await screen.findByTestId("aerb-qa-record-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-qa-device")).toBeInTheDocument(); });
    await userEvent.selectOptions(screen.getByTestId("aerb-qa-device"), "D1");
    await userEvent.selectOptions(screen.getByTestId("aerb-qa-result"), "fail");
    await userEvent.type(screen.getByTestId("aerb-qa-type"), "AERB annual QA");
    await userEvent.type(screen.getByTestId("aerb-qa-performed-by"), "S. Iyer, medical physicist");
    await userEvent.click(screen.getByTestId("aerb-qa-submit"));

    await waitFor(() => { expect(sentBodies(RECORD_QA)).toHaveLength(1); });
    expect(sentBodies(RECORD_QA)[0]).toMatchObject({
      deviceResourceId: "D1", result: "fail", qaType: "AERB annual QA",
      performedBy: "S. Iyer, medical physicist",
    });
    expect(await screen.findByTestId("aerb-outcome")).toHaveTextContent("CT-1 is out of service");
  });

  /**
   * A fail on an occupied machine is REFUSED — stopping a tube with a patient on the table is a
   * decision a person makes at the console, not one a register makes behind their back. The record
   * rolls back with it, and the RSO must be told that rather than shown a green tick.
   */
  it("shows the `already_occupied` refusal instead of swallowing it into a success", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [QA]: { status: 200, body: { rows: [], canManage: true } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [RECORD_QA]: {
        status: 409,
        body: { statusCode: 409, code: "already_occupied", message: "CT-1 has a study in progress" },
      },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-qa"));
    await userEvent.click(await screen.findByTestId("aerb-qa-record-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-qa-device")).toBeInTheDocument(); });
    await userEvent.selectOptions(screen.getByTestId("aerb-qa-device"), "D1");
    await userEvent.selectOptions(screen.getByTestId("aerb-qa-result"), "fail");
    await userEvent.type(screen.getByTestId("aerb-qa-type"), "AERB annual QA");
    await userEvent.type(screen.getByTestId("aerb-qa-performed-by"), "S. Iyer");
    await userEvent.click(screen.getByTestId("aerb-qa-submit"));

    expect(await screen.findByTestId("aerb-qa-error")).toHaveTextContent("CT-1 has a study in progress");
    expect(screen.queryByTestId("aerb-outcome")).not.toBeInTheDocument();
  });

  /* ═════════════════════ THE BADGES ═════════════════════ */

  const t6Badge = {
    badgeId: "B1", userId: "U1", userName: "R. Singh", badgeNo: "TLD-001",
    issuedOn: "2026-01-01", returnedOn: null, status: "active",
    lastPeriodEnd: "2026-03-31", lastHp10Msv: "1.400", lastInvestigation: false,
    workerYtdMsv: "1.400", workerFiveYearMsv: "1.400", worstYear: "2026", worstYearMsv: "1.400",
    overAnnualLimit: false, overFiveYearLimit: false, readCount: 1,
  };
  const t6BadgeBook = (over: Record<string, unknown> = {}) => ({
    rows: [t6Badge], gaps: [], reads: [],
    limits: { annualMsv: 30, fiveYearAverageMsv: 20, fiveYearTotalMsv: 100 },
    investigationLevelMsvPerMonth: 1, canManage: true, ...over,
  });

  /**
   * ═══ ZERO IS A READING ═══
   *
   * The commonest TLD result in a well-run department is "nothing detectable", and the obvious way
   * to write "has this field been filled in" — `Number(hp10) > 0` — rejects exactly that. A form
   * that cannot record a zero forces the RSO to invent a number or skip the entry, and a skipped
   * entry becomes a badge gap the register then reports as unmonitored exposure.
   */
  it("accepts a badge reading of ZERO — the commonest result there is", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: t6BadgeBook() },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [RECORD_READ]: { status: 201, body: { readId: "R9", investigation: false, investigationLevelMsv: 1 } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    await userEvent.click(await screen.findByTestId("aerb-badge-read-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-read-badge")).toBeInTheDocument(); });

    await userEvent.selectOptions(screen.getByTestId("aerb-read-badge"), "B1");
    fireEvent.change(screen.getByTestId("aerb-read-period-start"), { target: { value: "2026-04-01" } });
    fireEvent.change(screen.getByTestId("aerb-read-period-end"), { target: { value: "2026-06-30" } });
    await userEvent.type(screen.getByTestId("aerb-read-hp10"), "0");

    expect(screen.getByTestId("aerb-read-submit")).toBeEnabled();
    await userEvent.click(screen.getByTestId("aerb-read-submit"));
    await waitFor(() => { expect(sentBodies(RECORD_READ)).toHaveLength(1); });
    expect(sentBodies(RECORD_READ)[0]).toMatchObject({
      badgeId: "B1", periodStart: "2026-04-01", periodEnd: "2026-06-30", hp10Msv: 0,
      /** An untouched optional field is null on this form too — including `remarks`, which every
       *  other form on the screen offered and this one used to hardcode away. */
      hp007Msv: null, labRef: null, remarks: null,
    });
  });

  it("reports a reading that raised the investigation flag, with the level it was measured against", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: t6BadgeBook() },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [RECORD_READ]: { status: 201, body: { readId: "R9", investigation: true, investigationLevelMsv: 3 } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    await userEvent.click(await screen.findByTestId("aerb-badge-read-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-read-badge")).toBeInTheDocument(); });
    await userEvent.selectOptions(screen.getByTestId("aerb-read-badge"), "B1");
    fireEvent.change(screen.getByTestId("aerb-read-period-start"), { target: { value: "2026-04-01" } });
    fireEvent.change(screen.getByTestId("aerb-read-period-end"), { target: { value: "2026-06-30" } });
    await userEvent.type(screen.getByTestId("aerb-read-hp10"), "4.2");
    await userEvent.click(screen.getByTestId("aerb-read-submit"));

    const outcome = await screen.findByTestId("aerb-outcome");
    expect(outcome).toHaveTextContent("4.2");
    expect(outcome).toHaveTextContent("3 mSv investigation level");
  });

  it("issues a badge, and sets the investigation level the statutory limits are NOT", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [BADGES]: { status: 200, body: t6BadgeBook() },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [ISSUE_BADGE]: { status: 201, body: { badgeId: "B9" } },
      [SET_LEVEL]: { status: 201, body: { ok: true } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-badges"));
    await userEvent.click(await screen.findByTestId("aerb-badge-issue-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-badge-user")).toBeInTheDocument(); });
    await userEvent.selectOptions(screen.getByTestId("aerb-badge-user"), "U2");
    await userEvent.type(screen.getByTestId("aerb-badge-no"), "TLD-014");
    await userEvent.click(screen.getByTestId("aerb-badge-issue-submit"));
    await waitFor(() => { expect(sentBodies(ISSUE_BADGE)).toHaveLength(1); });
    expect(sentBodies(ISSUE_BADGE)[0]).toMatchObject({ userId: "U2", badgeNo: "TLD-014" });
    expect(await screen.findByTestId("aerb-outcome")).toHaveTextContent("S. Iyer");

    await userEvent.click(screen.getByTestId("aerb-level-open"));
    const level = await screen.findByTestId("aerb-level-value");
    /** D10 — it opens on the number in force, which the badge book already carries. */
    expect(level).toHaveValue(1);
    fireEvent.change(level, { target: { value: "0.5" } });
    await userEvent.click(screen.getByTestId("aerb-level-submit"));
    await waitFor(() => { expect(sentBodies(SET_LEVEL)).toHaveLength(1); });
    expect(sentBodies(SET_LEVEL)[0]).toMatchObject({ perMonthMsv: 0.5 });
  });

  /* ═════════════════════ THE PEOPLE ═════════════════════ */

  it("appoints the RSO and ends an appointment", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PERSONS]: {
        status: 200,
        body: {
          canManage: true,
          rows: [{
            id: "P1", userId: "U1", userName: "Manoj Bhat", personRole: "rso", approvalRef: "AERB/RSO/91",
            qualification: "RSO Level II", validFrom: "2026-01-01", validTo: null, active: true,
          }],
        },
      },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      [APPOINT]: { status: 201, body: { personId: "P9" } },
      "POST /api/aerb/persons/P1/end": { status: 201, body: { ok: true } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-people"));
    await userEvent.click(await screen.findByTestId("aerb-person-appoint-open"));
    await waitFor(() => { expect(screen.getByTestId("aerb-person-user")).toBeInTheDocument(); });

    await userEvent.selectOptions(screen.getByTestId("aerb-person-role"), "physicist");
    await userEvent.selectOptions(screen.getByTestId("aerb-person-user"), "U2");
    await userEvent.type(screen.getByTestId("aerb-person-qualification"), "M.Sc. Medical Physics, RSO Level III");
    await userEvent.click(screen.getByTestId("aerb-person-submit"));
    await waitFor(() => { expect(sentBodies(APPOINT)).toHaveLength(1); });
    expect(sentBodies(APPOINT)[0]).toMatchObject({
      userId: "U2", personRole: "physicist", qualification: "M.Sc. Medical Physics, RSO Level III",
      /** An open-ended appointment runs until it is ended, not until a date. */
      validTo: null,
    });

    await userEvent.click(screen.getByTestId("aerb-person-end-P1"));
    await waitFor(() => { expect(requestedKeys()).toContain("POST /api/aerb/persons/P1/end"); });
  });

  /* ═════════════════════ THE ASYMMETRY LEG ═════════════════════ */

  /**
   * ═══ THE ONE REGISTER WITH NO WRITER, AND IT IS THE PHI ONE ═══
   *
   * D5 — dose rows are written by the SOURCE inside its own transaction (`recordDose`, called from
   * `recordAcquired`), never typed into a screen. D7 makes the register PHI. So the dose tab gets
   * no form, and in particular no patient field: pass 2 of the close review found the UHID going
   * out raw beside a confidential patient's alias, and the fix withholds it. A write surface here
   * would be the obvious way to hand it straight back.
   */
  it("gives the dose register NO writer at all — it is written by the source, and it is PHI", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [DOSES]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-tab-dose"));
    await screen.findByTestId("aerb-dose-empty");

    for (const id of [
      "aerb-licence-form", "aerb-qa-form", "aerb-person-form",
      "aerb-badge-issue-form", "aerb-badge-read-form", "aerb-level-form",
    ]) {
      expect(screen.queryByTestId(id), id).not.toBeInTheDocument();
    }
    /** The only input on this tab is the over-DRL filter. No patient, no UHID, no dose entry. */
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  /* ═════════════════════ SURRENDER IS TERMINAL ═════════════════════ */

  /**
   * ═══ THE ONE-CLICK IRREVERSIBLE ACT ═══
   *
   * `surrendered` has no way back and the machine is unlicensed from that instant — every ionising
   * study on it refused. It sat one click from `Suspend`, on a row the RSO scans past at speed
   * while working down the gap list at go-live, which is the exact user this screen exists for.
   * Arming is a guard against a SLIP, not against a decision.
   */
  it("does not surrender on the first click — it arms, and posts nothing", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      "POST /api/aerb/licences/L1/status": { status: 201, body: { ok: true } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-licence-surrender-L1"));

    expect(requestedKeys()).not.toContain("POST /api/aerb/licences/L1/status");
    expect(screen.getByTestId("aerb-licence-surrender-confirm-L1")).toBeInTheDocument();
    expect(screen.getByTestId("aerb-licence-decommission-ref-L1")).toBeInTheDocument();
  });

  it("surrenders on the SECOND click, carrying the decommissioning reference AERB requires", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      "POST /api/aerb/licences/L1/status": { status: 201, body: { ok: true } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-licence-surrender-L1"));
    await userEvent.type(screen.getByTestId("aerb-licence-decommission-ref-L1"), "DECOM/2026/14");
    await userEvent.click(screen.getByTestId("aerb-licence-surrender-confirm-L1"));

    await waitFor(() => {
      expect(sentBodies("POST /api/aerb/licences/L1/status")).toHaveLength(1);
    });
    expect(sentBodies("POST /api/aerb/licences/L1/status")[0]).toMatchObject({
      to: "surrendered", decommissionRef: "DECOM/2026/14",
    });
  });

  it("lets the RSO back out of an armed surrender, having posted nothing", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      "POST /api/aerb/licences/L1/status": { status: 201, body: { ok: true } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-licence-surrender-L1"));
    await userEvent.click(screen.getByTestId("aerb-licence-surrender-cancel-L1"));

    expect(requestedKeys()).not.toContain("POST /api/aerb/licences/L1/status");
    expect(screen.queryByTestId("aerb-licence-surrender-confirm-L1")).not.toBeInTheDocument();
    expect(screen.getByTestId("aerb-licence-surrender-L1")).toBeInTheDocument();
  });

  /** The REVERSIBLE acts must stay one click — a guard on everything is a guard on nothing. */
  it("still suspends on a single click, because suspension is reversible", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [licence()], canManage: true } },
      [GAPS]: { status: 200, body: { rows: [] } },
      [PICKERS]: { status: 200, body: PICKER_BOOK },
      "POST /api/aerb/licences/L1/status": { status: 201, body: { ok: true } },
    });
    renderWithProviders(<RadiationSafety />);
    await userEvent.click(await screen.findByTestId("aerb-licence-suspend-L1"));
    await waitFor(() => {
      expect(sentBodies("POST /api/aerb/licences/L1/status")).toHaveLength(1);
    });
    expect(sentBodies("POST /api/aerb/licences/L1/status")[0]).toMatchObject({ to: "suspended" });
  });
});
