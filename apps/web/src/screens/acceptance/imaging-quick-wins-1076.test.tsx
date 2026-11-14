import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { RadiologyWorklist } from "../radiology-worklist";
import { RadiologyRoom } from "../radiology-room";
import { RadiologyReports } from "../radiology-reports";

/**
 * ACCEPTANCE — issue #1076, spec docs/specs/1076-imaging-quick-wins.md (owner APPROVED 2026-11-14), the
 * web half: the worklist says words and IST times, the console shows the contrast the prep bay recorded,
 * and the hand-over desk prints the report in hand.
 */
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

type Reply = { status: number; body: unknown };
const calls: string[] = [];
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const worklistRow = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "R2608310001", status: "scheduled", priority: "routine",
  studyTypeCode: "USG-ABDO", studyTypeName: "Ultrasound abdomen", scheduledAt: "2026-08-31T09:00:00.000Z",
  deviceResourceId: "D1", encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  uhid: "HMS-00000001-5", ageYears: 30, sex: "female",
  formFRequired: false, restricted: false, createdAt: "2026-08-31T08:00:00.000Z", checkedInAt: null, ...over,
});

beforeEach(() => { setToken("t"); calls.length = 0; vi.stubGlobal("print", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

it("spec #1076 D6: the worklist shows 'Checked in', an IST clock time and the study name, never the raw values", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [worklistRow({ status: "checked_in" })] } },
  });
  renderWithProviders(<RadiologyWorklist />);
  const row = await screen.findByTestId("study-S1");
  expect(within(row).getByText("Checked in")).toBeInTheDocument();
  expect(row).toHaveTextContent(/14:30/); // 09:00 UTC is 14:30 IST
  expect(row).toHaveTextContent("Ultrasound abdomen");
  expect(row.textContent).not.toContain("checked_in");
  expect(row.textContent).not.toContain("2026-08-31T09:00:00.000Z");
});

const DEVICES = {
  devices: [{ id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 104", portable: false, status: "available", ionising: true, licensedNow: true }],
};
const roomView = (over: Record<string, unknown> = {}) => ({
  studyId: "S1", accessionNo: "R2609290001", status: "in_acquisition", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", bodyPart: "head", contrastOption: "required", lateralityApplicable: false,
  laterality: "na", ionising: true, bedsideLocation: null, encounterNo: "V1", patientId: "P1",
  mintedStudyInstanceUid: "2.25.1234",
  patient: { name: "Asha Devi", uhid: "HMS-00000001-5", restricted: false, ageYears: 30, sex: "female", allergies: [], weight: { kg: 58, recordedAt: ago(600) } },
  device: DEVICES.devices[0],
  protocol: { book: "none", version: null, matchedOn: null, protocol: null },
  drl: [], renal: null, repeats: [], doseReport: null,
  recordedContrast: { agent: "Omnipaque 350", volumeMl: 90 },
  ...over,
});

it("spec #1076 D8: the console's contrast fields show the agent and volume the prep bay recorded, without typing", async () => {
  mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: ["radiology.acquire", "radiology.worklist.read"], scoped: { department: {}, floor: {} } } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "GET /api/radiology/worklist": { status: 200, body: { rows: [worklistRow({ studyTypeCode: "CT-HEAD", studyTypeName: "CT head", deviceResourceId: "D-CT", status: "in_acquisition" })] } },
    "GET /api/radiology/studies/S1/room": { status: 200, body: { study: roomView() } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "ready", ready: true, open: [], gates: [] } },
  });
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  const volume = await screen.findByTestId("contrast-volume");
  await waitFor(() => { expect(volume).toHaveValue("90"); });
  expect(screen.getByLabelText("Agent and batch")).toHaveValue("Omnipaque 350");
  expect(screen.getByTestId("contrast-given")).toBeChecked();
});

const RELEASED = {
  studyId: "S1", reportId: "R1", version: 1, accessionNo: "X2609290001", studyName: "X-ray chest PA", modality: "xray",
  patientId: "P1", patientName: "Farida Khatoon", uhid: "HMS-1", publishedAt: ago(60),
  criticalCategory: null, bedsideLocation: null, hold: null, doctor: "read", notice: "queued", filmIncluded: true,
  handovers: [], media: [], needs: ["not_collected"],
};
const PRINT = {
  reportId: "R1", version: 1, status: "signed", accessionNo: "X2609290001", studyTypeName: "X-ray chest PA",
  acquiredAt: ago(120), signedAt: ago(90), amendmentReason: null, letterhead: null,
  patient: { name: "Farida Khatoon", uhid: "HMS-1", sex: "female", age: 41 },
  referrer: { doctorCode: null, department: null },
  sections: [{ key: "findings", label: "Findings", text: "Lungs clear." }], impression: "Normal chest.", codedLines: [],
  criticalCategory: null, signer: null, signerId: "u-rad",
};

it("spec #1076 D10: the hand-over shows a Print button for the report in hand, and pressing it renders the print view", async () => {
  mockRoutes({
    "GET /api/radiology/release": { status: 200, body: { rows: [RELEASED] } },
    "GET /api/radiology/release/reports/R1/print": { status: 200, body: { report: PRINT } },
  });
  renderWithProviders(<RadiologyReports />);
  const reg = await screen.findByTestId("release-register");
  await userEvent.click(await within(reg).findByRole("button", { name: "Open" }));
  const hand = screen.getByTestId("handover");
  await userEvent.click(within(hand).getByRole("button", { name: "Print report" }));
  const page = await screen.findByTestId("imaging-report-print");
  expect(page).toHaveTextContent("Normal chest.");
  expect(calls).toContain("GET /api/radiology/release/reports/R1/print");
});
