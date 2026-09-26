import type { AbdmCallResult, AbdmGatewayClient } from "./gateway-client";

/**
 * ═══ ABDM S3 — THE HIU'S CALLS TO THE GATEWAY (M3), AND THE PUSH IT RECEIVES ═══
 *
 * EVERY M3 PATH BELOW IS UNVERIFIED UNTIL THE FIRST SANDBOX LOGIN (plan §2: this box cannot reach
 * `*.abdm.gov.in`). AUTHORITATIVE: the NHA wrapper's V3 HIU — `HIUConsentV3Service`,
 * `HIUConsentGatewayCallbackV3Service`, `HIUV3HealthInformationService`,
 * `HealthInformationV3GatewayCallbackService`, `GatewayURL.java`, `application-v3.properties` (W).
 * CROSS-CHECK: the Care connector's `gateway.py` HIU calls (C). `nha-in/docs` (N) is UNTRUSTED and is
 * named only where it disagrees; nothing from it is executed or copied.
 *
 * | # | Direction | Call | Path | Headers | Body (as built) | Source | Status |
 * |---|-----------|------|------|---------|-----------------|--------|--------|
 * | 1 | out | consent request | `POST {gw}/consent/v3/request/init` | X-HIU-ID | `{consent:{purpose:{text,code,refUri},patient:{id:<ABHA address>},hiu:{id},requester:{name,identifier:{type:"REGNO",value:<reg no>,system}},hiTypes,permission:{accessMode:"VIEW",dateRange:{from,to},dataEraseAt,frequency:{unit:"HOUR",value:1,repeats:0}}}}` — refUri = C's HL7 ValueSet URI (W's example says "wrapper"); requester identifier REGNO/mciindia = W's example, HPR id owed | W + C | UNVERIFIED |
 * | 2 | in | on-init | `{bridge}/api/v3/hiu/consent/request/on-init` | JWT | `{consentRequest:{id},error?,response:{requestId}}` | W | UNVERIFIED |
 * | 3 | out | status | `POST {gw}/consent/v3/request/status` | X-HIU-ID | `{consentRequestId}` | W + C | UNVERIFIED |
 * | 4 | in | on-status | `{bridge}/api/v3/hiu/consent/request/on-status` | JWT | `{consentRequest:{id,status},response}` — correlated by the consent-request id, as W's `consentRequestService` does | W | UNVERIFIED |
 * | 5 | in | notify | `{bridge}/api/v3/hiu/consent/request/notify` | JWT | `{notification:{consentRequestId,status:GRANTED|DENIED|REVOKED|EXPIRED,consentArtefacts:[{id}]}}` | W | UNVERIFIED |
 * | 6 | out | on-notify | `POST {gw}/consent/v3/request/hiu/on-notify` | X-HIU-ID | `{acknowledgement:[{status:"OK",consentId}],response:{requestId}}` — an ARRAY (W, C; the HIP's is an object) | W + C | UNVERIFIED |
 * | 7 | out | fetch | `POST {gw}/consent/v3/fetch` | X-HIU-ID | `{consentId}` | W + C | UNVERIFIED |
 * | 8 | in | on-fetch | `{bridge}/api/v3/hiu/consent/on-fetch` | JWT | `{consent:{status,consentDetail,signature},response}` | W | UNVERIFIED |
 * | 9 | out | HI request | `POST {gw}/data-flow/v3/health-information/request` | X-HIU-ID | `{hiRequest:{consent:{id},dateRange:<the ARTEFACT's>,dataPushUrl,keyMaterial:{cryptoAlg:"ECDH",curve:"Curve25519",dhPublicKey:{expiry,parameters,keyValue:<our X.509 key>},nonce}}}` — the artefact's range, or ABDM-1063 (spec §5) | W + C | UNVERIFIED |
 * | 10 | in | on-request | `{bridge}/api/v3/hiu/health-information/on-request` | JWT | `{hiRequest:{transactionId,sessionStatus},error?,response:{requestId}}` | W | UNVERIFIED |
 * | 11 | in | THE PUSH | `POST {dataPushUrl}` = `{ABDM_CALLBACK_BASE_URL}/hiu/data-push?pt=<token>` — the token in a QUERY parameter (below); that ABDM keeps a query string on `dataPushUrl` is unconfirmed | see below | `{pageNumber,pageCount,transactionId,entries:[{content,media,checksum,careContextReference}],keyMaterial}` | W (receiver `/v3/transfer/`); C (`…/hiu/health-information/transfer`) | UNVERIFIED |
 * | 12 | out | transfer notify | `POST {gw}/data-flow/v3/health-information/notify` | X-HIU-ID | `{notification:{consentId,transactionId,doneAt,notifier:{type:"HIU",id},statusNotification:{sessionStatus:"TRANSFERRED"|"FAILED",hipId,statusResponses:[{careContextReference,hiStatus:"OK"|"ERRORED",description}]}}}` — W sends TRANSFERRED; N says RECEIVED (untrusted); W puts its id under a header literally named `HIU` (a W defect), C and the spec say X-HIU-ID | W | UNVERIFIED |
 *
 * THE PUSH'S AUTHENTICATION (row 11) — DECIDED, UNVERIFIED. It is not an ABDM callback: W's HIP pushes
 * with NO Authorization header and W's receiver checks none; C's HIP sends its own gateway bearer and
 * C's receiver verifies a gateway JWT; N says "Authorization token is mandatory" (untrusted). Requiring
 * a JWT would refuse every W-based HIP, so the push is authenticated by what only the parties to THIS
 * transfer hold: (1) the 256-bit random token in the `dataPushUrl` we gave ABDM (stored as SHA-256
 * only, scrubbed from the logged request and from the edge access log), (2) the transaction id ABDM
 * assigned it, (3) AES-GCM ciphertext that authenticates only under OUR ephemeral key, and (4) the
 * entry checksum. A bearer, if
 * one comes, is neither required nor trusted. Confirm on the sandbox; pin a JWT check here if ABDM's
 * reference HIP sends one.
 *
 * WHERE THE TOKEN RIDES — DECIDED (WASA M-04), UNVERIFIED. In the QUERY parameter `pt`, not the path.
 * S3 first put it in the path (`…/data-push/<token>`); Caddy's access log keeps the path in the clear
 * by design (it is what makes a 5xx line diagnosable) and allows one filter per log field, so the
 * token went to disk. The `request>uri query` filter replaces `pt` (docker/prod/Caddyfile; pinned by
 * test/caddyfile-hardening.test.ts). UNVERIFIED: whether ABDM (and every HIP) POSTs to `dataPushUrl`
 * with its query string intact is unconfirmed until the sandbox — the path form was no more verified.
 * If the sandbox drops it, every push answers 404 `unknown_transfer`, and this is what to revisit.
 *
 * Details still open: the checksum (W sends the literal "string", C sends "", N says MD5 of the
 * plaintext — we REFUSE a real MD5 (hex or base64) that does not match and record the placeholders
 * as unverified, the GCM tag still authenticating every byte); pageNumber from 0 (W) or 1 (C) — we
 * count distinct pages; `accessMode` VIEW (C's default) while we keep the bundles until `dataEraseAt`.
 */
