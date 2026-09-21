import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  ROSTER_AMENDMENT_KINDS, ROSTER_ASSIGNMENT_KINDS, ROSTER_ASSIGNMENT_MODES,
  ROSTER_ASSIGNMENT_SOURCES, ROSTER_COVER_SCOPES, ROSTER_OFF_KINDS, ROSTER_SCOPE_TYPES,
  rosterAmendments, rosterAssignments, rosterPeriods, rosterPositions,
} from "../../kernel/db/schema/roster";
import { orgDepartments } from "../../kernel/db/schema/org";
import { roleAssignments, users } from "../../kernel/db/schema/auth";
import { resources } from "../../kernel/db/schema/resources";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { blockingFindings, validate } from "./validator";
import { acceptedFindingKeys } from "./findings";
import {
  rosterAmendmentApplied, rosterDutyChanged, rosterPeriodDrafted, rosterPeriodPublished,
  rosterPeriodSuperseded,
} from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type {
  RosterAmendmentKind, RosterAssignmentKind, RosterAssignmentMode, RosterAssignmentSource,
  RosterCoverScope, RosterOffKind, RosterOrigin, RosterScopeType,
} from "../../kernel/db/schema/roster";

/**
 * PHASE R (R2) — drafting a roster, filling it, PUBLISHING it, and amending it row by row.
 *
 * Read `kernel/db/schema/roster.ts`'s R2 header first: the two time axes, why `effective` is
 * denormalised, and why a small change is an amendment rather than a new version.
 *
 * ═══ WHAT PUBLISHING DOES, IN ONE TRANSACTION AND IN THIS ORDER ═══
 *
 *   0. takes ONE advisory lock, so two publishes anywhere in the hospital cannot interleave;
 *   1. locks each draft, and the live version of each draft's series, if any;
 *   2. refuses a draft whose base is no longer live (V3) or whose content has moved since the
 *      human read it (V4) — both BEFORE anything is written;
 *   3. takes every old version's rows OUT of effect and marks them superseded;
 *   4. checks that nobody would be PHYSICALLY IN TWO PLACES — across the whole set being published
 *      and against every other live roster — and refuses in a sentence naming the person;
 *   5. brings the new rows INTO effect, stamps the content hash, flips the statuses;
 *   6. emits one event per period and one per PERSON whose duties moved.
 *
 * **Step 3 before step 5 is load-bearing**: the exclusion constraint is checked per statement, and
 * v2 is usually v1 with three cells changed — the same people in the same windows.
 *
 * **And step 4 across the whole SET is the S2(b) fix.** Two units exchanging a resident for one
 * night cannot be published one at a time in either order: whichever goes first names somebody
 * still live in the other unit's old roster. `publishPeriods` takes a list for that reason, and
 * `publishPeriod` is a one-element call of it so the two can never drift apart.
 *
 * ═══ EVERY STAMP COMES FROM THE DATABASE (V6) ═══
 *
 * No exported function here takes a `now`. `published_at`, `superseded_at`, `applied_at`,
 * `live_from` and `live_to` are read from `now()` — which is `transaction_timestamp()`, and that
 * is the RIGHT choice here rather than a hazard: every row a single publish or amendment touches
 * must share one instant, or "as known at T" has an instant at which a duty was both closed and
 * not yet open. A reviewer tempted to make this `clock_timestamp()` should read that sentence
 * again.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 *
 * Rest after a night, one night in three, weekly off, staffing ratios, leave clashes: those are the
 * VALIDATOR's (R8) — findings a human may accept with a reason, not refusals. What is refused here
 * is only what can never be right: a window that ends before it starts, a slot outside its period,
 * an empty roster, a person in two rooms, and a publish that would silently undo somebody's work.
 */

export type RosterPeriodRow = typeof rosterPeriods.$inferSelect;
export type RosterAssignmentRow = typeof rosterAssignments.$inferSelect;
export type RosterAmendmentRow = typeof rosterAmendments.$inferSelect;

/** A presence window longer than this is a typing error (a wrong month, a wrong year), not a duty. */
export const MAX_PRESENCE_HOURS = 36;
const HOUR_MS = 3_600_000;

const iso = (d: Date): string => d.toISOString();

/**
 * ONE lock for every publish in the hospital. It is deliberately not per-scope: the thing being
 * protected is the cross-scope invariant (one body, two rooms), and a per-scope lock would let
 * Medicine and Surgery publish the same resident into the same night concurrently, each seeing a
 * world in which the other's rows did not exist yet. Publishing is a once-a-month act by a handful
 * of people; there is nothing to gain by making it concurrent and a rota to lose.
 */
const PUBLISH_LOCK = "roster.publish";

