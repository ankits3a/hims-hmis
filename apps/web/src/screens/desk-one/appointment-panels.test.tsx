import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import "../../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-16 — THE APPOINTMENT SCREEN'S THREE MISSING PANELS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04, against the "Three Seats, One Desk" artboard's `/appointment`:
 *
 *   *"look at the left sidebar. It shows 'Their History' … I want to have it."*
 *   *"the main panel shows slot booking coloring, free slot, not free slot. Color of the selected
 *   slot and a confirmation button."*
 *   *"I want panel to shows list of patient that have booked slot on that future date."*
 *
 * All three reads ALREADY EXISTED on the server and none had a caller:
 * `GET /opd/patients/:id/timeline` (07a, gated `opd.visits.read` which front_office holds) and
 * `GET /opd/appointments?doctorId&serviceDate`. That is the fourth and fifth built-and-unwired rail
 * this lane has found, which is why these tests drive the SCREEN — a route with no caller passes
 * every server test it has.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

/** Tomorrow in IST — the date the tab opens on, so the fixtures line up with what it asks for. */
function tomorrowIst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
    .format(new Date(Date.now() + 86_400_000));
}

function slot(hhmm: string, opts: { booked?: boolean; past?: boolean } = {}): unknown {
  const [h, m] = hhmm.split(":");
  return {
    start: `${tomorrowIst()}T${h!}:${m!}:00.000Z`,
    end: `${tomorrowIst()}T${h!}:${String(Number(m) + 15).padStart(2, "0")}:00.000Z`,
    booked: opts.booked ?? false,
    past: opts.past ?? false,
  };
}

function mount(opts: {
  timeline?: unknown[];
  slots?: unknown[];
  appointments?: unknown[];
  booked?: { body: unknown }[];
  anchor?: unknown;
  theirs?: unknown[];
  checkIns?: string[];
  moves?: { slotStart: string; doctorId?: string }[];
  cancels?: { reason: string }[];
  checkInRefuses?: boolean;
  emptyBoard?: boolean;
} = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: [
          "opd.visits.open", "opd.visits.read", "opd.appointments.read", "opd.appointments.manage",
          "patients.register", "patients.update", "billing.invoice.issue", "membership.instrument.recognise",
        ],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
    "GET /api/patients/p-1/photo": (): unknown => { throw new Error("no photo"); },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/patients/p-1/timeline": { items: opts.timeline ?? [] },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Cardiology", code: "CARD" }] },
    /*
      FD-22 — the future tab reads the doctor MASTER, not today's queue summary: a doctor who is not
      sitting today must still be bookable for next week. That was the bug the owner's "where is the
      department dropdown" question uncovered.
    */
    "GET /api/opd/doctors": {
      items: [{
        id: "doc-1", userId: "u-doc", displayName: "Dr. Verma", registrationNo: null,
        departmentId: "d-1", specialty: null, active: true,
        createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
      }],
    },
    "GET /api/opd/queues/summary": opts.emptyBoard === true ? { items: [] } : {
      items: [{
        doctor: {
          id: "doc-1", userId: "u-doc", displayName: "Dr. Verma", registrationNo: null,
          departmentId: "d-1", specialty: null, active: true,
          createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
        },
        sessionId: "s-1", status: "open", waitingCount: 1, waitingVitalsCount: 0, nowServing: null,
        scheduledToday: true, roomCode: "R1", avgConsultMinutes: 10, onLeaveToday: false,
      }],
    },
    "GET /api/opd/continuity": { anchor: opts.anchor ?? null },
    "GET /api/opd/slots": { slots: opts.slots ?? [] },
    /*
      Two different reads land on this path — the DAY's book (doctorId + serviceDate) and THIS
      PATIENT's bookings (patientId + status). `stubFetch` keys on the path without its query, so
      one handler answers both and branches on what was asked for.
    */
    "POST /api/opd/appointments/11/check-in": (): unknown => {
      if (opts.checkInRefuses === true) throw new Error("appointment is for 2026-09-05, not 2026-09-04");
      opts.checkIns?.push("11");
      return {
        encounter: { id: "e-2", patientId: "pp-11", visitNo: "V2", departmentId: "d-1", doctorId: "doc-1", status: "registered" },
        queueEntry: { id: "q-2", tokenNo: 3 }, tokenNo: 3, sessionId: "s-1", roomId: null,
        visitType: "new", doctorScheduledToday: true,
      };
    },
    "POST /api/opd/appointments/11/cancel": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as { reason: string };
      opts.cancels?.push(b);
      return { appointment: { id: "11", status: "cancelled" } };
    },
    "POST /api/opd/appointments/11/reschedule": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as { slotStart: string; doctorId?: string };
      opts.moves?.push(b);
      return { from: { id: "11" }, to: { id: "11", slotStart: b.slotStart } };
    },
    "GET /api/opd/appointments": (init?: RequestInit, url?: string) => (
      String(url ?? "").includes("patientId=")
        ? { items: opts.theirs ?? [] }
        : { items: opts.appointments ?? [] }
    ),
    "POST /api/opd/appointments": (init?: RequestInit) => {
      opts.booked?.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return {
        appointment: {
          id: "a-new", patientId: "p-1", doctorId: "doc-1", departmentId: "d-1",
          serviceDate: tomorrowIst(), slotStart: `${tomorrowIst()}T10:30:00.000Z`,
          slotEnd: `${tomorrowIst()}T10:45:00.000Z`, status: "booked", source: "desk",
          note: null, encounterId: null, rescheduledToId: null, rescheduledFromId: null,
          cancelReason: null, leaveId: null, bookedBy: "u1", bookedAt: "2026-09-04T00:00:00.000Z",
          updatedBy: "u1", updatedAt: "2026-09-04T00:00:00.000Z",
        },
      };
    },
    "GET /api/billing/session/current": { session: null },
    "GET /api/billing/patients/p-1/dues": { items: [] },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { patientId: "p-1", memberships: [], coupons: [], disclosure: "" },
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/counter"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function holdPatient(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));
  await waitFor(() => expect(screen.getByPlaceholderText(/seene mein dard/)).toBeInTheDocument());
}

