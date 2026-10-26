import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IpdShiftMapView, IpdWardCockpit } from "@hmis/contracts";
import { ApiError, setToken } from "../lib/api";
import { keepLastWard } from "../components/ward-picker";
import { renderWithRouter } from "../test-utils";
import { IpdWardAssign } from "./ipd-ward-assign";
import { IpdWardCockpit as Cockpit } from "./ipd-ward-cockpit";
import { fid } from "./ipd-nursing.fixture";

/*
  WM-1 (#982) — the in-charge's cockpit and shift assignment. Every value is synthetic; names are made up.
*/
const api = vi.hoisted(() => ({
  getCockpit: vi.fn(), getShiftMap: vi.fn(), saveShiftMap: vi.fn(), publishShiftMap: vi.fn(), copyShiftMap: vi.fn(), assignNurse: vi.fn(),
}));
vi.mock("../lib/ipd-ward-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-ward-api")>();
  return { ...real, ...api };
});
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const WARD = { id: fid(900), code: "F05-MED-F", name: "5F Medicine (Female)" };
const NURSE = fid(501);
const NURSE2 = fid(502);
const ref = (userId: string, name: string, initials: string) => ({ userId, name, initials });
const bed = (n: number, over: Partial<IpdWardCockpit["beds"][number]> = {}): IpdWardCockpit["beds"][number] => ({
  bedId: fid(n), code: `B${String(n)}`, admissionId: fid(n + 100), name: `Patient ${String(n)}`, nurse: ref(NURSE, "Asha Kumari", "A. K."), student: null,
  unassigned: false, suggestedNurseId: null, acuity: { level: null, points: 1, ventilated: false }, score: null, chips: [], next: null, ...over,
});

function cockpitOf(over: Partial<IpdWardCockpit> = {}): IpdWardCockpit {
  const now = Date.now();
  return {
    asOf: new Date(now).toISOString(), wards: [WARD], ward: WARD,
    shift: { key: "morning", date: "2026-03-10", startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() },
    map: { mapId: fid(800), status: "published", publishedAt: new Date(now - 7_200_000).toISOString(), late: false }, nextMap: null,
    census: { beds: 3, occupied: 3 },
    ratio: { unit: "general", night: false, patientsPerRn: 6, patients: 3, ventilated: 0, rnsOnDuty: 2, rnsNeeded: 1, breach: false },
    staff: [
      { ...ref(NURSE, "Asha Kumari", "A. K."), kind: "rn", pairedWithId: null, homeWardId: null, endedAt: null },
      { ...ref(NURSE2, "Bina Devi", "B. D."), kind: "rn", pairedWithId: null, homeWardId: null, endedAt: null },
    ],
    loads: [
      { ...ref(NURSE, "Asha Kumari", "A. K."), beds: 2, points: 2, overloaded: false },
      { ...ref(NURSE2, "Bina Devi", "B. D."), beds: 0, points: 0, overloaded: false },
    ],
    beds: [bed(1), bed(2), bed(3, { nurse: null, unassigned: true, suggestedNurseId: NURSE2 })],
    needsYou: [{ kind: "unassigned_bed", bedId: fid(3), userId: null, text: "B3: no nurse" }],
    rosterFallback: true,
    candidates: [
      { ...ref(NURSE, "Asha Kumari", "A. K."), kind: "rn" }, { ...ref(NURSE2, "Bina Devi", "B. D."), kind: "rn" },
    ],
    ...over,
  };
}

beforeEach(() => {
  keepLastWard(null, WARD.id);
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.nursing.view", "ipd.nursing.assign"], scoped: { department: {}, floor: {} } },
  }), { status: 200 })));
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => { localStorage.removeItem("hmis.ward.last"); vi.unstubAllGlobals(); setToken(null); });

