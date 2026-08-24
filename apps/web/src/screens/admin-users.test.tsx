import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { AdminUsers } from "./admin-users";

/**
 * PLAN 11e T6 — ROUTINE tier (AGENT-RULES §3): tests required and must pass; mutants NOT required
 * and fail-first NOT owed, stated rather than inferred.
 *
 * WHAT IS ASSERTED IS WHAT THIS SCREEN DECIDES: which sentence a refusal CODE maps to (the
 * `admin_lockout` one especially — a 409 with no sentence is a person staring at a number), which
 * action a row offers for an active versus a deactivated person, and that the create form sends
 * what was typed. Everything else on this screen is the server's decision rendered, and testing a
 * render against a stub would be testing the stub.
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return reply.status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(reply.body), {
          status: reply.status, headers: { "Content-Type": "application/json" },
        });
    }),
  );
}

function callsTo(method: string, path: string): { body: unknown }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return (init?.method ?? "GET") === method && raw.split("?")[0] === path;
    })
    .map(([, init]) => ({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }));
}

const ASHA = {
  id: "u-asha", username: "asha", fullName: "Asha Verma", active: true, hasPin: true,
  mustChangePassword: true,
  roles: [{ assignmentId: "a-1", roleKey: "front_office", scopeType: "hospital", scopeId: null }],
};
const RETIRED = {
  id: "u-gone", username: "gone", fullName: "Gone Away", active: false, hasPin: false,
  mustChangePassword: false, roles: [],
};

describe("AdminUsers", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("renders the whole roster — including deactivated people, whose row offers REACTIVATE", async () => {
    mockRoutes({ "GET /admin/users": { status: 200, body: { users: [ASHA, RETIRED] } } });
    renderWithProviders(<AdminUsers />);

    const ashaRow = await screen.findByTestId("admin-user-asha");
    expect(within(ashaRow).getByTestId("admin-status-asha")).toHaveTextContent("Active");
    expect(within(ashaRow).getByTestId("admin-status-asha")).toHaveTextContent("has PIN");
    expect(within(ashaRow).getByTestId("admin-status-asha")).toHaveTextContent("must change password");
    expect(within(ashaRow).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();

    // A LIST THAT HID DEACTIVATED PEOPLE would make "reactivate" a route with no way to reach it.
    const goneRow = screen.getByTestId("admin-user-gone");
    expect(within(goneRow).getByTestId("admin-status-gone")).toHaveTextContent("Deactivated");
    expect(within(goneRow).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(goneRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(within(goneRow).getByText(/this person can reach nothing/)).toBeInTheDocument();
  });

  /**
   * PLAN 11f T2 / D2. The screen renders the SERVER's count and mints no arithmetic of its own —
   * the same rule that keeps the password policy off this file. So what is asserted here is the
   * rendering decision this screen actually makes: below two, say it; at two, do not.
   */
  it("11f D2 — banners the takeover rule's mitigation when fewer than two people hold the full auth.* set", async () => {
    mockRoutes({ "GET /admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 1 } } });
    renderWithProviders(<AdminUsers />);

    const warning = await screen.findByTestId("admin-two-admin-warning");
    expect(warning).toHaveTextContent("Fewer than two people");
    expect(warning).toHaveTextContent("1 today");
    expect(warning).toHaveTextContent(/no repair but direct database access/);
  });

  it("11f D2 — the banner reads correctly at ZERO, which is the count a bare deployment has", async () => {
    // The count the first draft's wording rendered as "Only 0 person". Zero is not hypothetical:
    // it is every deployment before an admin role is assigned, and it is what the e2e fixture's
    // baseline measures.
    mockRoutes({ "GET /admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 0 } } });
    renderWithProviders(<AdminUsers />);

    const warning = await screen.findByTestId("admin-two-admin-warning");
    expect(warning).toHaveTextContent("Fewer than two people");
    expect(warning).toHaveTextContent("0 today");
    expect(warning.textContent).not.toMatch(/0 person\b/);
  });

  it("11f D2 — the banner is gone at two, and absent while the list is still in flight", async () => {
    mockRoutes({ "GET /admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 2 } } });
    renderWithProviders(<AdminUsers />);

    // Wait for the list to have ARRIVED before concluding the banner is absent — asserting on an
    // unresolved query would pass for the wrong reason, and would pass just as well at one.
    await screen.findByTestId("admin-user-asha");
    expect(screen.queryByTestId("admin-two-admin-warning")).not.toBeInTheDocument();
  });

  it("creates a person, sending exactly what was typed and omitting an empty PIN", async () => {
    mockRoutes({
      "GET /admin/users": { status: 200, body: { users: [] } },
      "POST /admin/users": { status: 201, body: { id: "u-new" } },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "ravi");
    await user.type(screen.getByLabelText("Full name"), "Ravi Kumar");
    await user.type(screen.getByLabelText("Password"), "a-good-password");
    await user.click(screen.getByRole("button", { name: /Add person/ }));

    await waitFor(() => expect(callsTo("POST", "/admin/users")).toHaveLength(1));
    // NO `pin` KEY AT ALL, rather than an empty string: `pin: ""` would fail the server's policy
    // (4-6 digits) and refuse a perfectly ordinary account with no PIN.
    expect(callsTo("POST", "/admin/users")[0]!.body).toEqual({
      username: "ravi", fullName: "Ravi Kumar", password: "a-good-password",
    });
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("ravi was added");
  });

  it("renders the POLICY refusal from the server rather than minting a floor of its own", async () => {
    mockRoutes({
      "GET /admin/users": { status: 200, body: { users: [] } },
      "POST /admin/users": {
        status: 400,
        body: {
          code: "password_policy",
          problems: [{ code: "password_too_short", message: "must be at least 10 characters" }],
        },
      },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "ravi");
    await user.type(screen.getByLabelText("Full name"), "Ravi Kumar");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: /Add person/ }));

    // THE REQUEST WAS MADE. That is the point of this test: a client-side copy of the floor would
    // have refused it here, and would then drift from the rule that actually decides.
    await waitFor(() => expect(callsTo("POST", "/admin/users")).toHaveLength(1));
    expect(await screen.findByTestId("admin-create-error")).toHaveTextContent("at least 10 characters");
  });

  it("gives admin_lockout its own sentence — a 409 with a bare number is a person staring at it", async () => {
    mockRoutes({
      "GET /admin/users": { status: 200, body: { users: [ASHA] } },
      "POST /admin/users/u-asha/deactivate": {
        status: 409, body: { code: "admin_lockout", message: "refused: this would leave NOBODY holding auth.users.manage" },
      },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate" }));

    const error = await screen.findByTestId("admin-row-error");
    expect(error).toHaveTextContent("would leave nobody able to administer users");
    expect(error).toHaveTextContent("Give somebody else that authority first");
  });

  it("a password reset says the sessions were signed out; a PIN reset says only the PIN changed", async () => {
    mockRoutes({
      "GET /admin/users": { status: 200, body: { users: [ASHA] } },
      "POST /admin/users/u-asha/password-reset": { status: 200, body: { sessionsRevoked: 2 } },
      "POST /admin/users/u-asha/pin-reset": { status: 204, body: null },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Reset password" }));
    const panel = screen.getByTestId("admin-reset-panel");
    expect(panel).toHaveTextContent("Every session this person holds will be signed out");
    await user.type(within(panel).getByLabelText("Password"), "issued-at-the-desk");
    await user.click(within(panel).getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(callsTo("POST", "/admin/users/u-asha/password-reset")).toHaveLength(1));
    expect(callsTo("POST", "/admin/users/u-asha/password-reset")[0]!.body)
      .toEqual({ newPassword: "issued-at-the-desk" });
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("sessions were signed out");

    await user.click(screen.getByRole("button", { name: "Reset PIN" }));
    const pinPanel = screen.getByTestId("admin-reset-panel");
    // THE TWO FLOWS SAY DIFFERENT THINGS, which is Q3's ruling made visible to the person acting.
    expect(pinPanel).toHaveTextContent("Sessions stay signed in");
    await user.type(within(pinPanel).getByLabelText("PIN (optional)"), "417293");
    await user.click(within(pinPanel).getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(callsTo("POST", "/admin/users/u-asha/pin-reset")).toHaveLength(1));
    expect(callsTo("POST", "/admin/users/u-asha/pin-reset")[0]!.body).toEqual({ newPin: "417293" });
  });

  it("CLOSE — a double click on a row action fires ONE request, not two", async () => {
    // §3.45's convention, asserted where it was missing. `disabled` alone cannot do this: two
    // clicks in the same tick both observe the pre-render state. `SubmitButton`'s ref latch flips
    // synchronously, which is the whole reason that component exists.
    let resolveDeactivate: (() => void) | undefined;
    mockRoutes({
      "GET /admin/users": { status: 200, body: { users: [ASHA] } },
      "POST /admin/users/u-asha/deactivate": () => ({ status: 200, body: { sessionsRevoked: 1 } }),
    });
    // Hold the request open so the second click lands while the first is genuinely in flight.
    const realFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (raw.includes("/deactivate")) {
        await new Promise<void>((resolve) => { resolveDeactivate = resolve; });
      }
      return realFetch(input, init);
    });

    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Deactivate" });
    await user.click(button);
    await user.click(button);
    resolveDeactivate?.();

    await waitFor(() => expect(callsTo("POST", "/admin/users/u-asha/deactivate")).toHaveLength(1));
    // …and it stays one after everything settles, rather than merely being one at the instant
    // the assertion first passed.
    expect(callsTo("POST", "/admin/users/u-asha/deactivate")).toHaveLength(1);
  });

  it("revokes one role assignment and says which", async () => {
    mockRoutes({
      "GET /admin/users": { status: 200, body: { users: [ASHA] } },
      "DELETE /admin/users/u-asha/roles/a-1": { status: 204, body: null },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(callsTo("DELETE", "/admin/users/u-asha/roles/a-1")).toHaveLength(1));
    expect(await screen.findByTestId("admin-notice"))
      .toHaveTextContent("front_office was revoked from asha");
  });
});
