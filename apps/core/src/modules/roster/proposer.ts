import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";
import { rosterPeriods } from "../../kernel/db/schema/roster";
import { absentUserIds } from "./absences";
import { addIstDays, istDateOfInstant, istMidnightUtc, istWeekday } from "./calendar";
import { assign, draftPeriod } from "./periods";
import { listTeams, nightPoolFor, teamMembers } from "./teams";
import { rulesInForce } from "./rules";

/**
 * PHASE R (R9) — **THE PROPOSER: A FIRST DRAFT NOBODY HAS TO TYPE.**
 *
 * A head of department spends an evening a month laying out a rota by hand, and the result is
 * usually somebody's third night running, because a person cannot hold thirty days and eight
 * people in their head at once. This drafts the month; the head edits and publishes it.
 *
 * ═══ IT DRAFTS, AND IT NEVER PUBLISHES ═══
 *
 * `rosterActPolicy` forbids a machine to publish, and this does not go near it. What it produces
 * is a `draft` period with `origin: 'machine'`, which a person then opens. The moment a human
 * touches that draft, `human_touched_at` is stamped and **the proposer may never edit it again** —
 * V8's central clause, enforced in `assign` rather than by this file remembering.
 *
 * ═══ A HOLE IS AN HONEST ANSWER; A BROKEN RULE IS NOT ═══
 *
 * When nobody can take a slot without breaking a rule that BLOCKS — rest after duty, one night in
 * three — the proposer **leaves the slot vacant** rather than filling it. A vacant slot is a
 * declared hole the validator reports as a shortfall, and a head can see and fix it. A filled slot
 * that breaks a rest rule looks finished and is not, and the first anybody hears of it is a
 * resident who has been awake for two days.
 *
 * This is why the harness asserts that a drafted month carries **zero `block` findings at
 * NMC-minimum staffing**: with enough people the proposer must find a legal rota, and where it
 * cannot it must say so in holes rather than in violations.
 *
 * ═══ THE SAME INPUT GIVES THE SAME ROSTER ═══
 *
 * Every tie is broken by a seeded pseudo-random number, so two runs of one month produce the same
 * draft, and a harness can replay a month with seeded sick calls and compare. A proposer that
 * shuffled by `Math.random` would be untestable in exactly the way that matters: you could never
 * tell a fix from a coincidence.
 *
 * ═══ FAIRNESS IS COUNTED, NOT ASSERTED ═══
 *
 * Nights, Sundays and holidays per person per term. The greedy choice is always the eligible
 * person carrying the FEWEST of whatever is being handed out, which is what stops the rota
 * drifting onto whoever happens to sort first — the failure every hand-written roster has, where
 * one junior resident quietly takes every festival.
 */

export const PROPOSAL_STRATEGIES = ["unit_split", "pooled_nights"] as const;
export type ProposalStrategy = (typeof PROPOSAL_STRATEGIES)[number];

/** 20:00 → 08:00 IST. The shape of a night in an Indian teaching hospital. */
const NIGHT_START_MIN = 20 * 60;
const NIGHT_HOURS = 12;
/** 09:00 → 17:00 IST. */
const DAY_START_MIN = 9 * 60;
const DAY_HOURS = 8;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type FairnessCounters = {
  readonly userId: string;
  readonly nights: number;
  readonly sundays: number;
  readonly holidays: number;
};

export type ProposeMonthInput = {
  readonly departmentId: string;
  readonly teamId: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly strategy: ProposalStrategy;
  /** Tie-breaking seed. The same seed and the same establishment give the same roster. */
  readonly seed?: number;
  /** Which position the night slot is filled from. Defaults to the members' own positions. */
  readonly nightPositionKey?: string;
  readonly dayPositionKey?: string;
  /** IST dates the hospital treats as holidays, for the fairness count. */
  readonly holidays?: readonly string[];
};

export type ProposalResult = {
  readonly periodId: string;
  readonly runId: string;
  readonly filled: number;
  readonly vacant: number;
  readonly nights: number;
  readonly fairness: readonly FairnessCounters[];
  readonly strategy: ProposalStrategy;
};

