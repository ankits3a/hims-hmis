import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { RadiologyReception } from "../radiology-reception";

/**
 * ACCEPTANCE — issue #1085, spec docs/specs/1085-imaging-morning-sweep.md (owner APPROVED 2026-11-14), the
 * web half (D2): on the day, the desk's Clocks show a booking 30 minutes past its slot that has not arrived,
 * with a one-tap no-show — the desk's own act, the reason the sweep writes for the same fact.
 *
 * Slot instants are RELATIVE to the real clock (a fixed time against a real clock is a time bomb).
 */
type Reply = { status: number; body: unknown };
type Seen = { key: string; body: unknown };
const seen: Seen[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    seen.push({ key, body: init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown });
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const ROW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", scheduledAt: minutesAgo(45), deviceResourceId: "D-CT",
  encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: minutesAgo(600), checkedInAt: null,
};
/** Ten minutes past its slot: not late yet. */
const ON_TIME = { ...ROW, studyId: "S2", accessionNo: "X2609290002", patientId: "P2", patientName: "Ravi Kumar", scheduledAt: minutesAgo(10) };

const DESK = ["radiology.schedule", "radiology.checkin", "radiology.worklist.read", "patients.read"];
const me: Reply = {
  status: 200,
  body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: DESK, scoped: { department: {}, floor: {} } } },
};

beforeEach(() => { setToken("t"); seen.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("spec #1085 D2: a booking 30 minutes past its slot and not arrived appears in the desk's Clocks with a no-show control", async () => {
  mockRoutes({
    "GET /api/auth/me": me,
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW, ON_TIME] } },
    "GET /api/radiology/devices": { status: 200, body: { devices: [] } },
    "POST /api/radiology/studies/S1/no-show": { status: 201, body: { studyId: "S1", status: "no_show" } },
  });
  renderWithProviders(<RadiologyReception />);

  const clocks = await screen.findByTestId("desk-clocks");
  await waitFor(() => { expect(within(clocks).getByText(/Asha Devi/)).toBeInTheDocument(); });
  expect(within(clocks).queryByText(/Ravi Kumar/)).toBeNull();

  await userEvent.click(within(clocks).getByRole("button", { name: /no-show/i }));
  await waitFor(() => {
    expect(seen.find((s) => s.key === "POST /api/radiology/studies/S1/no-show")?.body).toEqual({ reason: "not arrived" });
  });
});
