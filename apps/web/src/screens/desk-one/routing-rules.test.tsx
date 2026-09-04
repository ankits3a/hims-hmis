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
 * FD-13 — THE WALK-IN ROUTING RULES, ON THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04: *"is rule 2 active in place? … if the patient returns … offer same doctor as
 * before. However the queue is larger than 20 min waiting time then highlight the doctor with
 * waiting time and offer the second most preferrable doctor as per availability and waiting time."*
 *
 * IT WAS NOT ACTIVE, AND THE REASON IS THE WHOLE POINT OF THIS FILE. `walk-in-routing.ts` has
 * implemented every one of those rules since FD-7 T2, with unit tests that pass, and
 * `GET /opd/continuity` has answered on the server just as long. A grep for their importers returned
 * NOTHING: the FD-9 rebuild collapsed three routes into `/counter` and left the rail behind. The
 * appointment stage picked `open.reduce(shortest wait)` and no more.
 *
 * So `walk-in-routing.test.ts` proving the FUNCTION is not enough and never was — it passed
 * throughout the entire period the feature did not exist for a single user. These tests drive the
 * REAL screen, because "is it wired" is the only question the unit tests could not answer.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

function doctor(
  id: string, name: string, waitingCount: number,
  opts: { scheduledToday?: boolean; onLeaveToday?: boolean } = {},
): unknown {
  return {
    doctor: {
      id, userId: `u-${id}`, displayName: name, registrationNo: null, departmentId: "d-1",
      specialty: null, active: true,
      createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
    },
    sessionId: `s-${id}`, status: "open",
    waitingCount, waitingVitalsCount: 0, nowServing: null,
    scheduledToday: opts.scheduledToday ?? true, roomCode: "R1",
    avgConsultMinutes: 10,
    onLeaveToday: opts.onLeaveToday ?? false,
  };
}

/**
 * Sharma's line is DELIBERATELY the longer one in every fixture below. Rule 1 is "back to the doctor
 * who knows them EVEN WHEN HIS LINE IS LONGER" — a fixture where the anchor is also the quickest
 * would pass identically with the rail unwired, which is exactly the hole these tests exist to close.
 */
function mount(
  summaries: unknown[],
  anchor: { doctorId: string; doctorName: string; seenOn: string } | null,
  assigned: { departmentId: string; doctorId: string }[],
): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: ["opd.visits.open", "patients.register", "billing.invoice.issue"],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Cardiology", code: "CARD" }] },
    "GET /api/opd/queues/summary": { items: summaries },
    "GET /api/opd/continuity": { anchor },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    /* `d.assign` posts the WALK-IN, not a visit — the seat is the thing being asserted. */
    "POST /api/opd/walk-in": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as { departmentId: string; doctorId: string };
      assigned.push({ departmentId: b.departmentId, doctorId: b.doctorId });
      return {
        encounter: {
          id: "e-1", patientId: "p-1", visitNo: "V1", departmentId: b.departmentId,
          doctorId: b.doctorId, status: "open",
        },
        queueEntry: { id: "q-1", tokenNo: 4 },
        tokenNo: 4,
        sessionId: "s-1",
        roomId: null,
        visitType: "walk_in",
        doctorScheduledToday: true,
        patientId: "p-1",
        registered: false,
      };
    },
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

