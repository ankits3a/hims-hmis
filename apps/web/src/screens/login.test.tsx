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
   * The pine panel carries the verse. The first draft hid it with `aria-hidden` — the reflex for a
   * marketing column — which denies a blind clerk what every sighted one gets; that was true when
   * the panel held four claims about the software and it is truer now that it holds scripture. It
   * is a complementary landmark instead: announced, and skippable by anybody navigating landmarks.
   *
   * The assertion used to read `toHaveTextContent("At the counter")`, which was the pitch the owner
   * threw out. It is re-pointed at the verse rather than deleted, because what it is really pinning
   * is that the panel's CONTENT is inside the landmark and not stranded outside it.
   */
  it("the agent panel is a landmark a screen reader can reach and skip, not hidden content", () => {
    stubFetch({});
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderWithProviders(<LoginScreen />);
    const aside = screen.getByRole("complementary");
    expect(aside).toBeInTheDocument();
    expect(aside).not.toHaveAttribute("aria-hidden");
    expect(aside).toHaveTextContent("स्वकर्मणा तमभ्यर्च्य सिद्धिं विन्दति मानवः");
    // Not a live region: the line is fixed for the life of the page, so there is nothing to announce.
    expect(aside).not.toHaveAttribute("aria-live");
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

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * THE ROTATING LINE — AND THE ONE THING ABOUT IT THAT IS EASY TO BREAK AND HARD TO SEE
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `Math.random` is stubbed rather than a prop being threaded through, so the screen keeps the same
   * signature it has in production and the test still pins the verse. Index 0 is 18.46.
   */
  it("prints the pinned verse with its citation, and tags the script for a screen reader", () => {
    stubFetch({});
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderWithProviders(<LoginScreen />);

    const shloka = screen.getByText("स्वकर्मणा तमभ्यर्च्य सिद्धिं विन्दति मानवः");
    expect(shloka).toHaveAttribute("lang", "sa");
    expect(screen.getByText("गीता 18.46")).toBeInTheDocument();
    // Hinglish is Hindi in Latin letters, which is what `hi-Latn` is for — it is not English.
    const meaning = screen.getByText("Apne kaam se hi uski puja — wahi siddhi hai.");
    expect(meaning).toHaveAttribute("lang", "hi-Latn");
    expect(screen.getByText(/that is how a person is perfected/)).toHaveAttribute("lang", "en");
  });

  /**
   * THE DEFECT THIS GUARDS: the pick belongs in `useState`'s lazy initialiser and NOT in the render
   * body. This component re-renders on the 20-second clock tick, on every keystroke, on Caps Lock,
   * on the reveal and on the language toggle — a pick in the render body rerolls the verse under a
   * clerk mid-read, roughly three times a minute, and every other test here still passes.
   *
   * `mockReturnValueOnce(0)` then `0.99` is what makes it fail: a second call lands on a DIFFERENT
   * line, so a rerolled screen shows the proverb instead of 18.46.
   */
  it("holds the same line across a re-render — it never changes under the person reading it", async () => {
    stubFetch({});
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.99);
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();
    expect(screen.getByText("गीता 18.46")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "SHOW" }));
    await user.click(screen.getByRole("button", { name: "HIDE" }));

    expect(screen.getByText("गीता 18.46")).toBeInTheDocument();
    expect(screen.queryByText("सेवा ही परम धर्म है")).not.toBeInTheDocument();
  });

  it("keeps the same verse across a language switch, and swaps the meaning to Devanagari", async () => {
    stubFetch({});
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.99);
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "हिन्दी" }));

    await waitFor(() => expect(screen.getByText("अपने काम से ही उसकी पूजा — वही सिद्धि है।")).toBeInTheDocument());
    // The Sanskrit is Devanagari in both languages, and it is the SAME verse the English screen had.
    expect(screen.getByText("स्वकर्मणा तमभ्यर्च्य सिद्धिं विन्दति मानवः")).toBeInTheDocument();
    expect(screen.getByText("गीता 18.46")).toBeInTheDocument();
    // Hindi carries no Latin gloss — the meaning above it is already in the reader's script.
    expect(screen.queryByText(/that is how a person is perfected/)).not.toBeInTheDocument();
    expect(screen.queryByText("Apne kaam se hi uski puja — wahi siddhi hai.")).not.toBeInTheDocument();
  });

  /**
   * `सेवा ही परम धर्म है` is the line the owner asked for by name and it is NOT in the Gita — it is
   * a proverb. The table gives it `cite: null`; this pins that the SCREEN honours that by printing
   * the saying label where a verse would print its chapter and verse. A regression here does not
   * look broken, it looks fine and is false.
   */
  it("labels the proverb as a saying and never gives it a chapter and verse", () => {
    stubFetch({});
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    renderWithProviders(<LoginScreen />);

    expect(screen.getByText("सेवा ही परम धर्म है")).toBeInTheDocument();
    expect(screen.getByText("कहावत · a saying, not a verse")).toBeInTheDocument();
    expect(screen.queryByText(/^गीता \d/)).not.toBeInTheDocument();
  });

  /**
   * FD-10 stamped `data-lang` on the login root, which is what the STYLESHEET needs, and stopped
   * there. `<html lang>` stayed `"en"` on a fully Hindi screen, so a screen reader pronounced
   * Devanagari with an English voice — the same defect as the type rules, one layer up, and
   * invisible in every screenshot because it has no pixels.
   */
  it("stamps the document language too, not just the class hook the stylesheet reads", async () => {
    stubFetch({});
    document.documentElement.lang = "en";
    renderWithProviders(<LoginScreen />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "हिन्दी" }));

    await waitFor(() => expect(document.documentElement.lang).toBe("hi"));
  });
});
