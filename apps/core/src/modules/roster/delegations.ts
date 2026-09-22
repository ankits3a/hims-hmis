import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ROSTER_AUTHORITIES, rosterDelegations } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { hasPermission } from "../../kernel/auth/permissions";
import { RosterError } from "./errors";
import { ROSTER_PUBLISH, requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterAuthority } from "../../kernel/db/schema/roster";
import type { RosterPermission } from "./policy";

/**
 * PHASE R (R3) — **A HOD GOING ON LEAVE KEEPS THEIR DEPARTMENT RUNNING.**
 *
 * ═══ WHAT A DELEGATION IS, AND THE TWO THINGS IT IS NOT ═══
 *
 * It moves a PERMISSION from one person to another, inside a named scope, for a bounded stretch,
 * with a reason. It is **not** a change of identity: every act the delegate performs is recorded as
 * theirs, and the delegation is what explains why they were allowed to. And it is **not** a way
 * round `rosterActPolicy` — the matrix's `never` column is about what KIND of thing an actor is,
 * and no delegation makes a scheduled job into a person. A delegate with `publish` may publish; an
 * agent holding the same delegation still may not, and `requireRosterAct` runs the policy first.
 *
 * ═══ NOBODY HANDS ON WHAT THEY DO NOT HOLD ═══
 *
 * Checked at the moment of delegating, against the delegator's own grants at the delegation's own
 * scope. Without it, two people without the authority could delegate it to each other and both
 * would pass a naive check — the classic way a permission system grows a hole nobody planted.
 *
 * ═══ AND IT ALWAYS ENDS ═══
 *
 * `ends_at` is NOT NULL on this table alone. An open-ended delegation is a transfer of authority
 * nobody reviews, which is the thing a delegation exists not to be.
 */

export { delegationsInForce } from "./delegations-read";
export type { RosterDelegationRow } from "./delegations-read";

/**
 * Which permission each authority is a delegation OF. All six map to `roster.periods.publish`
 * today, because that is the one string the governed acts are gated on — but they are listed
 * separately so that R4's leave approval and R7's holiday declaration can move to their own strings
 * without this map becoming a lie.
 */
export const AUTHORITY_PERMISSION: Record<RosterAuthority, RosterPermission> = {
  publish: ROSTER_PUBLISH,
  approve_swap: ROSTER_PUBLISH,
  override_rule: ROSTER_PUBLISH,
  approve_leave: ROSTER_PUBLISH,
  declare_holiday: ROSTER_PUBLISH,
  declare_mode: ROSTER_PUBLISH,
};

export interface DelegationInput {
  delegatorUserId: string;
  delegateUserId: string;
  authority: RosterAuthority;
  scopeType: "hospital" | "department" | "team" | "location";
  scopeId?: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

export async function recordDelegation(tx: Tx, actor: Actor, input: DelegationInput): Promise<{ delegationId: string }> {
  await requireRosterAct(
    tx, actor, "publish",
    input.scopeType === "department" && input.scopeId != null ? { departmentId: input.scopeId } : {},
  );
  if (!(ROSTER_AUTHORITIES as readonly string[]).includes(input.authority)) {
    throw new RosterError("invalid_window", `"${input.authority}" is not an authority anybody may hand on`, { authority: input.authority });
  }
  const reason = input.reason.trim();
  if (reason === "" || reason.length > 500) {
    throw new RosterError("invalid_window", "a delegation needs a reason, in 500 characters or fewer", { reasonLength: reason.length });
  }
  if (input.endsAt <= input.startsAt) {
    throw new RosterError("invalid_window", "a delegation always ends, and it cannot end before it begins", {});
  }
  if (input.delegateUserId === input.delegatorUserId) {
    throw new RosterError("invalid_window", "delegating to yourself is not a delegation", {});
  }
  for (const id of [input.delegatorUserId, input.delegateUserId]) {
    const person = (await (tx as Db).select({ id: users.id, active: users.active }).from(users).where(eq(users.id, id)))[0];
    if (person === undefined || !person.active) throw new RosterError("unknown_user", undefined, { userId: id });
  }

  // Nobody hands on what they do not hold. Asked at the delegation's OWN scope.
  const permission = AUTHORITY_PERMISSION[input.authority];
  const holds = input.scopeType === "department" && input.scopeId != null
    ? await hasPermission(tx as Db, input.delegatorUserId, permission, "department", { departmentId: input.scopeId })
    : await hasPermission(tx as Db, input.delegatorUserId, permission, "hospital");
  if (!holds) {
    throw new RosterError("delegation_not_held", undefined, {
      delegatorUserId: input.delegatorUserId, authority: input.authority, permission,
    });
  }

  const delegationId = newId();
  await tx.insert(rosterDelegations).values({
    id: delegationId, delegatorUserId: input.delegatorUserId, delegateUserId: input.delegateUserId,
    authority: input.authority, scopeType: input.scopeType, scopeId: input.scopeType === "hospital" ? null : (input.scopeId ?? null),
    startsAt: input.startsAt, endsAt: input.endsAt, reason,
    createdBy: actor.id, updatedBy: actor.id,
  });
  return { delegationId };
}

