import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  ROSTER_ASSIGNMENT_KINDS, ROSTER_ASSIGNMENT_MODES, ROSTER_ASSIGNMENT_SOURCES, ROSTER_SCOPE_TYPES,
  rosterAssignments, rosterPeriods,
} from "../../kernel/db/schema/roster";
import { roles, users } from "../../kernel/db/schema/auth";
import { resources } from "../../kernel/db/schema/resources";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, requireRosterPermission } from "./access";
import { rosterPeriodDrafted, rosterPeriodPublished } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type {
  RosterAssignmentKind, RosterAssignmentMode, RosterAssignmentSource, RosterScopeType,
} from "../../kernel/db/schema/roster";

/**
 * PLAN 20 T1 — drafting a roster period, filling it, and the PUBLICATION GATE.
 *
 * Read `kernel/db/schema/roster.ts`'s header first: windows not days (D7), draft until published
 * (D3), `effective` and why it is denormalised, presence versus call.
 *
 * ═══ WHAT PUBLISHING DOES, IN ONE TRANSACTION ═══
 *
 *   1. locks the draft, and the currently published version for the same scope and start, if any;
 *   2. takes the old version's rows OUT of effect and marks it `superseded`, pointing at the new one;
 *   3. checks that nobody in the new version would be PHYSICALLY IN TWO PLACES — against the draft
 *      itself and against every other live roster (a resident borrowed by a second unit is exactly
 *      how this happens) — and refuses in a sentence that names the person and both windows;
 *   4. brings the new rows INTO effect, flips the status, emits ONE event naming both versions.
 *
 * Step 2 before step 4 is load-bearing: the exclusion constraint is checked per statement, and v2
 * is usually v1 with three cells changed — the same people in the same windows.
 *
 * ═══ v2 TAKES OVER WHOLE, AT THE INSTANT OF PUBLICATION ═══
 *
 * There is no splice in which v1 keeps "the shifts already running". A resolver asking about NOW
 * reads `effective` rows and gets v2. The question a court asks two years later — *who was rostered
 * at 03:10 that night, AS IT WAS KNOWN THAT NIGHT* — is answered from the version whose
 * `[published_at, superseded_at)` contains 03:10, which is why a superseded period and its rows are
 * never edited and never deleted. Nothing in this file deletes a row outside a DRAFT.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 *
 * Rest after a night, one night in three, weekly off, staffing ratios, leave clashes: those are the
 * VALIDATOR's (phase 20-U U3) — findings a human can accept with a reason, not refusals. What is
 * refused here is only what can never be right: a window that ends before it starts, a slot outside
 * its period, an empty roster, and one body in two rooms.
 */

export type RosterPeriodRow = typeof rosterPeriods.$inferSelect;
export type RosterAssignmentRow = typeof rosterAssignments.$inferSelect;

/** A presence window longer than this is a typing error (a wrong month, a wrong year), not a duty. */
export const MAX_PRESENCE_HOURS = 36;
const HOUR_MS = 3_600_000;

const iso = (d: Date): string => d.toISOString();

function assertWindow(startsAt: Date, endsAt: Date, what: string): void {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new RosterError("invalid_window", `${what}: the start or the end is not a real instant`);
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new RosterError(
      "invalid_window",
      `${what} ends (${iso(endsAt)}) at or before it starts (${iso(startsAt)})`,
      { startsAt: iso(startsAt), endsAt: iso(endsAt) },
    );
  }
}

async function lockPeriod(tx: Tx, periodId: string): Promise<RosterPeriodRow> {
  const rows = await tx.select().from(rosterPeriods).where(eq(rosterPeriods.id, periodId)).for("update");
  const period = rows[0];
  if (period === undefined) throw new RosterError("unknown_period", `there is no roster period ${periodId}`, { periodId });
  return period;
}

function assertDraft(period: RosterPeriodRow, verb: string): void {
  if (period.status !== "draft") {
    throw new RosterError(
      "period_not_draft",
      `"${period.title}" (version ${period.version}) is ${period.status} — a roster people are working to is never edited. `
      + `To ${verb}, draft a new version from it and publish that`,
      { periodId: period.id, status: period.status, version: period.version },
    );
  }
}

