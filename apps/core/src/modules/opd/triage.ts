/**
 * ═══ FD-8 — THE COMPLAINT, IN THE PATIENT'S OWN WORDS, TURNED INTO A DEPARTMENT ═══
 *
 * Desk One's appointment stage does not ask a clerk to pick a department from a dropdown. It asks
 * *"What brings them in?"* and takes the answer as the patient said it — `seene mein dard`, `bukhar`,
 * `ghutne mein dard` — then ranks the hospital's own departments. That is the difference between a
 * form and a desk: the clerk types what they were told, not what the software's vocabulary allows.
 *
 * ═══ THE MODEL NEVER NAMES A DEPARTMENT. IT ONLY CHOOSES FROM OURS. ═══
 *
 * The one failure that would matter here is a confident hallucination — "Neurosurgery" at a hospital
 * that has none, or worse, a plausible-sounding department that routes a chest-pain patient
 * somewhere slow. So the model is handed THE ACTUAL LIST and asked to return indexes into it;
 * anything it returns that is not an index we sent is dropped, silently and by construction. It
 * cannot invent a department because it is never asked for a name.
 *
 * ═══ AND IT IS AN ADVISOR, NEVER A GATE ═══
 *
 * A counter with a queue in front of it cannot wait on somebody else's network. Every failure —
 * no key configured, a timeout, a refusal, malformed JSON, an index we did not send — falls back to
 * `keywordRank`, the deterministic table Desk One itself shipped with. The desk always answers. The
 * clerk always sees the ranked list and always makes the final choice: nothing here seats anybody,
 * exactly as `proposeWalkIn` proposes and never applies.
 */

import { assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
import { defaultTriageCache, triageCacheKey } from "./triage-cache";
import type { TriageCache } from "./triage-cache";

import { rankBook } from "./complaint-ranker";
import { redFlagFor } from "./red-flags";
import type { RedFlag } from "./red-flags";

/** A department as the hospital actually has it. The model sees these and nothing else. */
export type TriageDepartment = { id: string; name: string };

export type TriageSuggestion = {
  departmentId: string;
  /** Why this department, in words a clerk can read out. Never a score. */
  reason: string;
};

export type TriageResult = {
  suggestions: TriageSuggestion[];
  /** `"model"` or `"keywords"` — the seat SAYS which, because advice whose origin is hidden is trusted too much. */
  source: "model" | "keywords";
  /**
   * ═══ SET WHEN THE DESK MUST NOT BOOK AT ALL ═══
   *
   * `red-flags.ts` carries the reasoning. When this is present `suggestions` is EMPTY by
   * construction: a red flag refuses to route rather than ranking Casualty first, because ranking
   * offers a choice and this is not a choice a non-medico clerk should be handed.
   */
  redFlag?: RedFlag;
};

/** What the desk knows about the patient when the complaint is typed. All of it may be absent. */
export type TriagePatient = {
  ageYears: number | null;
  /**
   * The names the desk holds for this patient — the found record, the enrolment form, the guardian
   * — supplied so they can be MASKED before the model is asked, and used for nothing else. A name
   * has no shape a pattern can find, so the one surface that knows it supplies it by value. Absent,
   * the guarantee covers identifier shapes only.
   */
  names?: readonly string[];
};

/**
 * Desk One's own table, carried over verbatim in intent: Hindi and English keys, because the clerk
 * types what the patient said. It is the fallback AND the floor — if the model is unavailable the
 * desk still routes, and if the model disagrees with an unambiguous keyword the clerk sees both.
 */
const KEYWORDS: { keys: string[]; departments: string[]; label: string }[] = [
  { keys: ["chest", "seena", "seene", "heart", "dil", "दिल", "छाती"], departments: ["Cardiology", "General Medicine"], label: "chest discomfort" },
  { keys: ["fever", "bukhar", "बुखार", "temperature"], departments: ["General Medicine", "Paediatrics"], label: "fever" },
  { keys: ["knee", "back", "joint", "kamar", "ghutn", "घुटन", "कमर"], departments: ["Orthopaedics"], label: "joint / back pain" },
  { keys: ["cough", "khansi", "sans", "खांसी", "breath"], departments: ["General Medicine"], label: "cough / breathlessness" },
  { keys: ["pregnan", "garbh", "period", "गर्भ"], departments: ["Obstetrics & Gynaecology"], label: "antenatal / gynae" },
  { keys: ["child", "baccha", "बच्च", "teeka", "vaccin"], departments: ["Paediatrics"], label: "child illness / vaccination" },
  { keys: ["sugar", "bp", "pressure", "diabet", "शुगर"], departments: ["General Medicine", "Cardiology"], label: "BP / sugar follow-up" },
  /*
    ═══════════════════════════════════════════════════════════════════════════════════════════════
    THE OTHER SEVEN DEPARTMENTS, added 2026-09-17 after the owner hit the hole on the live screen
    ═══════════════════════════════════════════════════════════════════════════════════════════════

    Owner, testing `/appointment`: *"I wrote 'aankh me dard', but the system showed 'Nobody in the
    shortest department is on today's board'… there's a doctor in ophthalmology and still the agent
    failed to pick the department."*

    The seven rows above reach FIVE of the twelve departments `DEFAULT_DEPARTMENTS` seeds. `aankh`
    matched nothing, the ranker returned an empty list, the seat fell back to "the shortest
    department" and told the clerk the ROSTER was empty — a sentence about a fault that did not
    exist, describing a routing failure that did. Half the hospital was unreachable by complaint and
    nothing said so, because a table that returns nothing looks exactly like a complaint nobody
    recognises.

    `triage.test.ts` now carries a CENSUS over `DEFAULT_DEPARTMENTS`: a department no complaint can
    reach fails the build. That is what makes this list maintainable rather than merely longer.

    ═══ WHY THE KEYS LOOK OVER-SPELLED ═══

    The matcher is `q.includes(key)`, so a key matches inside any longer word. Two of the obvious
    short keys are actively dangerous here and both are spelled around rather than shortened:
      - `"ear"` would route **heart** pain to ENT.
      - `"tension"` would route **hypertension** to Psychiatry.
    Both are among the commonest complaints in this book, and both have a test.
  */
  {
    keys: ["aankh", "ankh", "आँख", "आंख", "eye", "vision", "nazar", "नज़र", "dikhai", "motiyabind", "मोतियाबिंद", "chashm"],
    departments: ["Ophthalmology"], label: "eye",
  },
  {
    // `ear pain` / `earache` rather than `ear` — see the note above about heart.
    keys: ["kaan", "कान", "ear pain", "earache", "gala", "gale", "गला", "throat", "naak", "नाक", "sunai", "tonsil", "sinus"],
    departments: ["ENT"], label: "ear / nose / throat",
  },
  {
    keys: ["daant", "dant", "दाँत", "दांत", "tooth", "teeth", "masuda", "मसूड़ा", "cavity", "dental"],
    departments: ["Dental"], label: "teeth / gums",
  },
  {
    keys: ["khujli", "खुजली", "skin", "twacha", "त्वचा", "rash", "daane", "दाने", "phunsi", "daad", "fungal", "pimple", "eczema"],
    departments: ["Dermatology"], label: "skin",
  },
  {
    // `tanav` rather than `tension` — see the note above about hypertension.
    keys: ["neend", "नींद", "sleep", "depress", "anxiety", "ghabrahat", "घबराहट", "tanav", "तनाव", "mansik", "मानसिक", "nasha", "panic"],
    departments: ["Psychiatry"], label: "sleep / mood / mind",
  },
  {
    keys: ["hernia", "bawaseer", "बवासीर", "piles", "gaanth", "ganth", "गांठ", "fistula", "appendix", "phoda", "फोड़ा", "lump"],
    departments: ["General Surgery"], label: "lump / piles / hernia",
  },
  {
    // `rehab` catches "stroke rehabilitation"; bare `stroke` is deliberately absent, because an
    // acute stroke is an emergency for Medicine and must not be routed to a physiotherapy bench.
    keys: ["physio", "rehab", "exercise", "akadan", "stiffness", "lakwa", "लकवा"],
    departments: ["Physiotherapy"], label: "physiotherapy / rehabilitation",
  },
];

/** The deterministic ranking. Pure, synchronous, and the answer whenever the model cannot be reached. */
export function keywordRank(text: string, departments: TriageDepartment[]): TriageSuggestion[] {
  const table = tableRank(text, departments);
  if (table.length > 0) return table;

  /*
    ═══ THE HARVESTED BOOK ANSWERS WHAT THE TABLE HAS NEVER SEEN ═══

    Table FIRST and the book only when the table is silent, which is a deliberate ordering rather
    than a hedge:

      - The table is fourteen hand-written rows whose every key was chosen so a clerk can be told
        why, and it is the ONLY half that reads Devanagari — the harvested book is romanised (five
        Devanagari characters across 782 variants, measured). Letting the book override it would
        trade a curated answer for a scored one.
      - The book is 82 syndromes of owner-supplied regional vocabulary. It is what lets
        "thehuna me dard ba" and "motiyabind" reach a department at all, which no list written here
        was ever going to cover.

    So this is a pure ADDITION: every complaint the table answered before, it still answers
    identically, and the gap it used to fall into now has something in it. `rankBook` returns null
    rather than guessing, so a complaint neither half recognises still produces an empty list and
    the seat still says so honestly.
  */
  const book = rankBook(text);
  if (book === null) return [];

  /*
    ═══ IF THE PRIMARY DEPARTMENT IS NOT IN THIS HOSPITAL, THE BOOK SAYS NOTHING ═══

    Found by an existing test, and it was a genuine defect. At a hospital with no Obs & Gynae, an
    antenatal complaint fell through to the entry's SECONDARY department — Paediatrics, which the
    book lists because of the newborn — and the seat cheerfully proposed sending a pregnant woman
    to the children's OPD.

    A secondary department means "also consider", never "instead of". So the book's strongest claim
    has to exist here or the book abstains and the seat falls back to what it does when nothing is
    recognised. The harvest already folded 34 specialities onto the twelve this hospital seeds;
    this is the case where a hospital has DEACTIVATED one of its own, and the honest answer is that
    we have nowhere to send them rather than somewhere wrong.
  */
  const primary = book.departments[0];
  if (primary === undefined) return [];
  if (!departments.some((x) => x.name.toLowerCase() === primary.department.toLowerCase())) return [];

  const out: TriageSuggestion[] = [];
  for (const d of book.departments) {
    const dept = departments.find((x) => x.name.toLowerCase() === d.department.toLowerCase());
    if (dept === undefined || out.some((o) => o.departmentId === dept.id)) continue;
    /*
      The reason NAMES THE WORD THAT DECIDED IT where there is one. "eye — from 'motiyabind'" is
      something a clerk can repeat to a patient and disagree with; a bare department name is not.
    */
    out.push({
      departmentId: dept.id,
      reason: book.because.length > 0 ? `${book.label} — from "${book.because[0] ?? ""}"` : book.label,
    });
  }
  return out;
}

/** The hand-written floor, unchanged. Kept as its own function so its behaviour stays testable alone. */
function tableRank(text: string, departments: TriageDepartment[]): TriageSuggestion[] {
  const q = text.trim().toLowerCase();
  if (q === "") return [];
  const out: TriageSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of KEYWORDS) {
    if (!row.keys.some((k) => q.includes(k))) continue;
    for (const name of row.departments) {
      const dept = departments.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (dept === undefined || seen.has(dept.id)) continue;
      seen.add(dept.id);
      out.push({ departmentId: dept.id, reason: row.label });
    }
  }
  return out;
}

