import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders } from "../test-utils";
import { AlertsBell } from "./alerts-bell";

/**
 * jsdom ships no WebSocket a test can drive (the opd-vitals.test.tsx / opd-desk.test.tsx
 * precedent), so the transport is replaced by this fake and restored in afterEach. Copied
 * deliberately — a test file is self-contained, it never imports another *.test.ts(x).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

// 2026-08-21T09:40:00.000Z + 5:30 = 15:10 IST — arbitrary pin; this component reads no calendar
// date, only elapsed minutes since an alert's `createdAt`.
const NOW_ISO = "2026-08-21T09:40:00.000Z";

type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

/** `stubFetch` always answers 200; a POST here must answer 201 (D6), so a direct stub is used. */
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

function fetchCalls(): { method: string; path: string; headers: Record<string, string> }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    method: init?.method ?? "GET",
    path: String(input).split("?")[0]!,
    headers: (init?.headers as Record<string, string> | undefined) ?? {},
  }));
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}

function alertRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "al-1", kind: "escalation", title: "OPD wait escalated — reception queue", body: null,
    refType: "workflow_instance", refId: "wf-1", createdAt: NOW_ISO, readAt: null,
    ...over,
  };
}

describe("AlertsBell", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setToken(null);
    localStorage.clear();
  });

  it("renders the unread badge and the panel's rows from GET /alerts, and mark-read clears the badge", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    let unreadCount = 1;
    let readAt: string | null = null;
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /alerts": () => ({ status: 200, body: { items: [alertRow({ readAt })], unreadCount } }),
      "POST /alerts/al-1/read": () => {
        readAt = NOW_ISO;
        unreadCount = 0;
        return { status: 201, body: { alertId: "al-1", readAt: NOW_ISO, alreadyRead: false } };
      },
    });

    renderWithProviders(<AlertsBell />);

    const badge = await screen.findByTestId("alerts-unread-badge");
    expect(badge).toHaveTextContent("1");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("alerts-bell-toggle"));
    expect(await screen.findByText("OPD wait escalated — reception queue")).toBeInTheDocument();
    // The relative-time label, wired to `alertRow`'s `createdAt` sitting exactly on the pinned
    // system time (0 minutes elapsed) — proves `relativeLabel` reached the panel, not just the title.
    expect(screen.getByText("Just now")).toBeInTheDocument();

    await user.click(screen.getByTestId("alerts-mark-read-al-1"));
    await waitFor(() => expect(screen.queryByTestId("alerts-unread-badge")).not.toBeInTheDocument());

    const posts = callsTo("POST", "/alerts/al-1/read");
    expect(posts).toHaveLength(1);
    // SubmitButton's minted key travels to the server even though the route ignores it (D6) — the
    // convention is about the CLIENT being single-flight, not about the server needing the key.
    expect(posts[0]!.headers["Idempotency-Key"]).toMatch(/\S/);
  });

  it("nothing renders before the actor resolves — no token, no /alerts call, no bell", () => {
    renderWithProviders(<AlertsBell />);
    expect(screen.queryByTestId("alerts-bell-toggle")).not.toBeInTheDocument();
  });

  /**
   * PRESENCE-ONLY, and labelled as such (the pipeline-C precedent, billing-session.test.tsx's
   * K39 sibling): this proves the read is WIRED with `refetchInterval: 15_000` — it kills
   * DELETION of that option — and nothing more. It cannot attribute the second GET to the
   * interval specifically rather than to some other re-render, and it does not try to: the
   * convention's discriminating teeth (a 14 s negative control separating "the interval fired"
   * from "something re-rendered") live on `billing-counter.test.tsx`'s K39. This is not a second
   * copy of them.
   */
  it("the alerts read carries refetchInterval 15_000 — a second GET arrives after 15 s of fake time", async () => {
    vi.useRealTimers(); // the shared beforeEach already mocked Date; useFakeTimers refuses on top of that
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /alerts": { status: 200, body: { items: [], unreadCount: 0 } },
    });

    renderWithProviders(<AlertsBell />);
    await flush();
    await flush();
    const before = callsTo("GET", "/alerts").length;
    expect(before).toBeGreaterThan(0);

    await flush(15_000);
    expect(callsTo("GET", "/alerts").length).toBeGreaterThan(before);
  });
});
