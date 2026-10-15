/**
 * ER lane 1 (#808) — the emergency module's permission strings, in a file of their own so the manifest and the intents
 * import them without a cycle (the IPD `permissions.ts` precedent). Meanings are in `manifest.ts`.
 */
export const ER_BOARD_VIEW = "er.board.view";
export const ER_ARRIVAL_REGISTER = "er.arrival.register";
/**
 * `link_identity` files a `patient_merge` request — the same act as the merge screen's "Request merge" — so it asks the
 * same permission the patients module's route asks. DECIDED (lane 1): no new ER string for it.
 */
export const ER_IDENTITY_LINK = "patients.merge";
/**
 * ER lane 2 (#809) — triage, re-triage, vitals, bays and the ER doctor of record: the casualty nurse's and the doctor's
 * clinical acts (spec §4.2: "triage by a nurse or doctor with the er.triage grant"). DECIDED: one string for the five
 * acts; no money behind any of them.
 */
export const ER_TRIAGE = "er.triage";