export type TriageConfig = {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  /**
   * MEASURED AGAINST THE REAL GATEWAY, 2026-09-04: `auto/best-fast` took **22.7 s** for a one-line
   * reply. That is not a number a counter can wait on with a queue in front of it, and it is why
   * this advisor is built the way it is — the seat renders the KEYWORD ranking instantly and treats
   * anything the model adds as a refinement that may never arrive. A timeout here is an ordinary
   * outcome, not an error, and it costs the clerk nothing.
   */
  timeoutMs: number;
};

/**
 * The prompt is deliberately small and closed. It names the list, demands indexes, and forbids
 * prose — a model that returns anything else simply fails the parse and the desk falls back.
 */
function buildPrompt(text: string, departments: TriageDepartment[]): string {
  const list = departments.map((d, i) => `${String(i)}: ${d.name}`).join("\n");
  return [
    "You are helping a hospital front desk in India route a walk-in patient to the right OUT-PATIENT department.",
    "The clerk has typed the patient's complaint in the patient's own words. It may be Hindi, English, or Hinglish.",
    "",
    "These are the ONLY departments this hospital has:",
    list,
    "",
    `Complaint: ${text}`,
    "",
    "Reply with STRICT JSON and nothing else, in this exact shape:",
    '{"suggestions":[{"index":<number>,"reason":"<max 6 words, plain English>"}]}',
    "Rules: use ONLY indexes from the list above; at most 3 suggestions, best first;",
    "if nothing clearly fits, reply {\"suggestions\":[]}. Never invent a department. Never add commentary.",
  ].join("\n");
}

