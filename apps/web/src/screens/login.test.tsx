import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getToken, setToken } from "../lib/api";
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
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    navigate.mockClear();
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
