import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BRAKE, ON THE SCREEN — the assertion the whole red-flag feature is for
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `red-flags.test.ts` proves the rules fire and `triage.test.ts` proves they run before the model.
 * Neither proves the thing that actually protects a patient: that **the booking button is gone**.
 *
 * Owner, 2026-09-17: *"my front desk staff are non medico background and so they would rely on the
 * operating system to suggest them doctor/department."* A clerk who is handed a red warning AND an
 * assign button will press the button — that is what buttons are for, and it is why the stage
 * renders the flag INSTEAD OF the proposal rather than above it.
 */
const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: null, registeredOn: "2026-01-01", matchedOn: ["name"],
};

/** The doctor shape `routing-rules.test.tsx` uses — thinner fixtures do not reach the assign card. */
function doctor(id: string, name: string, waitingCount: number): unknown {
  return {
    doctor: {
      id, userId: `u-${id}`, displayName: name, registrationNo: null, departmentId: "d-1",
      specialty: null, active: true,
      createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
    },
    sessionId: `s-${id}`, status: "open",
    waitingCount, waitingVitalsCount: 0, nowServing: null,
    scheduledToday: true, roomCode: "R1", avgConsultMinutes: 10, onLeaveToday: false,
  };
}

function mount(triageReply: unknown): void {
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
    "GET /api/opd/queues/summary": { items: [doctor("doc-rao", "Dr. Rao", 1)] },
    "GET /api/opd/continuity": { anchor: null },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    "POST /api/opd/triage": triageReply,
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

async function holdPatientAndType(complaint: string): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));
  await waitFor(() => expect(screen.getByTestId("complaint")).toBeInTheDocument());
  await user.type(screen.getByTestId("complaint"), complaint);
}

afterEach(() => { setToken(null); });

describe("a red-flagged complaint cannot be booked from the appointment stage", () => {
  it("removes the assign button entirely — a button that is present is a button that gets pressed", async () => {
    mount({ suggestions: [], source: "keywords", redFlag: { reasonKey: "opdTriage.redFlag.chestPain", matched: "seene mein dard" } });
    await holdPatientAndType("seene mein dard");
    await waitFor(() => {
      expect(screen.queryByTestId("propose-assign")).not.toBeInTheDocument();
    });
  });

  it("tells the clerk what to do instead", async () => {
    mount({ suggestions: [], source: "keywords", redFlag: { reasonKey: "opdTriage.redFlag.chestPain", matched: "seene mein dard" } });
    await holdPatientAndType("seene mein dard");
    /*
      Asserted on the SENTENCE, not the key: i18n is loaded with the real bundle in these tests, so
      `t()` resolves. And the instruction is the half that changes what the clerk does — a warning
      that only described the danger would leave them holding the decision this exists to take away.
    */
    await waitFor(() => expect(screen.getByText(/do not book/i)).toBeInTheDocument());
  });

  /**
   * THE CONTROL. Without this, a stage that rendered no assign button for ANY reason would pass the
   * test above — the empty-result trap, where the assertion is satisfied by the screen being broken.
   */
  it("still offers the button for an ordinary complaint", async () => {
    mount({ suggestions: [{ departmentId: "d-1", reason: "fever" }], source: "keywords" });
    await holdPatientAndType("bukhar");
    await waitFor(() => expect(screen.getByTestId("propose-assign")).toBeInTheDocument());
  });
});
