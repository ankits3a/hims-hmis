import { randomUUID } from "node:crypto";
import { adaptersFor } from "../../kernel/notify/adapters";
import { maskPhone, maskPhonesIn } from "../../kernel/notify/mask";
import { LINK_OTP_TTL_MS, LoggingOtpSender, OtpSenderUnavailable } from "./patient-linking";
import type { OtpSender } from "./patient-linking";
import type { ChannelAdapter } from "../../kernel/notify/adapters";
import type { FetchLike } from "../../kernel/notify/providers";
import type { AppConfig } from "../../kernel/config";

/**
 * ═══ ABDM S2 × MSG91 — THE LINKING OTP ON THE HOSPITAL'S OWN SMS CHANNEL ═══
 *
 * Owner ruling 2026-09-26: "MSG91 SMS Sender". When the kernel's SMS channel is on a real gateway
 * (`NOTIFY_PROVIDER=live` and a provider's keys — MSG91's `MSG91_AUTH_KEY`), the patient-initiated
 * linking OTP goes out on THAT adapter: the same code, the same DLT refusal, the same masking as every
 * patient SMS. With SMS still on the console sink the runtime keeps `LoggingOtpSender` — a sink would
 * "send" the OTP into the server log, which is exactly what that sender refuses to do by default.
 *
 * DECIDED 2026-09-27 — THE PATIENT'S "STOP ALL MESSAGES" DOES NOT BLOCK THIS OTP. It is TRANSACTIONAL
 * and the patient asked for it, seconds ago, by starting the link in their PHR app; refusing it would
 * make "stop" mean "you can no longer link your own records". So it is sent straight to the SMS adapter
 * and not through the notify pump, whose consent rules (preferences.ts) govern the messages the
 * HOSPITAL starts — those are not bypassed by anything here.
 *
 * The OTP is never logged: this class writes no log line, and a gateway error that echoes the OTP or
 * the full number is scrubbed before it becomes the link request's stored `error` or ABDM's on-init.
 *
 * TRAI: an OTP SMS is a DLT content template like any other, so it has its own id
 * (`ABDM_LINK_OTP_DLT_TEMPLATE_ID`). With none, the send is REFUSED — never attempted, never faked.
 */
export const ABDM_LINK_OTP_TEMPLATE_KEY = "abdm_link_otp";

/**
 * The text to register on the DLT portal, with the OTP as its one `{#var#}`. The flow providers
 * (MSG91) send their own copy of this template with `VAR1` = the OTP; a generic DLT gateway sends
 * this string, which must match the registered template exactly.
 */
export function linkingOtpText(otp: string): string {
  const minutes = Math.round(LINK_OTP_TTL_MS / 60_000);
  return `${otp} is your OTP to link your records at this hospital to your ABHA. It is valid for ${String(minutes)} minutes. Do not share it with anyone.`;
}

export class SmsOtpSender implements OtpSender {
  readonly name = "sms";

  constructor(private readonly sms: ChannelAdapter, private readonly dltTemplateId: string | null) {}

  async send(to: { mobile: string; patientId: string }, otp: string, purpose: string): Promise<void> {
    const dlt = this.dltTemplateId?.trim() ?? "";
    if (dlt === "") {
      throw new OtpSenderUnavailable(
        "the linking-OTP SMS has no DLT template id — set ABDM_LINK_OTP_DLT_TEMPLATE_ID to the id the DLT portal issued for it; the OTP was not sent",
      );
    }
    try {
      // No preference check, on purpose — DECIDED 2026-09-27 above.
      await this.sms.send(to.mobile, linkingOtpText(otp), {
        notificationId: `abdm-link-otp:${randomUUID()}`,
        templateKey: ABDM_LINK_OTP_TEMPLATE_KEY,
        language: "en",
        variables: [otp],
        registration: { dltTemplateId: dlt, whatsappTemplateName: null },
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      throw new OtpSenderUnavailable(`the ${purpose} OTP SMS to ${maskPhone(to.mobile)} failed: ${maskPhonesIn(raw.split(otp).join("******"))}`);
    }
  }
}

/**
 * The runtime's sender: SMS when the kernel's SMS channel is on a real gateway, else the logging
 * sender with its production refusal and its sandbox opt-in unchanged. `fetchImpl` is for tests; the
 * default is the platform's `fetch`, exactly as the notify worker's.
 */
export function linkingOtpSender(
  cfg: AppConfig,
  s: { cmId: "sbx" | "abdm"; sandboxOtpToLog: boolean },
  fetchImpl?: FetchLike,
): OtpSender {
  const sms = adaptersFor(cfg, fetchImpl).sms;
  if (sms.sink === true) return new LoggingOtpSender(s.cmId, s.sandboxOtpToLog);
  return new SmsOtpSender(sms, cfg.abdm.linkOtpDltTemplateId);
}
