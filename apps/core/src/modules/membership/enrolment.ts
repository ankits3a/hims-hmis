import { z } from "zod";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { loadEnv } from "../../kernel/config";
import { withTx } from "../../kernel/db/client";
import { membershipInstances, membershipPlans } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { instrumentEnrolled } from "./events";
import { MembershipError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * RC-2 T4 / D5 — ENROLLING A MEMBER IS NOT APPLYING ONE.
 *
 * ═══ THE OWNER'S RULING, AND WHY IT IS A PERMISSION RATHER THAN A SCREEN DECISION ═══
 *
 * The Registration Counter handoff states it as a ruling: *"this seat APPLIES membership benefits
 * and cannot ENROL — enrolment is the front-office manager. Model it as two permissions from day
 * one."* Until this task there was only one half. `membership.instrument.recognise` — which the
 * clerk holds, correctly — is the APPLY authority, and nothing anywhere expressed the other.
 *
 * A UI that merely hides the enrol button would be a convention. `membership.instrument.enrol`,
 * granted to `front_office_supervisor` and `membership_admin` and deliberately NOT to
 * `front_office`, is a boundary: the clerk who honours a card at the counter cannot mint one.
 *
 * ═══ THE LANE IS STRUCTURALLY OFF, AND THIS IS WHERE `sales_disabled` FINALLY GETS THROWN ═══
 *
 * `MEMBERSHIP_SALES_ENABLED` (Plan 09 DD14) gates counter sales, and owner ruling **O-15 is
 * UNRULED** — the department brainstorm's default is to open hospital-counter sales only for
 * hospital-originated plans, and only after O-1's items 1, 4 and 6 come back from the CA. So this
 * route exists, is guarded, and REFUSES: `sales_disabled` has been a declared `MembershipErrorCode`
 * since Plan 09 with nothing in the tree ever throwing it, and this is the thrower it was reserved
 * for.
 *
 * That is deliberately different from `membership.catalog.manage`, which stays in
 * `NOT_YET_MODELLED` and is granted to nobody. `seed-roles.ts` gives the reason and this file
 * honours the distinction rather than arguing with it: **a permission that guards no route at all
 * is a key to a door that does not exist; a permission guarding a door that is locked by a flag is
 * a lock.** The first mints authority over nothing. The second is the structural-OFF pattern
 * `requireReceivableLane()` already ships one module over.
 *
 * ═══ WHAT THIS IS NOT ═══
 *
 * NOT the sales lane. There is no price, no card-sale invoice line, no cooling-off refund, no
 * disclosure script, no proration — Plan 22 T2 owns all of those and fills this body's caller in
 * ONE place when O-15 is ruled. What lives here is the primitive both need and which
 * `honourGrace` already contains a copy of: a patient, a plan, a validity window, an instance.
 */
const salesFlag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

/**
 * Read HERE and not through `loadConfig()`, for `memberBenefitsEnabled`'s measured reason: that
 * function parses the WHOLE environment, in which `DATABASE_URL` and `SECRET_KEY` are required with
 * no default, so it resolves on the build host and throws in CI. `z.enum(["true","false"])` and
 * never a coercing boolean — under coercion the string "false" is non-empty and therefore TRUE,
 * which would arm counter sales for an operator who wrote the value that means off.
 */
export function membershipSalesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env) loadEnv();
  return salesFlag.parse(env.MEMBERSHIP_SALES_ENABLED);
}

/** Every entry point in this lane opens with it, so the flag cannot be load-bearing in one door only. */
export function requireSalesLane(): void {
  if (!membershipSalesEnabled()) {
    throw new MembershipError(
      "sales_disabled",
      "MEMBERSHIP_SALES_ENABLED is off: the counter enrols nobody (owner ruling O-15 is open)",
    );
  }
}

export type EnrolInput = {
  patientId: string;
  planId: string;
  /** The printed card's code. The counter reads it off the card it is about to hand over. */
  cardCode: string;
  holderName: string;
};

export type EnrolResult = { instanceId: string; planId: string; cardCode: string; validTo: Date };

/**
 * Enrol a patient onto an existing plan. Refuses before it reads anything when the lane is off.
 *
 * `origin: "counter"` distinguishes these from `"import"` (the holder book) and `"grace"` (O-1's
 * honour-without-a-book-row), because provenance is what the reconcile queue and every commission
 * question are decided on later.
 */
export async function enrolMember(
  db: Db, actor: Actor, input: EnrolInput, now: Date = new Date(),
): Promise<EnrolResult> {
  requireSalesLane();
  if (actor.type !== "user") throw new MembershipError("sales_disabled", "an enrolment needs a user actor");

  const plans = await db
    .select({ id: membershipPlans.id, validityDays: membershipPlans.validityDays })
    .from(membershipPlans)
    .where(eq(membershipPlans.id, input.planId));
  const plan = plans[0];
  if (plan === undefined) throw new MembershipError("unknown_plan", `unknown plan ${input.planId}`);

  const instanceId = newId();
  const validTo = new Date(now.getTime() + plan.validityDays * 86_400_000);
  await withTx(db, async (tx) => {
    await tx.insert(membershipInstances).values({
      id: instanceId, planId: plan.id, cardCode: input.cardCode.trim(),
      holderName: input.holderName.trim(), patientId: input.patientId,
      validFrom: now, validTo, status: "active", origin: "counter",
      // C-17's rule, unchanged: an instance the holder book has not confirmed accrues nothing.
      verified: false,
    });
    // REVIEW MAJOR 7 — the actor, on the spine, inside the same transaction as the row. Without it
    // `membership_instances` records WHAT was minted and nothing records WHO minted it, which makes
    // D5's whole boundary unauditable.
    await appendEvent(tx, instrumentEnrolled.make({
      actor,
      patientId: input.patientId,
      payload: {
        instanceId, planId: plan.id, cardCode: input.cardCode.trim(),
        patientId: input.patientId, holderName: input.holderName.trim(),
      },
    }));
  });
  return { instanceId, planId: plan.id, cardCode: input.cardCode.trim(), validTo };
}
