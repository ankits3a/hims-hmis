import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyPortable, wardOf } from "./radiology-portable";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

/**
 * PLAN 18-S RS2b P6 — the portable round. The server sends the round already sorted by place then
 * slot; the screen groups it by ward, opens the study console from a row, and says honestly that
 * ordering from the ward arrives with the IPD plan.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

function calls(): string[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u).replace(/^.*\/studies/, "")}`);
}

const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "X2608310001", status: "scheduled", priority: "routine",
  studyTypeCode: "XR-CHEST", bedsideLocation: "Ward 3 · bed 12", scheduledAt: "2026-08-31T04:30:00.000Z",
  deviceResourceId: "D1", deviceCode: "PX-1", encounterNo: "V2608310001", patientId: "P1",
  patientName: "Asha Devi", restricted: false, ...over,
});

beforeEach(() => { setToken("t"); navigate.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

it("groups the round by ward, in the server's order, in the right column", async () => {
  mockRoutes({
    "GET /api/radiology/portable/round": {
      status: 200,
      body: {
        rows: [
          row({ studyId: "S1", bedsideLocation: "Ward 3 · bed 12", patientName: "Asha Devi" }),
          row({ studyId: "S2", bedsideLocation: "Ward 3 · bed 4", patientName: "Priya M." }),
          row({ studyId: "S3", bedsideLocation: "ICU, bed 2", patientName: "Ramesh K." }),
        ],
      },
    },
  });
  renderWithProviders(<RadiologyPortable />);
  const right = within(await screen.findByTestId("station-right"));
  const ward3 = within(await right.findByRole("region", { name: "Ward 3" }));
  expect(ward3.getByText("Asha Devi")).toBeInTheDocument();
  expect(ward3.getByText("Priya M.")).toBeInTheDocument();
  expect(within(right.getByRole("region", { name: "ICU" })).getByText("Ramesh K.")).toBeInTheDocument();
  /** The next bed is the server's first row, shown in the centre. */
  expect(within(screen.getByTestId("portable-next")).getByText("Ward 3 · bed 12")).toBeInTheDocument();
});

/**
 * 18-S RS6 T3 — the round works the bed where it stands: a row opens the room console inline in
 * bedside mode. Opening a booked bed checks it in (presence is derived); Start stays shut until the
 * three bedside radiation checks are ticked, and then carries them as attested text.
 */
it("opens the bedside console inline: the bed is checked in by opening; Start waits for the bay to be clear", async () => {
  const bedside = {
    studyId: "S9", accessionNo: "X2608310001", status: "ready", priority: "routine", studyTypeCode: "XR-CHEST",
    studyTypeName: "X-ray chest AP", modality: "xray", bodyPart: "chest", contrastOption: "none", lateralityApplicable: false,
    laterality: "na", ionising: true, bedsideLocation: "Ward 3 · bed 12", encounterNo: "V2608310001", patientId: "P1",
    mintedStudyInstanceUid: "2.25.9",
    patient: { name: "Asha Devi", uhid: "HMS-00000001-5", restricted: false, ageYears: 30, sex: "female", allergies: [], weight: null },
    device: null, protocol: { book: "none", version: null, matchedOn: null, protocol: null }, drl: [], renal: null, repeats: [],
  };
  mockRoutes({
    "GET /api/radiology/portable/round": { status: 200, body: { rows: [row({ studyId: "S9" })] } },
    "POST /api/radiology/studies/S9/check-in": { status: 200, body: { studyId: "S9", status: "checked_in", gates: [] } },
    "GET /api/radiology/studies/S9/room": { status: 200, body: { study: bedside } },
    "GET /api/radiology/studies/S9/readiness": { status: 200, body: { state: "ready", ready: true, open: [], gates: [{ id: "G1", kind: "identity_two_factor", state: "satisfied", waivable: false }] } },
    "POST /api/radiology/studies/S9/acquisition/start": { status: 200, body: { studyId: "S9", status: "in_acquisition" } },
  });
  renderWithProviders(<RadiologyPortable />);
  await userEvent.click(await screen.findByTestId("round-S9"));
  expect(navigate).not.toHaveBeenCalled();
  await screen.findByTestId("bedside-checklist");
  await userEvent.click(screen.getByTestId("step-acquire"));
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  await userEvent.click(screen.getByTestId("step-identify"));
  for (const k of ["distance", "apron", "pregnancy"]) await userEvent.click(within(screen.getByTestId("bedside-checklist")).getByTestId(`bay-${k}`));
  await userEvent.click(screen.getByTestId("step-acquire"));
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => { expect(calls()).toContain("POST /S9/acquisition/start"); });
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  const start = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/S9/acquisition/start") && i?.method === "POST");
  expect(JSON.parse(String(start?.[1]?.body))).toEqual({ bedsideSafety: expect.stringMatching(/2 m away.*lead apron.*no pregnant/) });
  expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/S9/check-in") && i?.method === "POST")).toBe(true);
});

it("says the round is empty and that ward ordering arrives with the IPD plan", async () => {
  mockRoutes({ "GET /api/radiology/portable/round": { status: 200, body: { rows: [] } } });
  renderWithProviders(<RadiologyPortable />);
  expect(await screen.findByText("No bedside studies on the round.")).toBeInTheDocument();
  expect(screen.getByTestId("portable-ipd-note")).toHaveTextContent(/IPD/);
});

it("shows a refusal in plain words", async () => {
  mockRoutes({
    "GET /api/radiology/portable/round": {
      status: 403, body: { statusCode: 403, code: "forbidden", message: "you do not hold radiology.acquire" },
    },
  });
  renderWithProviders(<RadiologyPortable />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

it("reads the ward off the place", () => {
  expect(wardOf("Ward 3 · bed 12")).toBe("Ward 3");
  expect(wardOf("ICU, bed 2")).toBe("ICU");
  expect(wardOf("Casualty")).toBe("Casualty");
});