export const HIU_PATHS = {
  consentInit: "/consent/v3/request/init",
  consentStatus: "/consent/v3/request/status",
  consentOnNotify: "/consent/v3/request/hiu/on-notify",
  consentFetch: "/consent/v3/fetch",
  hiRequest: "/data-flow/v3/health-information/request",
  hiNotify: "/data-flow/v3/health-information/notify",
} as const;

/** Our push route, under the callback base (`{ABDM_CALLBACK_BASE_URL}/hiu/data-push?pt=<token>`). */
export const HIU_PUSH_PREFIX = "/hiu/data-push";

/**
 * The QUERY parameter that carries the push token — never a path segment (the edge log keeps paths;
 * its query filter replaces this name). Pinned against the Caddyfile by caddyfile-hardening.test.ts.
 */
export const HIU_PUSH_TOKEN_PARAM = "pt";

/**
 * The HL7 v3 PurposeOfUse codes ABDM's consent carries (spec summary §4.3; C `Purpose`). A doctor in a
 * consultation may ask for CARE MANAGEMENT (the default) or BREAK-THE-GLASS; the other four are
 * listed because the spec allows them and refused here, because they are not a treating doctor's
 * purposes (public health, payment, research, and the patient's own request).
 */
export const ABDM_PURPOSES = {
  CAREMGT: "Care Management",
  BTG: "Break the Glass",
  PUBHLTH: "Public Health",
  HPAYMT: "Healthcare Payment",
  DSRCH: "Disease Specific Healthcare Research",
  PATRQT: "Self Requested",
} as const;
export type AbdmPurpose = keyof typeof ABDM_PURPOSES;
export const CONSULT_PURPOSES: readonly AbdmPurpose[] = ["CAREMGT", "BTG"];
export const PURPOSE_REF_URI = "http://terminology.hl7.org/ValueSet/v3-PurposeOfUse";

