import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { DB } from "../tokens";
import { findLiveSession } from "../auth/sessions";
import { hasPermission } from "../auth/permissions";
import { EventTail } from "./tail";
import type { TailedEvent } from "./tail";
import type { Db } from "../db/client";

export type TopicRouter = { names: string[]; topicsFor: (e: TailedEvent) => string[] };
/**
 * A space declares EXACTLY ONE of `permission` | `authorize`, validated at registerTopicSpace.
 * `permission` is the shipped role-gated form (`hasPermission` at hospital scope). `authorize`
 * is the identity-scoped form Plan 08.5 D6 adds for `alerts:<userId>`: a topic that belongs to
 * one human, where the answer is a property of the topic STRING and no role can grant it.
 */
export type TopicSpace = {
  prefix: string;
  permission?: string;
  authorize?: (userId: string, topic: string) => boolean;
};
export const REALTIME_PATH = "/ws";

type ClientState = { userId: string | null; topics: Set<string>; authTimer: NodeJS.Timeout | null };
type Inbound =
  | { type: "auth"; token: string } | { type: "subscribe"; topics: string[] } | { type: "unsubscribe"; topics: string[] } | { type: "ping" };

/** The wire is JSON text; RawData is a Buffer by default, a Buffer[] when the frame arrived fragmented. */
function textOf(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(new Uint8Array(raw)).toString("utf8");
}

function parseInbound(raw: RawData): Inbound | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textOf(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as { type?: unknown; token?: unknown; topics?: unknown };
  if (m.type === "auth" && typeof m.token === "string") return { type: "auth", token: m.token };
  if ((m.type === "subscribe" || m.type === "unsubscribe") && Array.isArray(m.topics) && m.topics.every((t) => typeof t === "string")) {
    return { type: m.type, topics: m.topics as string[] };
  }
  if (m.type === "ping") return { type: "ping" };
  return null;
}

