/**
 * #1077 — `reports.ts` IS SPLIT: `report-authoring.ts`, `report-signature.ts` and `criticals.ts`, every
 * public name through `index.ts`. This file is NOT part of the split and nothing in the module imports
 * it. It survives only because the approved, locked acceptance test of #1076
 * (`acceptance/imaging-quick-wins-1076.test.ts`) imports these three names from `../reports`, and an
 * agent may not edit a locked check. It is deleted (spec #1077 D5) once that import line points at
 * `../index` — owner's call.
 */
export { draftReport } from "./report-authoring";
export { publishReport, signReport } from "./report-signature";
