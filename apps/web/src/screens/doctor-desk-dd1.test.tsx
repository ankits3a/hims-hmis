import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DoctorDeskUnit } from "./doctor-desk-unit";
import { DoctorDeskNow } from "./doctor-desk-now";
import { DoctorDeskProfessor } from "./doctor-desk-professor";
import { DoctorDeskRatings } from "./doctor-desk-ratings";
import type { WireMyRatings, WireNow, WireProfessor, WireUnitBoard } from "../lib/doctor-desk-api";

/**
 * DD-1 — the Unit board, the two phone boards and my ratings against the server's wire (spec
 * SPEC-doctor-desk-dd1-2026-10-16). 10:00 IST, Tuesday 6 October, General Medicine Unit II.
 */
const AT = "2026-10-06T04:30:00.000Z";
const YOU = { userId: "hd", name: "Dr. Test Head", grade: "professor" };
const UNIT = { teamId: "u2", name: "General Medicine Unit II", short: "Unit II", departmentName: "General Medicine" };
const SCOPE_UNIT = { level: "unit" as const, officiating: false, departmentId: "med", departmentName: "General Medicine" };

const BOARD: WireUnitBoard = {
  at: AT, istDate: "2026-10-06", you: YOU, unit: UNIT, scope: SCOPE_UNIT,
  owed: [
    { key: "visit:e7", kind: "visit_open", what: "visit_open", holder: { userId: "jr", name: "Dr. Test Junior" }, since: "2026-10-04T18:30:00.000Z", dueAt: "2026-10-05T18:30:00.000Z", nudgedByMe: false, mayMove: true },
    { key: "lab_critical:c9", kind: "lab_critical", what: "lab_critical", holder: { userId: "sr", name: "Dr. Test Senior" }, since: "2026-10-06T04:05:00.000Z", dueAt: "2026-10-06T04:20:00.000Z", nudgedByMe: true, mayMove: true, acked: true, movedBy: { userId: "hd", name: "Dr. Test Head" } },
  ],
  moveTo: [
    { userId: "hd", name: "Dr. Test Head", role: "head" }, { userId: "sr", name: "Dr. Test Senior", role: "senior_resident" },
    { userId: "jr", name: "Dr. Test Junior", role: "junior_resident" },
  ],
  people: [
    { userId: "sr", name: "Dr. Test Senior", role: "senior_resident", officiating: false, onDutyUntil: "2026-10-06T11:30:00.000Z", open: 1, visitsDone: 41, criticalToActMedian: 12, criticalActs: 2, lastWord: null },
    { userId: "jr", name: "Dr. Test Junior", role: "junior_resident", officiating: false, onDutyUntil: null, open: 1, visitsDone: 30, criticalToActMedian: null, criticalActs: 0, lastWord: { rating: "good", workDate: "2026-10-05" } },
  ],
  units: [],
};
const NOW: WireNow = {
  at: AT, istDate: "2026-10-06", you: { userId: "sr", name: "Dr. Test Senior", grade: "senior_resident" }, unit: UNIT,
  scope: { ...SCOPE_UNIT, level: "member" },
  now: [
    { key: "lab_critical:c1", kind: "lab_critical", tab: "critical", patient: { id: "pa", uhid: "HMS-1", name: "Patient Alpha", restricted: false }, params: { analyte: "Potassium", value: "6.4", unit: "mmol/L" }, at: "2026-10-06T04:20:00.000Z", goneHome: false, source: { module: "lab", ref: "r1" }, href: "/patients/pa" },
    { key: "lab_critical:c2", kind: "lab_critical", tab: "critical", patient: { id: "pc", uhid: null, name: "Patient X-7", restricted: true }, params: { analyte: "Sodium", value: "118", unit: "mmol/L" }, at: "2026-10-06T03:20:00.000Z", goneHome: false, source: { module: "lab", ref: "r2" }, href: "/patients/pc", acked: true },
  ],
  today: [
    { key: "imaging_unread:rep1", kind: "imaging_unread", tab: "pending", patient: { id: "pb", uhid: "HMS-2", name: "Patient Beta", restricted: false }, params: { study: "CT abdomen" }, at: "2026-10-06T03:00:00.000Z", goneHome: false, source: { module: "radiology", ref: "rep1" }, href: "/opd/consult" },
  ],
};
const PROF: WireProfessor = {
  at: AT, istDate: "2026-10-06", you: YOU, unit: UNIT, scope: SCOPE_UNIT,
  owed: BOARD.owed.map((o) => { const { mayMove, ...rest } = o; void mayMove; return rest; }), owedTotal: 8, past: 2,
  handled: [{ key: "lab_critical:c5", analyte: "Potassium", value: "6.4", unit: "mmol/L", patient: { id: "pa", uhid: "HMS-1", name: "Patient Alpha", restricted: false }, by: { userId: "sr", name: "Dr. Test Senior" }, choice: "treatment_started", minutes: 7, actedAt: "2026-10-06T02:54:00.000Z" }],
  toRate: [{ workKind: "opd_visit", workId: "e11", visitNo: "V2610060011", workDate: "2026-10-06", patient: { id: "pa", uhid: "HMS-1", name: "Patient Alpha", restricted: false }, resident: { userId: "jr", name: "Dr. Test Junior", role: "junior_resident" }, completedAt: "2026-10-06T04:00:00.000Z", mine: null }],
};
const COVER = {
  requestId: "cv1", kind: "swap", status: "accepted", crossUnit: false,
  owner: { userId: "jr", name: "Dr. Test Junior" }, counterpart: { userId: "jr2", name: "Dr. Test Resident" }, requestedBy: { userId: "jr", name: "Dr. Test Junior" },
  duty: { assignmentId: "a1", userId: "jr", positionKey: "ward_jr", positionLabel: "Ward JR", startsAt: AT, endsAt: AT, istDate: "2026-10-10", night: true, mode: null, kind: "duty", departmentId: "med", teamId: "u2", teamName: "Unit II" },
  give: null, note: null, requestedAt: AT, answeredAt: AT, decidedBy: null, decidedAt: null, refusedRule: null, check: null,
  youMay: { answer: false, approve: true, withdraw: false },
};
const MONEY = /fee|paid|paise|price|bypass|payer|pmjay|₹|rupee|invoice|bill/i;

