import type { IpdCopilotSource } from "@hmis/contracts";

/**
 * E5.3 (#740), E5.4 (#741) — THE DETERMINISTIC LAYER: typed facts, the lines rendered from them, and the verifier that
 * stands between a model's words and the screen (spec §0A principle 6; §4.10 edge 13; §6 "an AI line whose number
 * differs from its source fails the test suite"). Pure: no database, no clock, no model.
 *
 * THE SAFETY ARGUMENT, IN ORDER:
 *  1. A FACT is built from rows (`copilot-facts.ts`) and carries the numbers, clock times and names it was built from,
 *     and the ids of those rows.
 *  2. A LINE is a template over one fact (`renderLine`). `test/…copilot-lines.test.ts` proves, over fixtures, that every
 *     number a template prints is one its fact carries.
 *  3. A model may only REWORD a line. `verifyReworded` accepts the rewording only when its numbers and times are
 *     exactly the template line's, its names are kept, and its guarded words (no / missed / given / max / rose …) are
 *     the template's — so "No missed doses, 9 given" can never come back as "9 doses missed". Anything else: the
 *     rewording is dropped and the template line stands. Refuse, never repair.
 *  4. Free text (the SBAR's and the discharge summary's) is checked by `verifyFreeText`: every number must already be
 *     in the text it summarises, it may not propose anything, and it carries no money and no identifier.
 */

export type FactRecord = { id: string; at: Date | null; label: string };

export type VitalParam = "temperatureC" | "pulse" | "respRate" | "systolic" | "spo2" | "painScore";
export type EwsBand = "low" | "low_medium" | "medium" | "high";

type FactBase = {
  /** Stable per fact and admission: the line's key. */
  key: string;
  source: IpdCopilotSource;
  /** Every number a line about this fact may print — computed from the rows, never from the template. */
  numbers: number[];
  /** Every IST clock time ("14:05") a line about this fact may print. */
  times: string[];
  /** Drug and test names from the rows: a rewording must keep the ones its template line printed. */
  terms: string[];
  records: FactRecord[];
};

export type Fact = FactBase & (
  | { kind: "vital"; param: VitalParam; max: number; min: number; latest: number; count: number; abnormal: boolean }
  /** `from`: the band before the window (else the window's first); `peak`: the worst set of the window. */
  | { kind: "ews"; scoreKind: "news2" | "meows" | "pews"; from: EwsBand | null; to: EwsBand; latestValue: number; latestAt: string; peak: EwsBand; peakValue: number; peakAt: string; sets: number }
  | { kind: "emar_exceptions"; missed: number; refused: number; held: number; given: number }
  | { kind: "emar_prn"; count: number }
  | { kind: "orders_new"; count: number }
  | { kind: "orders_stopped"; count: number }
  | { kind: "orders_active"; count: number }
  | { kind: "results"; department: "lab" | "imaging"; count: number }
  | { kind: "notes"; count: number; flagged: number }
  | { kind: "io"; inMl: number; outMl: number; balanceMl: number }
  | { kind: "consults"; asked: number; answered: number }
  | { kind: "npo"; since: string }
  | { kind: "diet"; code: string }
  | { kind: "rounds_other"; count: number }
);

export type Line = { key: string; text: string; source: IpdCopilotSource; abnormal: boolean; weight: number; fact: Fact };

/** What a builder supplies: the typed fact and the numbers counted or read from its rows. */
export type FactDraft = { [K in Fact["kind"]]: Omit<Extract<Fact, { kind: K }>, "times" | "terms"> & { times?: string[]; terms?: string[] } }[Fact["kind"]];

/** A fact's names are record text too: a strength in a drug name ("Zemox 500 mg") is a number the line may print. */
export function mkFact(d: FactDraft): Fact {
  const terms = d.terms ?? [];
  const inNames = terms.map((t) => quantitiesIn(t));
  return {
    ...d, terms,
    numbers: [...d.numbers, ...inNames.flatMap((q) => q.numbers)],
    times: [...(d.times ?? []), ...inNames.flatMap((q) => q.times)],
  } as Fact;
}

// ═══════════════════════════════════════════ templates ═══════════════════════════════════════════