async function openFutureTab(): Promise<void> {
  await holdPatient();
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name: /future appointment/i }));
  await waitFor(() => expect(screen.getByText("The day's book")).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

describe("FD-16: Their history, in the left rail", () => {
  const VISIT = {
    encounterId: "e-9", serviceDate: "2026-03-14", openedAt: "2026-03-14T04:00:00.000Z",
    status: "completed", visitType: "walk_in",
    doctorId: "doc-9", doctorName: "Dr. Sharma", departmentId: "d-1", departmentName: "Cardiology",
    diagnosis: "Essential hypertension", icd10Code: "I10",
    prescriptionLineCount: 3, dangerFlagged: false,
  };

  it("lists past visits with when, where and how they ended", async () => {
    mount({ timeline: [VISIT] });
    await holdPatient();

    const rows = await screen.findAllByTestId("history-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("14 Mar");
    expect(rows[0]).toHaveTextContent("Cardiology");
    expect(rows[0]).toHaveTextContent("Sharma");
  });

  /**
   * THE DIAGNOSIS IS ON THE WIRE AND MUST NOT BE ON THIS RAIL.
   *
   * `opd.visits.read` lets the counter READ it, and 07d put prescriptions and vitals behind
   * `opd.consult` precisely because a registration clerk has no reason to. This column faces a
   * queue: a diagnosis here is readable by whoever is standing at the window, which no permission
   * check can prevent. If a future edit renders it, this test is what stops it.
   */
  it("never renders the diagnosis or the ICD code, though the server sends both", async () => {
    mount({ timeline: [VISIT] });
    await holdPatient();
    await screen.findAllByTestId("history-row");

    const rail = document.querySelector("aside.rail");
    expect(rail?.textContent).not.toContain("Essential hypertension");
    expect(rail?.textContent).not.toContain("I10");
  });

  it("says plainly when this is a first visit", async () => {
    mount({ timeline: [] });
    await holdPatient();
    expect(await screen.findByTestId("history-none")).toBeInTheDocument();
  });
});

describe("FD-16: the slot grid says what is free, what is taken, and what you picked", () => {
  it("draws taken slots too — an empty box cannot distinguish a full day from no session", async () => {
    mount({ slots: [slot("09:00"), slot("09:15", { booked: true }), slot("09:30")] });
    await openFutureTab();

    expect(screen.getAllByTestId("slot-free")).toHaveLength(2);
    expect(screen.getAllByTestId("slot-taken")).toHaveLength(1);
    expect(screen.getByTestId("slot-taken")).toBeDisabled();
  });

  it("a full day and a day with no session say different things", async () => {
    mount({ slots: [slot("09:00", { booked: true })] });
    await openFutureTab();
    expect(screen.getByTestId("day-full")).toBeInTheDocument();
    expect(screen.queryByTestId("no-session")).not.toBeInTheDocument();
  });

  it("no session at all is named as such, not shown as a full day", async () => {
    mount({ slots: [] });
    await openFutureTab();
    expect(screen.getByTestId("no-session")).toBeInTheDocument();
    expect(screen.queryByTestId("day-full")).not.toBeInTheDocument();
  });

  /*
    A click used to BOOK. On a dense grid of times that put a promise about a time into the record
    from one mis-aimed click. Now it selects, and a second deliberate act commits.
  */
  it("picking a slot selects it and books nothing until the confirmation is pressed", async () => {
    const booked: { body: unknown }[] = [];
    mount({ slots: [slot("10:30"), slot("10:45")], booked });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getAllByTestId("slot-free")[0]!);
    expect(screen.getByTestId("slot-picked")).toBeInTheDocument();
    expect(booked).toHaveLength(0); // selecting is not booking

    await user.click(screen.getByTestId("confirm-slot"));
    await waitFor(() => expect(booked).toHaveLength(1));
    const body = booked[0]!.body as { patientId: string; doctorId: string; slotStart: string };
    expect(body.patientId).toBe("p-1");
    expect(body.doctorId).toBe("doc-1");
  });

  it("a taken slot cannot be picked at all", async () => {
    const booked: { body: unknown }[] = [];
    mount({ slots: [slot("09:00", { booked: true })], booked });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByTestId("slot-taken"));
    expect(screen.queryByTestId("slot-picked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("confirm-slot")).not.toBeInTheDocument();
    expect(booked).toHaveLength(0);
  });
});

const appt = (id: string, time: string, name: string, status = "booked"): unknown => ({
    id, patientId: `pp-${id}`, doctorId: "doc-1", departmentId: "d-1", serviceDate: tomorrowIst(),
    slotStart: `${tomorrowIst()}T${time}:00.000Z`, slotEnd: `${tomorrowIst()}T${time}:00.000Z`,
    status, source: "desk", note: null, encounterId: null, rescheduledToId: null,
    rescheduledFromId: null, cancelReason: null, leaveId: null, bookedBy: "u1",
    bookedAt: "2026-09-04T00:00:00.000Z", updatedBy: "u1", updatedAt: "2026-09-04T00:00:00.000Z",
  patient: { requestedId: `pp-${id}`, id: `pp-${id}`, uhid: `U0011${id}`, name, alias: null, restricted: false, administrativeGender: "female", dob: null },
});

describe("FD-16: the day's book", () => {

  it("lists who is booked that day, in time order", async () => {
    mount({ appointments: [appt("22", "11:30", "Sunita Devi"), appt("11", "09:15", "Asha Devi")] });
    await openFutureTab();

    const rows = await screen.findAllByTestId("book-row");
    expect(rows).toHaveLength(2);
    // sorted by slot start, not by the order the server happened to return
    expect(rows[0]).toHaveTextContent("Asha Devi");
    expect(rows[1]).toHaveTextContent("Sunita Devi");
    expect(screen.getByTestId("book-count")).toHaveTextContent("2 booked");
  });

  /* Cancelled and no-show rows are not people the desk should expect at that hour. */
  it("leaves out cancelled and no-show bookings", async () => {
    mount({
      appointments: [
        appt("11", "09:15", "Asha Devi"),
        appt("33", "10:00", "Ghost One", "cancelled"),
        appt("44", "10:30", "Ghost Two", "no_show"),
      ],
    });
    await openFutureTab();
    const rows = await screen.findAllByTestId("book-row");
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId("book-count")).toHaveTextContent("1 booked");
  });

  /**
   * A CONFIDENTIAL PATIENT IS RENDERED AS THE SERVER HANDED THEM OVER. `getPatientSummaries` returns
   * `restricted` with an alias and a null name; the screen shows the alias rather than deciding for
   * itself what may be displayed. This list is visible across a counter, which is exactly the
   * surface §14 exists for.
   */
  it("shows a restricted patient by alias and never by name", async () => {
    /*
      `name` IS DELIBERATELY POPULATED HERE, which the server never does — `getPatientSummaries`
      writes `name: restricted ? null : row.name`. That is the point: with a null name, rendering
      `name ?? alias` behaves identically and a mutant swapping the guard for it survives. This
      payload pins the SCREEN'S own guard rather than the server's nulling, so the day's book does
      not silently depend on a coupling nothing here can enforce.
    */
    const row = appt("55", "12:00", "SHOULD NOT APPEAR") as Record<string, unknown>;
    row["patient"] = {
      requestedId: "pp-55", id: "pp-55", uhid: "U001155", name: "SHOULD NOT APPEAR",
      alias: "Staff record", restricted: true, administrativeGender: "female", dob: null,
    };
    mount({ appointments: [row] });
    await openFutureTab();

    const rows = await screen.findAllByTestId("book-row");
    expect(rows[0]).toHaveTextContent("Staff record");
    expect(rows[0]).not.toHaveTextContent("SHOULD NOT APPEAR");
  });

  it("says so when nobody is booked", async () => {
    mount({ appointments: [] });
    await openFutureTab();
    expect(await screen.findByTestId("book-empty")).toBeInTheDocument();
  });
});

describe("FD-17: the appointment's type, and the bookings the desk did not warn about", () => {
  const ANCHOR = (wouldBe: string, days: number, ends: string): unknown => ({
    doctorId: "doc-1", doctorName: "Dr. Verma", seenOn: "2026-08-30",
    followUpDays: days, windowEndsOn: ends, wouldBe,
  });

  /**
   * Owner: *"Usually if the patient is visiting same department under set revisit tenure, the
   * patient would not be charged/billed."* That has always been true — `feeServiceFor` returns null
   * for a revisit — and the clerk could not learn it until after the patient was seated.
   */
  it("says a revisit is free, and names the tenure the doctor set", async () => {
    mount({ anchor: ANCHOR("revisit", 30, "2026-09-29") });
    await holdPatient();

    const badge = await screen.findByTestId("visit-type");
    expect(badge).toHaveTextContent("Revisit — no consultation fee");
    expect(badge).toHaveTextContent("30-day");
    expect(badge).toHaveTextContent("2026-09-29");
  });

  it("says a renewal is chargeable, and why the window no longer covers it", async () => {
    mount({ anchor: ANCHOR("renewal", 7, "2026-09-06") });
    await holdPatient();

    const badge = await screen.findByTestId("visit-type");
    expect(badge).toHaveTextContent("chargeable");
    expect(badge).toHaveTextContent("2026-09-06");
  });

  it("a patient never seen in this department gets no claim either way", async () => {
    mount({ anchor: null });
    await holdPatient();
    expect(screen.queryByTestId("visit-type")).not.toBeInTheDocument();
  });

  /*
    Owner: *"in future appointment, there's no warning for same patient booking another slot in the
    same day."* `listPatientAppointments` — whose own comment calls it "the duplicate-booking
    guard" — had no caller.
  */
  it("warns when this patient already holds a slot that day, and still allows it", async () => {
    const tomorrow = tomorrowIst();
    mount({
      slots: [slot("10:30")],
      theirs: [{
        id: "a-9", patientId: "p-1", doctorId: "doc-1", departmentId: "d-1", serviceDate: tomorrow,
        slotStart: `${tomorrow}T09:15:00.000Z`, slotEnd: `${tomorrow}T09:30:00.000Z`,
        status: "booked", source: "desk", note: null, encounterId: null, rescheduledToId: null,
        rescheduledFromId: null, cancelReason: null, leaveId: null, bookedBy: "u1",
        bookedAt: "2026-09-04T00:00:00.000Z", updatedBy: "u1", updatedAt: "2026-09-04T00:00:00.000Z",
      }],
    });
    await openFutureTab();

    const warn = await screen.findByTestId("already-booked");
    expect(warn).toHaveTextContent("already has 1 booking that day");
    /*
      09:15Z IS 14:45 IST, and asserting the IST face rather than the raw wire string is deliberate:
      it pins that `slotClock` converts. A test that matched "09:15" would pass just as happily if
      the desk printed UTC at an Indian counter.
    */
    expect(warn).toHaveTextContent("14:45");
    // a WARNING, never a gate — two departments in one day is a real thing
    await userEvent.setup({ delay: null }).click(screen.getAllByTestId("slot-free")[0]!);
    expect(screen.getByTestId("confirm-slot")).toBeEnabled();
  });

  it("a booking on ANOTHER day is not a same-day clash", async () => {
    mount({
      slots: [slot("10:30")],
      theirs: [{
        id: "a-8", patientId: "p-1", doctorId: "doc-1", departmentId: "d-1", serviceDate: "2026-12-25",
        slotStart: "2026-12-25T09:15:00.000Z", slotEnd: "2026-12-25T09:30:00.000Z",
        status: "booked", source: "desk", note: null, encounterId: null, rescheduledToId: null,
        rescheduledFromId: null, cancelReason: null, leaveId: null, bookedBy: "u1",
        bookedAt: "2026-09-04T00:00:00.000Z", updatedBy: "u1", updatedAt: "2026-09-04T00:00:00.000Z",
      }],
    });
    await openFutureTab();
    expect(screen.queryByTestId("already-booked")).not.toBeInTheDocument();
  });

  /* `checkInAppointment` was the other client nothing called: a booked patient arriving had no door. */
  it("a booked patient can be checked in from the day's book", async () => {
    const checkIns: string[] = [];
    mount({ appointments: [appt("11", "09:15", "Asha Devi")], checkIns });
    await openFutureTab();

    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByTestId("check-in-11"));
    await waitFor(() => expect(checkIns).toEqual(["11"]));
  });

  it("a patient already checked in is not offered check-in again", async () => {
    mount({ appointments: [appt("11", "09:15", "Asha Devi", "checked_in")] });
    await openFutureTab();
    await screen.findAllByTestId("book-row");
    expect(screen.queryByTestId("check-in-11")).not.toBeInTheDocument();
  });
});

