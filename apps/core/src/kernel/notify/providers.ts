import { maskPhone } from "./mask";
import type { ChannelAdapter } from "./adapters";
import type { AppConfig } from "../config";

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
  constructor(readonly code: "dlt_template_unregistered" | "whatsapp_template_unapproved" | "not_an_indian_mobile", message: string) {
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

export function dltSmsAdapter(cfg: NonNullable<AppConfig["notifySms"]>, fetchImpl: FetchLike): ChannelAdapter {
  return {
    channel: "sms",
    async send(to, text, meta) {
      const dlt = meta.registration?.dltTemplateId?.trim() ?? "";
      if (dlt === "") {
        throw new ProviderRefusedError(
          "dlt_template_unregistered",
          `SMS refused: template "${meta.templateKey ?? "unknown"}" has no DLT template id recorded — the operator's DLT scrubbing would drop it. Record the id the DLT portal issued (office → Messages).`,
        );
      }
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
