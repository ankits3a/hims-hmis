/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * SNIPPETS — A TYPING AID FOR THE CONSULT SCREEN, AND NOTHING THAT REACHES THE RECORD
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14, asked for Raycast-style snippets: a keyword, auto-expansion, Tab, and a
 * reference of the placeholder vocabulary.
 *
 * ═══ THE ONE THING THAT MAKES THIS DIFFERENT FROM RAYCAST, AND BETTER HERE ═══
 *
 * Raycast's placeholders come from the machine — `{clipboard}`, `{date}`, `{uuid}`. The useful ones
 * at a consultation come from THE PATIENT IN THE CHAIR: their weight as charted at the bay this
 * morning, the diagnosis just tagged, the follow-up date seven days out. A snippet that writes
 * *"Take one tablet twice daily for 5 days"* saves typing; one that writes *"Syrup 5 mL twice daily
 * — for Asha Devi, 14 kg, review on 21 Sep 2026"* saves typing AND transcription, which is where
 * the errors are.
 *
 * ═══ EXPANSION HAPPENS AT INSERT TIME AND IS NEVER STORED ═══
 *
 * The moment a snippet expands, what sits in the field is ORDINARY TEXT. No placeholder reaches
 * `opd_encounters.advice`, the e-Rx, the print relay or the patient's slip. That is deliberate and
 * it is what keeps this feature out of every other seam in the tree: the print path cannot render a
 * placeholder wrong because it never sees one, and a note written today still reads the same in
 * five years when the patient's weight has changed.
 *
 * ═══ AN UNRESOLVABLE PLACEHOLDER BECOMES A BLANK, NEVER AN EMPTY STRING ═══
 *
 * The bay has not charted a weight yet; the doctor has not tagged a diagnosis; a keyword has a typo
 * in it. Raycast would insert nothing and the sentence would close over the hole — *"Take 500 mg
 * for  kg body weight"* — which prints, and which nobody reads twice. Here every unresolved
 * placeholder becomes a TAB STOP instead: the caret is taken to it and the doctor is stopped by it.
 * A missing value should interrupt the person who can supply it, not vanish quietly into a slip.
 */

export type SnippetContext = {
  patient: { name: string | null; uhid: string | null; ageYears: number | null; sex: string | null } | null;
  vitals: {
    weightKg: number | null; heightCm: number | null; sbp: number | null; dbp: number | null;
    pulse: number | null; spo2: number | null; tempC: number | null;
  } | null;
  /** What the doctor has already written on this note — tags joined as they are stored. */
  note: { complaint: string; diagnosis: string };
  /**
   * THERE IS NO `department` HERE, AND THERE WAS. `{dept}` was written into the reference and then
   * removed: the consult screen holds the doctor's `departmentId` and no name for it, and fetching
   * the whole masters list for one placeholder is not a trade worth making. S10 — every documented
   * placeholder resolves against a full record — is what caught it before it shipped as a token
   * that could only ever produce a blank.
   */
  doctor: { name: string | null };
  /** Injected rather than read from the clock, so every test states its own day. */
  now: Date;
};

/** A blank the doctor Tabs between. `end > start` when the stop carries a default to type over. */
export type SnippetStop = { start: number; end: number; label: string };
export type Expansion = { text: string; stops: SnippetStop[] };

/**
 * THE KEYWORD CHARACTER REFERENCE, and it is one list so the panel a doctor reads and the resolver
 * that runs can never drift apart. `describe` is what the reference panel shows; `resolve` returns
 * null for "not known right now", which becomes a Tab stop rather than an empty string.
 */
export type PlaceholderSpec = {
  token: string;
  describe: string;
  resolve: (ctx: SnippetContext) => string | null;
};

