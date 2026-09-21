import { and, eq, isNull, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  ROSTER_ESCALATION_KINDS, orgDepartments, rosterEscalationTargets, rosterPositions,
} from "../../kernel/db/schema";
import { roles } from "../../kernel/db/schema/auth";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { whoIsOn } from "./resolve";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterEscalationKind } from "../../kernel/db/schema/roster";

/**
 * PHASE R (R6) — **WHERE AN ESCALATION GOES, RESOLVED ONCE.**
 *
 * Read `kernel/db/schema/roster.ts`'s R6 header first: why the destination became a row, and why it
 * ships inert.
 *
 * ═══ THE CONTRACT, AND EVERY BRANCH OF IT IS A TEST ═══
 *
 * `escalationRecipients` answers with the people to reach AND with **how it decided**, because a
 * caller that cannot tell "the roster said so" from "nobody has configured this yet" cannot log
 * anything useful when the wrong phone rings at 02:14.
 *
 *   · **no target row** → the fallback role's holders. `via: "role"`. This is every alert in the
 *     hospital today, unchanged.
 *   · **a row, but the resolver is off or no roster answers** → the fallback role's holders,
 *     `via: "role"` — the row is configuration, not a commitment to have published anything.
 *   · **a row, and a roster answers with somebody** → those people, `via: "roster"`.
 *   · **a row, and a roster answers with NOBODY** → the fallback role's holders, `via: "role"`,
 *     and `rosterWasEmpty: true`.
 *
 * **That last branch is the one to argue about, so it is argued here.** A published roster that
 * names nobody as the duty manager tonight is a real and meaningful statement — R5 is explicit that
 * an empty `published` answer is not an error. But *an escalation is not a report*: the question is
 * not "what does the roster say" but "who do we wake", and the answer "nobody, because the rota has
 * a hole in it" is the one answer an escalation may never give. So the hole is filled from the role
 * — the duty manager is **the rung never removed** — and `rosterWasEmpty` is raised so the hole is
 * visible rather than papered over.
 */

export type RosterEscalationTargetRow = typeof rosterEscalationTargets.$inferSelect;

export interface EscalationRecipients {
  userIds: string[];
  via: "roster" | "role";
  /** TRUE when a roster answered for this position here and named nobody — a hole, filled. */
  rosterWasEmpty: boolean;
  /** The role the answer came from, when it came from a role. */
  roleKey: string | null;
  positionKey: string | null;
}

export interface EscalationContext {
  /** The role this kind of alert has always gone to. Required: it is the rung never removed. */
  fallbackRoleKey: string;
  departmentId?: string;
}

/**
 * The target for this kind of alert here: a department row if there is one, otherwise the
 * hospital-wide row, otherwise none. A department's own answer wins, which is what lets Medicine
 * page its night SR while the rest of the hospital still pages the duty manager.
 */
export async function escalationTarget(
  exec: Db | Tx, alertKind: RosterEscalationKind, departmentId?: string,
): Promise<RosterEscalationTargetRow | undefined> {
  const rows = await (exec as Db).select().from(rosterEscalationTargets).where(and(
    eq(rosterEscalationTargets.alertKind, alertKind),
    eq(rosterEscalationTargets.active, true),
    departmentId === undefined
      ? isNull(rosterEscalationTargets.departmentId)
      : or(eq(rosterEscalationTargets.departmentId, departmentId), isNull(rosterEscalationTargets.departmentId)),
  ));
  return rows.find((r) => r.departmentId !== null) ?? rows.find((r) => r.departmentId === null);
}

