import type { AppConfig } from "../../kernel/config";

/**
 * ABDM S0 — the connector's settings, resolved from `AppConfig.abdm` ONLY when it is `configured`.
 *
 * Null otherwise, and every consumer treats null as "ABDM is off": the callback routes answer 503,
 * the operator CLI refuses, and no gateway client is ever constructed. There is no half-configured
 * client to call by mistake.
 */
export type AbdmSettings = {
  /** The HIE-CM gateway base, e.g. `https://dev.abdm.gov.in/api/hiecm` (NHA wrapper `application-v3.properties`). No trailing slash. */
  gatewayBaseUrl: string;
  /** The ABHA (M1) base — S1's concern; nullable because S0 never calls it. */
  abhaBaseUrl: string | null;
  clientId: string;
  /** NON-ENUMERABLE — present, readable, and absent from every JSON.stringify / spread / inspect. */
  clientSecret: string;
  /** `X-CM-ID`: `sbx` in the sandbox, `abdm` in production (NHA wrapper README §5). */
  cmId: "sbx" | "abdm";
  /** The HFR facility id this hospital answers as (`X-HIP-ID`). */
  hipId: string;
  hiuId: string | null;
  /** What `PATCH /gateway/v3/bridge/url` registers; callbacks arrive at `{this}/api/v3/...`. No trailing slash. */
  callbackBaseUrl: string;
  jwtAudience: string;
};

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

export function abdmSettingsFrom(abdm: AppConfig["abdm"]): AbdmSettings | null {
  if (!abdm.configured) return null;
  const settings = {
    gatewayBaseUrl: trimSlash(abdm.baseUrl!),
    abhaBaseUrl: abdm.abhaBaseUrl === null ? null : trimSlash(abdm.abhaBaseUrl),
    clientId: abdm.clientId!,
    cmId: abdm.cmId,
    hipId: abdm.hipId!,
    hiuId: abdm.hiuId,
    callbackBaseUrl: trimSlash(abdm.callbackBaseUrl!),
    jwtAudience: abdm.jwtAudience,
  } as AbdmSettings;
  Object.defineProperty(settings, "clientSecret", { value: abdm.clientSecret!, enumerable: false, writable: false });
  return settings;
}
