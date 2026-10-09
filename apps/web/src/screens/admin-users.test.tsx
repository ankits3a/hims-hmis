import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { AdminUsers } from "./admin-users";

/**
 * PLAN 11e T6 — and the rework of 2026-10-09 (the users board: search, chips, a drawer per person,
 * bulk acts, a New user drawer). WHAT IS ASSERTED IS WHAT THIS SCREEN DECIDES: which sentence a
 * refusal CODE maps to, what a search or a chip leaves on screen, that Deactivate asks first, that
 * a bulk act reaches each person, and that the create flow sends what was typed (or made) and then
 * the roles. Everything else is the server's decision rendered.
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

/** Every write in the order it was sent, as `METHOD path`. */
function writes(): string[] {
  return vi.mocked(fetch).mock.calls
    .filter(([, init]) => (init?.method ?? "GET") !== "GET")
    .map(([input, init]) => `${init?.method ?? "GET"} ${(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).split("?")[0]!}`);
}

const ASHA = {
  id: "u-asha", username: "asha", fullName: "Asha Verma", staffCode: "S-0001", active: true, hasPin: true,
  mustChangePassword: true,
  roles: [{ assignmentId: "a-1", roleKey: "front_office", scopeType: "hospital", scopeId: null }],
};
const RETIRED = {
  id: "u-gone", username: "gone", fullName: "Gone Away", staffCode: "S-0009", active: false, hasPin: false,
  mustChangePassword: false, roles: [],
};
const RAVI = {
  id: "u-ravi", username: "ravi.k", fullName: "Ravi Kumar", staffCode: "S-0031", active: true, hasPin: false,
  mustChangePassword: false, roles: [],
};

const CATALOGUE = {
  assignableScopes: ["hospital"],
  roles: [
    { key: "front_office", title: "Front Office (registration / OPD desk)", permissions: ["patients.read"], holders: 1, grantsAccessAuthority: false },
    { key: "cashier", title: "Cashier", permissions: ["billing.invoice.issue", "billing.receipt.record"], holders: 0, grantsAccessAuthority: false },
    { key: "doctor", title: "Doctor (OPD consultant)", permissions: ["opd.consult.write", "opd.queue.read", "patients.read"], holders: 0, grantsAccessAuthority: false },
    { key: "admin", title: "Administrator", permissions: ["auth.users.manage", "auth.roles.manage"], holders: 1, grantsAccessAuthority: true },
  ],
};

/** Open a person's drawer the way the keyboard does: their name is a button. */
async function openPerson(username: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`admin-open-${username}`));
  return screen.findByTestId("admin-user-drawer");
}

/** The names of the rows on screen, in order. */
const rowNames = (): string[] => within(screen.getByTestId("admin-rows")).queryAllByTestId(/^admin-open-/).map((b) => b.getAttribute("data-testid")!.replace("admin-open-", ""));

