import type { AppConfig } from "../config";

/**
 * D11 verbatim. `send` returning a `providerMessageId` is the ONLY thing the pump learns about
 * an attempt — with the console sink below, that value is always `null`: "the selected adapter
 * accepted the message" is a statement about THIS GATEWAY, not about delivery.
 * `notification.sent` is defined on exactly that basis (D11); `notification.delivered` has no
 * producer in this plan and arrives with the provider integration.
 */
export type ChannelAdapter = {
  channel: "whatsapp" | "sms";
  send(
    to: string,
    text: string,
    meta: { notificationId: string },
  ): Promise<{ providerMessageId: string | null }>;
};

const LOG_BODY_CHARS = 80;

/** One structured line per send — channel, recipient, the notification id, a truncated body. */
function logConsoleSend(channel: ChannelAdapter["channel"], to: string, text: string, notificationId: string): void {
  console.log(
    JSON.stringify({
      channel,
      to,
      notificationId,
      text: text.slice(0, LOG_BODY_CHARS),
    }),
  );
}

export const consoleWhatsappAdapter: ChannelAdapter = {
  channel: "whatsapp",
  async send(to, text, meta) {
    logConsoleSend("whatsapp", to, text, meta.notificationId);
    return { providerMessageId: null };
  },
};

export const consoleSmsAdapter: ChannelAdapter = {
  channel: "sms",
  async send(to, text, meta) {
    logConsoleSend("sms", to, text, meta.notificationId);
    return { providerMessageId: null };
  },
};

/**
 * Channel → adapter map for the configured `NOTIFY_PROVIDER`. The switch is EXHAUSTIVE on
 * purpose (D11): widening the `NOTIFY_PROVIDER` enum without adding a case here fails
 * compilation at the `never` assignment below, rather than shipping an unmapped provider behind
 * a silently-returned default.
 */
export function adaptersFor(
  cfg: Pick<AppConfig, "notifyProvider">,
): Record<ChannelAdapter["channel"], ChannelAdapter> {
  switch (cfg.notifyProvider) {
    case "console":
      return { whatsapp: consoleWhatsappAdapter, sms: consoleSmsAdapter };
    default: {
      const exhaustive: never = cfg.notifyProvider;
      throw new Error(`adaptersFor: unmapped NOTIFY_PROVIDER ${String(exhaustive)}`);
    }
  }
}
