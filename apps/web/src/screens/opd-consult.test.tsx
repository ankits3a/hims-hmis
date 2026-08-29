import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { todayIst } from "../lib/opd-api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdConsult } from "./opd-consult";

/**
 * PLAN 07d T6 — the screen gained ONE router component (`<Link to="/my-day">`), and a `<Link>`
 * needs a `RouterProvider` that `renderWithProviders` does not build. The house convention is to
 * mock `@tanstack/react-router` down to exactly what the screen uses — and the factory returns ONLY
 * what it lists, which is why this is the one entry and why adding a second router import to this
 * screen means adding it here too.
 *
 * A plain `<a href>` would have avoided the mock and was rejected: it is a full browser page load,
 * and reloading the whole bundle mid-consultation to look at a brief is a worse trade than one line
 * of test scaffolding (11g / DD1 records the same reasoning for the shell's own nav).
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

// 2026-08-18T04:00:00.000Z + 5:30 = 2026-08-18 09:30 IST (the T12/T13/T14 pin).
const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

/**
 * jsdom ships no WebSocket a test can drive (flag ⑮), so the transport is replaced by this fake and
 * restored in afterEach. Copied deliberately from the opd-desk / opd-vitals precedent — a test file
 * is self-contained and never imports another *.test.tsx.
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

const DOCTOR = {
  id: "doc-1", userId: "u-1", displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentId: "dep-1",
  specialty: "General", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};

const CONFIG = {
  slotMinutes: 10, followUpDefaultDays: 7, followUpExtensionDays: [15, 21, 30],
  extensionCapPerDoctorPerMonth: 2, maxSkipsBeforeLeft: 3, perkEveryNth: null, dangerRanges: {},
  letterhead: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"] },
};

const SESSION = {
  id: "sess-1", doctorId: "doc-1", serviceDate: TODAY, roomId: "room-1", status: "in",
  nextToken: 8, callsMade: 1, openedAt: NOW_ISO, closedAt: null, createdAt: NOW_ISO,
};

function summary(id: string, uhid: string, name: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestedId: id, id, uhid, name, alias: null, restricted: false, administrativeGender: "female", dob: "1992-03-04", ...over };
}

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "qe-1", seq: 1, sessionId: "sess-1", encounterId: "enc-1", tokenNo: 5, kind: "walk_in",
    appointmentAt: null, status: "waiting", danger: false, reEntry: false, perk: false,
    eligibleAt: null, calledAt: null, callCount: 0, skips: 0, doneAt: null, createdAt: NOW_ISO,
    position: 1, queueClass: 3,
    encounter: { id: "enc-1", patientId: "p-1", visitType: "new", dangerFlagged: true, status: "waiting" },
    patient: summary("p-1", "HMS0000000020", "Asha Devi"),
    ...over,
  };
}

const CURRENT = entry({
  id: "qe-cur", tokenNo: 5, status: "called", position: null, queueClass: null, calledAt: NOW_ISO, callCount: 1,
});
const WAIT_A = entry({
  id: "qe-a", seq: 2, encounterId: "enc-2", tokenNo: 6, position: 1, queueClass: 3,
  encounter: { id: "enc-2", patientId: "p-2", visitType: "new", dangerFlagged: false, status: "waiting" },
  patient: summary("p-2", "HMS0000000030", "Ram Prasad"),
});
const WAIT_B = entry({
  id: "qe-b", seq: 3, encounterId: "enc-3", tokenNo: 7, position: 2, queueClass: 1, danger: true, reEntry: true,
  encounter: { id: "enc-3", patientId: "p-3", visitType: "revisit", dangerFlagged: true, status: "waiting" },
  patient: summary("p-3", "HMS0000000040", "Sita Devi"),
});

const QUEUE_VIEW = {
  session: SESSION, doctor: DOCTOR, ordered: [WAIT_A, WAIT_B], current: CURRENT, inConsult: [],
  waitingVitals: 0, counts: { waiting: 2, called: 1, inConsult: 0, done: 0, left: 0 },
};

/** The same queue, but the called patient is a confidential record the OPD module only aliases. */
const CURRENT_HIDDEN = entry({
  ...CURRENT,
  patient: summary("p-1", "HMS0000000020", null, { restricted: true, alias: "Patient C" }),
});
const QUEUE_VIEW_HIDDEN = { ...QUEUE_VIEW, current: CURRENT_HIDDEN };

const ENCOUNTER = {
  id: "enc-1", patientId: "p-1", type: "opd_visit", status: "in_consultation", workflowInstanceId: "wf-1",
  departmentId: "dep-1", doctorId: "doc-1", appointmentId: null, serviceDate: TODAY, visitType: "new",
  intendedPayer: "self", referralSource: null, referrerName: null,
  chiefComplaint: null, diagnosis: null, icd10Code: null, advice: null,
  admissionAdvised: false, referralTo: null, referralNote: null,
  followUpDays: null, followUpExtended: false, dangerFlagged: true,
  consultStartedAt: NOW_ISO, consultCompletedAt: null, abandonedAt: null, abandonReason: null,
  openedBy: "u-1", openedAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};

function vitals(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "vit-1", encounterId: "enc-1", patientId: "p-1",
    heightCm: 162, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, rr: 16, spo2: 98, tempC: 37,
    notes: null, ageYearsAtRecord: 34, band: "adult", dangerFlags: [],
    recordedBy: "u-2", recordedAt: "2026-08-18T04:20:00.000Z",
    ...over,
  };
}
const VITALS_FIRST = vitals({});
const VITALS_LATEST = vitals({
  id: "vit-2", sbp: 190, recordedAt: "2026-08-18T04:40:00.000Z",
  dangerFlags: [{ vital: "sbp", value: 190, bound: "max", limit: 180 }],
});

const VISIT = {
  encounter: ENCOUNTER, queueEntries: [CURRENT], vitals: [VITALS_FIRST, VITALS_LATEST], prescriptions: [],
  patient: summary("p-1", "HMS0000000020", "Asha Devi"),
};

