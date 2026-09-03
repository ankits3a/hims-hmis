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
 * FD-11 — ONE MODEL CALL PER PAUSE, NOT ONE PER KEYSTROKE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED AGAINST THE LIVE GATEWAY before this guard existed. Typing one complaint —
 * "seene mein dard aur saans phool rahi hai" — into the desk:
 *
 *     38 requests for one complaint · 36 answered from the KEYWORD TABLE, 2 from the model
 *     fired straight at the provider: 32 of the 38 came back HTTP 429, `retry-after: 1`
 *
 * The daily quota was untouched (964 requests remaining): it is a BURST limit. And because
 * `suggestDepartments` falls back to the keyword table on any failure — by design, and correctly —
 * the whole thing failed SILENTLY. Every request returned 200, the desk showed a department, and
 * the model the hospital pays for was consulted for 5% of calls. The answer a clerk actually reads
 * is the last one, which is the most likely of all to have been throttled.
 *
 * That is why this is a component test and not a unit test of a timer. What has to hold is the
 * property the counter depends on — the desk asks ONCE when the typist stops — and it has to hold
 * through the real component, because the defect was never in a helper. It was in the wiring.
 */
const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ramesh Kumar", phone: "9100000000",
  administrativeGender: "male", dob: "1984-01-01", isConfidential: false, hasPhoto: false,
  district: "Kanpur Nagar", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["name"],
};

function mountDesk(onTriage: () => void): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital: ["opd.visits.open", "patients.register", "billing.invoice.issue"], scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1984-01-01", phone: "9100000000", addressLine: "12 Mall Road" } },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [{ id: "d-1", name: "Cardiology", code: "CARD" }] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/desk": { stats: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
    // THE COUNTER: every call the desk makes to the advisor, however it was triggered.
    "POST /api/opd/triage": () => { onTriage(); return { suggestions: [], source: "model" }; },
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

it("FD-11: typing a whole complaint spends ONE model call, not one per keystroke", async () => {
  let calls = 0;
  mountDesk(() => { calls += 1; });
  /*
    `router` is a module singleton and `RouterProvider`'s `history` only takes on the first mount in
    a file, so the route is driven rather than requested — the same trap `shell-nav.test.tsx` hit.
  */
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());

  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ramesh");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));

  const complaint = await screen.findByPlaceholderText(/seene mein dard/);
  expect(calls).toBe(0);

  // 27 characters, typed without a pause between them, exactly as a clerk types.
  await user.type(complaint, "seene mein dard aur saans p");

  await waitFor(() => expect(calls).toBe(1), { timeout: 2000 });
  // And it stays one: nothing fires a trailing call after the answer lands.
  await new Promise((r) => setTimeout(r, 600));
  expect(calls).toBe(1);
});
