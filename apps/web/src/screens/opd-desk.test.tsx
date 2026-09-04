import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdDesk } from "./opd-desk";

// 2026-08-18T04:00:00.000Z + 5:30 = 2026-08-18 09:30 IST — same IST calendar day (the T12 pin).
const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

/**
 * jsdom ships no WebSocket a test can drive (flag ⑮), so the transport is replaced by this fake and
 * restored in afterEach. `static OPEN = 1` is load-bearing: RealtimeClient.send() guards on
 * `WebSocket.OPEN`, which resolves to the stubbed global. (Copied deliberately — a mutant/self-
 * contained spec may not import another *.test.ts file.)
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

const DEPARTMENTS = [
  { id: "dep-1", code: "MED", name: "General medicine", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];
const ROOMS = [
  { id: "room-1", code: "12", name: "Consulting 12", floor: "1", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
  { id: "room-2", code: "14", name: "Consulting 14", floor: "1", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];

function doctor(id: string, displayName: string): Record<string, unknown> {
  return {
    id, userId: `u-${id}`, displayName, registrationNo: "NMC-4411", departmentId: "dep-1",
    specialty: "General", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
  };
}

/**
 * The four session states the plan names: in · out · not started · none (the last with no session
 * row). FD-7 T8 adds `onLeaveToday` to every row — the summary now consults `opd_doctor_leaves`,
 * which it never did before, so the field is required rather than optional and a fixture without it
 * would be a shape the server cannot send.
 */
const SUMMARY = [
  { doctor: doctor("doc-1", "Dr Meera Rao"), sessionId: "sess-1", status: "in", waitingCount: 4, waitingVitalsCount: 1, nowServing: 3, scheduledToday: true, roomCode: "12", onLeaveToday: false },
  { doctor: doctor("doc-2", "Dr Anil Verma"), sessionId: "sess-2", status: "out", waitingCount: 2, waitingVitalsCount: 0, nowServing: 7, scheduledToday: true, roomCode: "14", onLeaveToday: false },
  { doctor: doctor("doc-3", "Dr Kavita Nair"), sessionId: "sess-3", status: "not_started", waitingCount: 0, waitingVitalsCount: 0, nowServing: null, scheduledToday: true, roomCode: "14", onLeaveToday: false },
  { doctor: doctor("doc-4", "Dr Sameer Bose"), sessionId: null, status: "none", waitingCount: 0, waitingVitalsCount: 0, nowServing: null, scheduledToday: false, roomCode: null, onLeaveToday: false },
];

const SEARCH_HIT = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000", sex: "female",
  dob: null, isConfidential: false, hasPhoto: false,
};
const QR = { payload: "1.p-1.HMS0000001234.3.6f2a9c", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null };

/** POST /opd/visits answers OpenVisitResult; the desk reads tokenNo / roomId / visitType off it. */
const OPEN_RESULT = { tokenNo: 11, sessionId: "sess-1", roomId: "room-1", visitType: "revisit", doctorScheduledToday: true,
  // The open-visit response has always carried the encounter; the slip started READING it when
  // the visit number landed on it, which is why this key appears here and not before.
  encounter: { id: "enc-1", visitNo: "V2608180011" } };

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "qe-1", seq: 1, sessionId: "sess-1", encounterId: "enc-1", tokenNo: 4, kind: "walk_in",
    appointmentAt: null, status: "waiting", danger: false, reEntry: false, perk: false,
    eligibleAt: null, calledAt: null, callCount: 0, skips: 0, doneAt: null, createdAt: NOW_ISO,
    position: 1, queueClass: 3,
    encounter: { id: "enc-1", patientId: "p-1", visitType: "new", dangerFlagged: false, status: "waiting" },
    patient: { requestedId: "p-1", id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", alias: null, restricted: false, sex: "female", dob: null },
    ...overrides,
  };
}