describe("Doctor Desk DD-1", () => {
  const posted: { url: string; body: unknown }[] = [];
  let toggles: { status: number; body: unknown } = { status: 200, body: { proactive: false, draftProse: false } };
  let ratings: WireMyRatings;
  let board: WireUnitBoard = BOARD;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    board = BOARD;
    toggles = { status: 200, body: { proactive: false, draftProse: false } };
    ratings = { month: "2026-10", counts: { good: 2, fine: 1, needs_rework: 0, total: 3 }, share: { you: null, department: null, hospital: null }, recent: [{ workDate: "2026-10-05", workKind: "opd_visit", rating: "fine", reason: null }] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posted.push({ url: raw, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (raw.endsWith("/opd/consult/copilot-settings")) return new Response(JSON.stringify(toggles.body), { status: toggles.status, headers: { "Content-Type": "application/json" } });
      const body = raw.endsWith("/auth/me") ? { actor: { type: "user", id: "hd" }, permissions: { hospital: ["opd.consult", "roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/doctor-desk/unit") ? board
            : raw.endsWith("/doctor-desk/now") ? NOW
              : raw.endsWith("/doctor-desk/professor") ? PROF
                : raw.endsWith("/doctor-desk/ratings/mine") ? ratings
                  : raw.includes("/roster/my-duties") ? { at: AT, days: ["2026-10-06", "2026-10-07"], you: { name: null, grade: null, positionKey: null, unitName: null, departmentName: null }, duties: [], onTake: { teamId: "u2", name: "Unit II", endsAt: "2026-10-07T02:30:00.000Z" }, mySr: null, requests: [] }
                    : raw.endsWith("/roster/covers") ? [COVER]
                      : raw.endsWith("/approvals") ? { total: 2, items: [
                        { id: "ap1", typeKey: "patient_merge", requesterName: "Dr. Test Senior", amountPaise: null, requestedAt: AT, status: "pending" },
                        { id: "ap2", typeKey: "billing_discount", requesterName: "Desk", amountPaise: 50000, requestedAt: AT, status: "pending" },
                      ] }
                        : raw.endsWith("/acts") ? { actId: "x1", minutes: 9 }
                          : raw.endsWith("/clocks/move") ? { moveId: "m1" }
                            : raw.endsWith("/decide") ? { status: "approved", ruleKey: null }
                              : raw.endsWith("/doctor-desk/ratings") ? { ratingId: "r1" }
                                : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the unit board lists what the unit owes oldest first; Move gives a row to a chosen member", async () => {
    renderWithProviders(<DoctorDeskUnit />);
    const owes = await screen.findByTestId("dd-owes");
    const rows = within(owes).getAllByTestId(/^dd-owe-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["dd-owe-visit:e7", "dd-owe-lab_critical:c9"]);
    expect(screen.getByTestId("dd-owe-lab_critical:c9")).toHaveTextContent("read back · no act yet");
    expect(screen.getByTestId("dd-owe-lab_critical:c9")).toHaveTextContent("given by Dr. Test Head");
    await userEvent.click(screen.getByTestId("dd-move-visit:e7"));
    const select = screen.getByTestId("dd-move-to-visit:e7");
    expect(within(select).queryByText(/Dr. Test Junior/)).toBeNull(); // the holder is not offered
    await userEvent.selectOptions(select, "sr");
    await userEvent.click(screen.getByTestId("dd-move-go-visit:e7"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/doctor-desk/clocks/move", body: { rowKey: "visit:e7", toUserId: "sr" } }));
    expect(screen.getByTestId("dd-person-sr")).toHaveTextContent("12 min · 2 acts");
    expect(screen.getByTestId("dd-person-jr")).toHaveTextContent("Good · 2026-10-05");
    expect(screen.queryByTestId("dd-units")).toBeNull();
  });

  it("without the right to move there is no Move button; a HOD sees the units side by side, counts only", async () => {
    board = {
      ...BOARD, scope: { level: "department", officiating: false, departmentId: "med", departmentName: "General Medicine" },
      owed: BOARD.owed.map((o) => ({ ...o, mayMove: false })), moveTo: [],
      units: [{ teamId: "u1", name: "General Medicine Unit I", short: "Unit I", departmentName: "General Medicine", members: 6, open: 3, past: 1, seenToday: 88, criticalToActMedian: 9 }],
    };
    renderWithProviders(<DoctorDeskUnit />);
    expect(await screen.findByTestId("dd-unitsum-u1")).toHaveTextContent("Unit I631889 min");
    expect(screen.queryByTestId("dd-move-visit:e7")).toBeNull();
    expect(screen.getByTestId("desk-pill")).toHaveTextContent("HOD");
  });

  it("the SR phone: NOW criticals with What did you do?, a read-back one amber; TODAY rows; tabs without Beds; the copilot line", async () => {
    renderWithProviders(<DoctorDeskNow />);
    expect(await screen.findByTestId("ddp-crit-lab_critical:c1")).toHaveTextContent("Potassium 6.4 mmol/L");
    expect(screen.getByTestId("ddp-crit-lab_critical:c2")).toHaveAttribute("data-acked", "yes");
    expect(screen.getByTestId("ddp-acked-lab_critical:c2")).toHaveTextContent("Read back by the lab · no act recorded yet");
    expect(screen.getByTestId("ddp-crit-lab_critical:c2")).toHaveTextContent("Patient X-7");
    expect(screen.getByTestId("ddp-today-imaging_unread:rep1")).toHaveTextContent("CT abdomen");
    expect(screen.getByTestId("ddp-counts")).toHaveTextContent("2 now · 1 today");
    expect(screen.getAllByTestId(/^ddp-tab-/).map((t) => t.textContent)).toEqual(["Now", "OPD", "Unit"]);
    expect(screen.queryByText("Beds")).toBeNull();
    expect(await screen.findByTestId("ddp-copilot")).toHaveTextContent("COPILOT · ASK-ONLY · DRAFTING OFF");
    expect(await screen.findByTestId("ddp-take-line")).toHaveTextContent("Unit II admits till");
    await userEvent.click(screen.getByTestId("dd-act-lab_critical:c1-treatment_started"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/doctor-desk/acts", body: { rowKey: "lab_critical:c1", choice: "treatment_started", note: null } }));
    expect(await screen.findByTestId("dd-acted-lab_critical:c1")).toHaveTextContent("Recorded · Treatment started · 9 min from the result");
    await userEvent.click(screen.getByTestId("dd-act-lab_critical:c2-other"));
    expect(screen.getByTestId("dd-act-lab_critical:c2-save")).toBeDisabled();
    await userEvent.type(screen.getByTestId("dd-act-lab_critical:c2-note"), "Called the family");
    await userEvent.click(screen.getByTestId("dd-act-lab_critical:c2-save"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/doctor-desk/acts", body: { rowKey: "lab_critical:c2", choice: "other", note: "Called the family" } }));
  });

  it("no copilot status line when the toggles cannot be read", async () => {
    toggles = { status: 404, body: { message: "not found" } };
    renderWithProviders(<DoctorDeskNow />);
    await screen.findByTestId("ddp-crit-lab_critical:c1");
    await waitFor(() => expect(screen.queryByTestId("ddp-copilot")).toBeNull());
  });

  it("the Professor phone: Approve a swap through the roster's own route; no approval with money; no proactive line while proactive is off", async () => {
    renderWithProviders(<DoctorDeskProfessor />);
    expect(await screen.findByTestId("ddp-swap-cv1")).toHaveTextContent("Duty swap · 2026-10-10");
    expect(await screen.findByTestId("ddp-ask-ap1")).toBeInTheDocument();
    expect(screen.queryByTestId("ddp-ask-ap2")).toBeNull();
    expect(screen.getByTestId("ddp-sign-n")).toHaveTextContent("2");
    await userEvent.click(screen.getByTestId("ddp-swap-cv1-yes"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/roster/covers/cv1/decide", body: { approve: true } }));
    expect(screen.getByTestId("ddp-handled-lab_critical:c5")).toHaveTextContent("Potassium 6.4 · Patient Alpha · Dr. Test Senior took it in 7 min · Treatment started");
    expect(screen.getByTestId("ddp-unit-link")).toHaveTextContent("Open the unit board · 8 items");
    expect(await screen.findByTestId("ddp-copilot")).toHaveTextContent("ASK-ONLY");
    expect(screen.queryByTestId("ddp-proactive")).toBeNull();
  });

  it("the Professor phone's proactive line shows only when proactive is ON; rating Needs rework asks why", async () => {
    toggles = { status: 200, body: { proactive: true, draftProse: false } };
    renderWithProviders(<DoctorDeskProfessor />);
    expect(await screen.findByTestId("ddp-proactive")).toHaveTextContent("2 items owed by your unit are past their time.");
    expect(screen.getByTestId("ddp-copilot")).toHaveTextContent("COPILOT · PROACTIVE ON · DRAFTING OFF");
    await userEvent.click(screen.getByTestId("ddp-rate-e11-needs_rework"));
    expect(posted.filter((p) => p.url.endsWith("/doctor-desk/ratings"))).toHaveLength(0);
    expect(screen.getByTestId("ddp-rate-e11-save")).toBeDisabled();
    await userEvent.type(screen.getByTestId("ddp-rate-e11-why"), "plan missing");
    await userEvent.click(screen.getByTestId("ddp-rate-e11-save"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/doctor-desk/ratings", body: { workKind: "opd_visit", workId: "e11", rating: "needs_rework", reason: "plan missing" } }));
  });

  it("my ratings: no average below the floor; figures neutral (no colour); shares when the server sends them", async () => {
    const { unmount } = renderWithProviders(<DoctorDeskRatings />);
    expect(await screen.findByTestId("dd-share-dept")).toHaveTextContent("—Department averagetoo few ratings yet");
    expect(screen.getByTestId("dd-share-you")).toHaveTextContent("—You");
    expect(screen.getByTestId("dd-rating-counts")).toHaveTextContent("3rated2Good1Fine0Needs rework");
    expect(document.querySelector("[data-testid='dd-ratings'] .dd-red, [data-testid='dd-ratings'] .dd-amber")).toBeNull();
    unmount();
    ratings = { ...ratings, counts: { good: 5, fine: 1, needs_rework: 0, total: 6 }, share: { you: 83, department: 50, hospital: 61 } };
    renderWithProviders(<DoctorDeskRatings />);
    expect(await screen.findByTestId("dd-share-you")).toHaveTextContent("83%You");
    expect(screen.getByTestId("dd-share-dept")).toHaveTextContent("50%Department average");
    expect(screen.getByTestId("dd-share-hosp")).toHaveTextContent("61%Hospital average");
  });

  it("no money word on any DD-1 screen", async () => {
    for (const [El, id] of [[DoctorDeskUnit, "dd-owes"], [DoctorDeskNow, "ddp-today"], [DoctorDeskProfessor, "ddp-handled"], [DoctorDeskRatings, "dd-ratings"]] as const) {
      const { unmount, container } = renderWithProviders(<El />);
      await screen.findByTestId(id);
      expect(container.textContent ?? "").not.toMatch(MONEY);
      unmount();
    }
  });
});
