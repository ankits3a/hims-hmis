import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { router } from "../router";
import "../lib/i18n";

/**
 * PLAN 07c T4 — MY DESK, AND `/` STOPS BEING SOMEBODY ELSE'S SCREEN.
 *
 * These render through the REAL router at `/` rather than mounting the component directly, because
 * the assertion this task exists for is about the ROUTE: the index route was an unconditional
 * `throw redirect({ to: "/registration" })` and every authenticated user in the hospital — doctor,
 * cashier, storekeeper, administrator — landed on the patient registration desk. A test that
 * rendered `<Desk />` in isolation would pass with that redirect fully intact.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static reset(): void { FakeWebSocket.instances = []; }
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  simulateOpen(): void { this.readyState = 1; this.onopen?.(); }
  simulateMessage(obj: unknown): void { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

type Reply = { status: number; body: unknown };
/** FD-11 — the handler now sees `init`, so a test can assert what was actually POSTED. */
function mockRoutes(handlers: Record<string, Reply | ((init?: RequestInit) => Reply)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const h = handlers[key];
      if (h === undefined) return new Response("{}", { status: 404 });
      const { status, body } = typeof h === "function" ? h(init) : h;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const HALL = {
  key: "opd.hall",
  band: "now",
  titleKey: "desk.opd.hall",
  topics: ["queue:doc-1:2026-08-29"],
  stats: [
    { key: "desk.opd.waiting", value: "12", href: "/opd/desk" },
    { key: "desk.opd.withVitals", value: "4", href: "/opd/vitals" },
  ],
  rows: [
    { id: "doc-1", badge: "!", title: "Dr Meera Rao", subtitle: "desk.opd.notStarted", severity: "warn", href: "/opd/desk" },
  ],
};
const MY_VISITS = {
  key: "opd.myVisits",
  band: "today",
  titleKey: "desk.opd.myVisits",
  stats: [
    { key: "desk.opd.opened", value: "46", href: "/my-day" },
    { key: "desk.opd.stillHere", value: "3", href: "/opd/desk" },
  ],
};

function renderAt(
  path: string,
  cards: unknown[],
  hospital: string[] = ["opd.queue.read"],
  extra: Record<string, Reply | ((init?: RequestInit) => Reply)> = {},
): void {
  mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } } },
    "GET /api/ops/mode": { status: 200, body: { mode: "commissioning" } },
    "GET /api/alerts": { status: 200, body: { items: [] } },
    "GET /api/patients/search": { status: 200, body: { items: [] } },
    "GET /api/me/desk": { status: 200, body: { date: "2026-08-29", cards } },
    ...extra,
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: [path] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Bring the fake socket up to the point `RealtimeClient` calls itself connected. */
function connect(): void {
  act(() => {
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[0]!.simulateMessage({ type: "authed", userId: "u1" });
  });
}

