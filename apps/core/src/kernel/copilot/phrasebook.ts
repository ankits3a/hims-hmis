/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE DETERMINISTIC FLOOR
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `modules/opd/triage.ts` established the shape this follows, and its comment states the rule:
 * *"It is the fallback AND the floor — if the model is unavailable the desk still routes."* The
 * copilot inherits both halves. Almost every question a counter asks is one of a dozen sentences,
 * so the floor answers them instantly, for nothing, and the model is reached only for the tail.
 * That is what makes the whole thing cheap: spend is proportional to novelty, not to traffic.
 *
 * ═══ WHY THIS SCORES INSTEAD OF BRANCHING ═══
 *
 * Ten screens already do this with `q.toLowerCase()` and a first-match-wins `if/else`. That shape
 * cannot express "this token is weak evidence for two intents", and shipped code pays for it:
 * Desk One files `kitna` under the queue branch and `paisa`/`kitna` under the fee branch, so
 * "kitna paisa baaki hai" — plainly a money question — answers about the queue, because the queue
 * branch happens to be written first. The consult screen has the identical defect with `line`.
 *
 * So every intent is SCORED and the winner must beat the runner-up by a margin. A question whose
 * evidence is genuinely split returns null, and null is routed to the model. Admitting a miss costs
 * one cheap model call; guessing costs a clerk's trust the first time it is confidently wrong.
 */

/** The tools a question can be routed to. `none` is the model's way of saying it recognised nothing. */
export type CopilotIntent = "visit_status" | "queue_depth" | "patient_dues" | "my_day_report" | "stock_on_shelf" | "paid_not_collected" | "draft_short_book_entry";

export type IntentMatch = {
  intent: CopilotIntent;
  /** The placeholder this question was about, or null when it named no patient. */
  slot: string | null;
  /** Which cues fired. The seat SAYS why it answered — `triage.ts`'s `source` rule, one level finer. */
  cues: string[];
  score: number;
};

type Cue = { token: string; weight: number };

/**
 * STRONG cues name the intent almost by themselves. WEAK cues are the shared connective tissue of
 * counter Hindi — `kitna`, `kaun`, `hai` — which mean nothing alone and tip a balance when a strong
 * cue is already present. Getting this split right is the entire difference from the ten chains.
 *
 * A cue containing a SPACE outranks both, and that fell out of a failing test rather than a guess.
 * "is <<P1>> still waiting" is a question about one patient, but `still waiting` contains `wait`,
 * which is the queue's strongest single token — scored equally the two intents tie and the margin
 * rule refuses to answer. A phrase is strictly more evidence than any word inside it, so it scores
 * higher, and the tie disappears.
 */
const PHRASE_WEIGHT = 4;
const S = (token: string): Cue => ({ token, weight: token.includes(" ") ? PHRASE_WEIGHT : 3 });
const W = (token: string): Cue => ({ token, weight: token.includes(" ") ? 2 : 1 });

/**
 * Cues are matched as SUBSTRINGS, which is deliberate for Hindi: `dekh` has to catch "dekha",
 * "dekh liya" and "dekhliya", and a word-boundary match would need every inflection spelled out.
 * The cost is that a cue must be long enough not to appear inside an unrelated word — hence `bakay`
 * rather than `baki`, and no cue shorter than three characters.
 */
