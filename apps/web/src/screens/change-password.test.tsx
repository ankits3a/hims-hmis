import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { ChangePassword } from "./change-password";

/**
 * PLAN 11e T6 — ROUTINE tier (AGENT-RULES §3): tests required and must pass; mutants NOT required
 * and fail-first NOT owed, which is stated here rather than left to be inferred.
 *
 * The assertions are behavioural where this screen DECIDES something — the typo guard it owns, and
 * which refusal sentence a server code maps to — because everything else it does is the server's
 * decision rendered.
 */
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const reply = handlers[key] ?? { status: 404, body: {} };
      // A 204 MUST carry a null body — the Response constructor throws otherwise, and the throw
      // would look exactly like a failed request. `POST /auth/change-password` answers 204.
      return reply.status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "Content-Type": "application/json" },
        });
    }),
  );
}

function bodyOf(path: string): unknown {
  const call = vi.mocked(fetch).mock.calls.find(([input]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return raw.split("?")[0] === path;
  });
  const init = call?.[1];
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

describe("ChangePassword", () => {
  beforeEach(() => { setToken("tok-1"); navigate.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  async function fill(current: string, next: string, confirm: string): Promise<void> {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Current password"), current);
    await user.type(screen.getByLabelText("New password"), next);
    await user.type(screen.getByLabelText("New password again"), confirm);
    await user.click(screen.getByRole("button", { name: /Change password/ }));
  }

  it("sends the current and new password, and leaves for the app on success", async () => {
    mockRoutes({ "POST /auth/change-password": { status: 204, body: null } });
    renderWithProviders(<ChangePassword />);
    await fill("issued-by-admin", "the-one-i-chose", "the-one-i-chose");

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/registration" }));
    expect(bodyOf("/auth/change-password")).toEqual({
      currentPassword: "issued-by-admin", newPassword: "the-one-i-chose",
    });
  });

  it("catches a mistyped confirmation WITHOUT calling the server — the typo guard this screen owns", async () => {
    mockRoutes({ "POST /auth/change-password": { status: 204, body: null } });
    renderWithProviders(<ChangePassword />);
    await fill("issued-by-admin", "the-one-i-chose", "the-one-i-typo'd");

    expect(await screen.findByTestId("change-password-mismatch")).toBeInTheDocument();
    // NOT A ROUND TRIP: the server has no business knowing a password was typed twice.
    expect(bodyOf("/auth/change-password")).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders the server's POLICY refusal, every clause of it, and stays put", async () => {
    mockRoutes({
      "POST /auth/change-password": {
        status: 400,
        body: {
          code: "password_policy",
          problems: [
            { code: "password_too_short", message: "must be at least 10 characters — length is the whole policy" },
            { code: "password_is_username", message: "must not be the username" },
          ],
        },
      },
    });
    renderWithProviders(<ChangePassword />);
    await fill("issued-by-admin", "asha", "asha");

    const error = await screen.findByTestId("change-password-error");
    // BOTH clauses, because the server returns every problem at once so a person at a counter is
    // not sent round the loop twice.
    expect(error).toHaveTextContent("at least 10 characters");
    expect(error).toHaveTextContent("must not be the username");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders a wrong CURRENT password as its own refusal", async () => {
    mockRoutes({
      "POST /auth/change-password": {
        status: 403, body: { statusCode: 403, message: "current_password_incorrect" },
      },
    });
    renderWithProviders(<ChangePassword />);
    await fill("not-the-current-one", "a-perfectly-fine-one", "a-perfectly-fine-one");

    expect(await screen.findByTestId("change-password-error")).toHaveTextContent("current_password_incorrect");
    expect(navigate).not.toHaveBeenCalled();
  });
});
