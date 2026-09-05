import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { router } from "../router";
import { stubFetch } from "../test-utils";
import "../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 SCREEN 2 — `/appointment`, THE APPOINTMENT CLERK'S SEAT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE CLOCK IS PINNED, AND THIS SUITE CANNOT EXIST WITHOUT IT ═══
 *
 * Every claim here is about a TIME: which slots are past, which bookings were missed, which
 * rebooking rows are still in the future. All three are computed against `Date.now()` by the code
 * under test. An unpinned clock would make this file green until whatever hour it happened to break
 * — the exact defect this lane fixed in two other files tonight, written in fresh.
 *
 * Midday IST, far from both the UTC and the IST rollover.
 */
const NOW_ISO = "2026-09-05T05:00:00.000Z"; // 10:30 IST on 2026-09-05
const TODAY = "2026-09-05";
const TOMORROW = "2026-09-06";

const DOCTOR = {
  id: "doc-1", userId: "u-doc", displayName: "Dr Meera Iyer", departmentId: "d-1",
  active: true, registrationNo: "MCI-1", roomId: "r-1",
};
const ROOM = { id: "r-1", code: "OPD-1", name: "OPD room 1", floor: "Ground", active: true };

/** Two free, one taken — the three chip states the board must keep distinguishable. */
const SLOTS = [
  { start: `${TOMORROW}T04:00:00.000Z`, end: `${TOMORROW}T04:10:00.000Z`, roomId: "r-1", scheduleId: "s-1", booked: false, past: false },
  { start: `${TOMORROW}T04:10:00.000Z`, end: `${TOMORROW}T04:20:00.000Z`, roomId: "r-1", scheduleId: "s-1", booked: true, past: false },
  { start: `${TOMORROW}T04:20:00.000Z`, end: `${TOMORROW}T04:30:00.000Z`, roomId: "r-1", scheduleId: "s-1", booked: false, past: false },
];

const summary = (id: string, name: string, phone?: string | null): Record<string, unknown> => ({
  requestedId: id, id, uhid: `U0011000${id.slice(-1)}`, name, alias: null, restricted: false,
  administrativeGender: "female", dob: "1985-01-01", ...(phone === undefined ? {} : { phone }),
});

const appointment = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "a-1", patientId: "p-1", doctorId: "doc-1", departmentId: "d-1",
  serviceDate: TOMORROW, slotStart: `${TOMORROW}T04:00:00.000Z`, slotEnd: `${TOMORROW}T04:10:00.000Z`,
  status: "booked", source: "desk", note: null, encounterId: null,
  rescheduledToId: null, rescheduledFromId: null, cancelReason: null, leaveId: null,
  bookedBy: "u1", bookedAt: `${TODAY}T00:00:00.000Z`, updatedBy: "u1", updatedAt: `${TODAY}T00:00:00.000Z`,
  patient: summary("p-1", "Ramesh Kumar"),
  ...over,
});

/**
 * ═══ READING WHAT WAS ACTUALLY POSTED, AND WHY THIS FILE COULD NOT ═══
 *
 * Copied from `opd-appointments.test.tsx:52-62` — they are local to that file and exported from
 * nowhere, and a shared home for them is a refactor of two suites, not of this finding.
 *
 * `stubFetch` installs a `vi.fn()`, so every call is on the mock: the METHOD, the PATH and the
 * BODY. Until this file read them, all four of this screen's write paths could carry the wrong
 * patient, the wrong slot or the wrong reason and stay green — the recorder at `mount` parsed
 * every booking body and nothing ever asked it a question.
 */
function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { url, path: url.split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodyOf(method: string, path: string): Record<string, unknown> {
  return JSON.parse(callsTo(method, path)[0]?.body ?? "{}") as Record<string, unknown>;
}

function mount(
  posted: { url: string; body: unknown }[],
  opts: {
    rebooking?: unknown[]; book?: unknown[]; leaves?: unknown[]; canCheckIn?: boolean;
    /**
     * ═══ THE THREE WRITE ROUTES THIS HARNESS DID NOT HAVE, AND THE TRAP THEY SET ═══
     *
     * `mount` registered exactly ONE write route — `POST /api/opd/appointments` — so check-in,
     * reschedule and cancel were not merely unasserted here, they were UNREACHABLE: `stubFetch`
     * answers an unregistered key with a 404 (`test-utils.tsx:37`) and `rowAct` swallows that into
     * a row-error. "The call did not happen" would have passed for entirely the wrong reason.
     *
     * Spread LAST, so a test may also REPLACE a read route (the slot board does exactly that when
     * it needs the board to change under a held slot). And in the two-row tests, register BOTH
     * rows' routes: a mutant that calls the wrong row must get a 200 and be caught by the COUNT,
     * never by an incidental 404 whose error banner could be misread as the guard working.
     */
    routes?: Record<string, unknown>;
  } = {},
): void {
  const hospital = [
    "opd.appointments.manage", "opd.appointments.read", "opd.masters.read",
    "opd.visits.read", "patients.read",
    ...(opts.canCheckIn === false ? [] : ["opd.visits.open"]),
  ];
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital, scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [{
      id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
      administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
      district: "Hajipur", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
    }] },
    "GET /api/opd/doctors": { items: [DOCTOR] },
    "GET /api/opd/rooms": { items: [ROOM] },
    "GET /api/opd/departments": { items: [{ id: "d-1", code: "MED", name: "General Medicine", active: true }] },
    "GET /api/opd/slots": { slots: SLOTS },
    "GET /api/opd/leaves": { items: opts.leaves ?? [] },
    /*
      ═══ THE STUB TRAP THIS SCREEN WALKS INTO, AND WHY THE HANDLER BRANCHES ═══

      `stubFetch` keys on `METHOD path` with the QUERY STRING STRIPPED, and this screen makes TWO
      different reads of `/opd/appointments` — the day's book and the needs-rebooking rail. They
      collide on one entry. Registering them separately would silently serve whichever was declared
      last to BOTH, and every assertion here would still pass — vacuously, against the wrong body.
    */
    "GET /api/opd/appointments": (_init?: RequestInit, url?: string) => (
      (url ?? "").includes("needsRebooking=true")
        ? { items: opts.rebooking ?? [] }
        : { items: opts.book ?? [] }
    ),
    "GET /api/opd/patients/p-1/timeline": { items: [] },
    "POST /api/opd/appointments": (init?: RequestInit, url?: string) => {
      posted.push({ url: url ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
      return { appointment: appointment({}) };
    },
    ...(opts.routes ?? {}),
  });
  setToken("t");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/appointment"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** The route is DRIVEN, not requested — `router` is a module singleton. See registration.test.tsx. */
async function arrive(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/appointment" }); });
  await waitFor(() => { expect(screen.getByTestId("appointment-seat")).toBeInTheDocument(); });
}

beforeEach(() => { vi.setSystemTime(new Date(NOW_ISO)); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); vi.useRealTimers(); });

