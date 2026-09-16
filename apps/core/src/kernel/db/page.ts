import { PAGE_CURSOR_MAX, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@hmis/contracts";

/**
 * ═══ KEYSET PAGING — THE HOUSE'S FIRST ROW-PAGINATION PRECEDENT, SO THE LAWS ARE WRITTEN DOWN ═══
 *
 * Until this file nothing in `apps/core/src/modules` paged a list. `grep -rn "offset(\|cursor"`
 * over the modules returns prose comments and one event-stream cursor, and no row pagination at
 * all. `radiology/read.ts` records the house position in as many words — "200 live studies loses
 * the tail of the list, and the honest fix is a cursor" — so this is that fix, and whatever shape
 * it takes here is the shape the next list will copy. Hence the laws.
 *
 * ── LAW 1. THE CURSOR CARRIES A ROW'S ID, NEVER ITS SORT VALUE. ORDER BY `(sort expression, id)`.
 *
 * The first version of this file cursored on the sort VALUE — `lower(brand_name)` — and it was
 * wrong twice, both found by review and both measured:
 *
 *   1. AN UNBOUNDED CURSOR. `brand_name` is `text`, and the national release really does carry long
 *      ones: the loaded catalogue has two rows of 384 and 413 bytes, which encode to cursors of 523
 *      and 562 characters. `pageQuery` caps `cursor` at 512, so the server ISSUED A CURSOR ITS OWN
 *      SCHEMA THEN REFUSED — a 400, mid-walk, that no client could recover from.
 *   2. TWO DIFFERENT `lower()`s. The ORDER BY used Postgres `lower()`; the cursor was built with
 *      JavaScript `toLowerCase()`. They are not the same function. Measured: `İ` (U+0130) lowers to
 *      `i` in Postgres and to `i` + U+0307 in JavaScript. Where they differ the cursor does not
 *      equal the row's own sort position, and the next page's `>` SKIPS the rows in between —
 *      silently, with no error anywhere. (Zero of the 103,383 loaded brand names trip it today, and
 *      a control proved the probe could see the difference, so that zero is a fact about the data
 *      and not about the test.)
 *
 * An id fixes both by construction: it is bounded (a ULID, 26 characters), it is immutable, and it
 * is never lowercased by anybody. The predicate becomes a tuple comparison against the cursor row's
 * own values, read back in SQL, so the sort expression is evaluated by ONE engine — the database —
 * and never reproduced in TypeScript. `(sort, id)` is also unique whether or not the sort
 * expression is, which removes the uniqueness precondition entirely.
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

/**
 * The cursor must fit the bound the REQUEST side enforces. Asserted here rather than discovered on
 * the next request, because the failure it prevents is the server refusing a cursor it issued
 * itself — which is not a thing a client can do anything about, and which cost this file its first
 * design. With an id cursor it cannot fire; the assertion is what keeps that true if somebody ever
 * cursors on something longer again.
 */
export function encodeCursor(rowId: string): string {
  const cursor = Buffer.from(JSON.stringify([CURSOR_VERSION, rowId]), "utf8").toString("base64url");
  if (cursor.length > PAGE_CURSOR_MAX) {
    throw new Error(
      `a cursor of ${String(cursor.length)} characters exceeds the ${String(PAGE_CURSOR_MAX)} a request may carry `
      + `(row id ${JSON.stringify(rowId.slice(0, 40))}) — cursor on a bounded key`,
    );
  }
  return cursor;
}

/** `null`/absent means "start at the beginning". Anything else must decode, or it throws. Returns
 *  the ROW ID the caller should page after. */
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
export function finishPage<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  // `rows.length > limit >= 1`, so `items` is non-empty and `last` is defined.
  return { items, nextCursor: encodeCursor(idOf(last as T)) };
}
