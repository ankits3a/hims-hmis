export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
    this.name = "ApiError";
  }
}

/**
 * PLAN 11g / DD1 — THE ORIGIN'S ONE RULE: `/api/*` IS THE API, EVERYTHING ELSE IS THE APPLICATION.
 *
 * Until this constant existed the SPA requested `/patients`, `/billing`, `/admin/users` … — the
 * same paths its own ROUTER declares screens on. The production edge matches API traffic by PATH
 * alone (no method, no `Accept`), so a browser asking for the `/admin/users` SCREEN was handed the
 * API's `{"statusCode":401}`, and 15 of the 20 screens did not load at all: the smoke test's D1.
 *
 * Every request the app makes goes through `api()` below and therefore through this prefix — that
 * "one door" property is what makes the rule total, and `caddyfile-parity.test.ts` pins it, along
 * with the fact that no SPA route may fall inside the proxied space. The API's OWN path space is
 * unchanged: Caddy strips the prefix (`uri strip_prefix /api`) and the vite dev proxy rewrites it
 * away, so `@Controller("billing")` and every supertest e2e suite still speak `/billing`.
 */
export const API_BASE = "/api";

const TOKEN_KEY = "hmis.token";
let token: string | null = localStorage.getItem(TOKEN_KEY);

export function getToken(): string | null {
  return token;
}
export function setToken(next: string | null): void {
  token = next;
  if (next === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, next);
}

/**
 * A fresh key for ONE submit attempt. `SubmitButton` mints it and hands it to the handler, so
 * every request that attempt makes travels under the same key and a duplicate DELIVERY of any of
 * them is recognised by the server (migration 0013). A deliberate second submit mints a NEW key
 * and is a new attempt — which is correct: the guard is against duplicated delivery, never against
 * a cashier who means it.
 */
export function newIdempotencyKey(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function api<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) setToken(null); // guard bounces to /login on next navigation
  const text = await res.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

/**
 * PLAN 07c T3 — THE CLIENT HALF OF THE APP'S FIRST EXPORT, AND IT LIVES IN THIS FILE ON PURPOSE.
 *
 * `api()` parses JSON, so it cannot carry a CSV; the obvious move is a `fetch` in a download hook
 * beside the screen that uses it. **That is forbidden, and a test enforces it**:
 * `caddyfile-parity.test.ts` asserts `fetchCallingModules()` equals exactly `["lib/api.ts"]`,
 * because the one-door property is what makes `API_BASE`, the `Authorization` header and the 401
 * handling total rather than conventional (11g / DD1). A screen that reached for `fetch` directly
 * would skip all three in one line, and in production its request would land on the SPA handler and
 * come back as `index.html` with a 200. So the second door is built here, next to the first.
 *
 * ═══ THE SERVER NAMES THE FILE ═══
 *
 * `Content-Disposition` is READ rather than reconstructed. The server already sanitises the name
 * (`kernel/report/csv.ts` — everything outside `[A-Za-z0-9._-]` becomes a dash, so a report title
 * carrying a slash cannot steer a path), and a client that invented its own would drift from the
 * `report.exported` event the export writes. `fallbackName` covers an edge that strips the header,
 * which is a real deployment rather than a hypothetical.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const quoted = /filename\s*=\s*"([^"]+)"/.exec(header);
  const bare = /filename\s*=\s*([^;]+)/.exec(header);
  return (quoted?.[1] ?? bare?.[1])?.trim() ?? null;
}

export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method: "GET", headers });
  if (res.status === 401) setToken(null); // guard bounces to /login on next navigation
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? fallbackName;
  /*
   * In the tree before the click and out of it after: a click on an anchor that is not in the
   * document is ignored by Firefox. The object URL is revoked in the same turn, because a blob that
   * is never revoked is a leak that grows with every export of a long day.
   */
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