/* ═══════════════════════════════ drafting ═══════════════════════════════ */

export interface DraftPeriodInput {
  scopeType: RosterScopeType;
  scopeId?: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * Start this draft as a copy of another version's assignments. It must cover the same scope and
   * start. This is how a published month is AMENDED: copy, change three cells, publish.
   */
  copyFromPeriodId?: string | null;
}

export async function draftPeriod(
  tx: Tx, actor: Actor, input: DraftPeriodInput,
): Promise<{ periodId: string; version: number; copiedAssignments: number }> {
  await requireRosterPermission(tx, actor, ROSTER_MANAGE);
  assertWindow(input.startsAt, input.endsAt, "the period");
  if (!(ROSTER_SCOPE_TYPES as readonly string[]).includes(input.scopeType)) {
    throw new RosterError("invalid_window", `"${input.scopeType}" is not something a roster can cover`);
  }
  const scopeId = input.scopeType === "hospital" ? null : (input.scopeId ?? null);
  if (input.scopeType !== "hospital" && (scopeId === null || scopeId.trim() === "")) {
    throw new RosterError("invalid_window", `a ${input.scopeType} roster must say which ${input.scopeType} it covers`);
  }
  const title = input.title.trim();
  if (title === "") throw new RosterError("invalid_window", "a roster needs a name a person would recognise");

  const sameSeries = and(
    eq(rosterPeriods.scopeType, input.scopeType),
    sql`coalesce(${rosterPeriods.scopeId}, '') = ${scopeId ?? ""}`,
    eq(rosterPeriods.startsAt, input.startsAt),
  );

  let source: RosterPeriodRow | undefined;
  if (input.copyFromPeriodId != null) {
    source = (await tx.select().from(rosterPeriods).where(eq(rosterPeriods.id, input.copyFromPeriodId)))[0];
    if (source === undefined) {
      throw new RosterError("unknown_period", `there is no roster period ${input.copyFromPeriodId} to copy from`);
    }
    if (source.scopeType !== input.scopeType || (source.scopeId ?? "") !== (scopeId ?? "")
      || source.startsAt.getTime() !== input.startsAt.getTime()) {
      throw new RosterError(
        "invalid_window",
        `"${source.title}" covers a different roster — a new version can only be copied from an earlier version of itself`,
        { copyFromPeriodId: source.id },
      );
    }
  }

  const latest = await tx.select({ version: rosterPeriods.version }).from(rosterPeriods)
    .where(sameSeries).orderBy(desc(rosterPeriods.version)).limit(1);
  const version = (latest[0]?.version ?? 0) + 1;
  const periodId = newId();

  try {
    await tx.insert(rosterPeriods).values({
      id: periodId, scopeType: input.scopeType, scopeId, title,
      startsAt: input.startsAt, endsAt: input.endsAt, version, status: "draft",
      createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    // Two people drafting the next version at once: the unique index picks one, and the other is
    // told so rather than shown a constraint name.
    if (isUniqueViolation(e, "roster_periods_scope_start_version_ux")) {
      throw new RosterError("version_conflict", `somebody else has just drafted version ${version} of "${title}" — open theirs`, { version });
    }
    throw e;
  }

  let copiedAssignments = 0;
  if (source !== undefined) {
    const rows = await tx.select().from(rosterAssignments).where(eq(rosterAssignments.periodId, source.id));
    // A slot that no longer starts inside the new window is dropped, not smuggled in.
    const kept = rows.filter((r) => r.startsAt >= input.startsAt && r.startsAt < input.endsAt);
    if (kept.length > 0) {
      await tx.insert(rosterAssignments).values(kept.map((r) => ({
        ...r, id: newId(), periodId, effective: false,
        createdBy: actor.id, updatedBy: actor.id, createdAt: undefined, updatedAt: undefined,
      })));
    }
    copiedAssignments = kept.length;
  }

  await appendEvent(tx, rosterPeriodDrafted.make({
    payload: {
      periodId, scopeType: input.scopeType, scopeId, startsAt: iso(input.startsAt), endsAt: iso(input.endsAt),
      version, copiedFromPeriodId: source?.id ?? null,
    },
    actor,
    correlationId: periodId,
  }));
  return { periodId, version, copiedAssignments };
}

/* ═══════════════════════════════ assignments ═══════════════════════════════ */

export interface AssignInput {
  userId: string;
  roleKey: string;
  startsAt: Date;
  endsAt: Date;
  mode?: RosterAssignmentMode;
  kind?: RosterAssignmentKind;
  unitId?: string | null;
  locationResourceId?: string | null;
  batchRef?: string | null;
  topic?: string | null;
  source?: RosterAssignmentSource;
  note?: string | null;
}

export async function assign(
  tx: Tx, actor: Actor, periodId: string, input: AssignInput,
): Promise<{ assignmentId: string }> {
  await requireRosterPermission(tx, actor, ROSTER_MANAGE);
  const period = await lockPeriod(tx, periodId);
  assertDraft(period, "change who is on");

  const mode = input.mode ?? "presence";
  const kind = input.kind ?? "duty";
  const source = input.source ?? "manual";
  if (!(ROSTER_ASSIGNMENT_MODES as readonly string[]).includes(mode)
    || !(ROSTER_ASSIGNMENT_KINDS as readonly string[]).includes(kind)
    || !(ROSTER_ASSIGNMENT_SOURCES as readonly string[]).includes(source)) {
    throw new RosterError("invalid_window", "mode, kind or source is not one the roster knows", { mode, kind, source });
  }

  assertWindow(input.startsAt, input.endsAt, "the duty");
  // A duty belongs to the period its START falls in. Its end may run past the period's end: the
  // night of the 31st ends on the 1st, and splitting it in two would roster one person twice.
  if (input.startsAt < period.startsAt || input.startsAt >= period.endsAt) {
    throw new RosterError(
      "outside_period",
      `this duty starts ${iso(input.startsAt)}, outside "${period.title}" (${iso(period.startsAt)} to ${iso(period.endsAt)})`,
      { periodId, startsAt: iso(input.startsAt) },
    );
  }
  const hours = (input.endsAt.getTime() - input.startsAt.getTime()) / HOUR_MS;
  if (mode === "presence" && hours > MAX_PRESENCE_HOURS) {
    throw new RosterError(
      "invalid_window",
      `a duty of ${Math.round(hours)} hours in one place is a typing mistake, not a shift — check the dates `
      + `(the longest the roster accepts is ${MAX_PRESENCE_HOURS} hours; on-call may be as long as the period)`,
      { hours: Math.round(hours), maxHours: MAX_PRESENCE_HOURS },
    );
  }

  const person = (await tx.select({ id: users.id, active: users.active, fullName: users.fullName })
    .from(users).where(eq(users.id, input.userId)))[0];
  if (person === undefined || !person.active) {
    throw new RosterError(
      "unknown_user",
      person === undefined ? `there is no member of staff ${input.userId}` : `${person.fullName} no longer works here and cannot be put on a roster`,
      { userId: input.userId },
    );
  }
  const role = (await tx.select({ key: roles.key }).from(roles).where(eq(roles.key, input.roleKey)))[0];
  if (role === undefined) throw new RosterError("unknown_role", `"${input.roleKey}" is not a role in this hospital`, { roleKey: input.roleKey });
  if (input.locationResourceId != null) {
    const place = (await tx.select({ id: resources.id }).from(resources).where(eq(resources.id, input.locationResourceId)))[0];
    if (place === undefined) throw new RosterError("unknown_location", `there is no place ${input.locationResourceId}`, { locationResourceId: input.locationResourceId });
  }

  const assignmentId = newId();
  await tx.insert(rosterAssignments).values({
    id: assignmentId, periodId, userId: input.userId, roleKey: input.roleKey,
    startsAt: input.startsAt, endsAt: input.endsAt, mode, kind, source,
    unitId: input.unitId ?? null, locationResourceId: input.locationResourceId ?? null,
    batchRef: input.batchRef ?? null, topic: input.topic ?? null, note: input.note ?? null,
    effective: false, createdBy: actor.id, updatedBy: actor.id,
  });
  return { assignmentId };
}

/** A DRAFT is scratch paper: a row is simply removed. Nothing published can reach this function. */
export async function unassign(tx: Tx, actor: Actor, assignmentId: string): Promise<void> {
  await requireRosterPermission(tx, actor, ROSTER_MANAGE);
  const row = (await tx.select({ periodId: rosterAssignments.periodId })
    .from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId)))[0];
  if (row === undefined) throw new RosterError("unknown_assignment", `there is no duty ${assignmentId}`, { assignmentId });
  const period = await lockPeriod(tx, row.periodId);
  assertDraft(period, "take somebody off");
  await tx.delete(rosterAssignments).where(eq(rosterAssignments.id, assignmentId));
}

