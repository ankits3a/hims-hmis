import type { WireDoctorSummary } from "./opd-api";

/**
 * ═══ FD-7 T2 — THE WALK-IN'S THREE RULES, AS ONE PURE FUNCTION ═══
 *
 * The owner's routing ruling, in order, and the order is the whole design:
 *
 *   1. CONTINUITY — a prior consultation in this department routes the patient back to THAT doctor,
 *      **even when his line is longer**. Six months (the server owns the window, `continuity.ts`).
 *   2. SHORTEST WAIT — only when nobody here has seen them.
 *   3. NOBODY AT ALL — "join the department queue" names no doctor.
 *
 * It is a function rather than a lump of component code because the ORDER is the thing most likely
 * to be got wrong later, and an ordering that lives in JSX can only be asserted through a rendered
 * screen. Every rule below is killed by its own test in `walk-in-routing.test.ts`.
 *
 * The proposal is never applied on its own: the seat renders it, names the rule that fired, and the
 * clerk confirms or overrules. Nothing here seats anybody.
 */
export type RoutingRule = "continuity" | "shortest_wait" | "department_queue";

/** What the server answers for rule 1 (`GET /opd/continuity`). */
export type WireContinuityAnchor = { doctorId: string; doctorName: string; seenOn: string };

/**
 * THE 20-MINUTE RULE — owner, 2026-09-03: *"If the wait time exceeds 20 minutes, highlight the user
 * about the delay and suggest lower wait time based doctor."*
 *
 * It is a HIGHLIGHT, not a re-route. Continuity still wins; the clerk is told the line is long and
 * shown who is shorter, and the clerk decides. A rule that silently switched the patient away from
 * the doctor who knows them would be rule 2 wearing rule 1's name.
 */
export const DELAY_HIGHLIGHT_MINUTES = 20;

export type WalkInProposal = {
  rule: RoutingRule;
  doctor: WireDoctorSummary | null;
  waitMinutes: number | null;
  /** True when the proposed wait exceeds `DELAY_HIGHLIGHT_MINUTES`. */
  delayed: boolean;
  /** Named only when somebody in this department is genuinely quicker than the proposal. */
  alternative: WireDoctorSummary | null;
  alternativeWaitMinutes: number | null;
  /** Carried so the card can say WHO and WHEN, not merely "you have been here before". */
  anchor: WireContinuityAnchor | null;
  /** The anchor doctor exists but is not on today's board — rule 1 dropped out to rule 2. */
  anchorUnavailable: boolean;
};

const waitOf = (s: WireDoctorSummary): number => s.waitingCount * s.avgConsultMinutes;

/**
 * Who can actually take a patient in this department today. `scheduledToday` is the server's own
 * answer to "is this doctor sitting" — a doctor on leave, off the weekly template or without a
 * session is not on the board, which is exactly how "a doctor on leave drops out to rule 2" is
 * implemented: it needs no leave lookup of its own, because the board already knows.
 */
function availableIn(departmentId: string, summaries: readonly WireDoctorSummary[]): WireDoctorSummary[] {
  return summaries.filter((s) => s.doctor.departmentId === departmentId && s.doctor.active && s.scheduledToday);
}

/**
 * Ties broken by name, so two doctors with identical queues propose the SAME one on every render.
 * An unstable proposal would re-seat the patient between the clerk reading the card and confirming it.
 */
function shortest(candidates: readonly WireDoctorSummary[]): WireDoctorSummary | null {
  const sorted = [...candidates].sort((a, b) =>
    waitOf(a) - waitOf(b)
    || a.waitingCount - b.waitingCount
    || a.doctor.displayName.localeCompare(b.doctor.displayName));
  return sorted[0] ?? null;
}

export function proposeWalkIn(
  departmentId: string,
  summaries: readonly WireDoctorSummary[],
  anchor: WireContinuityAnchor | null,
): WalkInProposal {
  const candidates = availableIn(departmentId, summaries);
  const quickest = shortest(candidates);

  const anchored = anchor === null ? null : candidates.find((s) => s.doctor.id === anchor.doctorId) ?? null;
  const anchorUnavailable = anchor !== null && anchored === null;

  const chosen = anchored ?? quickest;
  if (chosen === null) {
    return {
      rule: "department_queue", doctor: null, waitMinutes: null, delayed: false,
      alternative: null, alternativeWaitMinutes: null, anchor, anchorUnavailable,
    };
  }

  const waitMinutes = waitOf(chosen);
  const delayed = waitMinutes > DELAY_HIGHLIGHT_MINUTES;
  /*
   * Only a STRICTLY quicker doctor is worth naming; when the proposal is already the shortest line
   * the delay is still shown and there is simply nothing to offer.
   *
   * `<`, and nothing else. An earlier draft also compared ids to stop the proposal offering ITSELF —
   * a mutant proved that clause could not be killed by any test, because a doctor can never be
   * strictly quicker than himself, and `<=` in its place IS caught by "the shortest-wait proposal
   * never names itself as the alternative". One guarded comparison beats two, one of them untestable.
   */
  const alternative = delayed && quickest !== null && waitOf(quickest) < waitMinutes ? quickest : null;

  return {
    rule: anchored !== null ? "continuity" : "shortest_wait",
    doctor: chosen,
    waitMinutes,
    delayed,
    alternative,
    alternativeWaitMinutes: alternative === null ? null : waitOf(alternative),
    anchor,
    anchorUnavailable,
  };
}
