import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "./lib/auth";
import { setToken } from "./lib/api";
import { router } from "./router";
import { stubFetch } from "./test-utils";
import i18next from "./lib/i18n";

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
    "GET /api/opd/summary": { departments: [] },
    "GET /api/billing/session/current": { session: null },
    "GET /api/me/figures": { registered: 0, visits: 0, collected: 0, waiting: 0 },
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

    ═══ FD-25 — AND THAT GAP IS NOW CLOSED, WHICH IS WHY THIS TEST CHANGED ═══

    `patients.register` opens a nav row again, because `/registration` is a real route again for a
    real second seat. Read the paragraph above as history: `lab_reception` and
    `radiology_receptionist` were the two roles it named as having no registration door but the
    command palette, and they are the two roles that get one back here — WITHOUT gaining
    `opd.visits.open`, which they should not have and still do not.

    That is the second time this file has recorded a real access consequence of a nav decision
    rather than a fixture edit, and it is worth keeping both halves: the deletion cost two roles a
    door, and restoring the route gave it back to exactly those two.
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
  // FD-25 — `patients.register` reaches the REGISTRATION seat, and this is the assertion that
  // records the reversal: it read `not.toBeInTheDocument()` while the route was deleted.
  expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument();
  // `/appointment` is still deleted, so it is still offered by nobody under any grant.
  expect(screen.queryByRole("link", { name: "Appointment" })).not.toBeInTheDocument();
  // …and it still does NOT reach Desk One. `opd.visits.open` is what does, and these two roles do
  // not hold it — a seat offered to somebody who would 403 on arrival is worse than no seat.
  expect(screen.queryByRole("link", { name: "Desk One" })).not.toBeInTheDocument();
});

/**
 * ═══ FD-25 — TWO SEATS, EACH OFFERED ONCE. THE GUARD IS "ONCE", NOT "ONE ROW" ═══
 *
 * FD-9 asserted that Desk One was the ONLY front-desk row, because the hospital staffed one person
 * and three names for one job is what put the owner on the wrong counter in FD-1.
 *
 * The hospital now staffs three seats and `/registration` is a real route again. That does NOT
 * re-open FD-1's defect, and the difference is worth stating precisely because it is the thing a
 * future reader will get wrong: FD-1's defect was two names for ONE SCREEN. These are two screens
 * for two staffing shapes — `/counter` on `opd.visits.open` is one person doing registration,
 * appointment and billing as stages of one session; `/registration` on `patients.register` is a
 * clerk who registers and routes and holds no drawer.
 *
 * So the invariant that survives is EXACTLY-ONCE-EACH, and it is the one that would actually catch
 * a regression: a duplicated row, or a row appearing under a permission its holder does not have.
 */
/**
 * ═══ FD-25 — NO TWO NAV ROWS MAY READ THE SAME ═══
 *
 * FOUND BY LOOKING, not by this suite: `/appointment` and `/opd/appointments` both rendered the
 * label "Appointments", one under DESK and one under OPD, a centimetre apart. Both rows were
 * correct in their own file; the defect only exists in the relationship between them, which is why
 * nothing failed.
 *
 * A nav is a list of PLACES. Two places a person cannot tell apart is FD-1's defect — the one that
 * put the owner on the wrong counter and had them report the right screen as broken — and it will
 * recur every time a screen is named after its noun instead of its job. So it is mechanical now:
 * whatever a person holds, no two links they are offered may carry the same words.
 */
it("FD-25: no two nav rows a person can see read the same", async () => {
  /* An owner-shaped grant list: the widest nav anybody gets, which is where collisions surface. */
  renderShell([
    "opd.visits.open", "patients.register", "opd.appointments.manage", "opd.appointments.read",
    "patients.merge", "billing.invoice.issue", "opd.masters.manage", "opd.vitals.record",
    "staff.reports.read", "approvals.requests.read",
  ]);
  /*
    Waits on a row this test does NOT make a claim about. Anchoring the wait on "Booking desk" —
    the label the first version of this guard was written to protect — made the test fail on the
    WAIT rather than on the duplicate assertion when that label regressed, which is a proof of
    nothing. A guard must fail on its own claim.
  */
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  const labels = screen.getAllByRole("link").map((a) => a.textContent?.trim() ?? "");
  const seen = new Map<string, number>();
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([label]) => label);
  expect(duplicated, `these nav labels appear more than once, so a clerk cannot tell the places apart: ${duplicated.join(", ")}`).toEqual([]);
});

