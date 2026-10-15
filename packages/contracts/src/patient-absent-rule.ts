/**
 * Which visits a guardian may stand in for ("guardian with reports" — the patient did not come).
 *
 * Owner 2026-10-09: *"we should give this feature to not just revisit or renewal but new patient as
 * well. This will meet the objective. Let's not complicate much."* — EVERY visit type: new, revisit,
 * renewal, and whatever type is added later. (Until that ruling, 2026-10-07: a returning patient only.)
 * What still decides is not the type: the visit must be waiting for vitals, the caller must hold the
 * bay's or the desk's grant, and the fee door is asked — all on the server (`opd/patient-absent.ts`).
 *
 * The function stays so the rule has ONE place: the server, the web screens and the phone all ask it,
 * and a later ruling changes one line.
 *
 * DEPENDENCY-FREE ON PURPOSE. The phone app imports this file straight from packages/contracts (it is
 * not in the pnpm workspace; metro.config.js watches the folder), and its CI job installs only the
 * app's own packages — a `zod` import here fails its `tsc` with "Cannot find module 'zod'".
 */
export function guardianMayStandIn(visitType: string | null | undefined): boolean {
  void visitType; // every type today; the argument stays so no caller changes when a ruling narrows it
  return true;
}
