import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { router } from "../router";
import { stubFetch } from "../test-utils";
import { isWedgeInput } from "./command-palette";
import { shouldOpenPalette } from "../lib/keyboard";
import "../lib/i18n";

/**
 * PLAN 11h T8 — the palette, driven through the real shell so the hotkey, the provider and the
 * router are all exercised the way a desk exercises them.
 */
function hit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { entity: "patient", id: "p1", title: "Asha Devi", subtitle: "HMS-1 · female", href: "/patients/p1", ...over };
}

function renderApp(opts: { hospital?: string[]; groups?: unknown[]; mode?: string } = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      /*
        FD-9 — `opd.visits.open` joins the default grant. The shell sentinel every test here waits
        on is the front-desk NAV LINK, and that row is `{ to: "/counter", permission:
        "opd.visits.open" }` since `/registration` was deleted. `front_office` holds both, so this
        is the truer fixture; the palette's own `/counter` COMMAND still rides `patients.register`,
        which is what a register-only role reaches the desk by.
      */
      permissions: { hospital: opts.hospital ?? ["opd.visits.open", "patients.register", "patients.read"], scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: opts.mode ?? "commissioning", note: null },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [] },
    "GET /api/search": {
      groups: opts.groups ?? [{ entity: "patient", provider: "patients.patient", hits: [hit()], total: 1, timedOut: false, errored: false }],
      tookMs: 8, skipped: [], auditId: "aud-1",
    },
    "POST /api/search/opened": {},
    "POST /api/patients/qr/verify": { ok: true, patient: { id: "scanned-1" } },
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        {/*
          FD-9 — `/merge`, not `/registration`: that route is deleted with the old front-desk design
          and a memory history pointed at it renders `Not Found`, so the shell that hosts the
          palette is never drawn. Which route this mounts on is incidental to every assertion here.
        */}
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/merge"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { setToken(null); });

const paletteInput = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>("[data-palette-input]");

it("`/` OPENS THE PALETTE — including on screens that never had a search box", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());

  fireEvent.keyDown(window, { key: "/" });

  await waitFor(() => expect(paletteInput()).toBeInTheDocument());
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
});

/**
 * ═══ FD-7 T7 / OWNER RULING 2026-09-03 — `Ctrl+K` DOES NOT OPEN IT, AND THIS ROW IS THE REVERSAL ═══
 *
 * This test asserted the opposite one day earlier ("the shortcut every desk already knows"), added
 * in FD-3 at the owner's own request. The 03-Sep ruling — "no shortcut should overlap chrome browser
 * or any browser internal shortcut keys" — overturns it: `Ctrl+K` is Chrome's address-bar search.
 *
 * Kept as an inverted assertion rather than deleted, for the same reason `keyboard.test.tsx` keeps
 * one: the chord is written down in FD-3's phase doc as an instruction, so the next task to read it
 * needs something that says out loud that it was overturned.
 */
it("Ctrl+K does NOT open it — it belongs to the browser (the 03-Sep ruling)", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());

  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.keyDown(window, { key: "K", metaKey: true });

  expect(screen.queryByRole("dialog")).toBeNull();
  // AND the door still opens by the key that IS the desk's, so this is not a vacuous pass.
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());
});

it("A `/` TYPED INTO AN INPUT IS A CHARACTER, NEVER A COMMAND", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  const someInput = document.createElement("input");
  document.body.appendChild(someInput);
  someInput.focus();

  fireEvent.keyDown(someInput, { key: "/" });

  expect(paletteInput()).toBeNull();
  someInput.remove();
});

it("Escape closes it", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  fireEvent.keyDown(paletteInput()!, { key: "Escape" });

  await waitFor(() => expect(paletteInput()).toBeNull());
});

it("shows results, and marks an APPROXIMATE match as one", async () => {
  renderApp({
    groups: [{
      entity: "patient", provider: "patients.patient",
      hits: [hit({ title: "Asha Devi", meta: { match: "approximate" } })],
      total: 1, timedOut: false, errored: false,
    }],
  });
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  fireEvent.change(paletteInput()!, { target: { value: "aasha" } });

  await waitFor(() => expect(screen.getByText("Asha Devi")).toBeInTheDocument());
  // A guess presented as an exact match is how the wrong patient gets opened.
  expect(screen.getByText("approximate match")).toBeInTheDocument();
});

