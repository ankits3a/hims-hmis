import { screen, waitFor, within } from "@testing-library/react";
import { WaitingForMe } from "./waiting-for-me";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { WAITING_EXPECTED, WAITING_FIXTURE } from "../../../../packages/contracts/src/waiting-fixture";

/**
 * E1.4 / E1.5 — "Waiting for me" on My day. Done-means 3: the web draws the SAME list as the phone
 * for the same answer — both render `WAITING_FIXTURE` and both must read `WAITING_EXPECTED` top to
 * bottom (the phone's half is `apps/mobile/__tests__/waiting.test.tsx`). Done-means 2 (web): each
 * line with a web screen is a link to it.
 */
const seen: string[] = [];
function serve(waiting: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    seen.push(key);
    const body = key === "GET /api/auth/me"
      ? { actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }
      : key === "GET /api/me/waiting" ? waiting : null;
    return new Response(JSON.stringify(body ?? {}), { status: body === null ? 404 : 200, headers: { "Content-Type": "application/json" } });
  }));
}

afterEach(() => { setToken(null); vi.unstubAllGlobals(); seen.length = 0; });

describe("Waiting for me (E1.4, E1.5) — web", () => {
  it("draws the shared fixture as the shared expected list, in order, from GET /me/waiting", async () => {
    serve(WAITING_FIXTURE);
    setToken("t-1");
    renderWithProviders(<WaitingForMe />);
    const strip = await screen.findByTestId("waiting-for-me");
    const rows = within(strip).getAllByRole("listitem");
    expect(rows.map((r) => [r.getAttribute("data-kind"), Number(r.querySelector("b")?.textContent)])).toEqual(WAITING_EXPECTED);
    expect(seen).toContain("GET /api/me/waiting");
  });

  it("each line with a web screen opens it in one click; the bell and reminders say where they live", async () => {
    serve(WAITING_FIXTURE);
    setToken("t-1");
    renderWithProviders(<WaitingForMe />);
    await screen.findByTestId("waiting-for-me");
    expect(screen.getByTestId("waiting-lab.reportsBack").getAttribute("href")).toBe("/opd/consult");
    expect(screen.getByTestId("waiting-radiology.unreadMine").getAttribute("href")).toBe("/opd/consult");
    expect(screen.getByTestId("waiting-roster.dutiesToday").getAttribute("href")).toBe("/roster/my-duties");
    expect(screen.getByText("in the bell")).toBeTruthy();
    expect(screen.getByText("on the phone")).toBeTruthy();
    expect(screen.queryByText(/billing/i)).toBeNull();
  });

  it("nothing waiting is said in one line, not hidden", async () => {
    serve({ items: [] });
    setToken("t-1");
    renderWithProviders(<WaitingForMe />);
    await waitFor(() => { expect(screen.getByText("Nothing waiting on you.")).toBeTruthy(); });
  });
});
