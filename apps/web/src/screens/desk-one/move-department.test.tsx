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
 * ═══ OWNER 2026-10-05 — "WRONG DEPARTMENT — MOVE PATIENT" ═══
 *
 * *"If by mistake the front desk staff set an appointment of the patient to Orthopedics but it
 * should be General Medicine, how can they move that patient … making sure the OPD report also gets
 * auto corrected."* The desk names the move (from → to), asks for the doctor and why, shows what the
 * visit will cost in the new department BEFORE the write, and then holds the NEW visit.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};
const doctor = (id: string, userId: string, displayName: string, departmentId: string) => ({
  doctor: {
    id, userId, displayName, code: id.toUpperCase(), registrationNo: null, departmentId, specialty: null, active: true,
    createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
  },
  sessionId: `s-${id}`, status: "open", waitingCount: 2, waitingVitalsCount: 0, nowServing: null,
  scheduledToday: true, roomCode: id === "doc-1" ? "R1" : "R4", avgConsultMinutes: 10, onLeaveToday: false,
});
const QUOTE = {
  encounterId: "e-1", visitType: "new", free: false, feeServiceId: "svc-1", freeReason: null, attributionCode: null,
  draft: {
    tariffVersionId: "tv-1", intendedPayer: "self",
    lines: [{
      lineId: "l-1", serviceId: "svc-1", serviceName: "OPD consultation", category: "consult",
      qty: 1, unitPaise: 30_000, grossPaise: 30_000, regulatedClamp: null,
      candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 0,
      gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "healthcare", cgstPaise: 0, sgstPaise: 0 },
      netPaise: 30_000,
    }],
    totals: {
      grossPaise: 30_000, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
      taxableTurnoverPaise: 0, exemptTurnoverPaise: 30_000, taxSummary: [],
      rawTotalPaise: 30_000, netPayablePaise: 30_000, roundingPaise: 0,
    },
  },
};

type Calls = { moves: { departmentId: string; doctorId: string; reason: string }[]; previews: string[] };

function mount(calls: Calls, opts: { billed?: boolean; feeOff?: boolean } = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: ["opd.visits.open", "patients.register", "patients.update", "billing.invoice.issue", "membership.instrument.recognise"],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
    "GET /api/patients/p-1/photo": (): unknown => { throw new Error("no photo"); },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": {
      items: [
        { id: "d-1", name: "Orthopaedics", code: "ORT", active: true },
        { id: "d-2", name: "General Medicine", code: "MED", active: true },
      ],
    },
    "GET /api/opd/queues/summary": { items: [doctor("doc-1", "u-ortho", "Dr. Verma", "d-1"), doctor("doc-2", "u-med", "Dr. Sharma", "d-2")] },
    "GET /api/opd/continuity": { anchor: null },
    "POST /api/opd/walk-in": {
      encounter: { id: "e-1", patientId: "p-1", visitNo: "V1", departmentId: "d-1", doctorId: "doc-1", status: "registered" },
      queueEntry: { id: "q-1", tokenNo: 7 }, tokenNo: 7, sessionId: "s-doc-1", roomId: null,
      visitType: "new", doctorScheduledToday: true, patientId: "p-1", registered: false,
    },
    "GET /api/opd/visits/e-1/move-preview": (_init?: RequestInit, url?: string) => {
      calls.previews.push(String(url));
      return {
        encounterId: "e-1",
        from: { departmentId: "d-1", doctorId: "doc-1", visitType: "new" },
        to: { departmentId: "d-2", visitType: "revisit" },
        standingInvoiceNo: opts.billed === true ? "INV/26-27/000042" : null,
      };
    },
    "POST /api/opd/visits/e-1/move-department": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}")) as Calls["moves"][number];
      calls.moves.push(b);
      return {
        from: { encounter: { id: "e-1", status: "abandoned" }, tokenNo: 7 },
        to: { encounter: { id: "e-2", visitNo: "V2", departmentId: "d-2", doctorId: "doc-2", status: "registered" }, tokenNo: 3, sessionId: "s-doc-2", roomId: null, visitType: "revisit" },
      };
    },
    "GET /api/billing/consult-terms": { consultFeeOff: opts.feeOff === true, paise: { new: 30_000, renewal: 15_000, revisit: null } },
    "GET /api/billing/visits/e-1/fee-quote": QUOTE,
    "GET /api/billing/visits/e-2/fee-quote": {
      encounterId: "e-2", visitType: "revisit", free: true, feeServiceId: null, draft: null,
      freeReason: { kind: "review_window", doctorName: "Dr. Sharma", seenOn: "2026-09-30", windowEndsOn: "2026-10-14" },
      attributionCode: null,
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

async function seatInOrthoAndOpenMove(): Promise<ReturnType<typeof userEvent.setup>> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getAllByRole("button", { name: /this is them/i })[0]).toBeInTheDocument());
  await user.click(screen.getAllByRole("button", { name: /this is them/i })[0]!);
  await waitFor(() => expect(screen.getByTestId("complaint")).toBeInTheDocument());
  // seat them with the ORTHOPAEDICS doctor — the mistake this test corrects
  await waitFor(() => expect(screen.getAllByText("Dr. Verma").length).toBeGreaterThan(0));
  const row = screen.getAllByText("Dr. Verma").map((n) => n.closest(".d1-docrow")).find((r) => r !== null) as HTMLElement;
  await user.click(within(row).getByRole("button", { name: /^assign$/ }));
  await waitFor(() => expect(screen.getByTestId("move-dept-open")).toBeInTheDocument());
  await user.click(screen.getByTestId("move-dept-open"));
  await waitFor(() => expect(screen.getByTestId("move-dept-panel")).toBeInTheDocument());
  return user;
}

