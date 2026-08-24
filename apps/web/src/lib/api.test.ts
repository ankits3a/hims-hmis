import { API_BASE, ApiError, api, getToken, setToken } from "./api";

describe("api()", () => {
  beforeEach(() => {
    setToken(null);
  });

  /**
   * PLAN 11g / DD1 — THE PREFIX IS THE CLIENT'S CONTRACT, SO IT IS ASSERTED HERE.
   *
   * Callers pass the API's OWN path (`/patients/search`); what leaves the browser is
   * `/api/patients/search`. That separation is what stops a browser GET of a SCREEN path being
   * answered by the API — the smoke test's D1, where 15 of 20 screens were dark — and
   * `apps/core/test/caddyfile-parity.test.ts` pins the other end of it against the Caddy matcher.
   */
  it("prepends the API base path to every request, leaving the caller's path unchanged", async () => {
    let capturedUrl: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedUrl = input;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await api("GET", "/patients/search?q=abc");
    expect(API_BASE).toBe("/api");
    expect(capturedUrl).toBe("/api/patients/search?q=abc");
  });

  it("attaches the bearer header when a token is stored", async () => {
    setToken("tok-123");
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await api("GET", "/patients/search");
    expect(capturedHeaders?.Authorization).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when no token is stored", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await api("GET", "/patients/search");
    expect(capturedHeaders?.Authorization).toBeUndefined();
  });

  it("clears the stored token on a 401 response", async () => {
    setToken("stale-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ statusCode: 401, message: "Unauthorized", error: "Unauthorized" }), {
          status: 401,
        }),
      ),
    );
    await expect(api("GET", "/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
  });

  it("does not touch the stored token on a non-401 error", async () => {
    setToken("good-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ statusCode: 400, message: [{ code: "too_small" }], error: "Bad Request" }), {
          status: 400,
        }),
      ),
    );
    await expect(api("POST", "/patients", { name: "" })).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBe("good-token");
  });

  it("ApiError carries the HTTP status and the raw parsed body — including a non-string zod-issue-array message", async () => {
    const body = { statusCode: 400, message: [{ code: "too_small", path: ["name"] }], error: "Bad Request" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })),
    );
    let caught: unknown;
    try {
      await api("POST", "/patients", { name: "" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as ApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.body).toEqual(body);
  });

  it("tolerates an empty response body without throwing a JSON parse error (the 204 from /auth/logout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(api("POST", "/auth/logout")).resolves.toBeNull();
  });

  it("sends a JSON Content-Type header only when a body is provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(null, { status: 204 });
      }),
    );
    await api("POST", "/auth/logout");
    expect(capturedHeaders?.["Content-Type"]).toBeUndefined();
    await api("POST", "/auth/login", { username: "a", password: "b" });
    expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
  });
});
