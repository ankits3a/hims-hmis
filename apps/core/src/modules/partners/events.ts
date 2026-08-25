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

/** The catalog `events.test.ts` pins. Later tasks in this phase APPEND to it. */
export const PARTNERS_EVENTS = [
  payoutClassBlocked,
  expectationWrittenOff,
] as const;
