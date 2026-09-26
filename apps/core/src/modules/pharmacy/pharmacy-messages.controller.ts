import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { pharmacyDispenses } from "../../kernel/db/schema";
import { MessagePreferenceError, recordMessagePreference } from "../../kernel/notify/preferences";
import { recordTemplateRegistration } from "../../kernel/notify/registrations";
import { PHARMACY_MESSAGE_TEMPLATES } from "./config";
import { PharmacyError } from "./errors";
import { messagesOffice, patientMessagesFor, providerStateOf, recordContactPhone } from "./messages";
import type { MessagesOffice, PatientMessagesView } from "./messages";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { MessagePreferenceChange } from "../../kernel/notify/preferences";

const changeBody = z.discriminatedUnion("change", [
  z.object({ change: z.literal("reminders_on") }),
  z.object({ change: z.literal("reminders_off") }),
  z.object({ change: z.literal("stop") }),
  z.object({ change: z.literal("resume") }),
  z.object({ change: z.literal("channel"), channel: z.enum(["sms", "whatsapp"]) }),
  z.object({ change: z.literal("language"), language: z.enum(["hi", "en"]) }),
]);

/** A DLT content-template id is the portal's long number; a WhatsApp template name is lower-case, digits and underscores. */
const templateBody = z.object({
  templateKey: z.enum(PHARMACY_MESSAGE_TEMPLATES),
  dltTemplateId: z.string().trim().regex(/^\d{10,30}$/, "the DLT content-template id is the number the DLT portal issued").nullable(),
  whatsappTemplateName: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "a WhatsApp template name is lower-case letters, digits and underscores").nullable(),
});
const contactBody = z.object({ phone: z.string().min(1).max(40) });

function toChange(b: z.infer<typeof changeBody>): MessagePreferenceChange {
  switch (b.change) {
    case "reminders_on": return { kind: "reminders", on: true };
    case "reminders_off": return { kind: "reminders", on: false };
    case "stop": return { kind: "stop" };
    case "resume": return { kind: "resume" };
    case "channel": return { kind: "channel", channel: b.channel };
    case "language": return { kind: "language", language: b.language };
  }
}

/**
 * ═══ PHARMACY P6 (patient messages) — THE DESK'S CONSENT CHIP AND THE OFFICE'S MESSAGES SIDE ═══
 *
 * The desk reads and records what the patient OF A TICKET IN HAND says about being messaged — the
 * dispense is the door, so the chip cannot be pointed at a patient nobody is serving. The office
 * records the provider's ids for the pharmacy's two templates and the pharmacy's phone, and reads what
 * was sent. The provider itself is configuration (`NOTIFY_PROVIDER`), shown here and never set here.
 */
@Controller("pharmacy")
export class PharmacyMessagesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id/messages")
  async messages(@Param("id") id: string): Promise<PatientMessagesView> {
    try {
      return await patientMessagesFor(this.db, parsed(idSchema, id), providerStateOf(this.cfg), new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /** One tap at the desk after asking the patient: reminders on or off, stop or resume messages, the channel, the language. */
  @RequirePermission("pharmacy.messages.consent", "hospital")
  @Post("dispenses/:id/messages")
  async record(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<PatientMessagesView> {
    const b = parsed(changeBody, body);
    const dispenseId = parsed(idSchema, id);
    try {
      const now = new Date();
      await withTx(this.db, async (tx) => {
        const d = (await tx.select({ patientId: pharmacyDispenses.patientId }).from(pharmacyDispenses).where(eq(pharmacyDispenses.id, dispenseId)))[0];
        if (d === undefined) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
        await recordMessagePreference(tx, actor, d.patientId, toChange(b), "pharmacy_desk", now);
      });
      return await patientMessagesFor(this.db, dispenseId, providerStateOf(this.cfg), now);
    } catch (e) {
      if (e instanceof MessagePreferenceError) {
        return toHttp(new PharmacyError(e.code === "messages_stopped" ? "messages_stopped" : "permission_denied", e.message));
      }
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.messages.manage", "hospital")
  @Get("office/messages")
  async office(): Promise<MessagesOffice> {
    return messagesOffice(this.db, providerStateOf(this.cfg), new Date());
  }

  /** The ids the DLT portal and Meta issued for one of the pharmacy's templates. `null` clears one. */
  @RequirePermission("pharmacy.messages.manage", "hospital")
  @Post("office/messages/templates")
  async templates(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<MessagesOffice> {
    const b = parsed(templateBody, body);
    try {
      const now = new Date();
      await withTx(this.db, (tx) => recordTemplateRegistration(tx, actor, b.templateKey, { dltTemplateId: b.dltTemplateId, whatsappTemplateName: b.whatsappTemplateName }, now));
      return await messagesOffice(this.db, providerStateOf(this.cfg), now);
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.messages.manage", "hospital")
  @Post("office/messages/contact")
  async contact(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<MessagesOffice> {
    const b = parsed(contactBody, body);
    try {
      if (actor.type !== "user") throw new PharmacyError("permission_denied", "the pharmacy's phone is recorded by a person");
      const now = new Date();
      await withTx(this.db, (tx) => recordContactPhone(tx, actor.id, b.phone, now));
      return await messagesOffice(this.db, providerStateOf(this.cfg), now);
    } catch (e) {
      return toHttp(e);
    }
  }
}