const VITAL_WORDS: Record<VitalParam, { name: string; unit: string }> = {
  temperatureC: { name: "Temperature", unit: " °C" }, pulse: { name: "Pulse", unit: "/min" }, respRate: { name: "Resp rate", unit: "/min" },
  systolic: { name: "Systolic BP", unit: " mmHg" }, spo2: { name: "SpO2", unit: "%" }, painScore: { name: "Pain score", unit: "" },
};
const BAND_WORDS: Record<EwsBand, string> = { low: "low", low_medium: "low–medium", medium: "medium", high: "high" };
const BAND_RANK: Record<EwsBand, number> = { low: 0, low_medium: 1, medium: 2, high: 3 };
const SCORE_WORDS = { news2: "NEWS2", meows: "MEOWS", pews: "PEWS" } as const;

/** A number as a line prints it: at most one decimal, no trailing ".0". */
export const shown = (n: number): string => String(Math.round(n * 10) / 10);
const plural = (n: number, one: string, many: string): string => `${shown(n)} ${n === 1 ? one : many}`;
const named = (terms: readonly string[]): string => (terms.length === 0 ? "" : `: ${terms.slice(0, 3).join(", ")}${terms.length > 3 ? " and others" : ""}`);

/** Whether the fact is something the doctor must see first. */
export function isAbnormal(f: Fact): boolean {
  switch (f.kind) {
    case "vital": return f.abnormal;
    // Still raised, risen, or raised at any time in the window (a score that touched medium is seen even after it settles).
    case "ews": return BAND_RANK[f.to] >= BAND_RANK.medium || BAND_RANK[f.peak] >= BAND_RANK.medium || (f.from !== null && BAND_RANK[f.to] > BAND_RANK[f.from]);
    case "emar_exceptions": return f.missed + f.refused + f.held > 0;
    case "notes": return f.flagged > 0;
    default: return false;
  }
}

/** Clinical weight (DECIDED): deterioration, then missed medicines, then abnormal vitals, results, consults, orders, the rest. */
export function weightOf(f: Fact): number {
  switch (f.kind) {
    case "ews": return isAbnormal(f) ? 100 : f.from !== null && f.from !== f.to ? 42 : 12;
    case "emar_exceptions": return isAbnormal(f) ? 90 : 11;
    case "vital": return f.abnormal ? 80 : 10;
    case "notes": return f.flagged > 0 ? 75 : 30;
    case "results": return 70;
    case "consults": return 60;
    case "orders_new": return 56;
    case "orders_stopped": return 55;
    case "npo": return 52;
    case "diet": return 50;
    case "emar_prn": return 45;
    case "io": return 35;
    case "rounds_other": return 20;
    case "orders_active": return 9;
  }
}