const QUEUE_VIEW = {
  session: { id: "sess-1", doctorId: "doc-1", serviceDate: TODAY, roomId: "room-1", status: "in", nextToken: 6, callsMade: 3, openedAt: NOW_ISO, closedAt: null, createdAt: NOW_ISO },
  doctor: doctor("doc-1", "Dr Meera Rao"),
  ordered: [
    entry({}),
    entry({
      id: "qe-2", seq: 2, encounterId: "enc-2", tokenNo: 5, position: 2, queueClass: 1, reEntry: true,
      encounter: { id: "enc-2", patientId: "p-2", visitType: "revisit", dangerFlagged: false, status: "waiting" },
      patient: { requestedId: "p-2", id: "p-2", uhid: "HMS0000005678", name: "Ravi Kumar", alias: null, restricted: false, sex: "male", dob: null },
    }),
  ],
  current: null,
  inConsult: [],
  waitingVitals: 1,
  counts: { waiting: 2, called: 0, inConsult: 0, done: 3, left: 0 },
};

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

async function pickDepartment(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const select = await screen.findByLabelText("Department");
  await waitFor(() => expect(within(select).getByText("General medicine")).toBeInTheDocument());
  await user.selectOptions(select, "dep-1");
}

async function pickPatient(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Search"), "98765");
  await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
  expect(await screen.findByText(/Selected patient: Asha Devi/)).toBeInTheDocument();
}

/**
 * PLAN 07b T2 — `useNavigate` is the one TanStack Router hook this screen calls (the token slip's
 * handoff to `/billing?encounterId=…`). Everything else in the module stays REAL, for the reason
 * `billing-counter.test.tsx` records: `PatientPicker` pulls in router hooks of its own, and a
 * factory that dropped them would fail at access time rather than tell us anything. (FD-7 T3 cut the
 * screen-for-a-component import that used to make this worse.) A `<Link>` was tried first and cannot work here — it needs a `RouterProvider`
 * this suite deliberately does not mount.
 */
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

