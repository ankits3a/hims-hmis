import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { suggestedContrastMl, aboveDrl } from "../lib/radiology-room-api";
import { RadiologyRoom, orderRoomList } from "./radiology-room";

/**
 * PLAN 18-S RS6 — THE MODALITY ROOMS: the console's four steps, the machine's list, and the three
 * views beside it. Every date is RELATIVE to the real clock (the house's fixed-date lesson).
 *
 * What these pin, beyond "it renders": the console never satisfies a PREP gate (it links to the
 * prep bay and keeps the dock shut); opening a booked patient checks them in and there is no
 * presence button; a refusal names the seat that fixes it; an above-DRL dose asks for a reason and
 * does not block; a repeat and a contrast-not-given carry their reasons to the server; resolving a
 * bill decision is offered only to its permission holder; marking a machine down is Setup's grant.
 */
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
function bodiesOf(key: string): Record<string, unknown>[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
}
const me = (perms: string[]): Reply => ({ status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } });
const TECH = ["radiology.acquire", "radiology.worklist.read", "radiology.gates.satisfy", "radiology.checkin", "aerb.doses.read"];

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const DEVICES = {
  devices: [
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 104", portable: false, status: "available", ionising: true, licensedNow: true },
    { id: "D-XR", code: "XR-1", name: "Digital X-ray", modality: "xray", room: "Room 101", portable: false, status: "down", ionising: true, licensedNow: true },
    { id: "D-PX", code: "PX-1", name: "Portable X-ray", modality: "xray", room: null, portable: true, status: "available", ionising: true, licensedNow: true },
  ],
};
const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "R2609290001", status: "ready", priority: "routine", studyTypeCode: "CT-HEAD",
  scheduledAt: ago(-30), deviceResourceId: "D-CT", encounterNo: "V1", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: ago(40), checkedInAt: ago(25), ...over,
});
const PROTOCOL = {
  study_type_code: "CT-HEAD", name: "CT brain with contrast", technique: "Axial, skull base to vertex.",
  kv: { min: 100, max: 120 }, contrast: { phase: "portal_venous", ml_per_kg: 1.5, max_ml: 100, delay_s: 70 },
  breath_hold: { en: "Keep your head still.", hi: "सिर बिल्कुल स्थिर रखें।" },
};
const room = (over: Record<string, unknown> = {}) => ({
  studyId: "S1", accessionNo: "R2609290001", status: "ready", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", bodyPart: "head", contrastOption: "required", lateralityApplicable: false,
  laterality: "na", ionising: true, bedsideLocation: null, encounterNo: "V1", patientId: "P1",
  mintedStudyInstanceUid: "2.25.1234",
  patient: { name: "Asha Devi", uhid: "HMS-00000001-5", restricted: false, ageYears: 30, sex: "female", allergies: ["Iohexol"], weight: { kg: 58, recordedAt: ago(600) } },
  device: DEVICES.devices[0],
  protocol: { book: "active", version: 2, matchedOn: "study_type", protocol: PROTOCOL },
  drl: [{ study_type_code: "CT-HEAD", quantity: "dlp", value: 1000 }],
  renal: { creatinineUmolL: 72, egfr: null, sampledAt: ago(60) },
  repeats: [],
  ...over,
});
const gates = (list: [string, string][]) => ({
  state: "ready", ready: true, open: list.filter(([, s]) => s === "open").map(([k]) => k),
  gates: list.map(([kind, state], i) => ({ id: `G${i}`, kind, state, waivable: false })),
});
const base = (over: Record<string, Reply> = {}): Record<string, Reply> => ({
  "GET /api/auth/me": me(TECH),
  "GET /api/radiology/devices": { status: 200, body: DEVICES },
  "GET /api/radiology/worklist": { status: 200, body: { rows: [row({})] } },
  "GET /api/radiology/studies/S1/room": { status: 200, body: { study: room() } },
  "GET /api/radiology/studies/S1/readiness": { status: 200, body: gates([["identity_two_factor", "satisfied"], ["contrast_consent", "satisfied"]]) },
  "GET /api/aerb/doses/patient/P1": { status: 200, body: { patientId: "P1", months: 12, studyCount: 2, overDrlCount: 1, totalDlp: "1800", totalDap: null, totalFluoroSeconds: null } },
  ...over,
});

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("the list is this machine's: STAT first, then furthest along; clocks name the STAT over 10 min", async () => {
  mockRoutes(base({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [
      row({ studyId: "A", patientName: "Booked One", status: "scheduled" }),
      row({ studyId: "B", patientName: "Stat Two", status: "checked_in", priority: "stat", createdAt: ago(14) }),
      row({ studyId: "C", patientName: "Ready Three", status: "ready" }),
    ] } },
  }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1" }} />);
  const list = within(await screen.findByTestId("room-list"));
  await waitFor(() => { expect(list.getAllByRole("button")).toHaveLength(3); });
  expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual([
    expect.stringContaining("Stat Two"), expect.stringContaining("Ready Three"), expect.stringContaining("Booked One"),
  ]);
  expect(calls).toContain("GET /api/radiology/worklist");
  expect(screen.getByTestId("room-clocks")).toHaveTextContent(/Stat Two · CT-HEAD — STAT waiting 14 min/);
  /** A down machine is flagged in the picker; the idle centre names who is ready. */
  expect(screen.getByTestId("machine-idle")).toHaveTextContent(/Ready for the table: Ready Three/);
});

