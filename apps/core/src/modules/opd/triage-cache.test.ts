import { createTriageCache, departmentFingerprint, normaliseComplaint, triageCacheKey } from "./triage-cache";
import { suggestDepartments } from "./triage";
import type { TriageDepartment, TriageResult } from "./triage";

const DEPTS: TriageDepartment[] = [
  { id: "d-card", name: "Cardiology" },
  { id: "d-gm", name: "General Medicine" },
  { id: "d-ent", name: "ENT" },
];
const CONFIG = { baseUrl: "https://gateway.example/v1", apiKey: "k", model: "m", timeoutMs: 2_000 };

/** A gateway that answers with a model suggestion and counts how many times it was asked. */
function gateway(indexes = [0]): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ suggestions: indexes.map((i) => ({ index: i, reason: "because" })) }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

describe("the triage cache — the same question is not paid for twice", () => {
  it("normalises case, Unicode form and whitespace, and NOTHING that changes meaning", () => {
    expect(normaliseComplaint("  Seene   Mein  DARD ")).toBe("seene mein dard");
    expect(normaliseComplaint("बुखार")).toBe(normaliseComplaint("बुखार".normalize("NFD")));
    /*
      THE ONE THAT MATTERS. "dard nahi hai" and "dard hai" are opposite complaints, and any
      normalisation clever enough to collapse them would make this cache a source of wrong routing.
      Measured on the live model: the keyword table answers Cardiology for the negated sentence and
      the model answers General Medicine — so these two must never share a key.
    */
    expect(normaliseComplaint("seene mein dard hai"))
      .not.toBe(normaliseComplaint("seene mein dard nahi hai"));
  });

  it("keys on the department list too, so a hospital that adds a department is not told the old answer", () => {
    const withNeuro = [...DEPTS, { id: "d-neuro", name: "Neurology" }];
    expect(triageCacheKey("sar dard", DEPTS)).not.toBe(triageCacheKey("sar dard", withNeuro));
    // A RENAME is a change too — the model is shown names, not ids.
    expect(departmentFingerprint(DEPTS))
      .not.toBe(departmentFingerprint([{ id: "d-card", name: "Cardiology (OPD)" }, DEPTS[1]!, DEPTS[2]!]));
    // Same list, same key — otherwise nothing would ever hit.
    expect(triageCacheKey("sar dard", DEPTS)).toBe(triageCacheKey("SAR  DARD", [...DEPTS]));
  });

  it("answers the second identical complaint without asking the gateway again", async () => {
    const cache = createTriageCache();
    const g = gateway([0]);
    const first = await suggestDepartments("seene mein dard", DEPTS, CONFIG, g.fetch, cache);
    const second = await suggestDepartments("Seene  Mein Dard", DEPTS, CONFIG, g.fetch, cache);

    expect(g.calls()).toBe(1);
    expect(second).toEqual(first);
    expect(second.source).toBe("model");
    expect(cache.stats.hits).toBe(1);
  });

  /**
   * THE SUBTLE HALF OF THE DESIGN. The advisor falls back to the keyword table on any failure — a
   * 429, a timeout, malformed JSON. Caching THAT would let one transient rate-limit pin the
   * degraded answer in front of every clerk for the rest of the day. Measured against the live
   * gateway before the debounce landed: 32 of 38 burst requests came back 429, so this is not a
   * theoretical branch.
   */
  it("never stores a keyword fallback, so one 429 cannot pin the degraded answer all day", async () => {
    const cache = createTriageCache();
    let calls = 0;
    const throttled = (async () => { calls += 1; return new Response("rate limited", { status: 429 }); }) as unknown as typeof fetch;

    const first = await suggestDepartments("bukhar", DEPTS, CONFIG, throttled, cache);
    expect(first.source).toBe("keywords");
    expect(cache.size()).toBe(0);

    // The gateway recovers, and the desk asks again rather than serving the fallback from a cache.
    const g = gateway([1]);
    const second = await suggestDepartments("bukhar", DEPTS, CONFIG, g.fetch, cache);
    expect(second.source).toBe("model");
    expect(calls).toBe(1);
    expect(g.calls()).toBe(1);
  });

  /**
   * Two clerks typing "bukhar" in the same second are ONE upstream request. The cache alone cannot
   * make this saving: nothing is stored until the first call has ANSWERED, so without coalescing
   * both are already on the wire by then.
   */
  it("coalesces identical calls that are still in flight into one", async () => {
    const cache = createTriageCache();
    let calls = 0;
    let release: (() => void) | null = null;
    let entered: (() => void) | null = null;
    const onWire = new Promise<void>((r) => { entered = r; });
    const slow = (async () => {
      calls += 1;
      entered?.();
      await new Promise<void>((r) => { release = r; });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"suggestions":[{"index":2,"reason":"ear"}]}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const a = suggestDepartments("kaan mein dard", DEPTS, CONFIG, slow, cache);
    const b = suggestDepartments("kaan mein dard", DEPTS, CONFIG, slow, cache);
    await onWire; // the first call is on the wire, so the second must have coalesced onto it
    release!();

    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(cache.stats.coalesced).toBe(1);
    expect(rb).toEqual(ra);
    expect(ra.suggestions[0]!.departmentId).toBe("d-ent");
    // The flight is cleaned up, or the next identical complaint would await a settled promise forever.
    expect(cache.inflight.size).toBe(0);
  });

  it("expires an entry once it is older than the TTL", () => {
    let clock = 1_000;
    const cache = createTriageCache({ ttlMs: 100, now: () => clock });
    const value: TriageResult = { suggestions: [{ departmentId: "d-gm", reason: "r" }], source: "model" };
    cache.set("k", value);
    expect(cache.get("k")).toEqual(value);
    clock += 101;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("evicts the least recently used once it is full, and a read counts as use", () => {
    const cache = createTriageCache({ max: 2 });
    const v = (id: string): TriageResult => ({ suggestions: [{ departmentId: id, reason: "r" }], source: "model" });
    cache.set("a", v("a"));
    cache.set("b", v("b"));
    cache.get("a");            // "a" is now the young one, so "b" is next out
    cache.set("c", v("c"));

    expect(cache.size()).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(v("a"));
    expect(cache.get("c")).toEqual(v("c"));
  });
});
