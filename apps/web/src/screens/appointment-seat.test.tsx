import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppointmentSeat } from "./appointment-seat";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { todayIst } from "../lib/opd-api";
import type { WireDoctorSummary } from "../lib/opd-api";

/**
 * ═══ FD-7 T2 — THE SEAT, ASSEMBLED ═══
 *
 * `walk-in-routing.test.ts` proves the three rules in isolation and kills eight mutants doing it.
 * This file proves the SCREEN renders what they return — RC-3's lesson, which cost that phase three
 * CRITICALs: every one of them was in the assembly, not in a component that had its own green suite.
 *
 * Two patients in every path that finishes one (D8), and every row asserted as SEPARATE NODES with
 * readable text (D9) — FD-2's 117 tests passed on `Ramesh KumarCRK123450139876543210same name`.
 */
const NOW = new Date("2026-09-03T04:00:00.000Z"); // Thursday 09:30 IST
const TODAY = todayIst(NOW);

const CAN = { actor: { type: "user", id: "u-fd7" }, permissions: { hospital: ["opd.appointments.manage", "opd.visits.open"], scoped: { department: {}, floor: {} } } };
const CANNOT = { actor: { type: "user", id: "u-no" }, permissions: { hospital: ["opd.visits.open"], scoped: { department: {}, floor: {} } } };

function doc(over: {
  id: string; name: string; departmentId?: string; waitingCount?: number; avgConsultMinutes?: number;
  scheduledToday?: boolean; onLeaveToday?: boolean;
}): WireDoctorSummary {
  return {
    doctor: {
      id: over.id, userId: `u-${over.id}`, displayName: over.name, registrationNo: null,
      departmentId: over.departmentId ?? "dept-gm", specialty: null, active: true,
      createdBy: "s", createdAt: "", updatedBy: "s", updatedAt: "",
    },
    sessionId: "s-1", status: "in", waitingCount: over.waitingCount ?? 1, waitingVitalsCount: 0,
    nowServing: 1, scheduledToday: over.scheduledToday ?? true, roomCode: "12",
    avgConsultMinutes: over.avgConsultMinutes ?? 10, onLeaveToday: over.onLeaveToday ?? false,
  };
}

const DR_LONG = doc({ id: "d-long", name: "Dr Long", waitingCount: 6 });    // 60 minutes
const DR_QUICK = doc({ id: "d-quick", name: "Dr Quick", waitingCount: 1 }); // 10 minutes

type Reply = { status: number; body: unknown };
let sent: Record<string, unknown> | null = null;

function mockRoutes(over: Record<string, Reply | ((init?: RequestInit) => Reply)> = {}): void {
  const base: Record<string, Reply> = {
    "GET /api/auth/me": { status: 200, body: CAN },
    "GET /api/opd/queues/summary": { status: 200, body: { items: [DR_LONG, DR_QUICK] } },
    "GET /api/opd/departments": { status: 200, body: { items: [{ id: "dept-gm", name: "General Medicine" }] } },
    "GET /api/opd/continuity": { status: 200, body: { anchor: null } },
    "GET /api/opd/appointments": { status: 200, body: { items: [] } },
    "GET /api/patients/search": { status: 200, body: { items: [] } },
  };
  const table = { ...base, ...over };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    if (init?.body !== undefined && typeof init.body === "string") sent = JSON.parse(init.body) as Record<string, unknown>;
    const entry = table[key];
    if (entry === undefined) return new Response("{}", { status: 404 });
    const reply = typeof entry === "function" ? entry(init) : entry;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

/** The counter puts a patient in hand through this key; the seat is a rendering of it (07b T1). */
function inHand(patientId: string): void {
  sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId, encounterId: null }));
}

beforeEach(() => {
  sessionStorage.clear();
  setToken("test-token");
  sent = null;
});

