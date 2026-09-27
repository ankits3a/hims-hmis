import { MSG91_FLOW_URL } from "../config";
import { maskPhone, maskPhonesIn } from "./mask";
import type { ChannelAdapter } from "./adapters";
import type { AppConfig, Msg91Config, SmsGatewayConfig } from "../config";

export { MSG91_FLOW_URL };

/**
 * ═══ PHARMACY P6 (patient messages) — THE TWO REAL GATEWAYS, OFF UNTIL THE OWNER CONTRACTS ONE ═══
 *
 * Provider choice is PROCUREMENT and the owner's. What is built here is the one adapter per channel
 * the Indian market leaves room for, behind `NOTIFY_PROVIDER=live` and that channel's keys
 * (`kernel/config.ts`); with neither, `adaptersFor` hands the pump the console sinks and nothing leaves
 * the building. No test reaches a network: every call goes through `fetchImpl`, which tests replace.
 *
 *   SMS       a DLT-registered Indian aggregator. TRAI's TCCCPR 2018 has every operator scrub a
 *             commercial SMS against the DLT portal: the hospital's entity (PE) id, a registered
 *             sender header, and the CONTENT TEMPLATE id whose text this message matches with its
 *             `{#var#}` slots filled. So the adapter REFUSES a template with no DLT id recorded — the
 *             operator would drop it anyway, and silently.
 *   WhatsApp  the WhatsApp Business Cloud API. A business-initiated message is a Meta-APPROVED template,
 *             sent by name, language and body parameters in order; free text is only allowed inside a
 *             24-hour window the patient opened, which a hospital's outbound message never is. So it
 *             REFUSES a template with no approved name recorded.
 *
 * The request shape for SMS is the adapter's own contract (JSON: to, sender, entity_id, template_id,
 * body, unicode) — Indian aggregators name those five fields differently, and mapping the contracted
 * one's names is a change to this one function on the day the contract is signed.
 *
 * A refusal is a `ProviderRefusedError`: not transient, so the pump moves the message to its next rung
 * at once instead of asking the same question three times.
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ProviderRefusedError extends Error {
  constructor(
    readonly code: "dlt_template_unregistered" | "msg91_template_unmapped" | "whatsapp_template_unapproved" | "not_an_indian_mobile",
    message: string,
  ) {
    super(message);
    this.name = "ProviderRefusedError";
  }
}

/** A 10-digit Indian mobile (6–9 first) → `91XXXXXXXXXX`; `+91`/`0` prefixes tolerated. Anything else is refused. */
export function toIndianMsisdn(to: string): string {
  let d = to.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) {
    throw new ProviderRefusedError("not_an_indian_mobile", `not an Indian mobile number (${maskPhone(to)}) — correct it on the patient's record`);
  }
  return `91${d}`;
}

/** The first string id a gateway's JSON answer carries, or null. */
function messageIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  for (const k of ["message_id", "messageId", "id", "request_id"]) {
    if (typeof b[k] === "string" && b[k] !== "") return b[k];
  }
  const data = b.data;
  if (Array.isArray(data) && typeof data[0] === "object" && data[0] !== null) return messageIdOf(data[0]);
  if (typeof data === "object" && data !== null) return messageIdOf(data);
  const messages = b.messages;
  if (Array.isArray(messages) && typeof messages[0] === "object" && messages[0] !== null) return messageIdOf(messages[0]);
  return null;
}

/** The DLT content-template id this message is registered under, or a `dlt_template_unregistered` refusal. */
function dltIdOrRefuse(meta: Parameters<ChannelAdapter["send"]>[2]): string {
  const dlt = meta.registration?.dltTemplateId?.trim() ?? "";
  if (dlt === "") {
    throw new ProviderRefusedError(
      "dlt_template_unregistered",
      `SMS refused: template "${meta.templateKey ?? "unknown"}" has no DLT template id recorded — the operator's DLT scrubbing would drop it. Record the id the DLT portal issued (office → Messages).`,
    );
  }
  return dlt;
}

export function dltSmsAdapter(cfg: Omit<SmsGatewayConfig, "provider">, fetchImpl: FetchLike): ChannelAdapter {
  return {
    channel: "sms",
    async send(to, text, meta) {
      const dlt = dltIdOrRefuse(meta);
      const res = await fetchImpl(cfg.gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          to: toIndianMsisdn(to), sender: cfg.senderId, entity_id: cfg.entityId, template_id: dlt,
          body: text, unicode: /[^\u0000-\u007f]/.test(text),
        }),
      });
      if (!res.ok) throw new Error(`SMS gateway answered HTTP ${String(res.status)} for ${maskPhone(to)}`);
      return { providerMessageId: messageIdOf(await res.json().catch(() => null)) };
    },
  };
}

