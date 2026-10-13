import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../../kernel/config";
import { adaptersFor } from "../../kernel/notify/adapters";
import { maskPhone, maskPhonesIn } from "../../kernel/notify/mask";
import type { AppConfig } from "../../kernel/config";
import type { ChannelAdapter } from "../../kernel/notify/adapters";

/**
 * E3.3 (#731) — THE FAMILY LINK'S OTP, ON THE HOSPITAL'S OWN SMS CHANNEL (the ABDM linking OTP's shape,
 * `modules/abdm/sms-otp-sender.ts`).
 *
 * TRANSACTIONAL: the attendant asked for it seconds ago by pressing "Send OTP", so it goes straight to the SMS adapter,
 * not through the notify pump (whose consent rules govern the messages the hospital starts). The OTP is never logged
 * except by the explicit non-production opt-in below, and a gateway error is scrubbed of the OTP and the number.
 *
 * HELD UNTIL RELEASED (DECIDED, like the daily totals): TRAI DLT needs a registered content template for the OTP SMS
 * (`IPD_FAMILY_OTP_DLT_TEMPLATE_ID`). With none the send is REFUSED — never attempted, never faked — and the page says
 * "OTP cannot be sent now, ask the ward desk". With SMS on the console sink, production refuses; staging and
 * development may set `IPD_FAMILY_OTP_TO_LOG=true` to read the OTP in the server log for a walk-through.
 */
export interface FamilyOtpSender {
  readonly name: string;
  /** Throws `FamilyOtpUnavailable` when it cannot send. */
  send(to: string, otp: string): Promise<void>;
}

export class FamilyOtpUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyOtpUnavailable";
  }
}

export const IPD_FAMILY_OTP_TEMPLATE_KEY = "ipd_family_otp";

/** The text to register on the DLT portal, the OTP its one `{#var#}`. */
export function familyOtpText(otp: string): string {
  return `${otp} is your OTP to see your patient's updates from the hospital. Valid for 10 minutes. Do not share it.`;
}

export function familyOtpEnv(env: NodeJS.ProcessEnv = process.env): { dltTemplateId: string | null; toLog: boolean; production: boolean } {
  if (env === process.env) loadEnv();
  const dlt = env.IPD_FAMILY_OTP_DLT_TEMPLATE_ID?.trim() ?? "";
  return { dltTemplateId: dlt === "" ? null : dlt, toLog: env.IPD_FAMILY_OTP_TO_LOG === "true", production: env.NODE_ENV === "production" };
}

export class SmsFamilyOtpSender implements FamilyOtpSender {
  readonly name = "sms";
  constructor(private readonly sms: ChannelAdapter, private readonly dltTemplateId: string | null) {}

  async send(to: string, otp: string): Promise<void> {
    if (this.dltTemplateId === null) {
      throw new FamilyOtpUnavailable("the family OTP SMS has no DLT template id (IPD_FAMILY_OTP_DLT_TEMPLATE_ID); nothing was sent");
    }
    try {
      await this.sms.send(to, familyOtpText(otp), {
        notificationId: `ipd-family-otp:${randomUUID()}`,
        templateKey: IPD_FAMILY_OTP_TEMPLATE_KEY,
        language: "en",
        variables: [otp],
        registration: { dltTemplateId: this.dltTemplateId, whatsappTemplateName: null },
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      throw new FamilyOtpUnavailable(`the family OTP SMS to ${maskPhone(to)} failed: ${maskPhonesIn(raw.split(otp).join("******"))}`);
    }
  }
}

/** No real SMS gateway: refuses in production; logs the OTP only on the explicit non-production opt-in. */
export class LoggingFamilyOtpSender implements FamilyOtpSender {
  readonly name = "logging (no SMS provider configured)";
  private readonly log = new Logger("ipd.family-otp");
  constructor(private readonly production: boolean, private readonly toLog: boolean) {}

  async send(to: string, otp: string): Promise<void> {
    if (this.production || !this.toLog) {
      throw new FamilyOtpUnavailable("no SMS sender is configured for the family OTP; nothing was sent");
    }
    this.log.warn(`NOT PRODUCTION — no SMS sender: family OTP for the phone ending ${to.slice(-4)} is ${otp}`);
    await Promise.resolve();
  }
}

/** The runtime's sender: SMS on a real gateway, else the logging sender. */
export function familyOtpSender(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): FamilyOtpSender {
  const e = familyOtpEnv(env);
  const sms = adaptersFor(cfg).sms;
  if (sms.sink === true) return new LoggingFamilyOtpSender(e.production, e.toLog);
  return new SmsFamilyOtpSender(sms, e.dltTemplateId);
}
