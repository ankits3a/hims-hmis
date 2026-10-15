import * as arrival from "./intents";
import * as triageIntents from "./triage";
import * as care from "./care";

export * from "./common";
export * from "./refusals";
export * from "./board";
export {
  ER_ESI_INFO, ER_ESI_LEVELS, ER_ESI_RESOURCES, ER_RETRIAGE_CLIMB_MIN, ErEsiDecisionSchema, ErEsiLevelSchema, ErEwsSchema, ErVitalsSchema,
  esiAlgorithm, isDownTriage,
} from "./triage";
export type { ErEsiDecision, ErEsiLevel, ErEws, ErVitals } from "./triage";
export { ER_CONSENT_KINDS, ER_MED_ROUTES, ER_NOTE_KINDS } from "./care";
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
  // lane 3 (#810)
  record_er_note: care.recordErNote,
  cosign_er_note: care.cosignErNote,
  place_er_order: care.placeErOrder,
  issue_er_med: care.issueErMed,
  give_er_dose: care.giveErDose,
  return_er_med: care.returnErMed,
  sign_er_verbal_order: care.signErVerbalOrder,
  record_procedure: care.recordProcedure,
  record_consent: care.recordConsent,
  call_specialty: care.callSpecialty,
  answer_call: care.answerCall,
  declare_stabilised: care.declareStabilised,
} as const;
export type ErIntentName = keyof typeof ER_INTENTS;
export const ER_INTENT_NAMES = Object.keys(ER_INTENTS) as ErIntentName[];
