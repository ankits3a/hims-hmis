import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The partners module's event surface. Every name carries `module: "partners"`; money is integer
 * paise (§3.19).
 *
 * TWO NAMES SHIP WITH THE SCHEMA, both stated by the plan rather than invented here:
 *   - `payout.class_blocked` — DD4 keeps it "for the attempt path". An external-RMP counterparty
 *     may exist; money owed to one may not, and an attempt is a fact worth recording precisely
 *     because the database refused it silently and structurally.
 *   - `expectation.written_off` — DD13/V5: an expectation nobody ever confirms expires after a
 *     configured number of days into `written_off`, evented, and appears in the aging report
 *     before it does.
 *
 * T6 and T7 add their own names as their lanes land; `events.test.ts` allows that without lying —
 * see its header.
 */
const MODULE = "partners";
const id = z.string().min(1);
const nonNegPaise = z.number().int().nonnegative();
/**
 * SIGNED paise. A correction can move money DOWN (V3), and an event that clamped that to zero
 * would make the spine disagree with the ledger it is describing — which is the one thing an
 * audit record may never do.
 */
const signedPaise = z.number().int();

/**
 * DD4 — the attempt to pay a class that cannot be paid. The schema refuses the row (composite FK
 * plus CHECK, measured in §3 Q1); this is how the refusal becomes visible to a human instead of
 * being an integrity error in a log.
 */
export const payoutClassBlocked = defineEvent(
  "payout.class_blocked",
  MODULE,
  z.object({
    counterpartyId: id,
    payeeClass: z.enum(["channel_partner", "staff_internal", "external_rmp"]),
    amountPaise: nonNegPaise,
    reason: z.string().min(1),
  }),
);

/** DD13 / V5 — the unclaimed slip's end state, evented so the aging report is never the only record. */
export const expectationWrittenOff = defineEvent(
  "expectation.written_off",
  MODULE,
  z.object({
    expectationId: id, counterpartyId: id, amountPaise: nonNegPaise,
    reason: z.string().min(1),
  }),
);

/**
 * ═══ PLAN 09 T7 — THE RECEIVABLE LANE'S FIVE NAMES (DD13, V1-V6) ═══
 *
 * DD15 governs every payload below: **instrument ids, attribution ids and amounts, and nothing
 * else.** No name, no UHID, no phone, no patient id — not even on an internal spine event, because
 * the cheapest way to keep a partner-facing surface identity-free is for the facts it is built
 * from not to carry identity in the first place. `attribution_ids.patient_id` is where the
 * hospital's own link lives, and it stays there.
 */

/** One outbound referral, one id, one partner (DD13). The slip's code is printed and QR-encoded. */
export const attributionIssued = defineEvent(
  "attribution.issued",
  MODULE,
  z.object({
    attributionId: id, expectationId: id, counterpartyId: id,
    code: z.string().min(1),
    expectedPaise: nonNegPaise,
    expiresAt: z.string().min(1),
  }),
);

/** V4 — the referred test was cancelled, so the claim it backs is written off rather than chased. */
export const attributionVoided = defineEvent(
  "attribution.voided",
  MODULE,
  z.object({
    attributionId: id, counterpartyId: id,
    expectationIds: z.array(id),
    reason: z.string().min(1),
  }),
);

/** One partner statement, imported once. The counts are the reconciliation's own headline. */
export const statementImported = defineEvent(
  "statement.imported",
  MODULE,
  z.object({
    counterpartyId: id,
    statementRef: z.string().min(1),
    statementPeriod: z.string().min(1),
    columnMapVersion: z.string().min(1),
    linesTotal: z.number().int().nonnegative(),
    linesMatched: z.number().int().nonnegative(),
    linesDisputed: z.number().int().nonnegative(),
    linesCorrected: z.number().int().nonnegative(),
    linesQuarantined: z.number().int().nonnegative(),
    /** SIGNED — a statement that is net a downward correction confirms a NEGATIVE total (V3). */
    confirmedPaise: signedPaise,
  }),
);

/**
 * V1/V6 — a line this hospital will not silently accept. It is a RARE SEMANTIC FACT and it belongs
 * on the spine for the same reason `instrument.lookup_refused` does: if it ever stops being rare,
 * the volume is visible where somebody is already looking.
 */
export const expectationDisputed = defineEvent(
  "expectation.disputed",
  MODULE,
  z.object({
    expectationId: id, counterpartyId: id,
    attributionId: z.string().min(1).nullable(),
    statementRef: z.string().min(1),
    statementLineNo: z.number().int().positive(),
    amountPaise: nonNegPaise,
    reason: z.enum(["unknown_attribution", "attribution_partner_mismatch", "amount_mismatch"]),
  }),
);

/**
 * V3 / DD5 — a statement amending a PRIOR period lands as an ADJUSTMENT ROW naming that period,
 * and edits nothing. `deltaPaise` is SIGNED: a partner correcting itself downwards is a negative
 * adjustment, never a smaller number written over the old one.
 */
export const expectationCorrected = defineEvent(
  "expectation.corrected",
  MODULE,
  z.object({
    expectationId: id, counterpartyId: id, attributionId: id, accrualId: id,
    correctsPeriod: z.string().min(1),
    statementRef: z.string().min(1),
    deltaPaise: z.number().int(),
  }),
);

/** The catalog `events.test.ts` pins. Later tasks in this phase APPEND to it. */
export const PARTNERS_EVENTS = [
  payoutClassBlocked,
  expectationWrittenOff,
  attributionIssued,
  attributionVoided,
  statementImported,
  expectationDisputed,
  expectationCorrected,
] as const;