const PATIENT_DETAIL = {
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, dob: "1992-03-04", administrativeGender: "female" },
  resolvedFrom: null,
};
const ALLERGIES = [
  { id: "al-1", substance: "Penicillin", severity: "severe", status: "active" },
  { id: "al-2", substance: "Sulfa", severity: "mild", status: "entered_in_error" },
];
const TIMELINE = [
  {
    encounterId: "enc-0", serviceDate: "2026-07-10", openedAt: "2026-07-10T04:00:00.000Z", status: "completed",
    visitType: "new", doctorId: "doc-1", doctorName: "Dr Meera Rao", departmentId: "dep-1",
    departmentName: "General medicine", diagnosis: "Acute gastritis", icd10Code: "K29.7",
    prescriptionLineCount: 2, dangerFlagged: false,
  },
];

const PRINT_DATA = {
  letterhead: CONFIG.letterhead,
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, restricted: false, ageYears: 34, administrativeGender: "female" },
  doctor: { displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentName: "General medicine" },
  encounter: {
    id: "enc-1", serviceDate: TODAY, diagnosis: "Acute pharyngitis", icd10Code: "J02.9",
    advice: "warm fluids", followUpDays: 7, chiefComplaint: "fever 3d",
    // PLAN 07d T5 — the wire shape gained `advisedTests`. The renderer tolerates its absence
    // (a tab open across a deploy), but a fixture should be the shape the server actually sends.
    advisedTests: [],
  },
  vitals: VITALS_LATEST,
  lines: [{
    drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "TDS",
    durationDays: 5, instructions: "after food", noSubstitution: false,
  }],
  qrPayload: "rx1.RX0000000000000000000001.EN0000000000000000000001.1.c2lnbmF0dXJlLWJ5dGVz",
  version: 1,
  issuedAt: "2026-08-18T05:12:00.000Z",
};

const ALLERGY_CONFLICT = {
  statusCode: 409,
  message: "prescription conflicts with a recorded allergy",
  code: "allergy_conflict",
  detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] },
};

// ——— a custom fetch mock for the tests that need a REAL non-200: stubFetch always answers 200 ———

type Handler = { status: number; body: unknown } | (() => { status: number; body: unknown });

