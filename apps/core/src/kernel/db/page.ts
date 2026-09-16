import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@hmis/contracts";

/**
 * ═══ KEYSET PAGING — THE HOUSE'S FIRST ROW-PAGINATION PRECEDENT, SO THE LAWS ARE WRITTEN DOWN ═══
 *
 * Until this file nothing in `apps/core/src/modules` paged a list. `grep -rn "offset(\|cursor"`
 * over the modules returns prose comments and one event-stream cursor, and no row pagination at
 * all. `radiology/read.ts` records the house position in as many words — "200 live studies loses
 * the tail of the list, and the honest fix is a cursor" — so this is that fix, and whatever shape
 * it takes here is the shape the next list will copy. Hence the laws.
 *
 * ── LAW 1. ORDER ASCENDING ON A UNIQUE EXPRESSION, AND THE CURSOR IS THAT VALUE.
 *
 * No composite tiebreak, because there is nothing to break: every list paged through here sorts on
 * a column the schema already makes unique — `formulary_medicines_brand_lower_ux` on
 * `lower(brand_name)`, `formulary_salts_name_lower_ux` on `lower(name)`, or a primary key. A
 * non-unique sort key needs `(value, id) > (cursorValue, cursorId)` and this helper does not
 * pretend to offer it; the next author who needs one should add it deliberately rather than
 * discover its absence.
 *
 * ── LAW 2. OVER-FETCH BY ONE. `finishPage` IS THE ONLY PLACE `nextCursor` IS PRODUCED.
 *
 * Ask the database for `limit + 1` rows; if it returns them all there is another page. NEVER derive
 * "there is more" from `items.length === limit`, which is the obvious thing and is wrong on a last
 * page that happens to be exactly full: the client is handed a cursor, follows it, gets nothing,
 * and — depending on how it handles empty — either shows a blank page or loops.
 *
 * ── LAW 3. FORWARD ONLY.
 *
 * There is no `prevCursor` and there will not be one. A Back button is the client keeping a stack
 * of the cursors it has already used, which it can do perfectly and the server cannot.
 *
 * ── LAW 4. A ROW RENAMED MID-PAGINATION MAY BE SEEN TWICE OR MISSED, AND THAT IS DISCLOSED.
 *
 * `pageMedicines` and `pageSalts` sort on a MUTABLE name, because that is the order a human reads
 * in. Rename a medicine from "Zyrtec" to "Alerid" while a pharmacist is on page 4 and it moves
 * behind them. Sorting on the immutable id instead would fix it and make the list unreadable. This
 * is a paged admin list, not a ledger; the trade is taken knowingly and written here rather than
 * discovered by somebody counting rows.
 *
 * ── AND THE LAW THAT IS A REFUSAL: `decodeCursor` THROWS. IT NEVER FALLS BACK TO PAGE ONE.
 *
 * A malformed cursor means the client and the server disagree about what a cursor is. Answering
 * page one is the friendly-looking response and it is the dangerous one: the client believes it
 * advanced, asks for the next page, is given page two, and pages the same three screens for ever
 * without an error anywhere. A 400 is the honest answer and the only one that terminates.
 */

export type Page<T> = { items: T[]; nextCursor: string | null };

export type PageRequest = { limit?: number; cursor?: string | null };

/** A cursor the caller could not have produced. Controllers map it to 400, never to 500. */
export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

/** Clamp to `[1, PAGE_LIMIT_MAX]`, defaulting when absent. See `pageQuery` for why it clamps. */
export function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return PAGE_LIMIT_DEFAULT;
  return Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.trunc(requested)));
}

/**
 * Cursors are versioned from the first one ever issued. A cursor is a fact about the server's
 * paging scheme held by a client that may reload days later; without a version, changing the
 * scheme makes old cursors decode to plausible nonsense instead of refusing.
 */
const CURSOR_VERSION = "1";

export function encodeCursor(sortValue: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, sortValue]), "utf8").toString("base64url");
}

/** `null`/absent means "start at the beginning". Anything else must decode, or it throws. */
export function decodeCursor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("that cursor is not readable — start the list again");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new CursorError("that cursor is not readable — start the list again");
  }
  const [version, value] = parsed as unknown[];
  if (version !== CURSOR_VERSION) {
    throw new CursorError(`that cursor was issued by an older list (v${String(version)}) — start the list again`);
  }
  if (typeof value !== "string") {
    throw new CursorError("that cursor is not readable — start the list again");
  }
  return value;
}

/**
 * Turn `limit + 1` rows into a page of at most `limit`, plus the cursor for the next one.
 *
 * LAW 2 LIVES HERE AND NOWHERE ELSE. Every paged reader must fetch `limit + 1` and hand the result
 * to this function; a reader that fetches `limit` and calls this will simply always report itself
 * as the last page, which is the failure this centralisation exists to make impossible to write
 * twice.
 */
export function finishPage<T>(rows: T[], limit: number, sortValueOf: (row: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  // `rows.length > limit >= 1`, so `items` is non-empty and `last` is defined.
  return { items, nextCursor: encodeCursor(sortValueOf(last as T)) };
}
