import { eq } from "drizzle-orm";
import { patientMessagePreferences } from "../db/schema";
import { appendEvent } from "../events/append";
import { messagePreferenceRecorded } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";

/**
 * ═══ PHARMACY P6 (patient messages) — WHAT A PATIENT SAID ABOUT BEING MESSAGED ═══
 *
 * The only writer of `patient_message_preferences`, and the reader the pump and `enqueueNotification`
 * share. Kernel-owned because the pump must honour it for EVERY patient message, not only the
 * pharmacy's: "stop sending me messages" means the lab's notice as well as the bill.
 *
 * The consent rules, DECIDED (DPDP Act 2023 s.6; TRAI TCCCPR 2018):
 *   - a transactional message (the bill just paid, a report ready) goes to the number on record with no
 *     row at all, unless the patient has STOPPED messages;
 *   - a refill reminder needs an OPT-IN, one tap at a desk after asking, recorded with who, when and where;
 *   - STOP withdraws everything, the reminder opt-in included, and is as easy as the opt-in was (one tap);
 *   - after a STOP, a reminder opt-in is refused until the patient RESUMES messages: the two are separate
 *     words the patient says, and a desk that could skip the first would make a STOP un-auditable;
 *   - resuming does not bring the reminders back — that consent was withdrawn and must be given again.
 */
export type MessageChannelChoice = "sms" | "whatsapp";
export type MessageLanguage = "hi" | "en";
export type MessageConsentVia = "pharmacy_desk" | "front_desk";

export type MessagePreference = {
  patientId: string;
  channel: MessageChannelChoice | null;
  language: MessageLanguage | null;
  refillReminders: boolean;
  remindersConsent: { at: Date; by: string; via: MessageConsentVia } | null;
  optedOut: { at: Date; by: string; via: MessageConsentVia } | null;
  updatedAt: Date;
};

export type MessagePreferenceChange =
  | { kind: "reminders"; on: boolean }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "channel"; channel: MessageChannelChoice }
  | { kind: "language"; language: MessageLanguage };

export class MessagePreferenceError extends Error {
  constructor(readonly code: "messages_stopped" | "not_a_person", message: string) {
    super(message);
    this.name = "MessagePreferenceError";
  }
}

type Row = typeof patientMessagePreferences.$inferSelect;

function toPreference(r: Row): MessagePreference {
  return {
    patientId: r.patientId,
    channel: (r.channel as MessageChannelChoice | null) ?? null,
    language: (r.language as MessageLanguage | null) ?? null,
    refillReminders: r.refillReminders,
    remindersConsent: r.refillReminders && r.remindersConsentAt !== null && r.remindersConsentBy !== null
      ? { at: r.remindersConsentAt, by: r.remindersConsentBy, via: r.remindersConsentVia as MessageConsentVia }
      : null,
    optedOut: r.optedOutAt !== null && r.optedOutBy !== null
      ? { at: r.optedOutAt, by: r.optedOutBy, via: r.optedOutVia as MessageConsentVia }
      : null,
    updatedAt: r.updatedAt,
  };
}

/** The patient's recorded word, or null when nothing was ever said (transactional only, template ladder, registered language). */
export async function messagePreferenceOf(exec: Db | Tx, patientId: string): Promise<MessagePreference | null> {
  const rows = await exec.select().from(patientMessagePreferences).where(eq(patientMessagePreferences.patientId, patientId));
  return rows[0] === undefined ? null : toPreference(rows[0]);
}

/** Whether a template needing `purpose` may reach this patient now: opted in, and not stopped. */
export function consentsTo(pref: MessagePreference | null, purpose: "refill_reminders"): boolean {
  if (pref === null || pref.optedOut !== null) return false;
  return purpose === "refill_reminders" ? pref.refillReminders : false;
}

/**
 * Record one thing the patient said, in the caller's transaction, and append the consent event. The
 * row is locked first (`for update`), so two desks tapping at once serialise rather than one silently
 * overwriting the other's consent record. Returns the state it left.
 */
export async function recordMessagePreference(
  tx: Tx,
  actor: Actor,
  patientId: string,
  change: MessagePreferenceChange,
  via: MessageConsentVia,
  now: Date,
): Promise<MessagePreference> {
  if (actor.type !== "user") {
    // A consent is a person's record of what a person said. A job or an agent has not heard the patient.
    throw new MessagePreferenceError("not_a_person", "a patient's messaging consent is recorded by a person at a desk, not by the system");
  }
  const found = await tx.select().from(patientMessagePreferences).where(eq(patientMessagePreferences.patientId, patientId)).for("update");
  const cur = found[0];
  const next = {
    channel: cur?.channel ?? null,
    language: cur?.language ?? null,
    refillReminders: cur?.refillReminders ?? false,
    remindersConsentAt: cur?.remindersConsentAt ?? null,
    remindersConsentBy: cur?.remindersConsentBy ?? null,
    remindersConsentVia: cur?.remindersConsentVia ?? null,
    optedOutAt: cur?.optedOutAt ?? null,
    optedOutBy: cur?.optedOutBy ?? null,
    optedOutVia: cur?.optedOutVia ?? null,
  };
  let label: "reminders_on" | "reminders_off" | "stopped" | "resumed" | "channel" | "language";
  switch (change.kind) {
    case "reminders":
      if (change.on) {
        if (next.optedOutAt !== null) {
          throw new MessagePreferenceError(
            "messages_stopped",
            "this patient asked for no messages — turn messages back on first (ask them), then ask about reminders",
          );
        }
        Object.assign(next, { refillReminders: true, remindersConsentAt: now, remindersConsentBy: actor.id, remindersConsentVia: via });
        label = "reminders_on";
      } else {
        // The withdrawal keeps who gave the consent and when: the record of it having been given stands.
        next.refillReminders = false;
        label = "reminders_off";
      }
      break;
    case "stop":
      Object.assign(next, { refillReminders: false, optedOutAt: now, optedOutBy: actor.id, optedOutVia: via });
      label = "stopped";
      break;
    case "resume":
      Object.assign(next, { optedOutAt: null, optedOutBy: null, optedOutVia: null });
      label = "resumed";
      break;
    case "channel":
      next.channel = change.channel;
      label = "channel";
      break;
    case "language":
      next.language = change.language;
      label = "language";
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(`recordMessagePreference: unmapped change ${String(exhaustive)}`);
    }
  }
  const values = { ...next, updatedBy: actor.id, updatedAt: now };
  const [row] = await tx.insert(patientMessagePreferences)
    .values({ patientId, ...values })
    .onConflictDoUpdate({ target: patientMessagePreferences.patientId, set: values })
    .returning();
  await appendEvent(tx, messagePreferenceRecorded.make({
    occurredAt: now, actor, patientId,
    payload: {
      change: label, via, refillReminders: row!.refillReminders, optedOut: row!.optedOutAt !== null,
      channel: (row!.channel as MessageChannelChoice | null) ?? null, language: (row!.language as MessageLanguage | null) ?? null,
    },
  }));
  return toPreference(row!);
}