it("the frozen clock is the day these fixtures are dated", () => {
  expect(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)).toBe(TODAY);
});

describe("FD-25: the rebooking rail — the only screen that answers 'who do I have to call?'", () => {
  /**
   * THIS RAIL IS THE REASON THE ROUTE EXISTS. Everything else on this screen is available on some
   * other surface; "the doctor is away, who do I have to call?" is not. Two things had to be built
   * for it, and both are asserted here because both are invisible when wrong.
   */
  it("shows who to ring, WITH the number, and asks the server for it explicitly", async () => {
    const seen: string[] = [];
    const posted: { url: string; body: unknown }[] = [];
    const origFetch = globalThis.fetch;
    mount(posted, {
      rebooking: [appointment({
        id: "r-1", status: "needs_rebooking", serviceDate: TOMORROW,
        patient: summary("p-2", "Lakshmi Prasad", "9835120114"),
      })],
    });
    /* Record the URLs so the `contact=true` opt-in is proved, not assumed. */
    const wrapped = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(typeof input === "string" ? input : String(input));
      return wrapped(input, init);
    }) as typeof fetch;

    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("1 patient"); });
    const rail = within(screen.getByTestId("rebooking-rail"));
    expect(rail.getByText("Lakshmi Prasad")).toBeInTheDocument();
    /*
      THE NUMBER. `PatientSummary` carries no contact field by default and a rail built on the plain
      read would render a blank column — a failure that is invisible because there is no field to be
      null. The opt-in is what makes it appear, so the request is asserted too.
    */
    expect(rail.getByText("9835120114")).toBeInTheDocument();
    expect(seen.some((u) => u.includes("needsRebooking=true") && u.includes("contact=true"))).toBe(true);
    globalThis.fetch = origFetch;
  });

  /**
   * `GET /opd/appointments?needsRebooking=true` HAS NO DATE BOUND — it returns every such row ever
   * created, oldest first, capped at 500. A rail built on the raw list fills with last month's
   * cancelled leave, and its count is wrong in the direction that makes a clerk stop trusting it.
   */
  it("ignores rows from days that have already passed", async () => {
    mount([], {
      rebooking: [
        appointment({ id: "old", status: "needs_rebooking", serviceDate: "2026-08-01", patient: summary("p-9", "Last Month", "9000000000") }),
        appointment({ id: "now", status: "needs_rebooking", serviceDate: TOMORROW, patient: summary("p-2", "Lakshmi Prasad", "9835120114") }),
      ],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("1 patient"); });
    const rail = within(screen.getByTestId("rebooking-rail"));
    expect(rail.queryByText("Last Month")).not.toBeInTheDocument();
  });

  /** A rail with nothing in it says so, rather than showing an empty box a clerk has to interpret. */
  it("says plainly when nothing needs moving", async () => {
    mount([]);
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("none"); });
    /*
      SCOPED TO THE RAIL, and the first version was not — which found a small duplication worth
      fixing rather than asserting around: the dock's idle line ALSO said "Nothing needs moving",
      so the screen told a clerk the same thing twice in two registers a few centimetres apart. The
      dock now says what IT can see; the rail says what there is to do.
    */
    expect(within(screen.getByTestId("rebooking-rail")).getByText(/Nothing needs moving/i)).toBeInTheDocument();
  });

  /**
   * THE DOCK OFFERS THE ONE ACTION THE SCREEN CAN ACTUALLY DO — and only when there is something to
   * do. A permanently-present "Draft the calls" button on a quiet day is the keycap-that-lies rule
   * wearing a different hat.
   */
  it("offers to draft the calls only when there are calls, and drafts name, number and lost time", async () => {
    mount([]);
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("none"); });
    expect(screen.queryByTestId("agent-action")).not.toBeInTheDocument();
  });
});

