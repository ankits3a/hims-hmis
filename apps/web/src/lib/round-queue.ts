import { ApiError, api } from "./api";
import type { IpdRoundSoap } from "@hmis/contracts";

/**
 * ═══ #962 (plan DD-IPD.4, D10) — ROUND NOTES SAVE ON THE PHONE FIRST ═══
 *
 * Ward wifi drops. A note the doctor signs is written to the phone (IndexedDB) BEFORE anything is sent, with a
 * client-generated id, the instant she signed (`signedAt`) and nothing else decided. Sending is IPD's own act —
 * `POST /ipd/rounds/sign` — with the client id AS its idempotency key, so a replay (a dropped answer, a second tab, a
 * reconnect mid-queue) lands the note exactly once: the server answers the first result for the same key.
 *
 *   queued    → saved on the phone, not yet acknowledged by the server
 *   synced    → the server answered; `syncedAt` is when, `roundId` its row
 *   conflict  → the server REFUSED it (not a network failure): the note is kept, both stand, and the screen flags it
 *               for the doctor (DECIDED: keep both and flag — never drop words a doctor wrote).
 *
 * The signing time travels as the round's `seenAt`; the server stamps its own receipt (`created_at`), which the Round
 * screen shows as the sync time. Nothing here reads money (decision 0058).
 */

export type QueuedNote = {
  clientId: string;
  /** Always the client id: the replay key IPD's `signRound` dedupes on. */
  idempotencyKey: string;
  admissionId: string;
  mode: "bedside" | "remote_review";
  soap: IpdRoundSoap;
  /** When the doctor signed, on the phone (sent as `seenAt`). */
  signedAt: string;
  status: "queued" | "synced" | "conflict";
  /** When the server acknowledged it (the phone's clock at the answer). */
  syncedAt: string | null;
  roundId: string | null;
  /** The refusal's code on a conflict. */
  error: string | null;
};

export type NoteStore = {
  all(): Promise<QueuedNote[]>;
  put(n: QueuedNote): Promise<void>;
};

export type SignBody = { idempotencyKey: string; admissionId: string; seenAt: string; mode: "bedside" | "remote_review"; soap: IpdRoundSoap };
export type SignAnswer = { roundId: string; status: "signed" | "awaiting_cosign" };
export type Sender = (body: SignBody) => Promise<SignAnswer>;

/** The real sender: IPD's sign route, the client id in the body AND the header. */
export const sendToIpd: Sender = (body) => api<SignAnswer>("POST", "/ipd/rounds/sign", body, body.idempotencyKey);

/** A v4 UUID (IPD's idempotency keys are UUIDs), from `crypto` when the browser has it. */
export function clientUuid(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function memoryNoteStore(): NoteStore {
  const rows = new Map<string, QueuedNote>();
  return {
    all: async () => [...rows.values()].map((n) => ({ ...n })),
    put: async (n) => { rows.set(n.clientId, { ...n }); },
  };
}

const DB_NAME = "hmis-doctor-desk";
const STORE = "round-notes";

/**
 * The phone's store: IndexedDB, one record per note keyed by client id. A browser without it (a private window that
 * refuses it) falls back to memory — the note still sends while the page is open; the screen says so.
 */
export function idbNoteStore(): NoteStore {
  const idb: IDBFactory | undefined = globalThis.indexedDB;
  if (idb === undefined) return memoryNoteStore();
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "clientId" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    });
    return opened;
  };
  const run = async <T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
    });
  };
  return {
    all: async () => (await run("readonly", (s) => s.getAll())) as QueuedNote[],
    put: async (n) => { await run("readwrite", (s) => s.put(n)); },
  };
}

/** A failure that is the network's (retry later), not the server's word (a conflict to flag). */
function isNetwork(e: unknown): boolean {
  // Signed out (401) waits for the next sign-in like a dropped network; it is not the server refusing the note.
  if (e instanceof ApiError) return e.status >= 500 || e.status === 0 || e.status === 401 || e.status === 408 || e.status === 429;
  return true;
}

function codeOf(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | undefined;
    if (body !== undefined && typeof body.code === "string") return body.code;
    return `http_${String(e.status)}`;
  }
  return "network";
}

export class RoundNoteQueue {
  private running: Promise<{ sent: number; conflicts: number }> | null = null;

  constructor(
    private readonly store: NoteStore,
    private readonly send: Sender = sendToIpd,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Sign a note: saved on the phone FIRST, then one attempt to send it (and anything else waiting). */
  async sign(input: { admissionId: string; mode: "bedside" | "remote_review"; soap: IpdRoundSoap }): Promise<QueuedNote> {
    const clientId = clientUuid();
    const note: QueuedNote = {
      clientId, idempotencyKey: clientId, admissionId: input.admissionId, mode: input.mode, soap: input.soap,
      signedAt: this.now().toISOString(), status: "queued", syncedAt: null, roundId: null, error: null,
    };
    await this.store.put(note);
    await this.replay().catch(() => undefined);
    return (await this.store.all()).find((n) => n.clientId === clientId) ?? note;
  }

  /** Send every queued note once, oldest first. Concurrent calls share one run. A network failure stops the run. */
  replay(): Promise<{ sent: number; conflicts: number }> {
    this.running ??= this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<{ sent: number; conflicts: number }> {
    let sent = 0;
    let conflicts = 0;
    const waiting = (await this.store.all()).filter((n) => n.status === "queued").sort((a, b) => a.signedAt.localeCompare(b.signedAt));
    for (const n of waiting) {
      try {
        const answer = await this.send({ idempotencyKey: n.idempotencyKey, admissionId: n.admissionId, seenAt: n.signedAt, mode: n.mode, soap: n.soap });
        await this.store.put({ ...n, status: "synced", syncedAt: this.now().toISOString(), roundId: answer.roundId, error: null });
        sent += 1;
      } catch (e) {
        if (isNetwork(e)) break;
        await this.store.put({ ...n, status: "conflict", error: codeOf(e) });
        conflicts += 1;
      }
    }
    return { sent, conflicts };
  }

  /** The notes on the phone (all, or one admission's), newest signed first. */
  async list(admissionId?: string): Promise<QueuedNote[]> {
    const all = await this.store.all();
    return all.filter((n) => admissionId === undefined || n.admissionId === admissionId).sort((a, b) => b.signedAt.localeCompare(a.signedAt));
  }
}

let shared: RoundNoteQueue | null = null;
/** The page's one queue over IndexedDB; replays when the browser comes back online. */
export function roundQueue(): RoundNoteQueue {
  if (shared === null) {
    shared = new RoundNoteQueue(idbNoteStore());
    const q = shared;
    globalThis.addEventListener?.("online", () => { void q.replay(); });
  }
  return shared;
}
