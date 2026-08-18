import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdVitals } from "./opd-vitals";

// 2026-08-18T04:00:00.000Z + 5:30 = 2026-08-18 09:30 IST (the T12/T13 pin).
const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

/**
 * jsdom ships no WebSocket a test can drive (flag ⑮), so the transport is replaced by this fake and
 * restored in afterEach. Copied deliberately from the opd-desk.test.tsx precedent — a test file is
 * self-contained, it never imports another *.test.ts(x).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

// ——— fixtures ———

function department(id: string, code: string, name: string): Record<string, unknown> {
  return { id, code, name, active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO };
}
const DEPARTMENTS = [department("dep-1", "MED", "General medicine"), department("dep-2", "PED", "Paediatrics")];

function doctor(id: string, displayName: string, departmentId: string): Record<string, unknown> {
  return {
    id, userId: `u-${id}`, displayName, registrationNo: "NMC-1", departmentId,
    specialty: "General", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
  };
}
const DOCTORS = [doctor("doc-1", "Dr Meera Rao", "dep-1"), doctor("doc-2", "Dr Anil Verma", "dep-2")];

/** The four bands from modules/opd/config.ts's DEFAULT_DANGER_RANGES — only the fields this screen's
 * mirror reads (key, upToAgeYears, required). */
const DANGER_RANGES = {
  weightRequiredUnderYears: 18,
  bands: [
    { key: "infant", upToAgeYears: 1, required: ["weightKg", "tempC", "spo2", "pulse"], ranges: {} },
    { key: "child_1_5", upToAgeYears: 6, required: ["heightCm", "weightKg", "tempC", "spo2", "pulse"], ranges: {} },
    { key: "child_6_12", upToAgeYears: 13, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], ranges: {} },
    { key: "adult", upToAgeYears: null, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], ranges: {} },
  ],
};
const CONFIG = {
  slotMinutes: 10, followUpDefaultDays: 7, followUpExtensionDays: [15, 21, 30],
  extensionCapPerDoctorPerMonth: 2, maxSkipsBeforeLeft: 3, perkEveryNth: null,
  dangerRanges: DANGER_RANGES,
  letterhead: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"] },
};

function encounter(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "enc-1", patientId: "p-adult", type: "opd_visit", status: "registered", workflowInstanceId: "wf-1",
    departmentId: "dep-1", doctorId: "doc-1", appointmentId: null, serviceDate: TODAY,
    visitType: "new", intendedPayer: "self", referralSource: null, referrerName: null,
    chiefComplaint: null, diagnosis: null, icd10Code: null, advice: null,
    admissionAdvised: false, referralTo: null, referralNote: null,
    followUpDays: null, followUpExtended: false, dangerFlagged: false,
    consultStartedAt: null, consultCompletedAt: null, abandonedAt: null, abandonReason: null,
    openedBy: "u-1", openedAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
    patient: { name: "Ravi Kumar", alias: null, restricted: false, uhid: "HMS0000000020" },
    queueEntry: { tokenNo: 5 },
    ...overrides,
  };
}

const ENC_ADULT = encounter({ dangerFlagged: true });
const ENC_CHILD = encounter({
  id: "enc-2", patientId: "p-child", departmentId: "dep-2", doctorId: "doc-2", dangerFlagged: true,
  openedAt: "2026-08-18T04:10:00.000Z",
  patient: { name: "Baby Naina", alias: null, restricted: false, uhid: "HMS0000000010" },
  queueEntry: { tokenNo: 2 },
});
const ENC_HIDDEN = encounter({
  id: "enc-3", patientId: "p-hidden", departmentId: "dep-1", doctorId: "doc-1",
  openedAt: "2026-08-18T04:20:00.000Z",
  patient: { name: null, alias: "Patient C", restricted: true, uhid: "HMS0000000030" },
  queueEntry: { tokenNo: 9 },
});
const ENC_ADULT2 = encounter({
  id: "enc-2", patientId: "p-adult2", openedAt: "2026-08-18T04:05:00.000Z",
  patient: { name: "Suresh Yadav", alias: null, restricted: false, uhid: "HMS0000000040" },
  queueEntry: { tokenNo: 6 },
});

