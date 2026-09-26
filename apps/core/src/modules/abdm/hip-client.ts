import { randomUUID } from "node:crypto";
import { completeOutbound, insertOutbound } from "./messages";
import { loggableHeaders } from "./redact";
import type { AbdmCallResult, AbdmFetch, AbdmGatewayClient } from "./gateway-client";
import type { AbdmSettings } from "./settings";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — THE HIP'S CALLS TO THE GATEWAY (M2), AND THE DATA PUSH TO AN HIU ═══
 *
 * EVERY PATH BELOW IS UNVERIFIED UNTIL THE FIRST SANDBOX LOGIN (plan §2: this box cannot reach
 * `*.abdm.gov.in`). Primary source: the NHA wrapper (authoritative — `application-v3.properties`,
 * `HIPLinkV3Service`, `DiscoveryV3Service`, `LinkV3Service`, `ConsentV3Service`,
 * `HIPHealthInformationV3Service`, `EncryptionService`, `CipherKeyManager`). Cross-check: the Care
 * connector (`abdm/service/v3/gateway.py`). `nha-in/docs` is untrusted and used for nothing here but
 * to note where it disagrees.
 *
 * | # | Call | Path / target | Headers | Body (as built) | Source | Status |
 * |---|------|---------------|---------|-----------------|--------|--------|
 * | 1 | link token | `POST {gw}/v3/token/generate-token` | X-HIP-ID | `{abhaAddress,name,gender,yearOfBirth}` (no abhaNumber — the wrapper's `GenerateTokenRequest`) | W | UNVERIFIED |
 * | 2 | link care contexts | `POST {gw}/hip/v3/link/carecontext` | X-HIP-ID, X-LINK-TOKEN | `{abhaNumber (the token's claim),abhaAddress,patient:[{referenceNumber,display,careContexts,hiType,count}]}` — `hiType` singular (W), NOT nha-in's `hiTypes` | W | UNVERIFIED |
 * | 3 | context notify | `POST {gw}/hip/v3/link/context/notify` | X-HIP-ID | `{notification:{patient:{id},careContext:{patientReference,careContextReference},hiTypes,date,hip:{id}}}` | W | UNVERIFIED |
 * | 4 | on-discover | `POST {gw}/user-initiated-linking/v3/patient/care-context/on-discover` | X-HIP-ID | `{transactionId,patient:[…per hiType…],matchedBy,response:{requestId}}` / `error` `ABDM-1010` | W | UNVERIFIED |
 * | 5 | on-init | `POST {gw}/user-initiated-linking/v3/link/care-context/on-init` | X-HIP-ID | `{transactionId,link:{referenceNumber,authenticationType:"MEDIATE",meta:{communicationMedium:"MOBILE",communicationHint,communicationExpiry}},response}` — W says `MEDIATE`; nha-in says `DIRECT|MEDIATED` | W | UNVERIFIED |
 * | 6 | on-confirm | `POST {gw}/user-initiated-linking/v3/link/care-context/on-confirm` | X-HIP-ID | `{patient:[…],response}` / `error` `ABDM-1035` "Incorrect OTP" | W | UNVERIFIED |
 * | 7 | consent on-notify | `POST {gw}/consent/v3/request/hip/on-notify` | X-HIP-ID | `{acknowledgement:{status:"OK",consentId},response}` — within 60 s (FT FAQ Q36) | W | UNVERIFIED |
 * | 8 | HI on-request | `POST {gw}/data-flow/v3/health-information/hip/on-request` | X-HIP-ID | `{hiRequest:{transactionId,sessionStatus:"ACKNOWLEDGED"},response}` / `error` | W | UNVERIFIED |
 * | 9 | data push | `POST {dataPushUrl}` (the HIU, NOT the gateway) | none — W sends no Authorization; Care sends ITS gateway token, which would hand our credential to the HIU, so we do not | `{pageNumber (from 0),pageCount,transactionId,entries:[{content,media,checksum,careContextReference}],keyMaterial}`, 7 entries a page (W) | W | UNVERIFIED |
 * | 10 | transfer notify | `POST {gw}/data-flow/v3/health-information/notify` | X-HIP-ID | `{notification:{consentId,transactionId,doneAt,notifier:{type:"HIP",id},statusNotification:{sessionStatus,hipId,statusResponses:[{careContextReference,hiStatus,description}]}}}` | W | UNVERIFIED |
 *
 * Details still open on each: the push `checksum` (W sends the literal "string", Care sends "",
 * nha-in says MD5 of the plaintext — we send the MD5 hex; UNVERIFIED); `keyMaterial.curve` spelling
 * (W echoes the requester's; we echo it too); the `gender` code `U` for unknown (W sends whatever the
 * facility stores); whether ABDM wants the ABHA number dashed or bare in (2) (an integrator saw a
 * dashed one refused — we send the token's own claim unchanged).
 *
 * Every call goes through S0's gateway client, so it carries REQUEST-ID/TIMESTAMP/X-CM-ID and the
 * session token, and is written to `abdm_messages` BEFORE it is sent. The link token rides a header
 * the log redacts (`*token*`) and is added to the call's scrub list. The data push is logged by THIS
 * file — as a summary (care contexts, checksums, sizes, our PUBLIC key and nonce), never the
 * ciphertext and never a private key.
 */
export const HIP_PATHS = {
  generateToken: "/v3/token/generate-token",
  addCareContexts: "/hip/v3/link/carecontext",
  contextNotify: "/hip/v3/link/context/notify",
  onDiscover: "/user-initiated-linking/v3/patient/care-context/on-discover",
  onInit: "/user-initiated-linking/v3/link/care-context/on-init",
  onConfirm: "/user-initiated-linking/v3/link/care-context/on-confirm",
  consentOnNotify: "/consent/v3/request/hip/on-notify",
  hiOnRequest: "/data-flow/v3/health-information/hip/on-request",
  hiNotify: "/data-flow/v3/health-information/notify",
} as const;

/** Wrapper `HIPHealthInformationV3Service`: `int pageSize = 7`, pages numbered from 0. */
export const PUSH_PAGE_SIZE = 7;
const PUSH_TIMEOUT_MS = 30_000;

export class HipClient {
  constructor(
    private readonly client: Pick<AbdmGatewayClient, "call">,
    private readonly settings: AbdmSettings,
    private readonly deps: { db: Db; fetch: AbdmFetch; now: () => Date },
  ) {}

  private post(path: string, kind: string, body: unknown, opts: { patientId?: string | null; linkToken?: string; requestId?: string } = {}): Promise<AbdmCallResult> {
    return this.client.call("POST", path, body, {
      kind,
      hipId: this.settings.hipId,
      patientId: opts.patientId ?? null,
      ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
      ...(opts.linkToken === undefined ? {} : { extraHeaders: { "X-LINK-TOKEN": opts.linkToken }, secrets: [opts.linkToken] }),
    });
  }

  generateToken(body: { abhaAddress: string; name: string; gender: string; yearOfBirth: number }, patientId: string, requestId: string): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.generateToken, "gateway.hip.generate_token", body, { patientId, requestId });
  }

  addCareContexts(linkToken: string, body: unknown, patientId: string, requestId: string): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.addCareContexts, "gateway.hip.add_care_contexts", body, { patientId, linkToken, requestId });
  }

  contextNotify(body: unknown, patientId: string): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.contextNotify, "gateway.hip.context_notify", body, { patientId });
  }

  onDiscover(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.onDiscover, "gateway.hip.on_discover", body, { patientId });
  }

  onInit(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.onInit, "gateway.hip.on_init", body, { patientId });
  }

  onConfirm(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.onConfirm, "gateway.hip.on_confirm", body, { patientId });
  }

  consentOnNotify(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.consentOnNotify, "gateway.hip.consent_on_notify", body, { patientId });
  }

  hiOnRequest(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.hiOnRequest, "gateway.hip.hi_on_request", body, { patientId });
  }

  hiNotify(body: unknown, patientId: string | null): Promise<AbdmCallResult> {
    return this.post(HIP_PATHS.hiNotify, "gateway.hip.hi_notify", body, { patientId });
  }

  /**
   * ONE PAGE of a data push, straight to the HIU's `dataPushUrl` (row 9 of the table). `summary` is
   * what the log keeps in place of the body — the caller builds it without the ciphertext. Returns
   * the HIU's status; throws only when there was no answer at all.
   */
  async push(dataPushUrl: string, body: unknown, summary: unknown, patientId: string | null): Promise<number> {
    const requestId = randomUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "REQUEST-ID": requestId,
      TIMESTAMP: this.deps.now().toISOString(),
      "X-CM-ID": this.settings.cmId,
      "X-HIP-ID": this.settings.hipId,
    };
    const logId = await insertOutbound(this.deps.db, {
      kind: "hiu.data_push", path: dataPushUrl, requestId, headers: loggableHeaders(headers), body: summary, patientId,
    });
    let res: Response;
    try {
      res = await this.deps.fetch(dataPushUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await completeOutbound(this.deps.db, logId, { error: message.slice(0, 2000) });
      throw new Error(`data push to the HIU failed: ${message}`);
    }
    const text = await res.text().catch(() => "");
    await completeOutbound(this.deps.db, logId, { httpStatus: res.status, responseBody: text === "" ? null : { text: text.slice(0, 2000) } });
    return res.status;
  }
}

/** ABDM's `response.requestId` — every `on-*` we send names the inbound REQUEST-ID it answers. */
export const answering = (requestId: string): { response: { requestId: string } } => ({ response: { requestId } });

export const ok2xx = (r: { status: number }): boolean => r.status >= 200 && r.status < 300;
