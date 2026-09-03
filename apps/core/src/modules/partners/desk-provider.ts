import { and, count, gte, sql } from "drizzle-orm";
import { attributionIds } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import type { DeskProvider } from "../../kernel/desk/types";

/**
 * ═══ FD-11 — "ATTRIBUTED", THE FIFTH SCHEME TILE ═══
 *
 * The last of the five counts the owner asked to be made real. It lives here, beside the table it
 * reads, rather than in a dashboard endpoint that reaches across three schemas — the same rule the
 * other four follow.
 *
 * `partners.attribution.issue` is the gate: the permission that lets somebody put a partner's slip
 * against a visit is the permission that may be told how many were put today. A front-desk clerk
 * without it simply has no such tile, which is right — attribution is a commercial fact and the
 * clerk who cannot record one has no use for the count.
 *
 * `issued_at` inside THIS IST day, and `state` is deliberately not filtered: an attribution that was
 * later voided was still issued today, and the tile says how much attribution work the desk did, not
 * how much of it survived. A number that quietly drops voided rows would disagree with the partner
 * ledger for reasons nobody could reconstruct from the screen.
 */
export const partnersAttributionDeskProvider: DeskProvider = {
  key: "partners.attribution",
  permission: "partners.attribution.issue",
  load: async (ctx) => {
    const day = istDayWindow(new Date(`${ctx.date}T00:00:00+05:30`));
    const rows = await ctx.db
      .select({ n: count() })
      .from(attributionIds)
      .where(and(gte(attributionIds.issuedAt, day.start), sql`${attributionIds.issuedAt} < ${day.end}`));
    return [{
      key: "partners.attribution",
      band: "today",
      titleKey: "desk.schemes.title",
      stats: [{ key: "desk.schemes.partners.n", value: String(rows[0]?.n ?? 0), href: "/counter" }],
    }];
  },
};