/**
 * ═══ ABDM × MSG91 — MSG91's FLOW API v5 (owner ruling 2026-09-26: "MSG91 SMS Sender") ═══
 *
 *   POST https://control.msg91.com/api/v5/flow
 *   headers  authkey: <MSG91_AUTH_KEY>, content-type: application/json
 *   body     { template_id, sender?, short_url: "0", recipients: [{ mobiles: "91XXXXXXXXXX", VAR1, VAR2, … }] }
 *   answer   { type: "success", message: "<request id>" } | { type: "error", message: "<reason>" }
 *
 * Confirmed against MSG91's published docs (api.msg91.com/apidoc/textsms/send-sms-flow.php and the
 * MSG91 help centre): the endpoint, the `authkey` header, `template_id` (successor of `flow_id`),
 * `recipients[].mobiles` in international format, `short_url` "1"/"0", and the success/error answer.
 * UNVERIFIED until the first sandbox send with the owner's key:
 *   · the VARIABLE NAMES. MSG91 fills a template's `##name##` slots from same-named recipient keys; this
 *     adapter sends the template's variables IN ORDER as `VAR1..VARn`, so each MSG91 template must be
 *     written with `##VAR1##`, `##VAR2##`, … in the DLT template's `{#var#}` positions;
 *   · whether `sender` is still read by control.msg91.com (the template carries its own sender header);
 *     it is sent when `SMS_DLT_SENDER_ID` is set and omitted otherwise;
 *   · whether a 2xx answer can carry `type: "error"` — handled as a failure either way.
 *
 * MSG91 does not send our rendered text: it sends ITS template, which is where the DLT template id and
 * the entity id live. So the DLT refusal is kept (no DLT id ⇒ `dlt_template_unregistered`), and a DLT
 * id with no MSG91 template mapped to it (`MSG91_TEMPLATE_IDS`) is refused `msg91_template_unmapped` —
 * both before any request. Every error names the number by its last four digits only, and provider
 * prose is masked and stripped of the auth key before it reaches `last_error` or a log.
 */
export function msg91SmsAdapter(cfg: Omit<Msg91Config, "provider">, fetchImpl: FetchLike): ChannelAdapter {
  const clean = (v: unknown): string => {
    const raw = typeof v === "string" ? v : "";
    return maskPhonesIn(cfg.authKey === "" ? raw : raw.split(cfg.authKey).join("[redacted]")).slice(0, 200);
  };
  return {
    channel: "sms",
    async send(to, _text, meta) {
      const dlt = dltIdOrRefuse(meta);
      const templateId = Object.hasOwn(cfg.templateIds, dlt) ? cfg.templateIds[dlt] : undefined;
      if (templateId === undefined) {
        throw new ProviderRefusedError(
          "msg91_template_unmapped",
          `SMS refused: DLT template ${dlt} ("${meta.templateKey ?? "unknown"}") has no MSG91 template — create it in MSG91 with this DLT id and add ${dlt}:<MSG91 template id> to MSG91_TEMPLATE_IDS.`,
        );
      }
      const recipient: Record<string, string> = { mobiles: toIndianMsisdn(to) };
      (meta.variables ?? []).forEach((v, i) => { recipient[`VAR${String(i + 1)}`] = v; });
      const res = await fetchImpl(cfg.flowUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authkey: cfg.authKey },
        body: JSON.stringify({
          template_id: templateId,
          ...(cfg.senderId === null ? {} : { sender: cfg.senderId }),
          short_url: "0",
          recipients: [recipient],
        }),
      });
      const answer: unknown = await res.json().catch(() => null);
      const b = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
      if (!res.ok) {
        const why = clean(b.message);
        throw new Error(`MSG91 answered HTTP ${String(res.status)} for ${maskPhone(to)}${why === "" ? "" : `: ${why}`}`);
      }
      if (b.type !== "success") {
        throw new Error(`MSG91 did not accept the SMS for ${maskPhone(to)}: ${clean(b.message) || "no reason given"}`);
      }
      return { providerMessageId: typeof b.message === "string" && b.message !== "" ? b.message : messageIdOf(answer) };
    },
  };
}

export function whatsappCloudAdapter(cfg: NonNullable<AppConfig["notifyWhatsapp"]>, fetchImpl: FetchLike): ChannelAdapter {
  return {
    channel: "whatsapp",
    async send(to, _text, meta) {
      const name = meta.registration?.whatsappTemplateName?.trim() ?? "";
      if (name === "") {
        throw new ProviderRefusedError(
          "whatsapp_template_unapproved",
          `WhatsApp refused: template "${meta.templateKey ?? "unknown"}" has no approved WhatsApp template name recorded — a business-initiated message must be one Meta approved. Record it (office → Messages).`,
        );
      }
      const variables = meta.variables ?? [];
      const res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, "")}/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.accessToken}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: toIndianMsisdn(to),
          type: "template",
          template: {
            name,
            language: { code: meta.language === "hi" ? "hi" : "en" },
            components: variables.length === 0 ? [] : [{ type: "body", parameters: variables.map((v) => ({ type: "text", text: v })) }],
          },
        }),
      });
      if (!res.ok) throw new Error(`WhatsApp Cloud API answered HTTP ${String(res.status)} for ${maskPhone(to)}`);
      return { providerMessageId: messageIdOf(await res.json().catch(() => null)) };
    },
  };
}
