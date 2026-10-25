import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { queuedVitals, resetVitalsQueueForTests } from "../lib/ipd-nursing-api";
import { keepLastWard } from "../components/ward-picker";
import { renderWithRouter } from "../test-utils";
import { IpdMyShift } from "./ipd-my-shift";
import { draftOf, fid, handoversOf, myShiftOf, shiftHandover } from "./ipd-nursing.fixture";

/*
  E4.1 (#733) — board D1, my shift on the nurse's phone. Every value is synthetic (`ipd-nursing.fixture.ts`).
*/
const api = vi.hoisted(() => ({
  getMyShift: vi.fn(), getShiftHandovers: vi.fn(), sendVitals: vi.fn(), getHandoverDraft: vi.fn(), giveShiftHandover: vi.fn(), acceptShiftHandover: vi.fn(),
}));
vi.mock("../lib/ipd-nursing-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-nursing-api")>();
  return {
    ...real, getMyShift: api.getMyShift, getShiftHandovers: api.getShiftHandovers, getHandoverDraft: api.getHandoverDraft,
    giveShiftHandover: api.giveShiftHandover, acceptShiftHandover: api.acceptShiftHandover,
  };
});
// E5.4 — the kept SBAR draft is its own test's (`ipd-copilot.test.tsx`); here the build is simply not available.
vi.mock("../lib/ipd-copilot-api", () => ({ buildSbarDraft: vi.fn(async () => { throw new Error("not in this test"); }) }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const PERMS = ["ipd.nursing.view", "ipd.vitals.record", "ipd.handover.shift"];
let vitalsCalls: unknown[] = [];
let vitalsAnswer: () => Response = () => new Response(JSON.stringify({ vitalsId: fid(999), score: { kind: "news2", value: 6, band: "medium" }, alertRaised: true, lateEntry: false }), { status: 201 });

beforeEach(() => {
  // The nurse has picked her ward before (the picker remembers it); a first visit is asked — see ward-picker.test.tsx.
  keepLastWard(null, fid(900));
  setToken("stub-token");
  resetVitalsQueueForTests();
  vitalsCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/ipd/nursing/vitals")) { vitalsCalls.push(JSON.parse(String(init?.body))); return vitalsAnswer(); }
    return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: PERMS, scoped: { department: {}, floor: {} } } }), { status: 200 });
  }));
  api.getMyShift.mockReset().mockResolvedValue(myShiftOf(Date.now()));
  api.getShiftHandovers.mockReset().mockResolvedValue(handoversOf(Date.now(), [shiftHandover(Date.now()), shiftHandover(Date.now(), { handoverId: fid(702), givenByViewer: true })]));
  api.getHandoverDraft.mockReset().mockImplementation(async (id: string) => draftOf(id));
  api.giveShiftHandover.mockReset().mockResolvedValue({});
  api.acceptShiftHandover.mockReset().mockResolvedValue({});
});
afterEach(() => { localStorage.removeItem("hmis.ward.last");
  vi.unstubAllGlobals(); setToken(null);
  vitalsAnswer = () => new Response(JSON.stringify({ vitalsId: fid(999), score: { kind: "news2", value: 6, band: "medium" }, alertRaised: true, lateEntry: false }), { status: 201 });
});

async function openVitals(admission = fid(102)): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`ipdn-now-vitals-${admission}`));
  return screen.findByTestId("ipdn-vitals-form");
}

