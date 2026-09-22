import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { rosterCycleEntries, rosterCycles, rosterTeams } from "../../kernel/db/schema/roster";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterActivity } from "../../kernel/db/schema/roster";

/**
 * PHASE R (R7) — **THE TEMPLATE GALLERY** (stress test H).
 *
 * ═══ WHY A GALLERY AND NOT A DEFAULT ═══
 *
 * Every department in an Indian teaching hospital runs a take pattern, and they are not the same
 * pattern. A two-unit ENT takes alternate days; a five-unit Medicine runs a rolling one-in-five; a
 * four-unit OBG shares a labour room that never closes. A system that shipped ONE default would be
 * wrong for every department but one, and the HOD would either fight it or ignore it.
 *
 * So these are starting points a head PICKS, each with the shape the stress test found in real
 * colleges — and **each is a DRAFT when applied**, because the establishment is the department's
 * and this file's arithmetic is a suggestion.
 *
 * ═══ THE SEQUENCE INSIDE A TEMPLATE IS THE ONE EVERY UNIT ACTUALLY WORKS ═══
 *
 * Emergency day → post-take round → theatre → ward and teaching. It is not arbitrary: a unit that
 * admitted all night rounds on its own admissions the next morning, which is why `post_take`
 * follows `take` and never precedes it, and why the theatre day is third rather than second.
 */

export interface CycleTemplate {
  key: string;
  label: string;
  /** How many units the pattern is written for. */
  units: number;
  cycleDays: number;
  /** `dayIndex` is relative to the cycle; `unitOffset` is which unit, relative to day 0's. */
  entries: readonly {
    dayIndex: number;
    unitOffset: number;
    activity: RosterActivity;
    startMinute: number;
    durationMinutes: number;
  }[];
  /** What a head should know before picking it — shown beside the template, not buried. */
  note: string;
}

const TAKE = { activity: "take" as const, startMinute: 480, durationMinutes: 1440 };
const OPD = { activity: "opd" as const, startMinute: 540, durationMinutes: 240 };
const OT = { activity: "elective_ot" as const, startMinute: 540, durationMinutes: 300 };
const POST = { activity: "post_take" as const, startMinute: 480, durationMinutes: 240 };
const WARD = { activity: "ward_teaching" as const, startMinute: 540, durationMinutes: 240 };

/**
 * Six patterns, from the stress test's survey of what colleges actually run. The `units` figure is
 * what the pattern is WRITTEN for; `draftCycleFromTemplate` refuses a department that has fewer,
 * because a five-unit rotation on three units silently gives somebody two takes in five days.
 */
