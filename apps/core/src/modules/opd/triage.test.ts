import { keywordRank, parseSuggestions, suggestDepartments } from "./triage";
import { createTriageCache } from "./triage-cache";
import type { TriageConfig, TriageDepartment } from "./triage";
import type { ChoiceAnswer, ChoiceClient, ChooseInput } from "../../kernel/inference/types";

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE HOSPITAL'S WHOLE BOOK, because half of it was unreachable
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-17, testing the live appointment screen: *"I wrote 'aankh me dard', but the system
 * showed 'Nobody in the shortest department is on today's board'… there's a doctor in ophthalmology
 * and still the agent failed to pick the department."*
 *
 * The keyword table had SEVEN rows reaching FIVE of the hospital's twelve departments. `aankh`
 * matched nothing, so the ranker returned an empty list, the seat fell back to "the shortest
 * department", and the clerk was told the ROSTER was empty — a sentence about a fault that did not
 * exist, for a routing failure that did.
 *
 * `DEFAULT_DEPARTMENTS` (`modules/opd/config.ts`) is the twelve this hospital seeds, and this
 * fixture is all of them so a row that reaches nothing fails HERE rather than at a counter.
 */
const ALL_DEPTS: TriageDepartment[] = [
  { id: "d-gm", name: "General Medicine" }, { id: "d-sur", name: "General Surgery" },
  { id: "d-paed", name: "Paediatrics" }, { id: "d-obg", name: "Obstetrics & Gynaecology" },
  { id: "d-ortho", name: "Orthopaedics" }, { id: "d-ent", name: "ENT" },
  { id: "d-oph", name: "Ophthalmology" }, { id: "d-der", name: "Dermatology" },
  { id: "d-psy", name: "Psychiatry" }, { id: "d-card", name: "Cardiology" },
  { id: "d-den", name: "Dental" }, { id: "d-phy", name: "Physiotherapy" },
];