/** Search, take the patient, and land on the appointment stage where the rules are drawn. */
async function holdPatient(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));
  await waitFor(() => expect(screen.getByPlaceholderText(/seene mein dard/)).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

describe("FD-13: the walk-in routing rules are on the screen, not merely in the library", () => {
  it("RULE 1 — a returning patient goes back to the doctor who saw them, even though his line is longer", async () => {
    const assigned: { departmentId: string; doctorId: string }[] = [];
    mount(
      [doctor("doc-sharma", "Dr. Sharma", 1), doctor("doc-verma", "Dr. Verma", 0)],
      { doctorId: "doc-sharma", doctorName: "Dr. Sharma", seenOn: "2026-03-14" },
      assigned,
    );
    await holdPatient();

    // the card names WHO and WHEN — "you have been here before" is small talk, this is a promise
    await waitFor(() => expect(screen.getByTestId("continuity-anchor")).toBeInTheDocument());
    expect(screen.getByText(/Dr\. Sharma on 2026-03-14/)).toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));

    // Verma has the EMPTY queue. Unwired, this assertion is the one that fails.
    await waitFor(() => expect(assigned).toHaveLength(1));
    expect(assigned[0]!.doctorId).toBe("doc-sharma");
  });

  it("with no prior visit it falls through to the shortest line, exactly as before", async () => {
    const assigned: { departmentId: string; doctorId: string }[] = [];
    mount(
      [doctor("doc-sharma", "Dr. Sharma", 1), doctor("doc-verma", "Dr. Verma", 0)],
      null,
      assigned,
    );
    await holdPatient();

    expect(screen.queryByTestId("continuity-anchor")).not.toBeInTheDocument();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));
    await waitFor(() => expect(assigned).toHaveLength(1));
    expect(assigned[0]!.doctorId).toBe("doc-verma");
  });

  /**
   * THE 20-MINUTE RULE. Sharma: 3 waiting × 10 min = 30, over the threshold. Verma: 1 × 10 = 10.
   * Continuity still wins the PROPOSAL; the clerk is told the line is long and offered the quicker
   * doctor as a second button. A silent re-route would be rule 2 wearing rule 1's name.
   */
  it("RULE 2 — past 20 minutes the delay is highlighted and a quicker doctor is offered, without stealing the proposal", async () => {
    const assigned: { departmentId: string; doctorId: string }[] = [];
    mount(
      [doctor("doc-sharma", "Dr. Sharma", 3), doctor("doc-verma", "Dr. Verma", 1)],
      { doctorId: "doc-sharma", doctorName: "Dr. Sharma", seenOn: "2026-03-14" },
      assigned,
    );
    await holdPatient();

    const highlight = await screen.findByTestId("delay-highlight");
    expect(highlight).toHaveTextContent(/About 30 minutes/);
    expect(highlight).toHaveTextContent(/longer than 20/);
    expect(highlight).toHaveTextContent(/Dr\. Verma could see them in about 10 min/);

    // the primary action is STILL the doctor who knows them — the alternative did not replace it
    expect(screen.getByTestId("continuity-anchor")).toBeInTheDocument();

    // …and the clerk may take the offer, which seats the OTHER doctor
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("take-alternative"));
    await waitFor(() => expect(assigned).toHaveLength(1));
    expect(assigned[0]!.doctorId).toBe("doc-verma");
  });

  it("under 20 minutes nothing is highlighted — the rule is a threshold, not decoration", async () => {
    mount(
      [doctor("doc-sharma", "Dr. Sharma", 1), doctor("doc-verma", "Dr. Verma", 0)],
      { doctorId: "doc-sharma", doctorName: "Dr. Sharma", seenOn: "2026-03-14" },
      [],
    );
    await holdPatient();
    await waitFor(() => expect(screen.getByTestId("continuity-anchor")).toBeInTheDocument());
    expect(screen.queryByTestId("delay-highlight")).not.toBeInTheDocument();
  });

  it("already the shortest line: the delay is still said, and nothing is offered that is not quicker", async () => {
    mount([doctor("doc-sharma", "Dr. Sharma", 3)], null, []);
    await holdPatient();

    const highlight = await screen.findByTestId("delay-highlight");
    expect(highlight).toHaveTextContent(/About 30 minutes/);
    expect(highlight).toHaveTextContent(/is already the shortest line/);
    expect(screen.queryByTestId("take-alternative")).not.toBeInTheDocument();
  });

  /* "Not scheduled" and "away today" are different sentences to say to a patient who asked by name. */
  it("when the remembered doctor is on leave the screen says so, and says leave is the reason", async () => {
    mount(
      [
        doctor("doc-sharma", "Dr. Sharma", 0, { scheduledToday: false, onLeaveToday: true }),
        doctor("doc-verma", "Dr. Verma", 1),
      ],
      { doctorId: "doc-sharma", doctorName: "Dr. Sharma", seenOn: "2026-03-14" },
      [],
    );
    await holdPatient();

    const note = await screen.findByTestId("anchor-unavailable");
    expect(note).toHaveTextContent(/Dr\. Sharma saw them on 2026-03-14/);
    expect(note).toHaveTextContent(/on leave today/);
    // and an absent doctor is never proposed — his empty queue is the shortest line in the building
    expect(screen.queryByTestId("continuity-anchor")).not.toBeInTheDocument();
  });
});