beforeEach(() => {
  FakeWebSocket.reset();
  resetRealtimeClientForTests();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

const REGISTRATION = {
  key: "patients.registration", band: "today", titleKey: "desk.patients.registration",
  stats: [{ key: "desk.patients.registered", value: "38", href: "/counter" }, { key: "desk.patients.noMobile", value: "2", href: "/counter" }, { key: "desk.patients.duplicatesPending", value: "1", href: "/merge" }],
};
const CAME_BACK = {
  key: "patients.cameBack", band: "today", titleKey: "desk.patients.cameBack",
  stats: [{ key: "desk.patients.duplicatesConfirmed", value: "3", href: "/merge" }, { key: "desk.patients.noMobileMonth", value: "11", href: "/counter" }, { key: "desk.patients.amendedWeek", value: "8", href: "/counter" }],
};
const APPOINTMENTS = {
  key: "opd.appointments", band: "now", titleKey: "desk.appointments.title", topics: ["queue:doc-1:2026-08-29"],
  stats: [{ key: "desk.appointments.dueToday", value: "12", href: "/opd/appointments" }, { key: "desk.appointments.needsRebooking", value: "2", href: "/opd/appointments" }],
  rows: [{ id: "doc-2", badge: "2", title: "Dr Sneha Toppo", subtitle: "desk.appointments.rebookRow", severity: "warn", href: "/opd/appointments" }],
};

describe("FD-1 T5 — the three tiles on the front door, rendered by the home screen unchanged", () => {
  it("registration, what came back and appointments render with their words, their figures as doors, and the rebooking doctor as a row", async () => {
    renderAt("/", [APPOINTMENTS, HALL, REGISTRATION, CAME_BACK, MY_VISITS]);
    expect(await screen.findByText("Registration")).toBeInTheDocument();
    expect(screen.getByText("What came back — last 30 days")).toBeInTheDocument();
    expect(screen.getByText("Appointments")).toBeInTheDocument();
    // a stat with an href renders as a LINK (A2), so the figure is found by its words
    const figure = (card: string, value: string): HTMLElement => within(screen.getByTestId(`stats-${card}`)).getByText(value);
    expect(figure("patients.registration", "38").closest("a")?.getAttribute("href")).toBe("/counter");
    expect(figure("patients.cameBack", "3").closest("a")?.getAttribute("href")).toBe("/merge");
    expect(figure("opd.appointments", "12").closest("a")?.getAttribute("href")).toBe("/opd/appointments");
    expect(screen.getByText("Turned out to be duplicates")).toBeInTheDocument();
    expect(screen.getByText("Registered by me")).toBeInTheDocument();
    expect(screen.getByText("Dr Sneha Toppo")).toBeInTheDocument();
    expect(screen.getByText("patients to rebook — doctor on leave")).toBeInTheDocument();
    expect(screen.getByTestId("stats-patients.registration")).toBeInTheDocument();
    expect(screen.getByTestId("stats-opd.appointments")).toBeInTheDocument();
  });
});

describe("07c T4 — the desk is the front door", () => {
  it("A1: `/` renders the desk, and NOT the registration screen it used to redirect to", async () => {
    renderAt("/", [HALL, MY_VISITS]);

    expect(await screen.findByRole("heading", { name: "My desk" })).toBeInTheDocument();
    // The registration desk's own search box is its signature. Its ABSENCE is the defect being
    // closed: this element was on screen for every doctor and cashier in the hospital.
    expect(document.querySelector("[data-search-input]")).toBeNull();
  });

  it("A1b: the cards the server sent are the cards on screen, in their bands", async () => {
    renderAt("/", [HALL, MY_VISITS]);

    await waitFor(() => { expect(screen.getByText("OPD hall")).toBeInTheDocument(); });
    expect(screen.getByText("Visits I opened")).toBeInTheDocument();
    expect(screen.getByText("Now")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    // The one row the hall names is a DOCTOR, and its subtitle is a key that got translated.
    expect(screen.getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(screen.getByText("Session not started")).toBeInTheDocument();
  });

  /**
   * A2 — EVERY FIGURE IS A DOOR. A number nobody can open is decoration, and decoration on a home
   * screen sends a clerk to find the rows on another screen — the three route changes per patient
   * this plan series exists to delete.
   */
  it("A2: every figure the provider gave an href to is a link to exactly that path", async () => {
    renderAt("/", [HALL, MY_VISITS]);

    await waitFor(() => { expect(screen.getByTestId("fig-desk.opd.waiting")).toBeInTheDocument(); });
    /*
      FD-11 — asserted through the stat's OWN key rather than its rendered value. The figure's label
      now sits inside the link, because a link whose entire accessible name is "12" tells a screen
      reader nothing — it reads "twelve, link" and the user has to hunt for what twelve counts. That
      made `name: "12"` an exact-match miss. Pinning key -> href is the stronger assertion anyway:
      it says WHICH figure goes where, which is the property DD1 is actually about.
    */
    expect(screen.getByTestId("fig-desk.opd.waiting")).toHaveAttribute("href", "/opd/desk");
    expect(screen.getByTestId("fig-desk.opd.withVitals")).toHaveAttribute("href", "/opd/vitals");
    expect(screen.getByTestId("fig-desk.opd.opened")).toHaveAttribute("href", "/my-day");
    expect(screen.getByTestId("fig-desk.opd.stillHere")).toHaveAttribute("href", "/opd/desk");
    // …and they really are links, not divs somebody styled to look like one.
    expect(screen.getByTestId("fig-desk.opd.waiting").tagName).toBe("A");
  });

  /**
   * A3 / DD11 — a dashboard that silently goes on showing a dropped socket's last value is worse
   * than one showing nothing, because nobody distrusts it.
   */
  it("A3: a disconnected socket says so and visibly dims the counts", async () => {
    renderAt("/", [HALL, MY_VISITS]);
    await waitFor(() => { expect(screen.getByTestId("stats-opd.hall")).toBeInTheDocument(); });

    connect();
    await waitFor(() => { expect(screen.getByTestId("desk-live")).toHaveTextContent("Live"); });
    expect(screen.getByTestId("stats-opd.hall").className).not.toContain("dim");

    act(() => { FakeWebSocket.instances[0]!.close(); });

    await waitFor(() => { expect(screen.getByTestId("desk-live")).toHaveTextContent("Not live"); });
    expect(screen.getByTestId("stats-opd.hall").className).toContain("dim");
  });

  it("A3b: the desk subscribes to the union of the topics the CARDS declare, not to a fixed list", async () => {
    renderAt("/", [HALL, MY_VISITS]);
    await waitFor(() => { expect(screen.getByText("OPD hall")).toBeInTheDocument(); });
    connect();

    await waitFor(() => {
      const subs = FakeWebSocket.instances[0]!.sent
        .map((s) => JSON.parse(s) as { type: string; topics?: string[] })
        .filter((f) => f.type === "subscribe")
        .flatMap((f) => f.topics ?? []);
      expect(subs).toContain("queue:doc-1:2026-08-29");
    });
  });

  /** E-1 — "the app is broken" and "my account has no access" go to different people. */
  it("E-1: a person with no cards is TOLD SO rather than shown a blank page", async () => {
    renderAt("/", [], []);
    expect(await screen.findByText(/Nothing is on your desk yet/i)).toBeInTheDocument();
    // …and the way to their own day is still offered: a day with nothing in it is still an answer.
    expect(screen.getByRole("link", { name: /My day/i })).toHaveAttribute("href", "/my-day");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — THE CASH DRAWER GATE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner's ruling: *"I want the welcome dashboard to ask the user to input the cashier drawer details
 * (the billing part). Once the user updates and confirms the details, he can now start
 * registration/appointment process."*
 *
 * A drawer is counted at the START of a shift because the count at the END means nothing without
 * it: `expectedCash = float + collected`. The server already refused cash with no session
 * (`requireOpenSession`) — but that refusal arrived at the till with a patient standing there.
 *
 * The risk in a gate is that it locks out the person it was never about, so that is what most of
 * these assert.
 */
const CLOSED = { status: 200, body: { session: null } };
const OPEN = { status: 200, body: { session: { id: "s1", cashierUserId: "u1", status: "open", openedAt: "2026-08-29T03:25:00.000Z", openingFloatPaise: 372000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } };

describe("FD-11 — the cash drawer is counted before the first patient", () => {
  it("a cashier with no open drawer is asked for it, and the doors will not start", async () => {
    renderAt("/", [REGISTRATION, APPOINTMENTS], ["opd.queue.read", "billing.session.own"], {
      "GET /api/billing/sessions/current": CLOSED,
    });

    expect(await screen.findByTestId("drawer-panel")).toBeInTheDocument();
    // The INFORMATION is never gated — a cashier reads their desk to find out what is waiting.
    expect(screen.getByTestId("stats-patients.registration")).toBeInTheDocument();
    // The ACTION is.
    await waitFor(() => { expect(screen.getByTestId("cta-patients.registration")).toBeDisabled(); });
    expect(screen.getByTestId("cta-opd.appointments")).toBeDisabled();
  });

  it("confirming the float posts PAISE and lets the desk start", async () => {
    const posted: string[] = [];
    let open = false;
    renderAt("/", [REGISTRATION], ["opd.queue.read", "billing.session.own"], {
      "GET /api/billing/sessions/current": () => (open ? OPEN : CLOSED),
      "POST /api/billing/sessions": (init) => { posted.push(init?.body as string); open = true; return { status: 201, body: OPEN.body.session }; },
    });
    const user = userEvent.setup();

    const field = await screen.findByLabelText("Opening float (₹)");
    await user.type(field, "3720.50");
    await user.click(screen.getByTestId("drawer-open"));

    /*
      RUPEES IN, PAISE OUT. The field is rupees because that is what is in the clerk's hand; the wire
      is paise because money here is an integer of the smallest unit everywhere. 3720.50 -> 372050,
      and a float that reached the server as 372049.99999 would be a variance somebody has to
      explain at close.
    */
    await waitFor(() => { expect(posted).toHaveLength(1); });
    expect(posted[0]).toContain('"floatPaise":372050');
    await waitFor(() => { expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument(); });
    expect(screen.getByTestId("cta-patients.registration")).not.toBeDisabled();
  });

  /**
   * TWO DEFENCES, AND THIS PINS BOTH — which took a surviving mutant to notice.
   *
   * `holdsDrawer` appears twice: it disables the session QUERY, and it is a term in `gated`. Removing
   * it from `gated` alone changes nothing observable, because the query never ran and `isSuccess` is
   * false either way — so that mutant survives, and it survives because it is equivalent, not
   * because the rule is untested.
   *
   * What makes each one load-bearing is asserted separately: the clerk is not gated (the semantic
   * rule), AND their browser never asks the billing module a question it would be refused (the
   * query's `enabled`). Drop `enabled` and the second assertion fails; drop the `gated` term and the
   * first one fails the moment `enabled` is ever loosened.
   */
  it("a registration-only clerk holds no drawer, so the gate is not theirs and is never even asked about", async () => {
    renderAt("/", [REGISTRATION], ["opd.queue.read"], {
      "GET /api/billing/sessions/current": CLOSED,
    });

    expect(await screen.findByTestId("stats-patients.registration")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument();
    // and their door works — gating somebody on a drawer they can never open would be a lockout.
    expect(screen.getByTestId("cta-patients.registration")).not.toBeDisabled();

    const asked = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/billing/sessions/current"));
    expect(asked, "a screen must not ask for what its holder cannot have").toEqual([]);
  });

  /**
   * THE DEAD END THE OWNER HIT ON THE PREVIEW: *"I wrongly typed the closing amount. Now I can't
   * undo it and so I can't close the drawer properly and hence can't proceed on to the dashboard."*
   *
   * A count that does not match the till files a variance approval and moves the session to
   * `closing`. The cashier cannot approve their own variance (the kernel refuses requester ==
   * approver) and cannot open a second drawer while that one is live — so the opening-float box this
   * screen used to show them was a form whose ONLY possible outcome was a refusal.
   */
  it("a drawer awaiting a supervisor is not asked to be opened again — that form could only be refused", async () => {
    renderAt("/", [REGISTRATION], ["opd.queue.read", "billing.session.own"], {
      "GET /api/billing/sessions/current": {
        status: 200,
        body: { session: { ...OPEN.body.session, status: "closing", countedCashPaise: 0, expectedCashPaise: 402000, variancePaise: -402000 } },
      },
    });

    expect(await screen.findByTestId("drawer-awaiting")).toBeInTheDocument();
    // the float box is GONE — it is not the way out of this state
    expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Opening float (₹)")).not.toBeInTheDocument();
    // and it points at somewhere that can actually move it
    expect(screen.getByTestId("drawer-goto-session")).toHaveAttribute("href", "/billing/session");
    // the doors stay shut, because the money reason is unchanged: there is no drawer to take cash into
    expect(screen.getByTestId("cta-patients.registration")).toBeDisabled();
  });

  it("a drawer already open is not asked for again", async () => {
    renderAt("/", [REGISTRATION], ["opd.queue.read", "billing.session.own"], {
      "GET /api/billing/sessions/current": OPEN,
    });

    expect(await screen.findByTestId("drawer-open-pill")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("cta-patients.registration")).not.toBeDisabled();
  });
});

/**
 * FD-11 — THE SCHEME TILES CARRY THE SERVER'S COUNTS, AND A BLANK IS NOT A ZERO.
 *
 * The tiles shipped without numbers first, deliberately: the artboard shows a count on each and
 * this codebase's rule is that a plausible number at a cash counter is the worst kind. The owner
 * then asked for the real ones, and three modules now emit them — membership (cards, coupons,
 * packages), billing (panels), partners (attribution) — each behind its own permission.
 *
 * Which makes the important assertion the ABSENT one: a person who does not hold partners sees a
 * partners tile with NOTHING where the number goes, not a zero. "0 attributed today" is a claim
 * about a module they cannot see, and it is a claim this screen has no standing to make.
 */
const SCHEME_CARDS = [
  {
    key: "membership.schemes", band: "today", titleKey: "desk.schemes.title",
    stats: [
      { key: "desk.schemes.membership.n", value: "4", href: "/counter" },
      { key: "desk.schemes.coupons.n", value: "0", href: "/counter" },
      { key: "desk.schemes.packages.n", value: "1", href: "/counter" },
    ],
  },
  {
    key: "billing.panels", band: "today", titleKey: "desk.schemes.title",
    stats: [{ key: "desk.schemes.panels.n", value: "6", href: "/billing/dues" }],
  },
];

describe("FD-11 — schemes in play", () => {
  it("shows the server's count on each tile, and a tile with no provider shows no number at all", async () => {
    renderAt("/", [REGISTRATION, ...SCHEME_CARDS], ["opd.queue.read", "opd.visits.open"]);

    /*
      Wait for the COUNT and not the tile. The schemes band does not depend on `/me/desk`, so the
      tiles are on screen before the figures arrive — waiting on the tile is waiting for nothing and
      asserted an empty count every time.
    */
    expect(await screen.findByTestId("scheme-n-membership")).toHaveTextContent("4");
    // A REAL ZERO IS A FACT and is shown as one: nobody presented a coupon today.
    expect(screen.getByTestId("scheme-n-coupons")).toHaveTextContent("0");
    expect(screen.getByTestId("scheme-n-packages")).toHaveTextContent("1");
    expect(screen.getByTestId("scheme-n-panels")).toHaveTextContent("6");

    // …and the one nobody sent a card for is blank, not zero. The tile is still a door.
    expect(screen.getByTestId("scheme-partners")).toBeInTheDocument();
    expect(screen.queryByTestId("scheme-n-partners")).not.toBeInTheDocument();
  });

  it("the tiles go where the SERVER said, and the scheme cards never appear as doors", async () => {
    renderAt("/", [REGISTRATION, ...SCHEME_CARDS], ["opd.queue.read", "opd.visits.open"]);

    await screen.findByTestId("scheme-n-panels");
    expect(screen.getByTestId("scheme-panels")).toHaveAttribute("href", "/billing/dues");
    expect(screen.getByTestId("scheme-membership")).toHaveAttribute("href", "/counter");
    /*
      They are ordinary desk cards on the wire, so without the filter they would ALSO render as two
      more door tiles in the Today band — the same three numbers twice, once as a door and once as a
      scheme.
    */
    expect(screen.queryByTestId("door-membership.schemes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("door-billing.panels")).not.toBeInTheDocument();
    expect(screen.getByTestId("door-patients.registration")).toBeInTheDocument();
  });
});
