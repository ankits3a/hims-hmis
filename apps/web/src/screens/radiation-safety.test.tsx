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

  /** The three registers T3–T5 build are declared and disabled, so the shape is visible from here. */
  it("the three unbuilt tabs are present and disabled", async () => {
    mockRoutes({
      [LICENCES]: { status: 200, body: { rows: [] } },
      [GAPS]: { status: 200, body: { rows: [] } },
    });
    renderWithProviders(<RadiationSafety />);
    for (const k of ["dose", "badges", "calendar"]) {
      expect(await screen.findByTestId(`aerb-tab-${k}`)).toBeDisabled();
    }
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