describe("FD-7 T2 — the appointment seat", () => {
  /** D2 — a clerk without the grant is told so, and gets NO controls to press. */
  it("a caller without opd.appointments.manage sees the refusal and no lane toggle", async () => {
    mockRoutes({ "GET /api/auth/me": { status: 200, body: CANNOT } });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    expect(await screen.findByTestId("appt-forbidden")).toBeTruthy();
    expect(screen.queryByTestId("appt-mode-walkin")).toBeNull();
    expect(screen.queryByTestId("appt-department")).toBeNull();
  });

  /* ── rule 1, on the assembled screen ─────────────────────────────────────────────────────── */

  it("continuity routes the patient back to the LONGER line, names the rule and the date", async () => {
    mockRoutes({
      "GET /api/opd/continuity": { status: 200, body: { anchor: { doctorId: "d-long", doctorName: "Dr Long", seenOn: "2026-07-12" } } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");

    const card = await screen.findByTestId("appt-proposal");
    expect(within(card).getByTestId("appt-proposal-rule").textContent).toBe("Seen here before");
    expect(within(card).getByTestId("appt-proposal-doctor").textContent).toBe("Dr Long");
    expect(within(card).getByTestId("appt-proposal-seen").textContent).toContain("2026-07-12");
  });

  /**
   * THE WAIT IS MINUTES **AND** A CLOCK, both, always — and they are SEPARATE NODES, so a run
   * together of "6 ahead60 minutes" cannot pass this the way FD-2's search row passed 117 tests.
   */
  it("the wait reads as a count, minutes and a clock time, in separate nodes", async () => {
    mockRoutes();
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");

    await screen.findByTestId("appt-proposal");
    expect(screen.getByTestId("appt-wait-ahead").textContent).toContain("1");
    const line = screen.getByTestId("appt-wait-line").textContent ?? "";
    expect(line).toContain("10");           // 1 waiting × 10 minutes
    expect(line).toMatch(/\d{1,2}:\d{2}/);  // and a clock time
  });

  /* ── the owner's 20-minute rule, on the assembled screen ─────────────────────────────────── */

  it("a 60-minute continuity wait is highlighted and names Dr Quick — WITHOUT re-routing", async () => {
    mockRoutes({
      "GET /api/opd/continuity": { status: 200, body: { anchor: { doctorId: "d-long", doctorName: "Dr Long", seenOn: "2026-07-12" } } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");

    const delay = await screen.findByTestId("appt-delay");
    expect(delay.textContent).toContain("60");
    expect(screen.getByTestId("appt-alternative").textContent).toContain("Dr Quick");
    // THE KILL for a silent re-route: the proposal is STILL the doctor who knows them.
    expect(screen.getByTestId("appt-proposal-doctor").textContent).toBe("Dr Long");
    expect(screen.getByTestId("appt-confirm").textContent).toContain("Dr Long");
  });

  it("taking the alternative is the CLERK's act, and it changes who the confirm sends to", async () => {
    mockRoutes({
      "GET /api/opd/continuity": { status: 200, body: { anchor: { doctorId: "d-long", doctorName: "Dr Long", seenOn: "2026-07-12" } } },
      "POST /api/opd/walk-in": { status: 200, body: { patientId: "p-1", registered: false, encounter: { id: "E-1" }, tokenNo: 4, sessionId: "s-1" } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");
    await user.click(await screen.findByTestId("appt-take-alternative"));

    expect(screen.getByTestId("appt-confirm").textContent).toContain("Dr Quick");
    await user.click(screen.getByTestId("appt-confirm"));
    await screen.findByTestId("appt-done");
    expect(sent).toEqual({ patient: { existingId: "p-1" }, departmentId: "dept-gm", doctorId: "d-quick" });
  });

  /* ── rule 3, and the server limit it runs into ───────────────────────────────────────────── */

  it("with nobody sitting it says so and offers NO confirm — a visit cannot be opened without a doctor", async () => {
    mockRoutes({ "GET /api/opd/queues/summary": { status: 200, body: { items: [] } } });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");

    expect(await screen.findByTestId("appt-no-doctor")).toBeTruthy();
    expect(screen.getByTestId("appt-proposal-rule").textContent).toBe("No doctor is sitting");
    expect(screen.queryByTestId("appt-confirm")).toBeNull();
  });

  /** A doctor off today's board drops rule 1 to rule 2, and the clerk is told why. */
  it("an anchor doctor who is not sitting today drops out, and the card says so", async () => {
    mockRoutes({
      "GET /api/opd/queues/summary": { status: 200, body: { items: [doc({ id: "d-long", name: "Dr Long", waitingCount: 6, scheduledToday: false }), DR_QUICK] } },
      "GET /api/opd/continuity": { status: 200, body: { anchor: { doctorId: "d-long", doctorName: "Dr Long", seenOn: "2026-07-12" } } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");

    expect((await screen.findByTestId("appt-proposal-rule")).textContent).toBe("Shortest wait");
    expect(screen.getByTestId("appt-proposal-doctor").textContent).toBe("Dr Quick");
    expect(screen.getByTestId("appt-anchor-unavailable").textContent).toContain("Dr Long");
  });

  /**
   * FD-7 T8 — the owner's edge case, on the assembled screen. The clerk must be able to say the true
   * sentence to a patient who asked for that doctor by name, and the absent doctor — whose queue is
   * EMPTY, and therefore shortest — must not be the one the desk proposes.
   */
  it("a doctor on leave is not proposed despite the emptiest queue, and the card says he is on leave", async () => {
    mockRoutes({
      "GET /api/opd/queues/summary": { status: 200, body: { items: [
        doc({ id: "d-long", name: "Dr Long", waitingCount: 0, scheduledToday: false, onLeaveToday: true }),
        DR_QUICK,
      ] } },
      "GET /api/opd/continuity": { status: 200, body: { anchor: { doctorId: "d-long", doctorName: "Dr Long", seenOn: "2026-07-12" } } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");

    expect((await screen.findByTestId("appt-proposal-doctor")).textContent).toBe("Dr Quick");
    expect(screen.getByTestId("appt-anchor-unavailable").textContent).toContain("on leave today");
  });

  /* ── the future lane — the owner's other correction ──────────────────────────────────────── */

  it("walk-in is the DEFAULT lane, and future is one press away", async () => {
    mockRoutes();
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    expect((await screen.findByTestId("appt-mode-walkin")).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("appt-mode-future").getAttribute("aria-pressed")).toBe("false");
  });

  it("a future appointment books a real slot off the doctor's own grid", async () => {
    const slotStart = `${TODAY}T05:00:00.000Z`;
    mockRoutes({
      "GET /api/opd/slots": { status: 200, body: { slots: [{ start: slotStart, end: `${TODAY}T05:15:00.000Z`, roomId: "r-1", scheduleId: "sc-1", booked: false, past: false }] } },
      "POST /api/opd/appointments": { status: 200, body: { appointment: { id: "a-1", slotStart } } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");
    await user.click(screen.getByTestId("appt-mode-future"));
    await user.selectOptions(screen.getByTestId("appt-doctor"), "d-quick");
    await user.click(await screen.findByTestId(`appt-slot-${slotStart}`));

    await screen.findByTestId("appt-done");
    expect(sent).toEqual({ patientId: "p-1", doctorId: "d-quick", slotStart });
  });

  it("a booked slot and a past slot are never offered", async () => {
    mockRoutes({
      "GET /api/opd/slots": { status: 200, body: { slots: [
        { start: `${TODAY}T05:00:00.000Z`, end: "", roomId: "r-1", scheduleId: "sc-1", booked: true, past: false },
        { start: `${TODAY}T03:00:00.000Z`, end: "", roomId: "r-1", scheduleId: "sc-1", booked: false, past: true },
      ] } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");
    await user.click(screen.getByTestId("appt-mode-future"));
    await user.selectOptions(screen.getByTestId("appt-doctor"), "d-quick");

    expect(await screen.findByTestId("appt-no-slots")).toBeTruthy();
    expect(screen.queryByTestId(`appt-slot-${TODAY}T05:00:00.000Z`)).toBeNull();
  });

  /* ── the third door ──────────────────────────────────────────────────────────────────────── */

  it("a patient who already has a booking is CHECKED IN, not walked in beside it", async () => {
    mockRoutes({
      "GET /api/opd/appointments": { status: 200, body: { items: [{ id: "a-9", patientId: "p-1", doctorId: "d-quick", slotStart: `${TODAY}T05:00:00.000Z`, status: "booked" }] } },
      "POST /api/opd/appointments/a-9/check-in": { status: 200, body: { encounter: { id: "E-9" }, tokenNo: 11, sessionId: "s-1" } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("appt-checkin-a-9"));
    expect((await screen.findByTestId("appt-done")).textContent).toContain("11");
  });

  /* ── D8: two patients, and nothing of the first survives into the second ─────────────────── */

  it("two patients in a row: the second starts clean — no department, no doctor, no proposal", async () => {
    mockRoutes({
      "POST /api/opd/walk-in": { status: 200, body: { patientId: "p-1", registered: false, encounter: { id: "E-1" }, tokenNo: 4, sessionId: "s-1" } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");
    await user.click(await screen.findByTestId("appt-confirm"));
    await screen.findByTestId("appt-done");

    await user.click(screen.getByTestId("appt-next"));
    await waitFor(() => expect(screen.queryByTestId("appt-done")).toBeNull());
    // THE KILL for a desk that carries the last patient's choices into the next one.
    expect((screen.getByTestId("appt-department") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("appt-doctor") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByTestId("appt-proposal")).toBeNull();
    expect(screen.getByTestId("appt-mode-walkin").getAttribute("aria-pressed")).toBe("true");
  });

  /** A refused walk-in is SAID, never swallowed — the clerk has a queue behind them. */
  it("a refused walk-in shows the server's reason", async () => {
    mockRoutes({
      "POST /api/opd/walk-in": { status: 409, body: { code: "session_closed", message: "the doctor's session is closed" } },
    });
    inHand("p-1");
    renderWithProviders(<AppointmentSeat now={NOW} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("appt-department"), "dept-gm");
    await user.click(await screen.findByTestId("appt-confirm"));
    expect(await screen.findByTestId("appt-error")).toBeTruthy();
    expect(screen.queryByTestId("appt-done")).toBeNull();
  });
});