describe("FD-25: the slot board — three states that must look like three states", () => {
  it("renders free, taken and picked as distinct chips, and refuses a click on a taken one", async () => {
    mount([]);
    await arrive();
    await waitFor(() => { expect(screen.getAllByTestId("slot-free").length).toBeGreaterThan(0); });

    expect(screen.getAllByTestId("slot-free")).toHaveLength(2);
    expect(screen.getAllByTestId("slot-taken")).toHaveLength(1);
    expect(screen.getByTestId("slot-taken")).toBeDisabled();

    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getAllByTestId("slot-free")[0]!);
    expect(screen.getByTestId("slot-picked")).toBeInTheDocument();
  });

  /**
   * A CLICK SELECTS, IT DOES NOT BOOK. FD-22's ruling: a booking is a promise about a time and is
   * made deliberately or not at all. This is the assertion that fails if anyone "simplifies" the
   * grid into click-to-book.
   */
  it("picking a slot books nothing until the button is pressed", async () => {
    const posted: { url: string; body: unknown }[] = [];
    mount(posted);
    await arrive();
    await waitFor(() => { expect(screen.getAllByTestId("slot-free").length).toBeGreaterThan(0); });

    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getAllByTestId("slot-free")[0]!);
    expect(posted).toHaveLength(0);
    /* …and the button says what it will do, rather than "Confirm". */
    expect(screen.getByTestId("confirm-slot")).toHaveTextContent(/Book .* with Dr Meera Iyer/);
  });

  it("says WHY the board is empty — no session is a different answer from fully booked", async () => {
    mount([]);
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("appt-doctor")).toBeInTheDocument(); });
    /* The fixture has slots, so neither empty-state is showing — the guard on the guard. */
    expect(screen.queryByTestId("no-session")).not.toBeInTheDocument();
    expect(screen.queryByTestId("day-full")).not.toBeInTheDocument();
  });

  /** The room is a FACT about the schedule, never a choice — a picker here books a doctor into a room they are not in. */
  it("shows the room the schedule puts the doctor in, and offers no way to change it", async () => {
    mount([]);
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("appt-room")).toHaveTextContent("OPD-1 · Ground"); });
    expect(screen.getByTestId("appt-room").tagName).not.toBe("SELECT");
  });
});

describe("FD-25: the day's book", () => {
  /**
   * ═══ THE MISSED ROW THAT WOULD HAVE BEEN PERMANENTLY INVISIBLE ═══
   *
   * The no-show sweep never touches today, so a screen deriving "missed" from the status shows zero
   * missed rows on the one day the desk can still act. Both the pill and the row come from one
   * function, so this asserts them together — a count that disagreed with the list beneath it is
   * the badge-contradicts-its-heading defect a screenshot caught on `/registration`.
   */
  it("counts and marks a booking whose slot has passed as MISSED, though its status still says booked", async () => {
    mount([], {
      book: [
        appointment({ id: "gone", serviceDate: TODAY, slotStart: `${TODAY}T03:20:00.000Z`, slotEnd: `${TODAY}T03:30:00.000Z` }),
        appointment({ id: "later", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` }),
      ],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("book-row-gone")).toBeInTheDocument(); });

    expect(screen.getByTestId("state-gone")).toHaveTextContent("missed");
    expect(screen.getByTestId("state-later")).toHaveTextContent("booked");
    expect(screen.getByTestId("count-missed")).toHaveTextContent("1 missed");
    expect(screen.getByTestId("count-to-arrive")).toHaveTextContent("1 to arrive");
  });

  /** A missed row offers a Rebook and NOT a Check in; a booked row the reverse. */
  it("offers the action that matches the row's state, and nothing else", async () => {
    mount([], {
      book: [
        appointment({ id: "gone", serviceDate: TODAY, slotStart: `${TODAY}T03:20:00.000Z`, slotEnd: `${TODAY}T03:30:00.000Z` }),
        appointment({ id: "later", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` }),
      ],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("book-row-gone")).toBeInTheDocument(); });

    expect(screen.getByTestId("rebook-row-gone")).toBeInTheDocument();
    expect(screen.queryByTestId("checkin-gone")).not.toBeInTheDocument();
    expect(screen.getByTestId("checkin-later")).toBeInTheDocument();
    expect(screen.queryByTestId("rebook-row-later")).not.toBeInTheDocument();
  });

  /**
   * A CHECKED-IN ROW SHOWS ITS STATE AND NO BUTTON — the artboard is explicit, and the reason is
   * that checking somebody in twice is exactly the error an always-present button invites.
   */
  it("a checked-in row offers no check-in button", async () => {
    mount([], { book: [appointment({ id: "in", status: "checked_in", serviceDate: TODAY })] });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("book-row-in")).toBeInTheDocument(); });
    expect(screen.queryByTestId("checkin-in")).not.toBeInTheDocument();
    expect(screen.getByTestId("state-in")).toHaveTextContent("waiting");
  });

  /**
   * ═══ CHECK-IN IS A DIFFERENT GRANT FROM BOOKING, AND THE BUTTON MUST KNOW ═══
   *
   * `POST /opd/appointments/:id/check-in` is `opd.visits.open`, NOT `opd.appointments.manage`. A
   * clerk who may book and may not check in is a real configuration, and offering them a button
   * that 403s is how a screen teaches its user to distrust it.
   */
  it("hides Check in from a clerk who may book but may not open a visit", async () => {
    mount([], {
      canCheckIn: false,
      book: [appointment({ id: "later", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` })],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("book-row-later")).toBeInTheDocument(); });
    expect(screen.queryByTestId("checkin-later")).not.toBeInTheDocument();
    /* …and the row is still there, still readable. Hiding the action is not hiding the patient. */
    expect(screen.getByTestId("state-later")).toHaveTextContent("booked");
  });

  /** Cancelling needs a REASON — the server requires one, so the screen asks before it can refuse. */
  it("will not cancel without a reason", async () => {
    mount([], {
      book: [appointment({ id: "later", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` })],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("cancel-later")).toBeInTheDocument(); });

    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByTestId("cancel-later"));
    expect(screen.getByTestId("cancel-confirm")).toBeDisabled();
    await user.type(screen.getByTestId("cancel-reason"), "patient rang to cancel");
    expect(screen.getByTestId("cancel-confirm")).toBeEnabled();
  });
});

