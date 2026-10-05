import { api, ApiError, NetworkError } from "../src/api";

const ok = (body: unknown, status = 200) =>
  jest.fn(async () => new Response(body === undefined ? "" : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("api", () => {
  it("sends the bearer token and JSON to the build's base", async () => {
    const f = ok({ a: 1 });
    await api("POST", "/x", { token: "tok", body: { b: 2 }, fetcher: f, base: "https://h/api" });
    const [url, init] = (f as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://h/api/x");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.body).toBe('{"b":2}');
  });
  it("reads a string exception's code from `message` and an object one's from `code`", async () => {
    await expect(api("GET", "/me", { fetcher: ok({ statusCode: 403, message: "password_change_required" }, 403) }))
      .rejects.toMatchObject({ status: 403, code: "password_change_required" });
    await expect(api("POST", "/c", { fetcher: ok({ code: "password_policy", problems: [] }, 400) }))
      .rejects.toBeInstanceOf(ApiError);
  });
  it("tells a dead network apart from a refusal", async () => {
    const f = jest.fn(async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch;
    await expect(api("GET", "/x", { fetcher: f })).rejects.toBeInstanceOf(NetworkError);
  });
});