/* ═══════════════════════════════ the publication gate ═══════════════════════════════ */

export interface PresenceClash {
  userId: string;
  fullName: string;
  a: { assignmentId: string; periodTitle: string; startsAt: string; endsAt: string };
  b: { assignmentId: string; periodTitle: string; startsAt: string; endsAt: string };
}

/**
 * Everybody in `periodId` who would be physically in two places if it went live now: against the
 * period's own rows, and against every OTHER live roster. Exported because the validator (20-U U3)
 * shows these as findings long before anybody presses publish.
 */
export async function presenceClashes(exec: Db | Tx, periodId: string): Promise<PresenceClash[]> {
  const result = await exec.execute(sql`
    select a.user_id as "userId", u.full_name as "fullName",
           a.id as "aId", pa.title as "aTitle", a.starts_at as "aStart", a.ends_at as "aEnd",
           b.id as "bId", pb.title as "bTitle", b.starts_at as "bStart", b.ends_at as "bEnd"
      from roster_assignments a
      join roster_assignments b
        on b.user_id = a.user_id and b.id <> a.id and b.mode = 'presence'
       and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
       and ((b.period_id = a.period_id and a.id < b.id) or (b.period_id <> a.period_id and b.effective))
      join roster_periods pa on pa.id = a.period_id
      join roster_periods pb on pb.id = b.period_id
      join users u on u.id = a.user_id
     where a.period_id = ${periodId} and a.mode = 'presence'
     order by a.starts_at, a.id, b.id`);
  const asIso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    userId: String(r.userId), fullName: String(r.fullName),
    a: { assignmentId: String(r.aId), periodTitle: String(r.aTitle), startsAt: asIso(r.aStart), endsAt: asIso(r.aEnd) },
    b: { assignmentId: String(r.bId), periodTitle: String(r.bTitle), startsAt: asIso(r.bStart), endsAt: asIso(r.bEnd) },
  }));
}