export const CYCLE_TEMPLATES: readonly CycleTemplate[] = [
  {
    key: "two_unit_alternate",
    label: "Two units, alternate days",
    units: 2, cycleDays: 2,
    entries: [
      { dayIndex: 0, unitOffset: 0, ...TAKE },
      { dayIndex: 0, unitOffset: 1, ...OPD },
      { dayIndex: 1, unitOffset: 1, ...TAKE },
      { dayIndex: 1, unitOffset: 0, ...POST },
    ],
    note: "Every other night on take. Sustainable only where the units are large; check the feasibility line before picking it.",
  },
  {
    key: "three_unit_fixed",
    label: "Three units, fixed twice-weekly",
    units: 3, cycleDays: 3,
    entries: [
      { dayIndex: 0, unitOffset: 0, ...TAKE },
      { dayIndex: 1, unitOffset: 0, ...POST },
      { dayIndex: 1, unitOffset: 1, ...TAKE },
      { dayIndex: 2, unitOffset: 2, ...TAKE },
      { dayIndex: 2, unitOffset: 0, ...OT },
    ],
    note: "One in three. The commonest shape in a mid-sized department, and the one NMC's two-JR floor was written around.",
  },
  {
    key: "four_unit_obg",
    label: "Four units with a labour-room pool (OBG)",
    units: 4, cycleDays: 4,
    entries: [
      { dayIndex: 0, unitOffset: 0, ...TAKE },
      { dayIndex: 1, unitOffset: 0, ...POST },
      { dayIndex: 1, unitOffset: 1, ...TAKE },
      { dayIndex: 2, unitOffset: 2, ...TAKE },
      { dayIndex: 2, unitOffset: 0, ...OT },
      { dayIndex: 3, unitOffset: 3, ...TAKE },
      { dayIndex: 3, unitOffset: 0, ...WARD },
    ],
    note: "The labour room never closes, so it is staffed from a department POOL rather than by the take unit — the pool is a team of its own (kind `pool`), not a column on this pattern.",
  },
  {
    key: "five_unit_weekly_fixed",
    label: "Five units, weekly-fixed with a rotating Saturday",
    units: 5, cycleDays: 7,
    entries: [
      { dayIndex: 0, unitOffset: 0, ...TAKE },
      { dayIndex: 1, unitOffset: 1, ...TAKE },
      { dayIndex: 2, unitOffset: 2, ...TAKE },
      { dayIndex: 3, unitOffset: 3, ...TAKE },
      { dayIndex: 4, unitOffset: 4, ...TAKE },
      { dayIndex: 5, unitOffset: 0, ...TAKE },
      { dayIndex: 6, unitOffset: 1, ...TAKE },
    ],
    note: "Each unit has the SAME weekday every week, which is what makes an OPD timetable stable — at the cost of Saturday drifting. The Sunday overlay is separate.",
  },
  {
    key: "five_unit_rolling",
    label: "Five units, rolling one-in-five",
    units: 5, cycleDays: 5,
    entries: [
      { dayIndex: 0, unitOffset: 0, ...TAKE },
      { dayIndex: 1, unitOffset: 0, ...POST },
      { dayIndex: 1, unitOffset: 1, ...TAKE },
      { dayIndex: 2, unitOffset: 2, ...TAKE },
      { dayIndex: 2, unitOffset: 0, ...OT },
      { dayIndex: 3, unitOffset: 3, ...TAKE },
      { dayIndex: 3, unitOffset: 0, ...WARD },
      { dayIndex: 4, unitOffset: 4, ...TAKE },
      { dayIndex: 4, unitOffset: 0, ...OPD },
    ],
    note: "The full sequence — emergency, post-take round, theatre, ward and teaching, OPD — and the shape this phase's own fixtures use. The weekday drifts, which some OPD timetables cannot absorb.",
  },
  {
    key: "single_unit_call",
    label: "One unit: daily OPD, take by call",
    units: 1, cycleDays: 1,
    entries: [
      { dayIndex: 0, unitOffset: 0, ...OPD },
      { dayIndex: 0, unitOffset: 0, ...TAKE },
    ],
    note: "A one-unit department (Dermatology, Psychiatry, Respiratory Medicine) is on take every day, by call from home. The hours-per-week line is the one to read before adopting it.",
  },
];

export function cycleTemplate(key: string): CycleTemplate {
  const t = CYCLE_TEMPLATES.find((x) => x.key === key);
  if (t === undefined) throw new RosterError("unknown_template", undefined, { templateKey: key });
  return t;
}

/**
 * Applies a template to a department's own units, as a **DRAFT**. The head publishes it, or edits
 * it first — this file's arithmetic is a suggestion and `publishCycle` is where a human commits.
 *
 * Refuses a department with fewer units than the pattern is written for, because the failure is
 * silent otherwise: a five-unit rotation on three units gives somebody two takes in five days and
 * looks like a valid cycle.
 */
export async function draftCycleFromTemplate(
  tx: Tx, actor: Actor,
  input: { departmentId: string; templateKey: string; anchorIstDate: string },
): Promise<{ cycleId: string; version: number }> {
  await requireRosterAct(tx, actor, "publish", { departmentId: input.departmentId });
  const template = cycleTemplate(input.templateKey);

  const teams = (await (tx as Db).select().from(rosterTeams)
    .where(eq(rosterTeams.departmentId, input.departmentId)))
    .filter((t) => t.kind === "clinical_unit")
    .sort((a, b) => (a.unitNumber ?? 0) - (b.unitNumber ?? 0));

  if (teams.length < template.units) {
    throw new RosterError(
      "template_needs_more_units",
      `"${template.label}" is written for ${template.units} units and this department has ${teams.length} — `
      + "a pattern applied to fewer units silently gives somebody two takes in one turn",
      { templateKey: template.key, needs: template.units, has: teams.length },
    );
  }

  const existing = await (tx as Db).select({ version: rosterCycles.version }).from(rosterCycles)
    .where(eq(rosterCycles.departmentId, input.departmentId));
  const version = Math.max(0, ...existing.map((c) => c.version)) + 1;

  const cycleId = newId();
  await tx.insert(rosterCycles).values({
    id: cycleId, departmentId: input.departmentId, cycleDays: template.cycleDays,
    anchorIstDate: input.anchorIstDate, version, status: "draft",
    createdBy: actor.id, updatedBy: actor.id,
  });
  await tx.insert(rosterCycleEntries).values(template.entries.map((e) => ({
    id: newId(), cycleId, dayIndex: e.dayIndex, teamId: teams[e.unitOffset]!.id,
    activity: e.activity, startMinute: e.startMinute, durationMinutes: e.durationMinutes,
    createdBy: actor.id, updatedBy: actor.id,
  })));
  return { cycleId, version };
}
