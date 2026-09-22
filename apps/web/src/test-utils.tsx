import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter,
} from "@tanstack/react-router";
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
 * ═══ PHASE O T3 — THE SAME PROVIDERS, PLUS A REAL ROUTER ═══
 *
 * `renderWithProviders` mounts a component with no router above it, so anything that renders a
 * `<Link>` or calls `useSearch`/`useNavigate` throws — which is why every screen that routes has
 * so far been tested with its navigation stubbed out. T3's bell renders a real `<Link>` into the
 * approvals inbox and T3's inbox reads `?focus=` back out, and a stub on either side would be a
 * test of the stub: the deep link is the ONE thing the pair exists to do.
 *
 * So: a memory history at `path`, one catch-all route rendering `ui` under the same three
 * providers production uses. `useSearch({ strict: false })` reads the query string off the
 * history, exactly as it does in the app, so `?focus=x` arrives the way the bell would send it.
 */
export function renderWithRouter(ui: React.ReactElement, path = "/"): ReturnType<typeof render> {
  // jsdom implements neither, and the router calls `scrollTo` on every navigation while a
  // deep-linked screen calls `scrollIntoView` on arrival. Both are no-ops a browser provides;
  // without them every routed test drowns in "Not implemented" stderr or throws outright.
  window.scrollTo = (): void => {};
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    validateSearch: (search: Record<string, unknown>): Record<string, unknown> => search,
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider><PatientInHandProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </PatientInHandProvider></AuthProvider>
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
