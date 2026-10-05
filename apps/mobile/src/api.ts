import { API_BASE } from "./config";

/**
 * The one door to the server. Same contract as the web's `lib/api.ts`: `Authorization: Bearer`,
 * JSON in and out, and a refusal surfaces as `ApiError` with the HTTP status and the server's
 * machine-readable `code` (Nest puts it in `message` for a string exception, or `code` for an
 * object one).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(`${status} ${code}`);
  }
}

/** The request never reached the server (no signal, DNS, TLS). Distinct from a refusal. */
export class NetworkError extends Error {}

export type Fetcher = typeof fetch;

export function codeOf(body: unknown): string {
  if (body !== null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.code === "string") return b.code;
    if (typeof b.message === "string") return b.message;
  }
  return "unknown";
}

export async function api<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: { token?: string | null; body?: unknown; fetcher?: Fetcher; base?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await (opts.fetcher ?? fetch)(`${opts.base ?? API_BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new ApiError(res.status, codeOf(parsed), parsed);
  return parsed as T;
}
