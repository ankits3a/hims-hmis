/**
 * PLAN 11h T1 — THE WIRE SHAPE OF A SEARCH ANSWER, defined once and shared.
 *
 * It lives in `contracts` rather than in the core because BOTH SIDES PARSE (plan DD2): the palette
 * parses to render chips, and the route re-parses the raw string to execute. A second copy of
 * "what a hit is" on the web side would drift from this one by construction — §2.54's class.
 */

/**
 * The entity classes a provider may declare. A new module EXTENDS THIS UNION and registers a
 * provider on its own manifest; it never edits the route (plan DD1).
 */
export type SearchEntity =
  | "patient"
  | "doctor"
  | "department"
  | "appointment"
  | "invoice"
  | "service"
  | "approval"
  | "user"
  | "room"
  | "command";

/** A resolved entity scope — `@doctor Mehra` once it has become an id rather than text (DD2). */
export type SearchChip = { entity: SearchEntity; id: string; label: string };

/**
 * A parsed query. T1 populates `raw`, `text` and `limit`; `chips` and `range` stay empty until
 * T8's grammar lands — DECLARED NOW so every provider written between here and there already
 * accepts them and no provider signature changes later.
 */
export type SearchQuery = {
  /** Exactly what was typed. Providers must read `text`, never re-parse this. */
  raw: string;
  /** Free text with chips and date words removed. */
  text: string;
  chips: SearchChip[];
  /** Inclusive ISO dates when the query named a period ("today", "last week"). */
  range?: { from: string; to: string };
  /** Entity classes a bare `@dept` narrowed the fan-out to. */
  entities?: SearchEntity[];
  limit: number;
};

/**
 * ONE hit, deliberately thin. `title`/`subtitle` are what the palette renders and `href` is where
 * Enter goes. `meta` is DISPLAY-ONLY STRINGS — the palette never computes with it, because money
 * arithmetic belongs on the server and a formatted paise string is not a number.
 */
export type SearchHit = {
  entity: SearchEntity;
  id: string;
  title: string;
  subtitle?: string;
  meta?: Record<string, string>;
  href?: string;
  /**
   * DD3's RESTRICTED class: a record the caller may know exists but not open, rendered as a stub
   * carrying the reason and — where the record admits one — a break-glass route in.
   *
   * THE SEALED CLASS HAS NO REPRESENTATION HERE, AND THAT IS THE POINT. A confidential record the
   * caller may not read is absent from `hits`, absent from `total`, and absent from the ordering.
   * A field for it — even an empty one — would be the leak.
   */
  restricted?: { reason: string; breakGlass: boolean };
};

export type SearchGroup = {
  entity: SearchEntity;
  /** The provider's stable key, `<module>.<entity>` — echoed into the audit row (T5). */
  provider: string;
  hits: SearchHit[];
  /** What the provider would have returned uncapped. Never counts sealed rows (DD3). */
  total: number;
  /** The provider outran its budget: this group is INCOMPLETE, which is not the same as empty. */
  timedOut: boolean;
  /** The provider threw. Also incomplete, and distinguishable from slow so a bug cannot hide. */
  errored: boolean;
};

export type SearchResponse = {
  groups: SearchGroup[];
  tookMs: number;
  /**
   * Providers the caller holds no permission for, by key. This is MODULE-level, never
   * record-level: it tells the palette to say "you cannot search invoices", and it reveals
   * nothing about whether any invoice matched — the provider never ran.
   */
  skipped: string[];
};

/**
 * PLAN 11h T8 — THE GRAMMAR. One parser, in `contracts`, because BOTH SIDES PARSE: the palette
 * parses to render chips, and the route re-parses the raw string to execute. The server never
 * trusts the client's parse — it re-derives it from the same text.
 *
 * ═══ A RESOLVED CHIP IS PART OF THE STRING ═══
 * `@doctor:01J...` is a chip; `@doctor` alone is a narrowing. That is deliberate: keeping the
 * resolved id INSIDE the raw query means the query string stays the single source of truth, a
 * palette URL can be shared or restored, and the server needs no second channel to learn what the
 * user picked. The UI renders `@doctor:<id>` as a labelled chip; the wire carries one string.
 *
 * ═══ DATE WORDS ARE NOT NATURAL LANGUAGE ═══
 * `today`, `yesterday`, `this week`, `last week` and their Hindi forms resolve to a date range
 * with no model involved. This is the large majority of what reads as "natural language" at a
 * desk, and it costs a lookup table (plan DD2 / DD10 — the deterministic lane comes first, and for
 * most queries it is the only lane needed).
 */

