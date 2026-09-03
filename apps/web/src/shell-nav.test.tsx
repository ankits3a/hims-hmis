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
        {/*
          FD-9 — `/merge` and NOT `/registration`: that route is deleted with the old front-desk
          design. The route this mounts on is incidental to every assertion in this file — they are
          all about what the SHELL offers — but it has to be a route that exists, or the router
          renders `Not Found` and the nav under test is never drawn at all. `/merge` is chosen for
          being inert on mount: it fetches nothing until somebody types.
        */}
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/merge"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { setToken(null); });

it("offers only the screens the signed-in person holds a permission for", async () => {
  /*
    ═══ FD-9 — THE SAME GRANT, AND ONE FEWER LINK, WHICH IS THE FINDING RATHER THAN A FIXTURE EDIT ═══

    The grant is unchanged: `patients.register` + `billing.invoice.issue`. What changed is that
    `patients.register` now opens NO NAV ROW. `/registration` is deleted, and the front-desk row
    that replaced it — `{ to: "/counter", permission: "opd.visits.open" }`, matching
    `opdManifest.menu`, which `nav-parity.test.ts` compares — rides the VISIT permission, because
    the desk it points at opens visits.

    `front_office` holds both, so the counter clerk this suite describes is unaffected. Two roles
    are: `lab_reception` and `radiology_receptionist` hold `patients.register` WITHOUT
    `opd.visits.open`, and their nav no longer carries a registration door. Their door is the
    command palette's `/counter` command, which is declared on `patients.register` for exactly that
    reason (`components/command-palette.tsx`). Asserted below so the gap is a recorded decision
    rather than something a later reader has to rediscover.
  */
  renderShell(["patients.register", "billing.invoice.issue"]);

  // The billing counter (`nav.billing` = "Counter") is this person's one screen.
  await waitFor(() => expect(screen.getByRole("link", { name: "Counter" })).toBeInTheDocument());

  // The fourteen that would have answered 403 are simply not offered.
  expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Merge review" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "OPD desk" })).not.toBeInTheDocument();
  // PLAN 16a T7 — the formulary desk is `formulary.manage`, held by `pharmacy` alone (DD10). A
  // clerk with a counter permission is not offered it, which is also why the link is invisible on
  // the live deployment today: that role exists and has no holders.
  expect(screen.queryByRole("link", { name: "Formulary" })).not.toBeInTheDocument();
  // FD-9 — and the deleted routes are offered by nobody, under any grant.
  expect(screen.queryByRole("link", { name: "Registration" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Appointment" })).not.toBeInTheDocument();
  // `patients.register` alone does not reach the desk row — `opd.visits.open` is what does.
  expect(screen.queryByRole("link", { name: "Desk One" })).not.toBeInTheDocument();
});

/** FD-9 — and the counter clerk, who holds the visit permission, IS offered the one front desk. */
it("FD-9: a counter clerk is offered Desk One, and it is the only front-desk row in the nav", async () => {
  renderShell(["opd.visits.open", "patients.register", "billing.invoice.issue"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
  expect(hrefs.filter((h) => h === "/counter")).toHaveLength(1);
  expect(hrefs).not.toContain("/registration");
  expect(hrefs).not.toContain("/appointment");
});

/**
 * PLAN 17b T8 — THE LABORATORY'S FOUR, AND THE SEPARATION THAT MATTERS AT THE SHELL.
 *
 * DD16 splits `lab.results.enter` from `lab.results.verify` so a technologist can key numbers all
 * day and sign none. The shell has to honour that: a bench technologist is offered the bench and
 * NOT the signing screen, and offering it would put a person one click from a 403 on the one screen
 * whose whole purpose they may not act on.
 */
it("17b: the bench technologist is offered the bench and NOT verify-and-report", async () => {
  renderShell(["lab.accession.operate", "lab.results.enter", "lab.worklist.read"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Bench" })).toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Verify & report" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Lab desk" })).not.toBeInTheDocument();
});

it("17b: the pathologist is offered verify-and-report", async () => {
  renderShell(["lab.results.verify"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Verify & report" })).toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Bench" })).not.toBeInTheDocument();
});

it("16a: the formulary desk appears for the permission that guards it, and for no other", async () => {
  renderShell(["formulary.manage"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Formulary" })).toBeInTheDocument());
  // `formulary.read` is a PRESCRIBER's permission (the consult autocomplete) and opens no desk.
  expect(screen.queryByRole("link", { name: "Desk One" })).not.toBeInTheDocument();
});

it("a person whose role holds nothing is TOLD SO rather than shown a blank bar", async () => {
  renderShell([]);

  // "The app is broken" and "my account has no access" go to different people; the shell must
  // not make the second look like the first.
  await waitFor(() =>
    expect(screen.getByText(/No screens are available to your role/i)).toBeInTheDocument(),
  );
  expect(screen.queryByRole("link", { name: "Desk One" })).not.toBeInTheDocument();
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
  /*
    FD-9 — THE GRANT LIST GREW BY ONE AND THE ASSERTION MOVED WITH IT.

    It used to grant exactly the counter clerk's three (`opd.visits.open`, `patients.register`,
    `billing.invoice.issue`) and then assert that `/counter` came before `/registration`. The
    owner's 03-Sep ruling DELETED `/registration` — Desk One at `/counter` registers, seats and
    bills as three stages of one session — which left `patients.register` with no nav row at all
    and this test asserting an order between one link and nothing.

    `patients.merge` is added so the Patients group has a member to be ordered AFTER, and the claim
    the test exists to make is unchanged: the desk group leads the row, because the counter is where
    a one-person desk works and it must not be the ninth similar-looking word.
  */
  renderShell(["opd.visits.open", "patients.register", "patients.merge", "billing.invoice.issue"]);
  await waitFor(() => { expect(screen.getByText("Merge review")).toBeInTheDocument(); });

  const nav = screen.getByRole("navigation");
  expect(nav).toHaveTextContent("Desk");
  expect(nav).toHaveTextContent("Patients");
  expect(nav).toHaveTextContent("Billing");

  // Reading order is the order a desk WORKS in: the counter first, not the ninth similar-looking word.
  const text = nav.textContent ?? "";
  expect(text.indexOf("Desk")).toBeLessThan(text.indexOf("Patients"));

  /**
   * ═══ FD-2 — THIS ASSERTION IS ABOUT LINK ORDER, NOT SUBSTRING POSITIONS ═══
   *
   * It used to read `text.indexOf("Counter") < text.indexOf("Registration")` over the nav's whole
   * `textContent`, and that only worked while the desk link was called "Counter" and nothing else
   * in the row contained the word "Registration". FD-2 renamed the desk link and the old form
   * promptly asserted something it never meant. The claim is about ORDER OF LINKS, so it is made
   * against the links themselves — immune to a rename, which is the point: a label is a product
   * decision and should not be able to break a structural test.
   */
  const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
  expect(hrefs.indexOf("/counter")).toBeGreaterThanOrEqual(0);
  expect(hrefs.indexOf("/counter")).toBeLessThan(hrefs.indexOf("/merge"));
  // And the deleted route is not offered by any group: one door to the front desk, not three.
  expect(hrefs).not.toContain("/registration");
  expect(hrefs).not.toContain("/appointment");
});

/** A group with nothing in it must not render its label — an empty heading is furniture. */
it("07b T8: a group the person holds nothing in does not render at all", async () => {
  /*
    FD-9 — `patients.merge` replaces `patients.register` as the one grant here. The claim is about
    EMPTY GROUPS, and it needs a person who holds something in exactly one group: after the deletion
    of `/registration`, `patients.register` opens no nav row at all, so the old fixture would have
    tested the "no screens available" sentence instead. `patients.merge` keeps the Patients group
    populated with one row — and now the DESK group is the empty one, which is a stronger version of
    the same assertion than the original could make.
  */
  renderShell(["patients.merge"]);
  await waitFor(() => { expect(screen.getByText("Merge review")).toBeInTheDocument(); });
  const nav = screen.getByRole("navigation");
  expect(nav).toHaveTextContent("Patients");
  expect(nav).not.toHaveTextContent("Desk");
  expect(nav).not.toHaveTextContent("Stores");
  expect(nav).not.toHaveTextContent("Billing");
});
