import type { AbdmJwtClaims } from "./callback-auth";

/**
 * ═══ ABDM S0 — THE CALLBACKS ABDM POSTS TO THE BRIDGE, AND THE REGISTRY LATER SLICES FILL ═══
 *
 * ABDM posts every callback to `{bridge url}{path}`, and the paths are FIXED by ABDM, not chosen by
 * us. This list is transcribed from the NHA wrapper's `v3/common/constants/GatewayURL.java`
 * (authoritative, spec summary §2) — every HIP and HIU path it names, and no others. A path ABDM
 * does not call is not a route: an unknown callback is a 404 rather than a row in the log.
 *
 * The public URL is `{ABDM_CALLBACK_BASE_URL}{path}`; with the base set to
 * `https://<host>/api/abdm/callbacks`, Caddy strips `/api` and the core serves
 * `/abdm/callbacks{path}` (`callbacks.controller.ts`).
 *
 * THE REGISTRY. S0 ships the routes and no handlers: every kind is logged and answered 202, and a
 * kind nobody handles yet is recorded `unhandled` rather than refused (refusing would make ABDM
 * retry a message we have already stored). S1–S3 call `registerAbdmCallbackHandler` for their kinds.
 */
export const ABDM_CALLBACKS = [
  // HIP — profile share (scan and share)
  "/api/v3/hip/patient/share",
  // HIP — HIP-initiated linking
  "/api/v3/hip/token/on-generate-token",
  "/api/v3/link/on_carecontext",
  "/api/v3/links/context/on-notify",
  // HIP — deep-linking SMS
  "/api/v3/patients/sms/on-notify",
  // HIP — patient-initiated discovery and linking
  "/api/v3/hip/patient/care-context/discover",
  "/api/v3/hip/link/care-context/init",
  "/api/v3/hip/link/care-context/confirm",
  // HIP — consent and data transfer
  "/api/v3/consent/request/hip/notify",
  "/api/v3/hip/health-information/request",
  // HIU — consent
  "/api/v3/hiu/consent/request/on-init",
  "/api/v3/hiu/consent/request/on-status",
  "/api/v3/hiu/consent/request/notify",
  "/api/v3/hiu/consent/on-fetch",
  // HIU — data transfer
  "/api/v3/hiu/health-information/on-request",
] as const;

export type AbdmCallbackPath = (typeof ABDM_CALLBACKS)[number];

/** `/api/v3/hip/patient/share` → `callback.hip/patient/share` — the message-log kind and the registry key. */
export function callbackKind(path: string): string {
  return `callback.${path.replace(/^\/api\/v3\//, "")}`;
}

export type AbdmInboundMessage = {
  /** The `abdm_messages` row this callback was stored as. */
  messageId: string;
  kind: string;
  path: string;
  /** ABDM's `REQUEST-ID` for this callback. */
  requestId: string;
  /** `response.requestId` — the outbound REQUEST-ID an `on-*` callback answers, when it names one. */
  correlationRequestId: string | null;
  hipId: string | null;
  hiuId: string | null;
  body: unknown;
  claims: AbdmJwtClaims;
};

export type AbdmCallbackHandler = (message: AbdmInboundMessage) => Promise<void>;

const handlers = new Map<string, AbdmCallbackHandler>();

/**
 * Registers the handler for one callback kind; returns the unregister function. A SECOND handler for
 * a kind is a programming error and throws — two slices both answering one callback would each send
 * an `on-*` reply, and ABDM would receive two answers to one question.
 */
export function registerAbdmCallbackHandler(kind: string, handler: AbdmCallbackHandler): () => void {
  if (handlers.has(kind)) throw new Error(`an ABDM callback handler is already registered for ${kind}`);
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

export function abdmCallbackHandler(kind: string): AbdmCallbackHandler | undefined {
  return handlers.get(kind);
}
