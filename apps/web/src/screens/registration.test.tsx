import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { router } from "../router";
import { stubFetch } from "../test-utils";
import "../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 SCREEN 1 — `/registration`, THE REGISTRATION CLERK'S SEAT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * These drive the REAL ROUTE through the real router, not the component in isolation, because two
 * of the four things most likely to be wrong here are ROUTING facts and cannot be seen any other
 * way: whether the global `F4` chord steals the key from this screen, and whether the screen is
 * reachable at all under the permission it claims.
 *
 * The suite is organised around what would actually go wrong at a counter rather than around the
 * component's structure. Every test below either guards a server rule the screen must not walk into
 * (`minor_needs_guardian`, `alias_required`) or a lesson this lane has already paid for.
 */

const FARIDA = {
  id: "p-1", uhid: "U00110012", name: "Farida Khatoon", phone: "9835041772",
  administrativeGender: "female", dob: "1975-03-02", isConfidential: false, hasPhoto: false,
  district: "Hajipur", registeredOn: "2020-12-01T00:00:00.000Z", matchedOn: ["phone"],
};

const DEPT = { id: "d-1", code: "MED", name: "General Medicine", active: true };
const DOCTOR = {
  id: "doc-1", userId: "u-doc", displayName: "Dr Nishant Rao", departmentId: "d-1",
  active: true, registrationNo: "MCI-1", roomId: "r-1",
};

/** A doctor with a queue, as `GET /opd/queues/summary` returns it — the ONLY source of the wait. */
const SUMMARY = {
  doctor: DOCTOR, sessionId: "s-1", status: "open" as const,
  waitingCount: 6, waitingVitalsCount: 0, nowServing: 3,
  scheduledToday: true, roomCode: "G-12", avgConsultMinutes: 12, onLeaveToday: false,
};

