/**
 * ═══ WHY A PATIENT WAS SKIPPED — THE VOCABULARY (owner, 2026-09-13) ═══
 *
 * *"If I am clicking Skip for the right reason, what could it be? it should be auditable. right?"*
 *
 * These five are the reasons an OPD token is passed over in an Indian corporate hospital, in the
 * order a counter meets them. They are CODED and not free text for the same reason `UNLOCK_REASONS`
 * is (`vitals-rules.ts`): a coded reason can be COUNTED, and *"how many patients missed their turn
 * this month because the billing queue was slow"* is a question the hospital gets to ask of its own
 * day. `other` carries the free text, and is the only one that requires it.
 *
 * ═══ "I CLICKED IT BY MISTAKE" IS DELIBERATELY NOT ON THIS LIST ═══
 *
 * It is the one answer that must not cost the patient anything, and a reason code cannot give a
 * turn back — `undoSkip` does. A mis-click recorded as a reason would leave the patient at the end
 * of the queue with a tidy audit trail explaining why, which is the wrong shape of honesty.
 */
export const SKIP_REASONS = ["absent", "stepped_out", "at_billing", "at_investigation", "not_ready", "other"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
