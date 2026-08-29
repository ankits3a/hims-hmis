import { and, asc, eq, gte, lte } from "drizzle-orm";
import { hasPermission } from "../auth/permissions";
import { userDayFacts, users } from "../db/schema";
import { DeskError } from "./types";
import type { DeskProvider, DeskProviderCtx } from "./types";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 07c T8 / DD13 — THE NIGHTLY ROLL, AND THE WINDOW READER THAT MUST AGREE WITH IT.
 *
 * ═══ WHY THIS EXISTS AT ALL (the measurement, re-taken at kickoff) ═══
 *
 * A brief covering six months, computed live, would aggregate ~2.5–3M rows across eight tables per
 * person per page load — and until migration 0041 there was not ONE index on any actor column on
 * any of them. So the long windows are served from `user_day_facts`, a per-person-per-day cache,
 * and only TODAY is computed live.
 *
 * ═══ ONE ARITHMETIC, TWO CALLERS — WHICH IS WHAT MAKES A1 TRUE RATHER THAN LUCKY ═══
 *
 * `liveFactsFor` is the only place a day's facts are ever computed. The nightly job stores what it
 * returns; `factsForWindow` reads today from it directly. There is no second query written "the
 * fast way" for the rollup and "the correct way" for today, because that pair is exactly how a
 * cached total and a live total come to differ while both look authoritative. The rollup is a
 * CACHE of this function and nothing else.
 */
export type DayFacts = { day: string; facts: Record<string, number>; provisional: boolean };

/**
 * PLAN 07c T8 — a fact bag is integers, and anything else is REFUSED rather than stored.
 *
 * Money here is paise and the rollup sums it across up to 184 days. A float that arrived because
 * somebody divided by 100 somewhere upstream would accumulate a rounding error nobody can find
 * afterwards, and a NaN would poison every window it appears in and render as "NaN" on a printed
 * shift report. Refusing at the boundary is the only place this is cheap to catch.
 */
function assertCountable(providerKey: string, facts: Record<string, number>): void {
  for (const [key, value] of Object.entries(facts)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new DeskError(
        "bad_fact",
        `desk provider "${providerKey}" returned a non-countable fact: ${key}=${String(value)} — ` +
          "facts are non-negative integers (money is paise), because the rollup sums them over months",
      );
    }
  }
}

/**
 * Every fact every provider the actor is permitted contributes for ONE day.
 *
 * The permission gate is applied BEFORE the provider runs, identically to `loadDesk` and
 * `loadReport` — a module the person may not see does not get its queries run on their behalf.
 * A provider that THROWS costs its own facts and nothing else: a brief missing one module's
 * numbers is worth having, and a brief that cannot be computed because pharmacy has a bad query is
 * not. The keys it did not contribute are simply absent, which the summer treats as "no data" and
 * NOT as zero — see `sumWindow`.
 */
export async function liveFactsFor(
  providers: DeskProvider[],
  ctx: DeskProviderCtx,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const p of providers) {
    if (p.facts === undefined) continue;
    if (!(await hasPermission(ctx.db, ctx.actor.id, p.permission, "hospital"))) continue;
    try {
      const facts = await p.facts(ctx);
      assertCountable(p.key, facts);
      Object.assign(out, facts);
    } catch (e) {
      // A bad-fact refusal is a PROGRAMMING error in a provider and must not be swallowed into a
      // silently short brief; a query failure is an operational one and must not blank the brief.
      if (e instanceof DeskError) throw e;
    }
  }
  return out;
}

/**
 * PLAN 07c T8 A2 — THE ROLL IS AN UPSERT, SO A SECOND RUN OF THE SAME NIGHT CHANGES NOTHING.
 *
 * Idempotence is structural rather than guarded: `(user_id, day)` is the table's PRIMARY KEY, so
 * there is no shape of retry, overlap or double-scheduling that can give one person two rows for
 * one day. An append-only design with a "latest wins" read would double every retried day and look
 * fine until somebody summed a month.
 *
 * A5 — a corrected or backfilled day RE-ROLLS by construction: the same call over the same date
 * recomputes from the primary tables and overwrites. There is nothing to compensate and no delta
 * to apply, which is the property that makes a cache safe to be wrong for a few hours.
 */