function mount(
  posted: { url: string; body: unknown }[],
  over: Record<string, unknown> = {},
): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        /*
          EXACTLY THE REGISTRATION CLERK'S GRANTS, and deliberately NOT billing's. `front_office`
          holds no `billing.session.own` and no `billing.invoice.read`; a screen that quietly needed
          them would 403 twice per patient on the seat it was built for, which is why this screen
          does not mount `DeskProvider`. The fixture is the guard on that decision.
        */
        hospital: [
          "patients.register", "patients.read", "patients.update",
          "opd.visits.open", "opd.masters.read", "opd.queue.read",
        ],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [FARIDA] },
    "GET /api/patients/abha/capability": {
      configured: false, canRecord: true, canCreate: false, canVerify: false,
      reason: "This hospital is not connected to ABDM — an ABHA can be recorded, not verified.",
    },
    "GET /api/opd/departments": { items: [DEPT] },
    "GET /api/opd/doctors": { items: [DOCTOR] },
    "GET /api/opd/queues/summary": { items: [SUMMARY] },
    "GET /api/opd/continuity": { anchor: null },
    "POST /api/opd/triage": { suggestions: [{ departmentId: "d-1", reason: "chest pain" }], source: "keywords" },
    "POST /api/patients": (init?: RequestInit, url?: string) => {
      posted.push({ url: url ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
      return { patient: { id: "p-new", uhid: "U00110013", name: "New Patient", dob: null, phone: null, addressLine: null } };
    },
    "POST /api/opd/walk-in": (init?: RequestInit, url?: string) => {
      posted.push({ url: url ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
      return { patientId: "p-new", registered: true, tokenNo: 7, encounter: { id: "e-1" }, queueEntry: {}, sessionId: "s-1", roomId: "r-1", visitType: "new", doctorScheduledToday: true };
    },
    ...over,
  });
  setToken("t");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/registration"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/**
 * THE ROUTE IS DRIVEN, NOT REQUESTED — and this cost four failures before it was written this way.
 *
 * `router` is a MODULE SINGLETON, and `RouterProvider`'s `history` prop only takes on the FIRST
 * mount in a test file. So `initialEntries: ["/registration"]` positions the first test and every
 * test after it inherits wherever the router was left — including wherever the `F4` test navigated.
 * The first eight passed and the last four could not find the screen at all.
 *
 * `registration-fields.test.tsx` documents this exact trap in its own comment, naming
 * `shell-nav.test.tsx` and `triage-debounce.test.tsx` as the two files that hit it before it did.
 * That makes this the fourth time; the navigate is what makes each test independent of the last.
 */
async function arrive(): Promise<void> {
  await act(async () => { await router.navigate({ to: "/registration" }); });
  await waitFor(() => { expect(screen.getByTestId("registration-seat")).toBeInTheDocument(); });
}

/**
 * SEARCH FIRST, THEN REGISTER — and the tests take that road rather than a shortcut, because it IS
 * the design. The "Register new" button lives with the search hits on purpose: the owner's ruling
 * is that a clerk looks before typing a single form field, and a helper that opened the form
 * directly would let a screen that had lost the search-first flow keep passing this suite.
 */
async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  /*
    The form is on screen from the start (see the first test), so this is the SEARCH-THEN-REGISTER
    road rather than a way to reveal it: the clerk looks, decides none of the hits is the person in
    front of them, and presses "Register new" — which clears whatever a previous patient left behind.
    Taking that road here rather than typing straight into the form keeps these tests honest about
    the flow the owner ruled for.
  */
  await user.type(screen.getByTestId("reg-search"), "Farida");
  await waitFor(() => { expect(screen.getByTestId("register-new")).toBeInTheDocument(); }, { timeout: 3000 });
  await user.click(screen.getByTestId("register-new"));
  /*
    THE QUERY IS NOT THROWN AWAY. A clerk who typed a name into the find box and found nobody has
    already typed that name; making them type it again is the small tax that teaches a desk to stop
    searching first. So "Register new" CARRIES the query into the name field, and this asserts it —
    a later refactor that "cleared the form properly" would silently reintroduce the double-typing.
  */
  await waitFor(() => { expect(screen.getByTestId("reg-name")).toHaveValue("Farida"); });
}

afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("FD-25: the registration seat opens on the search box", () => {
  /**
   * ═══ SEARCH-FIRST IS ENFORCED BY FOCUS, NOT BY HIDING THE FORM ═══
   *
   * The first build of this screen hid the form until "Register new" was pressed, reasoning that
   * search-first meant form-later. The signed-off artboard does not: it draws the search box and
   * the form together, with no conditional around the form. A screenshot of the built screen showed
   * why that matters — a 1440×980 counter monitor with one search box and six hundred pixels of
   * empty paper under it.
   *
   * So what this asserts is what actually enforces the ruling: THE FIND BOX HAS THE CURSOR when the
   * screen opens. That is the mechanism; a hidden form was only a proxy for it, and an expensive one.
   */
  it("opens with the cursor already in the find box, and the form ready below it", async () => {
    mount([]);
    await arrive();
    expect(screen.getByTestId("reg-search")).toHaveFocus();
    expect(screen.getByTestId("reg-form")).toBeInTheDocument();
    /* The helper says WHY in the same breath, which is the other half of the ruling. */
    expect(screen.getByText(/a duplicate stopped here costs nothing/i)).toBeInTheDocument();
  });

  /**
   * THE RAIL ANSWERS "WHO IS THIS", AND IT ANSWERS DURING A REGISTRATION TOO.
   *
   * Found by looking: it read "Nobody at the counter yet" while the clerk was typing that person's
   * name into the form beside it — literally true, since there is no UHID yet, and useless. The
   * empty state now means what it says: nobody, not even a draft.
   */
  it("shows the person being registered before they have a UHID, marked as not yet registered", async () => {
    mount([]);
    await arrive();
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("reg-name"), "Aarav Khatoon");
    await user.type(screen.getByTestId("reg-age"), "8");

    await waitFor(() => { expect(screen.getByTestId("rail-drafting")).toBeInTheDocument(); });
    expect(screen.getByTestId("rail-name")).toHaveTextContent("Aarav Khatoon");
    expect(screen.queryByTestId("rail-empty")).not.toBeInTheDocument();
    /* …and the rail carries the one thing that will stop the registration, where the eye rests. */
    expect(screen.getByTestId("rail-drafting")).toHaveTextContent(/guardian required/i);
  });

  it("finds a patient and puts them in the rail — the rail is empty until then", async () => {
    mount([]);
    await arrive();
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("reg-search"), "Farida");
    await waitFor(() => { expect(screen.getByTestId("hit-p-1")).toBeInTheDocument(); }, { timeout: 3000 });
    await user.click(screen.getByTestId("hit-p-1"));

    expect(screen.getByTestId("rail-name")).toHaveTextContent("Farida Khatoon");
    expect(screen.queryByTestId("rail-empty")).not.toBeInTheDocument();
  });
});

