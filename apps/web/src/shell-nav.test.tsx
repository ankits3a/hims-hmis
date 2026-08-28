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
  // PLAN 16a T7 — the formulary desk is `formulary.manage`, held by `pharmacy` alone (DD10). A
  // clerk with a counter permission is not offered it, which is also why the link is invisible on
  // the live deployment today: that role exists and has no holders.
  expect(screen.queryByRole("link", { name: "Formulary" })).not.toBeInTheDocument();
});

it("16a: the formulary desk appears for the permission that guards it, and for no other", async () => {
  renderShell(["formulary.manage"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Formulary" })).toBeInTheDocument());
  // `formulary.read` is a PRESCRIBER's permission (the consult autocomplete) and opens no desk.
  expect(screen.queryByRole("link", { name: "Registration" })).not.toBeInTheDocument();
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

/**
 * PLAN 07b T8 — THE ROW IS GROUPED, AND THE COUNTER LEADS IT.
 *
 * Twenty-seven links in one undifferentiated row is a list a person re-reads every time rather than
 * a place they know their way around, and holding three roles bought MORE of that row rather than a
 * better one. The group labels are the structure; the counter leading is the point, because that is
 * where a one-person desk actually works.
 */
it("07b T8: the nav is grouped, and a counter clerk's Desk group comes before the rest", async () => {
  renderShell(["opd.visits.open", "patients.register", "billing.invoice.issue"]);
  await waitFor(() => { expect(screen.getByText("Registration")).toBeInTheDocument(); });

  const nav = screen.getByRole("navigation");
  expect(nav).toHaveTextContent("Desk");
  expect(nav).toHaveTextContent("Patients");
  expect(nav).toHaveTextContent("Billing");

  // Reading order is the order a desk WORKS in: the counter first, not the ninth similar-looking word.
  const text = nav.textContent ?? "";
  expect(text.indexOf("Desk")).toBeLessThan(text.indexOf("Patients"));
  expect(text.indexOf("Counter")).toBeLessThan(text.indexOf("Registration"));
});

/** A group with nothing in it must not render its label — an empty heading is furniture. */
it("07b T8: a group the person holds nothing in does not render at all", async () => {
  renderShell(["patients.register"]);
  await waitFor(() => { expect(screen.getByText("Registration")).toBeInTheDocument(); });
  const nav = screen.getByRole("navigation");
  expect(nav).toHaveTextContent("Patients");
  expect(nav).not.toHaveTextContent("Stores");
  expect(nav).not.toHaveTextContent("Billing");
});