export async function publishPeriod(
  tx: Tx, actor: Actor, periodId: string, now: Date = new Date(),
): Promise<{ version: number; assignmentCount: number; supersededPeriodId: string | null }> {
  await requireRosterPermission(tx, actor, ROSTER_PUBLISH);
  const period = await lockPeriod(tx, periodId);
  assertDraft(period, "publish again");

  const counted = await tx.select({ n: sql<number>`count(*)::int` })
    .from(rosterAssignments).where(eq(rosterAssignments.periodId, periodId));
  const assignmentCount = counted[0]?.n ?? 0;
  if (assignmentCount === 0) {
    throw new RosterError(
      "empty_period",
      `"${period.title}" has nobody on it. Publishing it would make the hospital's answer to "who is on?" — nobody`,
      { periodId },
    );
  }

  // (2) the version people are working to now, if there is one — out of effect FIRST.
  const live = (await tx.select().from(rosterPeriods).where(and(
    eq(rosterPeriods.siteId, period.siteId),
    eq(rosterPeriods.scopeType, period.scopeType),
    sql`coalesce(${rosterPeriods.scopeId}, '') = ${period.scopeId ?? ""}`,
    eq(rosterPeriods.startsAt, period.startsAt),
    eq(rosterPeriods.status, "published"),
    ne(rosterPeriods.id, periodId),
  )).for("update"))[0];
  if (live !== undefined) {
    await tx.update(rosterAssignments).set({ effective: false, updatedBy: actor.id, updatedAt: now })
      .where(eq(rosterAssignments.periodId, live.id));
    await tx.update(rosterPeriods).set({
      status: "superseded", supersededAt: now, supersededByPeriodId: periodId, updatedBy: actor.id, updatedAt: now,
    }).where(eq(rosterPeriods.id, live.id));
  }

  // (3) one body, two rooms — said in a sentence, before the constraint has to say it in a code.
  const clashes = await presenceClashes(tx, periodId);
  if (clashes.length > 0) {
    const first = clashes[0]!;
    const elsewhere = first.b.periodTitle === first.a.periodTitle ? "twice in this roster" : `here and in "${first.b.periodTitle}"`;
    throw new RosterError(
      "presence_overlap",
      `${first.fullName} would have to be in two places at once — ${elsewhere}: `
      + `${first.a.startsAt} to ${first.a.endsAt}, and ${first.b.startsAt} to ${first.b.endsAt}`
      + (clashes.length > 1 ? ` (and ${clashes.length - 1} more like it)` : "")
      + ". On-call may overlap a duty; two duties in person may not",
      { clashes },
    );
  }

  // (4) into effect.
  try {
    await tx.update(rosterAssignments).set({ effective: true, updatedBy: actor.id, updatedAt: now })
      .where(eq(rosterAssignments.periodId, periodId));
  } catch (e) {
    // The backstop for a race the pre-check cannot see: two rosters naming one person, published
    // in the same second by two people. The database refuses the second; say it in words.
    if (isExclusionViolation(e, "roster_assignments_no_double_presence_excl")) {
      throw new RosterError(
        "presence_overlap",
        "another roster naming one of these people was published a moment ago, and they would now be in two places at once — open this roster again to see who",
        { periodId },
      );
    }
    throw e;
  }
  await tx.update(rosterPeriods).set({
    status: "published", publishedAt: now, publishedBy: actor.id, updatedBy: actor.id, updatedAt: now,
  }).where(eq(rosterPeriods.id, periodId));

  await appendEvent(tx, rosterPeriodPublished.make({
    payload: {
      periodId, scopeType: period.scopeType, scopeId: period.scopeId,
      startsAt: iso(period.startsAt), endsAt: iso(period.endsAt), version: period.version,
      assignmentCount, supersededPeriodId: live?.id ?? null,
    },
    actor,
    correlationId: periodId,
  }));
  return { version: period.version, assignmentCount, supersededPeriodId: live?.id ?? null };
}

