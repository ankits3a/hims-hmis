import { istDayIndex } from "./time";

export type VisitType = "new" | "revisit" | "renewal";

/**
 * OWNER RULING 2026-09-24 (money): a patient who consults the REFERRED department within this many
 * days of an internal referral pays no fee. Counted exactly as a follow-up window is — IST calendar
 * days, inclusive — from the moment of the referral.
 */
export const REFERRAL_FREE_DAYS = 7;

/**
 * §11.1 auto-detect. anchor = the patient's most recent COMPLETED consultation in the SAME DEPARTMENT (owner decision
 * 2026-08-15) with the follow-up window that consult carries (default 7; doctor-set 15/21/30). Inclusive, in IST calendar days.
 *
 * `referredAt` is the second anchor the owner ruled on 2026-09-24: the most recent internal referral INTO this
 * department. Inside its window the visit is a free follow-up whatever the consult anchor says. Outside it, the
 * referral changes nothing — the visit is `new` or `renewal` exactly as it would have been, because a lapsed
 * referral is not a consultation and must not turn a first visit into a renewal.
 */
export function classifyVisit(
  anchor: { consultCompletedAt: Date; followUpDays: number } | null, now: Date, referredAt: Date | null = null,
): VisitType {
  if (referredAt !== null && istDayIndex(now) - istDayIndex(referredAt) <= REFERRAL_FREE_DAYS) return "revisit";
  if (anchor === null) return "new";
  const days = istDayIndex(now) - istDayIndex(anchor.consultCompletedAt);
  return days <= anchor.followUpDays ? "revisit" : "renewal";
}
