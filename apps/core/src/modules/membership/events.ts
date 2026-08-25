import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The membership module's event surface. Every name carries `module: "membership"` (Global
 * Constraints — catalog discipline), and money fields are integer paise (§3.19 — no coercing
 * schema helper anywhere near a payload).
 *
 * THREE NAMES SHIP WITH THE SCHEMA, and each is one the plan states in as many words rather than
 * one this task invented:
 *   - `instrument.grace_honored` — O-1's named grace-honor path.
 *   - `coupon.redemption_released` — O-4's release, which is an EVENT because the redemption row
 *     itself is append-only.
 *   - `instrument.lookup_refused` — DD15: a rate-limited card lookup emits an event and writes NO
 *     audit row, because writing refusals to the counted table makes every retry extend the block.
 *
 * T3, T4 and T5 add their own names to `MEMBERSHIP_EVENTS` as their lanes land; `events.test.ts`
 * is written to allow exactly that without lying — see its header.
 */
const MODULE = "membership";
const id = z.string().min(1);

/**
 * O-1 — a card the book does not know is either partner feed lag or fraud, and the counter cannot
 * tell them apart. The honouring is allowed behind an approval, and it says so out loud: the
 * instance is created with `origin = 'grace'` and accrues nothing until a real book row matches it.
 */
export const instrumentGraceHonored = defineEvent(
  "instrument.grace_honored",
  MODULE,
  z.object({
    instanceId: id, cardCode: id, patientId: id, approvalId: id,
    reason: z.string().min(1),
  }),
);

/**
 * O-4 — the sale the coupon was consumed against was cancelled, so the coupon comes back. Narrow
 * on purpose: `markEnteredInError` of the invoice's receipt, or a FULL-value `correction` credit
 * note. A partial refund releases nothing.
 */
export const couponRedemptionReleased = defineEvent(
  "coupon.redemption_released",
  MODULE,
  z.object({
    redemptionId: id, releaseRowId: id, couponId: id, invoiceId: id,
    trigger: z.enum(["entered_in_error", "correction_credit_note"]),
  }),
);

/**
 * DD15 — the recognition surface must not become an enumeration oracle. `checkSearchRate` refuses,
 * and THIS is where the refusal is recorded: on the spine, never in `search_audit`, because the
 * limiter counts that table and a refusal written there would extend its own block.
 */
export const instrumentLookupRefused = defineEvent(
  "instrument.lookup_refused",
  MODULE,
  z.object({
    actorId: id, reason: z.enum(["rate_limited"]),
    limit: z.number().int().positive(), windowSec: z.number().int().positive(),
  }),
);

/** The catalog `events.test.ts` pins. Later tasks in this phase APPEND to it. */
export const MEMBERSHIP_EVENTS = [
  instrumentGraceHonored,
  couponRedemptionReleased,
  instrumentLookupRefused,
] as const;
