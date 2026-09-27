import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { notifications, notifyTemplateRegistrations, patients, pushSubscriptions, users } from "../db/schema";
import { withTx } from "../db/client";
import type { Db, Tx } from "../db/client";
import { appendEvent } from "../events/append";
import { PushSubscriptionGoneError, adaptersFor, encodePushAddresses } from "./adapters";
import type { ChannelAdapter, PushAddress, SendMeta } from "./adapters";
import { consentsTo, messagePreferenceOf } from "./preferences";
import type { MessagePreference } from "./preferences";
import { ProviderRefusedError } from "./providers";
import {
  notificationExpired,
  notificationFailed,
  notificationSent,
  notificationSuppressed,
} from "./events";
import { reachProfileFor } from "./reach";
import { templateByKey } from "./templates";
import type { NotificationTemplate } from "./templates";
import type { NotifyProvider, NotifyPushProvider } from "../config";

// THE SEND PATH (Plan 10, D2/D3/D4/D6/D7). This is the file where a defect reaches a person.
//
// THE CLAIM PRECEDES THE ADAPTER CALL, and it is deliberately the OPPOSITE of the dispatcher's
// placement (events/dispatcher.ts:102-115). The dispatcher claims AFTER its handler succeeds
// because its nightmare is LOSING an event. This surface's nightmare is the mirror image: a
// WhatsApp message cannot be un-sent, so the gateway's nightmare is SENDING TWICE. All three
// claim placements in this codebase now exist with written reasoning — billing before (a second
// receipt is a real document), dispatcher after (silent loss is the defect it exists to remove),
// gateway before (a second message is a real message). Moving this one is a design change, not a
// fix (Assertion Book N4 is its mutant).
//
// CORRECTNESS NEVER RESTS ON THE ADVISORY LOCK (D3, inherited from 08.5 D3). The Scheduler's
// lock keeps two workers from burning the same cycles; the `FOR UPDATE SKIP LOCKED` claim below
// is what makes concurrency SAFE, exactly as the six shipped sweeps carry their own.

type Channel = ChannelAdapter["channel"];
type AdapterSet = Record<Channel, ChannelAdapter>;
type NotificationRow = typeof notifications.$inferSelect;
type PatientRow = typeof patients.$inferSelect;

export type NotifyPumpOptions = {
  batchSize?: number;
  maxAttemptsPerRung?: number;
  stuckAfterMs?: number;
  now?: Date;
  /**
   * The adapter set to send through. Tests inject recording/failing fakes here and drive
   * `runNotifyPump` DIRECTLY, never through the Scheduler (Global Constraint 8).
   */
  adapters?: AdapterSet;
};

const DEFAULT_BATCH_SIZE = 50;
/** D6: `attempts` counts failures on the CURRENT rung; at this many the rung advances. */
const DEFAULT_MAX_ATTEMPTS_PER_RUNG = 3;
/**
 * D2's FALLBACK ONLY, for a caller that passes no `stuckAfterMs` — tests, and any direct call.
 * PRODUCTION NO LONGER LANDS HERE: `registerAllJobs` threads `cfg.notifyStuckAfterMs` through the
 * registration (jobs.ts, Plan 11a R0-2), so the operator's `NOTIFY_STUCK_AFTER_MS` is what takes
 * effect. This constant is NOT a mirror of that key's zod default and must not be maintained as
 * one: the comment that used to stand here said it was, and a duplicated literal drifts with
 * nothing noticing (plan-10 gate report §7.2).
 */
const DEFAULT_STUCK_AFTER_MS = 300_000;
/** The dispatcher's own curve (dispatcher.ts:37), one convention across the codebase. */
const MAX_BACKOFF_SECONDS = 60;
/** D6: the patient and staff/owner ladders share this default; a template may narrow it. */
const DEFAULT_CHANNELS: Channel[] = ["whatsapp", "sms"];
/** D4: `status='merged'` resolves through `merged_into_patient_id`, bounded. */
const MERGE_MAX_HOPS = 5;

const PUMP_ACTOR: Actor = { type: "system", id: "notify-pump" };
const STUCK_ERROR = "claimed for sending and never completed — flagged, never re-sent (D2)";