describe("OpdDesk", () => {
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

  /**
   * ═══ FD-7 T8 — "NOT SCHEDULED TODAY" IS THE WRONG SENTENCE FOR A DOCTOR ON LEAVE ═══
   *
   * Two things were wrong before T8 and they compound. The summary never consulted
   * `opd_doctor_leaves`, so a doctor on approved leave read as SCHEDULED and this board said nothing
   * at all. Once the server was taught about leave, every absent doctor would have collapsed into
   * one message — and "not scheduled today" is a shrug, where "on leave today" is an answer a clerk
   * can give the patient in front of them.
   *
   * The count is the point of the second row: those patients are in the building holding a token and,
   * in a bill-first hospital, have already paid. The transfer control that re-seats them — with the
   * consent E2 requires — is on this same screen.
   */
  it("FD-7 T8: a doctor on leave says SO, with the number still waiting, and is not merely 'not scheduled'", async () => {
    const onLeaveWithQueue = { ...SUMMARY[0]!, doctor: doctor("doc-9", "Dr Away"), sessionId: "sess-9", waitingCount: 3, scheduledToday: false, onLeaveToday: true };
    const onLeaveEmpty = { ...SUMMARY[3]!, doctor: doctor("doc-8", "Dr Gone"), waitingCount: 0, scheduledToday: false, onLeaveToday: true };
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: [...SUMMARY, onLeaveWithQueue, onLeaveEmpty] },
    });
    renderWithProviders(<OpdDesk />);
    await pickDepartment(userEvent.setup());

    const stranded = await screen.findByTestId("on-leave-doc-9");
    expect(stranded.textContent).toContain("3");                       // the people still waiting
    expect(stranded.textContent).not.toContain("Not scheduled");       // THE KILL for the shrug
    expect(screen.getByTestId("on-leave-doc-8").textContent).toBe("On leave today");
    // And a doctor who is simply off the roster keeps the OLD sentence — the two are not merged.
    expect(screen.queryByTestId("on-leave-doc-4")).toBeNull();
  });

  it("the doctor board renders GET /opd/queues/summary rows with room, status badge, waiting count, and the not-scheduled warning only where scheduledToday is false", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();

    await pickDepartment(user);

    await waitFor(() => expect(callsTo("GET", "/api/opd/queues/summary").length).toBeGreaterThanOrEqual(1));
    expect(callsTo("GET", "/api/opd/queues/summary")[0]!.url).toBe(`/api/opd/queues/summary?departmentId=dep-1&serviceDate=${TODAY}`);

    const rowIn = await screen.findByTestId("board-row-doc-1");
    expect(within(rowIn).getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(within(rowIn).getByText("In")).toBeInTheDocument();
    expect(within(rowIn).getByText("Room: 12")).toBeInTheDocument();
    expect(within(rowIn).getByTestId("board-waiting-doc-1")).toHaveTextContent("4");
    expect(within(rowIn).getByText("Now serving: 3")).toBeInTheDocument();
    expect(within(rowIn).queryByText("Not scheduled today")).toBeNull();

    const rowOut = screen.getByTestId("board-row-doc-2");
    expect(within(rowOut).getByText("Out")).toBeInTheDocument();
    expect(within(rowOut).getByText("Room: 14")).toBeInTheDocument();
    expect(within(rowOut).getByTestId("board-waiting-doc-2")).toHaveTextContent("2");

    const rowNotStarted = screen.getByTestId("board-row-doc-3");
    expect(within(rowNotStarted).getByText("Not started")).toBeInTheDocument();
    expect(within(rowNotStarted).queryByText("Not scheduled today")).toBeNull();

    const rowNone = screen.getByTestId("board-row-doc-4");
    expect(within(rowNone).getByText("No session")).toBeInTheDocument();
    expect(within(rowNone).getByText("Room: —")).toBeInTheDocument();
    // The warning belongs to scheduledToday === false ALONE — doc-3 also has no open session and
    // must NOT carry it, which is what separates "no session yet today" from "not working today".
    expect(within(rowNone).getByText("Not scheduled today")).toBeInTheDocument();
    expect(screen.getAllByText("Not scheduled today")).toHaveLength(1);
  });

  it("Open visit posts { patientId, departmentId, doctorId, intendedPayer } — referral source only when chosen — and renders the slip with the returned token, room and visit type", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/patients/search": { items: [SEARCH_HIT] },
      "GET /api/opd/appointments": { items: [] },
      "GET /api/opd/patients/p-1/timeline": { items: [] },
      "POST /api/opd/visits": OPEN_RESULT,
      "GET /api/patients/p-1/qr": QR,
    });
    const { container } = renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();

    await pickDepartment(user);
    await pickPatient(user);
    await screen.findByTestId("board-row-doc-1");

    await user.click(screen.getByTestId("open-visit-doc-1"));

    await waitFor(() => expect(callsTo("POST", "/api/opd/visits")).toHaveLength(1));
    // The default lane: payer defaults to self and NO referral key travels at all.
    expect(bodiesOf("POST", "/api/opd/visits")[0]).toEqual({
      patientId: "p-1", departmentId: "dep-1", doctorId: "doc-1", intendedPayer: "self",
    });

    await waitFor(() => expect(callsTo("GET", "/api/patients/p-1/qr")).toHaveLength(1));
    const slip = container.querySelector("[data-testid='token-card']") as HTMLElement;
    expect(slip).not.toBeNull();
    expect(within(slip).getByTestId("token-no")).toHaveTextContent("MED-11"); // FD-20 grammar
    // The wiring, not the rendering (token-slip.test.tsx owns that): the number the API returned
    // on the encounter is the number that reaches the paper.
    expect(within(slip).getByTestId("visit-no")).toHaveTextContent("V2608180011");
    expect(within(slip).getByText("Room: 12")).toBeInTheDocument(); // roomId room-1 → code 12
    expect(within(slip).getByText("MED · General medicine")).toBeInTheDocument();
    expect(within(slip).getByText("Dr Meera Rao")).toBeInTheDocument();
    // The badge reflects the RESPONSE's visitType, and the owner's free-follow-up line rides revisit.
    expect(screen.getByTestId("visit-type-badge")).toHaveTextContent("Revisit");
    expect(screen.getByText(/Free follow-up/)).toBeInTheDocument();
    // Exactly one token card is ever mounted (it replaces the desk view). FD-24 T6 removed the
    // `.print-doc` isolation with the browser print path; the card is a screen confirmation now.
    expect(container.querySelectorAll("[data-testid='token-card']")).toHaveLength(1);
    expect(container.querySelectorAll(".print-doc")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Next patient" }));
    await pickPatient(user);
    await user.selectOptions(screen.getByLabelText("Referral source"), "camp");
    await user.type(screen.getByLabelText("Referrer name"), "Ward camp");
    await user.click(screen.getByTestId("open-visit-doc-1"));

    await waitFor(() => expect(callsTo("POST", "/api/opd/visits")).toHaveLength(2));
    expect(bodiesOf("POST", "/api/opd/visits")[1]).toEqual({
      patientId: "p-1", departmentId: "dep-1", doctorId: "doc-1", intendedPayer: "self",
      referralSource: "camp", referrerName: "Ward camp",
    });
  });

  /**
   * PLAN 07b T2 — THE RAIL THAT WAS BUILT AND NEVER SENT.
   *
   * `router.tsx` documented `/billing?encounterId=…` as the OPD desk's handoff to the counter,
   * `billing-counter.tsx` read the param and its suite covered the deep link — and NOTHING in the
   * app ever constructed it, so every cashier re-found the patient and typed the visit id by hand.
   * These two assertions are what stop that regressing, and they are a pair on purpose: the link
   * must appear for a chargeable visit and must NOT appear for a free follow-up.
   */
  it("a chargeable visit's slip hands off to the counter carrying the encounter id", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/patients/search": { items: [SEARCH_HIT] },
      "GET /api/opd/appointments": { items: [] },
      "GET /api/opd/patients/p-1/timeline": { items: [] },
      "POST /api/opd/visits": { ...OPEN_RESULT, visitType: "new" },
      "GET /api/patients/p-1/qr": QR,
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();
    await pickDepartment(user);
    await pickPatient(user);
    await screen.findByTestId("board-row-doc-1");
    await user.click(screen.getByTestId("open-visit-doc-1"));

    await user.click(await screen.findByTestId("take-payment"));
    expect(navigate).toHaveBeenCalledWith({ to: "/billing", search: { encounterId: "enc-1" } });
  });

  it("a free follow-up's slip offers NO payment step — it names the vitals desk instead", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/patients/search": { items: [SEARCH_HIT] },
      "GET /api/opd/appointments": { items: [] },
      "GET /api/opd/patients/p-1/timeline": { items: [] },
      "POST /api/opd/visits": OPEN_RESULT, // visitType: "revisit"
      "GET /api/patients/p-1/qr": QR,
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();
    await pickDepartment(user);
    await pickPatient(user);
    await screen.findByTestId("board-row-doc-1");
    await user.click(screen.getByTestId("open-visit-doc-1"));

    await screen.findByTestId("slip-next-step");
    expect(screen.queryByTestId("take-payment")).toBeNull();
  });

  it("today's arrivals for the picked patient show the booked appointment with Check in → the slip, beside the last-visit hint", async () => {
    const appointment = {
      id: "ap-1", patientId: "p-1", doctorId: "doc-1", departmentId: "dep-1", serviceDate: TODAY,
      slotStart: "2026-08-18T04:30:00.000Z", slotEnd: "2026-08-18T04:40:00.000Z", status: "booked", source: "desk",
      note: null, encounterId: null, rescheduledToId: null, rescheduledFromId: null, cancelReason: null, leaveId: null,
      bookedBy: "u-1", bookedAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
      patient: { requestedId: "p-1", id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", alias: null, restricted: false, sex: "female", dob: null },
    };
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/patients/search": { items: [SEARCH_HIT] },
      "GET /api/opd/appointments": { items: [appointment] },
      "GET /api/opd/patients/p-1/timeline": {
        items: [{
          encounterId: "enc-0", serviceDate: "2026-08-04", openedAt: "2026-08-04T04:00:00.000Z", status: "completed",
          visitType: "new", doctorId: "doc-1", doctorName: "Dr Meera Rao", departmentId: "dep-1",
          departmentName: "General medicine", diagnosis: "Fever", icd10Code: null, prescriptionLineCount: 2, dangerFlagged: false,
        }],
      },
      "POST /api/opd/appointments/ap-1/check-in": { ...OPEN_RESULT, tokenNo: 9, roomId: "room-2", visitType: "new", encounter: { id: "enc-9", visitNo: "V2608180009" } },
      "GET /api/patients/p-1/qr": QR,
    });
    const { container } = renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();

    await pickDepartment(user);
    await pickPatient(user);

    await waitFor(() => expect(callsTo("GET", "/api/opd/appointments")).toHaveLength(1));
    expect(callsTo("GET", "/api/opd/appointments")[0]!.url).toBe(`/api/opd/appointments?patientId=p-1&serviceDate=${TODAY}`);
    expect(await screen.findByText("Last seen 2026-08-04 · General medicine")).toBeInTheDocument();

    const arrivals = await screen.findByTestId("arrivals");
    expect(within(arrivals).getByText("10:00")).toBeInTheDocument(); // 04:30Z → 10:00 IST
    expect(within(arrivals).getByText("Booked")).toBeInTheDocument();

    await user.click(within(arrivals).getByTestId("checkin-ap-1"));

    await waitFor(() => expect(callsTo("POST", "/api/opd/appointments/ap-1/check-in")).toHaveLength(1));
    const slip = container.querySelector("[data-testid='token-card']") as HTMLElement;
    expect(slip).not.toBeNull();
    expect(within(slip).getByTestId("token-no")).toHaveTextContent("MED-9");
    expect(within(slip).getByTestId("visit-no")).toHaveTextContent("V2608180009");
    expect(within(slip).getByText("Room: 14")).toBeInTheDocument(); // roomId room-2 → code 14
    expect(screen.getByTestId("visit-type-badge")).toHaveTextContent("New");
  });

  it("the queue overview refetches on a queue.called frame — timers frozen so the 15 s poll provably cannot be the cause", async () => {
    // MECHANISM (§3.14c): the ONLY thing that can produce a second GET /opd/queues here is the
    // realtime handler's invalidateQueries. The alternatives are each shut off by construction:
    //  · the 15 s poll  — fake timers are frozen and this test advances < 1 s of them, asserted below;
    //  · a remount      — nothing unmounts the query's component between the two counts;
    //  · the `authed` frame's connected-state re-render — counted explicitly BEFORE the event frame.
    vi.useRealTimers(); // the shared beforeEach already mocked Date; useFakeTimers refuses on top of that
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const startedAt = Date.now();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-1" } },
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/opd/queues": QUEUE_VIEW,
    });

    // @testing-library's waitFor cannot drive vitest's fake timers (it gates its clock-advance on a
    // global `jest`, which vitest does not define — probed on this harness), so this test flushes by
    // hand instead. Every advance below is milliseconds, never seconds.
    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    renderWithProviders(<OpdDesk />);
    await flush();
    await flush();

    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "dep-1" } });
    await flush();
    await flush();

    fireEvent.click(screen.getByTestId("board-pick-doc-1"));
    await flush();
    await flush();

    expect(callsTo("GET", "/api/opd/queues")).toHaveLength(1);
    expect(callsTo("GET", "/api/opd/queues")[0]!.url).toBe(`/api/opd/queues?doctorId=doc-1&serviceDate=${TODAY}`);
    expect(screen.getByTestId("queue-row-qe-1")).toHaveTextContent("4");
    expect(within(screen.getByTestId("queue-row-qe-2")).getByText("Returned with results")).toBeInTheDocument();

    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain("/api/ws");
    await act(async () => {
      ws.simulateOpen();
    });
    await act(async () => {
      ws.simulateMessage({ type: "authed", userId: "u-1" });
    });
    await flush();
    // Negative control: auth + the connected re-render on their own refetch NOTHING.
    expect(callsTo("GET", "/api/opd/queues")).toHaveLength(1);

    await act(async () => {
      ws.simulateMessage({
        type: "event", topic: `queue:doc-1:${TODAY}`, name: "queue.called", seq: 41,
        occurredAt: NOW_ISO, payload: { doctorId: "doc-1", serviceDate: TODAY, tokenNo: 4 },
      });
    });
    await flush();

    expect(callsTo("GET", "/api/opd/queues")).toHaveLength(2);
    // The poll is 15 000 ms; this whole test advanced the (frozen) clock by well under a second.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("K45: Abandon sends NO request while the reason is empty, and posts { reason } once it is not", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/opd/queues": QUEUE_VIEW,
      "POST /api/opd/visits/enc-1/abandon": { encounter: { id: "enc-1", status: "abandoned" } },
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();

    await pickDepartment(user);
    await user.click(await screen.findByTestId("board-pick-doc-1"));
    await screen.findByTestId("queue-row-qe-1");

    await user.click(screen.getByTestId("abandon-qe-1"));
    const dialog = await screen.findByRole("dialog");
    // The dialog really is open and really is showing the reason control — the absence of a request
    // below is therefore about the empty reason, not about a dialog that never rendered.
    expect(within(dialog).getByLabelText("Reason")).toHaveValue("");

    await user.click(within(dialog).getByRole("button", { name: "Confirm abandon" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/visits/enc-1/abandon")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("A reason is required");

    await user.type(within(dialog).getByLabelText("Reason"), "Patient left");
    await user.click(within(dialog).getByRole("button", { name: "Confirm abandon" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/visits/enc-1/abandon")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/opd/visits/enc-1/abandon")[0]).toEqual({ reason: "Patient left" });
  });

  it("K44: Transfer queue is always rendered, sends NO request until consent is ticked, then posts consented: true — and the server's 403 renders inline", async () => {
    // stubFetch always answers 200 and so cannot produce the 403 this case is about — the direct
    // stub is the only way to see a real non-2xx in this harness (the opd-admin precedent).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
        const path = raw.split("?")[0]!;
        const json = (body: unknown, status: number): Response =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (init?.method === "POST" && path === "/api/opd/queues/transfer") {
          return json({ statusCode: 403, message: "queue transfer needs a front-office supervisor", code: "forbidden" }, 403);
        }
        if (path === "/api/opd/departments") return json({ items: DEPARTMENTS }, 200);
        if (path === "/api/opd/rooms") return json({ items: ROOMS }, 200);
        if (path === "/api/opd/queues/summary") return json({ items: SUMMARY }, 200);
        if (path === "/api/opd/queues") return json(QUEUE_VIEW, 200);
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();

    // Rendered before any department, doctor or role is known: the desk holds no permission model.
    expect(screen.getByRole("button", { name: "Transfer queue" })).toBeInTheDocument();

    await pickDepartment(user);
    await user.click(await screen.findByTestId("board-pick-doc-1"));
    await screen.findByTestId("queue-row-qe-1");

    await user.click(screen.getByRole("button", { name: "Transfer queue" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("To doctor"), "doc-2");
    await user.type(within(dialog).getByLabelText("Reason"), "Doctor called to ward");

    // Everything except consent is supplied — so a request now could only mean the consent rule is gone.
    await user.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/queues/transfer")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Consent is required");

    await user.click(within(dialog).getByLabelText(/consented to the transfer/));
    await user.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/transfer")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/opd/queues/transfer")[0]).toEqual({
      fromDoctorId: "doc-1", toDoctorId: "doc-2", serviceDate: TODAY, consented: true, reason: "Doctor called to ward",
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("queue transfer needs a front-office supervisor");
  });
});


/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T3 / D7 — THE PAID STAMP ON THE BOARD
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("OpdDesk — the fee stamp (RC-4 T3)", () => {
  /**
   * `feeStatus` HAS BEEN ON THIS SCREEN'S WIRE SINCE RC-1 T3 AND WENT UNRENDERED FOR THREE PHASES.
   * Core's `QueueEntryView` carries it (`opd/queue.ts:56`), `listQueue` fills it from
   * `encounterFeeStatuses` (`:92`), and `opd-queue.controller.ts:148` returns the result with **no
   * serializer between** — so this task needed no core change at all, only a web type that had
   * stopped being narrower than its producer. Third time in this series, after `matchedOn` and
   * `avgConsultMinutes`, which is why the phase document told the task to MEASURE FIRST.
   *
   * Driven through the real screen — department, then doctor, then the queue table — rather than by
   * rendering the table in isolation, per method §5A.3.
   */
  async function boardWith(feeStatuses: (string | null)[]): Promise<void> {
    setToken("tok-1");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-1" } },
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/opd/queues": {
        ...QUEUE_VIEW,
        ordered: feeStatuses.map((feeStatus, i) => entry({
          id: `qe-fs-${i}`, seq: i + 1, tokenNo: 100 + i, position: i + 1, feeStatus,
          encounterId: `enc-fs-${i}`,
          encounter: { id: `enc-fs-${i}`, patientId: "p-1", visitType: "new", dangerFlagged: false, status: "waiting" },
        })),
      },
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();
    // The shared helper waits for the department OPTIONS to arrive before selecting — selecting a
    // value that has not loaded yet is a silent no-op that reads as "the screen is broken".
    await pickDepartment(user);
    await user.click(await screen.findByTestId("board-pick-doc-1"));
    await screen.findByTestId("queue-row-qe-fs-0");
  }

  it("stamps each of the four states with its own words, so a ₹0 visit is not read as a paid one", async () => {
    await boardWith(["settled", "unsettled", "credit", "free"]);
    expect(screen.getByTestId("fee-status-qe-fs-0").textContent).toBe("PAID");
    expect(screen.getByTestId("fee-status-qe-fs-1").textContent).toBe("UNPAID");
    expect(screen.getByTestId("fee-status-qe-fs-2").textContent).toBe("ON ACCOUNT");
    // `free` is NOT folded into `settled`: a ₹0 review visit and a paid one look identical on a
    // board that only knows paid/unpaid, and the point of the free branch is that it is defensible.
    expect(screen.getByTestId("fee-status-qe-fs-3").textContent).toBe("NO CHARGE");
  });

  /**
   * THE MUTANT: `null` treated as unpaid. `null` means the server declined to characterise this
   * encounter's fee — it is NOT `"unsettled"`, and stamping UNPAID on it asserts something nobody
   * said, in red, on a board a supervisor reads at a glance.
   */
  it("MUTANT — a null feeStatus stamped as UNPAID; it must render NOTHING", async () => {
    await boardWith([null, "unsettled"]);
    expect(screen.getByTestId("fee-status-qe-fs-1").textContent).toBe("UNPAID"); // the census
    expect(screen.queryByTestId("fee-status-qe-fs-0")).toBeNull();               // THE KILL
  });
});

