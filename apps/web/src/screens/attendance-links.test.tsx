import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { AttendanceLinks } from "./attendance-links";

/**
 * #634 — the attendance-links screen. What is asserted is what the SCREEN decides: which tabs a
 * permission shows, the count's words, that a suggestion is linked by its own click, that "Link"
 * is offered only on a matching login and asks to confirm, and that a login with no match is
 * offered its mobile and Aadhaar boxes instead. Every link itself is the server's decision.
 */
type Reply = { status: number; body: unknown };
const calls: { method: string; path: string; body: unknown }[] = [];

function mockRoutes(perms: string[], handlers: Record<string, Reply | (() => Reply)>): void {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const h = handlers[`${method} ${path}`] ?? handlers[`${method} ${path.split("?")[0]!}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    const r = typeof h === "function" ? h() : h;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }));
}

const COUNTS = { active: 1392, linked: 3, unlinked: 1389, needsAttention: 2, loginsActive: 210, loginsLinked: 3 };
const UNLINKED = {
  counts: COUNTS, total: 2, offset: 0,
  people: [
    { pin: "301", name: "Person One", dept: "Medicine", post: "Professor", reason: "no_match" },
    { pin: "320", name: "Person Two", dept: "Housekeeping", post: "Attendant", reason: "mobile_shared_on_machine" },
  ],
};
const SUGGESTIONS = {
  suggestions: [
    { person: { pin: "301", name: "Person One", dept: "Medicine", post: "Professor" }, login: { userId: "u-1", username: "p.one", fullName: "P One" }, last4: "0001", shared: false },
    { person: { pin: "320", name: "Person Two", dept: "Housekeeping", post: "Attendant" }, login: { userId: "u-2", username: "p.two", fullName: "P Two" }, last4: "0020", shared: true },
  ],
};
const PERSON = { pin: "305", name: "Person Five", dept: "Surgery", post: "Professor", status: "active", needsAttention: "aadhaar_shared", login: null };
const login = (username: string, match: "mobile" | "aadhaar" | null, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  userId: `u-${username}`, username, fullName: username.toUpperCase(), staffCode: "EMP-0001", linkedPin: null, match, hasMobile: match === "mobile", aadhaar: null, ...more,
});

describe("AttendanceLinks", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the committee sees the count and the unlinked list with reasons — and no linking tabs", async () => {
    mockRoutes(["attendance.all.read"], { "GET /attendance/links": { status: 200, body: UNLINKED } });
    renderWithProviders(<AttendanceLinks />);
    expect(await screen.findByTestId("links-linked")).toHaveTextContent("3 of 1,392 linked");
    expect(screen.getByTestId("links-attention")).toHaveTextContent("Need a person: 2");
    expect(screen.getByTestId("links-logins")).toHaveTextContent("Logins linked: 3 of 210");
    expect(await screen.findByTestId("unlinked-reason-301")).toHaveTextContent("No login matches");
    expect(screen.getByTestId("unlinked-reason-320")).toHaveTextContent("Mobile shared on machine");
    expect(screen.queryByTestId("links-tab-suggestions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("links-tab-byHand")).not.toBeInTheDocument();
    // The committee never calls an administrator's route.
    expect(calls.some((c) => c.path.startsWith("/admin/"))).toBe(false);
  });

  it("nobody else: a viewer holding neither permission is told so and nothing is fetched", async () => {
    mockRoutes([], {});
    renderWithProviders(<AttendanceLinks />);
    expect(await screen.findByTestId("attendance-links-denied")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.path !== "/auth/me")).toEqual([]));
  });

  it("the administrator links a suggestion with ONE click per pair; a shared number says so", async () => {
    let linked = false;
    mockRoutes(["auth.users.manage"], {
      "GET /admin/users/attendance-links": { status: 200, body: { counts: COUNTS, people: [] } },
      "GET /admin/users/attendance-links/suggestions": () => ({ status: 200, body: linked ? { suggestions: [SUGGESTIONS.suggestions[1]] } : SUGGESTIONS }),
      "POST /admin/users/attendance-links": () => { linked = true; return { status: 200, body: { pin: "301", userId: "u-1", source: "mobile", counts: { ...COUNTS, linked: 4 } } }; },
    });
    renderWithProviders(<AttendanceLinks />);
    expect(screen.queryByTestId("links-tab-unlinked")).not.toBeInTheDocument();
    await screen.findByTestId("suggestion-301-p.one");
    expect(screen.getByTestId("suggestion-shared-320")).toHaveTextContent("Shared number");
    expect(screen.queryByTestId("suggestion-shared-301")).not.toBeInTheDocument();
    expect(screen.getByTestId("suggestion-301-p.one")).toHaveTextContent("mobile ··0001");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]); // nothing links by itself
    await userEvent.click(screen.getByTestId("suggestion-link-301-p.one"));
    expect(await screen.findByTestId("links-notice")).toHaveTextContent("Linked Person One to p.one");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ pin: "301", userId: "u-1" }]);
    await waitFor(() => expect(screen.queryByTestId("suggestion-301-p.one")).not.toBeInTheDocument());
  });

  it("by hand: find the person, Link only on a MATCHING login, and confirm before anything is sent", async () => {
    mockRoutes(["auth.users.manage"], {
      "GET /admin/users/attendance-links": { status: 200, body: { counts: COUNTS, people: [] } },
      "GET /admin/users/attendance-links?q=five": { status: 200, body: { counts: COUNTS, people: [PERSON] } },
      "GET /admin/users/attendance-links/305/candidates": { status: 200, body: { person: PERSON, matches: [login("twin.a", "aadhaar"), login("twin.b", "aadhaar")], found: [] } },
      "GET /admin/users/attendance-links/305/candidates?q=clerk": { status: 200, body: { person: PERSON, matches: [login("twin.a", "aadhaar"), login("twin.b", "aadhaar")], found: [login("new.clerk", null), login("old.one", "mobile", { linkedPin: "309" })] } },
      "POST /admin/users/attendance-links": { status: 200, body: { pin: "305", userId: "u-twin.b", source: "aadhaar", counts: COUNTS } },
      "POST /admin/users/u-new.clerk/identity": { status: 200, body: { userId: "u-new.clerk", mobile: null, aadhaar: "XXXX XXXX 0124", attendance: "not_linked" } },
    });
    renderWithProviders(<AttendanceLinks />);
    await userEvent.click(await screen.findByTestId("links-tab-byHand"));
    await userEvent.type(screen.getByTestId("byhand-search"), "five");
    await userEvent.click(await screen.findByTestId("byhand-person-305"));
    expect(await screen.findByTestId("byhand-person")).toHaveTextContent("Aadhaar on two logins");
    expect(within(await screen.findByTestId("login-twin.b")).getByTestId("login-match-twin.b")).toHaveTextContent("Aadhaar matches");

    // A login that matches nothing offers its boxes, never "Link"; one already linked offers neither.
    await userEvent.type(screen.getByTestId("byhand-login-search"), "clerk");
    const clerk = await screen.findByTestId("login-new.clerk");
    expect(within(clerk).queryByTestId("login-link-new.clerk")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("login-old.one")).queryByTestId("login-link-old.one")).not.toBeInTheDocument();
    expect(screen.getByTestId("login-old.one")).toHaveTextContent("Already linked · #309");
    await userEvent.click(within(clerk).getByTestId("login-give-new.clerk"));
    await userEvent.type(screen.getByTestId("login-aadhaar-new.clerk"), "2345 6789 0124");
    await userEvent.click(within(clerk).getAllByRole("button", { name: "Save" })[1]!);
    await waitFor(() => expect(calls.filter((c) => c.path === "/admin/users/u-new.clerk/identity").map((c) => c.body)).toEqual([{ aadhaar: "2345 6789 0124" }]));
    await waitFor(() => expect(screen.queryByTestId("login-aadhaar-new.clerk")).not.toBeInTheDocument()); // the box is gone, and the number with it

    await userEvent.click(screen.getByTestId("login-link-twin.b"));
    expect(screen.getByTestId("byhand-confirm")).toHaveTextContent("Link Person Five (#305) to twin.b?");
    expect(screen.getByTestId("byhand-confirm")).toHaveTextContent("Their Aadhaar matches.");
    expect(calls.filter((c) => c.path === "/admin/users/attendance-links" && c.method === "POST")).toEqual([]);
    await userEvent.click(screen.getByTestId("byhand-confirm-yes"));
    expect(await screen.findByTestId("links-notice")).toHaveTextContent("Linked Person Five to twin.b");
    expect(calls.filter((c) => c.path === "/admin/users/attendance-links" && c.method === "POST").map((c) => c.body)).toEqual([{ pin: "305", userId: "u-twin.b" }]);
  });

  it("a refused link is said in words by its code", async () => {
    mockRoutes(["auth.users.manage"], {
      "GET /admin/users/attendance-links": { status: 200, body: { counts: COUNTS, people: [] } },
      "GET /admin/users/attendance-links/suggestions": { status: 200, body: SUGGESTIONS },
      "POST /admin/users/attendance-links": { status: 409, body: { code: "login_linked" } },
    });
    renderWithProviders(<AttendanceLinks />);
    await userEvent.click(await screen.findByTestId("suggestion-link-301-p.one"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This login is already linked.");
  });
});
