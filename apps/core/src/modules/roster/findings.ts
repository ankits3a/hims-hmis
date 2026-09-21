import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { newId } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import { rosterFindings, rosterPeriods } from "../../kernel/db/schema/roster";
import { appendEvent } from "../../kernel/events/append";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { rosterFindingAccepted } from "./events";
import { findingKey, validate } from "./validator";
import type { RosterFinding } from "./validator";

/**
 * PHASE R (R8) — **THE FINDINGS A ROSTER CARRIES, AND WHO SIGNED FOR THEM.**
 *
 * `validate()` computes; this persists. The split is deliberate: a proposer evaluating a hundred
 * candidate drafts must be able to ask "what would be wrong with this?" without leaving a hundred
 * findings behind, so the evaluation is pure and the RECORD is an act somebody performs.
 *
 * ═══ A FINDING IS CLEARED, NEVER DELETED ═══
 *
 * When a new draft no longer produces a finding, `cleared_at` is stamped and the row stays. What a
 * roster used to be wrong about is how a department learns that it is always short a JR in the
 * third week — and a table that deleted the fixed ones could never answer that.
 *
 * ═══ AND AN ACCEPTANCE NAMES A PERSON, AN INSTANT AND A REASON ═══
 *
 * All three or none — the database's own CHECK says so. The point of letting a warn be accepted at
 * all is that somebody answers for it afterwards; an acceptance with no reason is a finding
 * somebody silenced, which is the opposite of the thing this table exists to record.
 */

export type RosterFindingRow = typeof rosterFindings.$inferSelect;

async function dbNow(tx: Tx): Promise<Date> {
  const r = await tx.execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

/**
 * Evaluate a period and bring its stored findings into line with the answer: insert what is new,
 * leave what still stands (with whatever acceptance it carries), clear what is gone.
 *
 * **An acceptance survives re-evaluation of the same finding, and that is the delicate part.** A
 * head who accepted "Dr Rao's third night" on Tuesday should not be asked again on Wednesday
 * because an unrelated slot moved — so the match is on `findingKey`, not on row identity.
 */
export async function recordFindings(
  tx: Tx, actor: Actor, periodId: string,
): Promise<{ stored: RosterFindingRow[]; added: number; cleared: number }> {
  const period = (await (tx as Db).select().from(rosterPeriods)
    .where(eq(rosterPeriods.id, periodId)))[0];
  if (period === undefined) throw new RosterError("unknown_period", undefined, { periodId });

  const computed = await validate(tx, periodId);
  const now = await dbNow(tx);

  const existing = await (tx as Db).select().from(rosterFindings).where(and(
    eq(rosterFindings.periodId, periodId), isNull(rosterFindings.clearedAt),
  ));
  const existingByKey = new Map(existing.map((r) => [findingKey(r), r]));
  const computedKeys = new Set(computed.map((f) => findingKey(f)));

  let added = 0;
  for (const f of computed) {
    if (existingByKey.has(findingKey(f))) continue;
    await tx.insert(rosterFindings).values({
      id: newId(),
      periodId,
      assignmentId: f.assignmentId,
      userId: f.userId,
      ruleKey: f.ruleKey,
      severity: f.severity,
      params: f.params,
      createdBy: actor.id,
      updatedBy: actor.id,
    });
    added += 1;
  }

  let cleared = 0;
  for (const row of existing) {
    if (computedKeys.has(findingKey(row))) continue;
    await tx.update(rosterFindings)
      .set({ clearedAt: now, updatedBy: actor.id, updatedAt: now })
      .where(eq(rosterFindings.id, row.id));
    cleared += 1;
  }

  const stored = await listFindings(tx, periodId);
  return { stored, added, cleared };
}

export async function listFindings(
  exec: Db | Tx, periodId: string, opts: { includeCleared?: boolean } = {},
): Promise<RosterFindingRow[]> {
  const where = opts.includeCleared === true
    ? eq(rosterFindings.periodId, periodId)
    : and(eq(rosterFindings.periodId, periodId), isNull(rosterFindings.clearedAt));
  return (exec as Db).select().from(rosterFindings).where(where)
    .orderBy(asc(rosterFindings.severity), asc(rosterFindings.ruleKey), asc(rosterFindings.id));
}

/**
 * A NAMED HUMAN TAKES RESPONSIBILITY FOR A FINDING.
 *
 * Guarded by `accept_warning` — the act `rosterActPolicy` already reserves for a person. No agent,
 * no scheduled job and no copilot may perform it, because the entire value of the record is that a
 * human being can be asked about it later.
 */
export async function acceptFinding(
  tx: Tx, actor: Actor, findingId: string, reason: string,
): Promise<RosterFindingRow> {
  const row = (await (tx as Db).select().from(rosterFindings)
    .where(eq(rosterFindings.id, findingId)))[0];
  if (row === undefined) throw new RosterError("unknown_finding", undefined, { findingId });
  if (row.acceptedAt !== null) {
    throw new RosterError("finding_already_accepted", undefined, {
      findingId, acceptedBy: row.acceptedBy, acceptedAt: row.acceptedAt.toISOString(),
    });
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    // The CHECK would refuse it as a constraint; said here it is a sentence somebody can act on.
    throw new RosterError("invalid_window", "an acceptance without a reason is not an acceptance", {
      findingId,
    });
  }

  const period = (await (tx as Db).select().from(rosterPeriods)
    .where(eq(rosterPeriods.id, row.periodId)))[0];
  await requireRosterAct(
    tx, actor, "accept_warning",
    period?.departmentId == null ? {} : { departmentId: period.departmentId },
  );

  const now = await dbNow(tx);
  const [updated] = await tx.update(rosterFindings).set({
    acceptedBy: actor.id, acceptedAt: now, acceptReason: trimmed, updatedBy: actor.id, updatedAt: now,
  }).where(eq(rosterFindings.id, findingId)).returning();

  // "HOD override evented" (doc 10 §3.9). The reason stays in the row — see the event's own note.
  await appendEvent(tx, rosterFindingAccepted.make({
    payload: {
      findingId, periodId: row.periodId, ruleKey: row.ruleKey,
      severity: row.severity as "block" | "warn" | "info",
      acceptedAt: now.toISOString(),
    },
    actor, correlationId: row.periodId,
  }));
  return updated!;
}

/** The acceptance keys the publish gate honours: accepted, not cleared, for this period. */
export async function acceptedFindingKeys(
  exec: Db | Tx, periodId: string,
): Promise<Set<string>> {
  const rows = await (exec as Db).select().from(rosterFindings).where(and(
    eq(rosterFindings.periodId, periodId), isNull(rosterFindings.clearedAt),
  ));
  return new Set(rows.filter((r) => r.acceptedAt !== null).map((r) => findingKey(r)));
}

/** A finding as the validator would have returned it — for a caller that wants both shapes. */
export const asFinding = (row: RosterFindingRow): RosterFinding => ({
  ruleKey: row.ruleKey,
  severity: row.severity as RosterFinding["severity"],
  authority: "institution",
  userId: row.userId,
  assignmentId: row.assignmentId,
  params: row.params,
});
