import { istDayIndex } from "./time";

export type VisitType = "new" | "revisit" | "renewal";

/**
 * §11.1 auto-detect. anchor = the patient's most recent COMPLETED consultation in the SAME DEPARTMENT (owner decision
 * 2026-08-15) with the follow-up window that consult carries (default 7; doctor-set 15/21/30). Inclusive, in IST calendar days.
 */
export function classifyVisit(anchor: { consultCompletedAt: Date; followUpDays: number } | null, now: Date): VisitType {
  if (anchor === null) return "new";
  const days = istDayIndex(now) - istDayIndex(anchor.consultCompletedAt);
  return days <= anchor.followUpDays ? "revisit" : "renewal";
}