/**
 * D11's provider selection, and the one choice this file had to make on its own.
 * `registerAllJobs` READS NO ENVIRONMENT (jobs.ts:84-90 — the B1 scar, and its docstring says to
 * keep it that way) and the plan's own registration line is `runNotifyPump(db, { now })`, so no
 * `AppConfig` reaches this function. `NOTIFY_PROVIDER`'s zod enum has exactly ONE member today
 * (`"console"`, config.ts:31), so resolving it here is behaviourally identical to reading the
 * key — but it is a SEAM, not a truth. The plan that lands a real provider threads the selected
 * one in through `opts.adapters`, which is the same seam tests use for fakes.
 */
const PUMP_PROVIDER: NotifyProvider = "console";
/**
 * PHASE O T4 — THE SAME SEAM, FOR THE SECOND KNOB. Push can be live while WhatsApp and SMS are
 * still on the console sink (RO-4), so it has its own provider; `registerAllJobs` still reads
 * no environment, so the default here is still the sink and a deployment that has generated
 * VAPID keys threads the real adapter set in through `opts.adapters` exactly as before.
 */
const PUMP_PUSH_PROVIDER: NotifyPushProvider = "console";

/** `next_attempt_at = now + min(2^attempts, 60) s`, attempts counted AFTER this failure (D6). */
const backoffMs = (attempts: number): number => Math.min(2 ** attempts, MAX_BACKOFF_SECONDS) * 1000;

// ---------------------------------------------------------------------------------------------
// D7 — QUIET HOURS. ONE PURE FUNCTION, AND THIS IS THE ONLY PLACE THE RULE EXISTS.
// ---------------------------------------------------------------------------------------------

/** IST is UTC+5:30 and has no DST — the offset is arithmetic, never a timezone database read. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Design law (D7), not a deployment knob: quiet hours are 21:00–08:00 IST, wrapping midnight. */
const QUIET_START_HOUR_IST = 21;
const QUIET_END_HOUR_IST = 8;

/**
 * Returns the instant the message may next be attempted, or `null` when it may go NOW.
 *
 * A DEFERRAL IS NOT A SUPPRESSION AND NOT A FAILURE (D4 step 4): the row goes back to `queued`
 * with `next_attempt_at` at the next 08:00 IST and NO attempt is counted — a message held
 * overnight has not failed at anything, and counting it would burn a rung by morning.
 *
 * It applies iff the audience is `patient` AND the template's urgency is `routine`. Urgent
 * templates ignore it BY DESIGN (§11.13): staff and owner messages in Phase 1 are
 * escalation-driven and therefore interrupt-class, and the owner matrix is real-time always.
 * That is the anti-alarm-fatigue boundary — digests are 12a producers, not this plan.
 */
export function quietHoursDeferral(
  template: Pick<NotificationTemplate, "urgency">,
  audience: string,
  now: Date,
  /**
   * PHASE O T4 — THE STAFF LEG, AND THE ONE SEAT IT DOES NOT APPLY TO.
   *
   * Until now this function returned null for everybody but patients, because staff messages
   * were escalations and an escalation at 03:00 is the point. The relay templates are not
   * escalations: a `can_wait` obligation relayed to a nurse's personal phone at 02:00 is the
   * noise that makes her mute the phone before the `now` one arrives (R9's failure, arriving
   * by a different road). So a ROUTINE staff template defers exactly as a routine patient one
   * does — and an URGENT one still does not, which is what keeps the `now` lane loud.
   *
   * `quietExempt` is R9's two seats: the night supervisor and the CMO, whose entire job is to
   * be interrupted. It is read from the person's reach profile, or their class's default.
   *
   * The hours are 08:00–21:00 IST for everybody. T7 builds `department_hours` and the staff leg
   * moves onto the addressee's own department — a casualty nurse's quiet hours are not an OPD
   * clerk's. Until that table exists there is nothing better to read, and inventing a second
   * copy of it here is what T7 would then have to delete.
   */
  opts: { quietExempt?: boolean } = {},
): Date | null {
  if (audience !== "patient" && audience !== "staff") return null;
  if (template.urgency !== "routine") return null;
  if (audience === "staff" && opts.quietExempt === true) return null;

  // Shift into IST and then read the UTC getters: the shifted instant's UTC fields ARE the IST
  // wall clock, which is what makes this arithmetic and not a locale lookup.
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const hourIst = istNow.getUTCHours();
  const afterEvening = hourIst >= QUIET_START_HOUR_IST;
  const beforeMorning = hourIst < QUIET_END_HOUR_IST;
  if (!afterEvening && !beforeMorning) return null;

  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  // 21:00 and later is TONIGHT's half of a window that wraps midnight, so it resumes tomorrow
  // morning; anything before 08:00 is the tail of last night's and resumes this morning.
  const resumeIst = istMidnight + QUIET_END_HOUR_IST * HOUR_MS + (afterEvening ? DAY_MS : 0);
  return new Date(resumeIst - IST_OFFSET_MS);
}

