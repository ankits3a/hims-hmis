import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdAttendantMessageConsents, ipdDailyTotals, ipdFamilyLinks, notifications } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { maskPhone } from "../../kernel/notify/mask";
import { admissionAdvisoryLock, holdsPermission, readAdmission, requireIpdPermission } from "./admission-core";
import { attendantMessagesConsented, attendantMessagesStopped } from "./billdesk-events";
import { IPD_DAILY_TOTALS_SEND_HOUR_IST, attendantOf } from "./daily-totals";
import { IPD_LADDER_STATES } from "./deposit-ladder";
import { IpdError } from "./errors";
import { familyBlockOf, familyPhoneDigest } from "./family";
import { IPD_GOAL_TEMPLATES } from "./goals/goal-events";
import { IPD_BILL_VIEW, IPD_FAMILY_ISSUE } from "./permissions";
import type {
  Actor, IpdAttendantConsent, IpdAttendantMessages, IpdBillDeskDailyTotals, IpdDailyTotalsLine, IpdDailyTotalsSending,
} from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db, Tx } from "../../kernel/db/client";
import type { RecipientResolution, RecipientResolver, TemplateProviderIds } from "../../kernel/notify/pump";

/**
 * #761 — THE DAILY TOTALS REACH THE ATTENDANT, AND ONLY AS AN APPROVED TEMPLATE.
 *
 * The notify pump addresses an `ipd.daily_totals` row through the seam built here (`ipdAttendantRecipient`, installed by
 * `kernel/worker/jobs.ts`): the attendant reference the row carries is resolved to a phone AT SEND TIME — never a phone in
 * params. The seam suppresses the row when, at that moment:
 *   - the patient is sealed, MLC, or the treating team turned family updates off (`familyBlockOf`) → `recipient_blocked`;
 *   - the stay has ended → `recipient_blocked`;
 *   - the attendant said stop at the desk → `opted_out` (a stop beats every consent);
 *   - no consent is recorded for this attendant: neither a consent row here nor a live family link to the same attendant
 *     (whose consent was taken at issue, purpose `inpatient_updates`) → `no_consent`.
 * The reference no longer reaching a phone (guardian retired, phone cleared) is undeliverable `no_phone`.
 *
 * SENDING IS OFF until config names an approved template (`IPD_DAILY_TOTALS_WHATSAPP_TEMPLATE` and/or
 * `IPD_DAILY_TOTALS_DLT_TEMPLATE_ID`) AND the desk phone the message names (`IPD_BILL_DESK_PHONE`). Off, the config hands
 * the pump explicit nulls for the template, so the pump records each row `template_pending` and calls no adapter; the
 * bill desk shows "Not sent: template not configured".
 *
 * DECIDED (#761, standard practice): one message per admission per IST day (the `ipd_daily_totals` row), sent at 09:00 IST
 * (`IPD_DAILY_TOTALS_SEND_HOUR_IST`, the first hour after quiet hours); consent and stop are recorded by the desk that
 * issues family links (`ipd.family.issue`); the card is read under `ipd.bill.view`; every attempt is in the event log
 * (`ipd.daily_totals.skipped`, `notification.sent|suppressed|failed|expired`, `ipd.attendant_messages.*`).
 */

type DailyTotalsConfig = NonNullable<AppConfig["ipdDailyTotals"]>;
const NONE: DailyTotalsConfig = { whatsappTemplateName: null, dltTemplateId: null, deskPhone: null };

