import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RosterOnNow, answerFromBoard } from "./roster-on-now";
import type { WireOnNowBoard } from "../lib/roster-api";

/** 02:40 IST on Tuesday 6 October — Monday's unit is still on take until 08:00. */
const AT = "2026-10-05T21:10:00.000Z";

const BOARD: WireOnNowBoard = {
  at: AT, resolverEnabled: true,
  departments: [
    {
      departmentId: "d-med", code: "MED", name: "General Medicine", units: 5, source: "published", skeleton: false,
      unitOnTake: { teamId: "u1", code: "MED-U1", name: "General Medicine Unit I", startsAt: "2026-10-05T02:30:00.000Z", endsAt: "2026-10-06T02:30:00.000Z" },
      backupUnit: { teamId: "u5", code: "MED-U5", name: "General Medicine Unit V", startsAt: "2026-10-05T02:30:00.000Z", endsAt: "2026-10-06T02:30:00.000Z" },
      inTheBuilding: [
        { userId: "sr", name: "Dr. Aditi Deshmukh", positionKey: "unit_sr", positionLabel: "Unit senior resident", cadre: "senior_resident", phone: "9876543210" },
        { userId: "jr", name: "Dr. Yusuf Qureshi", positionKey: "ward_jr", positionLabel: "Ward junior resident", cadre: "junior_resident", phone: null },
      ],
      facultyOnCall: [{ userId: "fac", name: "Dr. S. P. Tripathi", positionKey: "faculty_on_call", positionLabel: "Faculty on call", callTier: 1 }],
    },
    {
      departmentId: "d-sur", code: "SUR", name: "General Surgery", units: 5, source: "static", skeleton: true,
      unitOnTake: null, backupUnit: null, inTheBuilding: [], facultyOnCall: [],
    },
  ],
  services: [
    { positionKey: "duty_manager", positionLabel: "Duty manager", cadre: "admin", source: "published", people: [{ userId: "dm", name: "Mr. Alok Srivastava", departmentId: "d-admn" }] },
    { positionKey: "casualty_mo", positionLabel: "Casualty medical officer", cadre: "medical_officer", source: "static", people: [] },
  ],
  holes: [
    {
      kind: "absent_on_duty", departmentId: "d-med", departmentName: "General Medicine", from: "2026-10-05T14:30:00.000Z", to: "2026-10-06T02:30:00.000Z",
      positionKey: "ward_jr", positionLabel: "Ward junior resident", userId: "jr2", name: "Dr. Tanvi Shah",
    },
    {
      kind: "no_take_cycle", departmentId: "d-sur", departmentName: "General Surgery", from: AT, to: "2026-10-06T21:10:00.000Z",
      positionKey: null, positionLabel: null, userId: null, name: null,
    },
  ],
};