it("FD-25: a clerk holding all three seat grants is offered each seat exactly once, and Desk One is not a fourth", async () => {
  /*
    ALL THREE GRANTS, and the third one is the point of the fixture: `/appointment` rides
    `opd.appointments.manage`, which is a DIFFERENT key from the other two. The first version of
    this test asserted the appointment row while granting only the counter clerk's three, and it
    failed — correctly. A row must appear for the grant that opens it and for no other, so a test
    asserting a row must hold that row's key or it is asserting a privacy defect.
  */
  renderShell(["opd.visits.open", "patients.register", "opd.appointments.manage", "billing.invoice.issue"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
  /*
    FD-25 — AND DESK ONE IS NOT A FOURTH DOOR. The owner ruled on 2026-09-05 that `/counter` keeps
    working and leaves the nav: the row is a recommendation ("here is where you work") and offering
    four front-desk entries to a clerk who works at one is how a nav stops being read. The ROUTE
    still serves — a one-person desk wants exactly that screen — and the command palette still
    offers it by name, which is a search rather than a menu.
  */
  expect(hrefs).not.toContain("/counter");
  expect(hrefs.filter((h) => h === "/registration")).toHaveLength(1);
  /*
    FD-25 — and `/appointment` too, now that its screen exists. THREE SEATS, EACH OFFERED ONCE, is
    the invariant that survives FD-9's "only one front-desk row": that ruling was about three NAMES
    for one job, and these are three screens for three staffing shapes. A duplicated row, or a row
    offered to somebody who would 403 on arrival, still fails here.
  */
  expect(hrefs.filter((h) => h === "/appointment")).toHaveLength(1);
});

/**
 * THE HALF THAT MATTERS MORE: a seat is offered to the grant that opens it AND TO NOBODY ELSE. A
 * registration clerk holding no `opd.visits.open` must not be shown Desk One — being offered a
 * screen that 403s on arrival is how a clerk learns to distrust the nav.
 */
it("FD-25: the registration clerk is offered the registration seat and NOT Desk One", async () => {
  renderShell(["patients.register"]);
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
  expect(hrefs.filter((h) => h === "/registration")).toHaveLength(1);
  expect(hrefs).not.toContain("/counter");
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
  /*
    FD-25 — DESK ONE IS NO LONGER A ROW, on the owner's 2026-09-05 ruling: keep it working, keep it
    out of the nav. So the desk group's leading row is `/registration`, and this test's claim is
    unchanged — the group a front desk works in reads before the patient-record rows. The absence is
    asserted below rather than left implied, because "the row quietly came back" is exactly the
    regression a ruling like this suffers.
  */
  expect(hrefs).not.toContain("/counter");
  expect(hrefs.indexOf("/registration")).toBeGreaterThanOrEqual(0);
  expect(hrefs.indexOf("/registration")).toBeLessThan(hrefs.indexOf("/merge"));
  /*
    FD-25 — `/registration` is asserted here and `/appointment` is NOT, and the difference is the
    fixture rather than an oversight: this person holds `patients.register` but not
    `opd.appointments.manage`, so the appointment row correctly does not appear for them. The claim
    this test makes is about GROUP ORDER, and one desk row proves it. Widening the grant to force a
    third row in would be changing the fixture to suit the assertion.
  */
  expect(hrefs).not.toContain("/appointment");
});

/** A group with nothing in it must not render its label — an empty heading is furniture. */
it("07b T8: a group the person holds nothing in does not render at all", async () => {
  /*
    FD-9 — `patients.merge` replaces `patients.register` as the one grant here. The claim is about
    EMPTY GROUPS, and it needs a person who holds something in exactly one group.

    FD-25 — AND IT STILL HAS TO BE `patients.merge`, FOR A NEW REASON. FD-9's reason was that
    `patients.register` opened no nav row at all once `/registration` was deleted, so the old
    fixture would have tested the "no screens available" sentence instead. That reason has expired:
    `/registration` is back and `patients.register` opens it. The grant is still correct because
    `/registration` sits in the DESK group, so `patients.register` would populate TWO groups and
    this test needs exactly one. `patients.merge` populates Patients alone and leaves DESK empty,
    which is still the assertion being made.
  */
  renderShell(["patients.merge"]);
  await waitFor(() => { expect(screen.getByText("Merge review")).toBeInTheDocument(); });
  const nav = screen.getByRole("navigation");
  expect(nav).toHaveTextContent("Patients");
  expect(nav).not.toHaveTextContent("Desk");
  expect(nav).not.toHaveTextContent("Stores");
  expect(nav).not.toHaveTextContent("Billing");
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — DESK ONE OWNS THE VIEWPORT, AND "COVERED" IS NOT "GONE"
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Found by driving the real screen and reading the DOM, not by a failing test. `.d1` is
 * `position: fixed; inset: 0; z-index: 40` over an opaque ground, and the shell was still rendering
 * its header, its sixteen nav links, the bell, language, theme and log out UNDERNEATH it. Measured:
 * `elementFromPoint()` at the "Counter" link's centre returned the desk's cash-float pill, and Tab
 * from the desk walked into eight links whose focus ring is painted under an opaque layer.
 *
 * Every assertion here is a ROLE and not a class, because the defect was never visual — the pixels
 * were always right. It was a landmark and a tab stop that a sighted mouse user could not reach and
 * a keyboard or screen-reader user could not escape.
 */
it("FD-11: the shell renders no chrome under Desk One — not hidden, not present", async () => {
  renderShell(["opd.visits.open", "patients.register", "billing.invoice.issue"]);
  /*
    `router` is a MODULE SINGLETON and `RouterProvider`'s `history` only takes on the first mount in
    a file, so a test that merely asks to start at `/counter` silently renders whatever the previous
    test left behind — which is how this assertion passed alone and failed in the suite. Navigate.
  */
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());

  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  // The doors FD-9 deleted were still being offered by the covered nav.
  expect(screen.queryByRole("link", { name: "Desk One" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
});

/**
 * The other half of the same ruling: suppressing the chrome must be scoped to routes that ASK for
 * it. A ternary is trivially invertible and every assertion above would still pass if it were —
 * they would pass on every screen in the application.
 */
it("FD-11: an ordinary route still gets the whole shell", async () => {
  renderShell(["opd.visits.open", "patients.register", "billing.invoice.issue"]);
  await act(async () => { await router.navigate({ to: "/merge" }); });

  await waitFor(() => expect(screen.getByRole("banner")).toBeInTheDocument());
  expect(screen.getByRole("navigation")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
});

/**
 * FD-11 — the desk stamps the script on its own root, exactly as the sign-in screen does.
 *
 * `desk-one.css` fixes `.tag`'s three Latin assumptions under `.d1[data-lang="hi"]`, so the
 * ATTRIBUTE is the fix: without it the override cannot match and every Devanagari label on the desk
 * silently falls back to whatever face the terminal happens to have. Asserted here rather than left
 * to a reviewer noticing a missing attribute — it has no pixels of its own to go wrong visibly.
 */
it("FD-11: Desk One stamps the script on its root so the Devanagari type rules can apply", async () => {
  renderShell(["opd.visits.open", "patients.register", "billing.invoice.issue"]);
  await act(async () => { await router.navigate({ to: "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  expect(screen.getByTestId("desk-one")).toHaveAttribute("data-lang", "en");

  await act(async () => { await i18next.changeLanguage("hi"); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toHaveAttribute("data-lang", "hi"));
  await act(async () => { await i18next.changeLanguage("en"); });
});