describe("FD-19: editing a future booking from the desk", () => {
  const tomorrow = tomorrowIst();
  const theirBooking = {
    id: "11", patientId: "p-1", doctorId: "doc-1", departmentId: "d-1", serviceDate: tomorrow,
    slotStart: `${tomorrow}T09:15:00.000Z`, slotEnd: `${tomorrow}T09:30:00.000Z`,
    status: "booked", source: "desk", note: null, encounterId: null, rescheduledToId: null,
    rescheduledFromId: null, cancelReason: null, leaveId: null, bookedBy: "u1",
    bookedAt: "2026-09-04T00:00:00.000Z", updatedBy: "u1", updatedAt: "2026-09-04T00:00:00.000Z",
  };

  /**
   * Owner, 2026-09-04: *"if patient decides to reschedule the future appointment then the operating
   * system must allow the user to edit the future booking."* `POST /appointments/:id/reschedule` has
   * existed since D7; its only caller was the standalone `/opd/appointments` screen, so the desk —
   * where the patient actually says "can we make it Thursday" — could not do it.
   */
  it("ROUTE 1 — find the patient, see their bookings, move one into a chosen slot", async () => {
    const moves: { slotStart: string; doctorId?: string }[] = [];
    mount({ slots: [slot("10:30")], theirs: [theirBooking], moves });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    // their upcoming bookings are listed beside the diary, no second lookup
    expect(await screen.findByTestId("their-bookings")).toBeInTheDocument();
    await user.click(screen.getByTestId("move-theirs-11"));

    // the grid becomes the picker and says so, so "book" has not silently become "move"
    expect(screen.getByTestId("moving-banner")).toBeInTheDocument();
    await user.click(screen.getAllByTestId("slot-free")[0]!);
    await user.click(screen.getByTestId("confirm-move"));

    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0]!.slotStart).toContain("10:30");
  });

  /* *"Second way is to search the doctor and change the patient schedule from there."* */
  it("ROUTE 2 — find the doctor, move a patient off their day's book", async () => {
    const moves: { slotStart: string; doctorId?: string }[] = [];
    mount({ slots: [slot("10:30")], appointments: [appt("11", "09:15", "Asha Devi")], moves });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(await screen.findByTestId("move-11"));
    await user.click(screen.getAllByTestId("slot-free")[0]!);
    await user.click(screen.getByTestId("confirm-move"));

    await waitFor(() => expect(moves).toHaveLength(1));
    // the doctor travels, which is what makes moving BETWEEN doctors the same call
    expect(moves[0]!.doctorId).toBe("doc-1");
  });

  it("booking is still booking — an unarmed grid does not move anything", async () => {
    const moves: { slotStart: string; doctorId?: string }[] = [];
    const booked: { body: unknown }[] = [];
    mount({ slots: [slot("10:30")], theirs: [theirBooking], moves, booked });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getAllByTestId("slot-free")[0]!);
    expect(screen.getByTestId("confirm-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-move")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-slot"));
    await waitFor(() => expect(booked).toHaveLength(1));
    expect(moves).toHaveLength(0);
  });

  it("changing your mind about moving leaves the booking alone", async () => {
    const moves: { slotStart: string; doctorId?: string }[] = [];
    mount({ slots: [slot("10:30")], theirs: [theirBooking], moves });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByTestId("move-theirs-11"));
    await user.click(screen.getAllByTestId("slot-free")[0]!);
    await user.click(screen.getByTestId("clear-slot"));

    expect(screen.queryByTestId("moving-banner")).not.toBeInTheDocument();
    expect(moves).toHaveLength(0);
  });
});

