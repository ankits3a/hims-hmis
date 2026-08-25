import { and, asc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { couponDefinitions, couponRedemptions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { MembershipError } from "./errors";
import { couponRedemptionReleased } from "./events";
import type { ResolvedInstruments } from "./instruments";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 09 T4 — COUPON REDEMPTION AND O-4's RELEASE. The redemption is written inside the invoice's
 * own transaction; the release is written inside the transaction of the thing that cancelled the
 * sale. Both are ROWS on an append-only table (migration 0022's trigger), never a status column.
 *
 * ═══ BELT AND BRACES, AND BOTH WERE MEASURED WITHOUT THE OTHER (DD10, §3 Q6) ═══
 *
 * The BRACES are `SELECT … FOR UPDATE` on `coupon_definitions`, taken before the redemptions are
 * counted, so two concurrent invoices redeeming one code cannot both read "not yet redeemed".
 * The BELT is the partial unique index `coupon_redemptions_single_use_uq` on
 * `(coupon_id, cycle_no) WHERE single_use AND state = 'redeemed'`, which is what survives a future
 * writer who forgets the lock. The spike measured each without the other: with the lock removed
 * the index fired 10/10 with a raw `23505` and the second redemption never landed; with both
 * present the refusal was a clean typed one 10/10 and the index never fired. **The lock's job is
 * to turn a raw 23505 into a clean typed refusal; the index's job is that the second redemption
 * never lands.** Book row D3 builds both mutants for exactly that reason.
 *
 * ═══ `cycle_no` IS WHAT MAKES O-4 AND DD5 SIMULTANEOUSLY TRUE (relay note 3) ═══
 *
 * A release cannot UPDATE the redeemed row — the trigger refuses — so it is a SECOND row; but then
 * the first row is still `state = 'redeemed'`, and an index keyed on `coupon_id` alone would refuse
 * the re-redemption O-4 exists to permit. `cycle_no` is the number of RELEASES already recorded for
 * the coupon, so a second redemption WITHOUT a release lands on the same cycle and is refused,
 * while a redemption AFTER a release lands on the next cycle and is allowed.
 *
 * ═══ AN ALREADY-REDEEMED SINGLE-USE COUPON IS NARROWED OUT BEFORE PRICING ═══
 *
 * `narrowToRedeemableCoupons` runs at composition time, so a bundled single-use coupon that has
 * already been spent simply proposes nothing on the next bill. Without that, every subsequent
 * invoice for that patient would REFUSE rather than price — the counter would stop working for the
 * member the day their coupon was used. The in-transaction refusal below is a RACE guard.
 */

/** What the composer and the writer both need to know about one coupon's redemption history. */
export type CouponRedemptionState = {
  couponId: string;
  /** Denormalised onto every redemption row at insert, exactly as DD10 says — the index cannot
   *  reach through the FK, and the flag that was true when the coupon was redeemed is the flag
   *  that should govern that redemption. */
  singleUse: boolean;
  /** The number of RELEASES so far. The next redemption lands on this cycle. */
  cycleNo: number;
  /** Redemptions not yet negated by a release row. Non-empty ⇒ a single-use coupon is spent. */
  openRedemptionIds: string[];
};

export type CouponRedemptionRequest = {
  couponId: string;
  instanceId: string | null;
  /** What the coupon actually took off this invoice — Σ of its winning candidates, integer paise. */
  amountPaise: number;
};

export type ReleasedRedemption = {
  redemptionId: string;
  releaseRowId: string;
  couponId: string;
};

/** O-4's two triggers and nothing else. A partial refund is not among them. */
export type ReleaseTrigger = "entered_in_error" | "correction_credit_note";

/**
 * The redemption history of these coupons, folded per coupon. Reads `coupon_definitions` for
 * `single_use` because `ResolvedCoupon` does not carry it: `instruments.ts` is T2's and frozen, and
 * single-use is a property of the CATALOG row rather than of the benefit arithmetic.
 */
export async function couponRedemptionStates(
  exec: Db | Tx,
  couponIds: string[],
): Promise<Map<string, CouponRedemptionState>> {
  const out = new Map<string, CouponRedemptionState>();
  if (couponIds.length === 0) return out;
  const definitions = await exec
    .select({ id: couponDefinitions.id, singleUse: couponDefinitions.singleUse })
    .from(couponDefinitions)
    .where(inArray(couponDefinitions.id, couponIds));
  const rows = await exec
    .select()
    .from(couponRedemptions)
    .where(inArray(couponRedemptions.couponId, couponIds))
    .orderBy(asc(couponRedemptions.seq));

  for (const definition of definitions) {
    const mine = rows.filter((r) => r.couponId === definition.id);
    const releasedOf = new Set(mine.filter((r) => r.state === "released").map((r) => r.releasedOfId));
    out.set(definition.id, {
      couponId: definition.id,
      singleUse: definition.singleUse,
      cycleNo: mine.filter((r) => r.state === "released").length,
      openRedemptionIds: mine.filter((r) => r.state === "redeemed" && !releasedOf.has(r.id)).map((r) => r.id),
    });
  }
  return out;
}

/**
 * THE PRE-PRICING NARROWING (see the file header). A single-use coupon with an open redemption
 * proposes nothing; a multi-use coupon is never narrowed here, because how many times it may be
 * used is the catalog's business and this phase issues no per-coupon usage cap.
 */
export function narrowToRedeemableCoupons(
  resolved: ResolvedInstruments,
  states: Map<string, CouponRedemptionState>,
): ResolvedInstruments {
  const coupons = resolved.coupons.filter((coupon) => {
    const state = states.get(coupon.couponId);
    if (state === undefined) return true;
    return !state.singleUse || state.openRedemptionIds.length === 0;
  });
  return coupons.length === resolved.coupons.length ? resolved : { ...resolved, coupons };
}

/**
 * DD10's WRITE, coupon side. One ordered `SELECT … FOR UPDATE` over the coupon CATALOG rows this
 * invoice redeems, then the count and the insert inside that lock.
 *
 * Ordered by coupon id and taken as ONE statement — the same rule the entitlement writer and the
 * billing allocation writers follow, so two invoices redeeming two coupons in opposite orders
 * cannot deadlock.
 */
export async function redeemCoupons(
  tx: Tx,
  actor: Actor,
  input: {
    invoiceId: string;
    patientId: string;
    at: Date;
    redemptions: CouponRedemptionRequest[];
  },
): Promise<{ redemptionIds: string[] }> {
  if (input.redemptions.length === 0) return { redemptionIds: [] };
  const couponIds = [...new Set(input.redemptions.map((r) => r.couponId))].sort();

  // THE BRACES (DD10). Everything below reads a coupon nobody else may be redeeming.
  await tx
    .select({ id: couponDefinitions.id })
    .from(couponDefinitions)
    .where(inArray(couponDefinitions.id, couponIds))
    .orderBy(asc(couponDefinitions.id))
    .for("update");

  const states = await couponRedemptionStates(tx, couponIds);
  const redemptionIds: string[] = [];
  for (const request of input.redemptions) {
    const state = states.get(request.couponId);
    if (state === undefined) {
      throw new MembershipError("unknown_coupon", `unknown coupon ${request.couponId}`, { couponId: request.couponId });
    }
    if (state.singleUse && state.openRedemptionIds.length > 0) {
      throw new MembershipError(
        "coupon_already_redeemed",
        `coupon ${request.couponId} is single-use and has already been redeemed`,
        { couponId: request.couponId, redemptionId: state.openRedemptionIds[0], cycleNo: state.cycleNo },
      );
    }
    const id = newId();
    await tx.insert(couponRedemptions).values({
      id,
      couponId: request.couponId,
      cycleNo: state.cycleNo,
      state: "redeemed",
      singleUse: state.singleUse,
      patientId: input.patientId,
      invoiceId: input.invoiceId,
      instanceId: request.instanceId,
      amountPaise: request.amountPaise,
      releasedOfId: null,
      reason: null,
      actorId: actor.id,
      at: input.at,
    });
    // The state is re-folded in memory so two requests for ONE coupon on ONE invoice cannot both
    // read "not yet redeemed" — the same shape as `askedQtyByLine`'s fold in `credit-notes.ts`.
    states.set(request.couponId, { ...state, openRedemptionIds: [...state.openRedemptionIds, id] });
    redemptionIds.push(id);
  }
  return { redemptionIds };
}

/**
 * O-4 — THE RELEASE. Every open redemption against this invoice comes back as a NEGATING ROW, and
 * `coupon.redemption_released` is appended per redemption inside the caller's transaction.
 *
 * ═══ THE NARROWING IS THE RULING, AND IT LIVES IN THE CALLERS ═══
 *
 * Release happens on `markEnteredInError` of the invoice's receipt, or on a `correction` credit
 * note — and on nothing else. A partial refund releases nothing, "because the sale the coupon was
 * consumed against really did happen". This function is deliberately unconditional once called:
 * putting the trigger test here as well would give the ruling two homes and let them drift.
 *
 * The release row carries `amount_paise` 0 and the redemption's own `cycle_no` — it names the
 * cycle it closes, and the partial unique index does not see it (that index is
 * `WHERE single_use AND state = 'redeemed'`).
 */
export async function releaseRedemptions(
  tx: Tx,
  actor: Actor,
  input: { invoiceId: string; trigger: ReleaseTrigger; at: Date; reason: string },
): Promise<ReleasedRedemption[]> {
  const mine = await tx
    .select()
    .from(couponRedemptions)
    .where(eq(couponRedemptions.invoiceId, input.invoiceId))
    .orderBy(asc(couponRedemptions.seq));
  const redeemed = mine.filter((r) => r.state === "redeemed");
  if (redeemed.length === 0) return [];

  const couponIds = [...new Set(redeemed.map((r) => r.couponId))].sort();
  // The same catalog lock the redemption takes, and for the same reason: `cycle_no` is derived
  // from the release COUNT, so two concurrent releases outside a lock would both write and hand
  // the coupon back twice.
  await tx
    .select({ id: couponDefinitions.id })
    .from(couponDefinitions)
    .where(inArray(couponDefinitions.id, couponIds))
    .orderBy(asc(couponDefinitions.id))
    .for("update");

  const releasedRows = await tx
    .select({ releasedOfId: couponRedemptions.releasedOfId })
    .from(couponRedemptions)
    .where(and(inArray(couponRedemptions.couponId, couponIds), eq(couponRedemptions.state, "released")));
  const alreadyReleased = new Set(releasedRows.map((r) => r.releasedOfId));

  const out: ReleasedRedemption[] = [];
  for (const redemption of redeemed) {
    if (alreadyReleased.has(redemption.id)) continue;
    const releaseRowId = newId();
    await tx.insert(couponRedemptions).values({
      id: releaseRowId,
      couponId: redemption.couponId,
      cycleNo: redemption.cycleNo,
      state: "released",
      singleUse: redemption.singleUse,
      patientId: redemption.patientId,
      invoiceId: redemption.invoiceId,
      instanceId: redemption.instanceId,
      amountPaise: 0,
      releasedOfId: redemption.id,
      reason: input.reason,
      actorId: actor.id,
      at: input.at,
    });
    await appendEvent(
      tx,
      couponRedemptionReleased.make({
        actor,
        payload: {
          redemptionId: redemption.id,
          releaseRowId,
          couponId: redemption.couponId,
          invoiceId: redemption.invoiceId,
          trigger: input.trigger,
        },
        patientId: redemption.patientId,
        correlationId: redemption.invoiceId, // invoice-scoped emission (Global Constraints)
      }),
    );
    out.push({ redemptionId: redemption.id, releaseRowId, couponId: redemption.couponId });
  }
  return out;
}

/** Every redemption row of one invoice, arrival order (`seq`, never the ULID — §3.26). */
export async function couponRedemptionsOf(
  exec: Db | Tx,
  invoiceId: string,
): Promise<(typeof couponRedemptions.$inferSelect)[]> {
  return exec
    .select()
    .from(couponRedemptions)
    .where(eq(couponRedemptions.invoiceId, invoiceId))
    .orderBy(asc(couponRedemptions.seq));
}
