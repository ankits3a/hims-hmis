import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithRouter } from "../test-utils";
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
    ackKind: null, acknowledgedAt: null, ownedUntil: null, ackNote: null,
    handedToUserId: null, ackExtensions: 0,
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
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /api/alerts": () => ({ status: 200, body: { items: [alertRow({ readAt })], unreadCount } }),
      "POST /api/alerts/al-1/read": () => {
        readAt = NOW_ISO;
        unreadCount = 0;
        return { status: 201, body: { alertId: "al-1", readAt: NOW_ISO, alreadyRead: false } };
      },
    });

    renderWithRouter(<AlertsBell />);

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

    const posts = callsTo("POST", "/api/alerts/al-1/read");
    expect(posts).toHaveLength(1);
    // SubmitButton's minted key travels to the server even though the route ignores it (D6) — the
    // convention is about the CLIENT being single-flight, not about the server needing the key.
    expect(posts[0]!.headers["Idempotency-Key"]).toMatch(/\S/);
  });

  it("nothing renders before the actor resolves — no token, no /alerts call, no bell", () => {
    renderWithRouter(<AlertsBell />);
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
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /api/alerts": { status: 200, body: { items: [], unreadCount: 0 } },
    });

    renderWithRouter(<AlertsBell />);
    await flush();
    await flush();
    const before = callsTo("GET", "/api/alerts").length;
    expect(before).toBeGreaterThan(0);

    await flush(15_000);
    expect(callsTo("GET", "/api/alerts").length).toBeGreaterThan(before);
  });

  // ═══════════════════════════ PHASE O T3 — THE ANSWER LINE AND THE DEEP LINK ═══════════════════════════

  it("offers the three answers on an unanswered alert, and `Own` posts a bounded promise", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    let row = alertRow();
    mockRoutes({
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /api/alerts": () => ({ status: 200, body: { items: [row], unreadCount: row.readAt === null ? 1 : 0 } }),
      "POST /api/alerts/al-1/ack": () => {
        row = alertRow({ ackKind: "owned", acknowledgedAt: NOW_ISO, ownedUntil: NOW_ISO, readAt: NOW_ISO });
        return { status: 201, body: { alertId: "al-1", kind: "owned", acknowledgedAt: NOW_ISO, ownedUntil: NOW_ISO, handedToUserId: null, ackExtensions: 0, changed: true } };
      },
    });

    renderWithRouter(<AlertsBell />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alerts-bell-toggle"));

    expect(await screen.findByTestId("alerts-ack-seen-al-1")).toBeInTheDocument();
    expect(screen.getByTestId("alerts-ack-own-al-1")).toBeInTheDocument();
    expect(screen.getByTestId("alerts-ack-handover-al-1")).toBeInTheDocument();
    // The offer says how long it is for. "Own" with no number is the promise G5 is about.
    expect(screen.getByTestId("alerts-ack-own-al-1")).toHaveTextContent("Own 30m");

    await user.click(screen.getByTestId("alerts-ack-own-al-1"));

    await waitFor(() => expect(callsTo("POST", "/api/alerts/al-1/ack")).toHaveLength(1));
    const sent = vi.mocked(fetch).mock.calls.find(([i, init]) => String(i).includes("/ack") && init?.method === "POST");
    expect(JSON.parse(String(sent![1]!.body))).toEqual({ kind: "owned", untilMinutes: 30 });

    // Answered: the row now says what the answer WAS instead of offering it again.
    await waitFor(() => expect(screen.getByTestId("alerts-ack-state-al-1")).toHaveTextContent("Yours"));
    expect(screen.queryByTestId("alerts-ack-own-al-1")).not.toBeInTheDocument();
  });

  it("deep-links an APPROVAL alert to the card it is about, and links nothing for a ref type with no screen", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    mockRoutes({
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /api/alerts": {
        status: 200,
        body: {
          items: [
            alertRow({ id: "al-1", refType: "approval", refId: "ap-9" }),
            // The ref EVERY escalation alert carries, and the one with no screen to land on.
            // A link built by template rather than by the closed map would send a reader to a
            // route that renders nothing — this is the negative half of the same claim.
            alertRow({ id: "al-2", refType: "workflow_instance", refId: "wf-9" }),
          ],
          unreadCount: 2,
        },
      },
    });

    renderWithRouter(<AlertsBell />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alerts-bell-toggle"));

    const link = await screen.findByTestId("alerts-open-al-1");
    expect(link).toHaveAttribute("href", "/approvals?focus=ap-9");
    expect(screen.queryByTestId("alerts-open-al-2")).not.toBeInTheDocument();
  });

  it("hand over asks for a staff code and posts it; a cancelled prompt posts nothing", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    mockRoutes({
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /api/alerts": { status: 200, body: { items: [alertRow()], unreadCount: 1 } },
      "POST /api/alerts/al-1/ack": { status: 201, body: { alertId: "al-1", kind: "handed_over", acknowledgedAt: NOW_ISO, ownedUntil: null, handedToUserId: "u-2", ackExtensions: 0, changed: true } },
    });

    renderWithRouter(<AlertsBell />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alerts-bell-toggle"));

    vi.stubGlobal("prompt", vi.fn(() => null));
    await user.click(await screen.findByTestId("alerts-ack-handover-al-1"));
    expect(callsTo("POST", "/api/alerts/al-1/ack")).toHaveLength(0);

    vi.stubGlobal("prompt", vi.fn(() => "  EMP-0002  "));
    await user.click(screen.getByTestId("alerts-ack-handover-al-1"));
    await waitFor(() => expect(callsTo("POST", "/api/alerts/al-1/ack")).toHaveLength(1));
    const sent = vi.mocked(fetch).mock.calls.find(([i, init]) => String(i).includes("/ack") && init?.method === "POST");
    // Trimmed: a badge number typed with a stray space is the same badge number.
    expect(JSON.parse(String(sent![1]!.body))).toEqual({ kind: "handed_over", handedToStaffCode: "EMP-0002" });
  });
});
