import { asc, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";
import {
  rosterAssignments, rosterHolidays, rosterPeriods, rosterPositions, rosterRequirements,
  staffCredentials,
} from "../../kernel/db/schema/roster";
import type {
  RosterCadre, RosterRuleAuthority, RosterRuleSeverity,
} from "../../kernel/db/schema/roster";
import { addIstDays, istDateOfInstant, istWeekday } from "./calendar";
import { absentUserIds } from "./absences";
import { RosterError } from "./errors";
/**
 * TYPE-ONLY, AND LOAD-BEARING. `periods.ts` calls this module from its publish gate, so a runtime
 * import back into it would close a cycle. The two rows this needs are read from the schema
 * directly a few lines down; a `import type` is erased and cannot close anything.
 */
import type { RosterAssignmentRow, RosterPeriodRow } from "./periods";
import { rulesInForce } from "./rules";
import type { EffectiveRule } from "./rules";

/**
 * PHASE R (R8) — **IS THIS ROSTER ANY GOOD?**
 *
 * R2's publish gate refuses what can never be right. This asks the different question: what is
 * wrong with a roster that is nonetheless perfectly representable — somebody on their third night
 * running, a unit with one junior resident, a registration that lapses on the 12th. Every answer is
 * a FINDING: a rule key, a severity, the numbers that produced it, and the person or slot it is
 * about. A named human may accept a finding with a reason, and that acceptance is kept.
 *
 * ═══ NOTHING HERE WRITES (and `simulate()` depends on it) ═══
 *
 * `validate()` reads the roster, the book, the requirements, the absences and the credentials, and
 * returns an array. It does not insert findings, does not stamp anything, and takes no `now` it
 * could stamp with. Persisting findings is the caller's act, and the publish gate's refusal is
 * computed from the returned array rather than from a table it just wrote.
 *
 * ═══ THE EMPTINESS TRAP, WHICH THIS PHASE HAS ALREADY PAID FOR ONCE ═══
 *
 * "No rule is violated" is true of a hospital with no rosters, no units and no people. Every
 * evaluator below therefore requires its population to EXIST before it can report green: a unit
 * with no assignments on a date is not a unit failing its JR minimum, and a roster carrying no
 * theatre sessions at all is not a roster denying its postgraduates theatre. A check that cannot
 * tell "compliant" from "empty" is not a check.
 *
 * ═══ WHAT COUNTS TOWARD A REQUIREMENT (V16) ═══
 *
 * A slot satisfies a requirement only when it is FILLED (`user_id` is not null — a vacant slot is
 * the hole the requirement exists to find), NOT `supernumerary` (a trainee added above
 * establishment does not relieve the establishment), and its position
 * `counts_toward_requirements`. All three, or it is not cover.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The dead of night in IST. A slot touching this is a night duty; an evening clinic is not. */
const NIGHT_FROM_MINUTE = 60; // 01:00 IST
const NIGHT_TO_MINUTE = 300; // 05:00 IST

export type RosterFinding = {
  readonly ruleKey: string;
  readonly severity: RosterRuleSeverity;
  readonly authority: RosterRuleAuthority;
  readonly userId: string | null;
  readonly assignmentId: string | null;
  readonly params: Record<string, unknown>;
};

/** A roster that may not exist: `simulate()` passes one of these rather than a period id. */
export type HypotheticalRoster = {
  readonly period: Pick<
    RosterPeriodRow, "id" | "departmentId" | "startsAt" | "endsAt" | "scopeType" | "scopeId"
  >;
  readonly assignments: readonly RosterAssignmentRow[];
};

export type ValidateInput = string | HypotheticalRoster;

type Slot = {
  readonly id: string;
  readonly userId: string | null;
  readonly positionKey: string;
  readonly cadre: RosterCadre;
  readonly counts: boolean;
  readonly supernumerary: boolean;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly hours: number;
  readonly mode: string | null;
  readonly kind: string;
  readonly teamId: string | null;
  readonly departmentId: string;
  readonly locationResourceId: string | null;
  readonly istDate: string;
  readonly isNight: boolean;
  readonly topic: string | null;
};

const finding = (
  rule: EffectiveRule,
  bits: { userId?: string | null; assignmentId?: string | null; params?: Record<string, unknown> },
): RosterFinding => ({
  ruleKey: rule.key,
  severity: rule.severity,
  authority: rule.authority,
  userId: bits.userId ?? null,
  assignmentId: bits.assignmentId ?? null,
  params: { ...bits.params },
});

const num = (rule: EffectiveRule, key: string, fallback: number): number => {
  const v = rule.params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/** IST minutes past midnight of an instant, used only to ask whether a window touches the night. */
const istMinuteOf = (at: Date): number => {
  const shifted = new Date(at.getTime() + 330 * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/**
 * Does `[from, to)` cover any instant of the 01:00–05:00 IST band on any day it spans? Written as a
 * sweep rather than an arithmetic trick because a 26-hour duty crosses the band twice and a
 * cleverer expression would quietly answer only about the first.
 */
function touchesNight(from: Date, to: Date): boolean {
  for (let t = from.getTime(); t < to.getTime(); t += 15 * 60_000) {
    const m = istMinuteOf(new Date(t));
    if (m >= NIGHT_FROM_MINUTE && m < NIGHT_TO_MINUTE) return true;
  }
  return false;
}

/* ═══════════════════════════════ the rules, one function each ═══════════════════════════════ */

/**
 * `slot_over_24h` — BLOCK. Not a shortage: a duty nobody could do, planned on purpose.
 *
 * **PRESENCE ONLY, and that is not a detail.** R2 already refuses a presence window longer than the
 * position's own `max_presence_hours`, so this rule is the hospital-wide line at 24 for the
 * positions whose individual cap is looser than that. On-call is deliberately exempt: a 24-hour
 * consultant call is the normal shape of Indian hospital cover, and R2's own refusal says so in as
 * many words — *"on-call may be longer"*. A rule that blocked it would refuse almost every
 * legitimate rota in the building.
 */
function slotOver24h(slots: readonly Slot[], rule: EffectiveRule): RosterFinding[] {
  const max = num(rule, "maxHours", 24);
  return slots
    .filter((s) => s.kind === "duty" && s.mode === "presence" && s.hours > max)
    .map((s) => finding(rule, {
      userId: s.userId, assignmentId: s.id,
      params: { hours: Math.round(s.hours * 100) / 100, maxHours: max },
    }));
}

/** `rest_after_duty` — the gap between one duty ending and the next beginning, per person. */
function restAfterDuty(slots: readonly Slot[], rule: EffectiveRule): RosterFinding[] {
  const min = num(rule, "minHours", 12);
  const out: RosterFinding[] = [];
  for (const [userId, mine] of byUser(slots)) {
    const duties = mine.filter((s) => s.kind === "duty" && s.mode === "presence")
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 1; i < duties.length; i += 1) {
      const prev = duties[i - 1]!;
      const next = duties[i]!;
      const gap = (next.startsAt.getTime() - prev.endsAt.getTime()) / HOUR_MS;
      // Overlapping or contiguous duties are one stretch, not a rest failure: the hours rules
      // below are what speak about those, and saying it twice would double-count one fact.
      if (gap > 0 && gap < min) {
        out.push(finding(rule, {
          userId, assignmentId: next.id,
          params: { restHours: Math.round(gap * 100) / 100, minHours: min, afterAssignmentId: prev.id },
        }));
      }
    }
  }
  return out;
}

/** The worst rolling 7-day total per person, and the longest unbroken stretch. */
function hoursRules(
  slots: readonly Slot[], rule: EffectiveRule,
  keys: { week: string; stretch?: string; shift?: string },
): RosterFinding[] {
  const maxWeek = num(rule, keys.week, 74);
  const out: RosterFinding[] = [];
  for (const [userId, mine] of byUser(slots)) {
    const duties = mine.filter((s) => s.kind === "duty" && s.mode === "presence")
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    if (duties.length === 0) continue;

    // Rolling seven days anchored at each duty: the strictest honest reading of "in a week", and
    // the one that cannot be defeated by a roster that starts its week on a convenient day.
    let worst = 0;
    let worstAt: Slot | null = null;
    for (const anchor of duties) {
      const from = anchor.startsAt.getTime();
      const to = from + 7 * DAY_MS;
      const total = duties
        .filter((s) => s.startsAt.getTime() >= from && s.startsAt.getTime() < to)
        .reduce((n, s) => n + s.hours, 0);
      if (total > worst) { worst = total; worstAt = anchor; }
    }
    if (worst > maxWeek && worstAt !== null) {
      out.push(finding(rule, {
        userId, assignmentId: worstAt.id,
        params: { weekHours: Math.round(worst * 100) / 100, maxWeekHours: maxWeek, from: worstAt.istDate },
      }));
    }

    if (keys.stretch !== undefined) {
      const maxStretch = num(rule, keys.stretch, 24);
      for (const s of longestStretches(duties)) {
        if (s.hours > maxStretch) {
          out.push(finding(rule, {
            userId, assignmentId: s.id,
            params: { stretchHours: Math.round(s.hours * 100) / 100, maxStretchHours: maxStretch },
          }));
        }
      }
    }
    if (keys.shift !== undefined) {
      const maxShift = num(rule, keys.shift, 12);
      for (const s of duties) {
        if (s.hours > maxShift) {
          out.push(finding(rule, {
            userId, assignmentId: s.id,
            params: { shiftHours: Math.round(s.hours * 100) / 100, maxShiftHours: maxShift },
          }));
        }
      }
    }
  }
  return out;
}

/** Contiguous or overlapping duties merged into the stretch a person actually works. */
function longestStretches(duties: readonly Slot[]): { id: string; hours: number }[] {
  const out: { id: string; hours: number }[] = [];
  let anchor = duties[0];
  if (anchor === undefined) return out;
  let start = anchor.startsAt.getTime();
  let end = anchor.endsAt.getTime();
  for (let i = 1; i < duties.length; i += 1) {
    const s = duties[i]!;
    if (s.startsAt.getTime() <= end) {
      end = Math.max(end, s.endsAt.getTime());
    } else {
      out.push({ id: anchor.id, hours: (end - start) / HOUR_MS });
      anchor = s; start = s.startsAt.getTime(); end = s.endsAt.getTime();
    }
  }
  out.push({ id: anchor.id, hours: (end - start) / HOUR_MS });
  return out;
}

/** `night_one_in_three` — two nights closer together than the rule allows. */
function nightFrequency(slots: readonly Slot[], rule: EffectiveRule): RosterFinding[] {
  const oneInN = num(rule, "oneInN", 3);
  const out: RosterFinding[] = [];
  for (const [userId, mine] of byUser(slots)) {
    const nights = [...new Set(mine.filter((s) => s.isNight && s.kind === "duty").map((s) => s.istDate))]
      .sort();
    for (let i = 1; i < nights.length; i += 1) {
      const gap = Math.round(
        (Date.parse(`${nights[i]!}T00:00:00Z`) - Date.parse(`${nights[i - 1]!}T00:00:00Z`)) / DAY_MS,
      );
      if (gap < oneInN) {
        const at = mine.find((s) => s.istDate === nights[i] && s.isNight);
        out.push(finding(rule, {
          userId, assignmentId: at?.id ?? null,
          params: { nights: [nights[i - 1], nights[i]], gapDays: gap, oneInN },
        }));
      }
    }
  }
  return out;
}

/** `weekly_off` — seven consecutive days of duty with no day off inside them. */
function weeklyOff(
  slots: readonly Slot[], rule: EffectiveRule, dates: readonly string[],
): RosterFinding[] {
  const perDays = num(rule, "perDays", 7);
  const out: RosterFinding[] = [];
  if (dates.length < perDays) return out; // the roster is shorter than the rule's window
  for (const [userId, mine] of byUser(slots)) {
    const onDuty = new Set(mine.filter((s) => s.kind === "duty").map((s) => s.istDate));
    if (onDuty.size === 0) continue;
    for (let i = 0; i + perDays <= dates.length; i += 1) {
      const window = dates.slice(i, i + perDays);
      if (window.every((d) => onDuty.has(d))) {
        out.push(finding(rule, {
          userId,
          params: { from: window[0], to: window[window.length - 1], perDays },
        }));
        break; // one finding per person: the fact is "no weekly off", said once
      }
    }
  }
  return out;
}

/** `unit_min_jr` / `unit_min_sr` — a unit's own strength, on days that unit actually works. */
function unitMinimum(
  slots: readonly Slot[], rule: EffectiveRule, cadre: RosterCadre,
): RosterFinding[] {
  const min = num(rule, "minCount", 1);
  const out: RosterFinding[] = [];
  const byTeamDate = new Map<string, Slot[]>();
  for (const s of slots) {
    if (s.teamId === null || s.kind !== "duty") continue;
    const k = `${s.teamId}\u0000${s.istDate}`;
    byTeamDate.set(k, [...(byTeamDate.get(k) ?? []), s]);
  }
  for (const [k, day] of byTeamDate) {
    // The population must exist: a team with no duty that day is not a team failing its minimum.
    const [teamId, istDate] = k.split("\u0000") as [string, string];
    const cover = new Set(
      day.filter((s) => s.cadre === cadre && s.userId !== null && !s.supernumerary && s.counts)
        .map((s) => s.userId!),
    );
    if (cover.size < min) {
      out.push(finding(rule, {
        params: { teamId, istDate, cadre, present: cover.size, minCount: min },
      }));
    }
  }
  return out.sort((a, b) =>
    `${a.params.teamId}${a.params.istDate}`.localeCompare(`${b.params.teamId}${b.params.istDate}`));
}

/**
 * `requirement_shortfall` — the hospital's own rows, evaluated per day class.
 *
 * The finding carries the REQUIREMENT's authority and citation in `params` rather than the rule's,
 * because "two JRs because the NMC says so" and "two JRs because we decided so" are different
 * sentences to the head reading them.
 */
function requirementShortfalls(
  slots: readonly Slot[],
  rule: EffectiveRule,
  requirements: readonly (typeof rosterRequirements.$inferSelect)[],
  dates: readonly string[],
  dayClassOf: (d: string) => string,
  credentialAt: (userId: string, key: string, at: Date) => boolean,
): RosterFinding[] {
  const out: RosterFinding[] = [];
  for (const req of requirements) {
    for (const istDate of dates) {
      const cls = dayClassOf(istDate);
      if (req.dayClass !== "any" && req.dayClass !== cls) continue;

      const inScope = slots.filter((s) => {
        if (s.istDate !== istDate || s.kind !== "duty") return false;
        if (s.positionKey !== req.positionKey) return false;
        if (req.shiftDefId !== null && s.id !== null && req.shiftDefId !== undefined) {
          // A requirement naming a shift speaks only about slots in that shift.
          if ((s as { shiftDefId?: string | null }).shiftDefId !== req.shiftDefId) return false;
        }
        if (req.scopeType === "team") return s.teamId === req.scopeId;
        if (req.scopeType === "department") return s.departmentId === req.scopeId;
        return s.locationResourceId === req.scopeId;
      });
      // Population check: a scope with nothing rostered on a date is not a scope in shortfall.
      if (inScope.length === 0) continue;

      const covering = inScope.filter((s) =>
        s.userId !== null
        && !s.supernumerary
        && s.counts
        && (req.credentialKey === null || credentialAt(s.userId, req.credentialKey, s.startsAt)));

      const have = new Set(covering.map((s) => s.userId!)).size;
      if (have < req.minCount) {
        out.push(finding(rule, {
          params: {
            requirementId: req.id, positionKey: req.positionKey, scopeType: req.scopeType,
            scopeId: req.scopeId, istDate, dayClass: req.dayClass,
            present: have, minCount: req.minCount,
            vacant: inScope.filter((s) => s.userId === null).length,
            supernumerary: inScope.filter((s) => s.supernumerary).length,
            authority: req.authority, citation: req.citation,
          },
        }));
      }
    }
  }
  return out;
}

const byUser = (slots: readonly Slot[]): Map<string, Slot[]> => {
  const m = new Map<string, Slot[]>();
  for (const s of slots) {
    if (s.userId === null) continue;
    m.set(s.userId, [...(m.get(s.userId) ?? []), s]);
  }
  return new Map([...m].sort(([a], [b]) => a.localeCompare(b)));
};

/* ═══════════════════════════════════ feasibility (S4) ═══════════════════════════════════ */

export type FeasibilityInput = {
  /** Residents available to take the nights. */
  readonly residents: number;
  /** How many of them the nights are shared between — the unit alone, or the department's pool. */
  readonly poolSize?: number;
  readonly nightHours?: number;
  readonly dayHours?: number;
  readonly dayShiftsPerWeek?: number;
  readonly limitHours?: number;
};

export type Feasibility = {
  readonly hoursPerWeek: number;
  readonly nightsPerWeek: number;
  readonly residentsPerUnit: number;
  readonly limitHours: number;
  readonly feasible: boolean;
};

/**
 * CAN THIS PATTERN BE STAFFED AT THIS STRENGTH — in hours per week and residents per unit.
 *
 * Pure arithmetic, and deliberately so: it answers before anybody drafts anything, which is when a
 * HOD actually asks. Stress test S4 is the case it exists for. Three junior residents covering
 * their own unit's nights take every third night — 2.33 nights a week, 16 hours each, on top of
 * their day duties — and land past 74 hours. The same three in a department pool of twelve take
 * one night in twelve and land comfortably inside it. The difference between those two numbers is
 * the entire argument for pooling nights, and it is arithmetic rather than opinion.
 */
export function templateFeasibility(input: FeasibilityInput): Feasibility {
  const residents = Math.max(1, input.residents);
  const pool = Math.max(1, input.poolSize ?? residents);
  const nightHours = input.nightHours ?? 16;
  const dayHours = input.dayHours ?? 8;
  const dayShifts = input.dayShiftsPerWeek ?? 6;
  const limitHours = input.limitHours ?? 74;

  const nightsPerWeek = 7 / pool;
  const hoursPerWeek = nightsPerWeek * nightHours + dayShifts * dayHours;
  return {
    hoursPerWeek: Math.round(hoursPerWeek * 100) / 100,
    nightsPerWeek: Math.round(nightsPerWeek * 100) / 100,
    residentsPerUnit: residents,
    limitHours,
    feasible: hoursPerWeek <= limitHours,
  };
}

/* ═══════════════════════════════════════ validate ═══════════════════════════════════════ */

/** The same read `periodWithAssignments` does, done here so the publish gate's cycle stays open. */
async function loadPeriod(
  exec: Db | Tx, periodId: string,
): Promise<{ period: RosterPeriodRow; assignments: RosterAssignmentRow[] }> {
  const period = (await (exec as Db).select().from(rosterPeriods)
    .where(eq(rosterPeriods.id, periodId)))[0];
  if (period === undefined) throw new RosterError("unknown_period", undefined, { periodId });
  const assignments = await (exec as Db).select().from(rosterAssignments)
    .where(eq(rosterAssignments.periodId, periodId))
    .orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id));
  return { period, assignments };
}

/**
 * Every finding a roster produces, worst first. **Writes nothing.**
 */
export async function validate(
  exec: Db | Tx, input: ValidateInput,
): Promise<RosterFinding[]> {
  const loaded = typeof input === "string"
    ? await loadPeriod(exec, input)
    : { period: input.period, assignments: [...input.assignments] };
  const period = loaded.period;
  const assignments = loaded.assignments.filter((a) => a.liveTo === null);

  const positions = await (exec as Db).select().from(rosterPositions);
  const posByKey = new Map(positions.map((p) => [p.key, p]));

  const slots: Slot[] = assignments.map((a) => {
    const p = posByKey.get(a.positionKey);
    const hours = (a.endsAt.getTime() - a.startsAt.getTime()) / HOUR_MS;
    return {
      id: a.id,
      userId: a.userId,
      positionKey: a.positionKey,
      cadre: (p?.cadre ?? "support") as RosterCadre,
      counts: p?.countsTowardRequirements ?? true,
      supernumerary: a.supernumerary,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      hours,
      mode: a.mode,
      kind: a.kind,
      teamId: a.teamId,
      departmentId: a.departmentId,
      locationResourceId: a.locationResourceId,
      istDate: istDateOfInstant(a.startsAt),
      isNight: touchesNight(a.startsAt, a.endsAt),
      topic: a.topic,
      shiftDefId: a.shiftDefId,
    } as Slot;
  });

  const dates: string[] = [];
  for (
    let d = istDateOfInstant(period.startsAt);
    Date.parse(`${d}T00:00:00Z`) < period.endsAt.getTime() + 330 * 60_000;
    d = addIstDays(d, 1)
  ) {
    dates.push(d);
    if (dates.length > 400) break; // a roster longer than a year is not a roster
  }

  const holidayRows = dates.length === 0 ? [] : await (exec as Db)
    .select().from(rosterHolidays).where(inArray(rosterHolidays.istDate, dates));
  const holidays = new Set(holidayRows.map((h) => h.istDate));
  const dayClassOf = (d: string): string => {
    if (holidays.has(d)) return "holiday";
    const w = istWeekday(d);
    return w === 0 ? "sunday" : w === 6 ? "saturday" : "weekday";
  };

  const rules = await rulesInForce(exec, period.departmentId, dates[0] ?? istDateOfInstant(period.startsAt));
  const ruleBy = new Map(rules.map((r) => [r.key, r]));

  const requirements = await (exec as Db).select().from(rosterRequirements)
    .where(eq(rosterRequirements.active, true));
  const scoped = requirements.filter((r) =>
    (r.scopeType === "department" && r.scopeId === period.departmentId)
    || (r.scopeType === "team" && slots.some((s) => s.teamId === r.scopeId))
    || (r.scopeType === "location" && slots.some((s) => s.locationResourceId === r.scopeId)));

  // Credentials, read once for everyone on the roster rather than per slot.
  const userIds = [...new Set(slots.map((s) => s.userId).filter((u): u is string => u !== null))];
  const creds = userIds.length === 0 ? [] : await (exec as Db).select().from(staffCredentials)
    .where(inArray(staffCredentials.userId, userIds));
  const credentialAt = (userId: string, key: string, at: Date): boolean =>
    creds.some((c) => c.userId === userId && c.credentialKey === key
      && c.validFrom.getTime() <= at.getTime()
      && (c.validTo === null || c.validTo.getTime() > at.getTime()));

  const out: RosterFinding[] = [];
  const run = (key: string, fn: (r: EffectiveRule) => RosterFinding[]): void => {
    const r = ruleBy.get(key);
    if (r !== undefined) out.push(...fn(r));
  };

  run("slot_over_24h", (r) => slotOver24h(slots, r));
  run("rest_after_duty", (r) => restAfterDuty(slots, r));
  run("weekly_hours_74", (r) => hoursRules(slots, r, { week: "maxWeekHours", stretch: "maxStretchHours" }));
  run("shift_12h_week_48h", (r) => hoursRules(slots, r, { week: "maxWeekHours", shift: "maxShiftHours" }));
  run("night_one_in_three", (r) => nightFrequency(slots, r));
  run("weekly_off", (r) => weeklyOff(slots, r, dates));
  run("unit_min_jr", (r) => unitMinimum(slots, r, "junior_resident"));
  run("unit_min_sr", (r) => unitMinimum(slots, r, "senior_resident"));
  run("requirement_shortfall", (r) =>
    requirementShortfalls(slots, r, scoped, dates, dayClassOf, credentialAt));

  // `credential_expired` — a BLOCK, and the only one that needs the requirement rows to know
  // which credential a post actually demands.
  run("credential_expired", (r) => {
    const res: RosterFinding[] = [];
    for (const req of scoped) {
      if (req.credentialKey === null) continue;
      for (const s of slots) {
        if (s.userId === null || s.kind !== "duty" || s.positionKey !== req.positionKey) continue;
        const scopeHit = req.scopeType === "team" ? s.teamId === req.scopeId
          : req.scopeType === "department" ? s.departmentId === req.scopeId
            : s.locationResourceId === req.scopeId;
        if (!scopeHit) continue;
        if (!credentialAt(s.userId, req.credentialKey, s.startsAt)) {
          res.push(finding(r, {
            userId: s.userId, assignmentId: s.id,
            params: {
              credentialKey: req.credentialKey, requirementId: req.id, positionKey: s.positionKey,
              istDate: s.istDate,
            },
          }));
        }
      }
    }
    return res;
  });

  // `rostered_while_absent` — approved leave against the duties actually planned. Read once for
  // the whole period rather than per slot; `absentUserIds` is the same reader V13 uses, so the
  // validator and the resolver cannot disagree about who is away.
  const absentIds = new Set(await absentUserIds(exec, period.startsAt, period.endsAt));
  run("rostered_while_absent", (r) => slots
    .filter((s) => s.userId !== null && s.kind === "duty" && absentIds.has(s.userId))
    .map((s) => finding(r, {
      userId: s.userId, assignmentId: s.id,
      // The KIND of leave is deliberately not here (D6): that a person is away is the roster's
      // business, why they are away is not. `absences.ts` redacts it for the same reason.
      params: { istDate: s.istDate, positionKey: s.positionKey },
    })));

  run("credential_expiring", (r) => {
    const within = num(r, "withinDays", 30);
    const horizon = new Date(period.endsAt.getTime() + within * DAY_MS);
    return creds
      .filter((c) => c.validTo !== null
        && c.validTo.getTime() >= period.startsAt.getTime()
        && c.validTo.getTime() < horizon.getTime())
      .map((c) => finding(r, {
        userId: c.userId,
        params: {
          credentialKey: c.credentialKey, expiresAt: c.validTo!.toISOString(), withinDays: within,
        },
      }));
  });

  const rank: Record<RosterRuleSeverity, number> = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) =>
    rank[a.severity] - rank[b.severity]
    || a.ruleKey.localeCompare(b.ruleKey)
    || (a.userId ?? "").localeCompare(b.userId ?? ""));
}

/**
 * WHAT AN ACCEPTANCE IS ABOUT — the rule, the slot and the person, not just the rule.
 *
 * Keyed this finely on purpose: accepting "Dr Rao's registration lapses on the 12th" must not also
 * accept the same rule firing for somebody else on the same roster. A coarser key would let one
 * signature clear a finding nobody had read.
 */
export const findingKey = (f: Pick<RosterFinding, "ruleKey" | "assignmentId" | "userId">): string =>
  `${f.ruleKey}\u0000${f.assignmentId ?? ""}\u0000${f.userId ?? ""}`;

/** The findings that stop a publish: `block`, minus the ones a named human has accepted. */
export const blockingFindings = (
  findings: readonly RosterFinding[], acceptedKeys: ReadonlySet<string> = new Set(),
): RosterFinding[] =>
  findings.filter((f) => f.severity === "block" && !acceptedKeys.has(findingKey(f)));