describe("FD-22: refusals land inline, cancelling confirms, and every doctor is bookable", () => {
  /**
   * Owner, 2026-09-04: *"When I tried to check in from the appointment screen, the error message
   * 'appointment is for 2026-09-05, not 2026-09-04' appeared on top instead of inline. Claude, the
   * error message should always be inline for any screen."*
   *
   * The refusal itself is CORRECT — a booking for the 5th cannot be checked in on the 4th — which
   * makes the placement the only thing wrong with it. The clerk pressed a button beside one
   * patient's name and the answer appeared somewhere else, with nothing tying it to which row.
   */
  it("a refused check-in reports under the row it came from, not in the page banner", async () => {
    mount({ appointments: [appt("11", "09:15", "Asha Devi")], checkInRefuses: true });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(await screen.findByTestId("check-in-11"));

    const inline = await screen.findByTestId("row-error-11");
    expect(inline).toHaveTextContent(/not 2026-09-04/);
    expect(inline).toHaveAttribute("role", "alert");
    // and the page-level banner stays out of it
    expect(screen.queryByText(/The server refused:/)).not.toBeInTheDocument();
  });

  /* *"there's no 'Cancel' button followed by confirm dialog box."* */
  it("cancelling asks first, and takes the reason the server requires", async () => {
    const cancels: { reason: string }[] = [];
    mount({ appointments: [appt("11", "09:15", "Asha Devi")], cancels });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(await screen.findByTestId("cancel-11"));
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Asha Devi");
    expect(cancels).toHaveLength(0); // asking is not cancelling

    await user.type(screen.getByTestId("cancel-reason"), "patient rang to cancel");
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels[0]!.reason).toBe("patient rang to cancel");
  });

  it("a cancellation with no reason is refused inline and nothing is sent", async () => {
    const cancels: { reason: string }[] = [];
    mount({ appointments: [appt("11", "09:15", "Asha Devi")], cancels });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(await screen.findByTestId("cancel-11"));
    await user.click(screen.getByTestId("cancel-confirm-submit"));

    expect(await screen.findByTestId("row-error-11")).toBeInTheDocument();
    expect(cancels).toHaveLength(0);
  });

  it("backing out of the confirmation cancels nothing", async () => {
    const cancels: { reason: string }[] = [];
    mount({ appointments: [appt("11", "09:15", "Asha Devi")], cancels });
    await openFutureTab();
    const user = userEvent.setup({ delay: null });

    await user.click(await screen.findByTestId("cancel-11"));
    await user.click(screen.getByTestId("cancel-abort"));
    expect(screen.queryByTestId("cancel-confirm")).not.toBeInTheDocument();
    expect(cancels).toHaveLength(0);
  });

  /**
   * The owner asked whether the missing department picker was just thin data. Partly — every active
   * doctor in the dev database is in Cardiology — but underneath it the doctor list came from
   * `GET /opd/queues/summary` FOR TODAY, so a doctor not sitting today could not be booked for next
   * week, which is the one thing a future booking is for.
   *
   * `emptyBoard` IS THE WHOLE TEST. A surviving mutant showed the first version proved nothing:
   * the shared fixture puts this doctor on today's board too, so reverting the source to
   * `d.summaries` passed happily. Today's board is empty here and the doctor master is not, which
   * is the only arrangement that can tell the two sources apart.
   */
  it("offers a department picker, and books a doctor who is not on today's board", async () => {
    mount({ slots: [slot("10:30")], emptyBoard: true });
    await openFutureTab();

    expect(screen.getByTestId("book-department")).toBeInTheDocument();
    // the doctor comes from the MASTER, so an empty board does not empty the picker
    expect(screen.getByTestId("book-doctor")).toHaveTextContent("Dr. Verma");
    expect(screen.getAllByTestId("slot-free").length).toBeGreaterThan(0);
  });
});