// ---------------------------------------------------------------------------------------------
// Terminal writes. EVERY ONE IS GUARDED ON `status = 'sending'` AND ONLY A WON FLIP APPENDS.
// ---------------------------------------------------------------------------------------------

type RowPatch = Partial<Omit<NotificationRow, "id" | "createdAt">>;

/** The guarded flip. Returns whether THIS caller won the row — nothing is appended if it did not. */
async function settle(tx: Tx, row: NotificationRow, patch: RowPatch, now: Date): Promise<boolean> {
  const won = await tx
    .update(notifications)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(notifications.id, row.id), eq(notifications.status, "sending")))
    .returning({ id: notifications.id });
  return won.length > 0;
}

async function markExpired(tx: Tx, row: NotificationRow, now: Date): Promise<void> {
  if (!(await settle(tx, row, { status: "expired" }, now))) return;
  await appendEvent(
    tx,
    notificationExpired.make({
      actor: PUMP_ACTOR,
      occurredAt: now,
      patientId: row.patientId ?? undefined,
      payload: { notificationId: row.id, templateKey: row.templateKey, audience: row.audience },
    }),
  );
}

async function markSuppressed(
  tx: Tx,
  row: NotificationRow,
  reason: "deceased" | "promotional_blocked" | "merge_unresolvable" | "opted_out" | "no_consent",
  now: Date,
): Promise<void> {
  if (!(await settle(tx, row, { status: "suppressed", lastError: reason }, now))) return;
  // The suppression EVENT is the audit trail that proves the stop fired (D4): a later reviewer
  // SEES the deceased check working rather than believing the comment above it.
  await appendEvent(
    tx,
    notificationSuppressed.make({
      actor: PUMP_ACTOR,
      occurredAt: now,
      patientId: row.patientId ?? undefined,
      payload: { notificationId: row.id, templateKey: row.templateKey, audience: row.audience, reason },
    }),
  );
}

async function markUndeliverable(
  tx: Tx,
  row: NotificationRow,
  reason: "ladder_exhausted" | "no_phone" | "no_push_subscription" | "render_error" | "stuck_sending",
  now: Date,
  lastError: string,
): Promise<void> {
  if (!(await settle(tx, row, { status: "undeliverable", lastError }, now))) return;
  // D6: for a PATIENT this event IS the desk flag — `alertsConsumer` turns it into a
  // `manual_notify` alert for the duty managers (T5). The pump raises no alert of its own; it
  // reuses 08.5's machinery instead of duplicating it.
  await appendEvent(
    tx,
    notificationFailed.make({
      actor: PUMP_ACTOR,
      occurredAt: now,
      patientId: row.patientId ?? undefined,
      payload: {
        notificationId: row.id,
        templateKey: row.templateKey,
        audience: row.audience,
        reason,
        refType: row.refType,
        refId: row.refId,
      },
    }),
  );
}

/**
 * The completion step, extracted because N13 is a claim ABOUT IT: run it twice against one
 * `sending` row and exactly one `notification.sent` exists. The `WHERE status = 'sending'` in
 * `settle` is what makes that true — a retry of completion wins nothing, so it appends nothing.
 * Appending outside that guard re-notifies nobody but lies to every consumer of the event log.
 */