async function takePublishLock(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PUBLISH_LOCK}))`);
}

/** The database's own clock. Shared by every row one transaction writes — see the header. */
async function dbNow(tx: Tx): Promise<Date> {
  const r = await tx.execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

function assertWindow(startsAt: Date, endsAt: Date, what: string): void {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new RosterError("invalid_window", `${what}: the start or the end is not a real instant`);
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new RosterError(
      "invalid_window",
      `${what} ends at or before it starts`,
      { startsAt: iso(startsAt), endsAt: iso(endsAt) },
    );
  }
}

async function lockPeriod(tx: Tx, periodId: string): Promise<RosterPeriodRow> {
  const rows = await tx.select().from(rosterPeriods).where(eq(rosterPeriods.id, periodId)).for("update");
  const period = rows[0];
  if (period === undefined) throw new RosterError("unknown_period", undefined, { periodId });
  return period;
}

function assertDraft(period: RosterPeriodRow): void {
  if (period.status !== "draft") {
    throw new RosterError("period_not_draft", undefined, {
      periodId: period.id, status: period.status, version: period.version,
    });
  }
}

/** The (site, scope, start) a version belongs to. Versions are numbered inside one of these. */
const sameSeries = (p: { siteId: string; scopeType: string; scopeId: string | null; startsAt: Date }) => and(
  eq(rosterPeriods.siteId, p.siteId),
  eq(rosterPeriods.scopeType, p.scopeType),
  sql`coalesce(${rosterPeriods.scopeId}, '') = ${p.scopeId ?? ""}`,
  eq(rosterPeriods.startsAt, p.startsAt),
);

/* ═══════════════════════════════ the content hash (V4) ═══════════════════════════════ */

/**
 * SHA-256 over the period's slots, canonically ordered and carrying only what a human REVIEWS.
 *
 * Row ids are deliberately absent. A head who deletes a slot and types an identical one back has
 * reviewed the same roster, and a hash that moved would refuse their publish for no reason anybody
 * could explain. What is hashed is the ANSWER the roster gives — who, as what, where, when, in what
 * mode — so any change to that answer, and only such a change, invalidates a review.
 */
export async function contentHash(exec: Db | Tx, periodId: string): Promise<string> {
  const rows = await (exec as Db).select().from(rosterAssignments)
    .where(and(eq(rosterAssignments.periodId, periodId), isNull(rosterAssignments.liveTo)))
    .orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.positionKey), asc(rosterAssignments.id));

  const canonical = rows
    .map((r) => [
      iso(r.startsAt), iso(r.endsAt), r.positionKey, r.userId ?? "", r.mode ?? "", r.kind,
      r.offKind ?? "", r.departmentId, r.teamId ?? "", r.coverScope, String(r.callTier ?? ""),
      r.supernumerary ? "1" : "0", r.locationResourceId ?? "",
    ].join("\u0001"))
    .sort()
    .join("\u0002");

  return createHash("sha256").update(canonical).digest("hex");
}

/* ═══════════════════════════════ drafting ═══════════════════════════════ */

export interface DraftPeriodInput {
  scopeType: RosterScopeType;
  scopeId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** The positions this roster answers for. A resolver asked about any other falls back (V14). */
  coversPositions: readonly string[];
  origin?: RosterOrigin;
  /**
   * The version this draft is made FROM. `publishPeriod` refuses if it is no longer the live one.
   * Pass it whenever a published roster is being re-planned; omit it only for a first version.
   */
  basedOnPeriodId?: string | null;
}

export async function draftPeriod(
  tx: Tx, actor: Actor, input: DraftPeriodInput,
): Promise<{ periodId: string; version: number; copiedAssignments: number }> {
  const origin: RosterOrigin = input.origin ?? (actor.type === "user" ? "human" : "machine");
  const departmentId = input.departmentId ?? null;
  // A MACHINE drafting its own proposal is `draft_machine_period`; a person drafting is `propose`.
  // The matrix (policy.ts) is what makes those two different answers for a `system` actor.
  await requireRosterAct(
    tx, actor, origin === "machine" ? "draft_machine_period" : "propose",
    departmentId === null ? {} : { departmentId },
  );

  assertWindow(input.startsAt, input.endsAt, "the period");
  if (!(ROSTER_SCOPE_TYPES as readonly string[]).includes(input.scopeType)) {
    throw new RosterError("invalid_window", `"${input.scopeType}" is not something a roster can cover`, { scopeType: input.scopeType });
  }
  const scopeId = input.scopeType === "hospital" ? null : (input.scopeId ?? null);
  if (input.scopeType !== "hospital" && (scopeId === null || scopeId.trim() === "")) {
    throw new RosterError("invalid_window", `a ${input.scopeType} roster must say which ${input.scopeType} it covers`, { scopeType: input.scopeType });
  }
  const title = input.title.trim();
  if (title === "") throw new RosterError("invalid_window", "a roster needs a name a person would recognise");

  const covers = [...new Set(input.coversPositions.map((p) => p.trim()).filter((p) => p !== ""))].sort();
  if (covers.length === 0) {
    throw new RosterError("invalid_window", "a roster must say which duty positions it answers for — one that answers for none reads as a hole everywhere");
  }
  const known = await (tx as Db).select({ key: rosterPositions.key }).from(rosterPositions).where(inArray(rosterPositions.key, covers));
  const unknown = covers.filter((c) => !known.some((k) => k.key === c));
  if (unknown.length > 0) throw new RosterError("unknown_position", undefined, { positionKeys: unknown });

  if (departmentId !== null) {
    const dept = (await (tx as Db).select({ id: orgDepartments.id }).from(orgDepartments).where(eq(orgDepartments.id, departmentId)))[0];
    if (dept === undefined) throw new RosterError("unknown_department", undefined, { departmentId });
  }

  let source: RosterPeriodRow | undefined;
  if (input.basedOnPeriodId != null) {
    source = (await (tx as Db).select().from(rosterPeriods).where(eq(rosterPeriods.id, input.basedOnPeriodId)))[0];
    if (source === undefined) throw new RosterError("unknown_period", undefined, { basedOnPeriodId: input.basedOnPeriodId });
    if (source.scopeType !== input.scopeType || (source.scopeId ?? "") !== (scopeId ?? "")
      || source.startsAt.getTime() !== input.startsAt.getTime()) {
      throw new RosterError(
        "invalid_window",
        "a new version can only be based on an earlier version of the same roster",
        { basedOnPeriodId: source.id },
      );
    }
  }

  const latest = await (tx as Db).select({ version: rosterPeriods.version }).from(rosterPeriods)
    .where(sameSeries({ siteId: "main", scopeType: input.scopeType, scopeId, startsAt: input.startsAt }))
    .orderBy(desc(rosterPeriods.version)).limit(1);
  const version = (latest[0]?.version ?? 0) + 1;
  const periodId = newId();
  const now = await dbNow(tx);

  try {
    await tx.insert(rosterPeriods).values({
      id: periodId, scopeType: input.scopeType, scopeId, departmentId, teamId: input.teamId ?? null,
      title, startsAt: input.startsAt, endsAt: input.endsAt, version, status: "draft",
      coversPositions: covers, basedOnPeriodId: source?.id ?? null, origin,
      draftedByActorType: actor.type,
      // The clock on the HUMAN-TOUCHED mark is what stops a machine becoming the second writer.
      humanTouchedAt: actor.type === "user" ? now : null,
      createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    // Two people drafting the next version at once: the unique index picks one, and the other is
    // told so rather than shown a constraint name.
    if (isUniqueViolation(e, "roster_periods_scope_start_version_ux")) {
      throw new RosterError("version_conflict", undefined, { version });
    }
    throw e;
  }

  let copiedAssignments = 0;
  if (source !== undefined) {
    const rows = await (tx as Db).select().from(rosterAssignments)
      .where(and(eq(rosterAssignments.periodId, source.id), isNull(rosterAssignments.liveTo)));
    // A slot that no longer starts inside the new window is dropped, not smuggled in. And the
    // LINEAGE is carried: a copied slot is the same duty, so its history survives the new version.
    const kept = rows.filter((r) => r.startsAt >= input.startsAt && r.startsAt < input.endsAt);
    if (kept.length > 0) {
      await tx.insert(rosterAssignments).values(kept.map((r) => ({
        ...r, id: newId(), periodId, effective: false, liveFrom: now, liveTo: null, amendmentId: null,
        createdBy: actor.id, updatedBy: actor.id, createdAt: undefined, updatedAt: undefined,
      })));
    }
    copiedAssignments = kept.length;
  }

  await appendEvent(tx, rosterPeriodDrafted.make({
    payload: {
      periodId, scopeType: input.scopeType, scopeId, departmentId,
      startsAt: iso(input.startsAt), endsAt: iso(input.endsAt), version, origin,
      basedOnPeriodId: source?.id ?? null, copiedAssignments,
    },
    actor,
    correlationId: periodId,
  }));
  return { periodId, version, copiedAssignments };
}

/* ═══════════════════════════════ assignments ═══════════════════════════════ */

export interface AssignInput {
  /** NULL is a VACANT slot: a declared hole the requirement checker can see (V16). */
  userId?: string | null;
  positionKey: string;
  startsAt: Date;
  endsAt: Date;
  departmentId: string;
  teamId?: string | null;
  mode?: RosterAssignmentMode | null;
  kind?: RosterAssignmentKind;
  offKind?: RosterOffKind | null;
  coverScope?: RosterCoverScope;
  callTier?: number | null;
  supernumerary?: boolean;
  locationResourceId?: string | null;
  batchRef?: string | null;
  topic?: string | null;
  source?: RosterAssignmentSource;
  note?: string | null;
  /**
   * Groups every slot one proposer RUN produced (R9), so a head can say "undo that draft" and mean
   * a set rather than a time range. Null for anything a person typed.
   */
  proposalRunId?: string | null;
}

/**
 * The act a slot edit is judged as: **if a human has touched this draft, editing it is
 * `edit_human_draft`** — which the matrix forbids to every machine actor — and otherwise it is an
 * ordinary `propose`. This is V8's central clause, and it is enforced here rather than by a caller
 * remembering to ask.
 */
const editAct = (period: RosterPeriodRow): "edit_human_draft" | "propose" =>
  period.humanTouchedAt === null ? "propose" : "edit_human_draft";

export async function assign(
  tx: Tx, actor: Actor, periodId: string, input: AssignInput,
): Promise<{ assignmentId: string }> {
  const period = await lockPeriod(tx, periodId);
  assertDraft(period);
  await requireRosterAct(tx, actor, editAct(period), { departmentId: input.departmentId });

  const kind = input.kind ?? "duty";
  const isOff = kind === "off";
  const mode = isOff ? null : (input.mode ?? "presence");
  const offKind = isOff ? (input.offKind ?? "WO") : null;
  const source = input.source ?? "manual";
  const coverScope = input.coverScope ?? "team";
  if ((mode !== null && !(ROSTER_ASSIGNMENT_MODES as readonly string[]).includes(mode))
    || !(ROSTER_ASSIGNMENT_KINDS as readonly string[]).includes(kind)
    || !(ROSTER_ASSIGNMENT_SOURCES as readonly string[]).includes(source)
    || !(ROSTER_COVER_SCOPES as readonly string[]).includes(coverScope)
    || (offKind !== null && !(ROSTER_OFF_KINDS as readonly string[]).includes(offKind))) {
    throw new RosterError("invalid_window", "mode, kind, source, cover scope or off-kind is not one the roster knows", { mode, kind, source, coverScope, offKind });
  }

  assertWindow(input.startsAt, input.endsAt, "the duty");
  // A duty belongs to the period its START falls in. Its end may run past the period's end: the
  // night of the 31st ends on the 1st, and splitting it in two would roster one person twice.
  if (input.startsAt < period.startsAt || input.startsAt >= period.endsAt) {
    throw new RosterError("outside_period", undefined, {
      periodId, startsAt: iso(input.startsAt), periodStartsAt: iso(period.startsAt), periodEndsAt: iso(period.endsAt),
    });
  }

  // V14's precondition: a roster answers only for the positions it declares.
  if (!period.coversPositions.includes(input.positionKey)) {
    throw new RosterError("position_not_covered", undefined, {
      periodId, positionKey: input.positionKey, covers: period.coversPositions,
    });
  }
  const position = (await (tx as Db).select().from(rosterPositions).where(eq(rosterPositions.key, input.positionKey)))[0];
  if (position === undefined) throw new RosterError("unknown_position", undefined, { positionKey: input.positionKey });

  const hours = (input.endsAt.getTime() - input.startsAt.getTime()) / HOUR_MS;
  const cap = Math.min(position.maxPresenceHours, MAX_PRESENCE_HOURS);
  if (mode === "presence" && hours > cap) {
    throw new RosterError(
      "invalid_window",
      `a duty of ${Math.round(hours)} hours in one place is a typing mistake, not a shift — `
      + `${position.label} is planned for at most ${cap} hours at a stretch (on-call may be longer)`,
      { hours: Math.round(hours), maxHours: cap, positionKey: position.key },
    );
  }

  const userId = input.userId ?? null;
  if (userId === null && isOff) {
    throw new RosterError("invalid_window", "a day off belongs to a person — there is no such thing as a vacant off", { periodId });
  }
  if (userId !== null) {
    const person = (await (tx as Db).select({ id: users.id, active: users.active, fullName: users.fullName })
      .from(users).where(eq(users.id, userId)))[0];
    if (person === undefined || !person.active) {
      throw new RosterError("unknown_user", undefined, { userId });
    }
    // The ONLY link to RBAC, and it is a check, never a grant: being rostered as the on-call
    // radiologist does not make somebody a radiologist, but somebody who is not one cannot be
    // rostered to answer as one.
    if (position.eligibleRoleKey !== null) {
      const holds = (await (tx as Db).select({ id: roleAssignments.id }).from(roleAssignments)
        .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.roleKey, position.eligibleRoleKey))).limit(1))[0];
      if (holds === undefined) {
        throw new RosterError(
          "position_ineligible",
          `${person.fullName} does not hold "${position.eligibleRoleKey}", which ${position.label} answers as`,
          { userId, positionKey: position.key, requiredRoleKey: position.eligibleRoleKey },
        );
      }
    }
  }

  const departmentId = input.departmentId;
  const dept = (await (tx as Db).select({ id: orgDepartments.id }).from(orgDepartments).where(eq(orgDepartments.id, departmentId)))[0];
  if (dept === undefined) throw new RosterError("unknown_department", undefined, { departmentId });

  if (input.locationResourceId != null) {
    const place = (await (tx as Db).select({ id: resources.id }).from(resources).where(eq(resources.id, input.locationResourceId)))[0];
    if (place === undefined) throw new RosterError("unknown_location", undefined, { locationResourceId: input.locationResourceId });
  }

  const assignmentId = newId();
  const now = await dbNow(tx);
  await tx.insert(rosterAssignments).values({
    id: assignmentId, periodId, userId, positionKey: input.positionKey,
    startsAt: input.startsAt, endsAt: input.endsAt, mode, kind, offKind, source, coverScope,
    departmentId, teamId: input.teamId ?? null, callTier: input.callTier ?? null,
    supernumerary: input.supernumerary ?? false,
    locationResourceId: input.locationResourceId ?? null,
    batchRef: input.batchRef ?? null, topic: input.topic ?? null, note: input.note ?? null,
    effective: false, liveFrom: now, lineageId: assignmentId,
    proposedByActorType: actor.type, proposedByActorId: actor.id,
    proposalRunId: input.proposalRunId ?? null,
    createdBy: actor.id, updatedBy: actor.id,
  });
  if (actor.type === "user" && period.humanTouchedAt === null) {
    await tx.update(rosterPeriods).set({ humanTouchedAt: now, updatedBy: actor.id, updatedAt: now })
      .where(eq(rosterPeriods.id, periodId));
  }
  return { assignmentId };
}

/** A DRAFT is scratch paper: a row is simply removed. Nothing published can reach this function. */
export async function unassign(tx: Tx, actor: Actor, assignmentId: string): Promise<void> {
  const row = (await (tx as Db).select({ periodId: rosterAssignments.periodId, departmentId: rosterAssignments.departmentId })
    .from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId)))[0];
  if (row === undefined) throw new RosterError("unknown_assignment", undefined, { assignmentId });
  const period = await lockPeriod(tx, row.periodId);
  assertDraft(period);
  await requireRosterAct(tx, actor, editAct(period), { departmentId: row.departmentId });
  await tx.delete(rosterAssignments).where(eq(rosterAssignments.id, assignmentId));
}

/* ═══════════════════════════════ one body, two rooms ═══════════════════════════════ */

export interface PresenceClash {
  userId: string;
  fullName: string;
  a: { assignmentId: string; periodId: string; startsAt: string; endsAt: string };
  b: { assignmentId: string; periodId: string; startsAt: string; endsAt: string };
}

/**
 * Everybody in these periods who would be physically in two places if they all went live now:
 * against the periods' own rows, against each OTHER (the cross-unit swap), and against every other
 * live roster. Exported because the validator (R8) shows these as findings long before anybody
 * presses publish.
 */
export async function presenceClashes(exec: Db | Tx, periodIds: readonly string[]): Promise<PresenceClash[]> {
  if (periodIds.length === 0) return [];
  const ids = sql.join(periodIds.map((i) => sql`${i}`), sql`, `);
  const result = await (exec as Db).execute(sql`
    select a.user_id as "userId", u.full_name as "fullName",
           a.id as "aId", a.period_id as "aPeriod", a.starts_at as "aStart", a.ends_at as "aEnd",
           b.id as "bId", b.period_id as "bPeriod", b.starts_at as "bStart", b.ends_at as "bEnd"
      from roster_assignments a
      join roster_assignments b
        on b.user_id = a.user_id and b.id <> a.id and b.mode = 'presence' and b.live_to is null
       and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
       and (
             (b.period_id in (${ids}) and a.id < b.id)
             or (b.period_id not in (${ids}) and b.effective)
           )
      join users u on u.id = a.user_id
     where a.period_id in (${ids}) and a.mode = 'presence' and a.live_to is null
       and a.user_id is not null
     order by a.starts_at, a.id, b.id`);
  const asIso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    userId: String(r.userId), fullName: String(r.fullName),
    a: { assignmentId: String(r.aId), periodId: String(r.aPeriod), startsAt: asIso(r.aStart), endsAt: asIso(r.aEnd) },
    b: { assignmentId: String(r.bId), periodId: String(r.bPeriod), startsAt: asIso(r.bStart), endsAt: asIso(r.bEnd) },
  }));
}

function refuseClashes(clashes: PresenceClash[]): never {
  const first = clashes[0]!;
  throw new RosterError(
    "presence_overlap",
    `${first.fullName} would have to be in two places at once`
    + (clashes.length > 1 ? ` (and ${clashes.length - 1} more like it)` : "")
    + ". On-call may overlap a duty; two duties in person may not",
    { clashes },
  );
}

/* ═══════════════════════════════ the publication gate ═══════════════════════════════ */

export interface PublishRequest {
  periodId: string;
  /**
   * V4 — the hash of the draft the human actually read. Omit ONLY where no human reviewed a
   * rendering of it (a test fixture, a first publish of a roster typed in the same breath); a
   * caller that passes a stale one is refused rather than silently publishing something else.
   */
  expectedContentHash?: string;
}

export interface PublishResult {
  periodId: string;
  version: number;
  assignmentCount: number;
  contentHash: string;
  supersededPeriodId: string | null;
}

export async function publishPeriod(
  tx: Tx, actor: Actor, periodId: string, opts: { expectedContentHash?: string } = {},
): Promise<PublishResult> {
  const [only] = await publishPeriods(tx, actor, [{ periodId, ...opts }]);
  return only!;
}

/**
 * Publish one roster, or several AS ONE ACT.
 *
 * The several-at-once form exists for the same-night cross-unit swap (stress test S2(b)): two units
 * exchange a resident, and neither new version can be published while the other unit's old one is
 * still live. Taking every old version out of effect before checking any new one is the only order
 * in which that transaction can exist at all.
 */
export async function publishPeriods(
  tx: Tx, actor: Actor, requests: readonly PublishRequest[],
): Promise<PublishResult[]> {
  if (requests.length === 0) return [];
  const ids = requests.map((r) => r.periodId);
  if (new Set(ids).size !== ids.length) {
    throw new RosterError("invalid_window", "the same roster is named twice in one publish", { periodIds: ids });
  }

  // (0) ONE lock, before anything is read: see PUBLISH_LOCK.
  await takePublishLock(tx);
  const now = await dbNow(tx);

  // (1) lock every draft, in id order so two callers naming overlapping sets cannot deadlock.
  const periods: RosterPeriodRow[] = [];
  for (const periodId of [...ids].sort()) {
    const period = await lockPeriod(tx, periodId);
    assertDraft(period);
    await requireRosterAct(tx, actor, "publish", period.departmentId === null ? {} : { departmentId: period.departmentId });
    periods.push(period);
  }

  // (2) every refusal that can be decided from the drafts alone, BEFORE a single write.
  const hashes = new Map<string, string>();
  for (const period of periods) {
    const counted = await (tx as Db).select({ n: sql<number>`count(*)::int` })
      .from(rosterAssignments).where(and(eq(rosterAssignments.periodId, period.id), isNull(rosterAssignments.liveTo)));
    const assignmentCount = counted[0]?.n ?? 0;
    if (assignmentCount === 0) throw new RosterError("empty_period", undefined, { periodId: period.id });

    const hash = await contentHash(tx, period.id);
    hashes.set(period.id, hash);
    const expected = requests.find((r) => r.periodId === period.id)?.expectedContentHash;
    if (expected !== undefined && expected !== hash) {
      // V4. The person approving read a rendering of a different roster from the one in front of us.
      throw new RosterError("draft_changed_since_review", undefined, {
        periodId: period.id, expectedContentHash: expected, actualContentHash: hash,
      });
    }

    /**
     * (2c) R8 — THE VALIDATOR, AND IT BELONGS EXACTLY HERE.
     *
     * With the other refusals that are decided from the drafts alone, and **before step (3)
     * supersedes anything.** A validator called after the supersede would mean a REFUSED publish
     * had already taken the live roster out of effect inside the transaction: the rollback saves
     * it, but only the rollback, and a future reader reordering these steps for tidiness would
     * have no way to see what they had broken. Put where refusals live, it cannot be got wrong.
     *
     * Only `block` stops a publish, and only a block nobody has accepted. Every other finding is
     * the head's to weigh — that is the whole distinction between this gate and R2's.
     */
    const findings = await validate(tx, period.id);
    // One definition of "accepted", shared with the findings reader, so that a later change to
    // what an acceptance means cannot leave the gate honouring a different rule from the screen.
    const blocking = blockingFindings(findings, await acceptedFindingKeys(tx, period.id));
    if (blocking.length > 0) {
      throw new RosterError("blocked_by_findings", undefined, {
        periodId: period.id,
        // Every code at once: a head fixing them one attempt at a time is a head we wasted.
        codes: [...new Set(blocking.map((f) => f.ruleKey))].sort(),
        findings: blocking.map((f) => ({
          ruleKey: f.ruleKey, userId: f.userId, assignmentId: f.assignmentId, params: f.params,
        })),
      });
    }
  }

  // (3) V3 — the base must still be the live version, and the old versions go out of effect FIRST.
  const superseded = new Map<string, string | null>();
  for (const period of periods) {
    const live = (await (tx as Db).select().from(rosterPeriods).where(and(
      sameSeries(period), eq(rosterPeriods.status, "published"), ne(rosterPeriods.id, period.id),
    )).for("update"))[0];

    const base = period.basedOnPeriodId;
    if ((live?.id ?? null) !== (base ?? null)) {
      // The lost update of S2(a). Publishing would silently discard whatever the live version
      // gained after this draft was taken from it — which is exactly what nobody would notice.
      throw new RosterError("stale_base", undefined, {
        periodId: period.id, basedOnPeriodId: base, liveVersionId: live?.id ?? null,
        liveVersion: live?.version ?? null,
      });
    }
    superseded.set(period.id, live?.id ?? null);

    if (live !== undefined) {
      /**
       * V7 — **`updated_by` IS NOT TOUCHED HERE, AND THAT IS THE POINT.** Superseding closes a
       * row's KNOWLEDGE window; it does not edit the duty. The senior resident who wrote "Dr Rao,
       * Tuesday night" must still be the person this row says wrote it, two years later, when
       * somebody asks who rostered her. Stamping the publisher over it would erase the only record
       * of authorship the row has — and would do it on every publish, silently.
       */
      await tx.update(rosterAssignments)
        .set({ effective: false, liveTo: now })
        .where(and(eq(rosterAssignments.periodId, live.id), isNull(rosterAssignments.liveTo)));
      await tx.update(rosterPeriods).set({
        status: "superseded", supersededAt: now, supersededByPeriodId: period.id,
        updatedBy: actor.id, updatedAt: now,
      }).where(eq(rosterPeriods.id, live.id));
      await appendEvent(tx, rosterPeriodSuperseded.make({
        payload: {
          periodId: live.id, scopeType: live.scopeType, scopeId: live.scopeId,
          supersededByPeriodId: period.id, supersededAt: iso(now),
        },
        actor, correlationId: live.id,
      }));
    }
  }

  // (4) one body, two rooms — across the WHOLE set, said in a sentence before a constraint says it
  //     in a code.
  const clashes = await presenceClashes(tx, ids);
  if (clashes.length > 0) refuseClashes(clashes);

  // (5) into effect.
  const results: PublishResult[] = [];
  for (const period of periods) {
    const hash = hashes.get(period.id)!;
    try {
      await tx.update(rosterAssignments)
        .set({ effective: true, updatedBy: actor.id, updatedAt: now })
        .where(and(eq(rosterAssignments.periodId, period.id), isNull(rosterAssignments.liveTo)));
    } catch (e) {
      // The backstop the pre-check cannot see, now that the advisory lock makes it nearly
      // unreachable: say it in words rather than a constraint name.
      if (isExclusionViolation(e, "roster_assignments_no_double_presence_excl")) {
        throw new RosterError("presence_overlap", undefined, { periodId: period.id });
      }
      throw e;
    }
    try {
      await tx.update(rosterPeriods).set({
        status: "published", publishedAt: now, publishedBy: actor.id, contentHash: hash,
        updatedBy: actor.id, updatedAt: now,
      }).where(eq(rosterPeriods.id, period.id));
    } catch (e) {
      if (isExclusionViolation(e, "roster_periods_one_published_excl")) {
        throw new RosterError("published_period_overlap", undefined, { periodId: period.id });
      }
      throw e;
    }

    const rows = await (tx as Db).select().from(rosterAssignments)
      .where(and(eq(rosterAssignments.periodId, period.id), isNull(rosterAssignments.liveTo)));
    await appendEvent(tx, rosterPeriodPublished.make({
      payload: {
        periodId: period.id, scopeType: period.scopeType, scopeId: period.scopeId,
        departmentId: period.departmentId, startsAt: iso(period.startsAt), endsAt: iso(period.endsAt),
        version: period.version, assignmentCount: rows.length, contentHash: hash,
        publishedAt: iso(now), supersededPeriodId: superseded.get(period.id) ?? null,
      },
      actor, correlationId: period.id,
    }));
    await emitDutyChanged(tx, actor, period.id, rows, [], null, now);

    results.push({
      periodId: period.id, version: period.version, assignmentCount: rows.length,
      contentHash: hash, supersededPeriodId: superseded.get(period.id) ?? null,
    });
  }
  // Answer in the order the caller asked, not the order the locks were taken.
  return ids.map((i) => results.find((r) => r.periodId === i)!);
}

/** One event per PERSON whose duties moved, never one per slot — see `events.ts`. */
async function emitDutyChanged(
  tx: Tx, actor: Actor, periodId: string,
  added: readonly RosterAssignmentRow[], removed: readonly RosterAssignmentRow[],
  amendmentId: string | null, at: Date,
): Promise<void> {
  const byUser = new Map<string, { added: string[]; removed: string[] }>();
  const bucket = (userId: string) => {
    let b = byUser.get(userId);
    if (b === undefined) { b = { added: [], removed: [] }; byUser.set(userId, b); }
    return b;
  };
  for (const r of added) if (r.userId !== null) bucket(r.userId).added.push(r.id);
  for (const r of removed) if (r.userId !== null) bucket(r.userId).removed.push(r.id);

  for (const [userId, b] of [...byUser].sort(([a], [c]) => (a < c ? -1 : 1))) {
    await appendEvent(tx, rosterDutyChanged.make({
      payload: { userId, periodId, added: b.added, removed: b.removed, amendmentId, effectiveFrom: iso(at) },
      actor, correlationId: periodId,
    }));
  }
}

/* ═══════════════════════════════ amendments ═══════════════════════════════ */

export interface AmendInput {
  kind: RosterAmendmentKind;
  reason: string;
  requestedBy: string;
  /** Assignment ids to take out of effect. They must belong to this period and be live. */
  close?: readonly string[];
  /** New slots. `replacesAssignmentId` carries the lineage of the slot this one takes over. */
  open?: readonly (AssignInput & { replacesAssignmentId?: string })[];
  afterTheFact?: boolean;
}

/**
 * ═══ ONE AMENDMENT IS ONE TRANSACTION ═══
 *
 * The rows it closes and the rows it opens share ONE instant, so there is no moment at which a
 * ward has nobody or two people. It is the row-level half of the hybrid model (S2), and it is what
 * a float, a swap, a cover and an after-the-fact correction all are.
 *
 * It amends a PUBLISHED period, never a draft: a draft is simply edited.
 */
export async function amend(
  tx: Tx, actor: Actor, periodId: string, input: AmendInput,
): Promise<{ amendmentId: string; supersededCount: number; addedCount: number }> {
  await takePublishLock(tx);
  const period = await lockPeriod(tx, periodId);
  if (period.status !== "published") {
    throw new RosterError("period_not_published", undefined, { periodId, status: period.status });
  }
  await requireRosterAct(tx, actor, "publish", period.departmentId === null ? {} : { departmentId: period.departmentId });

  const reason = input.reason.trim();
  if (reason === "" || reason.length > 500) {
    throw new RosterError("invalid_window", "an amendment needs a reason, in 500 characters or fewer — everybody it touches is shown it", { reasonLength: reason.length });
  }
  if (!(ROSTER_AMENDMENT_KINDS as readonly string[]).includes(input.kind)) {
    throw new RosterError("invalid_window", `"${input.kind}" is not a kind of amendment the roster knows`, { kind: input.kind });
  }

  const now = await dbNow(tx);
  const amendmentId = newId();
  const closeIds = [...new Set(input.close ?? [])];
  const openInputs = input.open ?? [];

  // Read the rows being closed BEFORE closing them: their lineage is what the replacements inherit.
  const closing = closeIds.length === 0 ? [] : await (tx as Db).select().from(rosterAssignments)
    .where(and(inArray(rosterAssignments.id, closeIds), eq(rosterAssignments.periodId, periodId), isNull(rosterAssignments.liveTo)))
    .for("update");
  const missing = closeIds.filter((i) => !closing.some((r) => r.id === i));
  if (missing.length > 0) {
    throw new RosterError("unknown_assignment", undefined, { periodId, assignmentIds: missing });
  }

  await tx.insert(rosterAmendments).values({
    id: amendmentId, periodId, kind: input.kind, reason,
    requestedBy: input.requestedBy, approvedBy: actor.id, approvedAt: now,
    afterTheFact: input.afterTheFact ?? false, appliedAt: now,
    supersededCount: closing.length, addedCount: openInputs.length,
    createdBy: actor.id, updatedBy: actor.id,
  });

  if (closing.length > 0) {
    // V7 again: closing a row is not editing it. See the note in `publishPeriods`.
    await tx.update(rosterAssignments)
      .set({ effective: false, liveTo: now })
      .where(inArray(rosterAssignments.id, closing.map((r) => r.id)));
  }

  const opened: RosterAssignmentRow[] = [];
  for (const slot of openInputs) {
    const replaces = slot.replacesAssignmentId === undefined
      ? undefined
      : closing.find((r) => r.id === slot.replacesAssignmentId);
    if (slot.replacesAssignmentId !== undefined && replaces === undefined) {
      throw new RosterError("unknown_assignment", undefined, { periodId, assignmentId: slot.replacesAssignmentId });
    }
    const id = newId();
    const kind = slot.kind ?? "duty";
    const isOff = kind === "off";
    await tx.insert(rosterAssignments).values({
      id, periodId, userId: slot.userId ?? null, positionKey: slot.positionKey,
      startsAt: slot.startsAt, endsAt: slot.endsAt,
      mode: isOff ? null : (slot.mode ?? "presence"), kind,
      offKind: isOff ? (slot.offKind ?? "WO") : null,
      departmentId: slot.departmentId, teamId: slot.teamId ?? null,
      coverScope: slot.coverScope ?? "team", callTier: slot.callTier ?? null,
      supernumerary: slot.supernumerary ?? false,
      locationResourceId: slot.locationResourceId ?? null,
      batchRef: slot.batchRef ?? null, topic: slot.topic ?? null, note: slot.note ?? null,
      source: slot.source ?? "manual",
      // Inserted NOT YET EFFECTIVE, and flipped below once the invariant has been checked in
      // application code. Inserting them live would let the exclusion constraint fire first, and a
      // ward sister covering a night at 02:00 would be shown a constraint name instead of the
      // sentence naming who is already on. The constraint stays as the backstop, not the messenger.
      effective: false, liveFrom: now, liveTo: null, amendmentId,
      lineageId: replaces?.lineageId ?? id,
      proposedByActorType: actor.type, proposedByActorId: actor.id,
      createdBy: actor.id, updatedBy: actor.id,
    });
    const row = (await (tx as Db).select().from(rosterAssignments).where(eq(rosterAssignments.id, id)))[0]!;
    opened.push(row);
  }

  // Re-run the invariant over the whole live period, not just the rows that moved: a cover added
  // at 02:00 clashes with a duty nobody touched.
  const clashes = await presenceClashes(tx, [periodId]);
  if (clashes.length > 0) refuseClashes(clashes);

  if (opened.length > 0) {
    try {
      await tx.update(rosterAssignments).set({ effective: true })
        .where(inArray(rosterAssignments.id, opened.map((r) => r.id)));
    } catch (e) {
      // The backstop: a live row in ANOTHER period that the check above could not see because it
      // arrived between the two statements. The advisory lock makes this nearly unreachable.
      if (isExclusionViolation(e, "roster_assignments_no_double_presence_excl")) {
        throw new RosterError("presence_overlap", undefined, { periodId });
      }
      throw e;
    }
    for (const r of opened) r.effective = true;
  }

  await appendEvent(tx, rosterAmendmentApplied.make({
    payload: {
      amendmentId, periodId, kind: input.kind, afterTheFact: input.afterTheFact ?? false,
      supersededCount: closing.length, addedCount: opened.length, appliedAt: iso(now),
    },
    actor, correlationId: periodId,
  }));
  await emitDutyChanged(tx, actor, periodId, opened, closing, amendmentId, now);

  return { amendmentId, supersededCount: closing.length, addedCount: opened.length };
}

/* ═══════════════════════════════ reads ═══════════════════════════════ */

export interface RosterScopeRef {
  scopeType: RosterScopeType;
  scopeId?: string | null;
  siteId?: string;
}

/**
 * ═══ WHAT THE ROSTER SAID AT INSTANT `knownAt` ═══
 *
 * Two filters, one per axis, and they answer two different questions with one function:
 *
 *   · pass a PAST instant and it answers *"who was rostered, as it was known that night"* — the
 *     question an inquiry asks, and the one a corrected roster must not silently re-answer;
 *   · pass NOW and it answers *"who is rostered, as corrected"* — the operational question.
 *
 * A period qualifies while it was published and not yet superseded; a row qualifies while it was
 * live. Nothing published is ever deleted, which is what makes the first question answerable at all.
 */
export async function asKnownAt(
  exec: Db | Tx, scope: RosterScopeRef, knownAt: Date,
): Promise<RosterAssignmentRow[]> {
  const siteId = scope.siteId ?? "main";
  return (exec as Db).select({ a: rosterAssignments }).from(rosterAssignments)
    .innerJoin(rosterPeriods, eq(rosterPeriods.id, rosterAssignments.periodId))
    .where(and(
      eq(rosterPeriods.siteId, siteId),
      eq(rosterPeriods.scopeType, scope.scopeType),
      sql`coalesce(${rosterPeriods.scopeId}, '') = ${scope.scopeId ?? ""}`,
      sql`${rosterPeriods.publishedAt} is not null and ${rosterPeriods.publishedAt} <= ${knownAt}`,
      sql`(${rosterPeriods.supersededAt} is null or ${rosterPeriods.supersededAt} > ${knownAt})`,
      sql`${rosterAssignments.liveFrom} <= ${knownAt}`,
      sql`(${rosterAssignments.liveTo} is null or ${rosterAssignments.liveTo} > ${knownAt})`,
    ))
    .orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id))
    .then((rows) => rows.map((r) => r.a));
}

export async function periodWithAssignments(
  exec: Db | Tx, periodId: string,
): Promise<{ period: RosterPeriodRow; assignments: RosterAssignmentRow[] }> {
  const period = (await (exec as Db).select().from(rosterPeriods).where(eq(rosterPeriods.id, periodId)))[0];
  if (period === undefined) throw new RosterError("unknown_period", undefined, { periodId });
  const assignments = await (exec as Db).select().from(rosterAssignments)
    .where(eq(rosterAssignments.periodId, periodId))
    .orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id));
  return { period, assignments };
}

/** Every version of every roster whose window touches `[from, to)`, newest version first. */
export async function periodsTouching(
  exec: Db | Tx, from: Date, to: Date,
  statuses: readonly RosterPeriodRow["status"][] = ["draft", "published"],
): Promise<RosterPeriodRow[]> {
  return (exec as Db).select().from(rosterPeriods)
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
