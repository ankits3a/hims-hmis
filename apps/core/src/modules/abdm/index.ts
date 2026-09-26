/**
 * THE cross-module interface of the abdm module (spec §4). Everything else in this folder is private;
 * the module-isolation lint rule enforces it. Plan: `docs/superpowers/plans/2026-09-25-abdm-connector.md`.
 *
 * S0 (this slice) moves no patient data: config, the gateway client, callback authentication, the
 * message log, the callback routes and their handler registry, and the bridge-registration CLI.
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
