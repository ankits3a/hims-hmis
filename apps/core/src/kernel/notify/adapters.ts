import webpush from "web-push";
import { maskPhone } from "./mask";
import { dltSmsAdapter, whatsappCloudAdapter } from "./providers";
import type { FetchLike } from "./providers";
import type { AppConfig } from "../config";

/**
 * D11 verbatim. `send` returning a `providerMessageId` is the ONLY thing the pump learns about
 * an attempt — with the console sink below, that value is always `null`: "the selected adapter
 * accepted the message" is a statement about THIS GATEWAY, not about delivery.
 * `notification.sent` is defined on exactly that basis (D11); `notification.delivered` has no
 * producer in this plan and arrives with the provider integration.
 */
/**
 * ═══ PHASE O T4 — THE UNION IS NAMED ONCE AND THE OTHER THREE PLACES IMPORT IT ═══
 *
 * `"whatsapp" | "sms"` was written out four times: here, in `templates.ts`'s `channels?`, in
 * `events.ts`'s `notification.sent` enum, and as a comment on `notifications.sent_channel`.
 * Widening it by hand in four places is the shape ledger §2.54 is about, so T4 widens it ONCE
 * and makes the other three read this constant. The comment on `sent_channel` stays a comment,
 * because a SQL column cannot import a TypeScript union — it is updated in the same commit.
 */
export { maskPhone };

export const NOTIFY_CHANNELS = ["whatsapp", "sms", "web_push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * What the pump tells an adapter besides the address and the text. `notificationId` is the original
 * contract; the rest arrived with PHARMACY P6 (patient messages) and is OPTIONAL, so every adapter and
 * fake written before it still satisfies the type. A real provider needs them: the DLT gateway must
 * name the registered template, WhatsApp fills an approved template by name, language and variables.
 */
export type SendMeta = {
  notificationId: string;
  templateKey?: string;
  language?: "hi" | "en";
  /** The template's variables in order (`NotificationTemplate.variables`), or absent. */
  variables?: string[];
  /** The provider's ids for this template (`notify_template_registrations`), or nulls. */
  registration?: { dltTemplateId: string | null; whatsappTemplateName: string | null };
};

export type ChannelAdapter = {
  channel: NotifyChannel;
  /**
   * PHARMACY P6 — TRUE ON A CONSOLE SINK: it "accepts" a message and nothing leaves the building. The
   * pump reads it to keep a patient off a sink rung when a real gateway serves another rung of the same
   * ladder (a live SMS gateway beside a WhatsApp still on the console would otherwise "send" every
   * message to the log and mark it sent). Absent = a real adapter, which every test fake is.
   */
  sink?: boolean;
  send(
    to: string,
    text: string,
    meta: SendMeta,
  ): Promise<{
    providerMessageId: string | null;
    /**
     * PHASE O T4, ADDITIVE and absent on every other channel: addresses the provider says are
     * permanently gone (a `410`). Push is the only channel whose address the RECIPIENT can
     * destroy, and a retry against a destroyed one fails identically for ever. The pump revokes
     * them; it does not climb the ladder over them.
     */
    goneAddresses?: string[];
  }>;
};

const LOG_BODY_CHARS = 80;

/** A push `to` is a list of per-browser capability URLs: the log says how many, never which. */
function pushSummary(to: string): string {
  try {
    const n = decodePushAddresses(to).length;
    return `[${String(n)} push subscription${n === 1 ? "" : "s"}]`;
  } catch {
    return "[unreadable push address]";
  }
}

/** One structured line per send — channel, the MASKED recipient, the notification id, a truncated body. */
function logConsoleSend(channel: ChannelAdapter["channel"], to: string, text: string, notificationId: string): void {
  console.log(
    JSON.stringify({
      channel,
      to: channel === "web_push" ? pushSummary(to) : maskPhone(to),
      notificationId,
      text: text.slice(0, LOG_BODY_CHARS),
    }),
  );
}

export const consoleWhatsappAdapter: ChannelAdapter = {
  channel: "whatsapp",
  sink: true,
  async send(to, text, meta) {
    logConsoleSend("whatsapp", to, text, meta.notificationId);
    return { providerMessageId: null };
  },
};

export const consoleSmsAdapter: ChannelAdapter = {
  channel: "sms",
  sink: true,
  async send(to, text, meta) {
    logConsoleSend("sms", to, text, meta.notificationId);
    return { providerMessageId: null };
  },
};

export const consoleWebPushAdapter: ChannelAdapter = {
  channel: "web_push",
  sink: true,
  async send(to, text, meta) {
    logConsoleSend("web_push", to, text, meta.notificationId);
    return { providerMessageId: null };
  },
};

/**
 * ═══ PHASE O T4 — WEB PUSH, THE ONE CHANNEL THAT NEEDS NO PURCHASE ═══
 *
 * RO-4 puts Chrome push first precisely because it is the only loud channel the hospital can
 * switch on today: no DLT header, no BSP template approval, no per-message cost. The other two
 * rungs stay on the console sink until those land (§8).
 *
 * ═══ `to` IS A SUBSCRIPTION, NOT A NUMBER ═══
 *
 * Every other channel addresses a person by one string that means the same thing everywhere. A
 * push endpoint is a per-BROWSER URL plus two keys, so the pump packs the triple into `to` as
 * JSON and this adapter unpacks it. That keeps `ChannelAdapter` one shape across three channels
 * rather than making the pump branch on which kind of address it is holding.
 *
 * ═══ A 410 IS NOT A FAILURE, IT IS A FACT ═══
 *
 * `410 Gone` (and `404`) mean the browser threw the subscription away — the person cleared site
 * data, or reinstalled. Retrying it is pointless for ever. The adapter reports it as a distinct
 * error the pump's caller recognises, so the row is REVOKED rather than climbed against.
 */
export class PushSubscriptionGoneError extends Error {
  constructor(readonly endpoint: string) {
    super(`push subscription gone: ${endpoint}`);
    this.name = "PushSubscriptionGoneError";
  }
}

export type PushAddress = { endpoint: string; p256dh: string; auth: string };

/**
 * The pump packs a person's LIVE SUBSCRIPTIONS into `to`; this is the only place either side
 * knows the shape. A list rather than one address because a person is a set of browsers.
 */
export function encodePushAddresses(subs: readonly PushAddress[]): string {
  return JSON.stringify(subs);
}

function isPushAddress(v: unknown): v is PushAddress {
  return typeof v === "object" && v !== null
    && typeof (v as PushAddress).endpoint === "string"
    && typeof (v as PushAddress).p256dh === "string"
    && typeof (v as PushAddress).auth === "string";
}

export function decodePushAddresses(to: string): PushAddress[] {
  const parsed: unknown = JSON.parse(to);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isPushAddress)) {
    throw new Error("decodePushAddresses: `to` is not a non-empty list of encoded push subscriptions");
  }
  return parsed;
}