export async function completeSend(
  tx: Tx,
  row: NotificationRow,
  sent: { channel: Channel; providerMessageId: string | null; templateVersion: number },
  now: Date,
): Promise<boolean> {
  const won = await settle(
    tx,
    row,
    {
      status: "sent",
      sentAt: now,
      sentChannel: sent.channel,
      sentTemplateVersion: sent.templateVersion,
      lastError: null,
      nextAttemptAt: null,
    },
    now,
  );
  if (!won) return false;

  await appendEvent(
    tx,
    notificationSent.make({
      actor: PUMP_ACTOR,
      occurredAt: now,
      patientId: row.patientId ?? undefined,
      payload: {
        notificationId: row.id,
        templateKey: row.templateKey,
        templateVersion: sent.templateVersion,
        audience: row.audience,
        channel: sent.channel,
        providerMessageId: sent.providerMessageId,
      },
    }),
  );
  return true;
}

// ---------------------------------------------------------------------------------------------
// Contact truth, read AT SEND TIME and never snapshotted at enqueue (D4).
// ---------------------------------------------------------------------------------------------

/**
 * Walks the merge chain from the row's patient to the survivor and returns EVERY record it
 * visited, survivor last. The whole chain comes back rather than only the survivor because the
 * deceased hard stop is asked of all of it: a merge says these records are ONE PERSON, so a
 * death recorded on any of them is that person's.
 *
 * Returns `null` for an unresolved or cyclic chain — defensive; it should not exist, and D4
 * says so. The bound is `MERGE_MAX_HOPS`, so a cycle cannot spin the pump.
 */
async function resolvePatientChain(tx: Tx, patientId: string | null): Promise<PatientRow[] | null> {
  if (patientId === null) {
    // Coherence is `enqueueNotification`'s job and there is no CHECK constraint behind it
    // (schema/notifications.ts:22-27). A row that got here anyway is a poison row: it throws
    // into the per-row catch in `runNotifyPump` and the batch carries on.
    throw new Error("notify pump: an audience='patient' row carries no patient_id");
  }

  const chain: PatientRow[] = [];
  let current = patientId;
  for (let hop = 0; hop <= MERGE_MAX_HOPS; hop += 1) {
    const found = await tx.select().from(patients).where(eq(patients.id, current));
    const patient = found[0];
    if (patient === undefined) return null;
    chain.push(patient);
    if (patient.status !== "merged") return chain;
    const next = patient.mergedIntoPatientId;
    if (next === null) return null;
    if (chain.some((seen) => seen.id === next)) return null; // a cycle
    current = next;
  }
  return null; // longer than the bound
}

// ---------------------------------------------------------------------------------------------
// The gauntlet.
// ---------------------------------------------------------------------------------------------

type SendPlan =
  | { kind: "done" }
  | {
      kind: "send";
      channel: Channel;
      channels: Channel[];
      to: string;
      text: string;
      templateVersion: number;
      /** PHARMACY P6 — what a real provider needs besides the text (`SendMeta`). */
      meta: Omit<SendMeta, "notificationId">;
    };

/**
 * PHARMACY P6 (patient messages) — the patient's word, over the WHOLE merge chain: a merge says the
 * records are one person, so a STOP said on either is theirs (the deceased rule's reasoning). The opt-in
 * and the choices are read from the survivor first, then the others in chain order.
 */
async function preferenceOfChain(tx: Tx, chain: PatientRow[]): Promise<{ stopped: boolean; best: MessagePreference | null }> {
  const prefs: MessagePreference[] = [];
  for (const p of [...chain].reverse()) {
    const pref = await messagePreferenceOf(tx, p.id);
    if (pref !== null) prefs.push(pref);
  }
  return { stopped: prefs.some((p) => p.optedOut !== null), best: prefs[0] ?? null };
}

