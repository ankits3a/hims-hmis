import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { dicomName } from "../lib/radiology-pacs-api";
import { RadiologyRoom } from "./radiology-room";

/**
 * PLAN 18-S RS12 — Unmatched images (the PACS inbox) and the console's dose report.
 *
 * What these pin: the two identities are shown side by side and a disagreeing UHID is marked; the
 * one act (Attach) needs an accession AND a reason and posts exactly those; a refusal names the seat
 * that fixes it; reject is a secondary act with its own reason; with nothing in hand the centre says
 * whether an archive exists and lists dose disagreements. At the console, a machine dose report
 * lets Send go with nothing typed, and mammography asks for AGD.
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
function bodiesOf(key: string): Record<string, unknown>[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
}
const me = (perms: string[]): Reply => ({ status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } });
const TECH = ["radiology.acquire", "radiology.worklist.read", "radiology.gates.satisfy", "radiology.checkin", "aerb.doses.read", "radiology.pacs.reconcile"];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const DEVICES = { devices: [{ id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 104", portable: false, status: "available", ionising: true, licensedNow: true }] };

const HELD = {
  id: "U1", studyInstanceUid: "1.2.5.1", accessionNumber: "X2609290004", dicomPatientId: "HMS-0000001-5",
  dicomPatientName: "DEVI^ASHA", modality: "CT", studyDate: "2026-09-29", seriesCount: 3, instanceCount: 212,
  reason: "patient_mismatch", receivedAt: ago(12), lastSeenAt: ago(10),
  candidate: { studyId: "S4", accessionNo: "X2609290004", patientName: "Asha Devi", uhid: "HMS-00000001-5", studyTypeCode: "CT-HEAD", status: "acquired", imageSource: "pacs" },
};
const INBOX = {
  configured: true, lastArrivalAt: ago(5), doseUnmatched: 1,
  unmatched: [HELD, { ...HELD, id: "U2", studyInstanceUid: "1.2.6.1", accessionNumber: "PHANTOM", dicomPatientId: "QA", dicomPatientName: "QA^PHANTOM", reason: "no_match", candidate: null }],
  doseConflicts: [{ id: "R1", studyId: "S2", accessionNo: "X2609290002", template: "ct_10011", conflict: { dlp: { typed: 84.6, sr: 845.6 } }, receivedAt: ago(30) }],
};
const base = (over: Record<string, Reply> = {}): Record<string, Reply> => ({
  "GET /api/auth/me": me(TECH),
  "GET /api/radiology/devices": { status: 200, body: DEVICES },
  "GET /api/radiology/pacs/inbox": { status: 200, body: INBOX },
  ...over,
});

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("dicomName reads a DICOM PN the way a person says it", () => {
  expect(dicomName("DEVI^ASHA")).toBe("ASHA DEVI");
  expect(dicomName("SHARMA^RAJ^KUMAR")).toBe("RAJ KUMAR SHARMA");
  expect(dicomName(null)).toBe("");
});

it("with nothing in hand: the archive's state, the one list, and the dose disagreements", async () => {
  mockRoutes(base());
  renderWithProviders(<RadiologyRoom search={{ view: "unmatched" }} />);
  expect(await screen.findByTestId("pacs-row-U1")).toHaveTextContent("ASHA DEVI");
  expect(screen.getByTestId("pacs-row-U1")).toHaveTextContent("Patient ID does not match the order");
  expect(screen.getByTestId("pacs-status")).toHaveTextContent(/never matched by a name/);
  expect(screen.getByTestId("dose-conflicts")).toHaveTextContent("DLP typed 84.6, machine 845.6");
  expect(screen.getByTestId("room-view-unmatched")).toHaveAttribute("aria-current", "page");
});

it("PACS not configured is said plainly", async () => {
  mockRoutes(base({ "GET /api/radiology/pacs/inbox": { status: 200, body: { ...INBOX, configured: false, unmatched: [], doseConflicts: [] } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "unmatched" }} />);
  expect(await screen.findByText("PACS not configured")).toBeInTheDocument();
  expect(screen.getByTestId("pacs-status")).toHaveTextContent(/No archive is declared yet/);
});

it("in hand: both identities side by side; Attach needs the accession and a reason and posts exactly those", async () => {
  mockRoutes(base({ "POST /api/radiology/pacs/unmatched/U1/attach": { status: 201, body: { studyId: "S4", accessionNo: "X2609290004" } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "unmatched" }} />);
  await userEvent.click(await screen.findByTestId("pacs-row-U1"));
  const cand = screen.getByTestId("pacs-candidate");
  expect(cand).toHaveTextContent("Asha Devi");
  expect(within(cand).getByText("HMS-00000001-5")).toHaveClass("text-red-700");
  expect(screen.getByTestId("attach-accession")).toHaveValue("X2609290004");
  expect(screen.getByTestId("dock-attach")).toBeDisabled();
  fireEvent.change(screen.getByTestId("attach-reason"), { target: { value: "UHID typed with a digit missing at CT-1" } });
  expect(screen.getByTestId("dock-attach")).toBeEnabled();
  await userEvent.click(screen.getByTestId("dock-attach"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/pacs/unmatched/U1/attach")).toEqual([{ accessionNo: "X2609290004", reason: "UHID typed with a digit missing at CT-1" }]); });
});

it("a refusal is the server's sentence, with the seat that fixes it", async () => {
  mockRoutes(base({ "POST /api/radiology/pacs/unmatched/U2/attach": { status: 409, body: { statusCode: 409, code: "not_acquired", message: "X2609290009 is in acquisition — the room sends it first" } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "unmatched" }} />);
  await userEvent.click(await screen.findByTestId("pacs-row-U2"));
  expect(screen.getByTestId("pacs-candidate")).toHaveTextContent("No order has this accession.");
  fireEvent.change(screen.getByTestId("attach-accession"), { target: { value: "x2609290009" } });
  fireEvent.change(screen.getByTestId("attach-reason"), { target: { value: "same patient" } });
  await userEvent.click(screen.getByTestId("dock-attach"));
  const alert = await screen.findByTestId("pacs-refusal");
  expect(alert).toHaveTextContent("the room sends it first");
  expect(within(alert).getByRole("link")).toHaveAttribute("href", "/radiology/room");
  expect(bodiesOf("POST /api/radiology/pacs/unmatched/U2/attach")[0]).toMatchObject({ accessionNo: "X2609290009" });
});

it("reject is the secondary act and carries its own reason", async () => {
  mockRoutes(base({ "POST /api/radiology/pacs/unmatched/U2/reject": { status: 201, body: { unmatchedId: "U2" } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "unmatched" }} />);
  await userEvent.click(await screen.findByTestId("pacs-row-U2"));
  expect(screen.getByTestId("reject")).toBeDisabled();
  fireEvent.change(screen.getByTestId("reject-reason"), { target: { value: "Morning QA phantom" } });
  await userEvent.click(screen.getByTestId("reject"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/pacs/unmatched/U2/reject")).toEqual([{ reason: "Morning QA phantom" }]); });
});

it("without the grant the view says who may reconcile and asks the server nothing", async () => {
  mockRoutes(base({ "GET /api/auth/me": me(["radiology.acquire"]) }));
  renderWithProviders(<RadiologyRoom search={{ view: "unmatched" }} />);
  expect(await screen.findByText(/Only a technologist or radiologist holding the PACS inbox/)).toBeInTheDocument();
  expect(bodiesOf("GET /api/radiology/pacs/inbox")).toHaveLength(0);
});

/* ═══ the console: the machine's dose report, and AGD ═══ */

