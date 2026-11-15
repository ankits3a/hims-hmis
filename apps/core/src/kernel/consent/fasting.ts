/** NPO thresholds — one constant, one owner (16a DD5). Not configurable in this phase on purpose:
 *  6 h for solids and 2 h for clear fluids is the ASA fasting guideline every Indian OT runs.
 *  Moved here from `modules/ot/gates.ts` (#1086): the IR suite fasts its patients by the same hours. */
export const NPO_SOLIDS_HOURS = 6;
export const NPO_CLEAR_FLUIDS_HOURS = 2;
