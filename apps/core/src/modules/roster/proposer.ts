import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";
import { rosterPeriods } from "../../kernel/db/schema/roster";
import { approvedAbsenceWindows, awayDuring } from "./absences";
import { addIstDays, holidaysBetween, istDateOfInstant, istMidnightUtc, istWeekday } from "./calendar";
import { assign, draftPeriod } from "./periods";
import { listTeams, nightPoolFor, teamMembers } from "./teams";
import { rulesInForce } from "./rules";
import { touchesNight } from "./validator";

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

/**
 * ═══ THE SHAPE OF A DAY (audit 2026-10-04 #3) — DECIDED ═══
 *
 * The take runs 08:00 → 08:00 (brainstorm 00 §1: *"The turn runs 08:00 → 08:00"*; R7's V12
 * flips the take unit at 08:00 exactly) and the roster prints itself at *"20:00 and 08:00"* (20-U
 * D5). The first proposer drafted a 09:00–17:00 day beside a 20:00–08:00 night, which left
 * 08:00–09:00 and 17:00–20:00 with nobody in the building **every day**: the in-building position
 * had a five-hour hole a day that no finding reported, because nothing was rostered to be short.
 *
 * So a day now has three shapes, and the in-building position is covered at every instant:
 *
 *   · **COVER** 08:00 → 20:00 — one resident of the unit's own, in the building, the position the
 *     night continues. Twelve hours: inside `shift_12h` and contiguous with the night at both ends.
 *   · **NIGHT** 20:00 → 08:00 — one resident; from the unit (`unit_split`) or the department's pool
 *     (`pooled_nights`, stress test S4).
 *   · **ROUTINE** 09:00 → 17:30 — everybody else of the unit's own: ward, OPD, theatre. The owner's
 *     ruling on office timings (20-U header, 2026-09-20: *"office timings 09:00–17:30"*). It is
 *     not drafted on a Sunday or on a holiday that withdraws OPD (#8).
 *
 * The cover is drafted as the `nightPositionKey` (it is the same post, by day); routine as
 * `dayPositionKey`.
 */
const NIGHT_START_MIN = 20 * 60;
const NIGHT_HOURS = 12;
const COVER_START_MIN = 8 * 60;
const COVER_HOURS = 12;
const ROUTINE_START_MIN = 9 * 60;
const ROUTINE_MINUTES = 8 * 60 + 30;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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
  /** Which position the night (and the 08:00 cover) is filled from. Defaults to the members' own. */
  readonly nightPositionKey?: string;
  readonly dayPositionKey?: string;
  /**
   * EXTRA IST dates to treat as holidays, beyond those declared in `roster_holidays` — which the
   * proposer now reads for itself (#8). Each is treated as an `as_sunday` holiday.
   */
  readonly holidays?: readonly string[];
};

export type ProposalResult = {
  readonly periodId: string;
  readonly runId: string;
  readonly filled: number;
  readonly vacant: number;
  /** Nights drafted INTO THIS period. */
  readonly nights: number;
  /** Pooled nights already held by a sibling unit's draft or published roster, and so not drafted here. */
  readonly nightsHeldElsewhere: number;
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
  nights: number;
  /** Nights this person already holds in a SIBLING roster this month — weighed, not reported. */
  heldNights: number;
  covers: number;
  sundays: number;
  holidays: number;
  /** The last IST date this person worked a night, or null. */
  lastNight: string | null;
  /** The instant their last duty ended, for the rest rule. */
  lastEnd: number | null;
  /** Did this person belong, and was not on leave, on at least one day of the month? */
  available: boolean;
};

/** A presence duty the person already holds in ANOTHER roster (draft or published). */
type Busy = { readonly startsAt: number; readonly endsAt: number; readonly night: string | null };