/** On or off, and what is missing — the one reading the pump, the bill desk and the card all share. */
export function dailyTotalsSendingOf(cfg: AppConfig["ipdDailyTotals"] | undefined): IpdDailyTotalsSending {
  const c = cfg ?? NONE;
  const channels: ("whatsapp" | "sms")[] = [];
  if (c.whatsappTemplateName !== null) channels.push("whatsapp");
  if (c.dltTemplateId !== null) channels.push("sms");
  const missing: string[] = [];
  if (channels.length === 0) missing.push("IPD_DAILY_TOTALS_WHATSAPP_TEMPLATE or IPD_DAILY_TOTALS_DLT_TEMPLATE_ID");
  if (c.deskPhone === null) missing.push("IPD_BILL_DESK_PHONE");
  return { on: missing.length === 0, channels, missing, sendHourIst: IPD_DAILY_TOTALS_SEND_HOUR_IST };
}

/**
 * The pump's provider ids for `ipd.daily_totals`, FROM CONFIG ONLY: explicit nulls while sending is off (so no table row
 * and no console sink can carry it), the configured approved ids when it is on.
 */
export function ipdTemplateRegistrations(cfg: AppConfig["ipdDailyTotals"] | undefined): Record<string, TemplateProviderIds> {
  const c = cfg ?? NONE;
  const on = dailyTotalsSendingOf(c).on;
  return {
    [IPD_GOAL_TEMPLATES.dailyTotals]: on
      ? { whatsappTemplateName: c.whatsappTemplateName, dltTemplateId: c.dltTemplateId }
      : { whatsappTemplateName: null, dltTemplateId: null },
  };
}

type Kind = "guardian" | "deposit_payer";
type Word =
  | { state: "blocked" | "stopped" | "no_consent" | "number_changed"; reason: "recipient_blocked" | "opted_out" | "no_consent" }
  | { state: "no_attendant" }
  | { state: "ok"; phone: string };

async function consentRow(db: Db | Tx, admissionId: string, ref: string) {
  return (await db.select().from(ipdAttendantMessageConsents)
    .where(and(eq(ipdAttendantMessageConsents.admissionId, admissionId), eq(ipdAttendantMessageConsents.attendantRef, ref))))[0];
}

/**
 * A live family link to this attendant. Its consent covers the daily totals only for the phone it was issued to (the link
 * keeps that phone as an HMAC, and refuses its own sends once the phone changes): with `phone` and the server key given, a
 * link issued to another number is not consent here either. Without the key no link counts (fail closed).
 */
async function liveFamilyLinkTo(db: Db | Tx, admissionId: string, ref: string, phone?: { phone: string; secretKey: Buffer | undefined }): Promise<boolean> {
  const r = await db.select({ phoneHash: ipdFamilyLinks.phoneHash }).from(ipdFamilyLinks).where(and(
    eq(ipdFamilyLinks.admissionId, admissionId), eq(ipdFamilyLinks.attendantRef, ref), eq(ipdFamilyLinks.status, "active"),
  ));
  if (phone === undefined) return r.length > 0;
  const key = phone.secretKey;
  if (key === undefined) return false;
  return r.some((l) => l.phoneHash === familyPhoneDigest(key, phone.phone));
}

/**
 * The send-time rule above, for one admission and one attendant reference. The reference must still be the admission's
 * registered attendant (`attendantOf` now): a row queued for an attendant since replaced reaches nobody — the desk's card,
 * consent and stop all name the current one.
 */
async function attendantWordOf(db: Db | Tx, admissionId: string, kind: Kind, ref: string, secretKey: Buffer | undefined): Promise<Word> {
  const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined || !(IPD_LADDER_STATES as readonly string[]).includes(a.state)) return { state: "blocked", reason: "recipient_blocked" };
  if ((await familyBlockOf(db, a)) !== null) return { state: "blocked", reason: "recipient_blocked" };
  const row = await consentRow(db, admissionId, ref);
  if (row?.stoppedAt != null) return { state: "stopped", reason: "opted_out" };
  const now = await attendantOf(db, a.patientId, a.id);
  if (now === null || now.kind !== kind || now.ref !== ref) return { state: "no_attendant" };
  // DECIDED (DPDP practice): consent is for a NUMBER. A desk consent keeps the HMAC of the phone it was given for; a phone
  // changed since then is no consent until the desk records it again ("consent needed again (number changed)").
  const digest = secretKey === undefined ? null : familyPhoneDigest(secretKey, now.phone);
  const deskFor = row?.consentedAt == null || row.consent == null ? null : (row.consent.phoneHash ?? "");
  if (deskFor !== null && digest !== null && deskFor === digest) return { state: "ok", phone: now.phone };
  if (await liveFamilyLinkTo(db, admissionId, ref, { phone: now.phone, secretKey })) return { state: "ok", phone: now.phone };
  if (deskFor !== null) return { state: "number_changed", reason: "no_consent" };
  return { state: "no_consent", reason: "no_consent" };
}

