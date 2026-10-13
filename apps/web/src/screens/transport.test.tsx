import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MyTasks } from "./my-tasks";
import { TransportBoard } from "./transport-board";
import { TransportRequest } from "./transport-request";
import type { MyTasksView, TaskCard, TransportBoardView, TransportDetail } from "@hmis/contracts";

/**
 * E1.6 TRANSPORT (issue #723) — the porter's card (details, escort and cylinder steps, the wristband scan at Done),
 * the request sheet, and the supervisor's board (late first, escort waiting in words, no patient name). Server stubbed.
 */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const card = (over: Partial<TaskCard>): TaskCard => ({
  id: "m1", kind: "patient_move", label: "Patient move", priority: "routine", state: "accepted",
  placeResourceId: "bed1", placeName: "ICU-3", placeCode: "ICU-3", floorName: "Floor 2", note: null,
  dueAt: iso(20), createdAt: iso(-5), assigneeId: "me", assigneeName: "me", proofNeeded: "scan", verifyRequired: false,
  mergedCount: 0, escalatedRung: 0, version: 3, ...over,
});
const detail = (over: Partial<TransportDetail>): TransportDetail => ({
  taskId: "m1", kind: "patient_move", fromName: "ICU-3", toName: "CT scan", mode: "bed", oxygen: true, oxygenChecked: false,
  monitor: true, isolation: "none", reason: "imaging", escortRequired: true, escortReason: "critical_care_bed", escortState: "waiting",
  escortName: null, patientName: "Ram Kumar", admissionNo: "IP-26-00012", handedOverAt: null, ...over,
});
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