/** Pulls the first JSON object out of a reply, so a model that wraps it in prose or fences still parses. */
export function parseSuggestions(raw: string, departments: TriageDepartment[]): TriageSuggestion[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(rows)) return [];
  const out: TriageSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 3)) {
    if (row === null || typeof row !== "object") continue;
    const { index, reason } = row as { index?: unknown; reason?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    // THE GUARD THAT MAKES A HALLUCINATION IMPOSSIBLE: an index we did not send is not a department.
    const dept = departments[index];
    if (dept === undefined || seen.has(dept.id)) continue;
    seen.add(dept.id);
    out.push({
      departmentId: dept.id,
      reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim().slice(0, 60) : "suggested",
    });
  }
  return out;
}

/**
 * Ask the model, and fall back to the table on ANY failure.
 *
 * `fetchImpl` is injected so the tests drive every branch — success, timeout, refusal, garbage —
 * without a network. The real caller passes nothing.
 */
export async function suggestDepartments(
  text: string,
  departments: TriageDepartment[],
  config: TriageConfig,
  fetchImpl: typeof fetch = fetch,
  cache: TriageCache = defaultTriageCache,
  patient: TriagePatient = { ageYears: null },
): Promise<TriageResult> {
  /*
    ═══ THE BRAKE RUNS FIRST, AND IT RETURNS BEFORE ANYTHING ELSE CAN ═══

    Before the keyword table, before the cache, and — deliberately — before the model. Three
    reasons, in order of how much each costs if ignored:

      1. A red flag must not depend on a provider being reachable. `askModel`'s timeout is an
         ordinary outcome, which is the right shape for choosing between Ophthalmology and ENT and
         completely the wrong shape for an emergency.
      2. It must not be cacheable against a complaint string alone: the same words are an emergency
         at 55 and not at 6, and `triageCacheKey` knows nothing about the patient.
      3. It is instant and free, and a clerk who has typed "saans nahi aa rahi" should not watch a
         spinner.

    `suggestions` is left EMPTY rather than filled with Casualty. See `red-flags.ts`: this refuses,
    it does not rank.
  */
  const redFlag = redFlagFor(text, patient.ageYears);
  if (redFlag !== undefined && redFlag !== null) {
    return { suggestions: [], source: "keywords", redFlag };
  }

  const keywords = keywordRank(text, departments);
  if (config.baseUrl === null || config.apiKey === null || text.trim() === "" || departments.length === 0) {
    return { suggestions: keywords, source: "keywords" };
  }

  /*
   * ═══ NOTHING THAT NAMES THE PATIENT LEAVES THIS PROCESS ═══
   *
   * The plan series' law — "identified PHI never enters an inference request — any stage, any
   * locus, ever" — which this path broke until 2026-09-19: the complaint went to the provider
   * verbatim, and a clerk who typed "Ramesh ji ko bukhar, 98765 43210" sent both. The complaint is
   * masked with the copilot's own masker: identifier SHAPES always, and the names the desk holds by
   * value, whole or by their parts, because a clerk says "Ramesh" and the record says "Ramesh Kumar".
   *
   * Everything local — the brake above, the keyword table — reads the complaint as typed. Only what
   * leaves is masked, and the cache below is keyed on that, so it never holds a name either.
   */
  const masked = maskQuestion(text, nameTerms(patient.names ?? []), { wholeWords: true }).masked;

  /*
   * ═══ FD-11 — THE SAME QUESTION IS NOT PAID FOR TWICE ═══
   *
   * The owner asked for this by name. Two savings, and both are exact: an answer already given for
   * this complaint and this department list is returned unchanged, and two clerks who ask the same
   * thing while the first request is still on the wire become ONE upstream call rather than two.
   *
   * Neither trades anything away. `triage-cache.ts` carries the reasoning for what is NOT done —
   * short-circuiting the model on a keyword hit was measured and is wrong — and for the rule that
   * a keyword fallback is never stored, so a transient 429 cannot pin the degraded answer.
   *
   * Keyed on the MASKED complaint: the answer depends only on what the model saw, so "Ramesh ko
   * bukhar" and "Suresh ko bukhar" are one question and one call.
   */
  const key = triageCacheKey(masked, departments);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const already = cache.inflight.get(key);
  if (already !== undefined) {
    cache.stats.coalesced += 1;
    return already;
  }

  const pending = askModel(masked, departments, { ...config, baseUrl: config.baseUrl, apiKey: config.apiKey }, fetchImpl, keywords);
  cache.inflight.set(key, pending);
  try {
    const result = await pending;
    cache.set(key, result); // stores only when `source === "model"`
    return result;
  } finally {
    cache.inflight.delete(key);
  }
}

