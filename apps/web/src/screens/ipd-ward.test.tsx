import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { resetVitalsQueueForTests } from "../lib/ipd-nursing-api";
import { keepLastWard } from "../components/ward-picker";
import { renderWithRouter } from "../test-utils";
import { IpdWard } from "./ipd-ward";
import { chartOf, fid, stationOf } from "./ipd-nursing.fixture";

/*
  E4.1 (#733) — board C, the ward nurse station. Every value is synthetic (`ipd-nursing.fixture.ts`).
*/
const api = vi.hoisted(() => ({ getStation: vi.fn(), getChart: vi.fn(), acknowledgeEws: vi.fn(), sendVitals: vi.fn() }));
vi.mock("../lib/ipd-nursing-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-nursing-api")>();
  return { ...real, getStation: api.getStation, getChart: api.getChart, acknowledgeEws: api.acknowledgeEws };
});
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const PERMS = ["ipd.nursing.view", "ipd.vitals.record", "ipd.ews.respond", "ipd.assessment.record"];

beforeEach(() => {
  // The nurse has picked her ward before (the picker remembers it); a first visit is asked — see ward-picker.test.tsx.
  keepLastWard(null, fid(900));
  setToken("stub-token");
  resetVitalsQueueForTests();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: PERMS, scoped: { department: {}, floor: {} } } }), { status: 200 })));
  api.getStation.mockReset().mockResolvedValue(stationOf(Date.now()));
  api.getChart.mockReset().mockResolvedValue(chartOf(Date.now()));
  api.acknowledgeEws.mockReset().mockResolvedValue({});
});
afterEach(() => { localStorage.removeItem("hmis.ward.last"); vi.unstubAllGlobals(); setToken(null); });

const codes = (): string[] => screen.getAllByTestId(/^ipdn-bed-/).map((e) => e.getAttribute("data-testid")!.replace("ipdn-bed-", ""));

describe("nurse station (E4.1, board C)", () => {
  it("shows bed cards with identity, chips in words, the score with its band word and trend, and the due clock", async () => {
    renderWithRouter(<IpdWard />, "/ipd/ward");
    const b1 = await screen.findByTestId("ipdn-bed-F05-MED-F-B01");
    expect(b1).toHaveTextContent("Test Patient A");
    expect(b1).toHaveTextContent("UHID UH-FAKE-1");
    expect(b1).toHaveTextContent("Allergy");
    expect(b1).toHaveTextContent("Fall risk");
    expect(b1).toHaveTextContent("NEWS2");
    expect(b1).toHaveTextContent("Emergency");
    expect(within(b1).getByLabelText("rising")).toBeInTheDocument();
    expect(b1).toHaveTextContent(/Vitals · overdue \d+ min/);
    expect(screen.getByTestId("ipdn-bed-F05-MED-F-B05")).toHaveTextContent(/Cleaning · 3[34] min/);
    expect(screen.getByTestId("ipdn-bed-F05-MED-F-B07")).toHaveTextContent("Reserved");
    expect(screen.getByTestId("ipdn-top")).toHaveTextContent("1 overdue");
  });

  it("is in bed order up to 30 beds and in needs-me order above, with a switch", async () => {
    renderWithRouter(<IpdWard />, "/ipd/ward");
    await screen.findByTestId("ipdn-bed-F05-MED-F-B01");
    expect(codes().slice(0, 3)).toEqual(["F05-MED-F-B01", "F05-MED-F-B02", "F05-MED-F-B03"]);
    await userEvent.click(screen.getByTestId("ipdn-needs-toggle"));
    expect(codes()[0]).toBe("F05-MED-F-B01");
    expect(codes()[3]).toBe("F05-MED-F-B04");
    expect(codes()[codes().length - 1]).toBe("F05-MED-F-B07");
  });

  it("defaults to needs-me order above 30 beds", async () => {
    api.getStation.mockResolvedValue(stationOf(Date.now(), { count: 34 }));
    renderWithRouter(<IpdWard />, "/ipd/ward");
    await screen.findByTestId("ipdn-bed-F05-MED-F-B01");
    expect(screen.getByTestId("ipdn-needs-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(codes().slice(-3).sort()).toEqual(["F05-MED-F-B05", "F05-MED-F-B06", "F05-MED-F-B07"]);
  });

  it("follows the server's night flag and can be switched by hand", async () => {
    api.getStation.mockResolvedValue(stationOf(Date.now(), { night: true }));
    renderWithRouter(<IpdWard />, "/ipd/ward");
    await screen.findByTestId("ipdn-bed-F05-MED-F-B01");
    expect(screen.getByTestId("ipd-ward")).toHaveClass("night");
    await userEvent.click(screen.getByTestId("ipdn-night-toggle"));
    expect(screen.getByTestId("ipd-ward")).not.toHaveClass("night");
  });

  it("acknowledges an open alert", async () => {
    renderWithRouter(<IpdWard />, "/ipd/ward");
    const b1 = await screen.findByTestId("ipdn-bed-F05-MED-F-B01");
    await userEvent.click(within(b1).getByTestId("ipdn-ack"));
    await waitFor(() => expect(api.acknowledgeEws).toHaveBeenCalledWith(fid(501)));
    expect(within(screen.getByTestId("ipdn-bed-F05-MED-F-B02")).queryByTestId("ipdn-ack")).toBeNull();
  });

  it("review walk: a queued set past 30 minutes is named on the live line after the station loads", async () => {
    const old = { idempotencyKey: "00000000-0000-4000-8000-000000000099", admissionId: fid(1), observedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      source: "person", values: { pulse: 88 }, queueLabel: "Test Patient A" };
    localStorage.setItem("hmis.ipd.vitalsQueue.v1", JSON.stringify([old]));
    renderWithRouter(<IpdWard />, "/ipd/ward");
    const box = await screen.findByTestId("ipdn-dropped");
    expect(box.textContent).toContain("Test Patient A");
    expect(box.textContent).toContain("Record these on paper.");
  });

  it("review 10: an alert no doctor was reached for says so in words; a sealed bed shows no code", async () => {
    const st = stationOf(Date.now());
    st.beds[1] = { ...st.beds[1]!, code: null, consultant: null, dayOfStay: null, patient: { ...st.beds[1]!.patient!, name: "Sealed patient", uhid: "", admissionNo: null, sealed: true } };
    api.getStation.mockResolvedValue(st);
    renderWithRouter(<IpdWard />, "/ipd/ward");
    const b1 = await screen.findByTestId("ipdn-bed-F05-MED-F-B01");
    expect(within(b1).getByTestId("ipdn-nodoc").textContent).toContain("No doctor reached — call");
    const sealed = screen.getByTestId(`ipdn-bed-${st.beds[1]!.bedId}`);
    expect(sealed.textContent).not.toContain("F05-MED-F-B02");
    expect(within(sealed).queryByTestId("ipdn-nodoc")).toBeNull();
  });

  it("opens the chart: vitals with a late entry flagged, the source of each set, and the assessment", async () => {
    renderWithRouter(<IpdWard />, "/ipd/ward");
    await userEvent.click(await screen.findByRole("button", { name: /Open the nursing chart for bed F05-MED-F-B01/ }));
    const chart = await screen.findByTestId("ipdn-chart");
    await within(chart).findByText(/late entry, typed/);
    expect(chart).toHaveTextContent("Sister Fake · typed");
    await userEvent.click(within(chart).getByRole("tab", { name: "Assessment" }));
    expect(within(chart).getByTestId("ipdn-assessment")).toHaveTextContent("55 · high risk");
  });
});
