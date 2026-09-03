import { and, count, eq, gte, lte, ne, sql } from "drizzle-orm";
import { couponRedemptions, entitlementCounters, membershipInstances } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import type { DeskCard, DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — "SCHEMES IN PLAY", AND THE COUNTS ARE REAL OR THEY ARE NOT THERE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's dashboard artboard puts a band of scheme tiles under the doors, each carrying a
 * number, and its note gives the reason they belong on the FIRST screen rather than in the bill:
 * *"a scheme is a thing a PATIENT arrives holding — a card, a coupon, an employer, a camp slip — so
 * the clerk needs to know it exists before the money screen, not after."*
 *
 * The tiles shipped without numbers in the first cut, deliberately: five counts across five modules
 * is five endpoints, and this codebase's standing rule — the artboard's own — is that a plausible
 * number at a cash counter is the worst kind. The owner then asked for the real ones. This is
 * membership's three of the five; billing owns the panel count and partners owns attribution, and
 * each emits its own beside its own permission rather than one module reaching into three schemas.
 *
 * ═══ THIS PROVIDER IS HOSPITAL-SCOPED, AND THAT IS NOT A DEVIATION ═══
 *
 * Most providers filter on `ctx.actor` — "whose day this is". These three do not, and `opd.hall` is
 * the precedent: waiting counts and open sessions are the BUILDING's state, not one clerk's. A
 * membership card is in force whoever looks at it. "Cards I personally saw today" would be a
 * different and much less useful number: the clerk needs to know the scheme exists at this hospital
 * before they can think to ask the patient for it.
 *
 * ═══ WHAT EACH ONE ACTUALLY COUNTS ═══
 *
 * Named for what the SQL does, because a tile that says "4" over a word the query does not mean is
 * the same lie as an invented number:
 *
 *   · cards      — instances `active` AND inside their own validity window right now. An expired
 *                  card is not in play, and `status` alone would count it.
 *   · coupons    — redemptions in the `redeemed` state whose `at` falls inside THIS IST DAY. A
 *                  released one is explicitly excluded: it was presented and then given back.
 *   · packages   — entitlement counters `active` and in force now. An entitlement is what a paid
 *                  package actually IS once it is sold — the thing that draws down.
 */

/*
 * The kernel's own IST day, given the desk's date rather than "now" — a supervisor's drill reads
 * another day and a window derived from `Date.now()` would silently answer for today. Transcribed
 * from `patients/desk-provider.ts:windowFor`, which solves the same problem the same way.
 */
function dayWindow(date: string): { from: Date; to: Date } {
  const day = istDayWindow(new Date(`${date}T00:00:00+05:30`));
  return { from: day.start, to: day.end };
}

async function schemesCard(ctx: DeskProviderCtx): Promise<DeskCard> {
  const { from, to } = dayWindow(ctx.date);
  const now = ctx.now;

  const [cards, coupons, packages] = await Promise.all([
    ctx.db
      .select({ n: count() })
      .from(membershipInstances)
      .where(and(
        eq(membershipInstances.status, "active"),
        lte(membershipInstances.validFrom, now),
        gte(membershipInstances.validTo, now),
      )),
    ctx.db
      .select({ n: count() })
      .from(couponRedemptions)
      .where(and(
        eq(couponRedemptions.state, "redeemed"),
        gte(couponRedemptions.at, from),
        sql`${couponRedemptions.at} < ${to}`,
      )),
    ctx.db
      .select({ n: count() })
      .from(entitlementCounters)
      .where(and(
        ne(entitlementCounters.state, "expired"),
        lte(entitlementCounters.validFrom, now),
        gte(entitlementCounters.validTo, now),
      )),
  ]);

  return {
    key: "membership.schemes",
    band: "today",
    titleKey: "desk.schemes.title",
    stats: [
      /*
        `href` is `/counter` on all three and that is the point of the band: a scheme tile is a DOOR
        to the desk where the scheme gets attached to the patient in hand, not a statistic. A number
        nobody can open is decoration (T4 A2).
      */
      { key: "desk.schemes.membership.n", value: String(cards[0]?.n ?? 0), href: "/counter" },
      { key: "desk.schemes.coupons.n", value: String(coupons[0]?.n ?? 0), href: "/counter" },
      { key: "desk.schemes.packages.n", value: String(packages[0]?.n ?? 0), href: "/counter" },
    ],
  };
}

/**
 * On `membership.instrument.read` — the permission the counter already holds to look a card up
 * (DD18: "the counter cannot function without these"). Somebody who may not read an instrument has
 * no business being told how many are in force.
 */
export const membershipSchemesDeskProvider: DeskProvider = {
  key: "membership.schemes",
  permission: "membership.instrument.read",
  load: async (ctx) => [await schemesCard(ctx)],
};
