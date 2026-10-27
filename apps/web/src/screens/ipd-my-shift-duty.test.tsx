import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { keepLastWard } from "../components/ward-picker";
import { renderWithRouter } from "../test-utils";
import { IpdMyShift } from "./ipd-my-shift";
import { fid, handoversOf, myShiftOf } from "./ipd-nursing.fixture";

/*
  WM-1 (#982) — my shift under a published assignment: the "no assignment yet" label before the ward's first publish,
  and "End my duty", refused while the nurse still holds beds. Every value is synthetic.
*/
const api = vi.hoisted(() => ({ getMyShift: vi.fn(), getShiftHandovers: vi.fn(), endMyDuty: vi.fn() }));
vi.mock("../lib/ipd-nursing-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-nursing-api")>();
  return { ...real, getMyShift: api.getMyShift, getShiftHandovers: api.getShiftHandovers };
});
vi.mock("../lib/ipd-ward-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-ward-api")>();
  return { ...real, endMyDuty: api.endMyDuty };
});
vi.mock("../lib/ipd-copilot-api", () => ({ buildSbarDraft: vi.fn(async () => { throw new Error("not in this test"); }) }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

beforeEach(() => {
  keepLastWard(null, fid(900));
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.nursing.view", "ipd.vitals.record"], scoped: { department: {}, floor: {} } },
  }), { status: 200 })));
  api.getShiftHandovers.mockReset().mockResolvedValue(handoversOf(Date.now(), []));
  api.endMyDuty.mockReset();
});
afterEach(() => { localStorage.removeItem("hmis.ward.last"); vi.unstubAllGlobals(); setToken(null); });

describe("my shift under the ward's assignment (WM-1)", () => {
  it("before the ward's first publish the list is the whole ward, labelled, and there is no End my duty", async () => {
    api.getMyShift.mockReset().mockResolvedValue({ ...myShiftOf(Date.now()), assignment: "ward" });
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    expect(await screen.findByTestId("ipdn-no-assignment")).toHaveTextContent("No assignment yet: whole ward");
    expect(screen.queryByTestId("ipdn-end-duty")).toBeNull();
  });

  it("End my duty asks once, then says why it is refused while beds are held", async () => {
    api.getMyShift.mockReset().mockResolvedValue({ ...myShiftOf(Date.now()), assignment: "mine" });
    api.endMyDuty.mockRejectedValue(new ApiError(409, { statusCode: 409, code: "beds_still_assigned", message: "x", detail: { bedIds: [fid(1)] } }));
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const end = await screen.findByTestId("ipdn-end-duty");
    await userEvent.click(end);
    expect(api.endMyDuty).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("ipdn-end-duty"));
    expect(api.endMyDuty).toHaveBeenCalledWith(fid(900));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hand over your beds first");
  });
});