/**
 * ═══ THE MONTH NAMES ARE WRITTEN OUT, AND THAT IS NOT PEDANTRY ═══
 *
 * `toLocaleDateString("en-IN", { month: "short" })` renders **"21 Sept 2026"** on Node 22 with full
 * ICU — measured — and "21 Sep 2026" on other CLDR builds. This string is printed on a patient's
 * slip and is read aloud at a counter, so it must not depend on which runtime rendered it: the
 * browser, the print relay and a test can all be different builds.
 *
 * IST, because a consultation at 23:40 in Delhi is still that day's consultation, and a UTC date
 * would put the follow-up on the wrong day for every evening clinic.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const IST_DATE = (d: Date): string => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[ist.getUTCMonth()]!} ${String(ist.getUTCFullYear())}`;
};

const num = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : String(n));
const text = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

export const PLACEHOLDERS: PlaceholderSpec[] = [
  { token: "name", describe: "The patient's name", resolve: (c) => text(c.patient?.name) },
  { token: "uhid", describe: "The patient's UHID", resolve: (c) => text(c.patient?.uhid) },
  { token: "age", describe: "Age in completed years", resolve: (c) => num(c.patient?.ageYears) },
  { token: "sex", describe: "Administrative gender, as registered", resolve: (c) => text(c.patient?.sex) },
  { token: "weight", describe: "Weight in kg, as charted at the bay today", resolve: (c) => num(c.vitals?.weightKg) },
  { token: "height", describe: "Height in cm, as charted today", resolve: (c) => num(c.vitals?.heightCm) },
  {
    token: "bp",
    describe: "Blood pressure as systolic/diastolic, e.g. 118/76",
    resolve: (c) => {
      const systolic = c.vitals?.sbp ?? null;
      const diastolic = c.vitals?.dbp ?? null;
      /*
        BOTH ARMS OR NEITHER. Half a blood pressure is not a reading, and "118/" on a slip is worse
        than a blank the doctor is stopped at.

        The names are spelled out rather than `s` and `d` for a second reason worth knowing about:
        `i18n-keys.test.ts` scans string literals for hand-spelled plurals — `patient(s)`, `box(es)`
        — and `String(s)` inside a template literal matches that pattern. A false positive, but the
        full words are better here anyway, so this sidesteps it without touching a shared guard.
      */
      return systolic === null || diastolic === null ? null : `${String(systolic)}/${String(diastolic)}`;
    },
  },
  { token: "pulse", describe: "Pulse, beats per minute", resolve: (c) => num(c.vitals?.pulse) },
  { token: "spo2", describe: "SpO₂, per cent", resolve: (c) => num(c.vitals?.spo2) },
  { token: "temp", describe: "Temperature in °C", resolve: (c) => num(c.vitals?.tempC) },
  { token: "diagnosis", describe: "The diagnosis tags on this note", resolve: (c) => text(c.note.diagnosis) },
  { token: "complaint", describe: "The chief complaint tags on this note", resolve: (c) => text(c.note.complaint) },
  { token: "doctor", describe: "The treating doctor's name", resolve: (c) => text(c.doctor.name) },
  { token: "today", describe: "Today's date, e.g. 14 Sep 2026", resolve: (c) => IST_DATE(c.now) },
];

/** Documented separately because they take an argument rather than being a fixed token. */
export const PLACEHOLDER_FORMS = [
  { token: "{date+N}", describe: "N days from today — {date+7} is the follow-up a week out" },
  { token: "{date-N}", describe: "N days before today" },
  { token: "{?}", describe: "A blank. Tab takes the caret here" },
  { token: "{?text}", describe: "A blank pre-filled with text to type over, e.g. {?twice daily}" },
  { token: "{{ }}", describe: "Literal braces — {{x}} writes {x}, for the rare snippet that needs one" },
];

const SPEC_BY_TOKEN = new Map(PLACEHOLDERS.map((p) => [p.token, p]));

/** Every token a body may legally use, for the save-time check. */
export function knownTokens(): string[] {
  return [...PLACEHOLDERS.map((p) => p.token), "date+N", "date-N", "?"];
}

/**
 * The tokens in a body that resolve to nothing at all — a typo like `{wieght}`. Reported when a
 * snippet is SAVED, because that is the last moment a human is looking at it. At expansion time an
 * unknown token still degrades to a blank rather than printing its own braces; this is the earlier,
 * cheaper warning, not the guard.
 */
