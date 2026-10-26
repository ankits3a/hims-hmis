import type { Actor } from "@hmis/contracts";

/** The module's names, in one leaf file so the manifest, the kinds and the consumer import no cycle. */
export const HOUSEKEEPING_VIEW = "housekeeping.view";
export const HOUSEKEEPING_VERIFY_TERMINAL = "housekeeping.verify_terminal";
/** HK-1 (#973) — areas, classes, checklists, QR codes, contractors and staff. */
export const HOUSEKEEPING_SETUP_MANAGE = "housekeeping.setup.manage";
/** HK-1 (#973) — draft and publish the shift rota. */
export const HOUSEKEEPING_ROTA_MANAGE = "housekeeping.rota.manage";
/** HK-1 (#973) — Pass or Fail a clean or a round (beside `ipd.beds.clean` on the ward side). */
export const HOUSEKEEPING_CONFIRM = "housekeeping.confirm";
/** HK-1 (#973) — the public door: who raises a door-QR request (no login). */
export const HOUSEKEEPING_DOOR_ACTOR: Actor = { type: "system", id: "housekeeping-door" };
/** HK-1 (#973) — the rounds clock. */
export const HOUSEKEEPING_ROUNDS_ACTOR: Actor = { type: "system", id: "housekeeping-rounds" };
/** The worker's consumer name for the bed's kernel events (`workerConsumers`). */
export const HOUSEKEEPING_BED_CONSUMER = "housekeeping.bed_turnover";
/** Who raises and cancels a clean on the bed's behalf. */
export const HOUSEKEEPING_ACTOR: Actor = { type: "system", id: "housekeeping-turnover" };
/** The cleaning skill (`support_staff`), defined in `kinds.ts`; named here so setup can read its holders without a cycle. */
export const HOUSEKEEPING_SKILL = "housekeeping";
