import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RosterOnNow } from "./roster-on-now";
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
        { userId: "sr", name: "Dr. Aditi Deshmukh", positionKey: "unit_sr", positionLabel: "Unit senior resident", cadre: "senior_resident" },
        { userId: "jr", name: "Dr. Yusuf Qureshi", positionKey: "ward_jr", positionLabel: "Ward junior resident", cadre: "junior_resident" },
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
      return new Response(JSON.stringify(BOARD), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a published department shows its unit on take till 08:00, the people in the building and the faculty on call", async () => {
    renderWithProviders(<RosterOnNow />);
    const med = await screen.findByTestId("dept-MED");
    expect(med).toHaveTextContent("General Medicine Unit I");
    expect(med).toHaveTextContent("till 08:00");
    expect(med).toHaveTextContent("SRDr. Aditi Deshmukh");
    expect(med).toHaveTextContent("JRDr. Yusuf Qureshi");
    expect(med).toHaveTextContent("Dr. S. P. Tripathi");
    expect(med).toHaveTextContent("General Medicine Unit V is the backup unit");
    expect(within(med).queryByRole("note")).toBeNull();
    // 02:40 — the headline says the night still belongs to yesterday's units.
    expect(screen.getByText("It is past midnight and yesterday's units are still on take. They hand over at 08:00, not at 12.")).toBeInTheDocument();
    expect(screen.getByTestId("on-now-clock")).toHaveTextContent("06 Oct, 02:40");
    expect(asked.some((u) => u.endsWith("/api/roster/on-now"))).toBe(true);
  });

  it("an UNPUBLISHED department says so instead of drawing an empty, staffed-looking row", async () => {
    renderWithProviders(<RosterOnNow />);
    const sur = await screen.findByTestId("dept-SUR");
    expect(within(sur).getByRole("note")).toHaveTextContent("No published roster for this department's units");
    expect(sur).toHaveTextContent("No unit on take");
    expect(sur).toHaveTextContent("SKELETON");
    expect(screen.getByTestId("service-casualty_mo")).toHaveTextContent("No published roster");
    expect(screen.getByTestId("service-duty_manager")).toHaveTextContent("Mr. Alok Srivastava");
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