const CUES: Record<CopilotIntent, Cue[]> = {
  /** "Has this person been seen yet / where are they?" — the owner's first example. */
  visit_status: [
    S("been seen"), S("seen by"), S("dekh"), S("देख"), S("mil gaya"), S("mila"),
    S("still waiting"), S("consult"), S("doctor ne"), S("डॉक्टर"),
    /*
      2026-09-19 — "मरीज <<P1>> अभी भी इंतज़ार में है क्या" answered the QUEUE: `इंतज़ार` is the
      queue's strong cue and this intent had no Hindi "STILL waiting" to set against it. The phrase
      outweighs the word inside it, as `still waiting` already does in English; a bare "kitna
      intezaar hai", with no "still", stays the queue's.
    */
    S("अभी भी इंतज़ार"), S("abhi bhi intezaar"), S("abhi bhi intezar"), S("ab bhi intezaar"),
    S("number aaya"), S("number aa gaya"),
    W("doctor"), W("status"), W("andar"), W("bulaya"),
  ],
  /** "How long / which line?" — what a clerk asks on behalf of somebody in front of them. */
  queue_depth: [
    S("wait"), S("queue"), S("line"), S("bhid"), S("भीड़"), S("intezaar"), S("इंतज़ार"),
    S("kitni der"), S("how long"), S("katar"), S("क़तार"),
    W("kam"), W("chhoti"), W("shortest"), W("kaun si"), W("kitna"),
  ],
  /** "What does this person owe?" */
  patient_dues: [
    S("paisa"), S("paise"), S("bakay"), S("baaki"), S("बकाया"), S("due"), S("dues"),
    S("owe"), S("outstanding"), S("balance"), S("पैसा"),
    W("kitna"), W("bill"), W("amount"),
  ],
  /** "Give me my day." — the owner's second example, and the one that must DO something. */
  my_day_report: [
    S("day report"), S("din ki report"), S("meri report"), S("my day"), S("report nikaal"),
    S("today's figures"), S("aaj ki report"), S("aaj ka hisaab"), S("दिन की रिपोर्ट"),
    S("kitne register"), S("day's figures"), S("end of day"),
    W("report"), W("aaj"), W("today"), W("figures"), W("summary"),
  ],
  /**
   * PD-7 C8 — "kitni amoxicillin bachi hai", "Pan 40 kab expire hoga": a medicine BY NAME on the
   * pharmacy shelf. The name itself is not a cue (it is the tool's subject, read from the question).
   * Left out on purpose, each for a question it would have stolen: `bache` (also children, and
   * patients still waiting), `available` ("is the doctor available"), `how many` / `how much`
   * ("how many are waiting", "how much does he owe"), bare `left` ("patients left to see").
   */
  stock_on_shelf: [
    S("stock"), S("in stock"), S("bachi"), S("bacha"), S("on the shelf"), S("shelf"), S("is left"), S("are left"),
    S("expire"), S("expiry"), S("kab expire"), S("स्टॉक"), S("बची"), S("बचा"), S("एक्सपायर"),
    W("kitni"), W("dawai"), W("medicine"), W("strip"), W("goli"), W("दवा"),
  ],
  /**
   * PD-7 C8 — "kiska paisa pending hai" at the pharmacy: paid, and the medicines not yet collected
   * (E25 — a paid ticket can stand uncollected). `pending` alone is weak on purpose: "<<P1>> ka
   * paisa pending hai" is a question about ONE patient's dues and must stay `patient_dues`.
   */
  paid_not_collected: [
    S("not collected"), S("uncollected"), S("collect nahi"), S("nahi le gaye"), S("le nahi gaye"),
    S("nahi liya"), S("liya nahi"), S("paid but"), S("pickup"), S("kiska paisa pending"), S("waiting to collect"),
    /*
      2026-09-19 — "kaun paisa dekar dawai lene nahi aaya" answered DUES: `paisa` scored 3 and
      nothing here matched, because the counter says the patient did not COME to take it as often
      as that they did not take it. "Paid, then" is its own phrase; with a named patient it ties
      `paisa` + the placeholder, and the tie goes to the model rather than to either guess.
    */
    S("lene nahi aaya"), S("lene nahi aaye"), S("lene nahi aayi"), S("nahi aaya lene"),
    S("paisa dekar"), S("paise dekar"), S("pay karke"),
    S("दवा नहीं ली"), S("लेने नहीं आया"), S("पैसे दे दिए"),
    W("pending"), W("collect"), W("le gaye"),
  ],
  /**
   * PARITY P1 (2026-09-24) — "Pan 40 khatam", "out of Pan 40": the counter says a drug is short,
   * and the agent DRAFTS a short-book line for the pharmacist to confirm. `out of stock` outweighs
   * the shelf's `stock` (a phrase outranks the word inside it); `nahi bacha` is left out, because
   * against the shelf's `bacha` it would tie inside the margin and send a plain stock question to
   * the model.
   */
  draft_short_book_entry: [
    S("khatam"), S("khatm"), S("khtm"), S("खत्म"), S("ख़त्म"), S("out of"), S("out of stock"), S("ran out"),
    S("short book"), S("shortbook"), S("shortage"), S("short hai"), S("short ho"),
    W("likh"), W("note"), W("finished"),
  ],
};