const CHIP_RE = /@([a-z_]+):([A-Za-z0-9_-]+)/g;
const BARE_RE = /@([a-z_]+)(?![:\w])/g;

/** Aliases a desk actually types. `@dr` and `@doctor` are the same thing. */
const ENTITY_ALIASES: Record<string, SearchEntity> = {
  p: "patient", patient: "patient",
  dr: "doctor", doctor: "doctor",
  dept: "department", department: "department",
  appt: "appointment", appointment: "appointment",
  bill: "invoice", invoice: "invoice",
  service: "service",
  approval: "approval",
  staff: "user", user: "user",
  room: "room",
};

/** IST calendar date for an instant — the hospital's day, not UTC's. */
function istDate(at: Date, addDays = 0): string {
  const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000 + addDays * 24 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/**
 * UNICODE-AWARE BOUNDARIES, NOT `\b`.
 *
 * MEASURED: `/\b(today|आज)\b/` never matches the Hindi word. JavaScript's `\b` is defined on
 * ASCII word characters, so a Devanagari string has no word boundary anywhere in it and the
 * alternative is dead on arrival — silently, because the English half still worked and the test
 * that caught it was the bilingual one. Lookarounds on letter-or-digit with the `u` flag behave
 * the same way for both scripts.
 */
const boundary = (words: string[]): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");

const DATE_WORDS: { pattern: RegExp; range: (now: Date) => { from: string; to: string } }[] = [
  // Order matters: the two-word forms are tried before the one-word forms they contain.
  { pattern: boundary(["this week", "इस सप्ताह"]), range: (n) => ({ from: istDate(n, -6), to: istDate(n) }) },
  { pattern: boundary(["last week", "पिछले सप्ताह"]), range: (n) => ({ from: istDate(n, -13), to: istDate(n, -7) }) },
  { pattern: boundary(["today", "आज"]), range: (n) => ({ from: istDate(n), to: istDate(n) }) },
  { pattern: boundary(["yesterday", "कल"]), range: (n) => ({ from: istDate(n, -1), to: istDate(n, -1) }) },
];

export type ParseOptions = { now?: Date; labels?: Record<string, string> };

/**
 * Raw text in, a `SearchQuery` out. Callers and provider signatures are unchanged from T1 — this
 * fills in the `chips`, `range` and `entities` the shape already declared.
 */
export function parseSearchQuery(raw: string, limit: number, opts: ParseOptions = {}): SearchQuery {
  const now = opts.now ?? new Date();
  let rest = raw;

  const chips: SearchChip[] = [];
  for (const m of raw.matchAll(CHIP_RE)) {
    const entity = ENTITY_ALIASES[m[1]!.toLowerCase()];
    if (entity === undefined) continue; // an unknown @word is just text, never an error
    chips.push({ entity, id: m[2]!, label: opts.labels?.[m[2]!] ?? m[2]! });
    rest = rest.replace(m[0], " ");
  }

  const entities: SearchEntity[] = [];
  for (const m of rest.matchAll(BARE_RE)) {
    const entity = ENTITY_ALIASES[m[1]!.toLowerCase()];
    if (entity === undefined) continue;
    if (!entities.includes(entity)) entities.push(entity);
    rest = rest.replace(m[0], " ");
  }

  let range: { from: string; to: string } | undefined;
  for (const { pattern, range: mk } of DATE_WORDS) {
    // Longest first would be cleaner; instead the list is ordered so "this week" is tried before
    // "week" could ever be a word on its own — there is no bare "week" pattern, deliberately.
    const found = rest.match(pattern);
    if (found !== null) {
      range = mk(now);
      rest = rest.replace(pattern, " ");
      break;
    }
  }

  return {
    raw,
    text: rest.replace(/\s+/g, " ").trim(),
    chips,
    ...(range === undefined ? {} : { range }),
    ...(entities.length === 0 ? {} : { entities }),
    limit,
  };
}

/** Render a resolved chip back into the query string the parser reads. */
export function chipToken(entity: SearchEntity, id: string): string {
  const alias = Object.entries(ENTITY_ALIASES).find(([, e]) => e === entity)?.[0] ?? entity;
  return `@${alias}:${id}`;
}
