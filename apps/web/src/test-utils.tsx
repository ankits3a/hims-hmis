import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { AuthProvider } from "./lib/auth";
import "./lib/i18n";

export function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

/** Minimal fetch stub: route key "METHOD path" → response body (or a function of the request). */
export function stubFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
      if (!(key in routes)) return new Response("{}", { status: 404 });
      const value = routes[key];
      const body = typeof value === "function" ? (value as (i?: RequestInit) => unknown)(init) : value;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}