/** THE ONE PLACE A FACT BECOMES WORDS. Every number printed here is a field of the fact, which is a count or a value of rows. */
export function renderLine(f: Fact): string {
  switch (f.kind) {
    case "vital": {
      const w = VITAL_WORDS[f.param];
      if (!f.abnormal) return `No change: ${w.name} in range — max ${shown(f.max)}${w.unit}, min ${shown(f.min)}${w.unit} over ${plural(f.count, "reading", "readings")}`;
      return `${w.name} max ${shown(f.max)}${w.unit}, min ${shown(f.min)}${w.unit}, latest ${shown(f.latest)}${w.unit} over ${plural(f.count, "reading", "readings")}`;
    }
    case "ews": {
      const word = SCORE_WORDS[f.scoreKind];
      const tail = `latest ${shown(f.latestValue)} at ${f.latestAt}`;
      if (BAND_RANK[f.peak] >= BAND_RANK.medium && BAND_RANK[f.peak] > BAND_RANK[f.to] && (f.from === null || BAND_RANK[f.peak] > BAND_RANK[f.from])) {
        return `${word} reached ${BAND_WORDS[f.peak]} (${shown(f.peakValue)} at ${f.peakAt}), now ${BAND_WORDS[f.to]} — ${tail}`;
      }
      if (f.from === null || f.from === f.to) {
        return BAND_RANK[f.to] >= BAND_RANK.medium ? `${word} stays ${BAND_WORDS[f.to]} — ${tail}` : `No change: ${word} ${BAND_WORDS[f.to]} — ${tail}`;
      }
      return BAND_RANK[f.to] > BAND_RANK[f.from]
        ? `${word} rose from ${BAND_WORDS[f.from]} to ${BAND_WORDS[f.to]} — ${tail}`
        : `${word} fell from ${BAND_WORDS[f.from]} to ${BAND_WORDS[f.to]} — ${tail}`;
    }
    case "emar_exceptions": {
      if (f.missed + f.refused + f.held === 0) return `No change: no missed, refused or held doses — ${shown(f.given)} given`;
      const parts = [
        f.missed > 0 ? `${shown(f.missed)} missed` : "", f.refused > 0 ? `${shown(f.refused)} refused` : "", f.held > 0 ? `${shown(f.held)} held` : "",
      ].filter((p) => p !== "");
      return `Doses: ${parts.join(", ")}; ${shown(f.given)} given${named(f.terms)}`;
    }
    case "emar_prn": return `PRN medicine given ${plural(f.count, "time", "times")}${named(f.terms)}`;
    case "orders_new": return `${plural(f.count, "new order", "new orders")}${named(f.terms)}`;
    case "orders_stopped": return `${plural(f.count, "order stopped", "orders stopped")}${named(f.terms)}`;
    case "orders_active": return `No change to orders — ${shown(f.count)} active`;
    case "results": return `${plural(f.count, f.department === "lab" ? "lab result reported" : "imaging report ready", f.department === "lab" ? "lab results reported" : "imaging reports ready")}${named(f.terms)}`;
    case "notes": return f.flagged > 0
      ? `${plural(f.count, "nursing note", "nursing notes")}, ${shown(f.flagged)} flagged`
      : `${plural(f.count, "nursing note", "nursing notes")}, none flagged`;
    case "io": return `Intake ${shown(f.inMl)} ml, output ${shown(f.outMl)} ml, balance ${f.balanceMl > 0 ? "+" : ""}${shown(f.balanceMl)} ml`;
    case "consults": {
      const parts = [f.asked > 0 ? `${shown(f.asked)} asked` : "", f.answered > 0 ? `${shown(f.answered)} answered` : ""].filter((p) => p !== "");
      return `Consults: ${parts.join(", ")}`;
    }
    case "npo": return `NPO since ${f.since}`;
    case "diet": return `Diet changed to ${f.code.replace(/_/g, " ")}`;
    case "rounds_other": return `${plural(f.count, "round", "rounds")} by another doctor`;
  }
}

export const SINCE_MAX_LINES = 6;
export const SINCE_MIN_LINES = 4;

/**
 * Four to six lines, abnormal first, then by weight (DECIDED). A quiet patient's facts render as "No change" lines; with
 * nothing recorded at all the one line says so (its fact carries no number).
 */
export function chooseLines(facts: readonly Fact[]): Line[] {
  const all = facts.map((f): Line => ({ key: f.key, text: renderLine(f), source: f.source, abnormal: isAbnormal(f), weight: weightOf(f), fact: f }));
  all.sort((a, b) => Number(b.abnormal) - Number(a.abnormal) || b.weight - a.weight || a.key.localeCompare(b.key));
  return all.slice(0, SINCE_MAX_LINES);
}

// ═══════════════════════════════════════════ the verifier ═══════════════════════════════════════════

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  once: 1, twice: 2, thrice: 3, couple: 2, both: 2, single: 1, double: 2, half: 0.5, dozen: 12,
};
const DEVANAGARI_ZERO = 0x0966;

export type Quantities = { numbers: number[]; times: string[] };

/**
 * Every quantity a piece of text states: digits (with a decimal point, and a sign when one leads the number), number
 * words ("two", "twice"), Devanagari digits, and clock times. "NEWS2", "SpO2" and "O2" are names, not numbers.
 */
export function quantitiesIn(text: string): Quantities {
  let s = text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO)).replace(/−/g, "-");
  s = s.replace(/\b(NEWS2|SpO2|O2)\b/gi, " ");
  const times: string[] = [];
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h: string, m: string) => { times.push(`${h.padStart(2, "0")}:${m}`); return " "; });
  const numbers: number[] = [];
  for (const m of s.matchAll(/(^|[\s(])([-+])?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)/g)) {
    const digits = m[3] ?? m[4]!;
    numbers.push(Number(m[2] === "-" ? `-${digits}` : digits));
  }
  for (const w of s.toLowerCase().matchAll(/[a-z]+/g)) {
    const n = WORD_NUMBERS[w[0]];
    if (n !== undefined) numbers.push(n);
  }
  return { numbers, times };
}

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const within = (n: number, set: readonly number[]): boolean => set.some((x) => same(x, n));