export async function rollupUserDay(
  db: Db, providers: DeskProvider[], userId: string, day: string, now: Date,
): Promise<Record<string, number>> {
  const actor: Actor = { type: "user", id: userId };
  const facts = await liveFactsFor(providers, { db, actor, reader: actor, date: day, now });
  await db
    .insert(userDayFacts)
    .values({ userId, day, facts, computedAt: now })
    .onConflictDoUpdate({
      target: [userDayFacts.userId, userDayFacts.day],
      set: { facts, computedAt: now },
    });
  return facts;
}

/**
 * PLAN 07c T8 A5 — THE NIGHTLY ROLL, AND IT RE-ROLLS A TRAILING WINDOW RATHER THAN ONE DAY.
 *
 * Rolling only "yesterday" is the obvious design and it is wrong in a hospital: an entered-in-error
 * mark, a late correction, a receipt voided on Monday for a Friday shift — all of them change a day
 * that is already rolled, and none of them would ever reach the brief. `LOOKBACK_DAYS` is how far
 * back a correction can land and still be picked up automatically; anything older is a deliberate
 * re-roll somebody asks for.
 *
 * The cost is bounded and small: active users × lookback days, once a night. This hospital has tens
 * of staff, not thousands, and migration 0041's composite indexes are what keep each of those days
 * an index lookup rather than a scan.
 */
export const LOOKBACK_DAYS = 3;

export async function rollupAll(
  db: Db, providers: DeskProvider[], today: string, now: Date, lookback = LOOKBACK_DAYS,
): Promise<{ users: number; days: number; rows: number }> {
  const active = await db.select({ id: users.id }).from(users).where(eq(users.active, true));
  /*
   * TODAY IS NOT ROLLED. It is still happening, so a row written now would be a settled-looking
   * answer to an unsettled question — and `factsForWindow` computes today live precisely so it can
   * mark it provisional (A3). The window is the `lookback` days ENDING YESTERDAY.
   */
  const days = Array.from({ length: lookback }, (_, i) => addDays(today, -(i + 1)));
  let rows = 0;
  for (const user of active) {
    for (const day of days) {
      await rollupUserDay(db, providers, user.id, day, now);
      rows += 1;
    }
  }
  return { users: active.length, days: days.length, rows };
}

/** IST calendar-day arithmetic on a 'YYYY-MM-DD' string. No clock, no offset — pure date maths. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * PLAN 07c T8 A1/A3 — A WINDOW OF DAYS: the rollup for every settled day, TODAY COMPUTED LIVE.
 *
 * The seam between the two is where a cached brief goes wrong, so it is one line and it is stated:
 * a day strictly before `today` comes from `user_day_facts`; `today` (and any date after it, which
 * is empty) is computed by `liveFactsFor` — the very function the rollup is a cache of.
 *
 * A day with NO rollup row is absent rather than zero, and that distinction is load-bearing: a
 * person who did not work on Sunday and a Sunday that was never rolled are different facts, and
 * rendering the second as a zero would make a broken job look like a quiet weekend.
 */
export async function factsForWindow(
  db: Db, providers: DeskProvider[], actor: Actor, from: string, to: string, today: string, now: Date,
): Promise<DayFacts[]> {
  const stored = await db
    .select({ day: userDayFacts.day, facts: userDayFacts.facts })
    .from(userDayFacts)
    .where(and(eq(userDayFacts.userId, actor.id), gte(userDayFacts.day, from), lte(userDayFacts.day, to)))
    .orderBy(asc(userDayFacts.day));

  const out: DayFacts[] = stored
    .filter((r) => r.day < today)
    .map((r) => ({ day: r.day, facts: r.facts as Record<string, number>, provisional: false }));

  if (today >= from && today <= to) {
    out.push({
      day: today,
      facts: await liveFactsFor(providers, { db, actor, reader: actor, date: today, now }),
      provisional: true,
    });
  }
  return out;
}

/**
 * Sum a window's bags into one bag. A key ABSENT from every day sums to nothing at all rather than
 * to zero — `undefined` is what `honestly()` in `brief.ts` reads to decide a clause cannot be made.
 */
export function sumWindow(days: DayFacts[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d.facts)) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}
