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

function mount(
  posted: { url: string; body: unknown }[],
  opts: { rebooking?: unknown[]; book?: unknown[]; leaves?: unknown[]; canCheckIn?: boolean } = {},
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