/**
 * PHARMACY P6 — THE PATIENT LADDER, AS THE PATIENT AND THE GATEWAYS LEAVE IT. Two adjustments, patient
 * audience only (a staff row's `rung` is an index `runReachLadder` chose in the template's own order,
 * and moving the ladder under it would send on the wrong channel):
 *   1. the channel the patient asked for goes first, when the template's ladder carries it at all (a
 *      template that narrowed itself to SMS stays SMS);
 *   2. when a real gateway serves some rung, the SINK rungs drop out — otherwise a live SMS beside a
 *      WhatsApp still on the console would "send" every message to a log line and mark it sent. With no
 *      real gateway anywhere nothing drops: that is today's console-only hospital, unchanged.
 */
function patientLadder(channels: Channel[], pref: MessagePreference | null, adapters: AdapterSet): Channel[] {
  let ladder = [...channels];
  const first = pref?.channel ?? null;
  if (first !== null && ladder.includes(first)) ladder = [first, ...ladder.filter((c) => c !== first)];
  const real = ladder.filter((c) => adapters[c].sink !== true);
  return real.length > 0 ? real : ladder;
}

/**
 * THE SUPPRESSION GAUNTLET, IN D4'S ORDER, on a row this cycle has already claimed. Returns
 * either a message to hand an adapter, or `done` — meaning this row has already been written to
 * its terminal state (or deferred) inside this transaction.
 */