/**
 * WebSocket fan-out (spec §5 realtime; §3 topology). Auth = the same bearer session HTTP uses, sent as the FIRST frame
 * (never in the URL — proxies log query strings). Topics are namespaced by a registered prefix, each with a permission
 * checked per subscribe via hasPermission (agents hold no permissions — Plan 02 seam — so agent tokens cannot subscribe).
 * Fan-out source = EventTail (per process, reads events.seq) — never an in-process emitter. Modules register routers and
 * topic spaces at their own module init; the kernel knows no module.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly routers: TopicRouter[] = [];
  private readonly spaces = new Map<string, TopicSpace>();
  private readonly clients = new Map<WebSocket, ClientState>();
  private wss: WebSocketServer | null = null;
  private tail: EventTail | null = null;
  private authTimeoutMs = 5000;

  constructor(@Inject(DB) private readonly db: Db, private readonly adapterHost: HttpAdapterHost) {}

  configure(opts: { authTimeoutMs?: number }): void { if (opts.authTimeoutMs !== undefined) this.authTimeoutMs = opts.authTimeoutMs; }
  registerRouter(r: TopicRouter): void { this.routers.push(r); }
  registerTopicSpace(s: TopicSpace): void {
    // Exactly one, refused at REGISTRATION rather than at subscribe: a space that declared
    // neither would silently reject every topic, and one that declared both would leave which
    // check actually runs to the reading order of a branch.
    const declared = (s.permission === undefined ? 0 : 1) + (s.authorize === undefined ? 0 : 1);
    if (declared !== 1) {
      throw new Error(`topic space "${s.prefix}" must declare exactly one of permission | authorize`);
    }
    this.spaces.set(s.prefix, s);
  }
  /** Union of every router's names — the tail's filter, re-read on each poll so late registrations count. */
  names(): string[] { return [...new Set(this.routers.flatMap((r) => r.names))]; }

  async onApplicationBootstrap(): Promise<void> {
    const server = this.adapterHost.httpAdapter.getHttpServer() as import("node:http").Server;
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname !== REALTIME_PATH) { socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    this.tail = new EventTail(this.db, () => this.names());
    this.tail.on((e) => this.fanOut(e));
    await this.tail.start();
  }

  /**
   * The tail must stop BEFORE the pool it reads is closed. Nest's close() runs every onModuleDestroy
   * hook (leaf modules first, root last) and only then onApplicationShutdown — and AppModule ends the
   * pg pool in ITS onModuleDestroy. Stopping the tail only in onApplicationShutdown leaves the 300 ms
   * interval armed across that gap, where a tick rejects with "Cannot use a pool after calling end on
   * the pool". RealtimeModule is a child of AppModule, so this hook runs first and closes the window.
   */
  onModuleDestroy(): void {
    this.tail?.stop();
  }

  onApplicationShutdown(): void {
    this.tail?.stop();
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    this.wss?.close();
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private accept(ws: WebSocket): void {
    const st: ClientState = { userId: null, topics: new Set(), authTimer: null };
    st.authTimer = setTimeout(() => {
      if (st.userId !== null) return;
      this.send(ws, { type: "error", code: "auth_timeout" });
      ws.close(4001, "auth_timeout");
    }, this.authTimeoutMs);
    st.authTimer.unref();
    this.clients.set(ws, st);
    ws.on("message", (raw: RawData) => { void this.onMessage(ws, raw); });
    ws.on("error", () => { ws.terminate(); });
    ws.on("close", () => {
      if (st.authTimer) clearTimeout(st.authTimer);
      st.authTimer = null;
      this.clients.delete(ws);
    });
  }

  private async onMessage(ws: WebSocket, raw: RawData): Promise<void> {
    const st = this.clients.get(ws);
    if (st === undefined) return;
    const msg = parseInbound(raw);
    if (msg === null) { this.send(ws, { type: "error", code: "bad_message" }); return; }
    switch (msg.type) {
      case "auth":
        await this.auth(ws, st, msg.token);
        return;
      case "subscribe":
        await this.subscribe(ws, st, msg.topics);
        return;
      case "unsubscribe":
        for (const t of msg.topics) st.topics.delete(t);
        this.send(ws, { type: "unsubscribed", topics: msg.topics });
        return;
      case "ping":
        this.send(ws, { type: "pong" });
        return;
    }
  }

  /**
   * PLAN 11e D1 — TWO REFUSALS, ONE OF THEM FREE.
   *
   * The DEACTIVATED case costs no code at all: `findLiveSession` joins `users` and returns null for
   * an inactive one, so the existing null branch below closes the socket on a retired employee's
   * still-valid token exactly as it does on a forged one. That is the reason the check lives at the
   * choke point rather than in the two callers (sessions.ts).
   *
   * The MUST-CHANGE case is refused explicitly and with the same 4001, because a person mid-
   * credential-reset has no business streaming a hospital's live event fabric, and the
   * change-password flow is plain HTTP that needs no socket.
   */
  private async auth(ws: WebSocket, st: ClientState, token: string): Promise<void> {
    const session = await findLiveSession(this.db, token);
    if (session === null || session.mustChangePassword) {
      this.send(ws, { type: "error", code: "unauthorized" });
      ws.close(4001, "unauthorized");
      return;
    }
    if (st.authTimer) { clearTimeout(st.authTimer); st.authTimer = null; }
    st.userId = session.userId;
    this.send(ws, { type: "authed", userId: session.userId });
  }

  private async subscribe(ws: WebSocket, st: ClientState, topics: string[]): Promise<void> {
    if (st.userId === null) { this.send(ws, { type: "error", code: "unauthorized" }); return; }
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const topic of topics) {
      const space = this.spaces.get(topic.split(":")[0] ?? "");
      // ONE BRANCH. The permission path is unchanged for every space that declares one; an
      // `authorize` space never reaches hasPermission, because there is no permission to check.
      const allowed =
        space === undefined ? false
          : space.authorize !== undefined ? space.authorize(st.userId, topic)
            : await hasPermission(this.db, st.userId, space.permission!, "hospital");
      if (!allowed) {
        rejected.push(topic);
        continue;
      }
      st.topics.add(topic);
      accepted.push(topic);
    }
    if (accepted.length > 0) this.send(ws, { type: "subscribed", topics: accepted });
    if (rejected.length > 0) this.send(ws, { type: "error", code: "forbidden_topic", topics: rejected });
  }

  private fanOut(e: TailedEvent): void {
    const topics = new Set(this.routers.filter((r) => r.names.includes(e.name)).flatMap((r) => r.topicsFor(e)));
    if (topics.size === 0) return;
    for (const [ws, st] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      for (const t of topics) if (st.topics.has(t)) ws.send(JSON.stringify({ type: "event", topic: t, name: e.name, seq: e.seq, occurredAt: e.occurredAt.toISOString(), payload: e.payload }));
    }
  }
}
