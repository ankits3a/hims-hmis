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
  opts: { token?: string | null; body?: unknown; fetcher?: Fetcher; base?: string; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  // The web's own header (`lib/api.ts`): the server answers a REPLAY of a key with the first answer, never a second write.
  if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
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

/**
 * A POST whose upload progress is reported — `fetch` cannot say how much of a body has left the
 * phone, and a slip's photograph on a ward's mobile data takes long enough that the desk needs to
 * see it moving. Same contract as `api`: `ApiError` for a refusal, `NetworkError` when it never arrived.
 */
export function xhrPost<T>(path: string, token: string | null, body: unknown, onProgress: (fraction: number) => void, base: string = API_BASE): Promise<T> {
  return new Promise<T>((done, fail) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}${path}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total)); };
    xhr.onerror = () => { fail(new NetworkError("network")); };
    xhr.ontimeout = () => { fail(new NetworkError("timeout")); };
    xhr.onload = () => {
      let parsed: unknown = undefined;
      if (xhr.responseText !== "") {
        try { parsed = JSON.parse(xhr.responseText); } catch { parsed = xhr.responseText; }
      }
      if (xhr.status >= 200 && xhr.status < 300) done(parsed as T);
      else fail(new ApiError(xhr.status, codeOf(parsed), parsed));
    };
    xhr.timeout = 120_000;
    xhr.send(JSON.stringify(body));
  });
}