export function unknownTokensIn(body: string): string[] {
  const out: string[] = [];
  for (const raw of tokensOf(body)) {
    if (raw.startsWith("?")) continue;
    if (/^date[+-]\d+$/.test(raw)) continue;
    if (SPEC_BY_TOKEN.has(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

function tokensOf(body: string): string[] {
  const out: string[] = [];
  /* `{{` and `}}` are the escapes and are skipped, so a body may carry literal braces. */
  const re = /\{\{|\}\}|\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[0] === "{{" || m[0] === "}}") continue;
    out.push(m[1] ?? "");
  }
  return out;
}

function resolveToken(raw: string, ctx: SnippetContext): string | null {
  const spec = SPEC_BY_TOKEN.get(raw);
  if (spec !== undefined) return spec.resolve(ctx);

  const rel = /^date([+-])(\d+)$/.exec(raw);
  if (rel !== null) {
    const days = Number(rel[2]) * (rel[1] === "-" ? -1 : 1);
    const d = new Date(ctx.now.getTime() + days * 24 * 60 * 60 * 1000);
    return IST_DATE(d);
  }
  return null;
}

/**
 * Expand one snippet body against the patient in the chair.
 *
 * Returns the finished TEXT and the Tab stops in the order the doctor should visit them — which is
 * source order, so a snippet reads top to bottom the way it was written.
 */
export function expandSnippet(body: string, ctx: SnippetContext): Expansion {
  let out = "";
  const stops: SnippetStop[] = [];
  const re = /\{\{|\}\}|\{([^{}]*)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    out += body.slice(last, m.index);
    last = m.index + m[0].length;

    if (m[0] === "{{") { out += "{"; continue; }
    if (m[0] === "}}") { out += "}"; continue; }

    const raw = m[1] ?? "";
    if (raw.startsWith("?")) {
      /* An explicit blank. Its text is a DEFAULT to type over, selected when the caret lands. */
      const fill = raw.slice(1);
      stops.push({ start: out.length, end: out.length + fill.length, label: fill });
      out += fill;
      continue;
    }

    const value = resolveToken(raw, ctx);
    if (value === null) {
      /*
        NOT KNOWN, so it becomes a blank the doctor is taken to. This covers three different causes
        with one behaviour, which is the point: no weight charted yet, no diagnosis tagged yet, and
        a token nobody ever defined all produce a hole that must not close over silently.
      */
      stops.push({ start: out.length, end: out.length, label: raw });
      continue;
    }
    out += value;
  }
  out += body.slice(last);
  return { text: out, stops };
}

/**
 * The keyword rule, and it is a safety rule rather than a style one.
 *
 * Auto-expansion fires as the doctor types. A keyword of `rest` would detonate in the middle of
 * "rest and fluids", "arrest" and "restrict" — so a keyword must begin with a character that does
 * not occur inside a word. `;` is the suggested one and `/` and `\` are allowed for the doctor who
 * prefers them.
 */
export const KEYWORD_LEAD = [";", "/", "\\"];

export function keywordProblem(keyword: string): string | null {
  const k = keyword.trim();
  if (k === "") return null; // a snippet without a keyword is legal — it is tapped, not typed
  if (!KEYWORD_LEAD.includes(k[0] ?? "")) return "lead";
  if (k.length < 2) return "short";
  if (/\s/.test(k)) return "space";
  return null;
}

/**
 * Find a keyword ending exactly at the caret. Longest match wins, so `;uri2` is reachable even
 * where `;uri` also exists — otherwise the shorter one would fire first and the longer could never
 * be typed at all.
 */
export function keywordEndingAt(
  value: string, caret: number, keywords: string[],
): { keyword: string; start: number } | null {
  let best: { keyword: string; start: number } | null = null;
  for (const k of keywords) {
    if (k === "") continue;
    const start = caret - k.length;
    if (start < 0) continue;
    if (value.slice(start, caret) !== k) continue;
    if (best === null || k.length > best.keyword.length) best = { keyword: k, start };
  }
  return best;
}
