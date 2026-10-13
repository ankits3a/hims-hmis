import { DIET_MEALS, DIET_MEAL_ROUND_DEFAULTS } from "@hmis/contracts";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { dietMealRounds } from "../../kernel/db/schema";
import type { DietMeal, DietMealRoundView } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * THE MEAL CLOCK. Four rounds, each with a cut-off (the list is built) and a serve time (the trays reach the ward), in
 * IST minutes after midnight. The settings rows (`diet_meal_rounds`, seeded by the migration) win; a missing row falls
 * back to the contract's default, so a test database emptied by `truncateAll` still has a clock.
 * Never a hand-written IST offset (`ist-clock-parity`): a day's start is `istDayWindow`, a date is `istDayString`.
 */
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export async function mealRounds(db: Db | Tx): Promise<DietMealRoundView[]> {
  const rows = await (db as Db).select().from(dietMealRounds);
  const byMeal = new Map(rows.map((r) => [r.meal, r] as const));
  return DIET_MEALS.map((meal) => {
    const r = byMeal.get(meal);
    return { meal, cutoffMinute: r?.cutoffMinute ?? DIET_MEAL_ROUND_DEFAULTS[meal].cutoffMinute, serveMinute: r?.serveMinute ?? DIET_MEAL_ROUND_DEFAULTS[meal].serveMinute };
  });
}

/** IST midnight starting the IST calendar day `date` (YYYY-MM-DD). Noon UTC lies inside that IST day. */
export function istDayStart(date: string): Date {
  return istDayWindow(new Date(`${date}T12:00:00Z`)).start;
}

export function nextIstDate(date: string): string {
  return istDayString(new Date(istDayStart(date).getTime() + DAY_MS + MINUTE_MS));
}

export type MealSlot = { meal: DietMeal; date: string; cutoffAt: Date; serveAt: Date };

export function slotOf(round: DietMealRoundView, date: string): MealSlot {
  const start = istDayStart(date).getTime();
  return { meal: round.meal, date, cutoffAt: new Date(start + round.cutoffMinute * MINUTE_MS), serveAt: new Date(start + round.serveMinute * MINUTE_MS) };
}

/** The first meal whose serve time is still ahead of `now` (today's, else tomorrow's breakfast). */
export function nextSlot(rounds: readonly DietMealRoundView[], now: Date): MealSlot {
  const today = istDayString(now);
  for (const date of [today, nextIstDate(today)]) {
    for (const r of rounds) {
      const s = slotOf(r, date);
      if (s.serveAt.getTime() > now.getTime()) return s;
    }
  }
  return slotOf(rounds[0]!, nextIstDate(nextIstDate(today)));
}

/**
 * Today's slots whose cut-off has passed and whose serve time has not: the lists the clock owes. `buildSlot` builds the
 * wards still without a list, so a ward that filled after the first build (or a tick after a restart) is built too.
 */
export function dueSlots(rounds: readonly DietMealRoundView[], now: Date): MealSlot[] {
  const today = istDayString(now);
  return rounds.map((r) => slotOf(r, today)).filter((s) => s.cutoffAt.getTime() <= now.getTime() && now.getTime() < s.serveAt.getTime());
}

/** Today's slots served within the last two hours: a list missing for one of them was missed by the clock. */
export function missedSlots(rounds: readonly DietMealRoundView[], now: Date): MealSlot[] {
  const today = istDayString(now);
  return rounds.map((r) => slotOf(r, today))
    .filter((s) => s.serveAt.getTime() <= now.getTime() && now.getTime() - s.serveAt.getTime() <= 2 * 3_600_000);
}
