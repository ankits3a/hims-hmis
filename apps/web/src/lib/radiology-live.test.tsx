import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setToken } from "./api";
import { resetRealtimeClientForTests } from "./realtime";
import { IMAGING_FLOOR_TOPIC, ORDER_SETTLE_MS, useImagingLive } from "./radiology-live";

/**
 * #1083 — the imaging lists' hook: a frame re-reads exactly the lists named, and a new order is read a
 * second time once the worker has had time to create its study (`ORDER_SETTLE_MS`). The fake socket is
 * the realtime.test.ts precedent (jsdom ships none a test can drive).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(): void { /* the subscribe frames are not this test's subject */ }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

function Probe({ lists }: { lists: (string | number)[][] }): null {
  useImagingLive(IMAGING_FLOOR_TOPIC, lists);
  return null;
}

const frame = (name: string) => ({ type: "event", topic: IMAGING_FLOOR_TOPIC, name, seq: 1, occurredAt: "x", payload: {} });

describe("useImagingLive (#1083)", () => {
  let qc: QueryClient;
  const reads: unknown[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    setToken("t");
    FakeWebSocket.instances = [];
    resetRealtimeClientForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    qc = new QueryClient();
    reads.length = 0;
    vi.spyOn(qc, "invalidateQueries").mockImplementation(async (filters) => { reads.push(filters); });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setToken(null); });

  const mount = (lists: (string | number)[][]) => {
    const view = render(<QueryClientProvider client={qc}><Probe lists={lists} /></QueryClientProvider>);
    const ws = FakeWebSocket.instances[0]!;
    act(() => { ws.readyState = 1; ws.onopen?.(); });
    act(() => { ws.onmessage?.({ data: JSON.stringify({ type: "authed", userId: "u-1" }) }); });
    const send = (name: string): void => { act(() => { ws.onmessage?.({ data: JSON.stringify(frame(name)) }); }); };
    return { view, send };
  };

  it("a floor frame re-reads exactly the lists named, once", () => {
    const { send } = mount([["radiology", "prep"], ["radiology", "worklist", "floor"]]);
    send("imaging.study_acquired");
    expect(reads).toEqual([
      { queryKey: ["radiology", "prep"], exact: true }, { queryKey: ["radiology", "worklist", "floor"], exact: true },
    ]);
    act(() => { vi.advanceTimersByTime(ORDER_SETTLE_MS + 1); });
    expect(reads).toHaveLength(2);
  });

  it("a new order is read now and once more after the settle window", () => {
    const { send } = mount([["radiology", "worklist", "floor"]]);
    send("order.placed");
    expect(reads).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(ORDER_SETTLE_MS - 1); });
    expect(reads).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(2); });
    expect(reads).toHaveLength(2);
  });

  it("the second read is dropped when the screen is gone", () => {
    const { view, send } = mount([["radiology", "worklist", "floor"]]);
    send("order.placed");
    view.unmount();
    act(() => { vi.advanceTimersByTime(ORDER_SETTLE_MS + 1); });
    expect(reads).toHaveLength(1);
  });
});