const PLACEHOLDER_RE = /<<P\d+>>/;

/** The lowest score that may answer at all, and the margin the winner must beat the runner-up by. */
const MIN_SCORE = 3;
const MIN_MARGIN = 2;

/**
 * ═══ `\p{M}` IS LOAD-BEARING, AND LEAVING IT OUT SHREDDED EVERY HINDI WORD ═══
 *
 * The first draft of this kept `\p{L}` and `\p{N}` and dropped everything else. In Devanagari the
 * vowel signs and the virama are Unicode MARKS, not letters — so `डॉक्टर` (ड + ◌ॉ + क + ◌् + ट + र)
 * normalised to `ड क टर`, and every Devanagari cue in the table below silently matched nothing.
 * The Hindi tests failed and the romanised ones passed, which is exactly the shape of bug that
 * ships when a feature is only ever typed in by its author.
 *
 * ═══ AND NFC, FOR THE SAME REASON ONE LEVEL DOWN (2026-09-19) ═══
 *
 * `ज़` is one code point on some keyboards (U+095B) and two on others (ज + nukta); so are `ड़`, `फ़`
 * and the rest. The table's `इंतज़ार` is the two-point form, and a question typed with the one-point
 * form matched nothing. NFC maps both spellings to one sequence, on both sides of the comparison.
 */
function normalise(question: string): string {
  return question
    .normalize("NFC")
    .toLowerCase()
    /*
      Punctuation to spaces rather than removed: "dekh-liya" and "dekh liya" must normalise the
      same way, and deleting the separator would fuse tokens instead of splitting them. The
      placeholder's own angle brackets are preserved — it is matched before this runs.
    */
    .replace(/[^\p{L}\p{M}\p{N}<>\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cues are normalised through the SAME function as the question, at module load.
 *
 * Also found by a failing test: `today's figures` never matched, because the question's apostrophe
 * became a space and the cue's did not. Any table matched against normalised text has to be
 * normalised by the same code, or the two drift the first time a cue contains punctuation.
 */
const NORMALISED_CUES: Record<CopilotIntent, Cue[]> = Object.fromEntries(
  (Object.keys(CUES) as CopilotIntent[]).map((intent) => [
    intent,
    CUES[intent].map((cue) => ({ token: normalise(cue.token), weight: cue.weight })),
  ]),
) as Record<CopilotIntent, Cue[]>;

/**
 * Route a MASKED question to one tool, or return null and let the model try.
 *
 * Takes the masked form so the floor and the model see the same string, and so that the presence of
 * a placeholder is itself usable evidence — a question carrying one is about a specific patient.
 */
export function matchIntent(question: string): IntentMatch | null {
  const slotHit = PLACEHOLDER_RE.exec(question);
  const slot = slotHit === null ? null : slotHit[0];
  const text = normalise(question);
  if (text === "" || text.replace(PLACEHOLDER_RE, "").trim() === "") return null;

  const scored = (Object.keys(NORMALISED_CUES) as CopilotIntent[]).map((intent) => {
    const cues: string[] = [];
    let score = 0;
    for (const cue of NORMALISED_CUES[intent]) {
      if (!text.includes(cue.token)) continue;
      cues.push(cue.token);
      score += cue.weight;
    }
    /*
      A NAMED PATIENT IS EVIDENCE FOR THE PATIENT-SCOPED INTENTS, and it is worth one weak cue
      rather than a strong one. "<<P1>> ka kitna paisa baaki hai" should not need the nudge — the
      money cues carry it — but "<<P1>> ka number aaya kya" has only weak cues of its own, and a
      question that names somebody is more likely to be about them than about the room.
    */
    if (slot !== null && (intent === "visit_status" || intent === "patient_dues")) score += 1;
    return { intent, slot, cues, score };
  }).sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;
  if (best === undefined || best.score < MIN_SCORE) return null;
  if (runnerUp !== undefined && best.score - runnerUp.score < MIN_MARGIN) return null;
  return best;
}

/**
 * The tool names, for the model's menu. Derived from the same object the floor scores, so the two
 * halves can never disagree about what exists — a menu maintained by hand would drift the first
 * time a tool was added.
 */
export function intentNames(): CopilotIntent[] {
  return Object.keys(CUES) as CopilotIntent[];
}
