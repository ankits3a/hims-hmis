import * as arrival from "./intents";
import * as triageIntents from "./triage";

export * from "./common";
export * from "./refusals";
export * from "./board";
export {
  ER_ESI_INFO, ER_ESI_LEVELS, ER_ESI_RESOURCES, ER_RETRIAGE_CLIMB_MIN, ErEsiDecisionSchema, ErEsiLevelSchema, ErEwsSchema, ErVitalsSchema,
  esiAlgorithm, isDownTriage,
} from "./triage";
export type { ErEsiDecision, ErEsiLevel, ErEws, ErVitals } from "./triage";
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
  // lane 2 (#809)
  triage: triageIntents.triage,
  re_triage: triageIntents.reTriage,
  record_er_vitals: triageIntents.recordErVitals,
  place_in_bay: triageIntents.placeInBay,
  move_bay: triageIntents.moveBay,
  assign_er_doctor: triageIntents.assignErDoctor,
} as const;
export type ErIntentName = keyof typeof ER_INTENTS;
export const ER_INTENT_NAMES = Object.keys(ER_INTENTS) as ErIntentName[];
