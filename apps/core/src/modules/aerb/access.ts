import { hasPermission } from "../../kernel/auth/permissions";
import { AerbError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T6 — **WHO MAY HOLD THE PEN, DECIDED IN ONE PLACE.**
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * `assertMayManage` was written three times — in `licences.ts`, `qa.ts` and `badges.ts` — each with
 * its own `const MANAGE = "aerb.registers.manage"` above it. Three copies of one authority
 * decision is the shape this repository has already paid for twice: the fix that lands on one
 * instance closes that instance and leaves the other two, and nothing fails while they disagree.
 *
 * T6 makes the decision READABLE as well as enforceable — the screen has to know whether to render
 * a form at all (`canManage` on the read responses, the `canOpenImages` pattern 18b's close review
 * settled) — and a fourth copy of the permission string for the read side is exactly how the
 * client's answer and the server's would drift apart. So there is one predicate, one string, and
 * the refusal is the same predicate with a sentence attached.
 *
 * ═══ THE SENTENCE STAYS WITH THE CALLER ═══
 *
 * "a badge is issued to a person by a person" and "a QA result is recorded by a person — a system
 * actor cannot stop or release a machine" are not interchangeable, and flattening them into one
 * generic refusal would lose the only part of the message that tells the reader what they were
 * doing. The caller passes its own sentence; only the DECISION is shared.
 */
export const AERB_MANAGE = "aerb.registers.manage";

/**
 * The predicate, and the only place the permission string is compared against an actor.
 *
 * A non-user actor is FALSE rather than an error: this is the question a read asks in order to
 * decide whether to offer a form, and the scheduler asking it is simply told no.
 */
export async function mayManage(exec: Db | Tx, actor: Actor): Promise<boolean> {
  if (actor.type !== "user") return false;
  return hasPermission(exec as Db, actor.id, AERB_MANAGE, "hospital");
}

/**
 * The same decision, as a refusal. `systemActorMessage` is the caller's own sentence for the case
 * where a machine tried to write a statutory record.
 */
export async function requireManage(
  exec: Db | Tx, actor: Actor, systemActorMessage: string,
): Promise<void> {
  if (actor.type !== "user") throw new AerbError("not_appointed", systemActorMessage);
  if (!(await hasPermission(exec as Db, actor.id, AERB_MANAGE, "hospital"))) {
    throw new AerbError("not_appointed", `${actor.id} does not hold ${AERB_MANAGE}`, { permission: AERB_MANAGE });
  }
}