describe("FD-25: the leave pill, which is why anybody opens this screen on a bad morning", () => {
  it("says no leave is declared when none is", async () => {
    mount([]);
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("leave-pill")).toHaveTextContent(/no leave declared/i); });
  });

  it("names the count when a doctor is away", async () => {
    mount([], { leaves: [{ id: "l-1", doctorId: "doc-1", fromDate: TOMORROW, toDate: TOMORROW, status: "scheduled", reason: "personal" }] });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("leave-pill")).toHaveTextContent(/1 doctor/i); });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 CLOSE, BACKLOG 1 — WHAT EACH BUTTON ACTUALLY PUTS ON THE WIRE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything above this line asserts what the screen SHOWS. Nothing above it asserted what the
 * screen WRITES: the recorder existed, parsed every booking body, and the only question ever asked
 * of it was `expect(posted).toHaveLength(0)` — a negative. So `slotStart: picked` → `all[0].start`,
 * `checkInAppointment(a.id)` → `bookRows[0].id`, a transposed reschedule and a dropped cancel
 * reason all shipped green through sixteen tests, typecheck and lint.
 *
 * Every test below therefore pins the METHOD, the URL and EVERY FIELD THAT CARRIES A DECISION —
 * which patient, which slot, which reason — and each of them was watched failing against a mutant
 * of the line it guards. `toEqual` on the whole body, never `toMatchObject`: a field that should
 * not travel is a decision too.
 *
 * Two of them (`refuses to book…` and the two `drops the held slot…`) are not coverage but repair:
 * they were RED against the tree as it stood, and the fixes they hold are in `appointment.tsx`.
 */
