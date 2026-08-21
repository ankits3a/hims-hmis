export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
    this.name = "ApiError";
  }
}

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
  const res = await fetch(path, {
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
