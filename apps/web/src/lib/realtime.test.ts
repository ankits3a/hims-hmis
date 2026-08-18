import { createElement, type ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { setToken } from "./api";
import { realtimeClient, resetRealtimeClientForTests, useRealtime, type EventFrame } from "./realtime";

/**
 * jsdom ships no WebSocket that a test can drive (verify-by-execution flag ⑮), so the whole
 * transport is replaced by this fake and restored in afterEach. `static OPEN = 1` is load-bearing:
 * RealtimeClient.send() guards on `WebSocket.OPEN`, which resolves to the stubbed global.
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
    this.simulateClose();
  }
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  simulateClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

type Frame = { type: string } & Record<string, unknown>;

function socket(i: number): FakeWebSocket {
  return FakeWebSocket.instances[i]!;
}
function frames(ws: FakeWebSocket): Frame[] {
  return ws.sent.map((s) => JSON.parse(s) as Frame);
}
function framesOfType(ws: FakeWebSocket, type: string): Frame[] {
  return frames(ws).filter((f) => f.type === type);
}

const AUTH_FRAME = { type: "auth", token: "tok-1" };
const EVENT: EventFrame = {
  type: "event", topic: "queue:doc-1:2026-08-17", name: "queue.called", seq: 41,
  occurredAt: "2026-08-17T04:30:00.000Z", payload: { tokenNo: 7 },
};

describe("RealtimeClient", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    resetRealtimeClientForTests();
    setToken("tok-1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setToken(null);
    localStorage.clear();
  });

  it("opens /ws and sends auth as the FIRST frame — nothing is sent before it", () => {
    realtimeClient().subscribe(["queue:doc-1:2026-08-17"], vi.fn());

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket(0).url).toBe(`ws://${location.host}/ws`);
    // Teeth for K39: the socket exists but has carried NOTHING before open.
    expect(socket(0).sent).toEqual([]);

    socket(0).simulateOpen();
    // Exactly one frame, and it is auth — a subscribe sent on open would land here first.
    expect(frames(socket(0))).toEqual([AUTH_FRAME]);
  });

  it("sends subscribe with the deduped topic list only after `authed`", () => {
    const client = realtimeClient();
    client.subscribe(["queue:a", "queue:b"], vi.fn());
    client.subscribe(["queue:b", "queue:c"], vi.fn()); // queue:b is already tracked — one entry, not two
    socket(0).simulateOpen();

    expect(frames(socket(0))).toEqual([AUTH_FRAME]); // still nothing but auth

    socket(0).simulateMessage({ type: "authed", userId: "u-1" });

    expect(frames(socket(0))).toEqual([
      AUTH_FRAME,
      { type: "subscribe", topics: ["queue:a", "queue:b", "queue:c"] },
    ]);
  });

  it("delivers an event frame only to the handlers registered for that topic", () => {
    const client = realtimeClient();
    const onQueue = vi.fn();
    const onDisplay = vi.fn();
    client.subscribe([EVENT.topic], onQueue);
    client.subscribe(["display:room-4"], onDisplay);
    socket(0).simulateOpen();
    socket(0).simulateMessage({ type: "authed", userId: "u-1" });

    socket(0).simulateMessage(EVENT);

    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onQueue).toHaveBeenCalledWith(EVENT);
    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("unsubscribes only when the LAST handler for a topic leaves", () => {
    const client = realtimeClient();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = client.subscribe([EVENT.topic], first);
    const offSecond = client.subscribe([EVENT.topic], second);
    socket(0).simulateOpen();
    socket(0).simulateMessage({ type: "authed", userId: "u-1" });

    offFirst();

    // Teeth for K40: one handler is gone, one remains — the topic is still ours.
    expect(framesOfType(socket(0), "unsubscribe")).toEqual([]);
    socket(0).simulateMessage(EVENT);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    offSecond();

    expect(framesOfType(socket(0), "unsubscribe")).toEqual([
      { type: "unsubscribe", topics: [EVENT.topic] },
    ]);
  });

  it("reconnects on 1000 → 2000 → 4000 … capped at 30000 ms, then re-auths and re-subscribes every active topic", () => {
    const client = realtimeClient();
    client.subscribe(["queue:a", "display:room-4"], vi.fn());
    socket(0).simulateOpen();
    socket(0).simulateMessage({ type: "authed", userId: "u-1" });

    // Each close schedules the NEXT reconnect; the delay is read from the timers, never the source.
    const expectedDelays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    for (const [i, delay] of expectedDelays.entries()) {
      socket(i).simulateClose();
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(i + 2);
    }

    const revived = socket(FakeWebSocket.instances.length - 1);
    revived.simulateOpen();
    revived.simulateMessage({ type: "authed", userId: "u-1" });

    expect(frames(revived)).toEqual([
      AUTH_FRAME,
      { type: "subscribe", topics: ["queue:a", "display:room-4"] },
    ]);
  });

  it("useRealtime subscribes on mount, reads onEvent through a ref, and unsubscribes on unmount", () => {
    function Probe({ topics, onEvent }: { topics: string[]; onEvent: (f: EventFrame) => void }): ReactElement {
      const { connected } = useRealtime(topics, onEvent);
      return createElement("span", { "data-testid": "conn" }, String(connected));
    }

    const firstCb = vi.fn();
    const secondCb = vi.fn();
    const { rerender, unmount, getByTestId } = render(
      createElement(Probe, { topics: [EVENT.topic], onEvent: firstCb }),
    );
    act(() => {
      socket(0).simulateOpen();
      socket(0).simulateMessage({ type: "authed", userId: "u-1" });
    });
    expect(frames(socket(0))).toEqual([AUTH_FRAME, { type: "subscribe", topics: [EVENT.topic] }]);
    expect(getByTestId("conn").textContent).toBe("true");

    // A fresh closure every render is the normal React case — it must NOT re-run the effect.
    rerender(createElement(Probe, { topics: [EVENT.topic], onEvent: secondCb }));
    expect(frames(socket(0))).toEqual([AUTH_FRAME, { type: "subscribe", topics: [EVENT.topic] }]);

    act(() => {
      socket(0).simulateMessage(EVENT);
    });
    expect(secondCb).toHaveBeenCalledWith(EVENT);
    expect(firstCb).not.toHaveBeenCalled();

    unmount();

    expect(framesOfType(socket(0), "unsubscribe")).toEqual([
      { type: "unsubscribe", topics: [EVENT.topic] },
    ]);
  });
});