describe("FD-25 close: every write path, and the decision it carries", () => {
  const user = (): ReturnType<typeof userEvent.setup> =>
    userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });

  /** Two rows, both today, both still to come — so both offer Check in AND Cancel. */
  const twoRowBook = [
    appointment({ id: "first", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` }),
    appointment({
      id: "second", serviceDate: TODAY, slotStart: `${TODAY}T06:10:00.000Z`, slotEnd: `${TODAY}T06:20:00.000Z`,
      patientId: "p-3", patient: summary("p-3", "Sunita Kumar"),
    }),
  ];

  /**
   * THE CHIP THAT WAS PRESSED, NOT THE DAY'S FIRST FREE SLOT. Clicking index [1] is the whole
   * point of this test: against index [0] "the chip pressed" and "the first slot on the board" are
   * the same string, and the mutant `slotStart: all[0].start` survives however loudly it is named.
   */
  it("books the patient the rail is showing, into the slot that was actually clicked", async () => {
    mount([]);
    await arrive();
    const u = user();
    await u.type(screen.getByLabelText("Search"), "Ramesh");
    await u.click(await screen.findByRole("button", { name: /Ramesh Kumar/ }));
    await waitFor(() => { expect(screen.getByTestId("rail-name")).toHaveTextContent("Ramesh Kumar"); });
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });

    await u.click(screen.getAllByTestId("slot-free")[1]!);
    expect(screen.getByTestId("slot-picked")).toHaveTextContent("09:50");
    await u.click(screen.getByTestId("confirm-slot"));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/appointments")).toEqual({
      patientId: "p-1", doctorId: "doc-1", slotStart: `${TOMORROW}T04:20:00.000Z`,
    });
  });

  /**
   * ═══ D2: THE BOOKING GOES TO THE CARD, NOT TO SESSION STORAGE ═══
   *
   * The seat kept two ideas of "who": `whoPicked`, the "Booking for" card this rail draws, and the
   * app-wide patient in hand, which survives a route change and is written by three roads that all
   * BLANK the card — arriving from `/counter`, a rebooking-rail row, and a row's Rebook. On every
   * one of them the rail says "Nobody picked yet" while `commit` posted whoever was in storage.
   *
   * The road driven here is the rail row: click Lakshmi's row (takes p-2 in hand, blanks the card),
   * think better of it, press "Stop moving", then book. Before the fix that booked LAKSHMI, and the
   * agent log line names a time and a doctor and no patient, so the desk could not read it back.
   *
   * `/registration` closed the identical hole in its own close pass 2 and the ruling was the same:
   * the write goes to what is on screen, and being wrong in the safe direction costs one search.
   */
  it("refuses to book when the rail is showing nobody, though somebody is still in hand", async () => {
    mount([], {
      rebooking: [appointment({
        id: "r-9", status: "needs_rebooking", serviceDate: TOMORROW,
        patientId: "p-2", patient: summary("p-2", "Lakshmi Prasad", "9835120114"),
      })],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("1 patient"); });

    const u = user();
    await u.click(screen.getByTestId("rebook-r-9"));   // p-2 goes in hand, the card is blanked
    await u.click(screen.getByTestId("cancel-move"));  // …and p-2 is STILL in hand
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();

    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });
    await u.click(screen.getAllByTestId("slot-free")[0]!);
    await u.click(screen.getByTestId("confirm-slot"));

    await waitFor(() => { expect(screen.getByTestId("appt-error")).toHaveTextContent(/Pick the patient first/); });
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);
  });

  /**
   * THE URL IS HALF THE ASSERTION. `rescheduleAppointment(appointmentId, slotStart, doctorId?)`
   * takes three strings, so transposing the first two typechecks and lints clean; it shows up only
   * as the path `/api/opd/appointments/2026-09-06T04%3A20%3A00.000Z/reschedule`, which `callsTo`
   * on the `r-9` path counts as zero. The body half kills a dropped `doctorId` and a wrong slot.
   */
  it("moves the appointment it was told to move, to the slot that was clicked", async () => {
    const moved = appointment({
      id: "r-9", status: "needs_rebooking", serviceDate: TOMORROW,
      patientId: "p-2", patient: summary("p-2", "Lakshmi Prasad", "9835120114"),
    });
    mount([], {
      rebooking: [moved],
      routes: {
        "POST /api/opd/appointments/r-9/reschedule": {
          from: moved, to: appointment({ id: "r-10", slotStart: `${TOMORROW}T04:20:00.000Z` }),
        },
      },
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("1 patient"); });

    const u = user();
    await u.click(screen.getByTestId("rebook-r-9"));
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });
    await u.click(screen.getAllByTestId("slot-free")[1]!);
    await u.click(screen.getByTestId("confirm-move"));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/appointments/r-9/reschedule")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/appointments/r-9/reschedule")).toEqual({
      slotStart: `${TOMORROW}T04:20:00.000Z`, doctorId: "doc-1",
    });
  });

  /**
   * TWO ROWS ARE STRUCTURALLY REQUIRED, and this is the same shape as the finding itself. With one
   * row `bookRows[0].id === a.id`, so the mutant "check in the first row in the book" passes a
   * one-row test whatever the test is called. `bookOrder` ranks both booked rows 0 and sorts by
   * `slotStart`, so `first` is index 0 and `second` is the one the clerk presses.
   */
  it("checks in the row whose button was pressed, not the first row in the book", async () => {
    mount([], {
      book: twoRowBook,
      routes: {
        "POST /api/opd/appointments/first/check-in": { tokenNo: 3, roomId: "r-1", visitType: "new", encounter: { id: "enc-3", visitNo: "V2609050003" } },
        "POST /api/opd/appointments/second/check-in": { tokenNo: 4, roomId: "r-1", visitType: "new", encounter: { id: "enc-4", visitNo: "V2609050004" } },
      },
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("checkin-second")).toBeInTheDocument(); });

    await user().click(screen.getByTestId("checkin-second"));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/appointments/second/check-in")).toHaveLength(1); });
    /* The half that kills the mutant: the OTHER row was not touched. */
    expect(callsTo("POST", "/api/opd/appointments/first/check-in")).toHaveLength(0);
    expect(screen.queryByTestId("row-error-second")).not.toBeInTheDocument();
  });

  /**
   * THE PADDED REASON IS DELIBERATE. `toEqual({ reason: "patient rang to cancel" })` is what pins
   * `reason.trim()` at the call site rather than the raw input value — the server refuses a blank
   * reason, and "   " is a blank reason that looks like text. The existing "will not cancel without
   * a reason" test stays: it guards the disabled flip, which is a different claim from this one.
   */
  it("cancels the row whose button was pressed, and sends the typed reason trimmed", async () => {
    mount([], {
      book: twoRowBook,
      routes: {
        "POST /api/opd/appointments/first/cancel": { appointment: appointment({ id: "first", status: "cancelled" }) },
        "POST /api/opd/appointments/second/cancel": { appointment: appointment({ id: "second", status: "cancelled" }) },
      },
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("cancel-second")).toBeInTheDocument(); });

    const u = user();
    await u.click(screen.getByTestId("cancel-second"));
    await u.type(screen.getByTestId("cancel-reason"), "  patient rang to cancel  ");
    await u.click(screen.getByTestId("cancel-confirm"));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/appointments/second/cancel")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/appointments/second/cancel")).toEqual({ reason: "patient rang to cancel" });
    expect(callsTo("POST", "/api/opd/appointments/first/cancel")).toHaveLength(0);
  });

  /**
   * ═══ D1: A HELD SLOT DIES WITH THE DAY IT BELONGED TO ═══
   *
   * The rebooking-rail row moves the doctor AND the day in one click. Every other road that moves
   * the board clears the held slot — the doctor select, the date input, "Stop moving" — and this
   * one did not, so a slot held for one doctor-day survived into a move aimed at another. The grid
   * cannot highlight a start it is not rendering, so nothing on screen said it was still held,
   * while `commit` posts `picked` and never `date`: the server derives `serviceDate` FROM the slot
   * it is handed, so when the new doctor happens to sit that clock time the move lands silently on
   * the wrong day, and when they do not the clerk gets a refusal for a slot the board never offered.
   *
   * FIXTURE HONESTY, said out loud because the test's name could be read as more than it proves:
   * `GET /api/opd/slots` is stubbed date-BLIND, so after the board jumps to 08-Sep it still returns
   * 06-Sep starts and the held slot is still findable on it. That is deliberate — it models the
   * WORST case, the one where both days carry the same clock time and the server accepts silently —
   * and it is what makes this assertion discriminate: nothing but clearing the pick can satisfy it.
   */
  it("drops the held slot when the clerk switches to moving somebody on another day", async () => {
    mount([], {
      rebooking: [appointment({
        id: "r-9", status: "needs_rebooking", serviceDate: "2026-09-08",
        slotStart: "2026-09-08T04:00:00.000Z", slotEnd: "2026-09-08T04:10:00.000Z",
        patientId: "p-2", patient: summary("p-2", "Lakshmi Prasad", "9835120114"),
      })],
    });
    await arrive();
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });

    const u = user();
    await u.click(screen.getAllByTestId("slot-free")[0]!);   // 09:30 on 06-Sep, held for somebody else
    expect(screen.getByTestId("slot-picked")).toBeInTheDocument();

    await u.click(screen.getByTestId("rebook-r-9"));         // the board jumps to Dr Iyer / 08-Sep
    expect(screen.getByTestId("appt-date")).toHaveValue("2026-09-08");
    /*
      Wait for the NEW board before judging, and gate on the TAKEN chip: it is the one chip whose
      testid does not depend on what is held, so it settles the query without pre-judging the very
      thing under test. A board still pending would satisfy every assertion below for the wrong
      reason — the vacuous pass this whole item is about.
    */
    await waitFor(() => { expect(screen.getAllByTestId("slot-taken")).toHaveLength(1); });
    expect(screen.queryByTestId("slot-picked")).not.toBeInTheDocument();
    expect(screen.getByTestId("confirm-move")).toBeDisabled();
    expect(screen.getByTestId("confirm-move")).toHaveTextContent("Pick a time first");
  });

  /**
   * THE SECOND ROAD INTO THE SAME RULE, and it needs its own test because the two handlers are
   * independent: a fix applied to the rail row leaves a row's Rebook reachable. This lane's close
   * pass 2 found five of six fixes closing an instance rather than a rule, which is exactly what a
   * shared test would have hidden here.
   *
   * Honest about what this one is: the day's-book Rebook changes neither doctor nor day, so the
   * held slot stays visible and the button names it. No wrong-day write is reachable on this road —
   * this pins the consistency (a new move starts with nothing held, as Desk One's move does), at a
   * cost of one re-click.
   */
  it("a row's Rebook drops the held slot too", async () => {
    mount([], {
      book: [appointment({ id: "gone", serviceDate: TODAY, slotStart: `${TODAY}T03:20:00.000Z`, slotEnd: `${TODAY}T03:30:00.000Z` })],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebook-row-gone")).toBeInTheDocument(); });
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });

    const u = user();
    await u.click(screen.getAllByTestId("slot-free")[0]!);
    expect(screen.getByTestId("slot-picked")).toBeInTheDocument();

    await u.click(screen.getByTestId("rebook-row-gone"));
    expect(screen.getByTestId("moving-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("slot-picked")).not.toBeInTheDocument();
    expect(screen.getByTestId("confirm-move")).toBeDisabled();
    expect(screen.getByTestId("confirm-move")).toHaveTextContent("Pick a time first");
  });

  /**
   * ═══ D1 AS A RULE, NOT AS TWO HANDLERS: YOU MAY ONLY COMMIT A SLOT THE BOARD IS OFFERING ═══
   *
   * Clearing the pick on the two roads that exist today closes today's two roads. The rule survives
   * a road nobody has written yet, and it is reached WITHOUT either of those handlers: hold 09:50,
   * check somebody in — which refreshes the board — and discover another clerk took 09:50 while it
   * was held. The pick is untouched by that road, so only resolving it against the board being
   * shown can disable the button; before the fix it stayed live and read "Book 09:50 with Dr Meera
   * Iyer" for a chip the same screen was drawing as taken.
   *
   * This is the sibling booking stage's rule (`desk-one/stages.tsx`, `all.find((x) => x.start ===
   * picked)`) that this seat was built without.
   */
  it("will not commit a slot the board has stopped offering", async () => {
    let taken = false;
    mount([], {
      book: [appointment({ id: "later", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` })],
      routes: {
        "GET /api/opd/slots": () => ({
          slots: taken ? SLOTS.map((s) => (s.start === `${TOMORROW}T04:20:00.000Z` ? { ...s, booked: true } : s)) : SLOTS,
        }),
        "POST /api/opd/appointments/later/check-in": { tokenNo: 5, roomId: "r-1", visitType: "new", encounter: { id: "enc-5", visitNo: "V2609050005" } },
      },
    });
    await arrive();
    const u = user();
    /*
      A PATIENT IS PICKED FIRST, AND THAT IS LOAD-BEARING. The Ctrl+Enter assertion at the foot of
      this test has to reach the SLOT rule, and `commit` refuses a booking with no patient on the
      card before it ever looks at the slot. Without this the keyboard road would be stopped by the
      wrong guard and the assertion would pass whatever the slot rule did — measured, not assumed:
      it did exactly that until the patient was added.
    */
    await u.type(screen.getByLabelText("Search"), "Ramesh");
    await u.click(await screen.findByRole("button", { name: /Ramesh Kumar/ }));
    await waitFor(() => { expect(screen.getByTestId("rail-name")).toHaveTextContent("Ramesh Kumar"); });
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });

    await u.click(screen.getAllByTestId("slot-free")[1]!);
    expect(screen.getByTestId("confirm-slot")).toHaveTextContent(/Book 09:50 with Dr Meera Iyer/);

    /* Somebody else takes 09:50, and the check-in's refresh is what brings the news. */
    taken = true;
    await u.click(screen.getByTestId("checkin-later"));
    await waitFor(() => { expect(screen.getAllByTestId("slot-taken")).toHaveLength(2); });

    expect(screen.getByTestId("confirm-slot")).toBeDisabled();
    expect(screen.getByTestId("confirm-slot")).toHaveTextContent("Pick a time first");

    /*
      AND THE GUARD LIVES IN `commit`, NOT ONLY ON THE BUTTON. Ctrl+Enter reaches `commit` through
      a window keydown listener and never consults the `disabled` attribute, so a rule enforced only
      in the affordance is a rule with a door left open. Reverting either half turns this test red,
      which is the point of asserting both.
    */
    await u.keyboard("{Control>}{Enter}{/Control}");
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 CLOSE PASS 2 — THE GUARDS ADDED WITHOUT AN ESCAPE, AND THE BOARD THAT KEPT LYING
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything above this line was written against the screen as it was. An independent read of the
 * fixes above found that two of them closed a road and left the clerk standing in it:
 *
 *   · `commit` now books `whoPicked`, the card the rail draws — and NOTHING on the screen could
 *     clear that card. The header's "Back to the search box / Esc" and the Escape key both reached
 *     for `pickerRef.current`, which is null exactly when there is a card to leave, so both were
 *     no-ops for the whole time a patient was picked. A clerk who picked the wrong Ramesh Kumar of
 *     two had no road back except a reload.
 *
 *   · The confirm button and the caption were moved onto the RESOLVED slot (`held`) and the slot
 *     board was not, so a slot the board had stopped offering was still painted with the legend's
 *     "yours" — solid green, white, bold, `aria-pressed="true"` — beside a button reading "Pick a
 *     time first". `data-testid` puts `unavailable` first, which is why the testid said `taken`
 *     while the pixels said `yours`, and why the test above could not see it.
 *
 * Both are the same mistake in two places: a rule enforced at one consumer and not at the others.
 * The repairs make ONE definition each — `backToSearch` decides what "back to the search box"
 * means for both affordances, and the board reads the same `held` the button reads.
 */