async function prepareRow(tx: Tx, row: NotificationRow, now: Date, adapters: AdapterSet): Promise<SendPlan> {
  // ── 1. EXPIRY (D5). CHECKED FIRST because a stale message is dead no matter what else is
  // true, and because this is the replay defense: a re-dispatched last-month booking expires
  // here instead of confirming an appointment that has already happened.
  if (row.expiresAt.getTime() <= now.getTime()) {
    await markExpired(tx, row, now);
    return { kind: "done" };
  }

  const template = templateByKey(row.templateKey);

  // Contact truth is LOADED here — phone, language, deceased state and merge state, all read at
  // SEND time (D4). A number corrected at the desk after enqueue is the one that gets used.
  const chain = row.audience === "patient" ? await resolvePatientChain(tx, row.patientId) : [];
  if (chain === null) {
    await markSuppressed(tx, row, "merge_unresolvable", now);
    return { kind: "done" };
  }
  const patient = chain[chain.length - 1] ?? null;

  // ── 2. DECEASED (D10, D-33, Assertion Book N1 — CRITICAL). The hard stop. It beats urgency
  // and it beats everything else in this function: a deceased patient's family is structurally
  // unreachable by this machinery, from the first message it ever sends. Deleting this line is
  // how a bereaved family gets an appointment reminder.
  if (chain.some((p) => p.deceasedAt !== null)) {
    await markSuppressed(tx, row, "deceased", now);
    return { kind: "done" };
  }

  // ── 2b. THE PATIENT'S OWN WORD (PHARMACY P6, DPDP). A STOP suppresses every patient message, the
  // transactional ones included; a template needing an opt-in is suppressed without one — including an
  // opt-in taken back after this row was queued, which `enqueueNotification` could not have seen.
  const word = row.audience === "patient" ? await preferenceOfChain(tx, chain) : { stopped: false, best: null };
  if (word.stopped) {
    await markSuppressed(tx, row, "opted_out", now);
    return { kind: "done" };
  }
  if (template.requiresOptIn !== undefined && !(row.audience === "patient" && consentsTo(word.best, template.requiresOptIn))) {
    await markSuppressed(tx, row, "no_consent", now);
    return { kind: "done" };
  }

  // ── 3. PROMOTIONAL BELT (D9). `enqueueNotification` already refuses this class outright, so
  // no such row can exist — this is the belt to that pair of braces, and it is what makes the
  // refusal survive a future writer that reaches the table another way.
  if (template.class === "promotional") {
    await markSuppressed(tx, row, "promotional_blocked", now);
    return { kind: "done" };
  }

  // ── 4. QUIET HOURS (D7, + T4's staff leg). Not a suppression: back to `queued`, no attempt
  // counted. The exemption is read per person, and only for the audience that can carry one.
  const quietExempt = row.audience === "staff" && row.userId !== null
    ? (await reachProfileFor(tx, row.userId)).quietExempt
    : false;
  const resumeAt = quietHoursDeferral(template, row.audience, now, { quietExempt });
  if (resumeAt !== null) {
    await settle(tx, row, { status: "queued", nextAttemptAt: resumeAt }, now);
    return { kind: "done" };
  }

  // ── 5. CHANNEL RESOLUTION (D6).
  //
  // PHASE O T4 REVERSED THE ORDER OF THIS STEP, and the reason is not style. It used to resolve
  // the ADDRESS first and the channel second, because every channel addressed a person by the
  // same string: a phone number. `web_push` does not — its address is a per-browser endpoint
  // and two keys — so "what is this person's address" is not answerable until you know which
  // channel is being asked about. Resolving the phone first would have declared a doctor with
  // no phone number unreachable by push, which is exactly backwards.
  const templateLadder = template.channels ?? DEFAULT_CHANNELS;
  const channels = row.audience === "patient" ? patientLadder(templateLadder, word.best, adapters) : templateLadder;
  const channel = channels[row.rung];
  if (channel === undefined) {
    await markUndeliverable(tx, row, "ladder_exhausted", now, row.lastError ?? "ladder exhausted");
    return { kind: "done" };
  }

  let to: string | null;
  if (channel === "web_push") {
    // EVERY live subscription, not the newest one. A doctor has a phone, the desk at the
    // station and the machine in the OT corridor; a push that reaches one of them reaches
    // nobody. The adapter fans across them and reports which are gone.
    const subs = row.userId === null ? [] : await livePushSubscriptions(tx, row.userId);
    if (subs.length === 0) {
      await markUndeliverable(
        tx, row, "no_push_subscription", now,
        "the recipient has granted no browser permission at send time",
      );
      return { kind: "done" };
    }
    to = encodePushAddresses(subs);
  } else {
    to = patient !== null ? patient.phone : await userPhone(tx, row.userId);
  }
  if (to === null || to === "") {
    // D-34's designed path: a phoneless patient enters at the desk-flag rung DIRECTLY, with
    // ZERO adapter calls (N9). A phoneless staff member or owner degrades to exactly the in-app
    // alert that already ships (D6) — 08.5's D6 guarantees it exists for every escalation.
    await markUndeliverable(tx, row, "no_phone", now, "no phone number on the recipient at send time");
    return { kind: "done" };
  }

  // ── 6. RENDER. Patient language is read from `patients.language` at send (D8); staff and
  // owner render `en`.
  // PHARMACY P6: the language the patient asked to be messaged in, when they said one.
  const asked = word.best?.language ?? null;
  const language: "hi" | "en" =
    row.audience !== "patient" ? "en" : (asked ?? patient?.language) === "en" ? "en" : "hi";
  let text: string;
  let variables: string[] | undefined;
  try {
    text = template.render[language](row.params);
    variables = template.variables?.(row.params);
  } catch (err) {
    // A RENDER THROW IS NOT A CHANNEL FAILURE AND NEVER ENTERS THE LADDER (D3). Retrying a
    // render cannot fix params — the second attempt renders the same wrong object with the same
    // missing field, so the ladder would spend both rungs and three attempts each discovering
    // that. Straight to undeliverable, and the desk gets a human task instead.
    await markUndeliverable(tx, row, "render_error", now, err instanceof Error ? err.message : String(err));
    return { kind: "done" };
  }

  // PHARMACY P6: the provider's ids for this template — a live DLT gateway refuses without its id.
  const reg = (await tx.select().from(notifyTemplateRegistrations).where(eq(notifyTemplateRegistrations.templateKey, row.templateKey)))[0];
  return {
    kind: "send", channel, channels: [...channels], to, text, templateVersion: template.version,
    meta: {
      templateKey: row.templateKey, language,
      ...(variables === undefined ? {} : { variables }),
      registration: { dltTemplateId: reg?.dltTemplateId ?? null, whatsappTemplateName: reg?.whatsappTemplateName ?? null },
    },
  };
}

/**
 * PHASE O T4 — every browser this person has granted permission in, newest first.
 *
 * Revoked rows are excluded and KEPT: a revocation is the record that a browser used to be
 * reachable and stopped being, which is what tells a supervisor why somebody stopped answering.
 */