it("orderRoomList: STAT, then in acquisition → ready → arrived → booked, then by slot", () => {
  const out = orderRoomList([
    row({ studyId: "1", status: "scheduled" }), row({ studyId: "2", status: "in_acquisition" }),
    row({ studyId: "3", status: "ready", priority: "stat" }), row({ studyId: "4", status: "checked_in" }),
  ] as never);
  expect(out.map((r) => r.studyId)).toEqual(["3", "2", "4", "1"]);
});

it("opening a BOOKED patient is the check-in — there is no presence button", async () => {
  mockRoutes(base({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [row({ status: "scheduled" })] } },
    "POST /api/radiology/studies/S1/check-in": { status: 200, body: { studyId: "S1", status: "checked_in", gates: [], pregnancyReason: "opened", policySource: "default" } },
  }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1" }} />);
  await userEvent.click(await screen.findByTestId("room-row-S1"));
  await waitFor(() => { expect(calls).toContain("POST /api/radiology/studies/S1/check-in"); });
  expect(screen.queryByRole("button", { name: /check in|arrived|in the room/i })).toBeNull();
});

it("Identify: a PREP gate open is shown with the prep bay link and the dock stays shut — the console never closes it", async () => {
  mockRoutes(base({
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: gates([["identity_two_factor", "satisfied"], ["renal_function", "open"]]) },
  }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  const note = await screen.findByTestId("prep-open");
  expect(note).toHaveTextContent(/prep bay still owes/i);
  expect(within(note).getByRole("link", { name: "Open the prep bay" })).toHaveAttribute("href", "/radiology/prep");
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  expect(calls.some((c) => c.includes("/gates/renal_function/"))).toBe(false);
});

it("Identify: the second identifier goes to the server to be compared, only after the name is said", async () => {
  mockRoutes(base({
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: gates([["identity_two_factor", "open"], ["laterality_confirm", "open"]]) },
    "POST /api/radiology/studies/S1/gates/identity_two_factor/satisfy": { status: 200, body: {} },
    "POST /api/radiology/studies/S1/gates/laterality_confirm/satisfy": { status: 200, body: {} },
  }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  await userEvent.type(await screen.findByTestId("id-value"), "HMS-00000001-5");
  expect(screen.getByTestId("id-check")).toBeDisabled();
  await userEvent.click(screen.getByTestId("id-first"));
  await userEvent.click(screen.getByTestId("id-check"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/gates/identity_two_factor/satisfy")).toEqual([{ secondIdentifier: "wristband", value: "HMS-00000001-5" }]); });
  await userEvent.click(screen.getByTestId("side-left"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/gates/laterality_confirm/satisfy")).toEqual([{ patientStated: "left" }]); });
  expect(screen.getByTestId("dock-act")).toBeDisabled();
});

it("Protocol: the book's card, the volume for this weight, and the words in Hindi", async () => {
  mockRoutes(base());
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  await userEvent.click(await screen.findByTestId("step-protocol"));
  expect(screen.getByTestId("protocol-card")).toHaveTextContent("CT brain with contrast");
  expect(screen.getByTestId("contrast-suggestion")).toHaveTextContent("Suggested volume: 87 mL");
  await userEvent.click(within(screen.getByTestId("breath-hold")).getByRole("button", { name: "हिं" }));
  expect(screen.getByTestId("breath-hold")).toHaveTextContent("सिर बिल्कुल स्थिर रखें।");
});

it("Protocol: no book published is said plainly, with the way to Setup → Books", async () => {
  mockRoutes(base({ "GET /api/radiology/studies/S1/room": { status: 200, body: { study: room({ protocol: { book: "none", version: null, matchedOn: null, protocol: null } }) } } }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  await userEvent.click(await screen.findByTestId("step-protocol"));
  const note = screen.getByTestId("no-protocol");
  expect(note).toHaveTextContent(/No protocol book is published yet/);
  expect(within(note).getByRole("link")).toHaveAttribute("href", "/radiology/setup?view=books");
});

it("Acquire: a refused start is the server's words with the seat that fixes it", async () => {
  mockRoutes(base({
    "POST /api/radiology/studies/S1/acquisition/start": { status: 422, body: { statusCode: 422, code: "payment_required", message: "study is a self-pay routine scan with no invoice line" } },
  }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  await userEvent.click(await screen.findByTestId("step-acquire"));
  await userEvent.click(screen.getByTestId("dock-act"));
  const refusal = await screen.findByText(/self-pay routine scan/);
  const box = refusal.closest("[data-refusal]")!;
  expect(box).toHaveAttribute("data-refusal", "payment_required");
  expect(within(box as HTMLElement).getByRole("link")).toHaveAttribute("href", "/radiology/reception");
});

it("Acquire → Send: CT dose above the DRL asks why (never blocks); repeat and contrast-not-given carry their reasons", async () => {
  mockRoutes(base({
    "GET /api/radiology/studies/S1/room": { status: 200, body: { study: room({ status: "in_acquisition" }) } },
    "POST /api/radiology/studies/S1/acquisition/repeat": { status: 200, body: { studyId: "S1", billDecisionId: "BD1" } },
    "POST /api/radiology/studies/S1/acquisition/acquired": { status: 200, body: { studyId: "S1", accessionNo: "R2609290001", studyInstanceUid: "2.25.1234", billDecisionIds: [] } },
  }));
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  fireEvent.change(await screen.findByTestId("dose-doseDlp"), { target: { value: "1250" } });
  fireEvent.change(screen.getByTestId("dose-doseCtdivol"), { target: { value: "58" } });
  expect(screen.getByTestId("drl-over")).toHaveTextContent(/Above the hospital's DRL/);
  fireEvent.change(screen.getByTestId("drl-reason"), { target: { value: "Large patient" } });

  await userEvent.selectOptions(screen.getByTestId("repeat-reason"), "motion");
  await userEvent.click(screen.getByTestId("repeat"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/repeat")).toEqual([{ reason: "motion" }]); });

  await userEvent.click(screen.getByTestId("contrast-not-given"));
  fireEvent.change(screen.getByTestId("not-given-reason"), { target: { value: "Cannula tissued" } });
  expect(screen.getByTestId("dock-act")).toBeEnabled();
  await userEvent.click(screen.getByTestId("dock-act"));
  await userEvent.click(screen.getByTestId("source-none"));
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S1/acquisition/acquired")[0]).toEqual({
    imageSource: "no_pacs_images", doseCtdivol: 58, doseDlp: 1250, doseManual: true, drlReason: "Large patient",
    contrastGiven: false, contrastNotGivenReason: "Cannula tissued",
  });
});

it("Rejects: the rate per machine and technologist; resolving is the desk's, not the technologist's", async () => {
  const rejects = {
    from: "2026-09-23", to: "2026-09-29",
    rows: [{ deviceResourceId: "D-CT", deviceCode: "CT-1", technologistId: "u-1", technologistName: "Amit Oraon", acquired: 20, repeats: 1 }],
    reasons: [{ reason: "motion", count: 1 }],
    log: [{ at: ago(30), studyId: "S1", accessionNo: "R2609290001", studyTypeCode: "CT-HEAD", deviceCode: "CT-1", technologistName: "Amit Oraon", reason: "motion" }],
    openDecisions: [{ id: "BD1", kind: "repeat_no_charge", studyId: "S1", accessionNo: "R2609290001", reason: "motion", raisedAt: ago(30) }],
  };
  mockRoutes(base({ "GET /api/radiology/room/rejects": { status: 200, body: rejects } }));
  renderWithProviders(<RadiologyRoom search={{ view: "rejects" }} />);
  expect(await screen.findByTestId("rate-row")).toHaveTextContent(/CT-1.*Amit Oraon.*20.*1.*5%/);
  expect(within(screen.getByTestId("open-decisions")).getByText(/With the imaging front desk/)).toBeInTheDocument();
  expect(screen.queryByTestId("resolve-BD1")).toBeNull();
});

it("Rejects: a holder of the bill-decisions grant resolves through the existing route, with a resolution", async () => {
  const rejects = { from: "a", to: "b", rows: [], reasons: [], log: [], openDecisions: [{ id: "BD1", kind: "contrast_not_given", studyId: "S1", accessionNo: "R1", reason: "Cannula tissued", raisedAt: ago(5) }] };
  mockRoutes(base({
    "GET /api/auth/me": me([...TECH, "radiology.bill_decisions.manage"]),
    "GET /api/radiology/room/rejects": { status: 200, body: rejects },
    "POST /api/radiology/bill-decisions/BD1/resolve": { status: 200, body: {} },
  }));
  renderWithProviders(<RadiologyRoom search={{ view: "rejects" }} />);
  const list = within(await screen.findByTestId("open-decisions"));
  const input = await list.findByRole("textbox");
  await userEvent.type(input, "Contrast reversed on the bill");
  await userEvent.click(list.getByTestId("resolve-BD1"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/bill-decisions/BD1/resolve")).toEqual([{ resolution: "Contrast reversed on the bill" }]); });
});

it("Downtime: a technologist is told who marks a machine down; the holder marks it and sees who to move", async () => {
  mockRoutes(base());
  const { unmount } = renderWithProviders(<RadiologyRoom search={{ view: "downtime" }} />);
  expect(await screen.findByTestId("down-ask")).toHaveTextContent(/radiologist in charge/);
  expect(await within(screen.getByTestId("machines-out")).findByText("XR-1")).toBeInTheDocument();
  expect(screen.getByTestId("paper-mode")).toHaveTextContent(/manual accession sheets/);
  unmount();

  mockRoutes(base({
    "GET /api/auth/me": me([...TECH, "radiology.devices.manage"]),
    "POST /api/radiology/setup/devices/D-CT/status": { status: 200, body: { from: "available", to: "down", studiesToMove: [{ studyId: "S1", accessionNo: "R2609290001", studyTypeCode: "CT-HEAD", status: "scheduled", scheduledAt: null }] } },
  }));
  renderWithProviders(<RadiologyRoom search={{ view: "downtime" }} />);
  await userEvent.selectOptions(await screen.findByTestId("down-machine"), "D-CT");
  await userEvent.type(screen.getByTestId("down-reason"), "Tube arcing");
  await userEvent.click(screen.getByTestId("down-report"));
  const moved = await screen.findByTestId("studies-to-move");
  expect(moved).toHaveTextContent(/CT-1 is down\. 1 booked patient to move/);
  expect(within(moved).getByRole("link")).toHaveAttribute("href", "/radiology/diary");
  expect(bodiesOf("POST /api/radiology/setup/devices/D-CT/status")).toEqual([{ status: "down", reason: "Tube arcing" }]);
});

it("the two suggestions are arithmetic the console shows, never controls", () => {
  expect(suggestedContrastMl(PROTOCOL as never, 58)).toBe(87);
  expect(suggestedContrastMl(PROTOCOL as never, 90)).toBe(100);
  expect(suggestedContrastMl({ ...PROTOCOL, paediatric: { bands: [{ from_kg: 10, to_kg: 20, ml_per_kg: 2 }] } } as never, 15)).toBe(30);
  expect(suggestedContrastMl(PROTOCOL as never, null)).toBeNull();
  expect(aboveDrl([{ quantity: "dlp", value: 1000 }], { doseDlp: 1200 })).toHaveLength(1);
  expect(aboveDrl([{ quantity: "dlp", value: 1000 }], { doseDlp: 900 })).toHaveLength(0);
});
