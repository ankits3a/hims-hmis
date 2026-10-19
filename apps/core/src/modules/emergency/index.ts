/**
 * ER lane 1 (#808, decision 0076) — THE cross-module interface of the emergency module: other modules import it only
 * through here (lint-enforced). Lane 1: the module surface, the ER episode workflow, the arrival and identity intents,
 * the band, the tracking board and the ER desk reads. Later lanes (triage, care, MLC, disposition, bill, codes, MCI,
 * copilot) add to this file.
 */
// Importing this module DEFINES the re-triage task kind and its skill (the API and the worker both need them).
import "./task-kinds";
export { emergencyManifest } from "./manifest";
export { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_CARE, ER_BILL, ER_CODES, ER_DISPOSITION, ER_IDENTITY_LINK, ER_MCI, ER_MLC, ER_TRIAGE } from "./names";
export { EmergencyModule } from "./emergency.module";
export { ErError, ErRefusal, erRefusalStatus } from "./errors";
export type { ErErrorCode } from "./errors";
export {
  ER_ACTOR_ROLE_KEYS, ER_EPISODE_TRANSITIONS, ER_EPISODE_WORKFLOW_DEF_KEY, erEpisodeWorkflowDefinition,
} from "./workflow";
export type { ErEpisodeTransition } from "./workflow";
export {
  ER_LAPSE_ACTOR, cancelPreAlert, lapseErPreAlerts, preAlert, recordBroughtDead, registerArrival, registerUnidentified,
} from "./arrival";
export { printErBand, reprintErBand } from "./bands";
export { linkIdentity } from "./identity";
export { listErDoctors, readErBoard, readErDesk, searchErPatients } from "./board";
export { ER_BOARD_EVENT_NAMES } from "./events";
export { ER_REALTIME_NAMES, ER_TOPIC_SPACES, erTopicRouter, erTopicsFor } from "./realtime";
// Lane 2 (#809) — triage, vitals, bays, the ER doctor, the re-triage clock, the triage screen's reads.
export {
  ER_CLOCK_ACTOR, ER_RETRIAGE_FALLBACK_ROLE, assignErDoctor, moveBay, placeInBay, reTriage, recordErVitals, sweepErTriageClocks, triage,
} from "./triage";
export { ER_RETRIAGE_TASK, ER_TRIAGE_DUE_TASK, ER_TRIAGE_SKILL } from "./task-kinds";
export { listErBays, readErEpisode } from "./board";
// Lane 3 (#810) — care, the `ER` encounter resolver and charge sink, the care clocks, the care reads.
export {
  ER_CALL_CLIMB_MIN, ER_CARE_ACTOR, ER_CRITICAL_CLIMB_MIN, ER_SATELLITE_STORE_CODE, ER_VERBAL_SIGN_MIN, answerCall, callSpecialty,
  cosignErNote, declareStabilised, giveErDose, issueErMed, returnErMed, placeErOrder, recordConsent, recordErNote, recordProcedure,
  signErVerbalOrder, sweepErCareClocks,
} from "./care";
export {
  ER_EPISODE_NO_RE, ER_EPISODE_PREFIX, erChargeLinesOf, erChargeSink, postErChargeIn, registerErChargeSink, registerErEncounterResolver,
} from "./charge-sink";
export { listErItems, readErCare } from "./care-read";
// Lane 4 (#811) — the medico-legal case: the register, its obligations and clocks, custody, the MLC desk reads.
export {
  ER_MLC_ACTOR, ER_MLC_INTIMATION_CLIMB_MIN, addMlcAddendum, countersignMlc, handOverEvidence, mlcOfEpisode, openMlc,
  readMlc, readMlcDesk, recordBelongings, recordPoliceIntimation, sweepErMlcClocks,
} from "./mlc";
export { ER_MLC_INTIMATION_TASK, ER_MLC_SKILL } from "./task-kinds";
// Lane 5 (#812) — disposition and departure: decide, discharge, hand to a unit (boarding), refer out, LAMA, LWBS, abscond, death.
export {
  ER_BOARDING_CLIMB_MIN, ER_BOARDING_TASK_MIN, ER_DISPO_ACTOR, arbitrateAdmission, decideDisposition, recordSpecialtyRefusal, departIn, dischargeFromEr, handToUnit, recordAbscond, recordErDeathIntent, recordLama, recordLwbs, referOut,
  sweepErBoarding,
} from "./dispo";
export { ER_ARBITRATION_TASK, ER_BED_SKILL, ER_BOARDING_TASK, ER_MS_SKILL } from "./task-kinds";
// Lane 6 (#813) — the ER bill (money; the bill desk only): payer, advance, pricing, settle / dues, event account, roll-over.
export {
  composeErBill, listErClaims, observationBlocks, openErEventAccount, priceErLines, readErBill, readErBillDesk, rollErLinesIn, setErPayer,
  settleErBill, takeErAdvance, visitFeeLines,
} from "./bill";
// Lane 7 (#814) — codes and activations: call, the resuscitation record, end, debrief, clocks.
export { activationClocksFor, callCode, codeClocks, endCode, readErCode, readErCodes, recordCodeDebrief, recordCodeEvent } from "./codes";
// Lane 8 (#815) — mass casualty, Code Yellow: declare, packs, arrival from a pack, START / JumpSTART tags, surge bays, board.
export {
  declareMci, listMciOverflowBeds, listMciPacks, mciTag, mintMciPacks, openSurgeBays, packNoOf, readMciBoard, readMciCount, registerMciArrival, standDownMci,
} from "./mci";
// Lane 9 (#816) — the ER copilot: Now cards, the ESI proposal (rules), "since arrival", drafts, the waiting display, tools.
export { checkEsiProposal, readEsiProposal } from "./copilot-esi";
export { istHm, readSinceArrival, sinceCandidates, verifyErSinceLine } from "./copilot-since";
export { ER_DRAFT_BUDGET_MS, buildErDraft, buildErReferralDraft, buildErSummaryDraft, buildMlcNarrativeDraft } from "./copilot-drafts";
export { askErModel, erModelBarred, erModelFrom } from "./copilot-model";
export type { ErFallback, ErModel } from "./copilot-model";
export { readErWaitingDisplay, stageOf } from "./copilot-waiting";
export { emergencyCopilotIntents, emergencyCopilotTools } from "./copilot-tools";
export {
  boardingLongCard, callUnansweredCard, casualtyNowCard, criticalResultCard, doctorOverdueCard, lwbsRiskCard, mlcCountersignDueCard,
  mlcIntimationDueCard, preAlertCard, resultReadyCard, retriageDueCard,
} from "./now-cards";
