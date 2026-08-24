import { useEffect, useRef, useState } from "react";
import { API_BASE, getToken } from "./api";

export type EventFrame = { type: "event"; topic: string; name: string; seq: number; occurredAt: string; payload: unknown };
type ServerFrame = EventFrame | { type: "authed"; userId: string } | { type: "subscribed" | "unsubscribed"; topics: string[] } | { type: "pong" } | { type: "error"; code: string; topics?: string[] };
type Handler = (f: EventFrame) => void;

/** One socket per tab; topics are reference-counted; auth is the first frame; reconnect with capped exponential backoff. */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private authed = false;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly listeners = new Set<(connected: boolean) => void>();
  constructor(private readonly url: string, private readonly token: () => string | null) {}

  onStatus(l: (connected: boolean) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  get connected(): boolean { return this.authed; }

  subscribe(topics: string[], h: Handler): () => void {
    const fresh: string[] = [];
    for (const t of topics) {
      let set = this.handlers.get(t);
      if (!set) { set = new Set(); this.handlers.set(t, set); fresh.push(t); }
      set.add(h);
    }
    this.ensureOpen();
    if (this.authed && fresh.length > 0) this.send({ type: "subscribe", topics: fresh });
    return () => {
      const gone: string[] = [];
      for (const t of topics) {
        const set = this.handlers.get(t);
        if (!set) continue;
        set.delete(h);
        if (set.size === 0) { this.handlers.delete(t); gone.push(t); }
      }
      if (this.authed && gone.length > 0) this.send({ type: "unsubscribe", topics: gone });
    };
  }

  private ensureOpen(): void {
    if (this.ws !== null || this.token() === null) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.send({ type: "auth", token: this.token() }); };
    ws.onmessage = (ev: MessageEvent<string>) => {
      let f: ServerFrame;
      try { f = JSON.parse(ev.data) as ServerFrame; } catch { return; }
      if (f.type === "authed") {
        this.authed = true; this.backoffMs = 1000;
        const topics = [...this.handlers.keys()];
        if (topics.length > 0) this.send({ type: "subscribe", topics });
        for (const l of this.listeners) l(true);
      } else if (f.type === "event") {
        for (const h of this.handlers.get(f.topic) ?? []) h(f);
      }
    };
    ws.onclose = () => {
      this.ws = null; this.authed = false;
      for (const l of this.listeners) l(false);
      if (this.handlers.size === 0) return;
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.ensureOpen(); }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }
  private send(obj: unknown): void { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
}

let singleton: RealtimeClient | null = null;
export function realtimeClient(): RealtimeClient {
  if (singleton === null) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // The socket rides the same origin rule as every fetch (DD1): `/api/ws`, stripped back to
    // `/ws` by the edge, so the gateway's own path is untouched.
    singleton = new RealtimeClient(`${proto}://${location.host}${API_BASE}/ws`, getToken);
  }
  return singleton;
}
/** test seam */
export function resetRealtimeClientForTests(): void { singleton = null; }

/** Subscribe to topics for the component's lifetime; onEvent is read through a ref so callers may pass a fresh closure every render. */
export function useRealtime(topics: string[], onEvent: (f: EventFrame) => void): { connected: boolean } {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = topics.join("|");
  const [connected, setConnected] = useState(realtimeClient().connected);
  useEffect(() => {
    const client = realtimeClient();
    const off = client.subscribe(key === "" ? [] : key.split("|"), (f) => cb.current(f));
    const offStatus = client.onStatus(setConnected);
    return () => { off(); offStatus(); };
  }, [key]);
  return { connected };
}