/** Every HI type the spec lists (W `HiTypeEnum`, spec §4.1) — an HMIS asks for all eight (FT FAQ Q2). */
export const ALL_HI_TYPES = [
  "OPConsultation", "Prescription", "DiagnosticReport", "DischargeSummary",
  "ImmunizationRecord", "HealthDocumentRecord", "WellnessRecord", "Invoice",
] as const;
export type AnyHiType = (typeof ALL_HI_TYPES)[number];
/** The default ask: the three the consult renders in full. The rest render generically. */
export const DEFAULT_REQUEST_HI_TYPES: readonly AnyHiType[] = ["OPConsultation", "Prescription", "DiagnosticReport"];

type CallOpts = { patientId?: string | null; requestId?: string; actorId?: string | null; secrets?: readonly string[] };

export class HiuClient {
  constructor(
    private readonly client: Pick<AbdmGatewayClient, "call">,
    private readonly hiuId: string,
  ) {}

  private post(path: string, kind: string, body: unknown, opts: CallOpts = {}): Promise<AbdmCallResult> {
    return this.client.call("POST", path, body, {
      kind,
      hiuId: this.hiuId,
      patientId: opts.patientId ?? null,
      ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
      ...(opts.actorId === undefined ? {} : { actorId: opts.actorId }),
      ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
    });
  }

  consentInit(body: unknown, opts: CallOpts): Promise<AbdmCallResult> {
    return this.post(HIU_PATHS.consentInit, "gateway.hiu.consent_init", body, opts);
  }

  consentStatus(body: unknown, opts: CallOpts): Promise<AbdmCallResult> {
    return this.post(HIU_PATHS.consentStatus, "gateway.hiu.consent_status", body, opts);
  }

  consentOnNotify(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIU_PATHS.consentOnNotify, "gateway.hiu.consent_on_notify", body, { patientId });
  }

  consentFetch(body: unknown, opts: CallOpts): Promise<AbdmCallResult> {
    return this.post(HIU_PATHS.consentFetch, "gateway.hiu.consent_fetch", body, opts);
  }

  /** The push URL's token is a credential: it rides `secrets`, so the logged body carries `[redacted]`. */
  hiRequest(body: unknown, opts: CallOpts): Promise<AbdmCallResult> {
    return this.post(HIU_PATHS.hiRequest, "gateway.hiu.hi_request", body, opts);
  }

  hiNotify(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIU_PATHS.hiNotify, "gateway.hiu.hi_notify", body, { patientId });
  }
}