/** Guarded words: a rewording must carry exactly the classes its template line carries (negation, direction, outcome). */
const GUARDED: readonly (readonly [string, RegExp])[] = [
  ["neg", /\b(no|not|none|nil|without|never|neither|nor|zero)\b|n't\b/i],
  ["max", /\b(max|maximum|peak|peaked|highest|high of)\b/i],
  // "/min" is a unit, not a minimum.
  ["min", /(?<!\/)\b(min|minimum|lowest|low of|nadir)\b/i],
  ["up", /\b(rose|risen|rising|rise|increased|increase|up|worse|worsened|climbed|higher)\b/i],
  ["down", /\b(fell|fallen|falling|fall|decreased|decrease|down|settled|improved|dropped|lower)\b/i],
  ["missed", /\b(missed|miss|omitted|skipped)\b/i],
  ["refused", /\b(refused|refusal|declined)\b/i],
  ["held", /\b(held|hold|withheld)\b/i],
  ["given", /\b(given|gave|administered|received|taken)\b/i],
  ["stopped", /\b(stopped|stop|discontinued|ceased)\b/i],
  ["new", /\b(new|started|added|begun|commenced)\b/i],
  ["change", /\b(change|changed|unchanged|stable|same|stays|steady)\b/i],
  ["flagged", /\b(flagged|flag|concern|concerns)\b/i],
];
const guardedOf = (text: string): string => GUARDED.filter(([, re]) => re.test(text)).map(([k]) => k).join(",");

const MONEY_RE = /₹|\brs\.?\s*\d|\brupees?\b|\bpaise\b|\bINR\b|\bbill\b|\bcharges?\b|\bdeposit\b|\bpayment\b/i;
/** Words that would turn a summary into a proposal (autonomy ladder: doses and orders — None, ever). */
const PROPOSAL_RE = /\b(start|give|increase|decrease|reduce|stop|administer|prescribe|consider|recommend|recommended|suggest|suggested|should|must|advise|titrate|switch to|add)\b/i;

export const REWORD_MAX_CHARS = 200;

const flat = (s: string): string => s.toLowerCase().replace(/\u2212/g, "-").replace(/\s+/g, " ").trim();

/**
 * THE PHRASES THAT BIND A NUMBER TO WHAT IT COUNTS. A template line is cut at its punctuation; in each piece, every
 * token that states a quantity is taken with the word before it and the word after it ("max 38.9 °C", "2 missed",
 * "at 12:30", "over 6 readings"). A rewording must carry each of these as written — so a model can move a clause or
 * change the words around it, but it cannot hand "2 missed, 9 given" back as "2 given, 9 missed".
 */
export function boundPhrases(templateText: string): string[] {
  const out: string[] = [];
  for (const piece of templateText.split(/[,;—()]|:\s/)) {
    const tokens = piece.trim().split(/\s+/).filter((t) => t !== "");
    tokens.forEach((tok, i) => {
      const q = quantitiesIn(tok);
      if (q.numbers.length + q.times.length === 0) return;
      out.push(flat([tokens[i - 1], tok, tokens[i + 1]].filter((t) => t !== undefined).join(" ")));
    });
  }
  return out;
}

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });

/**
 * MAY THIS REWORDING REPLACE ITS TEMPLATE LINE? Only when it says the same quantities about the same records:
 *  - every number and clock time in it is one the FACT carries (a wrong or invented number is refused);
 *  - it states exactly the numbers and times the template line states (none dropped, none borrowed from the fact's others);
 *  - each number still sits in the template's own phrase for it (`boundPhrases`): no number moved to another label;
 *  - every drug or test name the template printed is still there;
 *  - its guarded words are the template's (no added or lost negation, direction or outcome);
 *  - it is one short line with no money word and no placeholder.
 */
