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
 * ═══ OWNER 2026-10-04 — "Fix the Desk One issue on phone." ═══
 *
 * At 390px the desk kept the 252px dossier rail beside the stage, so the stage got ~140px and every
 * sentence wrapped one word per line. A phone is worked one patient at a time: one column, the
 * patient in hand as a compact strip (name, age/sex, UHID, ₹ to collect) that opens on tap, the
 * header's secondary items behind a Menu, and every line in the building behind one button with
 * the count on it.
 *
 * jsdom has no `matchMedia`, so every other suite renders the wide desk — which is the point: the
 * desktop DOM is untouched. These tests install a `matchMedia` that answers like a phone.
 */

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ravi Prasad", phone: "9876500011",
  administrativeGender: "male", dob: "1980-01-01", isConfidential: false, hasPhoto: false,
  district: "Patna", registeredOn: "2026-09-28T00:00:00.000Z", matchedOn: ["name"],
};

const DOCTOR = {
  doctor: {
    id: "doc-gm", userId: "u-doc-gm", displayName: "Dr Arjun Sharma", registrationNo: null, departmentId: "d-gm",
    specialty: null, active: true, createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x",
    updatedAt: "2020-01-01T00:00:00.000Z",
  },
  sessionId: "s-doc-gm", status: "open", waitingCount: 4, waitingVitalsCount: 0, nowServing: null,
  scheduledToday: true, roomCode: "R-MED-1", avgConsultMinutes: 10, onLeaveToday: false,
};

function phoneViewport(phone: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: phone
      ? (query: string) => ({
        matches: /max-width/.test(query), media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      })
      : undefined,
  });
}

function mount(): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: ["opd.visits.open", "opd.visits.read", "patients.register", "billing.invoice.issue", "billing.invoice.read"],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1980-01-01", phone: "9876500011", addressLine: "Boring Road" } },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-gm", name: "General Medicine", code: "MED" }] },
    "GET /api/opd/queues/summary": { items: [DOCTOR] },
    "GET /api/opd/patients/p-1/timeline": { items: [] },
    "GET /api/opd/continuity": { anchor: null },
    "GET /api/billing/sessions/current": { session: null },
    "GET /api/billing/patients/p-1/dues": { items: [] },
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

async function holdPatient(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ravi");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));
}

afterEach(() => { setToken(null); phoneViewport(false); });

describe("Desk One on a phone — one column, the patient as a strip, the list behind a button", () => {
  it("the patient in hand collapses to a strip with name, age/sex, UHID and ₹ to collect, and opens on tap", async () => {
    phoneViewport(true);
    mount();
    await holdPatient();

    const strip = await screen.findByTestId("d1-strip");
    expect(strip).toHaveTextContent("Ravi Prasad");
    expect(strip).toHaveTextContent(/46 M · U00110012/);
    expect(within(strip).getByTestId("d1-strip-collect")).toHaveTextContent(/to collect\s*₹0/);
    expect(strip).toHaveAttribute("aria-expanded", "false");
    // The full record is there (state kept) but folded away until asked for.
    expect(screen.getByTestId("d1-rail-body")).not.toBeVisible();

    const user = userEvent.setup({ delay: null });
    await user.click(strip);
    expect(strip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("d1-rail-body")).toBeVisible();
    expect(within(screen.getByTestId("d1-rail-body")).getByText(/edit record — audited/)).toBeInTheDocument();
  });

  it("every line in the building opens and closes from one button that carries the count", async () => {
    phoneViewport(true);
    mount();
    const toggle = await screen.findByTestId("d1-list-toggle");
    await waitFor(() => expect(toggle).toHaveTextContent(/4 waiting/));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Every line in the building")).not.toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Every line in the building")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Every line in the building")).not.toBeInTheDocument();
  });

  it("the header's secondary items sit behind a Menu, and the drawer state shows without opening it", async () => {
    phoneViewport(true);
    mount();
    const menu = await screen.findByTestId("d1-menu-toggle");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/command/)).not.toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.click(menu);
    const panel = screen.getByTestId("d1-menu");
    expect(within(panel).getByText(/command/)).toBeInTheDocument();
    expect(within(panel).getByText(/no drawer open/)).toBeInTheDocument();
  });

  it("the wide desk is unchanged — no strip, no Menu, the rail holds the full record", async () => {
    mount();
    await holdPatient();
    await waitFor(() => expect(screen.getByText(/edit record — audited/)).toBeVisible());
    expect(screen.queryByTestId("d1-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("d1-menu-toggle")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /command/ })).toBeInTheDocument();
  });
});
