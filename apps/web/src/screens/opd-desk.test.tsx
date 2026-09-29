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
  { doctor: doctor("doc-1", "Dr Meera Rao"), sessionId: "sess-1", status: "in", waitingCount: 4, waitingVitalsCount: 1, nowServing: 3, scheduledToday: true, roomCode: "12", onLeaveToday: false, avgConsultMinutes: 6 },
  { doctor: doctor("doc-2", "Dr Anil Verma"), sessionId: "sess-2", status: "out", waitingCount: 2, waitingVitalsCount: 0, nowServing: 7, scheduledToday: true, roomCode: "14", onLeaveToday: false, avgConsultMinutes: 6 },
  { doctor: doctor("doc-3", "Dr Kavita Nair"), sessionId: "sess-3", status: "not_started", waitingCount: 0, waitingVitalsCount: 0, nowServing: null, scheduledToday: true, roomCode: "14", onLeaveToday: false, avgConsultMinutes: 6 },
  { doctor: doctor("doc-4", "Dr Sameer Bose"), sessionId: null, status: "none", waitingCount: 0, waitingVitalsCount: 0, nowServing: null, scheduledToday: false, roomCode: null, onLeaveToday: false, avgConsultMinutes: 6 },
];

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

async function act_(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

async function pickDepartment(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const select = await screen.findByLabelText("Department");
  await waitFor(() => expect(within(select).getByText("General medicine")).toBeInTheDocument());
  await user.selectOptions(select, "dep-1");
}

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

  /**
   * ═══ UX-AUDIT 2026-09-28 — THE QUEUE DESK, NOT A SECOND REGISTRATION DESK ═══
   *
   * The Chromium audit found this route drawing a patient search, a payer/referral form and an
   * "Open visit" on every doctor row beside a doctor dropdown — Desk One's job, done a second way.
   * The decision (docs/superpowers/decisions/2026-09-28-opd-desk.md) moved that door to Desk One.
   * These pin the absence AND the one door that replaces it, so the pair cannot pass on an empty
   * screen.
   */
  it("UX-AUDIT 2026-09-28: opens no visits here — no search, no payer/referral, no per-row Open visit; the door is Desk One", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
    });
    renderWithProviders(<OpdDesk />);
    await pickDepartment(userEvent.setup());
    await screen.findByTestId("board-row-doc-1");

    expect(screen.queryByLabelText("Search")).toBeNull();
    expect(screen.queryByLabelText("Payer")).toBeNull();
    expect(screen.queryByLabelText("Referral source")).toBeNull();
    expect(screen.queryByTestId("open-visit-doc-1")).toBeNull();
    // ONE way to choose a doctor: the board row. No doctor dropdown competes with it.
    expect(screen.queryByLabelText("Doctor")).toBeNull();
    expect(screen.getByTestId("open-visit-desk-one")).toHaveAttribute("href", "/counter");
  });

  it("UX-AUDIT 2026-09-28: a token taken from the list is drawn ONCE, in the lane; Esc puts it down", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/opd/queues": QUEUE_VIEW,
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();
    await pickDepartment(user);
    await user.click(await screen.findByTestId("board-pick-doc-1"));
    const row = await screen.findByTestId("queue-row-qe-1");
    expect(screen.queryByTestId("in-hand")).toBeNull();

    await user.click(row);
    const lane = screen.getByTestId("in-hand");
    expect(within(lane).getByText("Asha Devi")).toBeInTheDocument();
    expect(within(lane).getByText(/HMS0000001234/)).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-pressed", "true");
    // The list row and the lane — and nowhere else: no "Selected patient" card, no strip.
    expect(screen.getAllByText("Asha Devi")).toHaveLength(2);

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("in-hand")).toBeNull();
    expect(row).toHaveAttribute("aria-pressed", "false");
  });

  it("UX-AUDIT 2026-09-28: the line is one list with a source chip on every row and no filter tabs; Transfer is the pinned next act for a doctor on leave with people waiting", async () => {
    const away = { ...SUMMARY[0]!, onLeaveToday: true, scheduledToday: false };
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: [away, ...SUMMARY.slice(1)] },
      "GET /api/opd/queues": QUEUE_VIEW,
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();
    await pickDepartment(user);
    await user.click(await screen.findByTestId("board-pick-doc-1"));
    await screen.findByTestId("queue-row-qe-1");

    expect(within(screen.getByTestId("queue-row-qe-1")).getByText("Walk-in")).toBeInTheDocument();
    expect(within(screen.getByTestId("queue-row-qe-2")).getByText("Returned with results")).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();

    const bar = screen.getByTestId("action-bar");
    expect(within(bar).getByText(/On leave today — 4 still waiting/)).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Transfer queue" })).toHaveClass("od-pri");
  });

  it("moving ONE token in hand posts only that entry, still behind consent", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: ROOMS },
      "GET /api/opd/queues/summary": { items: SUMMARY },
      "GET /api/opd/queues": QUEUE_VIEW,
      "POST /api/opd/queues/transfer": { transferred: 1, toSessionId: "sess-2" },
    });
    renderWithProviders(<OpdDesk />);
    const user = userEvent.setup();
    await pickDepartment(user);
    await user.click(await screen.findByTestId("board-pick-doc-1"));
    await user.click(await screen.findByTestId("queue-row-qe-1"));
    await user.click(screen.getByTestId("move-qe-1"));

    const form = screen.getByTestId("od-act");
    await user.selectOptions(within(form).getByLabelText("To doctor"), "doc-2");
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await act_();
    expect(callsTo("POST", "/api/opd/queues/transfer")).toHaveLength(0);

    await user.click(within(form).getByLabelText(/consented to the transfer/));
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/transfer")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/opd/queues/transfer")[0]).toEqual({
      fromDoctorId: "doc-1", toDoctorId: "doc-2", serviceDate: TODAY, entryIds: ["qe-1"], consented: true, reason: "",
    });
    expect(await within(form).findByText("1 moved")).toBeInTheDocument();
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

    // UX-AUDIT 2026-09-28 — the token is taken into the lane, the act is chosen in step 3 and
    // confirmed from the pinned bar; the table's clipped Actions column and its dialog are gone.
    await user.click(screen.getByTestId("queue-row-qe-1"));
    await user.click(screen.getByTestId("abandon-qe-1"));
    const dialog = screen.getByTestId("od-act");
    // The form really is open and really is showing the reason control — the absence of a request
    // below is therefore about the empty reason, not about a form that never rendered.
    expect(within(dialog).getByLabelText("Reason")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Confirm abandon" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/visits/enc-1/abandon")).toHaveLength(0);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("A reason is required");

    await user.type(within(dialog).getByLabelText("Reason"), "Patient left");
    await user.click(screen.getByRole("button", { name: "Confirm abandon" }));

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
    const dialog = screen.getByTestId("od-act");
    await user.selectOptions(within(dialog).getByLabelText("To doctor"), "doc-2");
    await user.type(within(dialog).getByLabelText("Reason"), "Doctor called to ward");

    // Everything except consent is supplied — so a request now could only mean the consent rule is gone.
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/queues/transfer")).toHaveLength(0);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Consent is required");

    await user.click(within(dialog).getByLabelText(/consented to the transfer/));
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));

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
