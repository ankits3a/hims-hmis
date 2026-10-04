import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import "../../lib/i18n";

/**
 * 20-U U7 — THE FRONT DESK KNOWS WHICH UNIT HOLDS TODAY'S OPD. The department card on the
 * appointment stage says which unit's day it is, and which of its doctors, from the roster's
 * published calendar (`GET /roster/opd-units`). Read-only: the doctors' rows, the queue bars and the
 * seat buttons are exactly what they were. A department that runs no units says nothing at all.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

function doctor(id: string, name: string, departmentId: string, waitingCount: number, designation: string | null = null): unknown {
  return {
    doctor: {
      id, userId: `u-${id}`, displayName: name, registrationNo: null, departmentId,
      specialty: null, active: true, designation,
      createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
    },
    sessionId: `s-${id}`, status: "open",
    waitingCount, waitingVitalsCount: 0, nowServing: null,
    scheduledToday: true, roomCode: "R1", avgConsultMinutes: 10, onLeaveToday: false,
  };
}

const UNITS = [{
  opdDepartmentId: "d-med", departmentId: "org-med",
  units: [{
    teamId: "t-2", code: "MED-U2", name: "General Medicine Unit II", short: "Unit II",
    startsAt: "2026-10-06T03:30:00.000Z", endsAt: "2026-10-06T07:30:00.000Z",
    doctors: [
      { userId: "u-head", name: "Dr. Rakesh Verma", role: "head" },
      { userId: "u-fac", name: "Dr. Anita Sharma", role: "faculty" },
      { userId: "u-sr", name: "Dr. Meena Joshi", role: "senior_resident" },
    ],
  }],
}];

function mount(permissions: string[], asked: string[]): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital: permissions, scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-med", name: "General Medicine", code: "MED" }, { id: "d-ped", name: "Paediatrics", code: "PED" }] },
    "GET /api/opd/queues/summary": { items: [doctor("doc-rao", "Dr. Rao", "d-med", 2, "Assistant Professor"), doctor("doc-sen", "Dr. Sen", "d-ped", 1, "Guest Faculty"), doctor("doc-nil", "Dr. Nil", "d-ped", 0)] },
    "GET /api/roster/doctor-units": [{ userId: "u-doc-rao", teamId: "t-2", code: "MED-U2", unitName: "General Medicine Unit II", short: "Unit II", departmentId: "org-med", departmentName: "General Medicine", roleInTeam: "head" }],
    "GET /api/opd/continuity": { anchor: null },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    "GET /api/roster/opd-units": (_init?: RequestInit, url?: string) => { asked.push(url ?? ""); return UNITS; },
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
  await waitFor(() => expect(screen.getByTestId("complaint")).toBeInTheDocument());
}

afterEach(() => { setToken(null); });

describe("20-U U7: the front desk sees which unit holds today's OPD", () => {
  it("the department card names the unit and its doctors; a department without units says nothing", async () => {
    const asked: string[] = [];
    mount(["opd.visits.open", "patients.register", "billing.invoice.issue", "roster.read"], asked);
    await holdPatient();

    await waitFor(() => expect(screen.getByTestId("opd-unit-d-med")).toBeInTheDocument());
    const line = screen.getByTestId("opd-unit-d-med");
    expect(line).toHaveTextContent("Unit II holds today's OPD");
    expect(within(line).getByText("Dr. Rakesh Verma, Dr. Anita Sharma, Dr. Meena Joshi")).toBeInTheDocument();
    expect(asked.some((u) => /\/roster\/opd-units\?date=\d{4}-\d{2}-\d{2}$/.test(u))).toBe(true);
    // Paediatrics runs no units: no line, no "Unit —".
    expect(screen.queryByTestId("opd-unit-d-ped")).toBeNull();
    expect(screen.queryByText(/Unit —/)).toBeNull();
  });

  it("2026-10-04 (owner) — each doctor row says the doctor's unit, or Guest Faculty; a doctor with neither shows the name alone", async () => {
    mount(["opd.visits.open", "patients.register", "billing.invoice.issue", "roster.read"], []);
    await holdPatient();
    await waitFor(() => expect(screen.getByTestId("doctor-tag-doc-rao")).toHaveTextContent("Unit II · Asst. Prof."));
    expect(screen.getByTestId("doctor-tag-doc-sen")).toHaveTextContent("Guest Faculty");
    expect(screen.queryByTestId("doctor-tag-doc-nil")).toBeNull();
  });

  it("a seat that does not read the roster does not ask, and the card is as it was", async () => {
    const asked: string[] = [];
    mount(["opd.visits.open", "patients.register", "billing.invoice.issue"], asked);
    await holdPatient();
    await waitFor(() => expect(screen.getAllByText("first free doctor").length).toBeGreaterThan(0));
    expect(asked).toEqual([]);
    expect(screen.queryByTestId("opd-unit-d-med")).toBeNull();
  });
});