/** The pump's recipient seam for `recipient: "attendant"` rows (installed by `registerAllJobs`). */
export function ipdAttendantRecipient(cfg: AppConfig["ipdDailyTotals"] | undefined, secretKey?: Buffer): RecipientResolver {
  const deskPhone = (cfg ?? NONE).deskPhone;
  return async (tx, row): Promise<RecipientResolution> => {
    const p = row.params as { attendant?: unknown; attendantRef?: unknown };
    const kind = p.attendant === "guardian" || p.attendant === "deposit_payer" ? p.attendant : null;
    const ref = typeof p.attendantRef === "string" && p.attendantRef !== "" ? p.attendantRef : null;
    if (row.refType !== "admission" || row.refId === null || kind === null || ref === null) {
      return { kind: "no_phone", detail: "the row names no admission or attendant reference" };
    }
    const w = await attendantWordOf(tx, row.refId, kind, ref, secretKey);
    if (w.state === "no_attendant") return { kind: "no_phone", detail: "the attendant this was queued for is not the registered attendant with a phone at send time" };
    if (w.state !== "ok") return { kind: "suppress", reason: w.reason };
    return { kind: "send", to: w.phone, ...(deskPhone === null ? {} : { renderParams: { deskPhone } }) };
  };
}

// ═══════════════════════════════════════ the words the desk reads ═══════════════════════════════════════

const SUPPRESSED_WORDS: Record<string, string> = {
  opted_out: "Not sent: messages stopped",
  no_consent: "Not sent: no consent recorded",
  recipient_blocked: "Not sent: family updates are off for this patient",
  deceased: "Not sent: patient deceased",
};

/** One day's line: what happened to the message, in words — never silent. */
export function dailyTotalsWords(
  outcome: string, n: { status: string; lastError: string | null } | null, sending: IpdDailyTotalsSending,
): { status: IpdDailyTotalsLine["status"]; words: string } {
  if (outcome === "no_attendant_phone") return { status: "not_sent", words: "Not sent: no attendant phone" };
  if (outcome === "sealed") return { status: "not_sent", words: "Not sent: sealed patient" };
  if (n === null) return { status: "not_sent", words: "Not sent: already recorded" };
  const at = `${String(IPD_DAILY_TOTALS_SEND_HOUR_IST).padStart(2, "0")}:00`;
  if (n.status === "queued" || n.status === "sending") {
    return sending.on ? { status: "waiting", words: `Waiting: sends at ${at}` } : { status: "waiting", words: "Waiting: template not configured" };
  }
  if (n.status === "sent") return { status: "sent", words: "Sent" };
  if (n.status === "expired") return { status: "not_sent", words: "Not sent: expired" };
  if (n.status === "suppressed") {
    if (n.lastError === "template_pending") {
      return { status: "not_sent", words: sending.on ? "Not sent: no message gateway for the approved template" : "Not sent: template not configured" };
    }
    return { status: "not_sent", words: SUPPRESSED_WORDS[n.lastError ?? ""] ?? "Not sent" };
  }
  return { status: "not_sent", words: "Not sent: could not deliver" };
}

