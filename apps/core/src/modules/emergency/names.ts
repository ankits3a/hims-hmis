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
