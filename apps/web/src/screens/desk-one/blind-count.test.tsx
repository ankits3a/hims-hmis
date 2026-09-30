import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { expect, it } from "vitest";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import "../../lib/i18n";

/**
 * ═══ OWNER RULING 2026-09-28 — BLIND COUNT ═══
 *
 * *"The cashier's 'collected today' … must also be hidden until their count is submitted, because
 * float plus collected reveals the expected cash."* Desk One tallies the cash its own bills took
 * (`takenPaise`) and used to SAY it — the dock's drawer answer read "₹X has come in as cash at this
 * desk since you signed in", beside the float. That sum is the expected cash, so the answer names
 * the float and nothing that came in.
 */
it("the dock's drawer answer names the float and never what has come in as cash", async () => {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital: ["opd.visits.open", "patients.register", "billing.invoice.issue", "billing.session.own"], scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": { items: [] },
    "GET /api/opd/queues/summary": { items: [] },
    "GET /api/opd/doctors": { items: [] },
    "GET /api/opd/appointments": { items: [] },
    "GET /api/billing/sessions/current": { session: { id: "s1", cashierUserId: "u1", status: "open", openedAt: "2026-09-28T03:30:00.000Z", openingFloatPaise: 200000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } },
    "GET /api/me/desk": { cards: [] },
    "GET /api/membership/recognition": { card: null, coupons: [] },
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
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText("ask — “kis line mein kam wait hai?”", {}, { timeout: 3000 });
  // the drawer answer needs the session read to have landed
  await waitFor(() => expect(qc.getQueryData(["d1", "cash-session"])).toBeDefined(), { timeout: 3000 });
  await user.type(input, "drawer{Enter}");
  const answer = await screen.findByText(/Your drawer opened at/, {}, { timeout: 3000 });
  expect(answer.textContent).toContain("2,000");
  expect(answer.textContent).not.toMatch(/come in as cash/);
  expect(answer.textContent).toContain("after you submit your closing count");
});