/**
 * A SEEDED GENERATOR, AND DELIBERATELY A TINY ONE. `mulberry32` is four lines and has no state
 * outside the closure, so a run is reproducible from its seed alone and a test can say "this month,
 * seed 7" and mean exactly one roster.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const istInstant = (istDate: string, minute: number): Date =>
  new Date(istMidnightUtc(istDate).getTime() + minute * MINUTE_MS);

type Candidate = {
  readonly userId: string;
  readonly positionKey: string;
  nights: number;
  sundays: number;
  holidays: number;
  /** The last IST date this person worked a night, or null. */
  lastNight: string | null;
  /** The instant their last duty ended, for the rest rule. */
  lastEnd: number | null;
};

const daysApart = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * THE MONTH, DRAFTED.
 *
 * Guarded by `draft_machine_period` inside `draftPeriod` — the one act the matrix grants a machine,
 * and only for a roster of its own making.
 */
export async function proposeMonth(
  tx: Tx, actor: Actor, input: ProposeMonthInput,
): Promise<ProposalResult> {
  const rnd = seededRandom(input.seed ?? 1);
  const runId = newId();

  // Who is available, and by which strategy. `unit_split` staffs a unit from its own people;
  // `pooled_nights` draws the night from the department's pool — stress test S4's whole point,
  // because three residents cannot cover their own nights and twelve can.
  const members = await teamMembers(tx, input.teamId, input.startsAt);
  const substantive = members.filter((m) => !m.supernumerary);
  const poolIds = input.strategy === "pooled_nights"
    ? await nightPoolFor(tx, input.departmentId, input.startsAt)
    : substantive.map((m) => m.userId);

  const away = new Set(await absentUserIds(tx, input.startsAt, input.endsAt));

  const byUser = new Map(substantive.map((m) => [m.userId, m]));
  const candidates: Candidate[] = [...new Set(poolIds)]
    .filter((u) => !away.has(u))
    .sort()
    .map((userId) => ({
      userId,
      positionKey: byUser.get(userId)?.positionKey ?? input.nightPositionKey ?? "ward_jr",
      nights: 0, sundays: 0, holidays: 0, lastNight: null, lastEnd: null,
    }));

  const rules = await rulesInForce(tx, input.departmentId, istDateOfInstant(input.startsAt));
  const ruleNum = (key: string, param: string, fallback: number): number => {
    const r = rules.find((x) => x.key === key);
    const v = r?.params[param];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const oneInN = ruleNum("night_one_in_three", "oneInN", 3);
  const restHours = ruleNum("rest_after_duty", "minHours", 12);

  const nightPosition = input.nightPositionKey
    ?? candidates[0]?.positionKey ?? "ward_jr";
  const dayPosition = input.dayPositionKey ?? nightPosition;

  const period = await draftPeriod(tx, actor, {
    scopeType: "team",
    scopeId: input.teamId,
    departmentId: input.departmentId,
    teamId: input.teamId,
    title: input.title,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    coversPositions: [...new Set([nightPosition, dayPosition])],
    origin: "machine",
  });

  const holidays = new Set(input.holidays ?? []);
  let filled = 0;
  let vacant = 0;
  let nights = 0;

  const lastDate = istDateOfInstant(new Date(input.endsAt.getTime() - 1));
  for (let d = istDateOfInstant(input.startsAt); d <= lastDate; d = addIstDays(d, 1)) {
    const isSunday = istWeekday(d) === 0;
    const isHoliday = holidays.has(d);
    const nightStart = istInstant(d, NIGHT_START_MIN);
    const nightEnd = new Date(nightStart.getTime() + NIGHT_HOURS * HOUR_MS);

    /**
     * ELIGIBILITY IS THE BLOCKING RULES ONLY. A warn is the head's to weigh, and a proposer that
     * refused to draft anything a human might have to think about would draft nothing at all.
     */
    const eligible = candidates.filter((c) => {
      if (c.lastNight !== null && daysApart(c.lastNight, d) < oneInN) return false;
      if (c.lastEnd !== null && (nightStart.getTime() - c.lastEnd) / HOUR_MS < restHours) return false;
      return true;
    });

    // Fairest first: fewest nights, then fewest of whatever this day costs extra, then the seed.
    const cost = (c: Candidate): number =>
      c.nights * 1000 + (isHoliday ? c.holidays : 0) * 100 + (isSunday ? c.sundays : 0) * 10;
    const picked = eligible.length === 0
      ? null
      : eligible
        .map((c) => ({ c, k: cost(c), j: rnd() }))
        .sort((x, y) => x.k - y.k || x.j - y.j)[0]!.c;

    await assign(tx, actor, period.periodId, {
      // NULL when nobody could take it without breaking a block rule — an honest hole.
      userId: picked?.userId ?? null,
      positionKey: nightPosition,
      departmentId: input.departmentId,
      teamId: input.teamId,
      startsAt: nightStart,
      endsAt: nightEnd,
      mode: "presence",
      source: "proposer",
      proposalRunId: runId,
    });
    nights += 1;
    if (picked === null) { vacant += 1; } else {
      filled += 1;
      picked.nights += 1;
      if (isSunday) picked.sundays += 1;
      if (isHoliday) picked.holidays += 1;
      picked.lastNight = d;
      picked.lastEnd = nightEnd.getTime();
    }

    // Day duty for everybody the night has not just spoken for, and who is rested.
    const dayStart = istInstant(d, DAY_START_MIN);
    const dayEnd = new Date(dayStart.getTime() + DAY_HOURS * HOUR_MS);
    for (const c of candidates) {
      if (c.userId === picked?.userId) continue;
      // The post-night day is OFF. This is the rest rule expressed as a rota rather than as a
      // refusal — the person who was here until 08:00 does not come back at 09:00.
      if (c.lastEnd !== null && (dayStart.getTime() - c.lastEnd) / HOUR_MS < restHours) continue;
      await assign(tx, actor, period.periodId, {
        userId: c.userId,
        positionKey: dayPosition,
        departmentId: input.departmentId,
        teamId: input.teamId,
        startsAt: dayStart,
        endsAt: dayEnd,
        mode: "presence",
        source: "proposer",
        proposalRunId: runId,
      });
      filled += 1;
      c.lastEnd = dayEnd.getTime();
    }
  }

  return {
    periodId: period.periodId,
    runId,
    filled,
    vacant,
    nights,
    strategy: input.strategy,
    fairness: candidates
      .map((c) => ({ userId: c.userId, nights: c.nights, sundays: c.sundays, holidays: c.holidays }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  };
}

/**
 * The fairness a PUBLISHED or drafted period actually carries — counted from the rows rather than
 * from the proposer's own bookkeeping, so a head can ask it of a roster somebody typed by hand.
 */
export function fairnessOf(
  assignments: readonly {
    userId: string | null; startsAt: Date; endsAt: Date; kind: string;
  }[],
  holidays: readonly string[] = [],
): FairnessCounters[] {
  const holiday = new Set(holidays);
  const acc = new Map<string, { nights: number; sundays: number; holidays: number }>();
  for (const a of assignments) {
    if (a.userId === null || a.kind !== "duty") continue;
    const d = istDateOfInstant(a.startsAt);
    const isNight = istDateOfInstant(a.endsAt) !== d
      || a.startsAt.getTime() + 12 * HOUR_MS <= a.endsAt.getTime();
    const row = acc.get(a.userId) ?? { nights: 0, sundays: 0, holidays: 0 };
    if (isNight) row.nights += 1;
    if (istWeekday(d) === 0) row.sundays += 1;
    if (holiday.has(d)) row.holidays += 1;
    acc.set(a.userId, row);
  }
  return [...acc.entries()]
    .map(([userId, r]) => ({ userId, ...r }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

/** The spread between the busiest and the least-worked person — one number a head can read. */
export const fairnessSpread = (f: readonly FairnessCounters[]): number => {
  if (f.length === 0) return 0;
  const n = f.map((x) => x.nights);
  return Math.max(...n) - Math.min(...n);
};

/* ═══════════════════════════ the monthly job ═══════════════════════════ */

/**
 * PHASE R (R9) — **THE MONTHLY DRAFT, AND WHY THIS ONE IS A `system` ACTOR.**
 *
 * R7's `MATERIALISER_ACTOR` is `user`-typed, because writing down more of a cycle a human already
 * published continues a person's decision rather than making one. **This job is the other kind.**
 * It produces a draft of its own, which is precisely the act the matrix grants a machine —
 * `draft_machine_period: system = y` — and nothing else. A `user`-typed actor here would be worse
 * than wrong: it would stamp `drafted_by_actor_type: 'user'` on a roster no person wrote, and the
 * whole point of that column is telling those apart.
 */
export const PROPOSER_ACTOR: Actor = { type: "system", id: "roster-proposer" };

/** The day of the IST month the draft is cut. Plan §4 R9. */
export const PROPOSAL_DAY_OF_MONTH = 20;

/**
 * Registered `dailyIst` and returning early on twenty-nine days out of thirty.
 *
 * **The scheduler has two cadences — `every(ms)` and `dailyIst` — and no monthly one.** Adding one
 * would mean editing `kernel/worker/scheduler.ts`, a file that belongs to every lane, to serve a
 * single caller. A daily job that checks the date costs one cheap read a day and touches nothing
 * anybody else owns. DECIDED here rather than escalated: it is not money, procurement or law.
 *
 * It is also **idempotent**: a unit that already has a period for next month is skipped, so a
 * double run on the 20th drafts nothing twice, and a missed 20th can be re-run by hand.
 */
export async function runMonthlyProposals(
  db: Db, now: Date,
): Promise<{ skipped: boolean; drafted: number; units: number }> {
  const todayIst = istDateOfInstant(now);
  if (Number(todayIst.slice(8, 10)) !== PROPOSAL_DAY_OF_MONTH) {
    return { skipped: true, drafted: 0, units: 0 };
  }

  // Next month, in IST: the 1st of the following month to the 1st of the one after.
  const [y, m] = [Number(todayIst.slice(0, 4)), Number(todayIst.slice(5, 7))];
  const firstOfNext = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
  const [ny, nm] = [Number(firstOfNext.slice(0, 4)), Number(firstOfNext.slice(5, 7))];
  const firstAfter = `${nm === 12 ? ny + 1 : ny}-${String(nm === 12 ? 1 : nm + 1).padStart(2, "0")}-01`;
  const startsAt = istMidnightUtc(firstOfNext);
  const endsAt = istMidnightUtc(firstAfter);

  const teams = await listTeams(db, {});
  const units = teams.filter((t) => t.kind === "clinical_unit" && t.active);

  let drafted = 0;
  for (const team of units) {
    const existing = await (db as Db).select({ id: rosterPeriods.id }).from(rosterPeriods).where(and(
      eq(rosterPeriods.scopeType, "team"),
      eq(rosterPeriods.scopeId, team.id),
      eq(rosterPeriods.startsAt, startsAt),
    ));
    if (existing.length > 0) continue; // somebody already has next month in hand

    /**
     * THE STRATEGY IS CHOSEN BY ARITHMETIC, NOT BY PREFERENCE — stress test S4.
     *
     * A unit with fewer residents than the night rule's divisor cannot cover its own nights at
     * all: three people cannot take one night in three and also leave anybody rested. Such a unit
     * is drafted from the DEPARTMENT's night pool. A unit that can cover itself is left to.
     */
    const members = await teamMembers(db, team.id, startsAt);
    const own = members.filter((m) => !m.supernumerary && !m.officiating).length;
    const strategy: ProposalStrategy = own < 4 ? "pooled_nights" : "unit_split";

    await db.transaction((tx) => proposeMonth(tx, PROPOSER_ACTOR, {
      departmentId: team.departmentId,
      teamId: team.id,
      title: `${firstOfNext.slice(0, 7)} — ${team.name}`,
      startsAt,
      endsAt,
      strategy,
      seed: Number(firstOfNext.replace(/-/g, "")) % 100000,
    }));
    drafted += 1;
  }
  return { skipped: false, drafted, units: units.length };
}
