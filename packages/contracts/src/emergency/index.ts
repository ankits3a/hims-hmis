import * as arrival from "./intents";

export * from "./common";
export * from "./refusals";
export * from "./board";
export { ErBandPayloadSchema } from "./intents";
export type { ErBandPayload } from "./intents";

/** ER lane 1 (#808) — the contracted intents, by their spec §2 names. Later lanes add theirs here. */
export const ER_INTENTS = {
  pre_alert: arrival.preAlert,
  cancel_pre_alert: arrival.cancelPreAlert,
  register_arrival: arrival.registerArrival,
  register_unidentified: arrival.registerUnidentified,
  record_brought_dead: arrival.recordBroughtDead,
  print_er_band: arrival.printErBand,
  reprint_er_band: arrival.reprintErBand,
  link_identity: arrival.linkIdentity,
} as const;
export type ErIntentName = keyof typeof ER_INTENTS;
export const ER_INTENT_NAMES = Object.keys(ER_INTENTS) as ErIntentName[];