function patientDetail(uhid: string, name: string, dob: string, sex: string): Record<string, unknown> {
  return { patient: { uhid, name, alias: null, dob, sex }, resolvedFrom: null };
}

// ——— a custom fetch mock for tests that need a REAL non-200: stubFetch always answers 200 ———

function mockRoutes(
  handlers: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const path = raw.split("?")[0]!;
      const key = `${init?.method ?? "GET"} ${path}`;
      const h = handlers[key];
      if (h === undefined) return new Response("{}", { status: 404 });
      const { status, body } = typeof h === "function" ? h() : h;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { url, path: url.split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodiesOf(method: string, path: string): Record<string, unknown>[] {
  return callsTo(method, path).map((c) => JSON.parse(c.body === "" ? "{}" : c.body) as Record<string, unknown>);
}

describe("OpdVitals", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setToken(null);
    localStorage.clear();
  });

  it("the worklist renders GET /opd/visits registered rows (token, patient, doctor, opened time — danger never here) as returned; a department filter re-queries; a visit.opened frame refetches", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    let visitsCalls = 0;
    stubFetch({
      "GET /auth/me": { actor: { type: "user", id: "u-1" } },
      "GET /opd/departments": { items: DEPARTMENTS },
      "GET /opd/doctors": { items: DOCTORS },
      "GET /opd/config": CONFIG,
      "GET /opd/queues/summary": {
        items: [{ doctor: DOCTORS[0], sessionId: "sess-1", status: "in", waitingCount: 0, waitingVitalsCount: 1, nowServing: null, scheduledToday: true, roomCode: "12" }],
      },
      "GET /opd/visits": () => {
        visitsCalls += 1;
        return { items: visitsCalls === 1 ? [ENC_ADULT, ENC_CHILD] : [ENC_ADULT] };
      },
    });
    renderWithProviders(<OpdVitals />);

    const rowAdult = await screen.findByTestId(`worklist-row-${ENC_ADULT.id as string}`);
    const rowChild = await screen.findByTestId(`worklist-row-${ENC_CHILD.id as string}`);
    expect(within(rowAdult).getByTestId(`token-${ENC_ADULT.id as string}`)).toHaveTextContent("5");
    expect(within(rowAdult).getByText("Ravi Kumar")).toBeInTheDocument();
    expect(within(rowAdult).getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(within(rowAdult).getByText("09:30")).toBeInTheDocument();
    // dangerFlagged is TRUE on both fixtures — this worklist never surfaces it (that lives on the queue screens).
    expect(within(rowAdult).queryByText(/danger/i)).toBeNull();
    expect(within(rowChild).queryByText(/danger/i)).toBeNull();

    // ordered as returned by the server, never re-sorted (token 5 before token 2 here).
    const rows = screen.getAllByTestId(/^worklist-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      `worklist-row-${ENC_ADULT.id as string}`, `worklist-row-${ENC_CHILD.id as string}`,
    ]);

    // a department filter re-queries: dep-1 only carries the adult encounter in this fixture.
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Department"), "dep-1");
    await waitFor(() => expect(screen.queryByTestId(`worklist-row-${ENC_CHILD.id as string}`)).toBeNull());
    expect(screen.getByTestId(`worklist-row-${ENC_ADULT.id as string}`)).toBeInTheDocument();
    const lastVisitsUrl = callsTo("GET", "/opd/visits").at(-1)!.url;
    expect(lastVisitsUrl).toContain("departmentId=dep-1");

    // a visit.opened frame on the department's doctors' queue topic is a HINT to re-read (D6).
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.simulateOpen();
    });
    await act(async () => {
      ws.simulateMessage({ type: "authed", userId: "u-1" });
    });
    const before = visitsCalls;
    await act(async () => {
      ws.simulateMessage({
        type: "event", topic: `queue:doc-1:${TODAY}`, name: "visit.opened", seq: 1, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY },
      });
    });
    await waitFor(() => expect(visitsCalls).toBeGreaterThan(before));
  });

  it("selecting a row loads the patient (age from dob; a 404 renders 'restricted record' and falls back to the adult band) and marks the required fields with * for that band", async () => {
    mockRoutes({
      "GET /opd/departments": { status: 200, body: { items: DEPARTMENTS } },
      "GET /opd/doctors": { status: 200, body: { items: DOCTORS } },
      "GET /opd/config": { status: 200, body: CONFIG },
      "GET /opd/visits": { status: 200, body: { items: [ENC_ADULT, ENC_CHILD, ENC_HIDDEN] } },
      "GET /patients/p-adult": { status: 200, body: patientDetail("HMS0000000020", "Ravi Kumar", "1990-01-01", "male") },
      "GET /patients/p-adult/allergies": { status: 200, body: { items: [] } },
      // 3 years old at NOW_ISO (2026-08-18): dob 2023-05-10, birthday already passed this year.
      "GET /patients/p-child": { status: 200, body: patientDetail("HMS0000000010", "Baby Naina", "2023-05-10", "female") },
      "GET /patients/p-child/allergies": { status: 200, body: { items: [] } },
      "GET /patients/p-hidden": { status: 404, body: { statusCode: 404, message: "unknown patient p-hidden", error: "Not Found" } },
      "GET /patients/p-hidden/allergies": { status: 404, body: { statusCode: 404, message: "unknown patient p-hidden", error: "Not Found" } },
    });
    renderWithProviders(<OpdVitals />);
    const user = userEvent.setup();

    // the 3-year-old: height, weight, temp, SpO2, pulse required — BP is NOT required (K47).
    await user.click(await screen.findByTestId(`worklist-row-${ENC_CHILD.id as string}`));
    expect(await screen.findByTestId("patient-panel-name")).toHaveTextContent("Baby Naina");
    expect(screen.getByTestId("band-label")).toHaveTextContent("Child (1-5)");
    expect(screen.getByLabelText("Height (cm) *")).toBeInTheDocument();
    expect(screen.getByLabelText("Weight (kg) *")).toBeInTheDocument();
    expect(screen.getByLabelText("Temp (°C) *")).toBeInTheDocument();
    expect(screen.getByLabelText("SpO2 (%) *")).toBeInTheDocument();
    expect(screen.getByLabelText("Pulse (/min) *")).toBeInTheDocument();
    expect(screen.getByLabelText("SBP (mmHg)")).toBeInTheDocument();
    expect(screen.queryByLabelText("SBP (mmHg) *")).toBeNull();
    expect(screen.getByLabelText("DBP (mmHg)")).toBeInTheDocument();
    expect(screen.queryByLabelText("DBP (mmHg) *")).toBeNull();

    // the adult: all seven.
    await user.click(screen.getByTestId(`worklist-row-${ENC_ADULT.id as string}`));
    expect(await screen.findByTestId("patient-panel-name")).toHaveTextContent("Ravi Kumar");
    expect(screen.getByTestId("band-label")).toHaveTextContent("Adult");
    for (const label of ["Height (cm)", "Weight (kg)", "SBP (mmHg)", "DBP (mmHg)", "Pulse (/min)", "Temp (°C)", "SpO2 (%)"]) {
      expect(screen.getByLabelText(`${label} *`)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText("RR (/min) *")).toBeNull();

    // 404 from GET /patients/:id is a DOMAIN ANSWER (hidden confidential record), not a crash —
    // renders "restricted record" and falls back to the adult band (same seven).
    await user.click(screen.getByTestId(`worklist-row-${ENC_HIDDEN.id as string}`));
    expect(await screen.findByTestId("restricted-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("patient-panel-name")).toBeNull();
    expect(screen.getByTestId("band-label")).toHaveTextContent("Adult");
    for (const label of ["Height (cm)", "Weight (kg)", "SBP (mmHg)", "DBP (mmHg)", "Pulse (/min)", "Temp (°C)", "SpO2 (%)"]) {
      expect(screen.getByLabelText(`${label} *`)).toBeInTheDocument();
    }
  });

  it("submitting posts NUMBERS (weightKg: 60, tempC: 37.2) and OMITS blank optional fields entirely — not '', not null (K46)", async () => {
    stubFetch({
      "GET /opd/departments": { items: DEPARTMENTS },
      "GET /opd/doctors": { items: DOCTORS },
      "GET /opd/config": CONFIG,
      "GET /opd/visits": { items: [ENC_ADULT] },
      "GET /patients/p-adult": patientDetail("HMS0000000020", "Ravi Kumar", "1990-01-01", "male"),
      "GET /patients/p-adult/allergies": { items: [] },
      [`POST /opd/visits/${ENC_ADULT.id as string}/vitals`]: {
        vitals: { id: "vit-1" }, flags: [], encounter: { ...ENC_ADULT, status: "waiting" },
      },
    });
    renderWithProviders(<OpdVitals />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`worklist-row-${ENC_ADULT.id as string}`));
    await screen.findByTestId("patient-panel-name");

    await user.type(screen.getByLabelText("Height (cm) *"), "170");
    await user.type(screen.getByLabelText("Weight (kg) *"), "60");
    await user.type(screen.getByLabelText("SBP (mmHg) *"), "120");
    await user.type(screen.getByLabelText("DBP (mmHg) *"), "80");
    await user.type(screen.getByLabelText("Pulse (/min) *"), "72");
    await user.type(screen.getByLabelText("SpO2 (%) *"), "98");
    await user.type(screen.getByLabelText("Temp (°C) *"), "37.2");
    // rr and notes deliberately left blank — rr is never required by any band, notes never required.

    await user.click(screen.getByRole("button", { name: "Save vitals" }));

    const path = `/opd/visits/${ENC_ADULT.id as string}/vitals`;
    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const body = bodiesOf("POST", path)[0]!;

    expect(typeof body.weightKg).toBe("number");
    expect(body.weightKg).toBe(60);
    expect(typeof body.tempC).toBe("number");
    expect(body.tempC).toBe(37.2);
    expect(typeof body.heightCm).toBe("number");
    expect(typeof body.sbp).toBe("number");
    expect(typeof body.dbp).toBe("number");
    expect(typeof body.pulse).toBe("number");
    expect(typeof body.spo2).toBe("number");
    expect("rr" in body).toBe(false);
    expect("notes" in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["dbp", "heightCm", "pulse", "sbp", "spo2", "tempC", "weightKg"].sort());
  });

  it("a 201 with flags renders a red role=alert banner naming the vital and the limit and the row leaves the worklist; a 400 vitals_incomplete renders the missing field list inline", async () => {
    let visitsCalls = 0;
    mockRoutes({
      "GET /opd/departments": { status: 200, body: { items: DEPARTMENTS } },
      "GET /opd/doctors": { status: 200, body: { items: DOCTORS } },
      "GET /opd/config": { status: 200, body: CONFIG },
      "GET /opd/visits": () => {
        visitsCalls += 1;
        return { status: 200, body: { items: visitsCalls === 1 ? [ENC_ADULT, ENC_ADULT2] : [ENC_ADULT2] } };
      },
      "GET /patients/p-adult": { status: 200, body: patientDetail("HMS0000000020", "Ravi Kumar", "1990-01-01", "male") },
      "GET /patients/p-adult/allergies": { status: 200, body: { items: [] } },
      "GET /patients/p-adult2": { status: 200, body: patientDetail("HMS0000000040", "Suresh Yadav", "1985-02-02", "male") },
      "GET /patients/p-adult2/allergies": { status: 200, body: { items: [] } },
      [`POST /opd/visits/${ENC_ADULT.id as string}/vitals`]: {
        status: 201,
        body: {
          vitals: { id: "vit-1" }, flags: [{ vital: "sbp", value: 190, bound: "max", limit: 180 }],
          encounter: { ...ENC_ADULT, status: "waiting" },
        },
      },
      [`POST /opd/visits/${ENC_ADULT2.id as string}/vitals`]: {
        status: 400,
        body: { statusCode: 400, message: "missing: weightKg", code: "vitals_incomplete", detail: { missing: ["weightKg"] } },
      },
    });
    renderWithProviders(<OpdVitals />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId(`worklist-row-${ENC_ADULT.id as string}`));
    await screen.findByTestId("patient-panel-name");
    await user.type(screen.getByLabelText("Height (cm) *"), "170");
    await user.type(screen.getByLabelText("Weight (kg) *"), "60");
    await user.type(screen.getByLabelText("SBP (mmHg) *"), "190");
    await user.type(screen.getByLabelText("DBP (mmHg) *"), "80");
    await user.type(screen.getByLabelText("Pulse (/min) *"), "72");
    await user.type(screen.getByLabelText("SpO2 (%) *"), "98");
    await user.type(screen.getByLabelText("Temp (°C) *"), "37.0");
    await user.click(screen.getByRole("button", { name: "Save vitals" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("SBP (mmHg)");
    expect(alert).toHaveTextContent("190");
    expect(alert).toHaveTextContent("180");

    // the row leaves the worklist: the encounter moved off "registered" server-side, and the
    // invalidated GET /opd/visits refetch no longer carries it.
    await waitFor(() => expect(screen.queryByTestId(`worklist-row-${ENC_ADULT.id as string}`)).toBeNull());

    // a stubbed 400 vitals_incomplete renders the missing field list inline.
    await user.click(screen.getByTestId(`worklist-row-${ENC_ADULT2.id as string}`));
    await screen.findByTestId("patient-panel-name");
    await user.click(screen.getByRole("button", { name: "Save vitals" }));

    await waitFor(() => expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("Weight (kg)"))).toBe(true));
  });

  it("Quick allergy posts { substance, severity?, source: 'vitals' } and the new allergy appears in the patient panel's list", async () => {
    let allergyCalls = 0;
    stubFetch({
      "GET /opd/departments": { items: DEPARTMENTS },
      "GET /opd/doctors": { items: DOCTORS },
      "GET /opd/config": CONFIG,
      "GET /opd/visits": { items: [ENC_ADULT] },
      "GET /patients/p-adult": patientDetail("HMS0000000020", "Ravi Kumar", "1990-01-01", "male"),
      "GET /patients/p-adult/allergies": () => {
        allergyCalls += 1;
        return { items: allergyCalls === 1 ? [] : [{ id: "al-1", substance: "Penicillin", severity: "moderate", status: "active" }] };
      },
      "POST /patients/p-adult/allergies": { allergyId: "al-1" },
    });
    renderWithProviders(<OpdVitals />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`worklist-row-${ENC_ADULT.id as string}`));
    await screen.findByTestId("patient-panel-name");
    expect(screen.getByTestId("allergy-list")).not.toHaveTextContent("Penicillin");

    await user.type(screen.getByLabelText("Substance"), "Penicillin");
    await user.selectOptions(screen.getByLabelText("Severity"), "moderate");
    await user.click(screen.getByRole("button", { name: "Add allergy" }));

    await waitFor(() => expect(callsTo("POST", "/patients/p-adult/allergies")).toHaveLength(1));
    expect(bodiesOf("POST", "/patients/p-adult/allergies")[0]).toEqual({
      substance: "Penicillin", severity: "moderate", source: "vitals",
    });
    await waitFor(() => expect(screen.getByTestId("allergy-list")).toHaveTextContent("Penicillin"));
  });
});
