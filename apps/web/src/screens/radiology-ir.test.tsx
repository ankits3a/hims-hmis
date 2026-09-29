import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { draftInstructions, karLevel, parseFluoro } from "../lib/radiology-ir-api";
import { RadiologyRoom } from "./radiology-room";

/**
 * PLAN 18-S RS12b — the IR suite (`/radiology/room?view=ir`).
 *
 * What these pin: the one list with each case's next step; the WHO phases are FORMS and post their
 * items (no JSON); the coagulation card shows the numbers and their dates, the refusal in words,
 * and the override only to the radiologist; the dose tiles raise the 3 Gy / 5 Gy alerts from a
 * typed Ka,r and the dock turns into the skin-check booking before Send; a due sedation reading
 * takes the dock; the hand-off carries English and Hindi; a server refusal is its own sentence
 * with the seat that fixes it.
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
const TECH = ["radiology.acquire", "radiology.worklist.read", "radiology.gates.satisfy", "radiology.checkin"];
const RADIOLOGIST = [...TECH, "radiology.gates.override"];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const THRESHOLDS = {
  skinFollowUpMgy: 3000, srdlMgy: 5000, inrMax: 1.5, plateletsMinPerUl: 50_000, coagValidDays: 7, vitalsEveryMin: 5, recoveryVitalsEveryMin: 15,
  skinFollowUpDays: { min: 14, max: 28 }, fastingSolidsHours: 6, fastingClearHours: 2,
};
const ROW = {
  studyId: "S1", accessionNo: "R2609290011", status: "ready", priority: "urgent", studyTypeCode: "IR-PCN",
  studyTypeName: "Percutaneous nephrostomy (PCN)", bleedingRisk: "high", scheduledAt: ago(-30), deviceCode: "IR-1",
  patientId: "P1", patientName: "Rajkumar Gope", restricted: false, phases: [], handedOff: false, lastVitalsAt: null, next: "sign_in",
};
const kase = (over: Record<string, unknown> = {}) => ({
  studyId: "S1", accessionNo: "R2609290011", status: "ready", priority: "urgent", studyTypeCode: "IR-PCN",
  studyTypeName: "Percutaneous nephrostomy (PCN)", bleedingRisk: "high", lateralityApplicable: true, laterality: "left",
  patient: { name: "Rajkumar Gope", uhid: "HMS-00000009-2", restricted: false, ageYears: 49, sex: "male" },
  phases: [],
  coagulation: { required: true, inr: { value: 1.3, sampledAt: ago(600) }, platelets: { perUl: 88_000, sampledAt: ago(600) }, verdicts: [], override: null },
  sedation: { plan: null, vitals: [], nextDueAt: null },
  dose: { karMgy: null, dapGyCm2: null, fluoroSeconds: null, levels: [] },
  skinFollowUp: null, note: null, handoff: null, next: "sign_in", thresholds: THRESHOLDS,
  ...over,
});
const ROOM = {
  studyId: "S1", accessionNo: "R2609290011", status: "ready", priority: "urgent", studyTypeCode: "IR-PCN", studyTypeName: "PCN",
  modality: "xray", bodyPart: "kidney", contrastOption: "optional", lateralityApplicable: true, laterality: "left", ionising: true,
  bedsideLocation: null, encounterNo: "IP1", patientId: "P1", mintedStudyInstanceUid: "2.25.1",
  patient: { name: "Rajkumar Gope", uhid: "HMS-00000009-2", restricted: false, ageYears: 49, sex: "male", allergies: ["Iohexol"], weight: null },
  device: { id: "D-IR", code: "IR-1", name: "IR suite", modality: "xray", room: null, portable: false, status: "available", ionising: true, licensedNow: true },
  protocol: { book: "none", version: null, matchedOn: null, protocol: null }, drl: [], renal: null, repeats: [], doseReport: null,
};
const SIGNED = (phase: string) => ({ phase, items: [], participants: ["Dr Rao", "Sr Tirkey"], recordedByName: "Sr Tirkey", recordedAt: ago(20) });
const base = (c: Record<string, unknown>, over: Record<string, Reply> = {}, perms = TECH): Record<string, Reply> => ({
  "GET /api/auth/me": me(perms),
  "GET /api/radiology/devices": { status: 200, body: { devices: [] } },
  "GET /api/radiology/ir/cases": { status: 200, body: { rows: [ROW] } },
  "GET /api/radiology/studies/S1/ir": { status: 200, body: { case: c } },
  "GET /api/radiology/studies/S1/room": { status: 200, body: { study: ROOM } },
  ...over,
});

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("pure: fluoro time reads min:s or seconds; Ka,r levels; the instructions carry the same sentences in both languages", () => {
  expect(parseFluoro("12:30")).toBe(750);
  expect(parseFluoro("90")).toBe(90);
  expect(parseFluoro("1:75")).toBeNull();
  expect(karLevel(2999, THRESHOLDS)).toBe("none");
  expect(karLevel(3000, THRESHOLDS)).toBe("skin");
  expect(karLevel(5000, THRESHOLDS)).toBe("srdl");
  const d = draftInstructions(6, true);
  expect(d.en).toMatch(/6 hours.*drain/);
  expect(d.hi).toMatch(/6 घंटे.*ड्रेन/);
});

it("with nothing in hand: the IR suite is a header view of the Rooms station, with the one list and each case's next step", async () => {
  mockRoutes(base(kase()));
  renderWithProviders(<RadiologyRoom search={{ view: "ir" }} />);
  const row = await screen.findByTestId("ir-row-S1");
  expect(row).toHaveTextContent("Rajkumar Gope");
  expect(row).toHaveTextContent("Percutaneous nephrostomy (PCN) · IR-1");
  expect(row).toHaveTextContent("Sign in due");
  expect(screen.getByTestId("room-view-ir")).toHaveAttribute("aria-current", "page");
  expect(screen.getByTestId("ir-idle")).toHaveTextContent("Next: Rajkumar Gope");
});

it("Sign in is a form: its items post as fields (consent with the procedure and side, fasting in IST), and Enter runs the dock", async () => {
  mockRoutes(base(kase(), { "POST /api/radiology/studies/S1/ir/sign-in": { status: 201, body: { phase: "sign_in" } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  expect(await screen.findByTestId("ir-dock-act")).toHaveTextContent("Record Sign in");
  expect(screen.getByTestId("ir-dock-act")).toBeDisabled();
  expect(screen.getByTestId("ir-lane-allergies")).toHaveTextContent("Iohexol");
  fireEvent.change(screen.getByTestId("si-people"), { target: { value: "Dr Rao (operator)\nSr Tirkey" } });
  fireEvent.click(screen.getByTestId("si-identity"));
  fireEvent.change(screen.getByTestId("si-witness"), { target: { value: "Sunita Oraon" } });
  fireEvent.click(screen.getByTestId("si-site"));
  fireEvent.click(screen.getByTestId("si-allergies"));
  fireEvent.change(screen.getByTestId("si-sedation-by"), { target: { value: "Sr Tirkey" } });
  fireEvent.change(screen.getByTestId("si-solids"), { target: { value: "2026-09-29T02:00" } });
  fireEvent.change(screen.getByTestId("si-clear"), { target: { value: "2026-09-29T07:00" } });
  fireEvent.click(screen.getByTestId("si-iv"));
  expect(screen.getByTestId("ir-dock-act")).toBeEnabled();
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/ir/sign-in")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/ir/sign-in")[0]).toMatchObject({
    participants: ["Dr Rao (operator)", "Sr Tirkey"], identityConfirmed: true, siteMarked: true, allergiesReviewed: true,
    anticoagulants: "none", sedationPlan: "moderate", sedationBy: "Sr Tirkey", ivAccessAndResus: true,
    lastSolidsAt: "2026-09-29T02:00:00+05:30", lastClearFluidsAt: "2026-09-29T07:00:00+05:30",
    consent: { procedureCode: "IR-PCN", language: "hi", signer: "patient", witness: "Sunita Oraon", laterality: "left" },
  });
});

it("coagulation out of range: the numbers with their dates, the refusal in words; the override is the radiologist's and posts the reason", async () => {
  const bad = kase({ coagulation: { required: true, inr: { value: 1.8, sampledAt: ago(600) }, platelets: { perUl: 140_000, sampledAt: ago(600) }, verdicts: ["inr_high"], override: null } });
  mockRoutes(base(bad));
  const first = renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  const card = await screen.findByTestId("ir-coag-refusal");
  expect(card).toHaveTextContent("INR above 1.5");
  expect(within(screen.getByTestId("ir-inr")).getByText("1.8")).toHaveClass("text-red-700");
  expect(screen.queryByTestId("ir-override")).toBeNull();
  expect(card).toHaveTextContent(/ask the operating radiologist/);
  first.unmount();

  mockRoutes(base(bad, { "POST /api/radiology/studies/S1/ir/coagulation-override": { status: 201, body: { verdicts: ["inr_high"] } } }, RADIOLOGIST));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  expect(await screen.findByTestId("ir-override")).toBeDisabled();
  fireEvent.change(screen.getByTestId("ir-override-reason"), { target: { value: "Infected obstructed kidney — drain now" } });
  await userEvent.click(screen.getByTestId("ir-override"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/ir/coagulation-override")).toEqual([{ reason: "Infected obstructed kidney — drain now" }]); });
});

it("on the table: Ka,r ≥ 3 Gy lights the tile and the alert; the dock books the skin check first, then Send posts the dose", async () => {
  const onTable = kase({ status: "in_acquisition", phases: [SIGNED("sign_in"), SIGNED("time_out"), SIGNED("sign_out")], next: "send", sedation: { plan: "local", vitals: [], nextDueAt: null } });
  mockRoutes(base(onTable, {
    "POST /api/radiology/studies/S1/ir/skin-follow-up": { status: 201, body: { followUpOn: "2026-10-20" } },
  }));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  fireEvent.change(await screen.findByTestId("dose-fluoro"), { target: { value: "38:20" } });
  fireEvent.change(screen.getByTestId("dose-dap"), { target: { value: "182.4" } });
  fireEvent.change(screen.getByTestId("dose-kar"), { target: { value: "3210" } });
  expect(screen.getByTestId("tile-kar")).toHaveTextContent("3.21");
  expect(screen.getByTestId("tile-kar")).toHaveAttribute("data-tone", "red");
  expect(screen.getByTestId("ir-skin-alert")).toHaveAttribute("data-level", "skin");
  expect(screen.getByTestId("ir-dock-act")).toHaveTextContent("Book the skin check");
  fireEvent.change(screen.getByTestId("skin-on"), { target: { value: "2026-10-20" } });
  await userEvent.click(screen.getByTestId("ir-dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/ir/skin-follow-up")).toEqual([{ patientInformed: true, followUpOn: "2026-10-20" }]); });

  fireEvent.change(screen.getByTestId("dose-kar"), { target: { value: "5400" } });
  expect(screen.getByTestId("ir-skin-alert")).toHaveAttribute("data-level", "srdl");
  expect(screen.getByTestId("ir-skin-alert")).toHaveTextContent("substantial radiation dose level");
});

it("Send posts the typed dose (fluoro min:s → seconds, DAP, Ka,r) once the skin check is on file", async () => {
  const ready = kase({
    status: "in_acquisition", phases: [SIGNED("sign_in"), SIGNED("time_out"), SIGNED("sign_out")], next: "send",
    sedation: { plan: "local", vitals: [], nextDueAt: null }, skinFollowUp: { on: "2026-10-20", note: null, byName: "Sr Tirkey", at: ago(1) },
  });
  mockRoutes(base(ready, { "POST /api/radiology/studies/S1/acquisition/acquired": { status: 201, body: { studyId: "S1", accessionNo: "R2609290011", studyInstanceUid: null, billDecisionIds: [] } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  fireEvent.change(await screen.findByTestId("dose-fluoro"), { target: { value: "38:20" } });
  fireEvent.change(screen.getByTestId("dose-dap"), { target: { value: "182.4" } });
  fireEvent.change(screen.getByTestId("dose-kar"), { target: { value: "3210" } });
  expect(screen.getByTestId("ir-skin-done")).toHaveTextContent("2026-10-20");
  expect(screen.getByTestId("ir-dock-act")).toHaveTextContent("Send");
  await userEvent.click(screen.getByTestId("ir-dock-act"));
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")).toEqual([
      { imageSource: "pacs", fluoroSeconds: 2300, doseDap: 182.4, doseKar: 3210, doseManual: true },
    ]);
  });
});

it("a sedation reading that is due takes the dock; it posts BP, HR, SpO₂, RASS and the drug", async () => {
  const due = kase({
    status: "in_acquisition", phases: [SIGNED("sign_in"), SIGNED("time_out")], next: "sign_out",
    sedation: { plan: "moderate", vitals: [{ id: "V1", bpSystolic: 124, bpDiastolic: 78, heartRate: 88, spo2: 98, rass: 0, drug: "Midazolam 1 mg IV", recordedByName: "Sr Tirkey", recordedAt: ago(7) }], nextDueAt: ago(2) },
  });
  mockRoutes(base(due, { "POST /api/radiology/studies/S1/ir/vitals": { status: 201, body: { id: "V2" } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  expect(await screen.findByTestId("ir-vitals-clock")).toHaveTextContent(/overdue/);
  expect(screen.getByTestId("ir-dock-act")).toHaveTextContent("Record sedation reading");
  expect(screen.getByTestId("ir-vitals")).toHaveTextContent("124/78");
  fireEvent.change(screen.getByTestId("vit-sys"), { target: { value: "118" } });
  fireEvent.change(screen.getByTestId("vit-dia"), { target: { value: "74" } });
  fireEvent.change(screen.getByTestId("vit-hr"), { target: { value: "92" } });
  fireEvent.change(screen.getByTestId("vit-spo2"), { target: { value: "97" } });
  fireEvent.change(screen.getByTestId("vit-rass"), { target: { value: "-1" } });
  fireEvent.change(screen.getByTestId("vit-drug"), { target: { value: "Fentanyl 25 µg IV" } });
  await userEvent.click(screen.getByTestId("ir-dock-act"));
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/studies/S1/ir/vitals")).toEqual([{ bpSystolic: 118, bpDiastolic: 74, heartRate: 92, spo2: 97, rass: -1, drug: "Fentanyl 25 µg IV" }]);
  });
});

it("the hand-off is drafted in English and Hindi from the procedure and posts both with who received the patient", async () => {
  const toRecovery = kase({
    status: "acquired", phases: [SIGNED("sign_in"), SIGNED("time_out"), SIGNED("sign_out")], next: "handoff",
    sedation: { plan: "moderate", vitals: [{ id: "V1", bpSystolic: 116, bpDiastolic: 72, heartRate: 88, spo2: 98, rass: 0, drug: null, recordedByName: "Sr Tirkey", recordedAt: ago(3) }], nextDueAt: ago(-2) },
    note: { procedure: "Left PCN, 8 Fr pigtail", approach: null, devices: "8 Fr pigtail", specimens: null, complications: null, bloodLossMl: 10, byName: "Dr Rao", at: ago(2) },
  });
  mockRoutes(base(toRecovery, { "POST /api/radiology/studies/S1/ir/handoff": { status: 201, body: { handoffAt: ago(0) } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  await waitFor(() => { expect((screen.getByTestId("ho-en") as HTMLTextAreaElement).value).toContain("6 hours"); });
  expect((screen.getByTestId("ho-hi") as HTMLTextAreaElement).value).toContain("6 घंटे");
  expect(screen.getByTestId("ho-bedrest")).toHaveValue("6");
  expect(screen.getByTestId("ir-dock-act")).toBeDisabled();
  fireEvent.change(screen.getByTestId("ho-received"), { target: { value: "Sr Kujur, Ward 3" } });
  await userEvent.click(screen.getByTestId("ir-dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/ir/handoff")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/ir/handoff")[0]).toMatchObject({
    vitals: { bpSystolic: 116, bpDiastolic: 72, heartRate: 88, spo2: 98 }, bedRestHours: 6, receivedBy: "Sr Kujur, Ward 3",
    instructionsEn: expect.stringContaining("Lie flat"), instructionsHi: expect.stringContaining("सीधे लेटे"),
  });
});

it("a server refusal is its own sentence, with the seat that fixes it", async () => {
  const start = kase({ phases: [SIGNED("sign_in"), SIGNED("time_out")], next: "start" });
  mockRoutes(base(start, { "POST /api/radiology/studies/S1/acquisition/start": { status: 402, body: { statusCode: 402, code: "payment_required", message: "self-pay routine scan with no invoice line" } } }));
  renderWithProviders(<RadiologyRoom search={{ view: "ir", study: "S1" }} />);
  expect(await screen.findByTestId("ir-dock-act")).toHaveTextContent("Start the procedure");
  await userEvent.click(screen.getByTestId("ir-dock-act"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("self-pay routine scan with no invoice line");
  expect(within(alert).getByRole("link")).toHaveAttribute("href", "/radiology/reception");
});
