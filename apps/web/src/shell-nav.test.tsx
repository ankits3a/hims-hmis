import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "./lib/auth";
import { setToken } from "./lib/api";
import { router } from "./router";
import { stubFetch } from "./test-utils";
import "./lib/i18n";

/**
 * PLAN 11h T6 — the shell renders the navigation THIS PERSON CAN USE, and nothing else.
 *
 * Before this, sixteen links were rendered to every role alike and fourteen of them answered 403
 * to a cashier — the "dark screens" the 2026-08-24 synthetic smoke test reported. The fix is a
 * projection, not a guard: every route still carries its server-side `@RequirePermission`, and
 * these assertions are about what a person is OFFERED.
 */
function renderShell(hospital: string[]): void {
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [] },
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/registration"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { setToken(null); });

it("offers only the screens the signed-in person holds a permission for", async () => {
  renderShell(["patients.register", "billing.invoice.issue"]);

  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Counter" })).toBeInTheDocument();

  // The fourteen that would have answered 403 are simply not offered.
  expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Merge review" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "OPD desk" })).not.toBeInTheDocument();
});

it("a person whose role holds nothing is TOLD SO rather than shown a blank bar", async () => {
  renderShell([]);

  // "The app is broken" and "my account has no access" go to different people; the shell must
  // not make the second look like the first.
  await waitFor(() =>
    expect(screen.getByText(/No screens are available to your role/i)).toBeInTheDocument(),
  );
  expect(screen.queryByRole("link", { name: "Registration" })).not.toBeInTheDocument();
});