const room = (over: Record<string, unknown> = {}) => ({
  studyId: "S1", accessionNo: "R2609290001", status: "in_acquisition", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", bodyPart: "head", contrastOption: "none", lateralityApplicable: false,
  laterality: "na", ionising: true, bedsideLocation: null, encounterNo: "V1", patientId: "P1", mintedStudyInstanceUid: "2.25.1234",
  patient: { name: "Asha Devi", uhid: "HMS-00000001-5", restricted: false, ageYears: 30, sex: "female", allergies: [], weight: null },
  device: DEVICES.devices[0], protocol: { book: "none", version: null, matchedOn: null, protocol: null },
  drl: [], renal: null, repeats: [], doseReport: null, ...over,
});
const consoleRoutes = (study: Record<string, unknown>): Record<string, Reply> => base({
  "GET /api/radiology/worklist": { status: 200, body: { rows: [] } },
  "GET /api/radiology/studies/S1/room": { status: 200, body: { study } },
  "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "in_acquisition", ready: true, open: [], gates: [] } },
  "GET /api/aerb/doses/patient/P1": { status: 200, body: { patientId: "P1", months: 12, studyCount: 0, overDrlCount: 0, totalDlp: null, totalDap: null, totalFluoroSeconds: null } },
  "POST /api/radiology/studies/S1/acquisition/acquired": { status: 200, body: { studyId: "S1", accessionNo: "R2609290001", studyInstanceUid: "2.25.1234", billDecisionIds: [] } },
});

it("a dose report from the machine: Send goes with nothing typed, and sends no dose and no doseManual", async () => {
  mockRoutes(consoleRoutes(room({ doseReport: { ctdivol: 52.1, dlp: 845.6, dap: null, fluoroSeconds: null, agd: null } })));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  expect(await screen.findByTestId("dose-report")).toHaveTextContent("52.1 · 845.6");
  expect(screen.getByTestId("dose-doseDlp")).toHaveAttribute("placeholder", "845.6");
  expect(screen.getByTestId("dock-act")).toBeEnabled();
  await userEvent.click(screen.getByTestId("dock-act"));
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")[0]).toEqual({ imageSource: "pacs" });
});

it("no dose report and nothing typed: the dock stays shut (the dose rule is unchanged)", async () => {
  mockRoutes(consoleRoutes(room()));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  await screen.findByTestId("dose-doseDlp");
  expect(screen.queryByTestId("dose-report")).toBeNull();
  expect(screen.getByTestId("dock-act")).toBeDisabled();
});

it("mammography asks for AGD, and a typed AGD is sent as doseAgd", async () => {
  mockRoutes(consoleRoutes(room({ modality: "mammography", studyTypeCode: "MG-SCREEN", studyTypeName: "Screening mammogram" })));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  fireEvent.change(await screen.findByTestId("dose-doseAgd"), { target: { value: "1.6" } });
  await userEvent.click(screen.getByTestId("dock-act"));
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")[0]).toEqual({ imageSource: "pacs", doseAgd: 1.6, doseManual: true });
});