/** The bill desk's strip for the day the nightly run reported (yesterday, IST). */
export async function readDailyTotalsStrip(db: Db, sending: IpdDailyTotalsSending, now: Date): Promise<IpdBillDeskDailyTotals> {
  const billDate = istDayString(new Date(now.getTime() - 24 * 3_600_000));
  const rows = await db.select({
    admissionId: ipdDailyTotals.admissionId, outcome: ipdDailyTotals.outcome, admissionNo: ipdAdmissions.admissionNo,
    status: notifications.status, lastError: notifications.lastError,
  }).from(ipdDailyTotals)
    .innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdDailyTotals.admissionId))
    .leftJoin(notifications, eq(notifications.id, ipdDailyTotals.notificationId))
    .where(eq(ipdDailyTotals.billDate, billDate));
  let sent = 0;
  let waiting = 0;
  const notSent: IpdDailyTotalsLine[] = [];
  for (const r of rows) {
    const w = dailyTotalsWords(r.outcome, r.status === null ? null : { status: r.status, lastError: r.lastError }, sending);
    if (w.status === "sent") sent += 1;
    else if (w.status === "waiting") waiting += 1;
    // The admission number only: the desk is read over a shoulder, and a sealed patient has no name here.
    else notSent.push({ admissionId: r.admissionId, admissionNo: r.admissionNo, billDate, ...w });
  }
  notSent.sort((x, y) => (x.admissionNo ?? "").localeCompare(y.admissionNo ?? ""));
  return { billDate, sending, sent, waiting, notSent };
}

// ═══════════════════════════════════════ the admission's card and its two acts ═══════════════════════════════════════

export async function readAttendantMessages(
  db: Db, actor: Actor, admissionId: string, sending: IpdDailyTotalsSending, opts: { secretKey?: Buffer } = {},
): Promise<IpdAttendantMessages> {
  await requireIpdPermission(db, actor, IPD_BILL_VIEW);
  const a = await readAdmission(db, admissionId);
  const to = await attendantOf(db, a.patientId, a.id);
  const row = to === null ? undefined : await consentRow(db, a.id, to.ref);
  const viaFamilyLink = to === null ? false : await liveFamilyLinkTo(db, a.id, to.ref, { phone: to.phone, secretKey: opts.secretKey });
  const word = to === null ? ({ state: "no_attendant" } as const) : await attendantWordOf(db, a.id, to.kind, to.ref, opts.secretKey);
  const last = (await db.select({ billDate: ipdDailyTotals.billDate, outcome: ipdDailyTotals.outcome, status: notifications.status, lastError: notifications.lastError })
    .from(ipdDailyTotals).leftJoin(notifications, eq(notifications.id, ipdDailyTotals.notificationId))
    .where(eq(ipdDailyTotals.admissionId, a.id)).orderBy(desc(ipdDailyTotals.billDate)).limit(1))[0];
  const state: IpdAttendantMessages["state"] = word.state === "ok" ? (sending.on ? "will_send" : "not_configured") : word.state;
  const WORDS: Record<IpdAttendantMessages["state"], string> = {
    will_send: `Daily totals go to the attendant at ${String(IPD_DAILY_TOTALS_SEND_HOUR_IST).padStart(2, "0")}:00`,
    not_configured: "Not sent: template not configured",
    no_attendant: "Not sent: no attendant phone",
    no_consent: "Not sent: no consent recorded",
    number_changed: "Consent needed again (number changed)",
    stopped: "Not sent: messages stopped",
    blocked: "Not sent: family updates are off for this patient",
  };
  return {
    admissionId: a.id,
    attendant: to === null ? null : { kind: to.kind, phoneMasked: maskPhone(to.phone) },
    // Named fields only: the phone digest the consent keeps never leaves the server.
    consent: row?.consent == null || row.consentedAt === null ? null : {
      consentedBy: row.consent.consentedBy, relation: row.consent.relation, method: row.consent.method, at: row.consentedAt.toISOString(),
    },
    viaFamilyLink,
    stoppedAt: row?.stoppedAt?.toISOString() ?? null,
    state, words: WORDS[state], sending,
    last: last === undefined ? null : {
      admissionId: a.id, admissionNo: a.admissionNo, billDate: last.billDate,
      ...dailyTotalsWords(last.outcome, last.status === null ? null : { status: last.status, lastError: last.lastError }, sending),
    },
    canManage: await holdsPermission(db, actor, IPD_FAMILY_ISSUE),
  };
}

