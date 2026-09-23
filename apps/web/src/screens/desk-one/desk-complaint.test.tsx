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
 * THE PATIENT'S OWN WORDS LEAVE THE DESK WITH THE VISIT (owner, 2026-09-23).
 *
 * Desk One has asked "what brings them in?" since FD-8 and used the answer only to rank departments.
 * These drive the REAL screen and read the walk-in body off the wire, because "is it sent" is the
 * question — the server half has its own route test (`desk-complaint.test.ts`).
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
    "POST /api/opd/triage": { suggestions: [], source: "table" },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    /* `d.assign` posts the WALK-IN, not a visit — the seat is the thing being asserted. */
    "POST /api/opd/walk-in": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as { departmentId: string; doctorId: string };
      assigned.push(b as never);
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
  await waitFor(() => expect(screen.getByTestId("complaint")).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

describe("the desk complaint travels with the walk-in", () => {
  it("what the clerk typed is sent, trimmed, as deskComplaint", async () => {
    const assigned: Record<string, unknown>[] = [];
    mount([doctor("doc-verma", "Dr. Verma", 0)], null, assigned as never);
    await holdPatient();
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("complaint"), "  pair mein jhunjhuni  ");
    await user.click(screen.getByTestId("propose-assign"));
    await waitFor(() => expect(assigned).toHaveLength(1));
    expect(assigned[0]!.deskComplaint).toBe("pair mein jhunjhuni");
  });

  it("nothing typed sends no deskComplaint key at all", async () => {
    const assigned: Record<string, unknown>[] = [];
    mount([doctor("doc-verma", "Dr. Verma", 0)], null, assigned as never);
    await holdPatient();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("propose-assign"));
    await waitFor(() => expect(assigned).toHaveLength(1));
    expect("deskComplaint" in assigned[0]!).toBe(false);
  });
});
