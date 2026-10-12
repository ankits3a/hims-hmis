import type { Actor } from "@hmis/contracts";

/** The module's names, in one leaf file so the manifest, the kinds and the consumer import no cycle. */
export const HOUSEKEEPING_VIEW = "housekeeping.view";
export const HOUSEKEEPING_VERIFY_TERMINAL = "housekeeping.verify_terminal";
/** The worker's consumer name for the bed's kernel events (`workerConsumers`). */
export const HOUSEKEEPING_BED_CONSUMER = "housekeeping.bed_turnover";
/** Who raises and cancels a clean on the bed's behalf. */
export const HOUSEKEEPING_ACTOR: Actor = { type: "system", id: "housekeeping-turnover" };