const PUSH_GONE_STATUS = new Set([404, 410]);

export function webPushAdapter(vapid: { publicKey: string; privateKey: string; subject: string }): ChannelAdapter {
  return {
    channel: "web_push",
    async send(to, text) {
      const subs = decodePushAddresses(to);
      const gone: string[] = [];
      let delivered = 0;
      let lastError: unknown = null;
      let providerMessageId: string | null = null;

      for (const sub of subs) {
        try {
          const res = await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            // The service worker reads `title` and `link` and renders nothing else. GC6 and
            // R10: what crosses this wire is a kind, a lane, minutes and a link — never a
            // patient, never a staff health fact, never a rupee amount.
            text,
            { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
          );
          delivered += 1;
          providerMessageId ??= res.headers?.location ?? null;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== undefined && PUSH_GONE_STATUS.has(status)) {
            gone.push(sub.endpoint);
            continue;
          }
          lastError = err;
        }
      }

      /**
       * ONE DELIVERY IS A DELIVERY. A doctor whose desktop subscription is dead and whose phone
       * rang has been reached, and climbing to WhatsApp over that would be the second message
       * about one thing that R9's budget exists to prevent. Only when NOTHING landed does this
       * become a failure the ladder may climb — and if everything that failed was `gone`, the
       * failure is "this person has no working browser", not "the push service is down".
       */
      if (delivered === 0) {
        if (lastError !== null) throw lastError;
        throw new PushSubscriptionGoneError(gone.join(", "));
      }
      return { providerMessageId, goneAddresses: gone };
    },
  };
}

/**
 * Channel → adapter map for the configured providers. Both switches are EXHAUSTIVE on purpose
 * (D11): widening either enum without adding a case fails compilation at the `never` assignment
 * rather than shipping an unmapped provider behind a silently-returned default.
 *
 * TWO PROVIDER KNOBS, NOT ONE. `NOTIFY_PROVIDER` gates WhatsApp and SMS, which are bought
 * together and arrive together; `NOTIFY_PUSH_PROVIDER` gates push, which needs nothing bought
 * and can be live while the other two are still on the console sink. One knob would have forced
 * the hospital to wait for the purchases before turning on the channel RO-4 asked for first.
 */
export function adaptersFor(
  cfg: Pick<AppConfig, "notifyProvider" | "notifyPushProvider" | "webPushVapid">
    & Partial<Pick<AppConfig, "notifySms" | "notifyWhatsapp">>,
  /** Tests hand a recording fake; production uses the platform's `fetch`. */
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Record<ChannelAdapter["channel"], ChannelAdapter> {
  let push: ChannelAdapter;
  switch (cfg.notifyPushProvider) {
    case "console":
      push = consoleWebPushAdapter;
      break;
    case "webpush": {
      const vapid = cfg.webPushVapid;
      if (vapid === null) {
        // Unreachable through `loadConfig`, which refuses this combination at boot. Kept
        // because `adaptersFor` takes a structural Pick and a test can hand it anything.
        throw new Error("adaptersFor: NOTIFY_PUSH_PROVIDER=webpush needs the three VAPID keys");
      }
      push = webPushAdapter(vapid);
      break;
    }
    default: {
      const exhaustive: never = cfg.notifyPushProvider;
      throw new Error(`adaptersFor: unmapped NOTIFY_PUSH_PROVIDER ${String(exhaustive)}`);
    }
  }

  switch (cfg.notifyProvider) {
    case "console":
      return { whatsapp: consoleWhatsappAdapter, sms: consoleSmsAdapter, web_push: push };
    /**
     * PHARMACY P6 (patient messages) — each channel on its own gateway WHEN ITS KEYS ARE SET, else on
     * the sink. `loadConfig` has already refused a half-configured channel, so a null here means "not
     * contracted" and nothing else.
     */
    case "live": {
      const sms = cfg.notifySms ?? null;
      const wa = cfg.notifyWhatsapp ?? null;
      return {
        whatsapp: wa === null ? consoleWhatsappAdapter : whatsappCloudAdapter(wa, fetchImpl),
        sms: sms === null ? consoleSmsAdapter : dltSmsAdapter(sms, fetchImpl),
        web_push: push,
      };
    }
    default: {
      const exhaustive: never = cfg.notifyProvider;
      throw new Error(`adaptersFor: unmapped NOTIFY_PROVIDER ${String(exhaustive)}`);
    }
  }
}