async function livePushSubscriptions(tx: Tx, userId: string): Promise<PushAddress[]> {
  const rows = await tx
    .select({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));
  return rows;
}

/**
 * A `410 Gone` is the browser telling us the subscription no longer exists. It is not a
 * transient failure and there is nothing to retry: the row is closed, the others are untouched.
 */
export async function revokePushSubscriptions(tx: Tx, endpoints: string[], now: Date): Promise<number> {
  if (endpoints.length === 0) return 0;
  const revoked = await tx
    .update(pushSubscriptions)
    .set({ revokedAt: now })
    .where(and(inArray(pushSubscriptions.endpoint, endpoints), isNull(pushSubscriptions.revokedAt)))
    .returning({ id: pushSubscriptions.id });
  return revoked.length;
}

async function userPhone(tx: Tx, userId: string | null): Promise<string | null> {
  if (userId === null) {
    throw new Error("notify pump: a staff/owner row carries no user_id");
  }
  const found = await tx.select({ phone: users.phone }).from(users).where(eq(users.id, userId));
  return found[0]?.phone ?? null;
}

/**
 * An adapter said no. `attempts` counts failures ON THE CURRENT RUNG; at `maxAttemptsPerRung`
 * the rung advances and attempts reset. Exhausting the last rung is `undeliverable` +
 * `notification.failed` — which for a patient IS the desk rung (D6).
 */
async function recordAttemptFailure(
  tx: Tx,
  row: NotificationRow,
  channels: Channel[],
  err: unknown,
  now: Date,
  maxAttemptsPerRung: number,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempted = row.attempts + 1;
  // PHARMACY P6 — a provider's REFUSAL (no DLT id, no approved template, not a mobile) is not transient:
  // the second and third attempts would ask the same question. The rung advances at once.
  const advance = attempted >= maxAttemptsPerRung || err instanceof ProviderRefusedError;
  const nextRung = advance ? row.rung + 1 : row.rung;

  if (nextRung >= channels.length) {
    await markUndeliverable(tx, row, "ladder_exhausted", now, message);
    return;
  }

  await settle(
    tx,
    row,
    {
      status: "queued",
      rung: nextRung,
      attempts: advance ? 0 : attempted,
      lastError: message,
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempted)),
    },
    now,
  );
}

// ---------------------------------------------------------------------------------------------
// The cycle.
// ---------------------------------------------------------------------------------------------

/**
 * D2's recovery policy, ruled: a `sending` row older than `stuckAfterMs` is flipped to
 * `undeliverable` with `notification.failed(stuck_sending)` and — for a patient — the D6 desk
 * flag. IT IS NEVER AUTOMATICALLY RE-SENT (N14), because the message may already be with the
 * patient and only a human can find out. Exactly-once at a provider boundary is not achievable
 * without provider-side idempotency keys; this is the honest local optimum and the plan says so.
 */
async function recoverStuckSending(db: Db, now: Date, stuckAfterMs: number): Promise<void> {
  const cutoff = new Date(now.getTime() - stuckAfterMs);
  const stale = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.status, "sending"), lte(notifications.updatedAt, cutoff)));

  for (const row of stale) {
    await withTx(db, (tx) => markUndeliverable(tx, row, "stuck_sending", now, STUCK_ERROR));
  }
}

/**
 * THE CLAIM (D2). One statement: the inner `SELECT … FOR UPDATE SKIP LOCKED` picks due rows
 * nobody else holds, and the outer `UPDATE` flips them to `sending` — so by the time any row
 * leaves this function, no other worker and no overlapping tick can claim it. SKIP LOCKED (not
 * NOWAIT, not a plain lock) is what lets a second worker make progress on the REST of the batch
 * instead of queueing behind the first.
 */
