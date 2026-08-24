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
 * T1's parse: raw text in, a `SearchQuery` out, with no grammar yet.
 *
 * IT IS DEFINED HERE, IN ITS FINAL HOME, RATHER THAN IN THE CORE. T8 replaces this body with the
 * `@entity` grammar and the date words; every caller and every provider signature stays exactly as
 * it is, because they already take the shape the grammar will fill in. Putting a temporary parse
 * in the core and a real one here later would have meant two homes for one fact for the length of
 * one phase — which is how §2.54's class starts.
 */
export function parseSearchQuery(raw: string, limit: number): SearchQuery {
  return { raw, text: raw.trim(), chips: [], limit };
}
