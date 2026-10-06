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
const PHONE_A = { id: "ph-a", model: "Redmi Note 12", osVersion: "Android 14", appVersion: "0.7.0 (8)", firstSeenAt: "2026-10-01T04:00:00.000Z", lastSeenAt: "2026-10-06T05:10:00.000Z", lastIp: "203.0.113.7", signedIn: true, signedInSince: "2026-10-06T03:30:00.000Z" };
const PHONE_OLD = { id: "ph-old", model: null, osVersion: null, appVersion: null, firstSeenAt: "2026-09-01T04:00:00.000Z", lastSeenAt: "2026-09-02T04:00:00.000Z", lastIp: null, signedIn: false, signedInSince: null };

/**
 * MOBILE M6a — the phones panel on /admin/users (owner 2026-10-06: staff use personal phones).
 */
describe("AdminUsers — the phones a person is signed in on", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("lists a person's phones: what each says it is, signed in since when, last opened — a phone holding no session offers no button", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": { status: 200, body: { limit: 2, phones: [PHONE_A, PHONE_OLD] } },
    });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(await screen.findByTestId("admin-phones-asha"));
    const panel = await screen.findByTestId("admin-phones-panel");
    expect(panel).toHaveTextContent("Phones — asha");
    const a = await within(panel).findByTestId("admin-phone-ph-a");
    expect(a).toHaveTextContent("Redmi Note 12");
    expect(a).toHaveTextContent("Android 14 · app 0.7.0 (8)");
    // 03:30Z is 09:00 IST on the 6th.
    expect(within(a).getByTestId("admin-phone-state-ph-a")).toHaveTextContent("Signed in since 06 Oct, 09:00");
    expect(a).toHaveTextContent("Last opened 06 Oct, 10:40");
    expect(a).toHaveTextContent("203.0.113.7");
    expect(within(a).getByRole("button", { name: "Sign out this phone" })).toBeInTheDocument();
    const old = within(panel).getByTestId("admin-phone-ph-old");
    expect(old).toHaveTextContent("Phone (model not reported)");
    expect(within(old).getByTestId("admin-phone-state-ph-old")).toHaveTextContent("Not signed in");
    expect(within(old).queryByRole("button", { name: "Sign out this phone" })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent("A person can be signed in on 2 phones at a time.");
  });

  it("signs ONE phone out — one POST for that phone — says so, and re-reads the list", async () => {
    let phones: (Omit<typeof PHONE_A, "signedInSince"> & { signedInSince: string | null })[] = [PHONE_A];
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": () => ({ status: 200, body: { limit: 2, phones } }),
      "POST /api/admin/users/u-asha/phones/ph-a/sign-out": () => { phones = [{ ...PHONE_A, signedIn: false, signedInSince: null }]; return { status: 200, body: { sessionsRevoked: 1 } }; },
    });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(await screen.findByTestId("admin-phones-asha"));
    await userEvent.click(await screen.findByTestId("admin-phone-signout-ph-a"));
    expect(await screen.findByTestId("admin-phones-notice")).toHaveTextContent("Redmi Note 12 is signed out. The app on it asks for the password again.");
    expect(callsTo("POST", "/api/admin/users/u-asha/phones/ph-a/sign-out")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("admin-phone-state-ph-a")).toHaveTextContent("Not signed in"));
    expect(screen.queryByTestId("admin-phone-signout-ph-a")).not.toBeInTheDocument();
    // Nobody's password, PIN or account was touched from this panel.
    expect(callsTo("POST", "/api/admin/users/u-asha/password-reset")).toHaveLength(0);
    expect(callsTo("POST", "/api/admin/users/u-asha/deactivate")).toHaveLength(0);
  });

  it("a refusal is said in the panel, in words: the phone is gone from the list", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": { status: 200, body: { limit: 2, phones: [PHONE_A] } },
      "POST /api/admin/users/u-asha/phones/ph-a/sign-out": { status: 404, body: { code: "phone_not_found" } },
    });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(await screen.findByTestId("admin-phones-asha"));
    await userEvent.click(await screen.findByTestId("admin-phone-signout-ph-a"));
    expect(await screen.findByTestId("admin-phones-error")).toHaveTextContent("That phone is no longer on this person's list.");
    expect(screen.queryByTestId("admin-phones-notice")).not.toBeInTheDocument();
  });

  it("a person with no phone says so; the list is only asked for when the panel is opened", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": { status: 200, body: { limit: 2, phones: [] } },
    });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    expect(callsTo("GET", "/api/admin/users/u-asha/phones")).toHaveLength(0);
    await userEvent.click(screen.getByTestId("admin-phones-asha"));
    expect(await screen.findByTestId("admin-phones-none")).toHaveTextContent(/No phone has signed in with the staff app for this person yet\..*app 0\.7\.0 or newer.*log out of the app and sign in again/);
  });

  /** MOBILE M6b — notifications on a phone, and the fixed test (owner 2026-10-06). */
  it("says for each phone whether notifications are on, and offers the test only where one can arrive", async () => {
    const PHONE_QUIET = { ...PHONE_A, id: "ph-q", model: "Samsung A15", notifications: false };
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": { status: 200, body: { limit: 2, notificationsConfigured: true, phones: [{ ...PHONE_A, notifications: true }, PHONE_QUIET, PHONE_OLD] } },
    });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(await screen.findByTestId("admin-phones-asha"));
    expect(await screen.findByTestId("admin-phone-notifications-ph-a")).toHaveTextContent("Notifications on");
    expect(screen.getByTestId("admin-phone-test-ph-a")).toHaveTextContent("Send test notification");
    expect(screen.getByTestId("admin-phone-notifications-ph-q")).toHaveTextContent("Notifications off on this phone");
    // Owner 2026-10-06: the control is never silently absent. Where a test cannot arrive it is
    // DISABLED and the line beside it says why and what the person does about it.
    expect(screen.getByTestId("admin-phone-test-ph-a")).toBeEnabled();
    expect(screen.getByTestId("admin-phone-test-ph-q")).toBeDisabled();
    expect(screen.getByTestId("admin-phone-test-why-ph-q")).toHaveTextContent("This phone has not turned notifications on. In the app: This phone → Notifications → Turn on.");
    expect(screen.queryByTestId("admin-phone-test-why-ph-a")).not.toBeInTheDocument();
    // A phone that holds no session has nothing to test (and nothing to sign out).
    expect(screen.queryByTestId("admin-phone-test-ph-old")).not.toBeInTheDocument();
  });

  it("a server with no Firebase key says so on every phone and offers no test", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": { status: 200, body: { limit: 2, notificationsConfigured: false, phones: [{ ...PHONE_A, notifications: false }] } },
    });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(await screen.findByTestId("admin-phones-asha"));
    expect(await screen.findByTestId("admin-phone-notifications-ph-a")).toHaveTextContent("Notifications are not set up on this server");
    expect(screen.getByTestId("admin-phone-test-ph-a")).toBeDisabled();
    expect(screen.getByTestId("admin-phone-test-why-ph-a")).toHaveTextContent("Notifications are not set up on this server, so a test cannot be sent.");
  });

  it("sends the test to ONE phone and says what happened — only `sent` is good news", async () => {
    let outcome = "sent";
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "GET /api/admin/users/u-asha/phones": { status: 200, body: { limit: 2, notificationsConfigured: true, phones: [{ ...PHONE_A, notifications: true }] } },
      "POST /api/admin/users/u-asha/phones/ph-a/test-notification": () => ({ status: 200, body: { outcome } }),
    });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(await screen.findByTestId("admin-phones-asha"));
    await userEvent.click(await screen.findByTestId("admin-phone-test-ph-a"));
    expect(await screen.findByTestId("admin-phones-notice")).toHaveTextContent("A test notification was sent to Redmi Note 12. It says only “Test — this phone can receive HMIS notifications.”");
    // The request carries no text: there is nothing an administrator can type into a colleague's lock screen.
    expect(callsTo("POST", "/api/admin/users/u-asha/phones/ph-a/test-notification")).toEqual([{ body: undefined }]);

    outcome = "failed";
    await userEvent.click(screen.getByTestId("admin-phone-test-ph-a"));
    expect(await screen.findByTestId("admin-phones-error")).toHaveTextContent("The notification service refused that just now. Nothing was sent — try again in a minute.");
    expect(screen.queryByTestId("admin-phones-notice")).not.toBeInTheDocument();

    outcome = "gone";
    await userEvent.click(screen.getByTestId("admin-phone-test-ph-a"));
    expect(await screen.findByTestId("admin-phones-error")).toHaveTextContent(/Redmi Note 12 no longer accepts notifications/);
  });
});