export function verifyReworded(text: string, line: Pick<Line, "text" | "fact">): Verdict {
  const t = text.trim();
  if (t === "" || t.length > REWORD_MAX_CHARS || /[\r\n]/.test(t)) return no("shape");
  if (MONEY_RE.test(t)) return no("money");
  if (t.includes("<<") || t.includes(">>")) return no("placeholder");
  const said = quantitiesIn(t);
  for (const n of said.numbers) if (!within(n, line.fact.numbers)) return no(`number_not_in_record:${String(n)}`);
  for (const c of said.times) if (!line.fact.times.includes(c)) return no(`time_not_in_record:${c}`);
  const template = quantitiesIn(line.text);
  const sort = (xs: readonly number[]): string => [...xs].sort((a, b) => a - b).map((n) => String(n)).join(",");
  if (sort(said.numbers) !== sort(template.numbers)) return no("numbers_differ_from_line");
  if ([...said.times].sort().join(",") !== [...template.times].sort().join(",")) return no("times_differ_from_line");
  const flatText = flat(t);
  for (const phrase of boundPhrases(line.text)) if (!flatText.includes(phrase)) return no("number_moved");
  const lower = t.toLowerCase();
  for (const term of line.fact.terms) {
    if (line.text.includes(term) && !lower.includes(term.toLowerCase())) return no("name_dropped");
  }
  if (guardedOf(t) !== guardedOf(line.text)) return no("meaning_words_differ");
  return { ok: true };
}

export const FREE_TEXT_MAX_CHARS = 1200;

/**
 * MAY THIS FREE TEXT STAND IN A DRAFT? It summarises `sources` (the masked notes it was given) and nothing else: every
 * number and time in it must already be in them or in `allowed` (the facts' numbers); no proposal, no money, no placeholder.
 * Medicine names are checked by the caller against the stay's orders (it needs the formulary).
 */
export function verifyFreeText(text: string, sources: readonly string[], allowed: Quantities = { numbers: [], times: [] }, maxChars = FREE_TEXT_MAX_CHARS): Verdict {
  const t = text.trim();
  if (t === "" || t.length > maxChars) return no("shape");
  if (MONEY_RE.test(t)) return no("money");
  if (t.includes("<<") || t.includes(">>")) return no("placeholder");
  if (PROPOSAL_RE.test(t)) return no("proposal");
  const known = sources.map((s) => quantitiesIn(s));
  const numbers = [...allowed.numbers, ...known.flatMap((k) => k.numbers)];
  const times = [...allowed.times, ...known.flatMap((k) => k.times)];
  const said = quantitiesIn(t);
  for (const n of said.numbers) if (!within(n, numbers)) return no(`number_not_in_record:${String(n)}`);
  for (const c of said.times) if (!times.includes(c)) return no(`time_not_in_record:${c}`);
  return { ok: true };
}

/** Lower-cased words of four letters or more — what a medicine-name check compares. */
export function wordsOf(text: string): string[] {
  return [...new Set([...text.toLowerCase().matchAll(/[a-z][a-z-]{3,}/g)].map((m) => m[0]))];
}

/**
 * Put the model's accepted rewordings onto the template lines. The model may reorder, but an abnormal line always comes
 * before a line that is not (the safety ordering is the template's, never the model's); a line the model dropped keeps
 * its template words and its place after the ones the model placed.
 */
export function applyRewordings(lines: readonly Line[], reworded: readonly { key: string; text: string }[]): { lines: (Line & { by: "template" | "model" })[]; accepted: number; rejected: { key: string; reason: string }[] } {
  const byKey = new Map(lines.map((l) => [l.key, l] as const));
  const out: (Line & { by: "template" | "model" })[] = [];
  const rejected: { key: string; reason: string }[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  for (const r of reworded) {
    const line = byKey.get(r.key);
    if (line === undefined || seen.has(r.key)) { rejected.push({ key: r.key, reason: line === undefined ? "unknown_line" : "repeated_line" }); continue; }
    seen.add(r.key);
    const verdict = verifyReworded(r.text, line);
    if (verdict.ok) { out.push({ ...line, text: r.text.trim(), by: "model" }); accepted += 1; } else { out.push({ ...line, by: "template" }); rejected.push({ key: r.key, reason: verdict.reason }); }
  }
  for (const l of lines) if (!seen.has(l.key)) out.push({ ...l, by: "template" });
  const order = new Map(out.map((l, i) => [l.key, i] as const));
  out.sort((a, b) => Number(b.abnormal) - Number(a.abnormal) || order.get(a.key)! - order.get(b.key)!);
  return { lines: out, accepted, rejected };
}
