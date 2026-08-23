import { act, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { ModeBanner } from "./mode-banner";

/**
 * PLAN 11c T5 — ROUTINE tier (AGENT-RULES §3): tests are required and must pass; mutants are
 * NOT required and fail-first is NOT owed. Every assertion below is behavioural (the banner
 * DECIDES whether to render, and what mode/note to show) except the polling-cadence test, which
 * is explicitly labelled presence-only — the `alerts-bell.test.tsx` precedent, copied rather than
 * imported (a test file is self-contained).
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
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function callsTo(method: string, path: string): number {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return (init?.method ?? "GET") === method && raw.split("?")[0] === path;
  }).length;
}

describe("ModeBanner", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setToken(null);
    localStorage.clear();
  });

  it("nothing renders before the actor resolves — no token, no /ops/mode call, no banner", () => {
    renderWithProviders(<ModeBanner />);
    expect(screen.queryByTestId("mode-banner")).not.toBeInTheDocument();
  });

  it("renders NOTHING when the mode is normal", async () => {
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /ops/mode": { status: 200, body: { mode: "normal", since: "2026-08-23T00:00:00.000Z", note: null, reportId: "r-1" } },
    });
    renderWithProviders(<ModeBanner />);
    await waitFor(() => expect(callsTo("GET", "/ops/mode")).toBeGreaterThan(0));
    expect(screen.queryByTestId("mode-banner")).not.toBeInTheDocument();
  });

  it.each(["commissioning", "ramp", "degraded", "downtime"] as const)(
    "renders a tinted banner with the mode word and note for mode=%s",
    async (mode) => {
      setToken("tok-1");
      mockRoutes({
        "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
        "GET /ops/mode": { status: 200, body: { mode, since: "2026-08-23T00:00:00.000Z", note: "generator on B feed", reportId: null } },
      });
      renderWithProviders(<ModeBanner />);

      const banner = await screen.findByTestId("mode-banner");
      expect(banner).toHaveAttribute("data-mode", mode);
      expect(screen.getByTestId("mode-banner-note")).toHaveTextContent("generator on B feed");
    },
  );

  it("renders no note span when the mode change carried none", async () => {
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /ops/mode": { status: 200, body: { mode: "ramp", since: "2026-08-23T00:00:00.000Z", note: null, reportId: null } },
    });
    renderWithProviders(<ModeBanner />);
    await screen.findByTestId("mode-banner");
    expect(screen.queryByTestId("mode-banner-note")).not.toBeInTheDocument();
  });

  /**
   * PRESENCE-ONLY, labelled as such (the `alerts-bell.test.tsx` precedent this copies): proves the
   * read is wired with `refetchInterval: 15_000` by observing a second GET after 15 s of fake
   * time. It cannot and does not attribute the second GET to the interval specifically rather than
   * some other re-render — that discriminating negative control lives on `billing-counter.test.tsx`'s
   * K39 and this is not a second copy of it.
   */
  it("the mode read carries refetchInterval 15_000 — a second GET arrives after 15 s of fake time", async () => {
    vi.useFakeTimers();
    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /ops/mode": { status: 200, body: { mode: "downtime", since: null, note: null, reportId: null } },
    });

    renderWithProviders(<ModeBanner />);
    await flush();
    await flush();
    const before = callsTo("GET", "/ops/mode");
    expect(before).toBeGreaterThan(0);

    await flush(15_000);
    expect(callsTo("GET", "/ops/mode")).toBeGreaterThan(before);
  });
});
