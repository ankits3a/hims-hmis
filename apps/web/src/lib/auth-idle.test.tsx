import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, IDLE_SIGN_OUT_MS, idleSignOutDue, useAuth } from "./auth";
import { setToken } from "./api";

/**
 * A browser left untouched on a shared terminal signs itself out after the idle window (the server refuses an idle
 * session too). Screens that poll keep the SERVER session warm, so the browser counts the person's own input, not
 * requests. The wall displays (OPD and radiology queue boards) are left signed in.
 */
function Who(): React.ReactElement {
  const { actor, ready } = useAuth();
  return <p data-testid="who">{ready ? (actor?.id ?? "nobody") : "…"}</p>;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setToken(null); });

it("idle is the person's input, not the clock alone; the display boards are exempt", () => {
  const t0 = 1_000_000;
  expect(idleSignOutDue(t0, t0 + IDLE_SIGN_OUT_MS - 1, "/opd/desk")).toBe(false);
  expect(idleSignOutDue(t0, t0 + IDLE_SIGN_OUT_MS + 1, "/opd/desk")).toBe(true);
  expect(idleSignOutDue(t0, t0 + IDLE_SIGN_OUT_MS + 1, "/opd/display")).toBe(false);
  expect(idleSignOutDue(t0, t0 + IDLE_SIGN_OUT_MS + 1, "/radiology/display")).toBe(false);
});

it("signs out after the idle window with no input, and input in between keeps it signed in", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "asha" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  setToken("t-asha");
  render(<QueryClientProvider client={new QueryClient()}><AuthProvider><Who /></AuthProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("asha"));
  await act(async () => { vi.advanceTimersByTime(IDLE_SIGN_OUT_MS - 60_000); });
  window.dispatchEvent(new Event("keydown"));
  await act(async () => { vi.advanceTimersByTime(IDLE_SIGN_OUT_MS - 60_000); });
  expect(screen.getByTestId("who")).toHaveTextContent("asha");
  await act(async () => { vi.advanceTimersByTime(2 * 60_000); });
  await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("nobody"));
  expect(calls).toContain("POST /api/auth/logout");
});
