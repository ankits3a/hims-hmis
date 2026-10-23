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
 * Owner 2026-10-23 — *"In the suggested list of patients in the /counter screen, show guardian info
 * as well along with age, area, mobile number and UHID."* Each row carries the guardian under the
 * age and mobile; a woman's spouse reads Husband (#942), the registration's father / husband box
 * reads Father/Husband, and a row with nobody on file says so.
 */
const BASE = {
  phone: "9100000001", dob: "1991-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2026-10-01T00:00:00.000Z", matchedOn: ["name"],
};
const HITS = [
  { ...BASE, id: "p-1", uhid: "U00000017", name: "Mohan Kumar", administrativeGender: "male", guardian: { name: "Ramesh Kumar", relation: "father" } },
  { ...BASE, id: "p-2", uhid: "U00000024", name: "Mohini Devi", administrativeGender: "female", guardian: { name: "Manoj Sah", relation: "spouse" } },
  { ...BASE, id: "p-3", uhid: "U00000031", name: "Mohita Kumari", administrativeGender: "female", guardian: { name: "Ram Prasad", relation: null } },
  { ...BASE, id: "p-4", uhid: "U00000048", name: "Mohan Singh", administrativeGender: "male", guardian: null },
];

function mountDesk(): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital: ["opd.visits.open", "patients.register", "billing.invoice.issue"], scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: HITS },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/billing/session/current": { session: null },
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

it("each counter hit shows its guardian under the age and mobile, and a row with none says so", async () => {
  mountDesk();
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());

  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Moh");
  await waitFor(() => expect(screen.getAllByTestId("hit-guardian")).toHaveLength(4));

  const lines = screen.getAllByTestId("hit-guardian");
  expect(lines.map((l) => l.textContent)).toEqual([
    "Father: Ramesh Kumar",
    "Husband: Manoj Sah",
    "Father/Husband: Ram Prasad",
    "no guardian on file",
  ]);
  expect(lines[0]).toHaveAttribute("title", "Father: Ramesh Kumar");

  // Placed between the age · mobile line and the area line, inside the same column.
  const column = lines[0]!.parentElement!;
  expect(within(column).getByText("Mohan Kumar")).toBeInTheDocument();
  const order = Array.from(column.children).map((c) => c.getAttribute("data-testid") ?? c.textContent);
  expect(order.indexOf("hit-guardian")).toBe(2);
  expect(order.indexOf("hit-tell-apart")).toBe(3);
});
