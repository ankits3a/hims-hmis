/**
 * E1.6 TRANSPORT (issue #723, decision 0072) — other modules import this one only through here (lint-enforced).
 * Importing it DEFINES transport's task kinds and the porter skill (`./kinds`), which both the API and the worker need.
 */
import "./kinds";
export { transportManifest } from "./manifest";
export { ESCORT_ROLE_KEYS, TRANSPORT_ACTOR, TRANSPORT_MANAGE, TRANSPORT_REQUEST, TRANSPORT_WORK } from "./names";
export { DOCUMENT_RUN, PATIENT_MOVE, PORTER_SKILL, SAMPLE_RUN } from "./kinds";
export { TransportModule } from "./transport.module";
export { TransportRefusal, transportHttpStatus } from "./errors";
export { addEscort, escortCandidates, recordOxygenCheck, requestPatientMove, requestTransport } from "./requests";
export type { TransportRequestResult } from "./requests";
export { isHighRiskForTransport } from "./risk";
export type { TransportRisk } from "./risk";
export { patientOptions, placeOptions, transportBoard, transportDetails } from "./reads";