describe("FD-25: the two server rules this screen must never walk into", () => {
  /**
   * ═══ `minor_needs_guardian` — THE PAEDIATRIC WALK-IN ═══
   *
   * `POST /patients` has always refused a KNOWN minor with no guardian (D-31, DPDP §9). The block
   * therefore opens ITSELF on the age rather than waiting for the clerk to remember, and submit is
   * refused before the server has to refuse it — a 400 the screen could see coming is a 400 the
   * clerk cannot do anything about.
   */
  it("a child cannot be registered until a guardian is named, and the block appears on the age", async () => {
    mount([]);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);

    await user.type(screen.getByTestId("reg-name"), "Aarav Khatoon");
    await user.click(screen.getByTestId("reg-sex-male"));
    await user.type(screen.getByTestId("reg-age"), "35");
    expect(screen.queryByTestId("guardian-block")).not.toBeInTheDocument();
    expect(screen.getByTestId("reg-submit")).toBeEnabled();

    /* The age is what decides, not the clerk remembering — so it appears on the way DOWN too. */
    await user.clear(screen.getByTestId("reg-age"));
    await user.type(screen.getByTestId("reg-age"), "8");
    await waitFor(() => { expect(screen.getByTestId("guardian-block")).toBeInTheDocument(); });
    expect(screen.getByTestId("reg-submit")).toBeDisabled();

    await user.type(screen.getByTestId("guardian-name"), "Imran Khatoon");
    await user.click(screen.getByTestId("guardian-relationship-mother"));
    expect(screen.getByTestId("reg-submit")).toBeEnabled();
  });

  /**
   * ═══ THE FOUR AUTHORITIES, WHICH NOTHING HAD EVER SENT ═══
   *
   * The server has stored `authorityMessages`/`Bills`/`Consents`/`Dsr` since the guardians table
   * existed and no client had ever supplied one, so every guardian on the deployed system holds
   * COLUMN DEFAULTS — and `consents` defaults TRUE, which is not what the signed-off artboard says.
   * The screen's initial pills and what it posts must agree, or the control is decoration.
   */
  it("posts the four guardian authorities the pills are actually showing", async () => {
    const posted: { url: string; body: unknown }[] = [];
    mount(posted);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);

    await user.type(screen.getByTestId("reg-name"), "Aarav Khatoon");
    await user.click(screen.getByTestId("reg-sex-male"));
    await user.type(screen.getByTestId("reg-age"), "8");
    await waitFor(() => { expect(screen.getByTestId("guardian-block")).toBeInTheDocument(); });
    await user.type(screen.getByTestId("guardian-name"), "Imran Khatoon");
    await user.click(screen.getByTestId("guardian-relationship-mother"));

    /* The artboard's defaults: messages and bills ON, consents and records OFF. */
    expect(screen.getByTestId("guardian-authority-messages")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("guardian-authority-consents")).toHaveAttribute("aria-checked", "false");
    /* Withhold the bills authority — a `false` that must survive the wire, not be omitted. */
    await user.click(screen.getByTestId("guardian-authority-bills"));

    await user.click(screen.getByTestId("reg-submit"));
    await waitFor(() => { expect(posted).toHaveLength(1); });
    const body = posted[0]!.body as { guardian: Record<string, unknown> };
    expect(body.guardian).toMatchObject({
      name: "Imran Khatoon", relationship: "mother",
      authorityMessages: true, authorityBills: false,
      authorityConsents: false, authorityDsr: false,
    });
  });

  /**
   * ═══ `alias_required` — THE TICK THAT WAS A 400 AT THE COUNTER ═══
   *
   * `registration.ts` refuses `isConfidential` with no alias. Desk One sent the flag and had no
   * alias field, so this box could not be used at all. Same discipline as the guardian: the screen
   * refuses before the server has to.
   */
  it("a sealed record cannot be submitted without the alias the server demands", async () => {
    const posted: { url: string; body: unknown }[] = [];
    mount(posted);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);

    await user.type(screen.getByTestId("reg-name"), "Staff Member");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.type(screen.getByTestId("reg-age"), "39");

    await user.click(screen.getByTestId("fold-confidential"));
    await user.click(screen.getByTestId("reg-confidential"));
    expect(screen.getByTestId("reg-submit")).toBeDisabled();

    await user.type(screen.getByTestId("reg-alias"), "Patient 44");
    expect(screen.getByTestId("reg-submit")).toBeEnabled();
    await user.click(screen.getByTestId("reg-submit"));

    await waitFor(() => { expect(posted).toHaveLength(1); });
    const body = posted[0]!.body as { isConfidential?: boolean; alias?: string };
    expect(body.isConfidential).toBe(true);
    expect(body.alias).toBe("Patient 44");
  });
});

