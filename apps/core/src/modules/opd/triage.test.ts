import { keywordRank, parseSuggestions, suggestDepartments } from "./triage";
import type { TriageConfig, TriageDepartment } from "./triage";

/**
 * ═══ FD-8 — THE TRIAGE ADVISOR ═══
 *
 * Two properties matter more than the ranking itself, and both are asserted here rather than
 * described in a comment:
 *
 *   1. THE MODEL CANNOT INVENT A DEPARTMENT. It is handed the hospital's real list and asked for
 *      indexes into it; anything else is dropped by construction.
 *   2. THE DESK NEVER STALLS ON IT. Every failure — no key, timeout, refusal, garbage, an index we
 *      did not send — falls back to the deterministic table, and the seat is told which source
 *      answered, because advice whose origin is hidden gets trusted too much.
 */
const DEPTS: TriageDepartment[] = [
  { id: "d-gm", name: "General Medicine" },
  { id: "d-card", name: "Cardiology" },
  { id: "d-ortho", name: "Orthopaedics" },
  { id: "d-paed", name: "Paediatrics" },
];

const CONFIG: TriageConfig = {
  baseUrl: "https://omniroute.example/v1", apiKey: "test-key", model: "test-model", timeoutMs: 2_000,
};

/** A model reply in the shape the endpoint returns. */
function reply(content: string, ok = true): typeof fetch {
  return (async () => ({
    ok,
    json: async () => ({ choices: [{ message: { content } }] }),
  })) as unknown as typeof fetch;
}

describe("triage — the complaint, in the patient's own words", () => {
  /* ── the deterministic floor ─────────────────────────────────────────────────────────────── */

  it("keywordRank routes Hindi and English alike, to the hospital's OWN departments", () => {
    expect(keywordRank("seene mein dard", DEPTS).map((s) => s.departmentId)).toEqual(["d-card", "d-gm"]);
    expect(keywordRank("bukhar", DEPTS).map((s) => s.departmentId)).toEqual(["d-gm", "d-paed"]);
    expect(keywordRank("ghutne mein dard", DEPTS).map((s) => s.departmentId)).toEqual(["d-ortho"]);
    expect(keywordRank("", DEPTS)).toEqual([]);
  });

  /** A department the hospital does not have is never suggested, however well the keyword matches. */
  it("keywordRank never names a department this hospital lacks", () => {
    expect(keywordRank("pregnancy", DEPTS)).toEqual([]);  // no Obs & Gynae in this list
  });

  /* ── the guard that makes a hallucination impossible ─────────────────────────────────────── */

  it("an index we did not send is DROPPED, not trusted", () => {
    // 9 is not in the list; 1 is Cardiology.
    const out = parseSuggestions('{"suggestions":[{"index":9,"reason":"Neurosurgery"},{"index":1,"reason":"cardiac"}]}', DEPTS);
    expect(out).toEqual([{ departmentId: "d-card", reason: "cardiac" }]);
  });

  it("a model that answers in prose, or with a NAME instead of an index, changes nothing", async () => {
    for (const bad of [
      "I think they should see Neurosurgery.",
      '{"suggestions":[{"department":"Neurosurgery","reason":"invented"}]}',
      "{ not json at all",
      '{"suggestions":"cardiology"}',
    ]) {
      const r = await suggestDepartments("seene mein dard", DEPTS, CONFIG, reply(bad));
      // Falls back to the table — and SAYS it did.
      expect({ input: bad.slice(0, 20), source: r.source, first: r.suggestions[0]?.departmentId })
        .toEqual({ input: bad.slice(0, 20), source: "keywords", first: "d-card" });
    }
  });

  it("duplicate indexes collapse — one department cannot be suggested twice", () => {
    const out = parseSuggestions('{"suggestions":[{"index":0,"reason":"a"},{"index":0,"reason":"b"}]}', DEPTS);
    expect(out).toHaveLength(1);
  });

  it("at most three suggestions reach the clerk", () => {
    const many = '{"suggestions":[{"index":0,"reason":"a"},{"index":1,"reason":"b"},{"index":2,"reason":"c"},{"index":3,"reason":"d"}]}';
    expect(parseSuggestions(many, DEPTS)).toHaveLength(3);
  });

  /* ── the model, when it works ────────────────────────────────────────────────────────────── */

  it("a good model answer is used, and is labelled as the model's", async () => {
    const r = await suggestDepartments(
      "chhaati mein jalan aur pasina", DEPTS, CONFIG,
      reply('{"suggestions":[{"index":1,"reason":"possible cardiac"}]}'),
    );
    expect(r).toEqual({ source: "model", suggestions: [{ departmentId: "d-card", reason: "possible cardiac" }] });
  });

  /** It is fenced JSON in practice more often than not; the desk should not care. */
  it("JSON wrapped in a code fence still parses", async () => {
    const r = await suggestDepartments(
      "knee pain", DEPTS, CONFIG,
      reply('```json\n{"suggestions":[{"index":2,"reason":"joint pain"}]}\n```'),
    );
    expect(r.source).toBe("model");
    expect(r.suggestions[0]!.departmentId).toBe("d-ortho");
  });

  /* ── and it never stalls the desk ────────────────────────────────────────────────────────── */

  it("with no key configured the model is never called at all", async () => {
    let called = false;
    const spy = (async () => { called = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    const r = await suggestDepartments("bukhar", DEPTS, { ...CONFIG, apiKey: null }, spy);
    expect(called).toBe(false);                       // THE KILL for a desk that waits on an unconfigured service
    expect({ source: r.source, first: r.suggestions[0]?.departmentId }).toEqual({ source: "keywords", first: "d-gm" });
  });

  it("a refusal, a throw and a non-200 all fall back rather than failing the desk", async () => {
    const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const refused = reply("{}", false);
    for (const f of [throwing, refused]) {
      const r = await suggestDepartments("seene mein dard", DEPTS, CONFIG, f);
      expect({ source: r.source, first: r.suggestions[0]?.departmentId }).toEqual({ source: "keywords", first: "d-card" });
    }
  });

  /** An empty model answer is not better than the table we already have. */
  it("an empty model answer does not erase the keyword ranking", async () => {
    const r = await suggestDepartments("bukhar", DEPTS, CONFIG, reply('{"suggestions":[]}'));
    expect(r.source).toBe("keywords");
    expect(r.suggestions.map((s) => s.departmentId)).toEqual(["d-gm", "d-paed"]);
  });

  /** The whole point of sending the list: the model is asked for indexes, never for a name. */
  it("the prompt carries the hospital's real departments and demands indexes", async () => {
    let sent = "";
    const capture = (async (_u: string, init: { body: string }) => {
      sent = init.body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"suggestions":[]}' } }] }) };
    }) as unknown as typeof fetch;
    await suggestDepartments("fever", DEPTS, CONFIG, capture);
    expect(sent).toContain("0: General Medicine");
    expect(sent).toContain("3: Paediatrics");
    expect(sent).toContain("index");
    expect(sent).toContain("Never invent a department");
    /*
     * MEASURED, not assumed: the Omniroute gateway answers `text/event-stream` even when streaming
     * is not requested, so without this flag `res.json()` throws and every call silently falls back
     * to the keyword table — the desk looks fine and the model is never used.
     */
    expect(JSON.parse(sent).stream).toBe(false);
  });
});