export async function escalationRecipients(
  exec: Db | Tx, alertKind: RosterEscalationKind, ctx: EscalationContext, at: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EscalationRecipients> {
  const byRole = async (rosterWasEmpty: boolean, positionKey: string | null): Promise<EscalationRecipients> => ({
    userIds: await usersHoldingRole(exec as Tx, ctx.fallbackRoleKey),
    via: "role", rosterWasEmpty, roleKey: ctx.fallbackRoleKey, positionKey,
  });

  const target = await escalationTarget(exec, alertKind, ctx.departmentId);
  if (target === undefined) return byRole(false, null);

  const answer = await whoIsOn(
    exec,
    { position: target.positionKey, ...(ctx.departmentId === undefined ? {} : { departmentId: ctx.departmentId }) },
    at, env,
  );
  if (answer.source !== "published") return byRole(false, target.positionKey);
  if (answer.userIds.length === 0) return byRole(true, target.positionKey);

  return {
    userIds: answer.userIds, via: "roster", rosterWasEmpty: false,
    roleKey: null, positionKey: target.positionKey,
  };
}

/* ═══════════════════════════════ configuring it ═══════════════════════════════ */

export interface SetEscalationTargetInput {
  alertKind: RosterEscalationKind;
  positionKey: string;
  fallbackRoleKey: string;
  departmentId?: string | null;
}

/**
 * Governed: deciding who gets woken is the same kind of act as publishing the rota that decides it.
 * At department scope when the row is a department's, so a HOD configures their own and not
 * everybody else's.
 */
export async function setEscalationTarget(
  tx: Tx, actor: Actor, input: SetEscalationTargetInput,
): Promise<{ targetId: string }> {
  const departmentId = input.departmentId ?? null;
  await requireRosterAct(tx, actor, "publish", departmentId === null ? {} : { departmentId });

  if (!(ROSTER_ESCALATION_KINDS as readonly string[]).includes(input.alertKind)) {
    throw new RosterError("unknown_escalation_kind", undefined, { alertKind: input.alertKind });
  }
  const position = (await (tx as Db).select({ key: rosterPositions.key }).from(rosterPositions)
    .where(eq(rosterPositions.key, input.positionKey)))[0];
  if (position === undefined) throw new RosterError("unknown_position", undefined, { positionKey: input.positionKey });
  const role = (await (tx as Db).select({ key: roles.key }).from(roles).where(eq(roles.key, input.fallbackRoleKey)))[0];
  if (role === undefined) {
    throw new RosterError("unknown_role", `"${input.fallbackRoleKey}" is not a role in this hospital`, { roleKey: input.fallbackRoleKey });
  }
  if (departmentId !== null) {
    const dept = (await (tx as Db).select({ id: orgDepartments.id }).from(orgDepartments).where(eq(orgDepartments.id, departmentId)))[0];
    if (dept === undefined) throw new RosterError("unknown_department", undefined, { departmentId });
  }

  /**
   * Read, then update or insert — rather than `onConflictDoUpdate`, which cannot target the unique
   * index here: that index is over `coalesce(department_id, '')`, an EXPRESSION, and drizzle's
   * conflict target takes columns. The row is configuration written by a person a few times a year,
   * so a read costs nothing, and the alternative (a plain unique on a nullable column) would let
   * two hospital-wide rows exist for one alert kind — two answers at 02:14.
   */
  const existing = (await tx.select().from(rosterEscalationTargets).where(and(
    eq(rosterEscalationTargets.alertKind, input.alertKind),
    departmentId === null
      ? isNull(rosterEscalationTargets.departmentId)
      : eq(rosterEscalationTargets.departmentId, departmentId),
  )).for("update"))[0];

  if (existing !== undefined) {
    await tx.update(rosterEscalationTargets).set({
      positionKey: input.positionKey, fallbackRoleKey: input.fallbackRoleKey,
      active: true, updatedBy: actor.id, updatedAt: new Date(),
    }).where(eq(rosterEscalationTargets.id, existing.id));
    return { targetId: existing.id };
  }

  const targetId = newId();
  await tx.insert(rosterEscalationTargets).values({
    id: targetId, alertKind: input.alertKind, positionKey: input.positionKey,
    departmentId, fallbackRoleKey: input.fallbackRoleKey,
    createdBy: actor.id, updatedBy: actor.id,
  });
  return { targetId };
}

export async function listEscalationTargets(exec: Db | Tx): Promise<RosterEscalationTargetRow[]> {
  return (exec as Db).select().from(rosterEscalationTargets).orderBy(rosterEscalationTargets.alertKind);
}
