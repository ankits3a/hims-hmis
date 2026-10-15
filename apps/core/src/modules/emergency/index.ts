/**
 * ER lane 1 (#808, decision 0076) — THE cross-module interface of the emergency module: other modules import it only
 * through here (lint-enforced). Lane 1: the module surface, the ER episode workflow, the arrival and identity intents,
 * the band, the tracking board and the ER desk reads. Later lanes (triage, care, MLC, disposition, bill, codes, MCI,
 * copilot) add to this file.
 */
// Importing this module DEFINES the re-triage task kind and its skill (the API and the worker both need them).
import "./task-kinds";
export { emergencyManifest } from "./manifest";
export { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_IDENTITY_LINK, ER_TRIAGE } from "./names";
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
export { ER_RETRIAGE_TASK, ER_TRIAGE_SKILL } from "./task-kinds";
export { listErBays, readErEpisode } from "./board";
