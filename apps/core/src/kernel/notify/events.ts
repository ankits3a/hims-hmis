import { NOTIFY_CHANNELS } from "./adapters";
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// The gateway's complete event surface (Plan 10, D12): FOUR catalog names, module "notify",
// `entity.verb_past` (defineEvent throws otherwise). The envelope's own `patientId` column
// carries patient linkage where it exists (§10.5) — payloads never duplicate it.
//
// `notification.delivered` is DELIBERATELY NOT defined here (D11/D12, self-review §7.3): with
// only the console adapter shipped, it would have zero possible producers — an event with zero
// producers is a vacuous assertion waiting to happen (§2.49). It arrives with the real provider
// integration alongside the delivery-callback route.
const MODULE = "notify";

const audienceSchema = z.enum(["patient", "staff", "owner"]);

export const notificationSent = defineEvent(
  "notification.sent",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    templateVersion: z.number().int(),
    audience: audienceSchema,
    channel: z.enum(NOTIFY_CHANNELS),
    providerMessageId: z.string().nullable(), // console adapter always returns null (D11)
  }),
);

export const notificationFailed = defineEvent(
  "notification.failed",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    audience: audienceSchema,
    // PHASE O T4 — `no_push_subscription` is the push twin of `no_phone`, and it is a separate
    // word because the remedy is different: a missing phone is fixed at the desk, a missing
    // subscription is fixed by the person granting permission in their own browser.
    reason: z.enum([
      "ladder_exhausted", "no_phone", "no_push_subscription", "render_error", "stuck_sending",
    ]),
    refType: z.string().nullable(), // the outbox row's ref_type/ref_id — not every notification has one
    refId: z.string().nullable(),
  }),
);

export const notificationSuppressed = defineEvent(
  "notification.suppressed",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    audience: audienceSchema,
    // PHARMACY P6 (patient messages) — `opted_out`: the patient asked for no messages at all;
    // `no_consent`: the template needs an opt-in (`requiresOptIn`) the patient has not given, or took back
    // after the row was queued. Both are the patient's own word, read at send time (D4).
    reason: z.enum(["deceased", "promotional_blocked", "merge_unresolvable", "opted_out", "no_consent"]),
  }),
);

export const notificationExpired = defineEvent(
  "notification.expired",
  MODULE,
  z.object({
    notificationId: z.string().min(1),
    templateKey: z.string().min(1),
    audience: audienceSchema,
  }),
);

/**
 * PHARMACY P6 (patient messages) — the patient said something about being messaged, and a person at a
 * desk recorded it: the consent record (who = the actor, when = the envelope, how = `via`, what =
 * `change`), with the state it left behind. The envelope's `patientId` carries the patient (§10.5).
 */
export const messagePreferenceRecorded = defineEvent(
  "message_preference.recorded",
  MODULE,
  z.object({
    change: z.enum(["reminders_on", "reminders_off", "stopped", "resumed", "channel", "language"]),
    via: z.enum(["pharmacy_desk", "front_desk"]),
    refillReminders: z.boolean(),
    optedOut: z.boolean(),
    channel: z.enum(["sms", "whatsapp"]).nullable(),
    language: z.enum(["hi", "en"]).nullable(),
  }),
);

/**
 * PHARMACY P6 (patient messages) — the provider's ids for one template were recorded on a screen: the
 * DLT content-template id the portal issued, the name WhatsApp approved. Who (actor) and when
 * (envelope) are the audit; the ids are not secrets.
 */
export const templateRegistrationRecorded = defineEvent(
  "template_registration.recorded",
  MODULE,
  z.object({
    templateKey: z.string().min(1),
    dltTemplateId: z.string().min(1).nullable(),
    whatsappTemplateName: z.string().min(1).nullable(),
  }),
);