/**
 * Each name whole, and each of its words: the clerk types what the patient is called at the
 * counter, which is rarely the registered name in full. One-letter initials are dropped — an "R"
 * would mask every standalone r in the complaint and protect nobody.
 */
function nameTerms(names: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const name of names) {
    const whole = name.trim();
    if (whole === "") continue;
    terms.add(whole);
    for (const part of whole.split(/[\s.,]+/)) {
      if ([...part].length >= 2) terms.add(part);
    }
  }
  return [...terms];
}

/** The call itself. Split out so `suggestDepartments` reads as the caching policy it now is. */
async function askModel(
  /** Already masked by the caller. The gate below checks rather than trusts that. */
  text: string,
  departments: TriageDepartment[],
  // Narrowed: `suggestDepartments` has already refused the unconfigured case above.
  config: TriageConfig & { baseUrl: string; apiKey: string },
  fetchImpl: typeof fetch,
  keywords: TriageSuggestion[],
): Promise<TriageResult> {
  const prompt = buildPrompt(text, departments);
  /*
    THE LAST GATE, on the exact string that goes on the wire — the whole prompt, department list
    included, because `mask.ts` is right that a masker cannot be its own witness. A refusal costs
    the model call and nothing else: the clerk gets the keyword table, which is what every other
    failure here already gives them. `IdentifierLeak` carries only a length, never the text.
  */
  try {
    assertNoIdentifiers(prompt);
  } catch {
    return { suggestions: keywords, source: "keywords" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        /*
         * `stream: false` IS LOAD-BEARING, and it was measured rather than assumed. The Omniroute
         * gateway answered `text/event-stream` — `data: {...}` chunks — even when streaming was not
         * requested, so `res.json()` threw and EVERY call silently fell back to the keyword table.
         * The desk looked like it worked and the model was never once used.
         *
         * FD-11 — Groq HONOURS it and returns `application/json`, verified against the live gateway
         * on all four candidate models. The flag stays explicit anyway: it costs nothing, and the
         * failure it prevents is invisible from the desk. A provider that ignores it is exactly the
         * provider nobody would suspect.
         */
        stream: false,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { suggestions: keywords, source: "keywords" };
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { suggestions: keywords, source: "keywords" };
    const parsed = parseSuggestions(content, departments);
    // An empty model answer is not better than the table we already have.
    return parsed.length > 0 ? { suggestions: parsed, source: "model" } : { suggestions: keywords, source: "keywords" };
  } catch {
    return { suggestions: keywords, source: "keywords" };
  } finally {
    clearTimeout(timer);
  }
}
