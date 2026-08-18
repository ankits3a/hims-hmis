import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { todayIst } from "../lib/opd-api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders } from "../test-utils";
import { OpdDisplay } from "./opd-display";

// 2026-08-18T04:00:00.000Z + 5:30 = 2026-08-18 09:30 IST — the T12/T13/T14/T15 pin, reused here.
const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

/**
 * jsdom ships no WebSocket a test can drive (flag ⑮), so the transport is replaced by this fake and
 * restored in afterEach. Copied deliberately from the realtime.test.ts / opd-consult precedent — a
 * test file is self-contained and never imports another *.test.ts(x).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
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
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

/**
 * `useSearch({ strict: false })` is the one TanStack Router hook this screen calls (flag ⑯); the
 * module is mocked down to it, per the Plan 05 convention (mock @tanstack/react-router down to the
 * hooks a screen actually uses). `searchState.current` is mutated per-test, not per-render.
 */
const searchState = vi.hoisted(() => ({ current: {} as { rooms?: string } }));
vi.mock("@tanstack/react-router", () => ({ useSearch: () => searchState.current }));

type Handler = { status: number; body: unknown } | (() => { status: number; body: unknown });

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = raw.split("?")[0]!;
      const key = `${init?.method ?? "GET"} ${path}`;
      const h = handlers[key];
      if (h === undefined) return new Response("{}", { status: 404 });
      const { status, body } = typeof h === "function" ? h() : h;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function fetchCalls(): { url: string; path: string; method: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { url, path: url.split("?")[0]!, method: init?.method ?? "GET" };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}

// ——— fixtures ———
// A published BoardItem, PLUS two fields (`patientName`, `uhid`) the real `boardSnapshot` never
// emits — §3.14c: an absence assertion proves nothing against a fixture that never had the thing.
// If the screen ever grew a stray `patient.name` read, this fixture is the one that would catch it.
const ITEM_A = {
  sessionId: "sess-1", roomId: "room-1", roomCode: "12", doctorId: "doc-1", doctorName: "Dr Meera Rao",
  departmentName: "General medicine", status: "in", nowServing: 5, next: [6, 7], waitingCount: 3,
  patientName: "Asha Devi", uhid: "HMS0000001234",
};
const ITEM_B = {
  sessionId: "sess-2", roomId: "room-2", roomCode: "14", doctorId: "doc-2", doctorName: "Dr Verma",
  departmentName: "Pediatrics", status: "out", nowServing: null, next: [], waitingCount: 0,
};
// The exact key set `apps/core`'s boardSnapshot emits (queue.test.ts's own "public surface" proof,
// mirrored here — flag ⑲): ITEM_B carries precisely these ten and nothing else.
const BOARD_ITEM_KEYS = [
  "departmentName", "doctorId", "doctorName", "next", "nowServing", "roomCode", "roomId", "sessionId", "status", "waitingCount",
];

