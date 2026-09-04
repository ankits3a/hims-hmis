import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { AuthProvider } from "./lib/auth";
import { PatientInHandProvider } from "./lib/patient-in-hand";
import "./lib/i18n";

export function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      {/*
        PLAN 07b T1 — every authed screen renders inside `PatientInHandProvider` in production
        (`router.tsx`'s Shell), so the harness mirrors that rather than letting a screen that reads
        the patient in hand pass its own suite while throwing in the app.
      */}
      <AuthProvider><PatientInHandProvider>{ui}</PatientInHandProvider></AuthProvider>
    </QueryClientProvider>,
  );
}

/**
 * Minimal fetch stub: route key "METHOD path" → response body (or a function of the request).
 *
 * The key drops the QUERY STRING, so two different reads of one path — `GET /opd/appointments`
 * answers both "the day's book" (doctorId + serviceDate) and "this patient's bookings"
 * (patientId + status) — collide on one entry. A handler therefore receives the FULL url as its
 * second argument and may branch on it. Existing handlers take one parameter and ignore it.
 */
export function stubFetch(
  routes: Record<string, unknown | ((init?: RequestInit, url?: string) => unknown)>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
      if (!(key in routes)) return new Response("{}", { status: 404 });
      const value = routes[key];
      const body = typeof value === "function" ? (value as (i?: RequestInit, u?: string) => unknown)(init, path) : value;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}
