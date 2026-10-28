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
 * Owner 2026-10-28 — the left rail, once a patient is in hand: *"move the phone number above the credit button, and add
 * relation type and relative name (Father: Sunil Kumar) in the same row the phone number will be. Add 'edit record —
 * audited' along the 'Credit' row."* So: name · age/sex/UHID · `phone · Father: name` · [Credit] [edit record — audited].
 * Every value is synthetic.
 */
const HIT = {
  id: "p-1", uhid: "U00000017", name: "Mohan Kumar", administrativeGender: "male", phone: "9100000001", dob: "1991-01-01",
  isConfidential: false, hasPhoto: false, district: "Kanpur Nagar", registeredOn: "2026-10-01T00:00:00.000Z", matchedOn: ["name"],
  guardian: { name: "Ramesh Kumar", relation: "father" },
};

function mountDesk(): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital: ["opd.visits.open", "patients.register", "patients.update", "billing.invoice.issue", "billing.dues.patient.read"], scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [HIT] },
    "GET /api/patients/p-1": { patient: { dob: "1991-01-01", phone: "9100000001", addressLine: "12 Mall Road" } },
    "GET /api/patients/p-1/photo": (): unknown => { throw new Error("no photo"); },
    "GET /api/patients/abha/capability": { configured: false, canRecord: false, canCreate: false, canVerify: false, reason: "off" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/opd/continuity": { anchor: null },
    "GET /api/billing/session/current": { session: null },
    "GET /api/billing/patients/p-1/dues": { items: [] },
    "GET /api/pharmacy/patients/p-1/credit": {
      totalAvailablePaise: 0, availablePaise: 0, totalNetPaise: 0, notes: [], refunds: [], refundAwaitingApprovalPaise: 0,
    },
    "GET /api/billing/patients/p-1/balance": { patientId: "p-1", advancePaise: 0, outstandingPaise: 0, dues: [] },
    "GET /api/me/desk": { stats: [] },
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

afterEach(() => { setToken(null); });

it("the rail shows phone · Father: name above one row of Credit and edit record — audited", async () => {
  mountDesk();
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Moh");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));

  const contact = await screen.findByTestId("d1-person-contact");
  expect(contact.textContent).toMatch(/^9100000001.* · Father: Ramesh Kumar$/);
  const actions = screen.getByTestId("d1-person-actions");
  expect(within(actions).getByTestId("desk-one-credit")).toBeInTheDocument();
  expect(within(actions).getByRole("button", { name: /edit record — audited/ })).toBeInTheDocument();
  // The phone row comes BEFORE the credit row.
  expect(contact.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
