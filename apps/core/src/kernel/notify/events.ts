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
    channel: z.enum(["whatsapp", "sms"]),
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
    reason: z.enum(["ladder_exhausted", "no_phone", "render_error", "stuck_sending"]),
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
    reason: z.enum(["deceased", "promotional_blocked", "merge_unresolvable"]),
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
