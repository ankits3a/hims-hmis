import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getToken, setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { LoginScreen } from "./login";

describe("LoginScreen", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
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
      "POST /auth/login": (init?: RequestInit) => {
        calls.push(`POST /auth/login ${init?.body as string}`);
        return { token: "tok-abc" };
      },
      "GET /auth/me": () => {
        calls.push("GET /auth/me");
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
    expect(calls.some((c) => c.startsWith("POST /auth/login"))).toBe(true);
    expect(calls).toContain("GET /auth/me");
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
});