describe("suggestDepartments — the brake runs before everything", () => {
  /**
   * These pin the ORDERING, which is the whole safety property. A red flag that ran after the model
   * would be a red flag that can arrive late, or not at all, on the day a provider is slow — and
   * that is the day it matters.
   */
  it("returns the flag and NO suggestions, rather than ranking Casualty first", async () => {
    const out = await suggestDepartments("seene mein dard", ALL_DEPTS, CONFIG, reply("{}"), createTriageCache(), { ageYears: 55 });
    expect(out.redFlag?.reasonKey).toBe("opdTriage.redFlag.chestPain");
    expect(out.suggestions).toEqual([]);
  });

  it("never calls the model on a red flag", async () => {
    let called = false;
    const spy = (async () => { called = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    await suggestDepartments("saans nahi aa rahi", ALL_DEPTS, CONFIG, spy, createTriageCache(), { ageYears: 40 });
    expect(called).toBe(false);
  });

  it("does not let the cache answer for a different patient", async () => {
    /*
      The same words are an emergency at 55 and not at 6, and `triageCacheKey` is built from the
      complaint and the department list — it knows nothing about the patient. Running the brake
      before the cache is what stops one child's answer being served to an adult.
    */
    const cache = createTriageCache();
    const adult = await suggestDepartments("seene mein dard", ALL_DEPTS, CONFIG, reply("{}"), cache, { ageYears: 55 });
    const child = await suggestDepartments("seene mein dard", ALL_DEPTS, CONFIG, reply('{"suggestions":[{"index":0,"reason":"r"}]}'), cache, { ageYears: 6 });
    expect(adult.redFlag).toBeDefined();
    expect(child.redFlag).toBeUndefined();
  });

  it("routes an ordinary complaint exactly as before", async () => {
    const out = await suggestDepartments("aankh me dard", ALL_DEPTS, { ...CONFIG, baseUrl: null, apiKey: null }, reply("{}"), createTriageCache(), { ageYears: 35 });
    expect(out.redFlag).toBeUndefined();
    expect(out.suggestions.map((x) => x.departmentId)).toContain("d-oph");
  });
});

describe("keywordRank — every department this hospital seeds is reachable", () => {
  /** The complaint that started it, in all three ways a clerk writes it. */
  it.each([["aankh me dard"], ["ankh mein dard"], ["eye pain"], ["आँख में दर्द"], ["आंख में दर्द"]])(
    "routes %s to Ophthalmology", (complaint: string) => {
      expect(keywordRank(complaint, ALL_DEPTS).map((s) => s.departmentId)).toContain("d-oph");
    },
  );

  it.each([
    ["kaan me dard", "d-ent"], ["ear pain", "d-ent"], ["gala kharab hai", "d-ent"],
    ["कान में दर्द", "d-ent"], ["naak band hai", "d-ent"],
    ["daant me dard", "d-den"], ["tooth pain", "d-den"], ["दाँत में दर्द", "d-den"],
    ["khujli ho rahi hai", "d-der"], ["skin rash", "d-der"], ["खुजली", "d-der"],
    ["neend nahi aati", "d-psy"], ["depression", "d-psy"], ["ghabrahat", "d-psy"],
    ["bawaseer", "d-sur"], ["piles", "d-sur"], ["gaanth hai", "d-sur"],
    ["physiotherapy chahiye", "d-phy"], ["stroke rehabilitation", "d-phy"],
  ])("routes %s to %s", (complaint: string, departmentId: string) => {
    expect(keywordRank(complaint, ALL_DEPTS).map((s) => s.departmentId)).toContain(departmentId);
  });

  /**
   * ═══ `dard` IS NOT A DEPARTMENT, AND THAT IS THE TRAP THIS TABLE HAS TO AVOID ═══
   *
   * Pain is the commonest word in every one of these complaints — "aankh me dard", "daant me dard",
   * "ghutne me dard". The BODY PART carries the routing and the pain word carries none of it. A
   * table that scored `dard` would send every complaint to whichever row was written first, which
   * is the defect Desk One's own chain already has with `kitna`.
   */
  it("routes on the body part and not on the word for pain", () => {
    expect(keywordRank("dard", ALL_DEPTS)).toEqual([]);
    expect(keywordRank("bahut dard ho raha hai", ALL_DEPTS)).toEqual([]);
  });

  /**
   * ═══ SHORT LATIN KEYS ARE TRAPS, AND THESE TWO ARE THE ONES THAT BIT ═══
   *
   * The matcher is `q.includes(key)`, so a key is matched inside any longer word. Writing `"ear"`
   * for ENT would route **heart** pain to ENT, and `"tension"` for Psychiatry would route
   * **hypertension** there. Both are the commonest complaints in this hospital's book. The table
   * therefore spells `ear pain` / `earache` and `tanav` / `ghabrahat`, and these two tests are what
   * stop somebody shortening them later.
   */
  it("does not send heart pain to ENT", () => {
    const hit = keywordRank("heart pain", ALL_DEPTS).map((s) => s.departmentId);
    expect(hit).toContain("d-card");
    expect(hit).not.toContain("d-ent");
  });

  it("does not send hypertension to Psychiatry", () => {
    expect(keywordRank("hypertension", ALL_DEPTS).map((s) => s.departmentId)).not.toContain("d-psy");
  });

  it("still never names a department the hospital lacks", () => {
    // The original guarantee, re-asserted over the bigger table: a four-department hospital.
    expect(keywordRank("aankh me dard", DEPTS)).toEqual([]);
    expect(keywordRank("daant me dard", DEPTS)).toEqual([]);
  });

  /**
   * THE CENSUS. A row whose department name does not match the seeded book reaches nothing and is
   * invisible — exactly the state `Ophthalmology` was in. This fails the build instead.
   */
  it("every seeded department is reachable by at least one complaint", () => {
    const reachable = new Set(
      [
        "seene mein dard", "bukhar", "ghutne mein dard", "khansi", "pregnancy", "baccha ko teeka",
        "sugar bp", "aankh me dard", "kaan me dard", "daant me dard", "khujli", "neend nahi aati",
        "bawaseer", "physiotherapy",
      ].flatMap((c) => keywordRank(c, ALL_DEPTS).map((s) => s.departmentId)),
    );
    const missing = ALL_DEPTS.filter((d) => !reachable.has(d.id)).map((d) => d.name);
    expect(missing).toEqual([]);
  });
});

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
      /*
        The fixture was "seene mein dard" until red flags landed, and chest pain now STOPS the
        router before the model is reached — correctly, and it is why this test changed rather than
        the brake. These two cases are about what happens when the MODEL misbehaves, so they need a
        complaint that actually reaches it.
      */
      const r = await suggestDepartments("ghutne mein dard", DEPTS, CONFIG, reply(bad));
      // Falls back to the table — and SAYS it did.
      expect({ input: bad.slice(0, 20), source: r.source, first: r.suggestions[0]?.departmentId })
        .toEqual({ input: bad.slice(0, 20), source: "keywords", first: "d-ortho" });
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
      // Not chest pain — see the note above: a red flag never reaches the model at all.
      const r = await suggestDepartments("ghutne mein dard", DEPTS, CONFIG, f);
      expect({ source: r.source, first: r.suggestions[0]?.departmentId }).toEqual({ source: "keywords", first: "d-ortho" });
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * NO IDENTIFIER REACHES THE MODEL — the plan series' law, asserted on triage's own wire
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"identified PHI never enters an inference request — any stage, any locus, ever."* The copilot
 * router has kept that since it was written; triage predates it and interpolated the complaint
 * verbatim, so a clerk who typed "Ramesh ji ko 3 din se bukhar, 98765 43210" sent a name and a
 * mobile number to the provider. These pin the exact string that goes on the wire, because that
 * string is the only place the law can be checked.
 */
describe("triage — nothing that names the patient reaches the model", () => {
  /** Records every body sent, so a test can read exactly what left and count how often. */
  function recorder(content = '{"suggestions":[{"index":0,"reason":"fever"}]}'): { fetchImpl: typeof fetch; bodies: string[] } {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  }

  /** The complaint line exactly as the model read it. */
  function complaintSent(body: string): string {
    const text = (JSON.parse(body) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
    return text.split("\n").find((line) => line.startsWith("Complaint: ")) ?? "";
  }

  it("a mobile number, a UHID and a visit number are masked by shape, with no help from the screen", async () => {
    const { fetchImpl, bodies } = recorder();
    await suggestDepartments("bukhar hai, mobile 98765 43210, UHID U00110012, parchi V2609150001", DEPTS, CONFIG, fetchImpl, createTriageCache());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/98765|43210|U00110012|V2609150001/);
    expect(complaintSent(bodies[0] ?? "")).toBe("Complaint: bukhar hai, mobile <<P3>>, UHID <<P2>>, parchi <<P1>>");
  });

  it("a name the desk supplies is masked whole or by its parts, in either script, with or without 'ji'", async () => {
    const latin = recorder();
    await suggestDepartments("Ramesh ji ko 3 din se bukhar", DEPTS, CONFIG, latin.fetchImpl, createTriageCache(), { ageYears: 40, names: ["Ramesh Kumar"] });
    expect(complaintSent(latin.bodies[0] ?? "")).toBe("Complaint: <<P1>> ji ko 3 din se bukhar");

    const joined = recorder();
    await suggestDepartments("Rameshji ko bukhar", DEPTS, CONFIG, joined.fetchImpl, createTriageCache(), { ageYears: 40, names: ["Ramesh Kumar"] });
    expect(complaintSent(joined.bodies[0] ?? "")).toBe("Complaint: <<P1>>ji ko bukhar");

    const devanagari = recorder();
    await suggestDepartments("सुनीता जी को खांसी है", DEPTS, CONFIG, devanagari.fetchImpl, createTriageCache(), { ageYears: 40, names: ["सुनीता देवी"] });
    expect(complaintSent(devanagari.bodies[0] ?? "")).toBe("Complaint: <<P1>> जी को खांसी है");
  });

  /*
    THE OTHER HALF, and the reason names are matched as whole words. A substring match would turn
    "aaram nahi" (no rest) into "aa<<P1>> nahi" for a patient called Ram, and "khali pet" (empty
    stomach) into "kh<<P2>> pet" for one called Ali — a masker that deletes the complaint to protect
    the name has protected nothing the model needed.
  */
  it("a word that merely CONTAINS a name is left alone: aaram is not Ram, khali is not Ali", async () => {
    const latin = recorder();
    await suggestDepartments("Ram ko khansi, khali pet dawai, aaram nahi", DEPTS, CONFIG, latin.fetchImpl, createTriageCache(), { ageYears: 40, names: ["Ram Prasad", "Ali"] });
    expect(complaintSent(latin.bodies[0] ?? "")).toBe("Complaint: <<P1>> ko khansi, khali pet dawai, aaram nahi");

    const devanagari = recorder();
    await suggestDepartments("राम को खांसी, आराम नहीं", DEPTS, CONFIG, devanagari.fetchImpl, createTriageCache(), { ageYears: 40, names: ["राम"] });
    expect(complaintSent(devanagari.bodies[0] ?? "")).toBe("Complaint: <<P1>> को खांसी, आराम नहीं");
  });

  /*
    THE LAST GATE RUNS ON THE WHOLE PROMPT, not on the complaint alone — `mask.ts`'s rule: the
    enforcement checks "the exact string that is about to go on the wire". A department list is
    configuration rather than operator text, so it is the one part the masker never sees; a gate
    that only re-checked the masker's own output would be the masker witnessing itself.
  */
  it("an identifier-shaped prompt is refused, costing the model call and never the desk", async () => {
    const { fetchImpl, bodies } = recorder();
    const depts = [...DEPTS, { id: "d-x", name: "Clinic 40012" }];
    const out = await suggestDepartments("bukhar", depts, CONFIG, fetchImpl, createTriageCache());
    expect(bodies).toHaveLength(0);
    expect(out.source).toBe("keywords");
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-gm", "d-paed"]);
  });

  /*
    The cache is keyed on what the MODEL saw, so it never holds a name, and two patients with the
    same complaint are — correctly — the same question.
  */
  it("two patients with the same complaint are one model call, because the cache never sees who", async () => {
    const cache = createTriageCache();
    const { fetchImpl, bodies } = recorder();
    const first = await suggestDepartments("Ramesh ko bukhar", DEPTS, CONFIG, fetchImpl, cache, { ageYears: 40, names: ["Ramesh"] });
    const second = await suggestDepartments("Suresh ko bukhar", DEPTS, CONFIG, fetchImpl, cache, { ageYears: 40, names: ["Suresh"] });
    expect(bodies).toHaveLength(1);
    expect(second).toEqual(first);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-19 — TYPESAFE FIRST, THE CHAT MODEL ITS FALLBACK
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner: *"keep typesafe as priority and the groq as fallback"*. Measured on `triage-eval.test.ts`'s
 * own 46 complaints (author-labelled): TypeSafe alone 40/46 top-1, the chat model alone 44/46 — it
 * knows "naak band" is ENT and TypeSafe does not. But TypeSafe KNOWS when it does not know: at
 * confidence >= 0.6 it answered 38 and all 38 were right, and every one of its misses scored below
 * the line. So it answers what it is sure of in ~280 ms, and hands the rest to the chat model.
 */
describe("suggestDepartments — TypeSafe first", () => {
  type Chooser = { client: ChoiceClient; calls: ChooseInput[] };
  const choosing = (answer: ChoiceAnswer | Error): Chooser => {
    const calls: ChooseInput[] = [];
    return {
      calls,
      client: {
        choose: (input: ChooseInput) => {
          calls.push(input);
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ answers: { department: answer }, model: "jev-1.13.0" });
        },
      },
    };
  };
  const sure = (choice: string, probabilities: Record<string, number>, confidence = 0.9): ChoiceAnswer => ({ choice, confidence, probabilities });

  /** A chat model that records whether it was asked, and answers Cardiology if it is. */
  function chat(): { fetchImpl: typeof fetch; asked: () => number } {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"suggestions":[{"index":1,"reason":"heart"}]}' } }] }) };
    }) as unknown as typeof fetch;
    return { fetchImpl, asked: () => n };
  }
  const LINE = 0.6;

  it("a confident choice ranks departments by probability, and the chat model is never asked", async () => {
    const ts = choosing(sure("Orthopaedics", { Orthopaedics: 0.8, "General Medicine": 0.15, Cardiology: 0.03, Paediatrics: 0.02, "none of these": 0 }));
    const groq = chat();
    const out = await suggestDepartments("ghutne mein dard", DEPTS, CONFIG, groq.fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(out.source).toBe("model");
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-ortho", "d-gm"]);
    expect(groq.asked()).toBe(0);
  });

  it("offers at most three, each at least a 10% chance, and never 'none of these'", async () => {
    const ts = choosing(sure("General Medicine", { "General Medicine": 0.4, Paediatrics: 0.25, Cardiology: 0.12, Orthopaedics: 0.11, "none of these": 0.12 }, 0.7));
    const out = await suggestDepartments("bukhar aur khansi", DEPTS, CONFIG, chat().fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-gm", "d-paed", "d-card"]);
  });

  it("the reason a clerk could read is ours — a fixed description, never the model's words", async () => {
    const ts = choosing(sure("Orthopaedics", { Orthopaedics: 0.95, "none of these": 0.05 }));
    const out = await suggestDepartments("ghutne mein dard", DEPTS, CONFIG, chat().fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(out.suggestions[0]?.reason).toBe("bones, joints, back, fractures, sprains");
  });

  it("below the line the chat model answers, exactly as it did before", async () => {
    const ts = choosing(sure("General Medicine", { "General Medicine": 0.4, Cardiology: 0.35, "none of these": 0.25 }, 0.3));
    const groq = chat();
    const out = await suggestDepartments("dhadkan tez", DEPTS, CONFIG, groq.fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-card"]);
    expect(groq.asked()).toBe(1);
  });

  it("an unreachable TypeSafe costs nothing but the fallback", async () => {
    const groq = chat();
    const out = await suggestDepartments("dhadkan tez", DEPTS, CONFIG, groq.fetchImpl, createTriageCache(), { ageYears: 40 }, { client: choosing(new Error("timeout")).client, minConfidence: LINE });
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-card"]);
    expect(groq.asked()).toBe(1);
  });

  it("a confident 'none of these' is the keyword table's answer — the chat model is not asked to overrule it", async () => {
    const ts = choosing(sure("none of these", { "none of these": 0.95, "General Medicine": 0.05 }));
    const groq = chat();
    const out = await suggestDepartments("bukhar", DEPTS, CONFIG, groq.fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(out.source).toBe("keywords");
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-gm", "d-paed"]);
    expect(groq.asked()).toBe(0);
  });

  it("with TypeSafe alone, an unsure answer is the keyword table's", async () => {
    const ts = choosing(sure("Cardiology", { Cardiology: 0.5, "General Medicine": 0.5 }, 0.2));
    const out = await suggestDepartments("bukhar", DEPTS, { ...CONFIG, baseUrl: null, apiKey: null }, chat().fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(out.source).toBe("keywords");
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-gm", "d-paed"]);
  });

  it("sends the MASKED complaint, and every department plus 'none of these' as the options", async () => {
    const depts = [...DEPTS, { id: "d-sleep", name: "Sleep Clinic" }];
    const ts = choosing(sure("none of these", { "none of these": 1 }));
    await suggestDepartments("Ramesh ko bukhar, 98765 43210", depts, CONFIG, chat().fetchImpl, createTriageCache(), { ageYears: 40, names: ["Ramesh Kumar"] }, { client: ts.client, minConfidence: LINE });
    const sent = ts.calls[0];
    expect(sent?.state).toEqual({ complaint: "<<P1>> ko bukhar, <<P2>>" });
    expect(Object.keys(sent?.questions.department?.options ?? {})).toEqual([...depts.map((d) => d.name), "none of these"]);
    // A department this hospital seeds carries a fixed description; one it invented carries none.
    expect(sent?.questions.department?.options.Cardiology).toEqual(expect.any(String));
    expect(sent?.questions.department?.options["Sleep Clinic"]).toBeNull();
    expect(JSON.stringify(sent)).not.toMatch(/Ramesh|98765|43210/);
  });

  it("two departments with one name are still two options, each mapped back to its own id", async () => {
    const depts = [{ id: "d-ent-a", name: "ENT" }, { id: "d-ent-b", name: "ENT" }, { id: "d-gm", name: "General Medicine" }];
    const ts = choosing(sure("ENT #2", { "ENT #2": 0.9, ENT: 0.1 }));
    const out = await suggestDepartments("kaan me dard", depts, CONFIG, chat().fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(Object.keys(ts.calls[0]?.questions.department?.options ?? {})).toEqual(["ENT", "ENT #2", "General Medicine", "none of these"]);
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["d-ent-b", "d-ent-a"]);
  });

  it("a red flag stops TypeSafe too — the brake runs before every model", async () => {
    const ts = choosing(sure("Cardiology", { Cardiology: 1 }));
    const out = await suggestDepartments("seene mein dard", ALL_DEPTS, CONFIG, chat().fetchImpl, createTriageCache(), { ageYears: 55 }, { client: ts.client, minConfidence: LINE });
    expect(out.redFlag).toBeDefined();
    expect(ts.calls).toHaveLength(0);
  });

  it("a TypeSafe answer is cached like any model answer", async () => {
    const cache = createTriageCache();
    const ts = choosing(sure("Orthopaedics", { Orthopaedics: 0.9, "none of these": 0.1 }));
    await suggestDepartments("ghutne mein dard", DEPTS, CONFIG, chat().fetchImpl, cache, { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    await suggestDepartments("ghutne mein dard", DEPTS, CONFIG, chat().fetchImpl, cache, { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(ts.calls).toHaveLength(1);
  });

  it("an identifier-shaped department list reaches neither model", async () => {
    const ts = choosing(sure("General Medicine", { "General Medicine": 1 }));
    const groq = chat();
    const out = await suggestDepartments("bukhar", [...DEPTS, { id: "d-x", name: "Clinic 40012" }], CONFIG, groq.fetchImpl, createTriageCache(), { ageYears: 40 }, { client: ts.client, minConfidence: LINE });
    expect(ts.calls).toHaveLength(0);
    expect(groq.asked()).toBe(0);
    expect(out.source).toBe("keywords");
  });
});
