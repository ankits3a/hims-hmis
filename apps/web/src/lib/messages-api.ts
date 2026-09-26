import { api } from "./api";

/**
 * PHARMACY P6 (patient messages) — the desk's consent chip and the hand-over's bill status, and the
 * office's Messages side (`apps/core/src/modules/pharmacy/pharmacy-messages.controller.ts`). Field for
 * field what the server returns.
 */
export type WireBillMessageState =
  | "not_yet" | "no_phone" | "stopped" | "zero_bill" | "pending"
  | "queued" | "held_quiet_hours" | "sending" | "sent" | "logged_only" | "suppressed" | "expired" | "failed";

export type WirePatientMessages = {
  hasPhone: boolean;
  phoneLast4: string | null;
  language: "hi" | "en";
  channel: "sms" | "whatsapp" | null;
  refillReminders: boolean;
  remindersConsent: { at: string; byName: string | null; via: string } | null;
  stopped: { at: string; byName: string | null; via: string } | null;
  bill: { state: WireBillMessageState; channel: string | null; at: string | null };
};

export type MessageChange =
  | { change: "reminders_on" } | { change: "reminders_off" } | { change: "stop" } | { change: "resume" }
  | { change: "channel"; channel: "sms" | "whatsapp" } | { change: "language"; language: "hi" | "en" };

export async function fetchPatientMessages(dispenseId: string): Promise<WirePatientMessages> {
  return api<WirePatientMessages>("GET", `/pharmacy/dispenses/${dispenseId}/messages`);
}

export async function recordPatientMessages(dispenseId: string, change: MessageChange): Promise<WirePatientMessages> {
  return api<WirePatientMessages>("POST", `/pharmacy/dispenses/${dispenseId}/messages`, change);
}

export type WireMessagesOffice = {
  provider: { sms: boolean; whatsapp: boolean };
  contactPhone: string | null;
  templates: {
    key: "pharmacy_bill_ready" | "pharmacy_refill_due"; purpose: "bill" | "refill";
    dltTemplateId: string | null; whatsappTemplateName: string | null; variables: number;
    text: { en: string; hi: string };
  }[];
  counts: { sent: number; loggedOnly: number; queued: number; failed: number; suppressed: number; expired: number };
  patients: { remindersOn: number; stopped: number };
  needs: ("provider" | "dlt_ids" | "whatsapp_names" | "contact_phone")[];
};

export async function fetchMessagesOffice(): Promise<WireMessagesOffice> {
  return api<WireMessagesOffice>("GET", "/pharmacy/office/messages");
}

export async function recordTemplateIds(input: { templateKey: string; dltTemplateId: string | null; whatsappTemplateName: string | null }): Promise<WireMessagesOffice> {
  return api<WireMessagesOffice>("POST", "/pharmacy/office/messages/templates", input);
}

export async function recordMessagesContact(phone: string): Promise<WireMessagesOffice> {
  return api<WireMessagesOffice>("POST", "/pharmacy/office/messages/contact", { phone });
}