describe("FD-25 close pass 2: a guard the clerk can get out of, and a board that cannot lie", () => {
  const user = (): ReturnType<typeof userEvent.setup> =>
    userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });

  /** The search-and-pick that puts a card in the rail — three lines, used by most tests below. */
  async function pickRamesh(u: ReturnType<typeof userEvent.setup>): Promise<void> {
    await u.type(screen.getByLabelText("Search"), "Ramesh");
    await u.click(await screen.findByRole("button", { name: /Ramesh Kumar/ }));
    await waitFor(() => { expect(screen.getByTestId("rail-name")).toHaveTextContent("Ramesh Kumar"); });
  }

  /** What `PatientStrip` needs to resolve the id it is handed — it reads the patient live, by design. */
  const stripRoute = {
    "GET /api/patients/p-1": {
      patient: {
        id: "p-1", uhid: "U00110012", name: "Ramesh Kumar",
        administrativeGender: "male", isConfidential: false, alias: null,
      },
    },
  };

  /**
   * HOLD 09:50, THEN LOSE IT — the board changing under a held slot, which is the one road into the
   * `held` rule that no handler on this screen controls.
   *
   * "will not commit a slot the board has stopped offering" above builds the same state inline and
   * is deliberately left doing so: its claim is about the WRITE, these two are about the PAINT and
   * the MESSAGE, and one test that fails for three reasons names none of them.
   */
  async function holdASlotThatIsThenTaken(): Promise<ReturnType<typeof userEvent.setup>> {
    let taken = false;
    mount([], {
      book: [appointment({ id: "later", serviceDate: TODAY, slotStart: `${TODAY}T06:00:00.000Z`, slotEnd: `${TODAY}T06:10:00.000Z` })],
      routes: {
        "GET /api/opd/slots": () => ({
          slots: taken ? SLOTS.map((s) => (s.start === `${TOMORROW}T04:20:00.000Z` ? { ...s, booked: true } : s)) : SLOTS,
        }),
        "POST /api/opd/appointments/later/check-in": { tokenNo: 5, roomId: "r-1", visitType: "new", encounter: { id: "enc-5", visitNo: "V2609050005" } },
      },
    });
    await arrive();
    const u = user();
    await pickRamesh(u);
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });
    await u.click(screen.getAllByTestId("slot-free")[1]!);
    expect(screen.getByTestId("confirm-slot")).toHaveTextContent(/Book 09:50 with Dr Meera Iyer/);
    /* Somebody else takes 09:50, and the check-in's refresh is what brings the news. */
    taken = true;
    await u.click(screen.getByTestId("checkin-later"));
    await waitFor(() => { expect(screen.getAllByTestId("slot-taken")).toHaveLength(2); });
    return u;
  }

  /**
   * ═══ FREE, TAKEN AND YOURS ARE THREE DIFFERENT THINGS ═══
   *
   * `slot-board.tsx`'s own header forbids exactly this state, and the reason is written there: *"a
   * greyed slot that might be either is how a desk double-books"*. The chip is asserted through
   * `aria-pressed` AND through the style it was given, because they fail differently — the first is
   * what a screen reader announces, the second is what the clerk who promised 09:50 is looking at.
   */
  it("stops drawing a slot as YOURS the moment the board stops offering it", async () => {
    await holdASlotThatIsThenTaken();
    const chip = screen.getByText("09:50");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("style") ?? "").not.toContain("var(--green)");
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * A REFUSAL A CLERK CANNOT EXPLAIN IS THE DEFECT, NOT THE REFUSAL. `commit` returned before it
   * set anything, so the keyboard road — the only road left once the button greys — produced no
   * banner, no log line and no change on screen at all. Pressing a key the button advertises and
   * getting nothing is how a desk learns the seat is broken.
   */
  it("says why Ctrl+Enter refused, rather than doing nothing at all", async () => {
    const u = await holdASlotThatIsThenTaken();
    await u.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByTestId("appt-error")).toHaveTextContent(/Pick a time first/);
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);
  });

  /**
   * ═══ THE POSITIVE CONTROL THE ABSENCE ASSERTIONS NEED ═══
   *
   * Two tests in this file now end in `expect(callsTo(…)).toHaveLength(0)` after a Ctrl+Enter, and
   * zero POSTs is also what a DEAD keyboard road produces. Nothing else in the file touches the
   * window listener, so without this the suite could not tell "the guard in `commit` held" from
   * "the key never reached `commit`" — and a later hardening that scoped the listener would leave
   * every one of them green while the keycap on the button became a lie.
   *
   * Proved by mutation, not by revert: deleting the `else if (e.key === "Enter" …)` branch turns
   * THIS test red, which is the whole of its job.
   */
  it("books through Ctrl+Enter, so the refusals above are refusals and not a dead road", async () => {
    mount([]);
    await arrive();
    const u = user();
    await pickRamesh(u);
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });
    await u.click(screen.getAllByTestId("slot-free")[1]!);

    await u.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => { expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/appointments")).toEqual({
      patientId: "p-1", doctorId: "doc-1", slotStart: `${TOMORROW}T04:20:00.000Z`,
    });
  });

  /**
   * ═══ THE HEADER BUTTON PROMISES A ROAD BACK. IT HAS TO BE ONE. ═══
   *
   * It renders unconditionally, with an `Esc` keycap on it, and it did nothing whenever a card was
   * showing — which is the only state a clerk would press it in.
   */
  it("the header's back-to-search clears the card, so the wrong patient can be put down", async () => {
    mount([]);
    await arrive();
    const u = user();
    await pickRamesh(u);

    await u.click(screen.getByTestId("focus-search"));

    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("rail-name")).not.toBeInTheDocument();
  });

  /** …and the card carries the same road where the clerk's eye actually is: on the rail. */
  it("the card carries its own way out", async () => {
    mount([]);
    await arrive();
    const u = user();
    await pickRamesh(u);

    await u.click(screen.getByTestId("rail-clear-patient"));

    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("rail-name")).not.toBeInTheDocument();
  });

  /**
   * THE KEYMAP'S TWO-STEP, WHICH COULD NOT REACH ITS SECOND STEP. Once returns the cursor, twice
   * puts the patient down. With a card showing there was no cursor to return and no release either;
   * the first Escape now clears the card (the picker remounts autofocused in its place) and the
   * second, with the cursor in that box, releases. `patient-strip` is the app-wide fact: it renders
   * only while somebody is in hand, so its disappearance is the release, observed from outside.
   */
  it("Escape clears the card, and Escape again puts the patient down", async () => {
    mount([], { routes: stripRoute });
    await arrive();
    const u = user();
    await pickRamesh(u);
    await waitFor(() => { expect(screen.getByTestId("patient-strip")).toBeInTheDocument(); });

    await u.keyboard("{Escape}");
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveFocus();
    /* Step one is not a release — the patient is still in hand, which is what makes it a two-step. */
    expect(screen.getByTestId("patient-strip")).toBeInTheDocument();

    await u.keyboard("{Escape}");
    await waitFor(() => { expect(screen.queryByTestId("patient-strip")).not.toBeInTheDocument(); });
  });

  /**
   * ═══ RELEASE IS AN APP-WIDE CONTROL AND THIS SEAT HAD STOPPED LISTENING TO IT ═══
   *
   * `PatientStrip`'s Release clears the patient in hand and nothing else. Before the booking moved
   * to the card that was harmless — the write read the same in-hand id, so releasing made the write
   * refuse. Now the card is what gets booked, so a clerk who presses Release watches the strip
   * vanish while the rail goes on offering to book the person she just put down.
   *
   * The two are set together by the picker; they are cleared together now.
   */
  it("releasing the patient in the strip clears the card that would otherwise still be booked", async () => {
    mount([], { routes: stripRoute });
    await arrive();
    const u = user();
    await pickRamesh(u);

    await u.click(screen.getByTestId("strip-release"));

    await waitFor(() => { expect(screen.getByTestId("rail-empty")).toBeInTheDocument(); });
    expect(screen.queryByTestId("rail-name")).not.toBeInTheDocument();
  });

  /**
   * ═══ A MOVE IS ARMED FOR A NAMED PATIENT; THE RAIL SAID "NOBODY PICKED YET" ═══
   *
   * Both move roads take the patient in hand and blank the card, so the rail fell back to its empty
   * state — heading "Booking for", the words "Nobody picked yet", and a live autofocused picker.
   * Typing a name there took SOMEBODY ELSE in hand, under a banner and a button that both still
   * named Lakshmi, while `commit`'s move branch reschedules `moving.id` and never reads the card.
   */
  it("names the patient a move is for, instead of a picker that would take somebody else in hand", async () => {
    mount([], {
      rebooking: [appointment({
        id: "r-9", status: "needs_rebooking", serviceDate: TOMORROW,
        patientId: "p-2", patient: summary("p-2", "Lakshmi Prasad", "9835120114"),
      })],
    });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("rebooking-count")).toHaveTextContent("1 patient"); });

    await user().click(screen.getByTestId("rebook-r-9"));

    expect(screen.getByTestId("rail-moving")).toHaveTextContent("Lakshmi Prasad");
    expect(screen.queryByTestId("rail-empty")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
  });

  /**
   * ═══ THE HANDOVER ROAD, PINNED RATHER THAN REPAIRED ═══
   *
   * Arriving from another seat with a patient in hand is the one road where the strip and the rail
   * disagree on purpose: the strip names Ramesh at the top of the screen and the rail says nobody
   * is picked, because this seat books what it is SHOWING. That is `/registration`'s ruling applied
   * here and it is the safe direction — being wrong costs one search.
   *
   * No test in this file arrived with a patient in hand (`beforeEach` clears sessionStorage), so
   * the road was invisible to the suite in both directions: neither the refusal nor a future repair
   * would have been noticed. This pins today's behaviour so that changing it is a decision.
   */
  it("a patient handed over from another seat is named by the strip and still not booked by this seat", async () => {
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "p-1", encounterId: null }));
    mount([], { routes: stripRoute });
    await arrive();
    await waitFor(() => { expect(screen.getByTestId("strip-label")).toHaveTextContent("Ramesh Kumar"); });
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();

    const u = user();
    await waitFor(() => { expect(screen.getAllByTestId("slot-free")).toHaveLength(2); });
    await u.click(screen.getAllByTestId("slot-free")[0]!);
    await u.click(screen.getByTestId("confirm-slot"));

    await waitFor(() => { expect(screen.getByTestId("appt-error")).toHaveTextContent(/Pick the patient first/); });
    expect(callsTo("POST", "/api/opd/appointments")).toHaveLength(0);
  });
});