/* ═══════════════════════════════ reads ═══════════════════════════════ */

export async function periodWithAssignments(
  exec: Db | Tx, periodId: string,
): Promise<{ period: RosterPeriodRow; assignments: RosterAssignmentRow[] }> {
  const period = (await exec.select().from(rosterPeriods).where(eq(rosterPeriods.id, periodId)))[0];
  if (period === undefined) throw new RosterError("unknown_period", `there is no roster period ${periodId}`, { periodId });
  const assignments = await exec.select().from(rosterAssignments)
    .where(eq(rosterAssignments.periodId, periodId))
    .orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id));
  return { period, assignments };
}

/** Every version of every roster whose window touches `[from, to)`, newest version first. */
export async function periodsTouching(
  exec: Db | Tx, from: Date, to: Date, statuses: readonly RosterPeriodRow["status"][] = ["draft", "published"],
): Promise<RosterPeriodRow[]> {
  return exec.select().from(rosterPeriods)
    .where(and(
      lt(rosterPeriods.startsAt, to), gt(rosterPeriods.endsAt, from),
      inArray(rosterPeriods.status, [...statuses]),
    ))
    .orderBy(asc(rosterPeriods.startsAt), asc(rosterPeriods.scopeType), desc(rosterPeriods.version));
}

/* ═══════════════════════════════ pg error sniffing ═══════════════════════════════ */

function pgError(e: unknown): { code?: string; constraint?: string } | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur != null && typeof cur === "object"; i += 1) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string" && c.code.length === 5) {
      return { code: c.code, constraint: typeof c.constraint === "string" ? c.constraint : undefined };
    }
    cur = c.cause;
  }
  return null;
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const pg = pgError(e);
  return pg?.code === "23505" && pg.constraint === constraint;
}

function isExclusionViolation(e: unknown, constraint: string): boolean {
  const pg = pgError(e);
  return pg?.code === "23P01" && pg.constraint === constraint;
}
