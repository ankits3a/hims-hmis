/**
 * THE cross-module interface of the abdm module (spec §4). Everything else in this folder is private;
 * the module-isolation lint rule enforces it. Plan: `docs/superpowers/plans/2026-09-25-abdm-connector.md`.
 *
 * S0 moved no patient data: config, the gateway client, callback authentication, the message log,
 * the callback routes and their handler registry, and the bridge-registration CLI.
 *
 * S1 (M1 — ABHA at the counter): the ABHA client over S0's session, the verify / create / link
 * flows, and scan-and-share.
 */
export { AbdmModule } from "./abdm.module";
export { ABDM_CLOCK, ABDM_FETCH, AbdmRuntime } from "./runtime";
export { abdmSettingsFrom } from "./settings";
export type { AbdmSettings } from "./settings";
export { AbdmGatewayClient, AbdmGatewayError, TOKEN_FALLBACK_LIFETIME_S, TOKEN_REFRESH_EARLY_MS } from "./gateway-client";
export type { AbdmCallOptions, AbdmCallResult, AbdmFetch, AbdmHttpMethod } from "./gateway-client";
export { AbdmCallbackAuthError, AbdmCallbackVerifier } from "./callback-auth";
export type { AbdmCallbackAuthReason, AbdmJwtClaims } from "./callback-auth";
export { ABDM_CALLBACKS, callbackKind, registerAbdmCallbackHandler } from "./callbacks";
export type { AbdmCallbackHandler, AbdmCallbackPath, AbdmInboundMessage } from "./callbacks";
export { listAbdmMessages } from "./messages";
export type { AbdmMessageRow } from "./messages";
export { ABHA_ENCRYPTION, ABHA_ENCRYPTION_NAME, ABHA_PATHS, AbhaClient, AbhaError } from "./abha-client";
export type { AbhaLoginKind, AbhaOtpSystem } from "./abha-client";
export { AbhaFlowError, AbhaService, classifyAbhaIdentifier } from "./abha-service";
export type { AbhaFlowView } from "./abha-service";
export { ABHA_TXN_TTL_MS, AbhaTransactions } from "./abha-transactions";
export { compareWithPatient, readAbdmProfile } from "./profile";
export type { AbdmProfile, FieldComparison } from "./profile";
export { counterQrUrl, ON_SHARE_PATH, ProfileShares, SHARE_TOKEN_EXPIRY_S } from "./profile-shares";
export type { ShareView } from "./profile-shares";