describe("FD-25: the two doors to a doctor, and the proposal that names its rule", () => {
  /**
   * NEITHER DOOR IS THE FALLBACK — the artboard is explicit. A clerk who KNOWS the doctor should
   * not have to describe a symptom; a clerk who does not should not have to guess a name.
   *
   * And the proposal is NEVER A SILENT ASSIGNMENT: the card names the rule that fired and carries
   * the reason in prose, because the patient is standing there asking why.
   */
  it("the complaint door routes through triage and the card names the rule and the wait", async () => {
    mount([]);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);

    await user.type(screen.getByTestId("reg-name"), "Farida Khatoon");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.type(screen.getByTestId("reg-complaint"), "seene mein dard");

    await waitFor(() => { expect(screen.getByTestId("routing-proposal")).toBeInTheDocument(); }, { timeout: 3000 });
    expect(screen.getByTestId("routing-doctor")).toHaveTextContent("Dr Nishant Rao");
    /* Rule 2, because `GET /opd/continuity` answered with no anchor: nobody has seen them here. */
    expect(screen.getByTestId("routing-rule")).toHaveTextContent("Rule 2");
    /* 6 waiting × 12 min — the wait comes from the queue summary, never from the screen's guess. */
    expect(screen.getByTestId("routing-wait")).toHaveTextContent("72m");
    expect(screen.getByTestId("routing-reason")).not.toBeEmptyDOMElement();
  });

  /**
   * ═══ THE BADGE MUST NOT CONTRADICT THE RULE IT SITS BESIDE ═══
   *
   * FOUND BY LOOKING, not by this suite: a card headed "Rule 3 · the department queue", saying "No
   * doctor is free in this department", wore a green badge reading "shortest wait" — a claim about
   * a comparison that never happened, on the one card whose point is that there was nobody to
   * compare. The badge logic was `continuity ? seenBefore : shortestWait`, correct for the two
   * rules that pick a doctor and wrong for the third.
   *
   * A badge is a claim. One the card's own heading contradicts teaches a clerk to stop reading both.
   */
  it("says nobody is assigned — not 'shortest wait' — when no doctor is available at all", async () => {
    mount([], { "GET /api/opd/queues/summary": { items: [{ ...SUMMARY, scheduledToday: false }] } });
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);
    await user.type(screen.getByTestId("reg-complaint"), "seene mein dard");

    await waitFor(() => { expect(screen.getByTestId("routing-proposal")).toBeInTheDocument(); }, { timeout: 3000 });
    expect(screen.getByTestId("routing-rule")).toHaveTextContent(/department queue/i);
    expect(screen.getByTestId("routing-badge")).toHaveTextContent(/nobody assigned/i);
    expect(screen.getByTestId("routing-badge")).not.toHaveTextContent(/shortest/i);
    /* …and the button must not offer to open a visit there is no doctor for. */
    expect(screen.getByTestId("reg-submit")).toHaveTextContent("Register only");
  });

  it("the doctor-by-name door proposes that doctor without a complaint being typed", async () => {
    mount([]);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);

    await user.type(screen.getByTestId("reg-name"), "Farida Khatoon");
    await user.click(screen.getByTestId("reg-sex-female"));
    await user.type(screen.getByTestId("reg-doctor"), "Rao");
    await user.click(await screen.findByTestId("doctor-doc-1"));

    await waitFor(() => { expect(screen.getByTestId("routing-proposal")).toBeInTheDocument(); });
    expect(screen.getByTestId("routing-doctor")).toHaveTextContent("Dr Nishant Rao");
  });

  /**
   * THE BUTTON SAYS WHICH OF THE TWO THINGS IT WILL DO. Registering somebody who is not seeing a
   * doctor today is an ordinary thing a front desk does — a lab test, a card, an admission tomorrow
   * — so the label changes rather than the button silently doing something else.
   */
  it("registers and opens the visit in ONE call once a doctor is chosen", async () => {
    const posted: { url: string; body: unknown }[] = [];
    mount(posted);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);

    await user.type(screen.getByTestId("reg-name"), "Farida Khatoon");
    await user.click(screen.getByTestId("reg-sex-female"));
    expect(screen.getByTestId("reg-submit")).toHaveTextContent("Register only");

    await user.type(screen.getByTestId("reg-doctor"), "Rao");
    await user.click(await screen.findByTestId("doctor-doc-1"));
    await waitFor(() => { expect(screen.getByTestId("reg-submit")).toHaveTextContent("Register and open the visit"); });

    await user.click(screen.getByTestId("reg-submit"));
    await waitFor(() => { expect(posted).toHaveLength(1); });
    /*
      ONE CALL, and it is the walk-in. The token and its paper are one event (FD-24 T5 queues both
      inside the visit's own transaction), so a registration that succeeded and a seating that
      failed would leave a patient holding a UHID, no token and a slip that never printed.
    */
    expect(posted[0]!.url).toContain("/opd/walk-in");
  });
});