it("offers COMMANDS the person may reach, and never those they may not", async () => {
  renderApp({ hospital: ["patients.register"], groups: [] });
  /*
    FD-9 — the sentinel is the app TITLE, not a nav link. This test deliberately grants ONE
    permission, and after `/registration` was deleted `patients.register` opens no nav row at all
    (the desk row rides `opd.visits.open`). That is the very asymmetry the assertion below tests:
    the palette still offers `/counter` to this person, because a register-only role — this is
    `lab_reception`'s and `radiology_receptionist`'s exact grant shape — needs a door somewhere.
  */
  await waitFor(() => expect(screen.getByRole("link", { name: "HMIS" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  /*
    FD-9 — the query and the expected row both moved with the screen. `/registration` is deleted;
    the palette's front-desk command is `/counter`, labelled `nav.counterDesk` = "Desk One", still
    on `patients.register` so the row appears for exactly the person who can use it.
  */
  fireEvent.change(paletteInput()!, { target: { value: "desk one" } });

  await waitFor(() => expect(screen.getByRole("button", { name: "Desk One" })).toBeInTheDocument());

  fireEvent.change(paletteInput()!, { target: { value: "user" } });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Users" })).toBeNull());
});

it("A WEDGE SCAN OPENS THE PATIENT; the same payload typed by a human does not", async () => {
  renderApp({ groups: [] });
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  /**
   * A REAL WEDGE DELIVERS CHARACTERS INDIVIDUALLY — the reviewer's MAJOR 7. Typing the payload in
   * one `fireEvent.change` is not how the hardware behaves, and an at-least-one assertion could
   * not have caught the eleven-POSTs-per-scan bug it hid.
   *
   * ═══ THE CLOCK IS DRIVEN, AND THAT IS WHAT STOPS THIS TEST FLAKING (07c) ═══
   *
   * The palette separates a scan from typing by SPEED alone (`WEDGE_MAX_MS = 120`), reading
   * `Date.now()` on every change. Twenty-two `fireEvent.change` calls take well under 120 ms on an
   * idle machine and comfortably OVER it inside a full `pnpm verify`, where the suite shares eight
   * cores with everything else — so this test passed 12/12 in isolation and failed inside loaded
   * runs. It was named as a known flake in the 07a/07b close, which prescribed exactly this: *"it
   * wants an injected clock; it will flake in CI until it gets one."*
   *
   * The clock is driven HERE rather than through a seam in the component, because the component is
   * not what is wrong: reading the real clock is correct behaviour for a scanner detector. What was
   * wrong is a test asserting a timing property while letting the machine's load decide the timing.
   * Five milliseconds per character is what a wedge actually does; the whole payload lands at
   * 110 ms, inside the window and close enough to it to still be a meaningful assertion.
   */
  const realNow = Date.now;
  const base = realNow();
  let tick = 0;
  vi.spyOn(Date, "now").mockImplementation(() => base + tick);

  const payload = "HMISQR0000000000000001";
  try {
    for (let i = 1; i <= payload.length; i += 1) {
      tick = i * 5; // a USB HID wedge's inter-character gap
      fireEvent.change(paletteInput()!, { target: { value: payload.slice(0, i) } });
    }
    expect(tick).toBeLessThan(120); // the payload lands INSIDE the window, on any machine
  } finally {
    vi.mocked(Date.now).mockRestore();
  }

  await waitFor(() => {
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.filter((c) => String(c[0]).includes("/patients/qr/verify"))).toHaveLength(1);
  });
});

describe("the two decisions, asserted directly", () => {
  it("A8 — `/` opens the palette from a screen, and NEVER from inside a field", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    expect(shouldOpenPalette({ key: "/", ctrlKey: false, metaKey: false }, document.body)).toBe(true);
    /*
     * FD-7 T7 / OWNER RULING 2026-09-03 — `Ctrl+K` NO LONGER OPENS IT, and this line used to assert
     * that it did. It is Chrome's address-bar search: "no shortcut should overlap chrome browser or
     * any browser internal shortcut keys". `/` survives the same rule because Chrome does not claim
     * it, and Firefox's Quick Find — unlike `Ctrl+N` — is suppressible by the page.
     */
    expect(shouldOpenPalette({ key: "k", ctrlKey: true, metaKey: false }, document.body)).toBe(false);
    expect(shouldOpenPalette({ key: "K", ctrlKey: false, metaKey: true }, document.body)).toBe(false);
    // The guard: a clinician typing a note must keep their character.
    expect(shouldOpenPalette({ key: "/", ctrlKey: false, metaKey: false }, input)).toBe(false);
    expect(shouldOpenPalette({ key: "/", ctrlKey: false, metaKey: false }, textarea)).toBe(false);
    // And an unrelated key is not a palette key.
    expect(shouldOpenPalette({ key: "a", ctrlKey: false, metaKey: false }, document.body)).toBe(false);
  });

  it("A9 — only LONG AND FAST is a scan", () => {
    expect(isWedgeInput(22, 40)).toBe(true);      // a wedge
    expect(isWedgeInput(22, 3000)).toBe(false);   // a UHID read off a card and typed
    expect(isWedgeInput(4, 20)).toBe(false);      // a fast typist on a short query
  });
});

it("NO MICROPHONE RENDERS while voice is inert — not a disabled one, none at all", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  // A visible-but-refusing control is an invitation to ask for it, and the answer would be a
  // compliance lecture at a busy counter. Voice audio is Class 2 until the DPIA rules otherwise.
  expect(screen.queryByRole("button", { name: /voice|mic|बोल/i })).toBeNull();
});

it("SAYS SO IN DOWNTIME rather than spinning — a desk needs to know to reach for the paper kit", async () => {
  renderApp({ mode: "downtime", groups: [] });
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });

  await waitFor(() => expect(screen.getByTestId("palette-degraded")).toBeInTheDocument());
  expect(screen.getByTestId("palette-degraded")).toHaveTextContent(/paper kit/i);
});

it("in NORMAL mode it says nothing extra", async () => {
  renderApp({ mode: "normal", groups: [] });
  await waitFor(() => expect(screen.getByRole("link", { name: "Desk One" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  expect(screen.queryByTestId("palette-degraded")).toBeNull();
});