describe("RosterOnNow (20-U U5a)", () => {
  const asked: string[] = [];
  beforeEach(() => {
    setToken("t");
    asked.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      asked.push(raw);
      const body = raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/copilot/ask") ? { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null }
            : BOARD;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a published department shows its unit on take as the board writes it, the people in the building and the faculty on call", async () => {
    renderWithProviders(<RosterOnNow />);
    const med = await screen.findByTestId("dept-MED");
    // "Unit I" under its department, as OnNow.dc.html draws it — not "General Medicine Unit I".
    expect(med).toHaveTextContent("Unit I");
    expect(med).not.toHaveTextContent("General Medicine Unit I");
    expect(med).toHaveTextContent("Monday's take · till 08:00");
    expect(med).toHaveTextContent("SRDr. Aditi Deshmukh");
    expect(med).toHaveTextContent("JRDr. Yusuf Qureshi");
    expect(med).toHaveTextContent("Dr. S. P. Tripathi");
    expect(med).toHaveTextContent("at home · comes in when called");
    expect(med).toHaveTextContent("Unit V is the backup unit");
    expect(within(med).queryByRole("note")).toBeNull();
    // 02:40 — the clock line and its note: the night still belongs to Monday's units.
    expect(screen.getByTestId("on-now-clock")).toHaveTextContent("Tuesday 6 October, 02:40");
    expect(screen.getByTestId("on-now-note")).toHaveTextContent("It is past midnight, and Monday's units are still on take. They hand over at 08:00, not at 12.");
    expect(asked.some((u) => u.endsWith("/api/roster/on-now"))).toBe(true);
  });

  it("D6 — a call button for a person in the building with a number on file, and none without one", async () => {
    renderWithProviders(<RosterOnNow />);
    const med = await screen.findByTestId("dept-MED");
    expect(within(med).getByRole("link", { name: "Call Dr. Aditi Deshmukh" })).toHaveAttribute("href", "tel:9876543210");
    expect(within(med).queryByRole("link", { name: "Call Dr. Yusuf Qureshi" })).toBeNull();
  });

  it("a department with no take cycle says so in plain words, instead of an empty, staffed-looking row", async () => {
    renderWithProviders(<RosterOnNow />);
    const sur = await screen.findByTestId("dept-SUR");
    expect(within(sur).getByRole("note")).toHaveTextContent("General Surgery has no take cycle, so no unit is named as admitting and nobody is listed.");
    expect(sur).toHaveTextContent("No take cycle");
    expect(sur).toHaveTextContent("SKELETON");
    expect(sur).toHaveTextContent("No backup unit is named");
    expect(screen.getByTestId("service-casualty_mo")).toHaveTextContent("No published roster");
    expect(screen.getByTestId("service-duty_manager")).toHaveTextContent("Mr. Alok Srivastava");
  });

  it("is drawn in the Doctor Desk frame, whose menu lists only screens that exist", async () => {
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    const menu = screen.getByTestId("desk-menu");
    await vi.waitFor(() => expect(within(menu).getByTestId("desk-menu-roster")).toHaveAttribute("href", "/roster/month"));
    expect(within(menu).getByTestId("desk-menu-onNow")).toHaveAttribute("aria-current", "page");
    // My OPD needs opd.consult, which this person does not hold; nothing else is listed.
    expect(within(menu).queryByTestId("desk-menu-myOpd")).toBeNull();
    expect(within(menu).getAllByRole("link")).toHaveLength(2);
    expect(screen.getByTestId("desk-context")).toHaveTextContent("Who is on now");
  });

  it("the paper copy names every department, the people in the building with their numbers, and when it was printed", async () => {
    renderWithProviders(<RosterOnNow />);
    const sheet = await screen.findByTestId("on-now-print");
    expect(sheet).toHaveTextContent("SR Dr. Aditi Deshmukh · 9876543210");
    expect(sheet).toHaveTextContent("General Surgery");
    expect(sheet).toHaveTextContent(/Printed /);
    // The card says what is true: printing is by hand; it does not claim a copy was printed.
    expect(screen.getByTestId("on-now-dark")).toHaveTextContent("It does not print itself yet");
    expect(screen.getByTestId("on-now-dark")).not.toHaveTextContent(/Last printed/);
  });

  it("the ask bar answers from the board when the hospital copilot does not understand", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    await user.type(screen.getByLabelText("Ask the copilot"), "medicine mein on call kaun hai?{Enter}");
    expect(await screen.findByTestId("desk-ask-answer")).toHaveTextContent("General Medicine: Unit I is on take till 08:00. In the building: SR Dr. Aditi Deshmukh, JR Dr. Yusuf Qureshi. Faculty on call: Dr. S. P. Tripathi.");
    expect(asked.some((u) => u.endsWith("/api/copilot/ask"))).toBe(true);
  });

  it("the board's own answerer: a service by name, and nothing for a question it cannot place", () => {
    const t = (k: string, o?: Record<string, unknown>): string => `${k}${o === undefined ? "" : JSON.stringify(o)}`;
    expect(answerFromBoard("who is the duty manager", BOARD, t)).toContain("rosterOnNow.answer.service");
    expect(answerFromBoard("what is the weather", BOARD, t)).toBeNull();
  });

  it("lists the holes in the next 24 hours as sentences", async () => {
    renderWithProviders(<RosterOnNow />);
    const holes = await screen.findByTestId("on-now-holes");
    expect(holes).toHaveTextContent("General Medicine: Dr. Tanvi Shah (Ward junior resident) is rostered 20:00–08:00 and is on approved leave.");
    expect(holes).toHaveTextContent("General Surgery has no published take cycle");
  });

  it("asks for eight hours ahead when the desk taps it", async () => {
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    await userEvent.click(screen.getByRole("button", { name: "In 8 hours" }));
    await vi.waitFor(() => expect(asked.some((u) => u.includes("/api/roster/on-now?at="))).toBe(true));
  });

  it("a pinned instant is asked for as given, with no clock buttons", async () => {
    renderWithProviders(<RosterOnNow at={AT} />);
    await screen.findByTestId("dept-MED");
    expect(asked.some((u) => u.includes(`at=${encodeURIComponent(AT)}`))).toBe(true);
    expect(screen.queryByRole("button", { name: "In 8 hours" })).toBeNull();
  });
});