function mockRoutes(handlers: Record<string, Handler>): void {
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

/** Every read the screen makes on the happy path, so each test only declares what it is about. */
function baseRoutes(): Record<string, Handler> {
  return {
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
    "GET /api/opd/me/doctor": { status: 200, body: DOCTOR },
    "GET /api/opd/config": { status: 200, body: CONFIG },
    "GET /api/opd/queues": { status: 200, body: QUEUE_VIEW },
    "GET /api/opd/visits/enc-1": { status: 200, body: VISIT },
    "GET /api/patients/p-1": { status: 200, body: PATIENT_DETAIL },
    "GET /api/patients/p-1/allergies": { status: 200, body: { items: ALLERGIES } },
    "GET /api/opd/patients/p-1/timeline": { status: 200, body: { items: TIMELINE } },
    // Nest's DEFAULT 201 — the erratum-E5 status the real controller returns (stubFetch cannot make one).
    "POST /api/opd/visits/enc-1/consult/start": { status: 201, body: { encounter: ENCOUNTER, queueEntry: CURRENT } },
  };
}

function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return {
      url, path: url.split("?")[0]!, method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodiesOf(method: string, path: string): Record<string, unknown>[] {
  return callsTo(method, path).map((c) => JSON.parse(c.body === "" ? "{}" : c.body) as Record<string, unknown>);
}

/** Boot the screen and start the called patient's consultation — the entry state of tests 3-6. */
async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderWithProviders(<OpdConsult />);
  await screen.findByTestId("queue-row-qe-cur");
  await user.click(screen.getByRole("button", { name: "Start consultation" }));
  await screen.findByTestId("patient-panel");
}

describe("OpdConsult", () => {
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

  it("boots on GET /opd/me/doctor — a 404 is the domain answer 'not a doctor' and NO queue read follows; with a profile it renders the queue (position, token, class, danger, re-entry) with the called token highlighted plus the session control, and a queue.called frame refetches", async () => {
    // The clock is pinned so `todayIst()` — which both the screen and this test call — is TODAY.
    expect(todayIst()).toBe(TODAY);

    // (a) erratum E3: 404 from /opd/me/doctor is a DOMAIN answer, not a transport failure.
    mockRoutes({
      "GET /api/opd/me/doctor": {
        status: 404,
        body: { statusCode: 404, message: "no OPD doctor profile for this user", code: "not_a_doctor" },
      },
      "GET /api/opd/config": { status: 200, body: CONFIG },
    });
    renderWithProviders(<OpdConsult />);
    expect(await screen.findByTestId("not-a-doctor")).toBeInTheDocument();
    // the mechanism: the queue read is GATED on having a doctor profile — not merely hidden from view.
    expect(callsTo("GET", "/api/opd/queues")).toHaveLength(0);
    expect(screen.queryByTestId("consult-queue")?.textContent ?? "").toBe("");
    cleanup();
    vi.unstubAllGlobals();

    // (b) with a doctor profile: the queue, keyed on my own doctor id and today.
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    let queueCalls = 0;
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-1" } },
      "GET /api/opd/me/doctor": DOCTOR,
      "GET /api/opd/config": CONFIG,
      "GET /api/opd/queues": () => {
        queueCalls += 1;
        return QUEUE_VIEW;
      },
    });
    renderWithProviders(<OpdConsult />);

    const currentRow = await screen.findByTestId("queue-row-qe-cur");
    const url = callsTo("GET", "/api/opd/queues").at(-1)!.url;
    expect(url).toContain("doctorId=doc-1");
    expect(url).toContain(`serviceDate=${TODAY}`);

    // the called token is highlighted; the two waiting rows are not
    expect(currentRow).toHaveAttribute("aria-current", "true");
    expect(within(currentRow).getByTestId("queue-token-qe-cur")).toHaveTextContent("5");
    const rowA = screen.getByTestId("queue-row-qe-a");
    const rowB = screen.getByTestId("queue-row-qe-b");
    expect(rowA).not.toHaveAttribute("aria-current");
    expect(rowB).not.toHaveAttribute("aria-current");

    // position, token, class badge, danger flag and the re-entry marker, per row
    expect(within(rowA).getByTestId("queue-position-qe-a")).toHaveTextContent("#1");
    expect(within(rowA).getByTestId("queue-token-qe-a")).toHaveTextContent("6");
    expect(within(rowA).getByText("Walk-in")).toBeInTheDocument();
    expect(within(rowA).queryByTestId("queue-danger-qe-a")).toBeNull();
    expect(within(rowA).queryByTestId("queue-reentry-qe-a")).toBeNull();
    expect(within(rowB).getByTestId("queue-position-qe-b")).toHaveTextContent("#2");
    expect(within(rowB).getByText("Returned with results")).toBeInTheDocument();
    expect(within(rowB).getByTestId("queue-danger-qe-b")).toBeInTheDocument();
    expect(within(rowB).getByTestId("queue-reentry-qe-b")).toBeInTheDocument();

    // the session status control reflects the session the server returned
    expect(screen.getByLabelText("Session")).toHaveValue("in");

    // D6: a queue.called frame on MY topic is a hint to re-read. Real timers here, so the 15 s poll
    // cannot fire inside this test — the frame is the only mechanism that can move this counter.
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.simulateOpen();
    });
    await act(async () => {
      ws.simulateMessage({ type: "authed", userId: "u-1" });
    });
    const before = queueCalls;
    await act(async () => {
      ws.simulateMessage({
        type: "event", topic: `queue:doc-1:${TODAY}`, name: "queue.called", seq: 9, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY, tokenNo: 5 },
      });
    });
    await waitFor(() => expect(queueCalls).toBeGreaterThan(before));
  });

  it("Call next, Skip and Start post to their own routes with no body, Start opens the patient panel — and a stubbed 409 call_conflict renders inline", async () => {
    let callNextCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/queues/sess-1/call-next": () => {
        callNextCalls += 1;
        return callNextCalls === 1
          ? { status: 201, body: { entry: CURRENT, encounter: ENCOUNTER } }
          : {
            status: 409,
            body: { statusCode: 409, message: "another patient is already called", code: "call_conflict" },
          };
      },
      "POST /api/opd/queues/entries/qe-cur/skip": { status: 201, body: { entry: { ...CURRENT, status: "waiting" } } },
    });
    renderWithProviders(<OpdConsult />);
    const user = userEvent.setup();
    await screen.findByTestId("queue-row-qe-cur");

    await user.click(screen.getByRole("button", { name: "Call next" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")[0]!.body).toBe("");

    await user.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")[0]!.body).toBe("");

    await user.click(screen.getByRole("button", { name: "Start consultation" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")[0]!.body).toBe("");
    expect(await screen.findByTestId("patient-panel")).toBeInTheDocument();

    // the screen's OWN Alt+N (a local useEffect handler — lib/keyboard.tsx is not touched) calls next
    // again, and this time the server refuses: a 409 call_conflict is rendered where the doctor reads it.
    await user.keyboard("{Alt>}n{/Alt}");
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(2));
    const refusal = await screen.findByText("another patient is already called");
    expect(refusal).toHaveAttribute("role", "alert");
  });

  it("the patient panel loads the patient, the ACTIVE allergies as red chips, the OPD timeline and the LATEST vitals with its danger flag — and a 404 from GET /patients/:id renders restricted mode with the UHID only", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    expect(await screen.findByTestId("panel-patient-name")).toHaveTextContent("Asha Devi");
    expect(screen.getByTestId("panel-uhid")).toHaveTextContent("HMS0000000020");
    expect(screen.getByTestId("panel-patient-age")).toHaveTextContent("34 years · female");
    expect(screen.getByTestId("panel-visit-type")).toHaveTextContent("New");

    // active allergies only, and rendered as red chips
    const chip = await screen.findByTestId("allergy-chip-al-1");
    expect(chip).toHaveTextContent("Penicillin");
    expect(chip).toHaveClass("text-red-800");
    expect(screen.queryByTestId("allergy-chip-al-2")).toBeNull();
    expect(screen.getByTestId("allergy-chips")).not.toHaveTextContent("Sulfa");

    // the LATEST vitals row wins (the fixture's first row carries sbp 120, the latest 190) and its
    // danger flag is highlighted — a screen reading vitals[0] would show 120 and no flag.
    await waitFor(() => expect(screen.getByTestId("panel-vitals")).toHaveTextContent("BP 190/80"));
    expect(screen.getByTestId("panel-vitals")).not.toHaveTextContent("BP 120/80");
    expect(screen.getByTestId("vitals-danger-sbp")).toHaveTextContent("190");

    // the OPD timeline: date, department, doctor, diagnosis
    await user.click(screen.getByRole("tab", { name: "History" }));
    const row = await screen.findByTestId("timeline-row-enc-0");
    expect(row).toHaveTextContent("2026-07-10");
    expect(row).toHaveTextContent("General medicine");
    expect(row).toHaveTextContent("Dr Meera Rao");
    expect(row).toHaveTextContent("Acute gastritis");

    cleanup();
    vi.unstubAllGlobals();

    // §14 / D-37: a hidden confidential record answers 404 — restricted mode, UHID only, no crash.
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/queues": { status: 200, body: QUEUE_VIEW_HIDDEN },
      "GET /api/patients/p-1": {
        status: 404, body: { statusCode: 404, message: "unknown patient p-1", error: "Not Found" },
      },
      "GET /api/patients/p-1/allergies": {
        status: 404, body: { statusCode: 404, message: "unknown patient p-1", error: "Not Found" },
      },
    });
    const user2 = userEvent.setup();
    await openPanel(user2);

    expect(await screen.findByTestId("restricted-banner")).toBeInTheDocument();
    expect(screen.getByTestId("panel-uhid")).toHaveTextContent("HMS0000000020");
    expect(screen.queryByTestId("panel-patient-name")).toBeNull();
    expect(screen.queryByText("Asha Devi")).toBeNull();
    expect(screen.queryByTestId("allergy-chips")).toBeNull();
  });

  it("the note autosaves with PUT /opd/visits/:id/consult/note on BLUR — never on keystroke — and a blur that changed nothing sends nothing", async () => {
    mockRoutes({ ...baseRoutes(), "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } } });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/consult/note";

    const diagnosis = await screen.findByLabelText("Diagnosis");
    await user.click(diagnosis);
    await user.type(diagnosis, "Acute pharyngitis");
    // typing is NOT the trigger — a screen saving on change would already have posted here
    expect(callsTo("PUT", path)).toHaveLength(0);

    const icd10 = screen.getByLabelText("ICD-10 code");
    await user.click(icd10);
    await waitFor(() => expect(callsTo("PUT", path)).toHaveLength(1));
    await user.type(icd10, "J02.9");
    const chief = screen.getByLabelText("Chief complaint");
    await user.click(chief);
    await user.type(chief, "fever 3d");
    const advice = screen.getByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, "warm fluids");
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => expect(bodiesOf("PUT", path).at(-1)).toEqual({
      chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis", icd10Code: "J02.9", advice: "warm fluids",
    }));
    expect(await screen.findByTestId("note-saved")).toBeInTheDocument();

    // an unchanged blur is not a save: focus in and straight back out again writes nothing
    const saves = callsTo("PUT", path).length;
    await user.click(screen.getByLabelText("Advice"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("PUT", path)).toHaveLength(saves);
  });

  it("K48: Issue & print posts the lines with durationDays as a NUMBER; a 409 allergy_conflict opens the override dialog, an empty reason sends nothing, and the confirmed re-post carries `overrides` with a reason per match — then the e-Rx prints", async () => {
    let rxCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/visits/enc-1/prescriptions": () => {
        rxCalls += 1;
        return rxCalls === 1
          ? { status: 409, body: ALLERGY_CONFLICT }
          : {
            status: 201,
            body: { prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload, allergyOverrideCount: 1 },
          };
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/prescriptions";

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Tab Penicillin V");
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.selectOptions(screen.getByLabelText("Frequency"), "TDS");
    await user.selectOptions(screen.getByLabelText("Route"), "oral");
    await user.type(screen.getByLabelText("Days"), "5");
    await user.type(screen.getByLabelText("Instructions"), "after food");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const first = bodiesOf("POST", path)[0]!;
    expect(first).toEqual({
      lines: [{
        drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "TDS",
        durationDays: 5, instructions: "after food", noSubstitution: false,
        // PLAN 16a T6 / DD9 — a typed line carries `medicineId: null`, and the assertion is
        // `toEqual` so a field appearing in the body without a decision fails here. It did.
        medicineId: null,
      }],
    });
    // §3.19: the form hands back "5"; the BODY must carry the number
    expect(typeof (first.lines as { durationDays: unknown }[])[0]!.durationDays).toBe("number");
    expect("overrides" in first).toBe(false);

    // the hard-warning dialog: one reason field per matched line, naming the substance
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Line 1: Penicillin")).toBeInTheDocument();

    // the reason is the rule: confirming with it blank sends NOTHING (the button is deliberately live)
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", path)).toHaveLength(1);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("A reason is required for every conflict");

    await user.type(within(dialog).getByLabelText("Line 1: Penicillin"), "tolerated previously, benefit outweighs");
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));

    // K48 — the re-post carries the overrides array, a reason per match, and the SAME lines
    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(2));
    const second = bodiesOf("POST", path)[1]!;
    expect(second.overrides).toEqual([
      { lineIndex: 0, substance: "Penicillin", reason: "tolerated previously, benefit outweighs" },
    ]);
    expect(second.lines).toEqual(first.lines);

    // the e-Rx is fetched and printed — and exactly ONE .print-doc is mounted anywhere in the document
    await waitFor(() => expect(callsTo("GET", "/api/opd/prescriptions/rx-1/print")).toHaveLength(1));
    await waitFor(() => expect(document.querySelectorAll(".print-doc")).toHaveLength(1));
    expect(document.querySelector(".print-doc")).toHaveTextContent("CRK MEDICAL COLLEGE & HOSPITAL");
    expect(screen.getByRole("button", { name: "Print prescription" })).toBeInTheDocument();
  });

  /**
   * PLAN 16a T6 — the formulary picker and the two new hard warnings.
   *
   * The four acceptance points, in order: picking sets `medicineId`; a severe interaction needs a
   * reason before the submit proceeds; a soft notice never blocks; and the "not in formulary" hint
   * is COVERAGE-GATED, absent even for an unresolved line while coverage is low.
   */
  const FORMULARY = {
    items: [
      { id: "m-warf", brandName: "Warf 5", routeClass: "systemic", salts: [{ saltId: "s-warf", strength: "5 mg" }] },
      { id: "m-asa", brandName: "Ecosprin 75", routeClass: "systemic", salts: [{ saltId: "s-asa", strength: "75 mg" }] },
    ],
  };
  const SEVERE_HIT = {
    severity: "severe", lineIndex: 0, note: "bleeding risk — avoid or monitor INR closely",
    // C5 — the client echoes this on the override so the server knows which hit was cleared.
    saltPair: ["s-asa", "s-warf"],
    against: { scope: "prior", prescriptionId: "rx-old", issuedAt: "2026-08-08T04:00:00.000Z", assumedCurrent: false },
  };

  it("16a: the picker sets medicineId, and a severe interaction needs a reason before it will issue", async () => {
    let rxCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines": { status: 200, body: FORMULARY },
      "GET /api/formulary/coverage": { status: 200, body: { coverage: 0.92, noticeEnabled: true } },
      "POST /api/opd/visits/enc-1/rx-precheck": {
        status: 201,
        body: { allergyMatches: [], interactions: [SEVERE_HIT], duplicates: [], notices: [], unresolvedLineIndexes: [] },
      },
      "POST /api/opd/visits/enc-1/prescriptions": () => {
        rxCalls += 1;
        return {
          status: 201,
          body: {
            prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload,
            allergyOverrideCount: 0, interactionOverrideCount: 1, duplicateOverrideCount: 0, notices: [],
          },
        };
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/prescriptions";

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await screen.findByLabelText("Drug");

    // Picking from the formulary fills the NAME and carries the id (DD9).
    await user.selectOptions(await screen.findByTestId("rx-formulary-0"), "m-warf");
    expect(screen.getByLabelText("Drug")).toHaveValue("Warf 5");
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    // The pre-check opened the dialog, and NOTHING was posted to the issue route.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/bleeding risk/)).toBeInTheDocument();
    // The prior-scope label, which is the honest half: it names when, not just what.
    expect(within(dialog).getByText(/prescribed \d+ days ago/)).toBeInTheDocument();
    expect(callsTo("POST", path)).toHaveLength(0);

    // A blank reason sends nothing — the same rule the allergy dialog has always had.
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", path)).toHaveLength(0);
    expect(within(dialog).getByText("A reason is required for every conflict")).toBeInTheDocument();

    await user.type(within(dialog).getByTestId("interaction-reason-0"), "cardiology advised dual therapy");
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const body = bodiesOf("POST", path)[0]! as {
      lines: { medicineId: string | null }[];
      interactionOverrides: { lineIndex: number; reason: string }[];
    };
    expect(body.lines[0]!.medicineId).toBe("m-warf");
    expect(body.interactionOverrides).toEqual([{
      lineIndex: 0, reason: "cardiology advised dual therapy", saltPair: ["s-asa", "s-warf"],
    }]);
    expect("duplicateOverrides" in body).toBe(false);
    expect(rxCalls).toBe(1);
  });

  /**
   * C7 (independent review) — 16a's STATE MUST NOT OUTLIVE THE PATIENT IT BELONGS TO.
   *
   * `resetPanel` cleared the shipped allergy state and none of the seven fields T6 added. The
   * dangerous one is the dialog: its `open` reads `matches !== null || interactionHits.length > 0
   * || duplicateHits.length > 0`, and nulling `matches` alone left it OPEN across a patient change
   * — where confirming would post patient A's overrides against patient B's lines.
   */
  it("16a: starting the next patient clears every trace of the last one's checks", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines": { status: 200, body: FORMULARY },
      "GET /api/formulary/coverage": { status: 200, body: { coverage: 0.92, noticeEnabled: true } },
      "POST /api/opd/visits/enc-1/rx-precheck": {
        status: 201,
        body: {
          allergyMatches: [], interactions: [SEVERE_HIT], duplicates: [], notices: [],
          unresolvedLineIndexes: [0],
        },
      },
      "POST /api/opd/visits/enc-1/consult/complete": { status: 201, body: { ok: true } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.selectOptions(await screen.findByTestId("rx-formulary-0"), "m-warf");
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    // Patient A's override dialog is open, holding A's hit.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/bleeding risk/)).toBeInTheDocument();

    /**
     * The doctor moves on with the keyboard — Alt+Enter completes the consultation, and the
     * handler is WINDOW-LEVEL, so it fires while the modal is open. That is not a contrivance to
     * reach a blocked button: it is the reviewer's actual scenario, and it is why a stale dialog
     * was dangerous rather than merely untidy. `complete()` calls `resetPanel()`, which is the
     * function that used to clear the allergy state and none of 16a's.
     */
    await user.keyboard("{Alt>}{Enter}{/Alt}");

    /**
     * THE DIALOG IS GONE — not merely emptied of allergy matches. Before the fix `resetPanel` nulled
     * `matches` and left `interactionHits` populated, so the dialog stayed open with patient A's hit
     * in it while the panel moved on; confirming there would have posted A's overrides against B's
     * lines. The panel itself closes on completion, which is why nothing below reaches for the rx
     * tab: there is no active patient until the next one is started, and that is the point.
     */
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByTestId("rx-notices")).toBeNull();
    expect(screen.queryByTestId("rx-uncovered-0")).toBeNull();
    expect(screen.queryByTestId("patient-panel")).toBeNull();
  });

  it("16a: a soft notice never blocks, and the uncovered-line hint stays silent until coverage says otherwise", async () => {
    const SOFT = {
      moiety: "paracetamol", lineIndex: 0, hard: false,
      against: { scope: "prior", prescriptionId: "rx-old", issuedAt: "2026-08-08T04:00:00.000Z", assumedCurrent: true },
    };
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines": { status: 200, body: FORMULARY },
      // T8 is not deployed in this scenario: a 404 means the hint stays OFF, which is also the
      // correct long-term degrade (DD5).
      "GET /api/formulary/coverage": { status: 404, body: { message: "not found" } },
      "POST /api/opd/visits/enc-1/rx-precheck": {
        status: 201,
        body: {
          allergyMatches: [], interactions: [], duplicates: [SOFT], notices: [SOFT],
          unresolvedLineIndexes: [0],
        },
      },
      "POST /api/opd/visits/enc-1/prescriptions": {
        status: 201,
        body: {
          prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload,
          allergyOverrideCount: 0, interactionOverrideCount: 0, duplicateOverrideCount: 0, notices: [SOFT],
        },
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/prescriptions";

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Some Ayurvedic Tonic");
    await user.type(screen.getByLabelText("Dose"), "10 ml");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    // A soft hit posts straight through: no dialog, no gate.
    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Allergy conflict" })).toBeNull();

    const panel = await screen.findByTestId("rx-notices");
    expect(within(panel).getByTestId("rx-notice-0")).toHaveTextContent("already contains paracetamol");
    // The assumed-currency label, and the in-system-only honesty line (design law 10).
    expect(within(panel).getByText(/may no longer be current/)).toBeInTheDocument();
    expect(within(panel).getByText("Checked against in-system prescriptions only")).toBeInTheDocument();

    // THE COVERAGE GATE. The line is unresolved and the server said so — and the hint is still
    // absent, because coverage is unknown. Below the threshold it would fire on nearly every line.
    expect(screen.queryByTestId("rx-uncovered-0")).toBeNull();

    // The e-Rx print dialog is open on top after a successful issue — the notices are BEHIND it,
    // which is the real order of events: the doctor prints, closes, and then reads what was noted.
    // Dismissing while a modal is open is not a state a user can reach, so the test does not fake one.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(await screen.findByTestId("rx-notices")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("rx-notices")).toBeNull();
  });

  it("K49: completing with the DEFAULT follow-up OMITS followUpDays from the posted key set; an extension travels as a number, a stubbed 409 extension_cap_reached renders inline and keeps the form, and a real 201 closes the panel and refetches the queue", async () => {
    let completeCalls = 0;
    let queueCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/queues": () => {
        queueCalls += 1;
        return { status: 200, body: QUEUE_VIEW };
      },
      "POST /api/opd/visits/enc-1/consult/complete": () => {
        completeCalls += 1;
        return completeCalls === 1
          ? {
            status: 409,
            body: {
              statusCode: 409, message: "follow-up extension cap reached for this month",
              code: "extension_cap_reached",
            },
          }
          // Nest's DEFAULT 201 (erratum E5) — the screen must treat any 2xx as success, never an exact 200.
          : { status: 201, body: { encounter: { ...ENCOUNTER, status: "completed" } } };
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/consult/complete";

    // (a) an extension plus the outcome controls — refused by the server, and the form survives it
    await user.selectOptions(screen.getByLabelText("Follow-up"), "15");
    await user.click(screen.getByLabelText("Tests ordered — patient returns today"));
    await user.click(screen.getByLabelText("Admission advised"));
    await user.type(screen.getByLabelText("Referred to"), "AIIMS Patna");
    await user.type(screen.getByLabelText("Referral note"), "cardiac eval");
    await user.click(screen.getByRole("button", { name: "Complete consultation" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const refused = bodiesOf("POST", path)[0]!;
    expect(refused).toEqual({
      note: {
        chiefComplaint: null, diagnosis: null, icd10Code: null, advice: null,
        admissionAdvised: true, referralTo: "AIIMS Patna", referralNote: "cardiac eval",
      },
      testsOrderedReturnToday: true,
      followUpDays: 15,
    });
    expect(typeof refused.followUpDays).toBe("number");

    const refusal = await screen.findByText("follow-up extension cap reached for this month");
    expect(refusal).toHaveAttribute("role", "alert");
    // the form state is preserved: nothing was cleared by the refusal
    expect(screen.getByTestId("patient-panel")).toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up")).toHaveValue("15");
    expect(screen.getByLabelText("Referred to")).toHaveValue("AIIMS Patna");
    expect(screen.getByLabelText("Admission advised")).toBeChecked();

    // (b) back to the DEFAULT window — K49: the key is ABSENT, so the server's own default applies
    await user.selectOptions(screen.getByLabelText("Follow-up"), "");
    const queueBefore = queueCalls;
    await user.click(screen.getByRole("button", { name: "Complete consultation" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(2));
    const completed = bodiesOf("POST", path)[1]!;
    expect("followUpDays" in completed).toBe(false);
    expect(Object.keys(completed).sort()).toEqual(["note", "testsOrderedReturnToday"]);

    // the real 201 is a success: the panel closes and the queue is re-read
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
    await waitFor(() => expect(queueCalls).toBeGreaterThan(queueBefore));
  });

  /**
   * ——— K44 / Plan 08 T15: the three unasserted shortcuts, absorbed from Plan 07 ———
   *
   * Plan 07 shipped this screen with FOUR local Alt handlers and asserted ONE of them (Alt+N,
   * above). Its gate mutant `gateX4` — a copy of the screen with the other three handlers stripped
   * — SURVIVED the whole suite, which is the definition of an untested lane: the doctor's fastest
   * three keys were held up by nothing. Plan 08 absorbs them as required-DIED (W-8), and each test
   * asserts THE POSTED CALL rather than a rendered state, because a rendered state can be reached
   * by the mouse and would not tell the two apart.
   */
  it("K44: Alt+K skips the called patient — the POSTED skip, and nothing else on the queue moves", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/queues/entries/qe-cur/skip": { status: 201, body: { entry: { ...CURRENT, status: "waiting" } } },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    await user.keyboard("{Alt>}k{/Alt}");

    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")[0]!.body).toBe("");
    // one key, one lane: Alt+K is not a general "do the next thing"
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(0);
  });

  it("K44: Alt+S with no consultation in progress posts consult/start and opens the panel", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    await user.keyboard("{Alt>}s{/Alt}");

    await waitFor(() => expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")[0]!.body).toBe("");
    expect(await screen.findByTestId("patient-panel")).toBeInTheDocument();
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);
  });

  it("K44: Alt+Enter completes the open consultation — the same body the button posts, with the default follow-up window OMITTED", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/visits/enc-1/consult/complete": {
        status: 201, body: { encounter: { ...ENCOUNTER, status: "completed" } },
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/consult/complete";

    await user.keyboard("{Alt>}{Enter}{/Alt}");

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    // K49's rule holds through the keyboard too: the key is ABSENT, so the OPD config's own
    // `followUpDefaultDays` applies rather than a number this screen invented.
    const body = bodiesOf("POST", path)[0]!;
    expect(Object.keys(body).sort()).toEqual(["note", "testsOrderedReturnToday"]);
    expect(body.testsOrderedReturnToday).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
  });

  it("NOT OVER-BROAD (§3.44): a key this screen does not bind fires nothing, the same letters typed WITHOUT Alt into the note fire nothing, and Alt+S inside the prescription FORM is that form's own submit alone — never a second one from this screen", async () => {
    mockRoutes({
      ...baseRoutes(),
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      "POST /api/opd/queues/entries/qe-cur/skip": { status: 201, body: { entry: CURRENT } },
      "POST /api/opd/visits/enc-1/consult/complete": { status: 201, body: { encounter: ENCOUNTER } },
      "POST /api/opd/visits/enc-1/prescriptions": {
        status: 201,
        body: { prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload, allergyOverrideCount: 0 },
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    // (a) Alt on a letter the screen does not bind reaches none of the four lanes
    await user.keyboard("{Alt>}x{/Alt}");
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(0);

    // (b) the SAME letters, without Alt, typed where a doctor actually types them: `k`, `s` and
    // Enter inside the note are text, not commands (`if (!e.altKey) return`).
    await user.click(screen.getByRole("button", { name: "Start consultation" }));
    await screen.findByTestId("patient-panel");
    await user.type(screen.getByLabelText("Chief complaint"), "ks");
    await user.keyboard("{Enter}");
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/complete")).toHaveLength(0);
    // Enter landed in the note as a NEWLINE — the keystroke was text, exactly as it should be.
    expect(screen.getByLabelText("Chief complaint")).toHaveValue("ks\n");

    // (c) inside the FormKit prescription form Alt+S is ALREADY that form's submit, so the screen's
    // own handler stands down (`e.target.closest("form")`). Exactly ONE prescription is posted —
    // a handler without that guard would issue the e-Rx twice from one keystroke.
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Tab Paracetamol");
    await user.type(screen.getByLabelText("Dose"), "500 mg");
    await user.selectOptions(screen.getByLabelText("Route"), "oral");
    await user.selectOptions(screen.getByLabelText("Frequency"), "TDS");
    await user.type(screen.getByLabelText("Days"), "3");
    await user.keyboard("{Alt>}s{/Alt}");

    await waitFor(() => expect(document.querySelectorAll(".print-doc")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions")).toHaveLength(1);
  });
});

/**
 * PLAN 07d T1/T2/T6 — **THE PAST RECORD, WHICH THE DOCTOR HAS NEVER BEEN ABLE TO READ.**
 *
 * Before this task the history tab was one line per past visit and there was NO way to read a prior
 * prescription at all — the only cross-encounter prescription query in the tree was private to the
 * interaction checker. These assertions are about the three things that makes true: that the two
 * new views exist and render the server's rows, that they are fetched ONLY when opened (each is a
 * PHI read that writes an access-log row, and a read nobody looked at should not be recorded as
 * one), and that an empty one says so rather than spinning.
 */
const RX_HISTORY = {
  items: [
    {
      prescriptionId: "rx-2", encounterId: "enc-9", serviceDate: "2026-07-02", issuedAt: NOW_ISO,
      doctorId: "doc-1", doctorName: "Dr Meera Rao", status: "active", version: 1,
      lines: [{ drug: "Tab Amoxicillin 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null }],
    },
    {
      prescriptionId: "rx-1", encounterId: "enc-8", serviceDate: "2026-03-11", issuedAt: NOW_ISO,
      doctorId: "doc-2", doctorName: "Dr A Left", status: "superseded", version: 1,
      lines: [{ drug: "Tab Metformin 500 mg", dose: "1 tab", route: "oral", frequency: "BD", durationDays: null, instructions: null }],
    },
  ],
};
const VITALS_HISTORY = {
  items: [
    { vitalsId: "v-1", encounterId: "enc-8", serviceDate: "2026-03-11", recordedAt: NOW_ISO, sbp: 124, dbp: 82, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, band: "adult", dangerFlags: [] },
    { vitalsId: "v-2", encounterId: "enc-9", serviceDate: "2026-07-02", recordedAt: NOW_ISO, sbp: 168, dbp: 104, pulse: 92, rr: 18, spo2: 96, tempC: 37.1, band: "adult", dangerFlags: [{ vital: "sbp", value: 168, bound: "max", limit: 160 }] },
  ],
};

describe("07d T1 — the past-record panel", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    setToken("t-1");
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  /** The file's own harness, reused rather than duplicated — `baseRoutes` already reaches the panel. */
  function withHistory(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/opd/patients/p-1/prescriptions": { status: 200, body: RX_HISTORY },
      "GET /api/opd/patients/p-1/vitals": { status: 200, body: VITALS_HISTORY },
      ...over,
    };
  }

  const asked = (path: string): boolean => fetchCalls().some((c) => c.path.includes(path));

  async function openHistoryTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "History" }));
    await screen.findByTestId("timeline");
  }

  it("T2: the queue's DEPTH is shown, not only its rows — a doctor should not have to count", async () => {
    mockRoutes(withHistory());
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    expect(screen.getByTestId("queue-depth")).toHaveTextContent("2 waiting");
  });

  /** T6 — 07c built the brief; a doctor who must navigate to it from the front door will not. */
  it("T6: the doctor's own day is one click from the cockpit", async () => {
    mockRoutes(withHistory());
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    expect(screen.getByRole("link", { name: "My day" })).toHaveAttribute("href", "/my-day");
  });

  /**
   * THE LAZY FETCH IS A PRIVACY PROPERTY, NOT A PERFORMANCE ONE. Each history read writes a row
   * into the PHI access log, so firing both on every consult render — or even on opening the tab —
   * would fill the DPDP register with reads nobody performed.
   */
  it("T1: neither history is read until its own view is opened", async () => {
    mockRoutes(withHistory());
    await openHistoryTab(userEvent.setup());

    expect(asked("/opd/patients/p-1/prescriptions")).toBe(false);
    expect(asked("/opd/patients/p-1/vitals")).toBe(false);
  });

  it("T1: the prescription history renders every past prescription, and LABELS a superseded one", async () => {
    mockRoutes(withHistory());
    const user = userEvent.setup();
    await openHistoryTab(user);

    await user.click(screen.getByRole("button", { name: "Prescriptions" }));

    expect(await screen.findByText(/Tab Amoxicillin 500 mg/)).toBeInTheDocument();
    // A superseded version is SHOWN and labelled, never hidden: "what was this patient actually
    // given in March" may well be the superseded row.
    expect(screen.getByText(/Tab Metformin 500 mg/)).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
    // E-7 — a prescription from a doctor who has left is readable; authorship is history.
    expect(screen.getByText("Dr A Left")).toBeInTheDocument();
  });

  it("T1: the vitals history renders OLDEST first, so it reads as a trend, and flags a danger row", async () => {
    mockRoutes(withHistory());
    const user = userEvent.setup();
    await openHistoryTab(user);

    await user.click(screen.getByRole("button", { name: "Vitals" }));

    const panel = await screen.findByTestId("vitals-history");
    const text = panel.textContent ?? "";
    expect(text.indexOf("2026-03-11")).toBeLessThan(text.indexOf("2026-07-02"));
    expect(text).toContain("168/104");
    expect(within(panel).getByText("flagged")).toBeInTheDocument();
  });

  /**
   * T7 — §1.3 guarantees several panels are empty on day one (zero medicines are seeded and the
   * `pharmacy` role has no holders), so a spinner that never resolves is the worst answer available.
   */
  it("T7: an empty history says so in a sentence rather than spinning", async () => {
    mockRoutes(withHistory({ "GET /api/opd/patients/p-1/prescriptions": { status: 200, body: { items: [] } } }));
    const user = userEvent.setup();
    await openHistoryTab(user);

    await user.click(screen.getByRole("button", { name: "Prescriptions" }));
    expect(await screen.findByText(/No prescription has been issued to this patient/i)).toBeInTheDocument();
  });
});

/**
 * PLAN 07d T5 / DD4 — **ADVISED INVESTIGATIONS ARE ADVICE, AND EVERY SURFACE SAYS SO.**
 *
 * There is no lab or radiology module in this system — no order table, no result table, no
 * accession (measured, §2). So the one thing these assertions defend above all others is that
 * nothing here implies a pipeline that does not exist: the screen says it, the printed slip says
 * it, and the price is a snapshot the counter re-confirms rather than a promise.
 */
const PRICE_LIST = {
  items: [
    { serviceId: "svc-usg", code: "USG-ABD", name: "Ultrasound abdomen", category: "procedure", pricePaise: 120000 },
    { serviceId: "svc-cbc", code: "LAB-CBC", name: "Complete blood count", category: "procedure", pricePaise: 35000 },
  ],
};

describe("07d T5 — advised investigations", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    setToken("t-1");
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/tariff/price-list": { status: 200, body: PRICE_LIST },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      ...over,
    };
  }

  it("says on the SCREEN that this creates no order — before a doctor assumes one exists", async () => {
    mockRoutes(routes());
    await openPanel(userEvent.setup());

    const panel = await screen.findByTestId("advised-tests");
    expect(within(panel).getByText(/create no order and book no sample/i)).toBeInTheDocument();
    expect(within(panel).getByText("No investigation advised.")).toBeInTheDocument();
  });

  it("searches the priced catalogue and shows the price beside each service", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");

    expect(await screen.findByText("Ultrasound abdomen — ₹1,200.00")).toBeInTheDocument();
    // A two-character floor: a catalogue search that fires on one letter is a list of everything.
    expect(screen.queryByText(/Complete blood count/)).not.toBeInTheDocument();
  });

  /**
   * The selection is SAVED through the consult-note route, which is what makes it free of new
   * authority: that route already requires the encounter's own treating doctor and an
   * `in_consultation` state.
   */
  it("advising a test saves it on the consult note, with the price as a SNAPSHOT", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");
    await user.click(await screen.findByRole("button", { name: /Ultrasound abdomen/ }));

    await waitFor(() => {
      expect(within(screen.getByTestId("advised-chosen")).getByText("Ultrasound abdomen")).toBeInTheDocument();
    });
    const put = fetchCalls().filter((c) => c.method === "PUT" && c.path.endsWith("/consult/note")).at(-1);
    expect(put?.body).toContain('"serviceId":"svc-usg"');
    // The PRICE travels with it — a reference resolved later would make the printed slip a promise
    // about today's tariff rather than a quotation from this afternoon (E-9).
    expect(put?.body).toContain('"pricePaise":120000');
  });

  it("an advised test can be taken back off, and the removal is saved too", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");
    await user.click(await screen.findByRole("button", { name: /Ultrasound abdomen/ }));
    await screen.findByTestId("advised-chosen");

    await user.click(screen.getByRole("button", { name: "Remove Ultrasound abdomen" }));

    await waitFor(() => { expect(screen.getByText("No investigation advised.")).toBeInTheDocument(); });
    const put = fetchCalls().filter((c) => c.method === "PUT" && c.path.endsWith("/consult/note")).at(-1);
    expect(put?.body).toContain('"advisedTests":[]');
  });

  /** E-10 — a service the hospital has withdrawn never appears; the catalogue is the source. */
  it("a catalogue with nothing matching says why, rather than showing an empty box", async () => {
    mockRoutes(routes({ "GET /api/tariff/price-list": { status: 200, body: { items: [] } } }));
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");
    expect(await screen.findByText(/The catalogue is curated in the tariff, not here/i)).toBeInTheDocument();
  });
});