describe("AdminUsers", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("renders the whole roster — a deactivated person is listed, says so, and their drawer offers REACTIVATE", async () => {
    mockRoutes({ "GET /api/admin/users": { status: 200, body: { users: [ASHA, RETIRED] } } });
    renderWithProviders(<AdminUsers />);

    const ashaRow = await screen.findByTestId("admin-user-asha");
    expect(within(ashaRow).getByTestId("admin-status-asha")).toHaveTextContent("Active");
    expect(within(ashaRow).getByTestId("admin-status-asha")).toHaveTextContent("New password due");
    expect(within(ashaRow).getByTestId("admin-pin-asha")).toHaveTextContent("PIN set");
    expect(within(ashaRow).getByTestId("admin-staff-code-asha")).toHaveTextContent("asha · S-0001");

    // A LIST THAT HID DEACTIVATED PEOPLE would make "reactivate" a route with no way to reach it.
    const goneRow = screen.getByTestId("admin-user-gone");
    expect(within(goneRow).getByTestId("admin-status-gone")).toHaveTextContent("Deactivated");
    expect(goneRow).toHaveTextContent("No role");
    const drawer = await openPerson("gone");
    expect(within(drawer).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();

    const asha = await openPerson("asha");
    expect(within(asha).getByRole("heading", { name: "Asha Verma" })).toBeInTheDocument();
    expect(within(asha).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("11f D2 — banners the takeover rule's mitigation when fewer than two people hold the full auth.* set", async () => {
    mockRoutes({ "GET /api/admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 1 } } });
    renderWithProviders(<AdminUsers />);
    const warning = await screen.findByTestId("admin-two-admin-warning");
    expect(warning).toHaveTextContent("Fewer than two people");
    expect(warning).toHaveTextContent("1 today");
    expect(warning).toHaveTextContent(/no repair but direct database access/);
  });

  it("11f D2 — the banner reads correctly at ZERO, which is the count a bare deployment has", async () => {
    mockRoutes({ "GET /api/admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 0 } } });
    renderWithProviders(<AdminUsers />);
    const warning = await screen.findByTestId("admin-two-admin-warning");
    expect(warning).toHaveTextContent("Fewer than two people");
    expect(warning).toHaveTextContent("0 today");
    expect(warning.textContent).not.toMatch(/0 person\b/);
  });

  it("11f D2 — the banner is gone at two, and absent while the list is still in flight", async () => {
    mockRoutes({ "GET /api/admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 2 } } });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    expect(screen.queryByTestId("admin-two-admin-warning")).not.toBeInTheDocument();
  });

  it("creates a person, sending exactly what was typed and omitting an empty PIN", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [] } },
      "POST /api/admin/users": { status: 201, body: { id: "u-new" } },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New user" }));
    const drawer = screen.getByTestId("admin-new-user");
    await user.type(within(drawer).getByLabelText("Full name"), "Ravi Kumar");
    // The username is MADE from the name — a suggestion the person may overwrite.
    expect(within(drawer).getByLabelText("Username")).toHaveValue("ravi.kumar");
    expect(within(drawer).getByTestId("admin-new-username-hint")).toHaveTextContent("Made from name");
    await user.clear(within(drawer).getByLabelText("Username"));
    await user.type(within(drawer).getByLabelText("Username"), "ravi");
    await user.click(within(drawer).getByRole("button", { name: "Type my own" }));
    await user.type(within(drawer).getByLabelText("Password"), "a-good-password");
    await user.click(within(drawer).getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(callsTo("POST", "/api/admin/users")).toHaveLength(1));
    // NO `pin` KEY AT ALL, rather than an empty string: `pin: ""` would fail the server's policy.
    expect(callsTo("POST", "/api/admin/users")[0]!.body).toEqual({ username: "ravi", fullName: "Ravi Kumar", password: "a-good-password" });
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("ravi was added");
  });

  it("renders the POLICY refusal from the server, in the New user drawer, rather than minting a floor of its own", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [] } },
      "POST /api/admin/users": { status: 400, body: { code: "password_policy", problems: [{ code: "password_too_short", message: "must be at least 10 characters" }] } },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New user" }));
    const drawer = screen.getByTestId("admin-new-user");
    await user.type(within(drawer).getByLabelText("Full name"), "Ravi Kumar");
    await user.click(within(drawer).getByRole("button", { name: "Type my own" }));
    await user.type(within(drawer).getByLabelText("Password"), "short");
    await user.click(within(drawer).getByRole("button", { name: "Create user" }));

    // THE REQUEST WAS MADE: a client-side copy of the floor would have refused it here.
    await waitFor(() => expect(callsTo("POST", "/api/admin/users")).toHaveLength(1));
    expect(await within(drawer).findByTestId("admin-create-error")).toHaveTextContent("at least 10 characters");
  });

  it("gives admin_lockout its own sentence, inside the Deactivate check where the eye is", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "POST /api/admin/users/u-asha/deactivate": { status: 409, body: { code: "admin_lockout", message: "refused: this would leave NOBODY holding auth.users.manage" } },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    const drawer = await openPerson("asha");
    await user.click(within(drawer).getByRole("button", { name: "Deactivate" }));
    const ask = screen.getByTestId("admin-deactivate-ask");
    await user.click(within(ask).getByTestId("admin-deactivate-confirm"));

    const error = await within(ask).findByTestId("admin-row-error");
    expect(error).toHaveTextContent("would leave nobody able to administer users");
    expect(error).toHaveTextContent("Give somebody else that authority first");
    expect(screen.getAllByTestId("admin-row-error")).toHaveLength(1);
  });

  it("a password reset says the sessions were signed out; a PIN reset says only the PIN changed", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "POST /api/admin/users/u-asha/password-reset": { status: 200, body: { sessionsRevoked: 2 } },
      "POST /api/admin/users/u-asha/pin-reset": { status: 204, body: null },
    });
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    const drawer = await openPerson("asha");

    await user.click(within(drawer).getByRole("button", { name: "Reset password" }));
    const panel = screen.getByTestId("admin-reset-panel");
    expect(panel).toHaveTextContent("Every session this person holds will be signed out");
    expect(within(panel).getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
    await user.type(within(panel).getByLabelText("Password"), "issued-at-the-desk");
    await user.click(within(panel).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/password-reset")).toHaveLength(1));
    expect(callsTo("POST", "/api/admin/users/u-asha/password-reset")[0]!.body).toEqual({ newPassword: "issued-at-the-desk" });
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("sessions were signed out");

    await user.click(within(screen.getByTestId("admin-user-drawer")).getByRole("button", { name: "Reset PIN" }));
    const pinPanel = screen.getByTestId("admin-reset-panel");
    expect(pinPanel).toHaveTextContent("Sessions stay signed in");
    await user.type(within(pinPanel).getByLabelText("PIN (optional)"), "417293");
    await user.click(within(pinPanel).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/pin-reset")).toHaveLength(1));
    expect(callsTo("POST", "/api/admin/users/u-asha/pin-reset")[0]!.body).toEqual({ newPin: "417293" });
  });

  it("CLOSE — a double click on the Deactivate check fires ONE request, not two", async () => {
    let resolveDeactivate: (() => void) | undefined;
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "POST /api/admin/users/u-asha/deactivate": () => ({ status: 200, body: { sessionsRevoked: 1 } }),
    });
    const realFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (raw.includes("/deactivate")) await new Promise<void>((resolve) => { resolveDeactivate = resolve; });
      return realFetch(input, init);
    });

    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    const drawer = await openPerson("asha");
    await user.click(within(drawer).getByRole("button", { name: "Deactivate" }));
    const button = screen.getByTestId("admin-deactivate-confirm");
    await user.click(button);
    await user.click(button);
    resolveDeactivate?.();

    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/deactivate")).toHaveLength(1));
    expect(callsTo("POST", "/api/admin/users/u-asha/deactivate")).toHaveLength(1);
  });

  it("revokes one role assignment from the drawer and says which", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA] } },
      "DELETE /api/admin/users/u-asha/roles/a-1": { status: 204, body: null },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("asha");
    // NAMED BY THE ROLE AND THE PERSON, not "Remove" thirty times over for a screen reader.
    await userEvent.click(within(drawer).getByRole("button", { name: "Revoke front_office from asha" }));
    await waitFor(() => expect(callsTo("DELETE", "/api/admin/users/u-asha/roles/a-1")).toHaveLength(1));
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("front_office was revoked from asha");
  });

  // ═══════════════════════ THE ROLE PICKER ═══════════════════════

  it("offers only the roles this person does NOT hold, grouped by area, and assigns at the scope the SERVER named", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 2 } },
      "GET /api/admin/roles": { status: 200, body: CATALOGUE },
      "POST /api/admin/users/u-asha/roles": { status: 201, body: { assignmentId: "a-2" } },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("asha");
    // The drawer names the held role by its catalogue TITLE, short, with its area and size.
    expect(within(drawer).getByTestId("admin-role-a-1")).toHaveTextContent("Front Office");
    expect(within(drawer).getByTestId("admin-role-a-1")).toHaveTextContent("PATIENTS · 1 permissions");

    const search = within(drawer).getByTestId("admin-role-search-asha");
    await userEvent.click(search);
    const menu = within(drawer).getByTestId("admin-role-search-asha-menu");
    expect(within(menu).queryByTestId("admin-role-search-asha-opt-front_office")).not.toBeInTheDocument();
    expect(within(menu).getByTestId("admin-role-search-asha-opt-cashier")).toHaveTextContent("Cashier2 permissions");
    expect(within(menu).getByRole("group", { name: "billing" })).toBeInTheDocument();

    await userEvent.type(search, "cash");
    expect(within(menu).queryByTestId("admin-role-search-asha-opt-doctor")).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByTestId("admin-role-search-asha-opt-cashier"));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/roles")).toHaveLength(1));
    expect(callsTo("POST", "/api/admin/users/u-asha/roles")[0]!.body).toEqual({ roleKey: "cashier", scopeType: "hospital" });
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("cashier was assigned to asha");
  });

  it("warns BEFORE assigning a role that carries authority over access — the pick arms it, the second button acts", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 2 } },
      "GET /api/admin/roles": { status: 200, body: CATALOGUE },
      "POST /api/admin/users/u-asha/roles": { status: 201, body: { assignmentId: "a-3" } },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("asha");
    expect(screen.queryByTestId("admin-authority-warning-asha")).not.toBeInTheDocument();
    await userEvent.type(within(drawer).getByTestId("admin-role-search-asha"), "admin");
    await userEvent.click(within(drawer).getByTestId("admin-role-search-asha-opt-admin"));
    expect(await screen.findByTestId("admin-authority-warning-asha")).toHaveTextContent("authority over access itself");
    expect(callsTo("POST", "/api/admin/users/u-asha/roles")).toHaveLength(0);

    await userEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("admin-authority-warning-asha")).not.toBeInTheDocument();
    expect(callsTo("POST", "/api/admin/users/u-asha/roles")).toHaveLength(0);

    await userEvent.click(within(drawer).getByTestId("admin-role-search-asha-opt-admin"));
    await userEvent.click(within(drawer).getByTestId("admin-role-search-asha-confirm"));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/roles")).toEqual([{ body: { roleKey: "admin", scopeType: "hospital" } }]));
  });

  it("renders NO picker when the catalogue refuses — auth.users.manage opens this screen, auth.roles.manage opens the picker", async () => {
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [ASHA], fullAdministrators: 2 } },
      "GET /api/admin/roles": { status: 403, body: { code: "forbidden", message: "no" } },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("asha");
    expect(within(drawer).getByRole("button", { name: "Revoke front_office from asha" })).toBeInTheDocument();
    await waitFor(() => expect(callsTo("GET", "/api/admin/roles")).toHaveLength(1));
    expect(within(drawer).queryByTestId("admin-role-search-asha")).not.toBeInTheDocument();
    expect(within(drawer).queryByTestId("admin-copy-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("admin-row-error")).not.toBeInTheDocument();
  });

  it("flags an existing non-hospital assignment as granting nothing", async () => {
    const scoped = { ...ASHA, roles: [{ assignmentId: "a-9", roleKey: "doctor", scopeType: "department", scopeId: "PAEDS" }] };
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [scoped], fullAdministrators: 2 } },
      "GET /api/admin/roles": { status: 200, body: CATALOGUE },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("asha");
    const inert = await within(drawer).findByTestId("admin-inert-a-9");
    expect(inert).toHaveTextContent("department: PAEDS");
    expect(inert).toHaveTextContent("grants nothing today");
  });
});