describe("my shift (E4.1, board D1)", () => {
  it("lists what is due now in time order with bed, name and a clock in words", async () => {
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const now = await screen.findByTestId("ipdn-now");
    const items = within(now).getAllByRole("button");
    expect(items[0]).toHaveTextContent("F05-MED-F-B01");
    expect(items[0]).toHaveTextContent("Alert · Emergency");
    expect(items[1]).toHaveTextContent(/Vitals · overdue \d+ min/);
    expect(items[2]).toHaveTextContent(/Vitals · in (9|10) min/);
    expect(items[3]).toHaveTextContent(/Assessment · in (19|20) min/);
    expect(screen.getByText("6 patients")).toBeInTheDocument();
  });

  it("scores as the numbers are typed, reads them back, and saves with the time taken", async () => {
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const form = await openVitals(fid(101));
    await userEvent.type(within(form).getByLabelText("Resp rate"), "26");
    expect(within(form).getByTestId("ipdn-score")).toHaveTextContent("NEWS2");
    expect(within(form).getByTestId("ipdn-score")).toHaveTextContent("3");
    expect(within(form).getByTestId("ipdn-score")).toHaveTextContent("Single red");
    await userEvent.type(within(form).getByLabelText("Pulse"), "92");
    await userEvent.click(within(form).getByTestId("ipdn-check"));
    expect(within(form).getByTestId("ipdn-readback")).toHaveTextContent("26");
    await userEvent.click(within(form).getByTestId("ipdn-save"));
    await screen.findByText(/Saved · NEWS2 6/);
    expect(vitalsCalls).toHaveLength(1);
    expect(vitalsCalls[0]).toMatchObject({ admissionId: fid(101), source: "person", values: { respRate: 26, pulse: 92 } });
    expect((vitalsCalls[0] as { confirmedOutOfRange?: true }).confirmedOutOfRange).toBeUndefined();
  });

  it("asks to confirm a value outside the limits and sends the confirmation", async () => {
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const form = await openVitals();
    await userEvent.type(within(form).getByLabelText("Pulse"), "250");
    await userEvent.click(within(form).getByTestId("ipdn-check"));
    expect(within(form).getByRole("alert")).toHaveTextContent("Unusual value — check it");
    await userEvent.click(within(form).getByRole("button", { name: "Confirm and save" }));
    await waitFor(() => expect(vitalsCalls).toHaveLength(1));
    expect(vitalsCalls[0]).toMatchObject({ confirmedOutOfRange: true, values: { pulse: 250 } });
  });

  it("records a refusal with no values", async () => {
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const form = await openVitals();
    await userEvent.click(within(form).getByTestId("ipdn-refused"));
    await screen.findByText(/Refusal recorded/);
    expect(vitalsCalls[0]).toMatchObject({ refused: true, values: {} });
  });

  it("queues the set when the network is gone and says so in a few words", async () => {
    vitalsAnswer = () => { throw new TypeError("Failed to fetch"); };
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const form = await openVitals();
    await userEvent.type(within(form).getByLabelText("Pulse"), "88");
    await userEvent.click(within(form).getByTestId("ipdn-check"));
    await userEvent.click(within(form).getByTestId("ipdn-save"));
    expect(await screen.findByTestId("ipdn-notice")).toHaveTextContent("Queued — will send");
    expect(queuedVitals()).toHaveLength(1);
    expect(screen.getByTestId("ipdn-live")).toHaveTextContent("1 set queued");
  });

  it("shows a refusal's rule", async () => {
    vitalsAnswer = () => new Response(JSON.stringify({ statusCode: 409, code: "admission_wrong_state", message: "x", rule: "The admission is not in a state that allows this act.", fix: "Open admission" }), { status: 409 });
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    const form = await openVitals();
    await userEvent.type(within(form).getByLabelText("Pulse"), "88");
    await userEvent.click(within(form).getByTestId("ipdn-check"));
    await userEvent.click(within(form).getByTestId("ipdn-save"));
    expect(await within(form).findByRole("alert")).toHaveTextContent("not in a state");
    expect(queuedVitals()).toHaveLength(0);
    expect(ApiError).toBeDefined();
  });

  it("handover: accepts one given by someone else, never one I gave; gives a drafted SBAR", async () => {
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    await userEvent.click(await screen.findByTestId("ipdn-handover-open"));
    const pane = await screen.findByTestId("ipdn-handover");
    expect(within(pane).getByTestId(`ipdn-shift-handover-${fid(701)}`)).toBeInTheDocument();
    expect(within(pane).queryByTestId(`ipdn-shift-handover-${fid(702)}`)).toBeNull();
    await userEvent.click(within(within(pane).getByTestId(`ipdn-shift-handover-${fid(701)}`)).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(api.acceptShiftHandover).toHaveBeenCalledWith(fid(701)));
    await userEvent.click(within(pane).getAllByRole("button", { name: /Draft SBAR/ })[0]!);
    await waitFor(() => expect(within(pane).getByDisplayValue("Day 7. NEWS2 1 at 09:10, falling.")).toBeInTheDocument());
    expect(pane).toHaveTextContent("assessment");
    await userEvent.click(within(pane).getByRole("button", { name: "Give" }));
    await waitFor(() => expect(api.giveShiftHandover).toHaveBeenCalledWith(fid(101), expect.objectContaining({ situation: "Day 7. NEWS2 1 at 09:10, falling." })));
  });

  it("night mode follows the server", async () => {
    api.getMyShift.mockResolvedValue(myShiftOf(Date.now(), true));
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    await screen.findByTestId("ipdn-now");
    expect(screen.getByTestId("ipd-my-shift")).toHaveClass("night");
  });
});