describe("FD-25: the keys, and the one that would have stolen the patient", () => {
  /**
   * ═══ F4 IS BOUND LOCALLY OR THIS SEAT LOSES ITS PATIENT MID-REGISTRATION ═══
   *
   * `lib/keyboard.tsx` binds `F4` GLOBALLY to `navigate({ to: "/counter", search: { new: true } })`
   * — correct everywhere except here, where `F4` is this screen's own "Register new". A clerk
   * halfway through a registration who pressed it would be thrown onto Desk One with the form gone.
   *
   * This is the test that fails if the capture-phase binding or its `stopPropagation` is removed,
   * and it asserts the ROUTE, because the defect is a navigation and nothing else would show it.
   */
  it("F4 opens the form HERE and does not navigate to Desk One", async () => {
    mount([]);
    await arrive();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", bubbles: true }));
    });
    await waitFor(() => { expect(screen.getByTestId("reg-form")).toBeInTheDocument(); });
    expect(router.state.location.pathname).toBe("/registration");
  });

  /**
   * THE HEADER BUTTON DRAWS AN `Esc` KEYCAP, SO `Esc` MUST DO WHAT IT SAYS. "A keycap that lies is
   * worse than none" is this design system's own rule — a clerk presses it, nothing happens, and
   * they learn the screen is broken.
   */
  it("Escape returns the cursor to the search box, which is what the keycap claims", async () => {
    mount([]);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);
    await user.type(screen.getByTestId("reg-name"), "Somebody");
    expect(screen.getByTestId("reg-name")).toHaveFocus();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.getByTestId("reg-search")).toHaveFocus();
  });
});

describe("FD-25: the co-pilot answers from this screen and says what it cannot see", () => {
  /**
   * "The co-pilot is non-negotiable" means a dock wired to THIS screen's real state, answering THIS
   * screen's real questions. There is no model behind it — FD-8 measured the gateway at 22–40 s,
   * which is not an answer a clerk with a queue can wait for — so every answer names its source and
   * the scope answer says plainly what it cannot look up. A dock that bluffs is worse than none.
   */
  it("answers a guardian question from the age actually typed", async () => {
    mount([]);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await openForm(user);
    await user.type(screen.getByTestId("reg-age"), "8");

    await user.type(screen.getByTestId("agent-ask"), "does this child need a guardian?");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("agent-dock")).toHaveTextContent("a guardian is required");
    });
  });

  it("says what it cannot see rather than guessing", async () => {
    mount([]);
    await arrive();
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId("agent-ask"), "what is the ward occupancy tonight");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("agent-dock")).toHaveTextContent("I answer from what is on this screen");
    });
  });
});
