import { BioattendError, createBioattendClient } from "./client";
import type { FetchLike } from "./client";

const KEY = `bio_${"7c".repeat(32)}`;
const BASE = "https://bioattend.invalid/api/hmis/v1";

/** A scripted bioattend: each call answers the next entry; a string is a network failure. */
function scripted(answers: ({ status: number; body: unknown } | "network")[]): { fetch: FetchLike; calls: { url: string; key: string | undefined }[] } {
  const calls: { url: string; key: string | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, key: init.headers["X-HMIS-Key"] });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a === "network") throw new Error(`connect ECONNREFUSED ${url} with ${init.headers["X-HMIS-Key"]}`);
    return { status: a.status, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}
const OK_SHIFTS = { status: 200, body: { ok: true, shifts: [] } };
const refusal = (status: number, error: string) => ({ status, body: { ok: false, error } });

function client(fetch: FetchLike, over: Partial<Parameters<typeof createBioattendClient>[0]> = {}) {
  const slept: number[] = [];
  const c = createBioattendClient({ baseUrl: BASE, key: () => KEY, fetch, sleep: async (ms) => { slept.push(ms); }, ...over });
  return { c, slept };
}
async function outcomeOf(p: Promise<unknown>): Promise<BioattendError> {
  try { await p; } catch (e) { if (e instanceof BioattendError) return e; throw e; }
  throw new Error("expected a BioattendError");
}

describe("the bioattend client", () => {
  it("sends the key in X-HMIS-Key and nowhere else", async () => {
    const s = scripted([OK_SHIFTS]);
    await client(s.fetch).c.shifts();
    expect(s.calls).toEqual([{ url: `${BASE}/shifts`, key: KEY }]);
  });

  it.each([
    [400, "from must be YYYY-MM-DD", "bad_request"],
    [401, "bad_or_missing_key", "bad_key"],
    [403, "ip_not_allowed_for_this_key", "ip_not_allowed"],
    [403, "https_required", "https_required"],
    [403, "use_https_biotime_crkmch_com", "wrong_host"],
    [403, "something_new", "forbidden"],
  ])("HTTP %i %s is `%s` and is NOT retried — one call, no sleep", async (status, error, outcome) => {
    const s = scripted([refusal(status, error), OK_SHIFTS]);
    const { c, slept } = client(s.fetch);
    const e = await outcomeOf(c.shifts());
    expect([e.outcome, e.status]).toEqual([outcome, status]);
    expect(e.refused).toBe(status === 401 || status === 403);
    expect(s.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it.each([
    ["429 rate_limited", refusal(429, "rate_limited")],
    ["503 api_not_configured", refusal(503, "api_not_configured")],
    ["a network error", "network" as const],
  ])("%s IS retried, with back-off, and the answer that follows is used", async (_name, first) => {
    const s = scripted([first, first, OK_SHIFTS]);
    const { c, slept } = client(s.fetch);
    await expect(c.shifts()).resolves.toEqual([]);
    expect(s.calls).toHaveLength(3);
    expect(slept).toEqual([1000, 2000]);
  });

  it("gives up after the retries and names the outcome", async () => {
    const s = scripted([refusal(429, "rate_limited")]);
    const { c, slept } = client(s.fetch, { retries: 2 });
    const e = await outcomeOf(c.shifts());
    expect([e.outcome, e.status]).toEqual(["rate_limited", 429]);
    expect(s.calls).toHaveLength(3);
    expect(slept).toEqual([1000, 2000]);
  });

  it("an error never carries the key, the query string or the upstream body", async () => {
    const s = scripted(["network"]);
    const e = await outcomeOf(client(s.fetch, { retries: 0 }).c.punches(41_000, 1000));
    expect(e.message).toBe("bioattend /punches: network");
    expect(JSON.stringify({ ...e, message: e.message, stack: e.stack })).not.toContain(KEY);
    const refused = await outcomeOf(client(scripted([{ status: 401, body: { ok: false, error: "bad_or_missing_key", echo: KEY } }]).fetch).c.staff());
    expect(refused.message).toBe("bioattend /staff: bad_key (HTTP 401)");
  });

  it("an answer that is not the guide's JSON is `bad_response`, not a crash and not a retry", async () => {
    for (const body of ["<html>502</html>", { ok: true }, { ok: true, shifts: [{ id: "three" }] }, { ok: false }]) {
      const s = scripted([{ status: 200, body }]);
      expect((await outcomeOf(client(s.fetch).c.shifts())).outcome).toBe("bad_response");
      expect(s.calls).toHaveLength(1);
    }
  });

  it("keeps its own budget under bioattend's 120 a minute: the call over it is refused HERE, unsent", async () => {
    const s = scripted([OK_SHIFTS]);
    let t = 1_000_000;
    const { c } = client(s.fetch, { callsPerMinute: 3, now: () => t });
    await c.shifts(); await c.shifts(); await c.shifts();
    const e = await outcomeOf(c.shifts());
    expect([e.outcome, e.status]).toEqual(["rate_limited", null]);
    expect(s.calls).toHaveLength(3);
    expect(c.callCount()).toBe(3);
    t += 60_000; // the minute rolls over
    await expect(c.shifts()).resolves.toEqual([]);
    expect(s.calls).toHaveLength(4);
  });

  it("with no key it makes no call at all", async () => {
    const s = scripted([OK_SHIFTS]);
    const e = await outcomeOf(client(s.fetch, { key: () => null }).c.staff());
    expect(e.outcome).toBe("bad_key");
    expect(s.calls).toEqual([]);
  });

  it("one day is `date=`, a range is `from=`/`to=`; punches page by after_id", async () => {
    const s = scripted([{ status: 200, body: { ok: true, attendance: [] } }, { status: 200, body: { ok: true, attendance: [] } }, { status: 200, body: { ok: true, next_after_id: 7, more: false, punches: [] } }]);
    const { c } = client(s.fetch);
    await c.attendance("2026-03-10", "2026-03-10");
    await c.attendance("2026-03-01", "2026-03-10");
    await c.punches(7);
    expect(s.calls.map((x) => x.url.slice(BASE.length))).toEqual(["/attendance?date=2026-03-10", "/attendance?from=2026-03-01&to=2026-03-10", "/punches?after_id=7&limit=1000"]);
  });
});
