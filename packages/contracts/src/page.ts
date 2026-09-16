import { z } from "zod";

/**
 * ═══ THE WIRE SHAPE OF A PAGED LIST ═══
 *
 * Shared because the client must not re-derive "is there more" from the row count — see the four
 * laws in `apps/core/src/kernel/db/page.ts`, of which this file is the half both sides can see.
 */

/** What a caller gets when it names no limit — enough to fill a screen, small enough to be cheap. */
export const PAGE_LIMIT_DEFAULT = 50;

/** The most any caller may take in one page, however large a number it asks for. */
export const PAGE_LIMIT_MAX = 200;

/**
 * `limit` is CLAMPED, not rejected, which is the ruling `suggestQuery` already carries one file
 * over: "a typeahead that 400s on a stray query parameter is a prescribing screen that stops
 * working for a reason the doctor cannot see". A caller asking for 10,000 gets `PAGE_LIMIT_MAX`.
 *
 * A NON-NUMERIC limit is still a 400 — that is malformed, not oversized, and the difference is
 * the difference between a client with a bug and a client with an opinion.
 */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

export type PageQuery = z.infer<typeof pageQuery>;

/**
 * `nextCursor` is `null` on the last page and a string otherwise. A client follows it until it is
 * null and never infers the end from `items.length` — a full last page would then be followed for
 * ever.
 */
export type WirePage<T> = { items: T[]; nextCursor: string | null };