describe("VD-2 T3 — the doctor-board flash rides the queue topic", () => {
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
  it("queue.escalated paints the flash naming the token; queue.escalation_cancelled turns it into the cancel line", async () => {
    vi.useRealTimers(); // the shared beforeEach already mocked Date; useFakeTimers refuses on top of that
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("t");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-1" }, permissions: { hospital: ["opd.visits.open", "opd.queue.read"], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/opd/queues": QUEUE_VIEW,
    });
    const flush = async (ms = 5): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    renderWithProviders(<OpdDesk />);
    await flush(); await flush();
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "dep-1" } });
    await flush(); await flush();
    fireEvent.click(screen.getByTestId("board-pick-doc-1"));
    await flush(); await flush();
    expect(screen.queryByTestId("escalation-flash")).toBeNull();
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => { ws.simulateOpen(); });
    await act(async () => { ws.simulateMessage({ type: "authed", userId: "u-1" }); });
    await flush();
    await act(async () => {
      ws.simulateMessage({ type: "event", topic: `queue:doc-1:${TODAY}`, name: "queue.escalated", seq: 42, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY, tokenNo: 7, entryId: "qe-7", fromClass: 3, toClass: 0, by: "agent" } });
    });
    await flush();
    const flash = screen.getByTestId("escalation-flash");
    expect(flash).toHaveTextContent("Token 7");
    expect(flash.getAttribute("data-cancelled")).toBe("false");
    await act(async () => {
      ws.simulateMessage({ type: "event", topic: `queue:doc-1:${TODAY}`, name: "queue.escalation_cancelled", seq: 43, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY, tokenNo: 7, entryId: "qe-7", restoredClass: 3, withinMs: 4000 } });
    });
    await flush();
    expect(screen.getByTestId("escalation-flash").getAttribute("data-cancelled")).toBe("true");
    expect(screen.getByTestId("escalation-flash")).toHaveTextContent("cancelled");
    // an unrelated frame leaves the flash alone
    await act(async () => {
      ws.simulateMessage({ type: "event", topic: `queue:doc-1:${TODAY}`, name: "queue.called", seq: 44, occurredAt: NOW_ISO, payload: { doctorId: "doc-1", serviceDate: TODAY, tokenNo: 4 } });
    });
    await flush();
    expect(screen.getByTestId("escalation-flash")).toHaveTextContent("Token 7");
    // CLOSE pass 1 — Dr Rao's flash does not follow the picker to another doctor's board
    fireEvent.click(screen.getByTestId("board-pick-doc-2"));
    await flush(); await flush();
    expect(screen.queryByTestId("escalation-flash")).toBeNull();
  });
});