/**
 * THE REWORK (owner 2026-10-09: "difficult to manage and act smoothly in this screen") — search,
 * chips, the drawer, Deactivate asks first, bulk acts, and a New user that makes the username and
 * the first password.
 */
describe("AdminUsers — finding people and acting on many", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  const IDENTITY = {
    status: 200,
    body: {
      aadhaarConfigured: true,
      users: [
        { userId: "u-asha", mobile: "9876501234", aadhaar: "XXXX XXXX 0124", attendance: "linked" },
        { userId: "u-gone", mobile: null, aadhaar: null, attendance: "two_matches" },
        { userId: "u-ravi", mobile: null, aadhaar: null, attendance: "not_linked" },
      ],
    },
  };
  const ROSTER = { status: 200, body: { users: [RAVI, ASHA, RETIRED], fullAdministrators: 2 } };

  it("lists by name; typing part of a name, a staff code or a mobile narrows the rows; '/' puts the cursor in the box", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/users/identity": IDENTITY });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    expect(rowNames()).toEqual(["asha", "gone", "ravi.k"]);
    expect(screen.getByTestId("admin-count")).toHaveTextContent("3 people");
    const search = screen.getByTestId("admin-search");
    expect(search).toHaveFocus();

    await userEvent.type(search, "verm");
    expect(rowNames()).toEqual(["asha"]);
    expect(screen.getByTestId("admin-shown")).toHaveTextContent("1 of 3 shown");
    await userEvent.clear(search);
    await userEvent.type(search, "s-0031");
    expect(rowNames()).toEqual(["ravi.k"]);
    await waitFor(() => expect(callsTo("GET", "/api/admin/users/identity")).toHaveLength(1));
    await userEvent.clear(search);
    await userEvent.type(search, "98765 01");
    expect(rowNames()).toEqual(["asha"]);
    await userEvent.clear(search);
    await userEvent.type(search, "nobody-at-all");
    expect(rowNames()).toEqual([]);
    expect(screen.getByText("No one matches")).toBeInTheDocument();
    await userEvent.clear(search);
    expect(rowNames()).toEqual(["asha", "gone", "ravi.k"]);

    // "/" from anywhere that is not a field — and NOT while typing in one.
    search.blur();
    await userEvent.keyboard("/");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");
    await userEvent.type(search, "a/b");
    expect(search).toHaveValue("a/b");
  });

  it("the role filter keeps only the holders of that role", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/roles": { status: 200, body: CATALOGUE } });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    await waitFor(() => expect(within(screen.getByTestId("admin-role-filter")).getByRole("option", { name: "Front Office" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("admin-role-filter"), "front_office");
    expect(rowNames()).toEqual(["asha"]);
    await userEvent.selectOptions(screen.getByTestId("admin-role-filter"), "");
    expect(rowNames()).toHaveLength(3);
  });

  it("each chip filters, and its count is the rows it shows; 'Attendance not linked' needs the identity list", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/users/identity": IDENTITY });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-chip-notLinked");
    const expected: Record<string, string[]> = {
      all: ["asha", "gone", "ravi.k"], active: ["asha", "ravi.k"], deactivated: ["gone"], noRole: ["gone", "ravi.k"],
      passwordDue: ["asha"], notLinked: ["gone", "ravi.k"],
    };
    for (const [chip, names] of Object.entries(expected)) {
      const button = screen.getByTestId(`admin-chip-${chip}`);
      expect(button).toHaveTextContent(String(names.length));
      await userEvent.click(button);
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(rowNames()).toEqual(names);
    }
    // The counts follow the search: a chip says how many of THESE rows it would keep.
    await userEvent.click(screen.getByTestId("admin-chip-all"));
    await userEvent.type(screen.getByTestId("admin-search"), "ravi");
    expect(screen.getByTestId("admin-chip-noRole")).toHaveTextContent("1");
    expect(screen.getByTestId("admin-chip-passwordDue")).toHaveTextContent("0");
  });

  it("without the identity list there is no 'Attendance not linked' chip and no attendance mark", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    await waitFor(() => expect(callsTo("GET", "/api/admin/users/identity")).toHaveLength(1));
    expect(screen.queryByTestId("admin-chip-notLinked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("admin-attendance-asha")).not.toBeInTheDocument();
  });

  it("a click anywhere on a row opens that person's drawer; Close and Escape put it away", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/users/identity": IDENTITY });
    renderWithProviders(<AdminUsers />);
    await userEvent.click(within(await screen.findByTestId("admin-user-ravi.k")).getByText("No role"));
    const drawer = screen.getByTestId("admin-user-drawer");
    expect(within(drawer).getByRole("heading", { name: "Ravi Kumar" })).toBeInTheDocument();
    await userEvent.click(within(drawer).getByTestId("admin-drawer-close"));
    expect(screen.queryByTestId("admin-user-drawer")).not.toBeInTheDocument();

    const asha = await openPerson("asha");
    // Masked on the drawer; the full number is one click away on the edit panel.
    expect(asha).toHaveTextContent("98•••••234");
    expect(asha).toHaveTextContent("•••• 0124");
    expect(within(asha).getByTestId("admin-drawer-attendance")).toHaveTextContent("Attendance linked");
    within(asha).getByRole("button", { name: "Reset password" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("admin-user-drawer")).not.toBeInTheDocument();
  });

  it("DEACTIVATE ASKS FIRST: the check names the person and what happens; Keep active sends nothing; Deactivate sends one", async () => {
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "POST /api/admin/users/u-ravi/deactivate": { status: 200, body: { sessionsRevoked: 1 } },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("ravi.k");
    await userEvent.click(within(drawer).getByTestId("admin-deactivate"));
    const ask = screen.getByTestId("admin-deactivate-ask");
    expect(within(ask).getByRole("heading")).toHaveTextContent("Deactivate Ravi Kumar?");
    expect(ask).toHaveTextContent("Signed out of phones and all PCs");
    expect(ask).toHaveTextContent("Roles kept");
    expect(ask).toHaveTextContent("Turn on again any time");
    expect(callsTo("POST", "/api/admin/users/u-ravi/deactivate")).toHaveLength(0);
    await userEvent.click(within(ask).getByRole("button", { name: "Keep active" }));
    expect(screen.queryByTestId("admin-deactivate-ask")).not.toBeInTheDocument();
    expect(callsTo("POST", "/api/admin/users/u-ravi/deactivate")).toHaveLength(0);

    await userEvent.click(within(screen.getByTestId("admin-user-drawer")).getByTestId("admin-deactivate"));
    await userEvent.click(screen.getByTestId("admin-deactivate-confirm"));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-ravi/deactivate")).toHaveLength(1));
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("ravi.k was deactivated");
    expect(screen.queryByTestId("admin-deactivate-ask")).not.toBeInTheDocument();
  });

  it("BULK ADD ROLE: ticking rows shows the bar; one pick is assigned to each selected person who lacks it", async () => {
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "GET /api/admin/roles": { status: 200, body: CATALOGUE },
      "POST /api/admin/users/u-asha/roles": { status: 201, body: { assignmentId: "a-5" } },
      "POST /api/admin/users/u-ravi/roles": { status: 201, body: { assignmentId: "a-6" } },
    });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    expect(screen.queryByTestId("admin-bulk")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Asha Verma" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Ravi Kumar" }));
    // A tick is not an open: no drawer.
    expect(screen.queryByTestId("admin-user-drawer")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-bulk")).toHaveTextContent("2 selected");

    await waitFor(() => expect(screen.getByTestId("admin-bulk-role")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("admin-bulk-role"));
    const panel = screen.getByTestId("admin-bulk-role-panel");
    await userEvent.type(within(panel).getByTestId("admin-bulk-role-search"), "cash");
    await userEvent.click(within(panel).getByTestId("admin-bulk-role-search-opt-cashier"));
    await waitFor(() => expect(writes()).toEqual(["POST /api/admin/users/u-asha/roles", "POST /api/admin/users/u-ravi/roles"]));
    expect(callsTo("POST", "/api/admin/users/u-ravi/roles")[0]!.body).toEqual({ roleKey: "cashier", scopeType: "hospital" });
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("Cashier added to 2");

    // A role one of them already holds goes only to the other.
    await userEvent.click(screen.getByTestId("admin-bulk-role"));
    await userEvent.type(within(screen.getByTestId("admin-bulk-role-panel")).getByTestId("admin-bulk-role-search"), "front");
    await userEvent.click(screen.getByTestId("admin-bulk-role-search-opt-front_office"));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[2]).toBe("POST /api/admin/users/u-ravi/roles");
  });

  it("BULK DEACTIVATE asks once for all, runs one by one, and names who was refused", async () => {
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "POST /api/admin/users/u-asha/deactivate": { status: 409, body: { code: "admin_lockout", message: "refused" } },
      "POST /api/admin/users/u-ravi/deactivate": { status: 200, body: { sessionsRevoked: 0 } },
    });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all shown" }));
    expect(screen.getByTestId("admin-bulk")).toHaveTextContent("3 selected");
    await userEvent.click(screen.getByTestId("admin-bulk-deactivate"));
    const ask = screen.getByTestId("admin-deactivate-ask");
    // The deactivated person is not asked about twice.
    expect(within(ask).getByRole("heading")).toHaveTextContent("Deactivate 2 people?");
    expect(writes()).toEqual([]);
    await userEvent.click(within(ask).getByTestId("admin-deactivate-confirm"));

    await waitFor(() => expect(writes()).toEqual(["POST /api/admin/users/u-asha/deactivate", "POST /api/admin/users/u-ravi/deactivate"]));
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("1 deactivated");
    expect(screen.getByTestId("admin-row-error")).toHaveTextContent("asha: Refused: this would leave nobody able to administer users");
  });

  it("NEW USER: a made first password of twelve or more, the picked roles assigned AFTER the account exists, the mobile saved", async () => {
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "GET /api/admin/roles": { status: 200, body: CATALOGUE },
      "POST /api/admin/users": { status: 201, body: { id: "u-new" } },
      "POST /api/admin/users/u-new/identity": { status: 200, body: { userId: "u-new", mobile: "9876512345", aadhaar: null, attendance: "not_linked" } },
      "POST /api/admin/users/u-new/roles": { status: 201, body: { assignmentId: "a-7" } },
    });
    const random = vi.spyOn(crypto, "getRandomValues");
    renderWithProviders(<AdminUsers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New user" }));
    const drawer = screen.getByTestId("admin-new-user");
    expect(random).toHaveBeenCalled();
    const made = within(drawer).getByTestId("admin-new-password").textContent!;
    expect(made.length).toBeGreaterThanOrEqual(12);
    expect(made).toMatch(/^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
    await user.click(within(drawer).getByRole("button", { name: "New one" }));
    const second = within(drawer).getByTestId("admin-new-password").textContent!;
    expect(second.length).toBeGreaterThanOrEqual(12);

    await user.type(within(drawer).getByLabelText("Full name"), "Dr. Rekha Gupta");
    expect(within(drawer).getByLabelText("Username")).toHaveValue("rekha.gupta");
    await user.type(within(drawer).getByLabelText("Mobile"), "9876512345");
    await waitFor(() => expect(within(drawer).getByTestId("admin-new-role-doctor")).toBeInTheDocument());
    await user.click(within(drawer).getByTestId("admin-new-role-doctor"));
    expect(within(drawer).getByTestId("admin-new-role-doctor")).toHaveAttribute("aria-pressed", "true");
    await user.click(within(drawer).getByTestId("admin-new-more"));
    await user.type(within(drawer).getByTestId("admin-new-role-search"), "cash");
    await user.click(within(drawer).getByTestId("admin-new-role-search-opt-cashier"));
    expect(within(drawer).getByTestId("admin-new-role-cashier")).toHaveAttribute("aria-pressed", "true");
    // Alt+S submits, as on every keyboard-first desk.
    await user.click(within(drawer).getByLabelText("Full name"));
    await user.keyboard("{Alt>}s{/Alt}");

    await waitFor(() => expect(writes()).toEqual([
      "POST /api/admin/users", "POST /api/admin/users/u-new/identity", "POST /api/admin/users/u-new/roles", "POST /api/admin/users/u-new/roles",
    ]));
    expect(callsTo("POST", "/api/admin/users")[0]!.body).toEqual({ username: "rekha.gupta", fullName: "Dr. Rekha Gupta", password: second });
    expect(callsTo("POST", "/api/admin/users/u-new/identity")[0]!.body).toEqual({ mobile: "9876512345" });
    expect(callsTo("POST", "/api/admin/users/u-new/roles").map((c) => c.body)).toEqual([
      { roleKey: "doctor", scopeType: "hospital" }, { roleKey: "cashier", scopeType: "hospital" },
    ]);
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("rekha.gupta was added");
    expect(screen.queryByTestId("admin-new-user")).not.toBeInTheDocument();
    random.mockRestore();
  });

  it("COPY FROM ANOTHER USER assigns, one by one, only the roles this person lacks", async () => {
    const both = { ...ASHA, roles: [...ASHA.roles, { assignmentId: "a-8", roleKey: "cashier", scopeType: "hospital", scopeId: null }] };
    mockRoutes({
      "GET /api/admin/users": { status: 200, body: { users: [both, RAVI], fullAdministrators: 2 } },
      "GET /api/admin/roles": { status: 200, body: CATALOGUE },
      "POST /api/admin/users/u-ravi/roles": { status: 201, body: { assignmentId: "a-9" } },
    });
    renderWithProviders(<AdminUsers />);
    const drawer = await openPerson("ravi.k");
    await waitFor(() => expect(within(drawer).getByTestId("admin-copy-open")).toBeInTheDocument());
    await userEvent.click(within(drawer).getByTestId("admin-copy-open"));
    await userEvent.selectOptions(within(drawer).getByTestId("admin-copy-from"), "u-asha");
    expect(within(drawer).getByTestId("admin-copy-go")).toHaveTextContent("Copy 2 roles");
    await userEvent.click(within(drawer).getByTestId("admin-copy-go"));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-ravi/roles").map((c) => c.body)).toEqual([
      { roleKey: "front_office", scopeType: "hospital" }, { roleKey: "cashier", scopeType: "hospital" },
    ]));
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("2 roles copied to ravi.k from asha");
  });
});