describe("OpdDisplay", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    searchState.current = {};
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setToken(null);
    localStorage.clear();
  });

  it("opens no socket before Start; after Start, GET /opd/queues/board?serviceDate=&roomIds=<search> renders one card per item", async () => {
    // The clock is pinned so `todayIst()` — which both the screen and this test call — is TODAY.
    expect(todayIst()).toBe(TODAY);
    searchState.current = { rooms: "room-1,room-2" };
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /opd/queues/board": { status: 200, body: { items: [ITEM_A, ITEM_B] } },
    });
    const user = userEvent.setup();

    renderWithProviders(<OpdDisplay />);

    // before Start: the gate only, no board read, no socket. The button now carries BOTH
    // languages ("शुरू करें / Start" — the bilingual-label correction), so the accessible name is
    // no longer the exact string "Start"; match it as a substring instead.
    const startButton = screen.getByRole("button", { name: /Start/ });
    expect(callsTo("GET", "/opd/queues/board")).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(0);

    await user.click(startButton);

    await screen.findByTestId("board-card-sess-1");
    const url = callsTo("GET", "/opd/queues/board").at(-1)!.url;
    expect(url).toBe(`/opd/queues/board?serviceDate=${TODAY}&roomIds=room-1,room-2`);

    // after Start: the subscription is made — a WebSocket instance now exists.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);

    const cardA = screen.getByTestId("board-card-sess-1");
    expect(cardA).toHaveTextContent("12"); // room code
    expect(cardA).toHaveTextContent("Dr Meera Rao");
    expect(cardA).toHaveTextContent("General medicine");
    expect(screen.getByTestId("now-serving-sess-1")).toHaveTextContent("5");
    expect(cardA).toHaveTextContent("6, 7"); // next tokens

    expect(screen.getByTestId("board-card-sess-2")).toBeInTheDocument();
    expect(screen.getByTestId("now-serving-sess-2")).toHaveTextContent("—"); // no one being served
  });

  it("a queue.called frame updates NOW SERVING immediately and speaks hi-IN then en-IN; a queue.skipped frame clears NOW SERVING", async () => {
    searchState.current = { rooms: "room-1" };
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        lang = "";
        constructor(t: string) {
          this.text = t;
        }
      },
    );
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /opd/queues/board": { status: 200, body: { items: [ITEM_A] } },
    });
    const user = userEvent.setup();

    renderWithProviders(<OpdDisplay />);
    await user.click(screen.getByRole("button", { name: /Start/ }));
    await screen.findByTestId("board-card-sess-1");

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.simulateOpen();
    });
    await act(async () => {
      ws.simulateMessage({ type: "authed", userId: "u-1" });
    });

    const callsBeforeFrame = callsTo("GET", "/opd/queues/board").length;
    await act(async () => {
      ws.simulateMessage({
        type: "event", topic: "display:room-1", name: "queue.called", seq: 41, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY, sessionId: "sess-1", roomId: "room-1", tokenNo: 37 },
      });
    });

    // updated immediately — no GET fired to produce this value (§3.14c mechanism check). The cache
    // write is synchronous but react-query's notifyManager flushes the resulting re-render on a
    // microtask, so this reads through `waitFor` rather than asserting the instant `act()` returns.
    await waitFor(() => expect(screen.getByTestId("now-serving-sess-1")).toHaveTextContent("37"));
    expect(callsTo("GET", "/opd/queues/board")).toHaveLength(callsBeforeFrame);

    expect(speak).toHaveBeenCalledTimes(2);
    const [first, second] = speak.mock.calls.map(([u]) => u as { text: string; lang: string });
    expect(first!.lang).toBe("hi-IN");
    expect(first!.text).toBe("टोकन नंबर 37, कमरा 12");
    expect(second!.lang).toBe("en-IN");
    expect(second!.text).toBe("Token number 37, room 12");
    expect(cancel).toHaveBeenCalled();

    await act(async () => {
      ws.simulateMessage({
        type: "event", topic: "display:room-1", name: "queue.skipped", seq: 42, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY, sessionId: "sess-1", roomId: "room-1", tokenNo: 37 },
      });
    });
    await waitFor(() => expect(screen.getByTestId("now-serving-sess-1")).toHaveTextContent("—"));
  });

  it("refetchInterval polls every 15 s regardless of frames", async () => {
    searchState.current = { rooms: "room-1" };
    vi.useRealTimers(); // the shared beforeEach already mocked Date; useFakeTimers refuses on top of that
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    mockRoutes({
      "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
      "GET /opd/queues/board": { status: 200, body: { items: [ITEM_A] } },
    });

    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    renderWithProviders(<OpdDisplay />);
    await flush();
    // `userEvent` needs real timers for its internal delays (the opd-desk precedent) — `fireEvent`
    // dispatches the click synchronously and plays cleanly with fake timers.
    fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    await flush();
    await flush();

    expect(callsTo("GET", "/opd/queues/board")).toHaveLength(1);

    await flush(15_000);
    await flush();

    // `waitFor` cannot drive vitest's fake timers (it gates on a global `jest`, which vitest does
    // not define — probed on this harness), so the count is read directly after the hand-flush.
    expect(callsTo("GET", "/opd/queues/board").length).toBeGreaterThan(1);
  });

  it("shows no patient identifier and calls no /patients route — only /opd/queues/board is fetched", async () => {
    // The real wire shape (§3.14c mechanism, flag ⑲): the clean fixture's key set matches
    // boardSnapshot's ten keys exactly — no patient-identifying field exists at the SOURCE either.
    expect(Object.keys(ITEM_B).sort()).toEqual(BOARD_ITEM_KEYS);

    // No token: AuthProvider makes no /auth/me call either, so the ONLY possible fetch is the
    // component's own board read — the strongest form of "fetch keys are only the board route".
    mockRoutes({ "GET /opd/queues/board": { status: 200, body: { items: [ITEM_A, ITEM_B] } } });
    const user = userEvent.setup();

    renderWithProviders(<OpdDisplay />);
    await user.click(screen.getByRole("button", { name: /Start/ }));
    await screen.findByTestId("board-card-sess-1");

    // The fixture DOES carry a name and a UHID (ITEM_A above) — the board must not render them.
    expect(screen.queryByText(/UHID|Asha/)).toBeNull();
    expect(screen.queryByText("HMS0000001234")).toBeNull();

    const paths = new Set(fetchCalls().map((c) => c.path));
    expect(paths).toEqual(new Set(["/opd/queues/board"]));
    expect(fetchCalls().some((c) => c.path.includes("/patients"))).toBe(false);
  });
});
