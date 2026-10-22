import * as arrival from "./intents";
import * as triageIntents from "./triage";
import * as care from "./care";
import * as mlc from "./mlc";
import * as bill from "./bill";
import * as codes from "./codes";
import * as mci from "./mci";
import * as dispo from "./dispo";

export * from "./common";
export * from "./refusals";
export * from "./board";
export {
  ER_ESI_INFO, ER_ESI_LEVELS, ER_ESI_RESOURCES, ER_RETRIAGE_CLIMB_MIN, ErEsiDecisionSchema, ErEsiLevelSchema, ErEwsSchema, ErVitalsSchema,
  esiAlgorithm, isDownTriage,
} from "./triage";
export type { ErEsiDecision, ErEsiLevel, ErEws, ErVitals } from "./triage";
export { ER_CONSENT_KINDS, ER_MED_ROUTES, ER_NOTE_KINDS } from "./care";
export {
  ER_MLC_CATEGORIES, ER_MLC_COUNTERSIGN_MIN, ER_MLC_FREE_BY_LAW, ER_MLC_INTIMATION_MIN, ER_MLC_LATE_MIN, ErMlcClockSchema,
  ErMlcDeskSchema, ErMlcDetailSchema, ErMlcRowSchema,
} from "./mlc";
export type { ErMlcCategory, ErMlcClock, ErMlcDesk, ErMlcDetail, ErMlcRow } from "./mlc";
export { ER_DISPOSITIONS, ER_REFERRAL_REASONS, ER_RETURN_IF_SIGNS } from "./dispo";
export {
  ER_OBSERVATION_BLOCK_HOURS, ER_OBSERVATION_FREE_HOURS, ER_PAYER_KINDS, ER_ROAD_ACCIDENT_CAP_PAISE, ER_ROAD_ACCIDENT_DAYS, ER_SERVICE_CODES,
  ErBillDeskSchema, ErBillLineSchema, ErBillSchema,
} from "./bill";
export type { ErBill, ErBillDesk, ErPayerKind } from "./bill";
export {
  ER_CODE_ANYWHERE, ER_CODE_CLOCKS, ER_CODE_EVENT_KINDS, ER_CODE_KINDS, ER_CODE_OUTCOMES, ER_CODE_TEAM, ER_RHYTHMS, ErCodeViewSchema, ErCodesSchema,
} from "./codes";
export type { ErCodeClockDef, ErCodeKind, ErCodeView, ErCodes } from "./codes";
export {
  ER_MCI_COMMAND_ROLES, ER_MCI_METHODS, ER_MCI_PACKS_MAX, ER_MCI_TAGS, ER_MCI_TAG_WORDS, ErMciBoardSchema, ErMciCountSchema, ErMciFindingsSchema,
  ER_MCI_FAMILY_STAGES, ER_MCI_PRESS_SCRIPT, ER_MCI_STOPS_DECISIONS, ER_MCI_STOPS_STATES, ErMciFamilyDeskSchema, ErMciPackSchema, ErMciZoneSchema, ErMciSurgeBedSchema, ErMciTagSchema, mciFamilyStage, mciTagProposal,
} from "./mci";
export type { ErMciBoard, ErMciCount, ErMciFamilyDesk, ErMciFamilyStage, ErMciFindings, ErMciMethod, ErMciPack, ErMciSurgeBed, ErMciTag, ErMciZone } from "./mci";
/** ER lane 6 (#813): the intents whose answers name money — the bill desk's, never a clinical screen's (0058). */
export const ER_MONEY_INTENTS = ["set_er_payer", "take_er_advance", "price_er_lines", "settle_er_bill", "open_er_event_account"] as const;
export type { ErDisposition, ErReturnIfSign } from "./dispo";
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
  // lane 4 (#811)
  open_mlc: mlc.openMlc,
  add_mlc_addendum: mlc.addMlcAddendum,
  record_police_intimation: mlc.recordPoliceIntimation,
  countersign_mlc: mlc.countersignMlc,
  record_belongings: mlc.recordBelongings,
  hand_over_evidence: mlc.handOverEvidence,
  // lane 5 (#812)
  decide_disposition: dispo.decideDisposition,
  discharge_from_er: dispo.dischargeFromEr,
  hand_to_unit: dispo.handToUnit,
  refer_out: dispo.referOut,
  record_lama: dispo.recordLama,
  record_lwbs: dispo.recordLwbs,
  record_abscond: dispo.recordAbscond,
  record_er_death: dispo.recordErDeath,
  record_specialty_refusal: dispo.recordSpecialtyRefusal,
  arbitrate_admission: dispo.arbitrateAdmission,
  // lane 6 (#813) — money: the ER bill desk only
  set_er_payer: bill.setErPayer,
  take_er_advance: bill.takeErAdvance,
  price_er_lines: bill.priceErLines,
  settle_er_bill: bill.settleErBill,
  open_er_event_account: bill.openErEventAccount,
  // lane 7 (#814) — codes and activations
  call_code: codes.callCode,
  record_code_event: codes.recordCodeEvent,
  end_code: codes.endCode,
  record_code_debrief: codes.recordCodeDebrief,
  // lane 8 (#815) — mass casualty, Code Yellow
  declare_mci: mci.declareMci,
  stand_down_mci: mci.standDownMci,
  mint_mci_packs: mci.mintMciPacks,
  register_mci_arrival: mci.registerMciArrival,
  mci_tag: mci.mciTag,
  open_surge_bays: mci.openSurgeBays,
  decide_mci_stops: mci.decideMciStops,
} as const;
export type ErIntentName = keyof typeof ER_INTENTS;
export const ER_INTENT_NAMES = Object.keys(ER_INTENTS) as ErIntentName[];