const daysApart = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * THE MONTH, DRAFTED.
 *
 * Guarded by `draft_machine_period` inside `draftPeriod` — the one act the matrix grants a machine,
 * and only for a roster of its own making.
 *
 * ═══ POOLED NIGHTS ARE THE DEPARTMENT'S, AND ARE DRAFTED ONCE (audit 2026-10-04 #1) — DECIDED ═══
 *
 * Stress test S4, as ACCEPTED: *"department-pooled 12-hour nights + the take unit's own team"* —
 * the take unit works its day; night cover for every unit's wards is ONE pooled resident a floor.
 * Two consequences the first proposer had backwards:
 *
 *   · **The pool is for the night only.** Day duty (cover and routine) goes to the unit's OWN
 *     substantive members. It used to iterate the whole pool, so each unit's draft put the entire
 *     department on its day list.
 *   · **One night, one resident, for the department — not one per unit.** Each unit's draft used
 *     to draft its own pooled night with the same seed, so one JR stood on four units' nights at
 *     once. Now a pooled night is written with `cover_scope = 'department'` and NO `team_id` (so the
 *     resolver's closed-membership subtraction, which applies to team slots, does not drop a pool
 *     member for not belonging to this unit), and a unit's draft SKIPS any night already held by a
 *     department-scope slot in a sibling roster (draft or published). The first unit drafted
 *     carries the department's nights; the rest see them and carry none. Chosen over a separate
 *     department-scope period because it needs no new period shape and keeps `runMonthlyProposals`
 *     a loop over units; the cost is that the night lives in whichever unit drafted first, which
 *     the HOD sees in the draft and may move.
 *
 * Every candidate's duties in OTHER rosters (any department, draft or published, not this roster's
 * own series) are read once and honoured as busy time: rest and one-in-N are judged against them,
 * so the proposer cannot draft a cross-unit presence clash (#4) it would then be refused for.
 *
 * ═══ MEMBERSHIP AND LEAVE ARE PER SLOT, NOT PER MONTH (#2, #9) ═══
 *
 * Who belongs to the unit is read for every day (at the 08:00 cover) and the pool for every night
 * (at 20:00) — a JR joining on the 15th is drafted from the 15th, one leaving on the 10th is not
 * drafted after. Approved leave excludes a person from exactly the slots it overlaps.
 */
export async function proposeMonth(
  tx: Tx, actor: Actor, input: ProposeMonthInput,
): Promise<ProposalResult> {
  const rnd = seededRandom(input.seed ?? 1);
  const runId = newId();
  const pooled = input.strategy === "pooled_nights";

  const firstDate = istDateOfInstant(input.startsAt);
  const lastDate = istDateOfInstant(new Date(input.endsAt.getTime() - 1));
  const dates: string[] = [];
  for (let d = firstDate; d <= lastDate; d = addIstDays(d, 1)) dates.push(d);

  // Who is in the unit on each day, and who is in the night pool on each night.
  const ownOn = new Map<string, string[]>();
  const poolOn = new Map<string, string[]>();
  let positionHint: string | undefined;
  for (const d of dates) {
    const members = (await teamMembers(tx, input.teamId, istInstant(d, COVER_START_MIN)))
      .filter((m) => !m.supernumerary);
    positionHint ??= members[0]?.positionKey;
    ownOn.set(d, members.map((m) => m.userId).sort());
    poolOn.set(d, pooled
      ? await nightPoolFor(tx, input.departmentId, istInstant(d, NIGHT_START_MIN))
      : (await teamMembers(tx, input.teamId, istInstant(d, NIGHT_START_MIN)))
        .filter((m) => !m.supernumerary).map((m) => m.userId).sort());
  }
  const everyone = [...new Set([...ownOn.values(), ...poolOn.values()].flat())].sort();

  const leave = await approvedAbsenceWindows(
    tx, new Date(input.startsAt.getTime() - DAY_MS), new Date(input.endsAt.getTime() + DAY_MS),
  );

  const rules = await rulesInForce(tx, input.departmentId, firstDate);
  const ruleNum = (key: string, param: string, fallback: number): number => {
    const r = rules.find((x) => x.key === key);
    const v = r?.params[param];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const oneInN = ruleNum("night_one_in_three", "oneInN", 3);
  const restHours = ruleNum("rest_after_duty", "minHours", 12);

  const nightPosition = input.nightPositionKey ?? positionHint ?? "ward_jr";
  const dayPosition = input.dayPositionKey ?? nightPosition;

  // Holidays: the declared ones, and any the caller adds. OPD and the elective list are withdrawn
  // on every pattern but `opd_short`; take and nights run as usual (20-U board, Gandhi Jayanti).
  const declared = await holidaysBetween(tx, firstDate, addIstDays(lastDate, 1));
  const holidayPattern = new Map<string, string>(declared.map((h) => [h.istDate, h.pattern]));
  for (const d of input.holidays ?? []) if (!holidayPattern.has(d)) holidayPattern.set(d, "as_sunday");

  // Duties these people already hold in OTHER rosters — not this roster's own series, whose other
  // versions are alternatives to this draft rather than commitments beside it.
  const busy = new Map<string, Busy[]>();
  const heldNights = new Set<number>();
  if (everyone.length > 0) {
    const ids = sql.join(everyone.map((u) => sql`${u}`), sql`, `);
    const res = await (tx as Db).execute(sql`
      select a.user_id as "userId", a.starts_at as "startsAt", a.ends_at as "endsAt"
        from roster_assignments a join roster_periods p on p.id = a.period_id
       where a.user_id in (${ids}) and a.live_to is null and a.mode = 'presence' and a.kind <> 'off'
         and p.status in ('draft', 'published')
         and not (p.scope_type = 'team' and p.scope_id = ${input.teamId} and p.starts_at = ${input.startsAt})
         and a.starts_at < ${new Date(input.endsAt.getTime() + DAY_MS)}
         and a.ends_at > ${new Date(input.startsAt.getTime() - DAY_MS)}`);
    for (const r of res.rows as { userId: string; startsAt: unknown; endsAt: unknown }[]) {
      const s = new Date(String(r.startsAt instanceof Date ? r.startsAt.toISOString() : r.startsAt));
      const e = new Date(String(r.endsAt instanceof Date ? r.endsAt.toISOString() : r.endsAt));
      const night = touchesNight(s, e) ? istDateOfInstant(s) : null;
      busy.set(r.userId, [...(busy.get(r.userId) ?? []), { startsAt: s.getTime(), endsAt: e.getTime(), night }]);
    }
  }
  if (pooled) {
    // The department's nights already held elsewhere — vacant or filled, the slot exists there.
    const res = await (tx as Db).execute(sql`
      select a.starts_at as "startsAt"
        from roster_assignments a join roster_periods p on p.id = a.period_id
       where a.department_id = ${input.departmentId} and a.cover_scope = 'department'
         and a.position_key = ${nightPosition} and a.live_to is null and a.kind = 'duty'
         and p.status in ('draft', 'published')
         and not (p.scope_type = 'team' and p.scope_id = ${input.teamId} and p.starts_at = ${input.startsAt})
         and a.starts_at >= ${input.startsAt} and a.starts_at < ${input.endsAt}`);
    for (const r of res.rows as { startsAt: unknown }[]) {
      heldNights.add(new Date(String(r.startsAt instanceof Date ? r.startsAt.toISOString() : r.startsAt)).getTime());
    }
  }

  const cand = new Map<string, Candidate>(everyone.map((userId) => [userId, {
    userId, nights: 0, covers: 0, sundays: 0, holidays: 0, lastNight: null, lastEnd: null,
    available: false,
    heldNights: (busy.get(userId) ?? []).filter((b) => b.night !== null
      && b.startsAt >= input.startsAt.getTime() && b.startsAt < input.endsAt.getTime()).length,
  }]));

  /** Rest before `from` and after `to`, against this draft AND every other roster's duties. */
  const rested = (c: Candidate, from: Date, to: Date): boolean => {
    if (c.lastEnd !== null && (from.getTime() - c.lastEnd) / HOUR_MS < restHours) return false;
    for (const b of busy.get(c.userId) ?? []) {
      if (b.endsAt <= from.getTime()) {
        if ((from.getTime() - b.endsAt) / HOUR_MS < restHours) return false;
      } else if (b.startsAt >= to.getTime()) {
        if ((b.startsAt - to.getTime()) / HOUR_MS < restHours) return false;
      } else {
        return false; // overlaps: one body, two rooms
      }
    }
    return true;
  };
  const free = (c: Candidate, from: Date, to: Date): boolean =>
    !awayDuring(leave, c.userId, from, to) && rested(c, from, to);

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

  let filled = 0;
  let vacant = 0;
  let nights = 0;
  let nightsHeldElsewhere = 0;

  const put = async (
    userId: string | null, positionKey: string, startsAt: Date, endsAt: Date,
    scope: { coverScope: "team" | "department"; teamId: string | null },
  ): Promise<void> => {
    await assign(tx, actor, period.periodId, {
      // NULL when nobody could take it without breaking a block rule — an honest hole.
      userId, positionKey, departmentId: input.departmentId, teamId: scope.teamId,
      coverScope: scope.coverScope, startsAt, endsAt, mode: "presence",
      source: "proposer", proposalRunId: runId,
    });
    if (userId === null) vacant += 1; else filled += 1;
  };

  /** Fairest first: fewest of the counted duty, then fewest of whatever this day costs extra, then the seed. */
  const pick = (pool: Candidate[], count: (c: Candidate) => number, isSunday: boolean, isHoliday: boolean) =>
    pool.length === 0 ? null : pool
      .map((c) => ({
        c,
        k: count(c) * 1000 + (isHoliday ? c.holidays : 0) * 100 + (isSunday ? c.sundays : 0) * 10,
        j: rnd(),
      }))
      .sort((x, y) => x.k - y.k || x.j - y.j)[0]!.c;

  const credit = (c: Candidate, end: Date, isSunday: boolean, isHoliday: boolean): void => {
    if (isSunday) c.sundays += 1;
    if (isHoliday) c.holidays += 1;
    c.lastEnd = Math.max(c.lastEnd ?? 0, end.getTime());
  };

  for (const d of dates) {
    const isSunday = istWeekday(d) === 0;
    const pattern = holidayPattern.get(d);
    const isHoliday = pattern !== undefined;
    // Sunday and an `as_sunday` / `opd_off_ot_proceeds` holiday: no OPD, no elective list.
    const routineRuns = !isSunday && (pattern === undefined || pattern === "opd_short");

    const own = (ownOn.get(d) ?? []).map((u) => cand.get(u)!);
    const nightPool = (poolOn.get(d) ?? []).map((u) => cand.get(u)!);
    const nightStart = istInstant(d, NIGHT_START_MIN);
    const nightEnd = new Date(nightStart.getTime() + NIGHT_HOURS * HOUR_MS);
    const coverStart = istInstant(d, COVER_START_MIN);
    const coverEnd = new Date(coverStart.getTime() + COVER_HOURS * HOUR_MS);
    const routineStart = istInstant(d, ROUTINE_START_MIN);
    const routineEnd = new Date(routineStart.getTime() + ROUTINE_MINUTES * MINUTE_MS);

    for (const c of own) if (!awayDuring(leave, c.userId, coverStart, nightEnd)) c.available = true;

    // ── the NIGHT first: whoever takes it is spared the day before it.
    let nightTaker: Candidate | null = null;
    if (pooled && heldNights.has(nightStart.getTime())) {
      nightsHeldElsewhere += 1;
    } else {
      /**
       * ELIGIBILITY IS THE BLOCKING RULES ONLY. A warn is the head's to weigh, and a proposer that
       * refused to draft anything a human might have to think about would draft nothing at all.
       */
      const eligible = nightPool.filter((c) => {
        if (!free(c, nightStart, nightEnd)) return false;
        if (c.lastNight !== null && daysApart(c.lastNight, d) < oneInN) return false;
        return !(busy.get(c.userId) ?? []).some((b) => b.night !== null && Math.abs(daysApart(b.night, d)) < oneInN);
      });
      for (const c of nightPool) if (!awayDuring(leave, c.userId, nightStart, nightEnd)) c.available = true;
      nightTaker = pick(eligible, (c) => c.nights + c.heldNights, isSunday, isHoliday);
      await put(nightTaker?.userId ?? null, nightPosition, nightStart, nightEnd,
        pooled ? { coverScope: "department", teamId: null } : { coverScope: "team", teamId: input.teamId });
      nights += 1;
    }

    // ── the 08:00 COVER: the unit's own, so the building is never empty between night and night.
    const coverTaker = pick(
      own.filter((c) => c !== nightTaker && free(c, coverStart, coverEnd)),
      (c) => c.covers, isSunday, isHoliday,
    );
    await put(coverTaker?.userId ?? null, nightPosition, coverStart, coverEnd, { coverScope: "team", teamId: input.teamId });
    if (coverTaker !== null) {
      coverTaker.covers += 1;
      credit(coverTaker, coverEnd, isSunday, isHoliday);
    }

    // ── ROUTINE day duty for the rest of the unit's own, where the day has one.
    if (routineRuns) {
      for (const c of own) {
        if (c === nightTaker || c === coverTaker) continue;
        // The post-night day is OFF: rest expressed as a rota rather than as a refusal.
        if (!free(c, routineStart, routineEnd)) continue;
        await put(c.userId, dayPosition, routineStart, routineEnd, { coverScope: "team", teamId: input.teamId });
        credit(c, routineEnd, isSunday, isHoliday);
      }
    }

    if (nightTaker !== null) {
      nightTaker.nights += 1;
      nightTaker.lastNight = d;
      credit(nightTaker, nightEnd, isSunday, isHoliday);
    }
  }

  return {
    periodId: period.periodId,
    runId,
    filled,
    vacant,
    nights,
    nightsHeldElsewhere,
    strategy: input.strategy,
    fairness: [...cand.values()]
      .filter((c) => c.available)
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
    // The same test the validator uses (01:00–05:00 IST touched). The old "twelve hours or crosses
    // midnight" counted the 08:00–20:00 cover as a night (audit 2026-10-04 #3).
    const isNight = touchesNight(a.startsAt, a.endsAt);
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

/**
 * THE STRATEGY IS CHOSEN BY ARITHMETIC, NOT BY PREFERENCE — stress test S4. A unit with fewer
 * residents than can cover their own nights is drafted from the DEPARTMENT's night pool. Shared by
 * the monthly job and 20-U U5b's "draft this month" so the two can never draft differently.
 */
export async function proposalStrategyFor(
  exec: Db | Tx, teamId: string, at: Date,
): Promise<ProposalStrategy> {
  const members = await teamMembers(exec, teamId, at);
  const own = members.filter((m) => !m.supernumerary && !m.officiating).length;
  return own < 4 ? "pooled_nights" : "unit_split";
}

/** The tie-breaking seed the monthly job uses for a month starting on `firstOfMonth` (IST date). */
export const proposalSeedFor = (firstOfMonth: string): number =>
  Number(firstOfMonth.replace(/-/g, "")) % 100000;

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
    const strategy = await proposalStrategyFor(db, team.id, startsAt);

    await db.transaction((tx) => proposeMonth(tx, PROPOSER_ACTOR, {
      departmentId: team.departmentId,
      teamId: team.id,
      title: `${firstOfNext.slice(0, 7)} — ${team.name}`,
      startsAt,
      endsAt,
      strategy,
      seed: proposalSeedFor(firstOfNext),
    }));
    drafted += 1;
  }
  return { skipped: false, drafted, units: units.length };
}
