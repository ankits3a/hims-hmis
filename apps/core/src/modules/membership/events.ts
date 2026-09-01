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

/**
 * PLAN 09 T5 — one drop of a partner's holder book, read and decided.
 *
 * The counts are the whole payload: how many rows arrived, how many became cards, how many were
 * refused and how many the hospital already had. A dispute about a partner's book starts here and
 * then goes to `import_quarantine` and `holder_book_imports` for the lines themselves — the event
 * carries no holder name, no card code and no person, because a spine that carried the book would
 * be a second copy of it.
 */
export const holderBookImported = defineEvent(
  "holder_book.imported",
  MODULE,
  z.object({
    importId: id, counterpartyId: id, fileName: z.string().min(1), columnMapVersion: z.string().min(1),
    rowsTotal: z.number().int().nonnegative(),
    rowsAccepted: z.number().int().nonnegative(),
    rowsQuarantined: z.number().int().nonnegative(),
    rowsAlreadyApplied: z.number().int().nonnegative(),
  }),
);

/**
 * T5/E3 — A HUMAN decided which patient an imported holder is. The importer never links, whatever
 * the similarity score, so this event is the ONLY record that a card changed hands from "nobody" to
 * a named person — and it is the record a later dispute about a wrong link is settled from.
 */
export const instrumentHolderLinked = defineEvent(
  "instrument.holder_linked",
  MODULE,
  z.object({
    queueItemId: id, instanceId: id, patientId: id,
    reason: z.enum(["fuzzy_match", "merge_duplicate", "cap_overflow", "lapsed_restore"]),
  }),
);

/** The catalog `events.test.ts` pins. Later tasks in this phase APPEND to it. */
/**
 * RC-2 review MAJOR 7 — WHO ENROLLED WHOM.
 *
 * `enrolMember` was a copy of `graceHonor`'s insert MINUS its `appendEvent`, and
 * `membership_instances` carries no actor column at all — no `created_by`, no `issued_by`. So the
 * permission boundary D5 exists to draw ("the clerk who honours a card cannot mint one") had
 * crossings that nothing recorded: ten instances would appear with `origin='counter'`, a timestamp,
 * and no way for any report or audit to name who made them.
 *
 * The event carries the actor the way every other membership event does, which is also why this is
 * an event rather than a column: no migration, and the spine is where "what did somebody do" lives.
 */
export const instrumentEnrolled = defineEvent(
  "instrument.enrolled",
  MODULE,
  z.object({
    instanceId: id, planId: id, cardCode: z.string().min(1), patientId: id,
    holderName: z.string().min(1),
  }),
);

export const MEMBERSHIP_EVENTS = [
  instrumentGraceHonored,
  couponRedemptionReleased,
  instrumentLookupRefused,
  holderBookImported,
  instrumentHolderLinked,
  instrumentEnrolled,
] as const;
