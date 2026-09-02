import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth";
import { setToken } from "./api";

/**
 * FD-1 CLOSE pass 2 — a logout empties the query cache: the class behind the figures screen's
 * CRITICAL (the next login on the same tab painted the last person's cached per-person data).
 */
function Logout(): React.ReactElement {
  const { logout, ready } = useAuth();
  return <button type="button" data-testid="logout" disabled={!ready} onClick={() => { void logout(); }}>out</button>;
}

afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

it("logout clears EVERY cached query, not only the front desk's, and a stale token on boot does too", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "asha" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST" && url.endsWith("/api/auth/logout")) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
  setToken("t-asha");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
  qc.setQueryData(["billing-session", "current"], { session: { openingFloatPaise: 225000 } });
  qc.setQueryData(["me", "desk", "asha", "2026-09-02"], { date: "2026-09-02", cards: [] });
  render(<QueryClientProvider client={qc}><AuthProvider><Logout /></AuthProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("logout")).toBeEnabled());
  expect(qc.getQueryData(["billing-session", "current"])).toBeDefined();
  fireEvent.click(screen.getByTestId("logout"));
  await waitFor(() => expect(qc.getQueryData(["billing-session", "current"])).toBeUndefined());
  expect(qc.getQueryData(["me", "desk", "asha", "2026-09-02"])).toBeUndefined();
  expect(qc.getQueryCache().getAll()).toHaveLength(0);
});