/** The attendant who would receive the message now, under the admission's lock; refuses when there is none. */
async function currentAttendant(tx: Tx, admissionId: string) {
  await admissionAdvisoryLock(tx, admissionId);
  const a = await readAdmission(tx, admissionId);
  if (!(IPD_LADDER_STATES as readonly string[]).includes(a.state)) {
    throw new IpdError("attendant_messages_refused", "Daily totals are only for a patient in a bed.", { reason: "stay_ended" });
  }
  const to = await attendantOf(tx, a.patientId, a.id);
  if (to === null) {
    throw new IpdError("attendant_messages_refused", "No registered attendant phone. Record a guardian with bill authority and a phone, or the deposit payer's phone.", { reason: "no_attendant_phone" });
  }
  return { a, to };
}

/** Consent to the daily totals for the registered attendant (re-consenting clears an earlier stop). */
export async function recordAttendantConsent(
  db: Db, actor: Actor, admissionId: string, input: IpdAttendantConsent, opts: { now?: Date; secretKey: Buffer },
): Promise<{ recorded: true }> {
  await requireIpdPermission(db, actor, IPD_FAMILY_ISSUE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const { a, to } = await currentAttendant(tx, admissionId);
    // The consent is for this number: its HMAC (never the number) is kept with it.
    const consent = { ...input.consent, phoneHash: familyPhoneDigest(opts.secretKey, to.phone) };
    const values = { consent, consentedBy: actor.id, consentedAt: now, stoppedAt: null, stoppedBy: null, updatedAt: now };
    await tx.insert(ipdAttendantMessageConsents)
      .values({ id: newId(), admissionId: a.id, attendantKind: to.kind, attendantRef: to.ref, ...values })
      .onConflictDoUpdate({ target: [ipdAttendantMessageConsents.admissionId, ipdAttendantMessageConsents.attendantRef], set: values });
    await appendEvent(tx, attendantMessagesConsented.make({
      actor, occurredAt: now, correlationId: a.id, patientId: a.patientId,
      payload: { admissionId: a.id, attendantKind: to.kind, relation: input.consent.relation, method: input.consent.method, provenance: "person" },
    }));
    return { recorded: true as const };
  });
}

/** The attendant asked to stop: no further daily totals to this attendant on this admission, whatever consent exists. */
export async function stopAttendantMessages(
  db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {},
): Promise<{ stopped: boolean }> {
  await requireIpdPermission(db, actor, IPD_FAMILY_ISSUE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const { a, to } = await currentAttendant(tx, admissionId);
    const row = await consentRow(tx, a.id, to.ref);
    if (row?.stoppedAt != null) return { stopped: false };
    if (row === undefined) {
      await tx.insert(ipdAttendantMessageConsents).values({
        id: newId(), admissionId: a.id, attendantKind: to.kind, attendantRef: to.ref, stoppedAt: now, stoppedBy: actor.id, updatedAt: now,
      });
    } else {
      await tx.update(ipdAttendantMessageConsents).set({ stoppedAt: now, stoppedBy: actor.id, updatedAt: now })
        .where(eq(ipdAttendantMessageConsents.id, row.id));
    }
    await appendEvent(tx, attendantMessagesStopped.make({
      actor, occurredAt: now, correlationId: a.id, patientId: a.patientId,
      payload: { admissionId: a.id, attendantKind: to.kind, provenance: "person" },
    }));
    return { stopped: true };
  });
}