/**
 * STAFF ATTENDANCE (owner 2026-10-09) — Mobile and Aadhaar on the Users screen, and the word per
 * person: "Attendance linked" / "Not linked" / "Two matches".
 */
describe("AdminUsers — mobile, Aadhaar and the attendance link", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  const ROSTER = { status: 200, body: { users: [ASHA, RETIRED], fullAdministrators: 2 } };
  const identityOf = (over: Record<string, unknown> = {}, configured = true): Reply => ({
    status: 200,
    body: {
      aadhaarConfigured: configured,
      users: [
        { userId: "u-asha", mobile: null, aadhaar: null, attendance: "not_linked", ...over },
        { userId: "u-gone", mobile: "9811100020", aadhaar: null, attendance: "two_matches" },
      ],
    },
  });
  const open = async (username = "asha"): Promise<HTMLElement> => {
    const drawer = await openPerson(username);
    await userEvent.click(within(drawer).getByTestId(`admin-identity-${username}`));
    return screen.findByTestId("admin-identity-panel");
  };

  it("the list says each person's state in words", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/users/identity": identityOf({ attendance: "linked" }) });
    renderWithProviders(<AdminUsers />);
    expect(await screen.findByTestId("admin-attendance-asha")).toHaveTextContent("Attendance linked");
    expect(screen.getByTestId("admin-attendance-gone")).toHaveTextContent("Two matches");
  });

  it("without the identity read the roster still renders, with no attendance word and no error", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER });
    renderWithProviders(<AdminUsers />);
    await screen.findByTestId("admin-user-asha");
    await waitFor(() => expect(callsTo("GET", "/api/admin/users/identity")).toHaveLength(1));
    expect(screen.queryByTestId("admin-attendance-asha")).not.toBeInTheDocument();
    expect(screen.queryByTestId("admin-row-error")).not.toBeInTheDocument();
  });

  it("EMPTY: both boxes are open; saving the mobile posts it alone and says so", async () => {
    let saved = false;
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "GET /api/admin/users/identity": () => identityOf(saved ? { mobile: "9876501234", attendance: "linked" } : {}),
      "POST /api/admin/users/u-asha/identity": () => { saved = true; return { status: 200, body: { userId: "u-asha", mobile: "9876501234", aadhaar: null, attendance: "linked" } }; },
    });
    renderWithProviders(<AdminUsers />);
    const panel = await open();
    expect(within(panel).getByTestId("admin-identity-state")).toHaveTextContent("Not linked");
    expect(within(panel).getByTestId("admin-identity-aadhaar")).toBeEnabled();
    expect(within(panel).getByTestId("admin-identity-aadhaar-hint")).toHaveTextContent("Only the last four are kept here");
    expect(within(panel).queryByTestId("admin-identity-aadhaar-masked")).not.toBeInTheDocument();

    await userEvent.type(within(panel).getByTestId("admin-identity-mobile"), "9876501234");
    await userEvent.click(within(panel).getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/identity")).toEqual([{ body: { mobile: "9876501234" } }]));
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("Mobile saved for asha");
    await waitFor(() => expect(within(panel).getByTestId("admin-identity-state")).toHaveTextContent("Attendance linked"));
    expect(screen.getByTestId("admin-attendance-asha")).toHaveTextContent("Attendance linked");
  });

  it("an Aadhaar is typed once: after saving, the box is gone and only XXXX XXXX 0124 with Change and Remove is shown", async () => {
    let saved = false;
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "GET /api/admin/users/identity": () => identityOf(saved ? { aadhaar: "XXXX XXXX 0124", attendance: "linked" } : {}),
      "POST /api/admin/users/u-asha/identity": () => { saved = true; return { status: 200, body: { userId: "u-asha", mobile: null, aadhaar: "XXXX XXXX 0124", attendance: "linked" } }; },
    });
    renderWithProviders(<AdminUsers />);
    const panel = await open();
    await userEvent.type(within(panel).getByTestId("admin-identity-aadhaar"), "2345 6789 0124");
    await userEvent.click(within(panel).getAllByRole("button", { name: "Save" })[1]!);
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/identity")).toEqual([{ body: { aadhaar: "2345 6789 0124" } }]));
    expect(await within(panel).findByTestId("admin-identity-aadhaar-masked")).toHaveTextContent("XXXX XXXX 0124");
    expect(within(panel).queryByTestId("admin-identity-aadhaar")).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Change" })).toBeEnabled();
    expect(within(panel).getByTestId("admin-identity-aadhaar-remove")).toBeInTheDocument();
    // The number is nowhere on the page any more.
    expect(document.body.textContent).not.toContain("2345 6789");
    expect(document.body.innerHTML).not.toContain("234567890124");
  });

  it("SET AND MASKED: Change opens an empty box (never the old number); Remove posts null", async () => {
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "GET /api/admin/users/identity": identityOf({ mobile: "9876501234", aadhaar: "XXXX XXXX 0124", attendance: "linked" }),
      "POST /api/admin/users/u-asha/identity": { status: 200, body: { userId: "u-asha", mobile: "9876501234", aadhaar: null, attendance: "linked" } },
    });
    renderWithProviders(<AdminUsers />);
    const panel = await open();
    expect(within(panel).getByTestId("admin-identity-aadhaar-masked")).toHaveTextContent("XXXX XXXX 0124");
    expect(within(panel).getByTestId("admin-identity-mobile")).toHaveValue("9876501234");
    await userEvent.click(within(panel).getByTestId("admin-identity-aadhaar-change"));
    expect(within(panel).getByTestId("admin-identity-aadhaar")).toHaveValue("");
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).getByTestId("admin-identity-aadhaar-masked")).toBeInTheDocument();
    await userEvent.click(within(panel).getByTestId("admin-identity-aadhaar-remove"));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/identity")).toEqual([{ body: { aadhaar: null } }]));
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent("Aadhaar removed for asha");
    await userEvent.click(within(panel).getByTestId("admin-identity-mobile-remove"));
    await waitFor(() => expect(callsTo("POST", "/api/admin/users/u-asha/identity")).toHaveLength(2));
    expect(callsTo("POST", "/api/admin/users/u-asha/identity")[1]).toEqual({ body: { mobile: null } });
  });

  it("KEY NOT CONFIGURED: the Aadhaar box is disabled with one line saying so; the mobile still works", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/users/identity": identityOf({}, false) });
    renderWithProviders(<AdminUsers />);
    const panel = await open();
    expect(within(panel).getByTestId("admin-identity-aadhaar")).toBeDisabled();
    expect(within(panel).getByTestId("admin-identity-aadhaar-hint")).toHaveTextContent("Aadhaar cannot be saved yet: the Aadhaar linking key is not set up on this server.");
    expect(within(panel).getAllByRole("button", { name: "Save" })[1]).toBeDisabled();
    expect(within(panel).getByTestId("admin-identity-mobile")).toBeEnabled();
  });

  it("TWO MATCHES: the panel says so and what to do about it", async () => {
    mockRoutes({ "GET /api/admin/users": ROSTER, "GET /api/admin/users/identity": identityOf() });
    renderWithProviders(<AdminUsers />);
    const panel = await open("gone");
    expect(within(panel).getByTestId("admin-identity-state")).toHaveTextContent("Two matches");
    expect(within(panel).getByTestId("admin-identity-state")).toHaveTextContent("More than one person shares this mobile or this Aadhaar");
  });

  it("a refusal is said in words beside the fields, and the number typed stays in the box to be corrected", async () => {
    mockRoutes({
      "GET /api/admin/users": ROSTER,
      "GET /api/admin/users/identity": identityOf(),
      "POST /api/admin/users/u-asha/identity": { status: 400, body: { code: "aadhaar_invalid", problem: "bad_check_digit", message: "that is not a valid Aadhaar number" } },
    });
    renderWithProviders(<AdminUsers />);
    const panel = await open();
    await userEvent.type(within(panel).getByTestId("admin-identity-aadhaar"), "2345 6789 0125");
    await userEvent.click(within(panel).getAllByRole("button", { name: "Save" })[1]!);
    expect(await within(panel).findByTestId("admin-identity-error")).toHaveTextContent("That is not a valid Aadhaar number. Check the twelve digits.");
    expect(within(panel).getByTestId("admin-identity-aadhaar")).toHaveValue("2345 6789 0125");
  });
});