afterEach(() => { setToken(null); });

describe("Wrong department — move patient (owner 2026-10-05)", () => {
  it("names the move, previews the fee in the new department, asks why, and then holds the NEW visit", async () => {
    const calls: Calls = { moves: [], previews: [] };
    mount(calls);
    const user = await seatInOrthoAndOpenMove();
    const panel = screen.getByTestId("move-dept-panel");

    // FROM: the department, doctor and token the patient is holding now
    expect(within(panel).getByTestId("move-dept-from")).toHaveTextContent(/Orthopaedics.*Dr\. Verma.*ORT-7/);
    // the department they are already in is not offered as a target
    expect(within(panel).queryByTestId("move-dept-d-1")).not.toBeInTheDocument();

    await user.click(within(panel).getByTestId("move-dept-d-2"));
    // a department with one doctor on the board picks that doctor
    await waitFor(() => expect(within(panel).getByTestId("move-doctor-doc-2")).toHaveStyle({ fontWeight: "700" }));
    // the fee the visit carries NOW, and what it becomes in medicine — before anything is written
    await waitFor(() => expect(within(panel).getByTestId("move-dept-fee")).toHaveTextContent(/New · ₹300/));
    expect(within(panel).getByTestId("move-dept-fee-after")).toHaveTextContent("Revisit · Free");
    expect(calls.previews.some((u) => u.includes("departmentId=d-2"))).toBe(true);

    // why is required
    await user.click(within(panel).getByTestId("move-dept-submit"));
    expect(await within(panel).findByTestId("move-dept-error")).toHaveTextContent(/why/);
    expect(calls.moves).toHaveLength(0);

    await user.type(within(panel).getByTestId("move-dept-reason"), "booked in ortho by mistake");
    await user.click(within(panel).getByTestId("move-dept-submit"));
    await waitFor(() => expect(calls.moves).toHaveLength(1));
    expect(calls.moves[0]).toEqual({ departmentId: "d-2", doctorId: "doc-2", reason: "booked in ortho by mistake" });

    // the desk now holds the new visit: medicine, Dr. Sharma, MED-3 — the patient was never re-typed
    await waitFor(() => expect(screen.queryByTestId("move-dept-panel")).not.toBeInTheDocument());
    const card = screen.getByTestId("seating-card");
    expect(card).toHaveTextContent("Dr. Sharma");
    expect(card).toHaveTextContent(/General Medicine.*MED-3/);
  });

  it("a bill standing against the visit is named, and the move is not offered", async () => {
    const calls: Calls = { moves: [], previews: [] };
    mount(calls, { billed: true });
    const user = await seatInOrthoAndOpenMove();
    const panel = screen.getByTestId("move-dept-panel");
    await user.click(within(panel).getByTestId("move-dept-d-2"));
    expect(await within(panel).findByTestId("move-dept-billed")).toHaveTextContent(/INV\/26-27\/000042.*credit note/);
    expect(within(panel).getByTestId("move-dept-submit")).toBeDisabled();
  });

  it("with the consultation fee switched off, both sides of the preview say free", async () => {
    const calls: Calls = { moves: [], previews: [] };
    mount(calls, { feeOff: true });
    const user = await seatInOrthoAndOpenMove();
    const panel = screen.getByTestId("move-dept-panel");
    await user.click(within(panel).getByTestId("move-dept-d-2"));
    await waitFor(() => expect(within(panel).getByTestId("move-dept-fee")).toHaveTextContent(/New · Free \(consultation fee switched off\)/));
    expect(within(panel).getByTestId("move-dept-fee-after")).toHaveTextContent("Revisit · Free (consultation fee switched off)");
  });
});