async function claimBatch(db: Db, now: Date, batchSize: number): Promise<NotificationRow[]> {
  const at = now.toISOString();
  const claimed = await db.execute(sql`
    update notifications
    set status = 'sending', updated_at = ${at}::timestamptz
    where id in (
      select id from notifications
      where status = 'queued'
        and (next_attempt_at is null or next_attempt_at <= ${at}::timestamptz)
        and (scheduled_for is null or scheduled_for <= ${at}::timestamptz)
      order by created_at asc, id asc
      limit ${batchSize}
      for update skip locked
    )
    returning id
  `);

  const ids = (claimed.rows as unknown as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];

  const rows = await db.select().from(notifications).where(inArray(notifications.id, ids));
  return [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
}

/**
 * Best effort, and it must never throw: the row stays `sending` and `recoverStuckSending`
 * resolves it later. That is the conservative answer to an UNEXPECTED error, and the
 * `notification.failed` reason enum says so — it has no member for "something else went wrong",
 * because the pump does not know whether the adapter was reached, and D2 forbids guessing.
 */
async function noteRowError(db: Db, row: NotificationRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    // `updated_at` is DELIBERATELY left at the claim's own instant rather than moved forward:
    // it is the stuck clock, and touching it here would postpone the recovery this row needs.
    await db
      .update(notifications)
      .set({ lastError: message, updatedAt: row.updatedAt })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, "sending")));
  } catch {
    // Nothing left to do but leave the row for the stuck sweep; a throw here would stall the
    // batch, which is the one thing the per-row catch exists to prevent.
  }
}

/**
 * One pump cycle. Registered on 08.5's Scheduler as the seventh job (`kernel/worker/jobs.ts`),
 * and driven DIRECTLY by every test (Global Constraint 8). Returns the number of rows an
 * adapter accepted in this cycle.
 *
 * EVERY ROW PROCESSES INSIDE ITS OWN TRY/CATCH — one poison row never stalls the batch (D3).
 * The adapter call sits deliberately OUTSIDE any transaction: holding one open across a
 * provider round-trip would put a lock on the row for the length of somebody else's network,
 * and the guarded flip afterwards is what makes the short second transaction safe.
 */
export async function runNotifyPump(db: Db, opts: NotifyPumpOptions = {}): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttemptsPerRung = opts.maxAttemptsPerRung ?? DEFAULT_MAX_ATTEMPTS_PER_RUNG;
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const now = opts.now ?? new Date();
  const adapters = opts.adapters
    ?? adaptersFor({ notifyProvider: PUMP_PROVIDER, notifyPushProvider: PUMP_PUSH_PROVIDER, webPushVapid: null });

  await recoverStuckSending(db, now, stuckAfterMs);

  const claimed = await claimBatch(db, now, batchSize);
  let sent = 0;

  for (const row of claimed) {
    try {
      const plan = await withTx(db, (tx) => prepareRow(tx, row, now, adapters));
      if (plan.kind === "done") continue;

      let result: Awaited<ReturnType<ChannelAdapter["send"]>>;
      try {
        result = await adapters[plan.channel].send(plan.to, plan.text, { notificationId: row.id, ...plan.meta });
      } catch (err) {
        // Every subscription gone: close them all, then let the ladder climb to the next rung.
        // Without this the pump would retry three times against endpoints that will answer 410
        // for ever, and the person would look unreachable rather than un-subscribed.
        if (err instanceof PushSubscriptionGoneError) {
          await withTx(db, (tx) => revokePushSubscriptions(tx, err.endpoint.split(", ").filter((e) => e !== ""), now));
        }
        await withTx(db, (tx) => recordAttemptFailure(tx, row, plan.channels, err, now, maxAttemptsPerRung));
        continue;
      }

      // PHASE O T4 — a push that reached the phone and not the dead desktop is a DELIVERY, and
      // the dead desktop is a fact to record rather than a reason to climb. Revoked outside the
      // completeSend transaction on purpose: closing a subscription must not be able to roll
      // back the send that discovered it.
      if (result.goneAddresses !== undefined && result.goneAddresses.length > 0) {
        await withTx(db, (tx) => revokePushSubscriptions(tx, result.goneAddresses ?? [], now));
      }

      const won = await withTx(db, (tx) =>
        completeSend(
          tx,
          row,
          { channel: plan.channel, providerMessageId: result.providerMessageId, templateVersion: plan.templateVersion },
          now,
        ),
      );
      if (won) sent += 1;
    } catch (err) {
      await noteRowError(db, row, err);
    }
  }

  return sent;
}
