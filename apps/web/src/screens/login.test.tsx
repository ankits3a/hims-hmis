import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getToken, setToken } from "../lib/api";
import i18next from "../lib/i18n";
import { renderWithProviders, stubFetch } from "../test-utils";
import { LoginScreen } from "./login";

/**
 * PLAN 11e T6 added the forced-change fork and removed this screen's client-side password floor.
 * `useNavigate` is mocked for the whole file so the fork is observable; the three tests that
 * predate 11e do not assert on navigation and are unaffected by it.
 */
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

describe("LoginScreen", () => {
  beforeEach(async () => {
    setToken(null);
    localStorage.clear();
    navigate.mockClear();
    /*
      i18next is a MODULE SINGLETON, so the Hindi test below leaks its language into every test that
      runs after it — which is how three unrelated assertions started failing on a screen whose
      behaviour had not changed. Clearing localStorage is not enough: that is only where the choice
      is persisted, not where it currently lives.
    */
    await i18next.changeLanguage("en");
  });

  it("renders a validation alert for both fields when submitted empty — zod resolver wired in", async () => {
    stubFetch({});
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(2);
  });

  it("stores the token and loads the actor on a successful sign-in", async () => {
    const calls: string[] = [];
    stubFetch({
      "POST /api/auth/login": (init?: RequestInit) => {
        calls.push(`POST /api/auth/login ${init?.body as string}`);
        return { token: "tok-abc" };
      },
      "GET /api/auth/me": () => {
        calls.push("GET /api/auth/me");
        return { actor: { type: "user", id: "u1" } };
      },
    });
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Username"), "clerk1");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(getToken()).toBe("tok-abc"));
    expect(localStorage.getItem("hmis.token")).toBe("tok-abc");
    expect(calls.some((c) => c.startsWith("POST /api/auth/login"))).toBe(true);
    expect(calls).toContain("GET /api/auth/me");
    expect(calls[0]).toContain('"username":"clerk1"');
    // PLAN 07c T4 — a successful sign-in lands on `/`, the person's own desk. It used to land on
    // `/registration`, which for a doctor or a cashier was somebody else's screen and, before the
    // index route was fixed, was ALSO where `/` sent them straight back to.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
  });

  it("shows the sign-in-failed alert when the credentials are rejected", async () => {
    // stubFetch always answers 200; a rejected login needs a real non-2xx response, so this
    // one test stubs fetch directly instead of going through the routes helper.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ statusCode: 401, message: "invalid" }), { status: 401 })),
    );
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Username"), "clerk1");
    await user.type(screen.getByLabelText("Password"), "wrongpassword");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Sign-in failed — check the username and password")).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  // ────────────────────────── PLAN 11e T6 / D6 ──────────────────────────

  it("routes a 403 password_change_required into /change-password, and KEEPS the token", async () => {
    // The real sequence: `/auth/login` succeeds and stores the token, then `/auth/me` — a guarded
    // route — is refused because the account is in the forced-change state. `api()` clears the
    // token only on a 401, so the change travels on this very session (11e D1).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (raw.includes("/api/auth/login")) {
          return new Response(JSON.stringify({ token: "tok-forced" }), {
            status: 201, headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ statusCode: 403, message: "password_change_required" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
      }),
    );
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "asha");
    await user.type(screen.getByLabelText("Password"), "issued-by-admin");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/change-password" }));
    expect(getToken()).toBe("tok-forced");
    // …and it is NOT reported as a failed sign-in: the credentials were correct.
    expect(screen.queryByText("Sign-in failed — check the username and password")).not.toBeInTheDocument();
  });

  // ────────────────────────── FD-10 — the rebuilt screen's own affordances ──────────────────────────

  /**
   * The reveal exists because of what happens without it at a counter: a mistyped password, a second
   * mistyped password, a lockout, and a clerk who now asks a colleague to type it in for them —
   * which is the credential-sharing the help text on this same screen tells them not to do.
   *
   * `tabIndex={-1}` is asserted because it is the half that is easy to lose: Tab from the password
   * field belongs on Sign in, not on a button that shows the password to whoever is at the counter.
   */
  it("the reveal shows and re-hides the password, and is not in the tab path", async () => {
    stubFetch({});
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();
    const password = screen.getByLabelText("Password");

    expect(password).toHaveAttribute("type", "password");
    const reveal = screen.getByRole("button", { name: "SHOW" });
    expect(reveal).toHaveAttribute("tabindex", "-1");

    await user.click(reveal);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "HIDE" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  /**
   * Caps Lock is the most common sign-in failure there is and the only one a browser can warn about
   * before the request leaves. It is read off the KEYSTROKE (`getModifierState`) rather than guessed
   * from the value, and it is suppressed while the password is revealed — the person can see it.
   */
  it("warns about Caps Lock from the keystroke, and stops warning once the password is visible", async () => {
    stubFetch({});
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();
    const password = screen.getByLabelText("Password");

    expect(screen.queryByText("Caps Lock is on.")).not.toBeInTheDocument();

    /*
      The modifier has to be set on the NATIVE event. React's `getModifierState` delegates to
      `nativeEvent.getModifierState` when it exists, and `fireEvent`'s init dictionary has no
      `getModifierState` key — passing one is silently dropped, which is why the obvious version of
      this test asserted nothing and failed.
    */
    const down = new KeyboardEvent("keydown", { key: "A", bubbles: true });
    Object.defineProperty(down, "getModifierState", { value: () => true });
    fireEvent(password, down);
    expect(await screen.findByText("Caps Lock is on.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "SHOW" }));
    expect(screen.queryByText("Caps Lock is on.")).not.toBeInTheDocument();
  });

  /**
   * ═══ THE LANGUAGE REACHES THE STYLESHEET, AND THAT IS THE DEFECT THIS GUARDS ═══
   *
   * `.tag` — the house's section-label treatment — is IBM Plex Mono, uppercase, and tracked at
   * .14em. All three are Latin assumptions: Devanagari has no case, letter-spacing pulls its
   * conjuncts and matras apart, and Plex Mono has no Devanagari coverage at all, so every label
   * fell back to a different face on every machine. It was VISIBLE the moment the Hindi screenshot
   * was taken and invisible in every English one.
   *
   * `login.css` fixes it under `.lg[data-lang="hi"]`, so the attribute IS the fix: without it the
   * override cannot match and the labels silently go back to being wrong. Asserted here rather than
   * left to a reviewer noticing a stray attribute.
   */
  it("stamps the script on the root so the Devanagari type rules can apply, and translates the form", async () => {
    stubFetch({});
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();

    expect(screen.getByTestId("login-screen")).toHaveAttribute("data-lang", "en");

    await user.click(screen.getByRole("button", { name: "हिन्दी" }));

    await waitFor(() => expect(screen.getByTestId("login-screen")).toHaveAttribute("data-lang", "hi"));
    expect(screen.getByRole("button", { name: "साइन इन" })).toBeInTheDocument();
    expect(screen.getByLabelText("पासवर्ड")).toBeInTheDocument();
  });

  /**
   * The pine panel carries four real statements about what the software does at the reader's seat.
   * The first draft hid it with `aria-hidden` — the reflex for a marketing column — which denies a
   * blind clerk the same information every sighted one gets. It is a complementary landmark
   * instead: announced, and skippable by anybody navigating landmarks.
   */
  it("the agent panel is a landmark a screen reader can reach and skip, not hidden content", () => {
    stubFetch({});
    renderWithProviders(<LoginScreen />);
    const aside = screen.getByRole("complementary");
    expect(aside).toBeInTheDocument();
    expect(aside).not.toHaveAttribute("aria-hidden");
    expect(aside).toHaveTextContent("At the counter");
  });

  it("no longer refuses a short password client-side — the server decides what may be USED to sign in", async () => {
    // The floor here used to be `min(8)`, a copy of a rule the server deliberately does not apply
    // at login (11e D3): a floor at sign-in locks out precisely the accounts the reset flow exists
    // to save. What is asserted is that the REQUEST IS MADE.
    const sent: string[] = [];
    stubFetch({
      "POST /api/auth/login": (init?: RequestInit) => { sent.push(init?.body as string); return { token: "tok-short" }; },
      "GET /api/auth/me": () => ({ actor: { type: "user", id: "u1" } }),
    });
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "asha");
    await user.type(screen.getByLabelText("Password"), "old7pwd");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('"password":"old7pwd"');
  });
});
