import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { RadiologyReception } from "../radiology-reception";

/**
 * ACCEPTANCE — issue #1084, spec docs/specs/1084-imaging-prepared-ahead.md (owner APPROVED 2026-11-14), the
 * web half (D6): the desk lane shows the readiness forecast for the patient in hand.
 *
 * The slot is RELATIVE to the real clock (three days ahead), and only displayed: nothing here measures a
 * window against it. The desk holds no `radiology.checkin`, so opening the patient is not an arrival.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const slot = new Date(Date.now() + 3 * 86_400_000).toISOString();

const ROW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-ABD-C", scheduledAt: slot, deviceResourceId: "D-CT",
  encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: new Date().toISOString(), checkedInAt: null,
};
const VIEW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-ABD-C", studyTypeName: "CT abdomen with contrast", modality: "ct", durationMin: 15,
  serviceId: "SVC-CT", encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi", uhid: "HMS-00000001-5",
  restricted: false, scheduledAt: slot, deviceResourceId: "D-CT", bedsideLocation: null, invoiceLineId: "IL1",
  intendedPayer: "self", authorisation: "invoice",
  checks: {
    gates: ["contrast_consent", "identity_two_factor", "prior_contrast_reaction", "renal_function"],
    pregnancyReason: "sex_not_female", policySource: "default", prep: ["nil_by_mouth_4h", "creatinine_report"],
  },
  addOns: [],
  forecast: {
    slotAt: slot, verdict: "creatinine_stale", kinds: ["creatinine_stale"], blocking: true, reviewReasons: [],
    creatinine: { resultId: "R1", sampledAt: new Date(Date.now() - 28 * 86_400_000).toISOString(), validDays: 30, validAtSlot: false },
  },
};

const me: Reply = {
  status: 200,
  body: {
    actor: { type: "user", id: "u-1" },
    permissions: { hospital: ["radiology.schedule", "radiology.worklist.read", "patients.read"], scoped: { department: {}, floor: {} } },
  },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("spec #1084 D6: the desk lane shows the forecast line for the patient in hand", async () => {
  mockRoutes({
    "GET /api/auth/me": me,
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: VIEW } },
    "GET /api/radiology/devices": { status: 200, body: { devices: [] } },
  });
  renderWithProviders(<RadiologyReception />);
  expect(screen.queryByTestId("forecast-S1")).toBeNull();
  await userEvent.click(await screen.findByTestId("row-S1"));

  const lane = await screen.findByTestId("patient-in-hand");
  await waitFor(() => { expect(within(lane).getByTestId("forecast-S1")).toBeInTheDocument(); });
  const line = within(lane).getByTestId("forecast-S1");
  expect(line).toHaveAttribute("data-verdict", "creatinine_stale");
  expect(line).toHaveTextContent(/no creatinine in the valid window/i);
});
