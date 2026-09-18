/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — WHAT THE MODEL IS ALLOWED TO SEE, AND THE MACHINE THAT MAKES IT TRUE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The desk copilot answers questions a clerk types with a queue in front of them. Some of those
 * questions miss the phrasebook and reach a language model to be ROUTED — never to be answered.
 * The distinction is the whole design: the model is handed a question with every identifier
 * replaced by a placeholder and a menu of tool names, and it returns which tool to run. It does not
 * see the patient, it does not see the answer, and it does not write the sentence the clerk reads.
 *
 * The plan series states the law this discharges, in as many words:
 *
 *     "identified PHI never enters an inference request — any stage, any locus, ever."
 *
 * Plan 12a's scope item 3 states the enforcement in the same breath — *"asserted by tests that the
 * request body contains no identifier fields"*. So there are two functions here and they are
 * deliberately not one. `maskQuestion` is the INTENTION. `assertNoIdentifiers` is the ENFORCEMENT,
 * runs last, on the exact string that is about to go on the wire, and refuses rather than repairs.
 * A masker cannot be its own witness: the failure that matters is a bug in the masker, and a check
 * written as part of it would be wrong in precisely the cases it exists to catch.
 *
 * ═══ WHY REFUSE RATHER THAN REPAIR ═══
 *
 * A scrubber that silently fixes what it finds turns a masker bug into a thing nobody learns about.
 * Refusing costs one question its model routing — it falls back to the phrasebook, which is the
 * ordinary outcome when the model is unreachable anyway — and it costs a patient nothing.
 * Fail-closed on the model, fail-open on the desk.
 */

/** What one masking pass produced. `slots` maps `<<P1>>` → the text the clerk actually typed. */
export type MaskedQuestion = {
  masked: string;
  slots: Record<string, string>;
};

/**
 * THE SHAPES THAT ARE IDENTITIES.
 *
 * Ordered longest-first so the greedier pattern wins: a visit number is eleven characters that
 * begin like a UHID, and a UHID is nine characters that contain a digit run. Matching short first
 * would leave half an identifier standing, which is worse than leaving the whole one.
 */
const IDENTIFIER_PATTERNS: RegExp[] = [
  /**
   * The episode number a patient carries on a printed slip — `V2609150001`, a letter and ten
   * digits (`nextEpisodeNo`, `modules/opd/encounters.ts`). Front-desk questions arrive with these
   * more often than with a UHID, because the clerk is reading the paper in the patient's hand.
   */
  /\b[A-Za-z]{1,5}\d{10}\b/g,
  /**
   * The UHID, 2026-08-25 format: `<PREFIX><7-digit serial><check digit>`, e.g. `U12345013`.
   * `modules/patients/search.ts` is the authority for the shape and this mirrors its `UHID_FULL_RE`.
   */
  /\b[A-Za-z]{1,5}\d{8}\b/g,
  /** An Indian mobile, with or without country code, spaces and dashes tolerated. */
  /\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g,
  /**
   * THE CATCH-ALL, AND IT IS DELIBERATELY OVER-EAGER.
   *
   * Five digits or more, whatever surrounds them. An identifier this system does not recognise —
   * a legacy UHID from the old register, an insurance number, an ABHA, a number format some future
   * module mints — is still an identifier, and a masker that only knew today's formats would leak
   * every one of tomorrow's. The cost of over-masking is a little routing accuracy on a question
   * about "40012"; the cost of under-masking is a patient.
   *
   * FIVE is the floor because four and below is the language of a counter: "4 baje", "2 line",
   * "500 rupees", "10 minute". Masking those would make the model dumber for no gain in safety,
   * since none of them identifies anybody.
   */
  /\b\d{5,}\b/g,
];

/** Identifier-shaped, for the scrubber. Same shapes, un-anchored, used only to detect. */
const IDENTIFIER_DETECTORS: RegExp[] = IDENTIFIER_PATTERNS.map((r) => new RegExp(r.source));

const PLACEHOLDER_RE = /^<<P\d+>>$/;

/** Escape a caller-supplied term so a name containing `.` or `(` cannot act as a pattern. */
function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every identity in `question` with a stable placeholder.
 *
 * `terms` is what the SCREEN knows it is displaying — the names on the rows the clerk is looking
 * at. A name has no shape a regular expression can find (see the test file's own note on this), so
 * the one surface that does know supplies them by value. Callers that display nothing pass none,
 * and then the guarantee covers identifier shapes only — which is the honest scope, and why the
 * web client is expected to pass them.
 */
export function maskQuestion(question: string, terms: readonly string[] = []): MaskedQuestion {
  const slots: Record<string, string> = {};
  const issued = new Map<string, string>();
  let next = 1;

  const placeholderFor = (found: string): string => {
    const key = found.toLowerCase();
    const already = issued.get(key);
    if (already !== undefined) return already;
    const token = `<<P${String(next)}>>`;
    next += 1;
    issued.set(key, token);
    slots[token] = found;
    return token;
  };

  let masked = question;

  /*
    CALLER-SUPPLIED TERMS RUN FIRST, longest-first within them.
    "Farida Khatoon" must be one placeholder rather than two, so the full name has to be consumed
    before the given name can match inside it.
  */
  for (const term of [...terms].filter((t) => t.trim() !== "").sort((a, b) => b.length - a.length)) {
    const re = new RegExp(escapeLiteral(term.trim()), "gi");
    masked = masked.replace(re, (found) => placeholderFor(found));
  }

  for (const pattern of IDENTIFIER_PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, "g"), (found) => placeholderFor(found));
  }

  return { masked, slots };
}

/**
 * Turn what the model handed back into the identifier the clerk typed — or nothing.
 *
 * `null` for anything that is not a placeholder WE issued, and that is the load-bearing half. The
 * model is free to reply `<<P9>>`, or to helpfully echo a UHID it invented; resolving either would
 * take a hallucination and point it at a real person's record. The only strings that resolve are
 * the ones this process minted moments ago.
 */
export function rehydrate(slot: string, slots: Record<string, string>): string | null {
  const trimmed = slot.trim();
  if (!PLACEHOLDER_RE.test(trimmed)) return null;
  return slots[trimmed] ?? null;
}

export class IdentifierLeak extends Error {
  constructor(readonly matched: string) {
    super(`refusing to send: identifier-shaped text survived masking (${matched.length} chars)`);
    this.name = "IdentifierLeak";
  }
}

/**
 * The last thing that runs before a body goes on the wire. Throws `IdentifierLeak` if anything
 * identifier-shaped is still standing.
 *
 * The message carries the LENGTH of what it matched and never the text. An exception ends up in a
 * log, and a scrubber that printed the identifier it caught would be the leak it exists to prevent.
 */
export function assertNoIdentifiers(text: string): void {
  for (const detector of IDENTIFIER_DETECTORS) {
    const hit = detector.exec(text);
    if (hit !== null) throw new IdentifierLeak(hit[0]);
  }
}
