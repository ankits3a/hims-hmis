import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 07c T9 / DD14 — **THE AUDIT TRAIL COVERS THE AUDITOR.**
 *
 * A supervisor's view of a named staff member is hospital work product and is not, by itself, a
 * patient-privacy event: counts, money and timings name nobody. The moment somebody drills from
 * "three credit-extended" to WHICH three, it becomes one — a named person reading a named
 * patient list about somebody else's shift — and that is exactly the read a DPDP register is
 * asked about after an incident.
 *
 * So the drill is its own act, with its own permission, its own stated reason, and this row. The
 * reason is `min(1)` because an unfilled reason box is the same as no reason at all, and a control
 * that can be satisfied by pressing Enter is a control nobody will have thought about.
 */
export const staffReportDrilled = defineEvent("staff_report.drilled", "desk", z.object({
  /** The person whose work was opened. The SUPERVISOR is the event's own `actor`. */
  subjectUserId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(1),
  sections: z.number().int().nonnegative(),
  /** How many rows were revealed — "what did they actually see" is the question afterwards. */
  rows: z.number().int().nonnegative(),
}));