describe("transport (E1.6)", () => {
  const posted: { url: string; body: unknown }[] = [];
  let mine: MyTasksView;
  let details: TransportDetail[];
  let board: TransportBoardView;
  let refuse: string | null;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    refuse = null;
    mine = { serverNow: new Date(NOW).toISOString(), mine: [card({})], pool: [] };
    details = [detail({})];
    board = {
      serverNow: new Date(NOW).toISOString(),
      rows: [
        { taskId: "b1", kind: "patient_move", state: "assigned", priority: "routine", fromName: "W-12", toName: "OT-1", mode: "stretcher",
          oxygen: false, monitor: false, isolation: "none", escortState: "not_needed", porterInitials: "R. S.", createdAt: iso(-40), dueAt: iso(-10), late: true, version: 2 },
        { taskId: "b2", kind: "patient_move", state: "accepted", priority: "urgent", fromName: "ICU-3", toName: "CT scan", mode: "bed",
          oxygen: true, monitor: true, isolation: "contact", escortState: "waiting", porterInitials: null, createdAt: iso(-5), dueAt: iso(25), late: false, version: 2 },
      ],
      workers: [{ userId: "w1", name: "Ramesh Singh", onDuty: true, open: 1, inProgress: 0 }],
      counts: { open: 2, late: 1, waitingEscort: 1, pool: 0, notShown: 0 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
        if (refuse !== null) return json({ code: refuse, message: "x", fix: "y" }, 409);
        if (raw.endsWith("/transport/requests")) return json({ taskId: "n1", state: "assigned", version: 2, merged: false, escortRequired: true });
        return json({ id: "m1", state: "done", version: 4, taskId: "m1" });
      }
      if (raw.endsWith("/tasks/mine")) return json(mine);
      if (raw.includes("/transport/details")) return json({ details });
      if (raw.endsWith("/transport/escorts")) return json([{ userId: "n1", name: "Sister Anita" }]);
      if (raw.endsWith("/transport/board")) return json(board);
      if (raw.includes("/transport/patients")) {
        return json([{ admissionId: "a1", admissionNo: "IP-26-00012", name: "Ram Kumar", uhid: "U1", bedId: "bed1", bedName: "ICU-3", criticalCare: true }]);
      }
      if (raw.endsWith("/transport/places")) return json([{ id: "ct", kind: "room", code: "CT", name: "CT scan" }]);
      if (raw.endsWith("/auth/me")) {
        return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["tasks.work", "transport.work", "transport.request", "transport.manage"], scoped: { department: {}, floor: {} } } });
      }
      return json({});
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the porter's card shows from → to, the patient, oxygen and the escort waiting in words, with the two steps before Start", async () => {
    renderWithProviders(<MyTasks />);
    const c = await screen.findByTestId("transport-m1");
    expect(within(c).getByTestId("transport-route")).toHaveTextContent("ICU-3→CT scan");
    expect(within(c).getByTestId("transport-patient")).toHaveTextContent("Ram Kumar · IP-26-00012");
    expect(within(c).getByTestId("transport-o2")).toHaveTextContent("Oxygen · check cylinder");
    expect(within(c).getByTestId("transport-escort")).toHaveTextContent("Waiting for escort");
    await userEvent.click(within(c).getByTestId("o2-check"));
    expect(posted.map((p) => p.url)).toEqual([expect.stringContaining("/transport/tasks/m1/oxygen-check")]);
    await userEvent.click(within(c).getByTestId("escort-add"));
    await userEvent.click(await within(c).findByText("Sister Anita"));
    expect(posted[1]).toEqual({ url: expect.stringContaining("/transport/tasks/m1/escort"), body: { escortUserId: "n1" } });
  });

  it("Start refused for no escort shows the rule in a few words", async () => {
    refuse = "escort_required";
    renderWithProviders(<MyTasks />);
    await userEvent.click(within(await screen.findByTestId("transport-m1")).getByTestId("task-start"));
    expect(await screen.findByTestId("my-tasks-notice")).toHaveTextContent("Escort needed · Add escort");
  });

  it("at Done the porter scans the wristband: the code goes as scan proof; a wrong patient is refused loudly", async () => {
    mine = { ...mine, mine: [card({ state: "in_progress" })] };
    details = [detail({ escortState: "with_escort", escortName: "Sister Anita", oxygenChecked: true })];
    renderWithProviders(<MyTasks />);
    const c = await screen.findByTestId("transport-m1");
    expect(within(c).getByTestId("task-done")).toBeDisabled();
    await userEvent.type(within(c).getByTestId("band-input"), "IP-26-00012-1{Enter}");
    expect(posted[0]).toEqual({ url: expect.stringContaining("/tasks/m1/done"), body: { version: 3, proof: { kind: "scan", code: "IP-26-00012-1" } } });
    refuse = "wrong_patient";
    await userEvent.click(within(c).getByTestId("task-done"));
    expect(await screen.findByTestId("my-tasks-notice")).toHaveTextContent("WRONG PATIENT · stop");
  });

  it("a patient move in progress always ends at the wristband scan, even before its details load", async () => {
    mine = { ...mine, mine: [card({ state: "in_progress" })] };
    details = [];
    renderWithProviders(<MyTasks />);
    const c = await screen.findByTestId("task-m1");
    expect(within(c).getByTestId("band-scan")).toBeInTheDocument();
    await userEvent.type(within(c).getByTestId("band-input"), "IP-26-00012-1{Enter}");
    expect(posted[0]!.body).toEqual({ version: 3, proof: { kind: "scan", code: "IP-26-00012-1" } });
  });

  it("a tap-proof task's Done sends the tap", async () => {
    mine = { ...mine, mine: [card({ id: "s1", kind: "sample_run", label: "Sample run", state: "in_progress", proofNeeded: "tap" })] };
    details = [detail({ taskId: "s1", kind: "sample_run", mode: null, oxygen: false, monitor: false, escortRequired: false, escortState: "not_needed", patientName: null, admissionNo: null })];
    renderWithProviders(<MyTasks />);
    await userEvent.click(within(await screen.findByTestId("transport-s1")).getByTestId("task-done"));
    expect(posted[0]!.body).toEqual({ version: 3, proof: { kind: "tap" } });
  });

  it("the request sheet: a critical-care patient says escort required; the request posts the move", async () => {
    renderWithProviders(<TransportRequest />);
    await userEvent.click(await screen.findByTestId("patient-a1"));
    expect(screen.getByTestId("escort-forced")).toHaveTextContent("Critical-care bed: escort required");
    await userEvent.selectOptions(await screen.findByTestId("to-place"), "ct");
    await userEvent.click(screen.getByTestId("mode-bed"));
    await userEvent.click(screen.getByTestId("oxygen"));
    await userEvent.click(screen.getByTestId("request-send"));
    expect(posted[0]!.body).toMatchObject({ kind: "patient_move", admissionId: "a1", toResourceId: "ct", mode: "bed", oxygen: true });
    expect(await screen.findByTestId("request-answer")).toHaveTextContent("Porter requested · escort needed");
  });

  it("the board: late first, escort waiting in words, no patient name", async () => {
    renderWithProviders(<TransportBoard />);
    const rows = await within(await screen.findByTestId("tb-list")).findAllByTestId(/^tb-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["tb-row-b1", "tb-row-b2"]);
    expect(within(rows[1]!).getByTestId("tb-escort-state")).toHaveTextContent("Waiting for escort");
    expect(screen.getByTestId("tb-escort")).toHaveTextContent("1waiting for escort");
    expect(screen.queryByText(/Ram Kumar/)).toBeNull();
  });
});