describe("ward cockpit (WM-1)", () => {
  it("shows each bed's nurse, a red bed with no nurse, and gives it to the lowest-load nurse in one tap", async () => {
    api.getCockpit.mockResolvedValue(cockpitOf());
    api.assignNurse.mockResolvedValue({ ratioBreach: false });
    renderWithRouter(<Cockpit />, "/ipd/ward/cockpit");
    const red = await screen.findByTestId(`ipdw-bed-${fid(3)}`);
    expect(red).toHaveClass("red");
    expect(red).toHaveTextContent("No nurse");
    expect(screen.getByTestId(`ipdw-bed-${fid(1)}`)).toHaveTextContent("A. K.");
    await userEvent.click(within(red).getByTestId(`ipdw-give-${fid(3)}`));
    expect(api.assignNurse).toHaveBeenCalledWith(fid(3), NURSE2, undefined);
    expect(screen.getByTestId("ipdw-needs")).toHaveTextContent("B3: no nurse");
  });

  it("a reassignment asks for a reason before it can be sent", async () => {
    api.getCockpit.mockResolvedValue(cockpitOf());
    api.assignNurse.mockResolvedValue({ ratioBreach: false });
    renderWithRouter(<Cockpit />, "/ipd/ward/cockpit");
    const b1 = await screen.findByTestId(`ipdw-bed-${fid(1)}`);
    await userEvent.click(within(b1).getByRole("button", { name: "Reassign" }));
    const form = screen.getByTestId("ipdw-reassign");
    await userEvent.selectOptions(within(form).getByRole("combobox"), NURSE2);
    const send = within(form).getByRole("button", { name: "Reassign" });
    expect(send).toBeDisabled();
    await userEvent.type(within(form).getByRole("textbox"), "Going off sick");
    await userEvent.click(send);
    expect(api.assignNurse).toHaveBeenCalledWith(fid(1), NURSE2, "Going off sick");
  });

  it("shows a ratio breach in red words", async () => {
    api.getCockpit.mockResolvedValue(cockpitOf({ ratio: { unit: "general", night: false, patientsPerRn: 6, patients: 5, ventilated: 1, rnsOnDuty: 1, rnsNeeded: 2, breach: true } }));
    renderWithRouter(<Cockpit />, "/ipd/ward/cockpit");
    const ratio = await screen.findByTestId("ipdw-ratio");
    expect(ratio).toHaveTextContent("1 of 2 · 1:6");
    expect(within(ratio).getByText(/1 of 2/)).toHaveClass("hot");
  });
});

describe("shift assignment (WM-1)", () => {
  const draftMap = (over: Partial<IpdShiftMapView> = {}): IpdShiftMapView => ({
    mapId: fid(801), wardId: WARD.id, shiftDate: "2026-03-10", shift: "evening", status: "draft",
    staff: [{ userId: NURSE, kind: "rn", pairedWithId: null }, { userId: NURSE2, kind: "rn", pairedWithId: null }],
    beds: [{ bedId: fid(1), nurseId: NURSE, studentId: null }, { bedId: fid(2), nurseId: NURSE, studentId: null }],
    ...over,
  });

  it("an occupied bed with no nurse sits in its own column; Take moves it; Publish saves then publishes", async () => {
    api.getCockpit.mockResolvedValue(cockpitOf());
    api.getShiftMap.mockResolvedValue(draftMap());
    api.saveShiftMap.mockResolvedValue({ mapId: fid(801) });
    api.publishShiftMap.mockResolvedValue({ mapId: fid(801), late: false, ratioBreach: false });
    renderWithRouter(<IpdWardAssign />, "/ipd/ward/assign");
    expect(await screen.findByTestId("ipdw-checks")).toHaveTextContent("No nurse: B3");
    await userEvent.click(screen.getByTestId(`ipdw-chip-${fid(3)}`));
    await userEvent.click(within(screen.getByTestId(`ipdw-nurse-${NURSE2}`)).getByRole("button", { name: "Take selected bed" }));
    expect(screen.getByTestId("ipdw-checks")).toHaveTextContent("Every bed has a named nurse");
    await userEvent.click(screen.getByTestId("ipdw-publish"));
    await waitFor(() => expect(api.publishShiftMap).toHaveBeenCalledWith(fid(801)));
    const sent = api.saveShiftMap.mock.calls[0]![0] as { beds: { bedId: string; nurseId: string }[] };
    expect(sent.beds).toEqual(expect.arrayContaining([{ bedId: fid(3), nurseId: NURSE2 }, { bedId: fid(1), nurseId: NURSE }]));
  });

  it("a refused publish names the beds in words", async () => {
    api.getCockpit.mockResolvedValue(cockpitOf());
    api.getShiftMap.mockResolvedValue(draftMap());
    api.saveShiftMap.mockResolvedValue({ mapId: fid(801) });
    api.publishShiftMap.mockRejectedValue(new ApiError(409, { statusCode: 409, code: "bed_unassigned", message: "x", detail: { bedIds: [fid(3)] } }));
    renderWithRouter(<IpdWardAssign />, "/ipd/ward/assign");
    await userEvent.click(await screen.findByTestId("ipdw-publish"));
    expect(await screen.findByTestId("ipdw-error")).toHaveTextContent("An occupied bed has no nurse · B3");
  });

  it("a live map is read-only here", async () => {
    api.getCockpit.mockResolvedValue(cockpitOf());
    api.getShiftMap.mockResolvedValue(draftMap({ status: "published" }));
    renderWithRouter(<IpdWardAssign />, "/ipd/ward/assign");
    expect(await screen.findByText("This shift is live. Change a bed on the cockpit, with a reason.")).toBeInTheDocument();
    expect(screen.getByTestId("ipdw-publish")).toBeDisabled();
  });
});
