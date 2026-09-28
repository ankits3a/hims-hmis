import { screen, within } from "@testing-library/react";
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

it("opens the study console from a row", async () => {
  mockRoutes({ "GET /api/radiology/portable/round": { status: 200, body: { rows: [row({ studyId: "S9" })] } } });
  renderWithProviders(<RadiologyPortable />);
  await userEvent.click(await screen.findByTestId("round-S9"));
  expect(navigate).toHaveBeenCalledWith({ to: "/radiology/studies/$studyId", params: { studyId: "S9" } });
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
