/**
 * Which visits a guardian may stand in for ("patient not present — guardian with reports").
 * Owner 2026-10-07: a returning patient — revisit (inside the follow-up window, free) or renewal (past
 * it, charged) — never a new visit.
 *
 * DEPENDENCY-FREE ON PURPOSE. The phone app imports this file straight from packages/contracts (it is
 * not in the pnpm workspace; metro.config.js watches the folder), and its CI job installs only the
 * app's own packages — a `zod` import here fails its `tsc` with "Cannot find module 'zod'".
 */
export const PATIENT_ABSENT_VISIT_TYPES = ["revisit", "renewal"] as const;

/** True when a visit of this type may be marked "patient not present — guardian with reports". */
export function guardianMayStandIn(visitType: string | null | undefined): boolean {
  return visitType !== null && visitType !== undefined && (PATIENT_ABSENT_VISIT_TYPES as readonly string[]).includes(visitType);
}
