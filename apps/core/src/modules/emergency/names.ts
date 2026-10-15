/**
 * ER lane 1 (#808) — the emergency module's permission strings, in a file of their own so the manifest and the intents
 * import them without a cycle (the IPD `permissions.ts` precedent). Meanings are in `manifest.ts`.
 */
export const ER_BOARD_VIEW = "er.board.view";
export const ER_ARRIVAL_REGISTER = "er.arrival.register";
/**
 * ER review (2026-10-15, DECIDED) — the wall display's own string: a kiosk or wall screen reads the board in wall mode
 * (initials or the alias, no UHID, no complaint, no police chip) and nothing else.
 */
export const ER_BOARD_WALL = "er.board.wall";
/**
 * `link_identity` files a `patient_merge` request — the same act as the merge screen's "Request merge" — so it asks the
 * same permission the patients module's route asks. DECIDED (lane 1): no new ER string for it.
 */
export const ER_IDENTITY_LINK = "patients.merge";
