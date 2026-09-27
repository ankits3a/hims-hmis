import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  invoices, notifications, notifyTemplateRegistrations, patientMessagePreferences, patients, pharmacyDispenseLines, pharmacyDispenses,
  pharmacyMessageSettings, pharmacyRetailSaleLines, pharmacyRetailSales,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { patientMessagingLive } from "../../kernel/config";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { consentsTo, messagePreferenceOf } from "../../kernel/notify/preferences";
import { templateByKey } from "../../kernel/notify/templates";
import { loadOpdConfig } from "../opd";
import {
  PHARMACY_MESSAGE_TEMPLATES, PHARMACY_BILL_TEMPLATE, PHARMACY_REFILL_TEMPLATE, REFILL_LOOKBACK_DAYS,
  REFILL_MIN_SUPPLY_DAYS, REFILL_REMINDER_LEAD_DAYS, REFILL_REMINDER_NAMES_DRUGS, istDateOf,
} from "./config";
import { controlOf } from "./controlled";
import { PharmacyError } from "./errors";
import { dispenseHandedOver, retailSold } from "./events";
import { doseUnits, dosesPerDay } from "./qty";
import { userNames } from "./queue";
import type { Db, Tx } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";
import type { MessagePreference } from "../../kernel/notify/preferences";
import type { RxLine } from "../opd";

/**
 * ═══ PHARMACY P6 (patient messages) — THE PATIENT HEARS: A BILL, AND AN OPT-IN REFILL REMINDER ═══
 *
 * The last item of the parity plan's P6, built on the notify kernel and nothing beside it: both
 * messages are templates in `kernel/notify/templates.ts`, both go into the one outbox through
 * `enqueueNotification`, and the pump sends them — quiet hours, the channel ladder, the deceased stop,
 * the patient's STOP and the provider all live there. This file only decides WHEN a pharmacy message
 * is owed and WHAT it may carry.
 *
 *   THE BILL      on `dispense.handed_over` (the OPD counter) and `retail.sold` (the walk-in counter),
 *                 ONCE PER INVOICE (the dedupe key is the invoice id: a redelivered event, or a second
 *                 event about the same bill, inserts nothing). Transactional: no opt-in, but never to a
 *                 patient who stopped messages, never for a zero bill, never for a paper dispense typed
 *                 in after an outage (the patient left days ago), and never to a patient with no phone
 *                 (they hold the printed bill; queuing it would only raise a "call them" task nobody
 *                 can do).
 *   THE REMINDER  a daily job. For each patient who OPTED IN, the lines of their handed-over dispenses
 *                 whose supply — quantity ÷ (dose × doses a day) from the prescription's own words, when
 *                 those words parse — is at least `REFILL_MIN_SUPPLY_DAYS` (a chronic-looking line), not
 *                 since refilled (a later dispense or walk-in sale of the same item), and runs out within
 *                 `REFILL_REMINDER_LEAD_DAYS`. ONCE PER DISPENSE. A controlled line (Schedule X, NDPS)
 *                 never prompts a reminder: it is dispensed only against a new prescription.
 *
 * NEITHER NAMES A DRUG. `REFILL_REMINDER_NAMES_DRUGS` is the owner's switch and it is OFF; even ON, a
 * Schedule X, NDPS or H1 line is never named (`namableDrugs`).
 */
export const PHARMACY_MESSAGES_CONSUMER = "pharmacy.patient_messages";

const BILL_REF_TYPE = "invoice";
const REFILL_REF_TYPE = "pharmacy_dispense";

/** Whose hospital: the letterhead's name, or a plain word when an unconfigured box has none. */
async function hospitalName(exec: Db | Tx): Promise<string> {
  try {
    return (await loadOpdConfig(exec)).letterhead.name;
  } catch {
    return "Hospital";
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE BILL
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type BillEnqueueSkip = "no_invoice" | "zero_bill" | "no_phone" | "stopped";

/**
 * Queue the bill message for one invoice, or say why not. Idempotent by invoice: the second call for
 * the same bill — a redelivery, or the other event — inserts nothing and returns `{ id: null }`.
 */
export async function enqueueBillMessage(
  tx: Tx,
  input: { patientId: string; invoiceId: string; occurredAt: Date; sourceEventId: string | null },
): Promise<{ id: string | null; skipped: BillEnqueueSkip | null }> {
  const inv = (await tx.select({ invoiceNo: invoices.invoiceNo, netPayablePaise: invoices.netPayablePaise, serviceDay: invoices.serviceDay })
    .from(invoices).where(eq(invoices.id, input.invoiceId)))[0];
  if (inv === undefined) return { id: null, skipped: "no_invoice" };
  if (inv.netPayablePaise <= 0) return { id: null, skipped: "zero_bill" };
  const phone = (await tx.select({ phone: patients.phone }).from(patients).where(eq(patients.id, input.patientId)))[0]?.phone ?? null;
  if (phone === null || phone.trim() === "") return { id: null, skipped: "no_phone" };
  if ((await messagePreferenceOf(tx, input.patientId))?.optedOut != null) return { id: null, skipped: "stopped" };

  const queued = await enqueueNotification(tx, {
    templateKey: PHARMACY_BILL_TEMPLATE,
    params: { hospital: await hospitalName(tx), billNo: inv.invoiceNo, amountPaise: inv.netPayablePaise, paidOn: inv.serviceDay },
    dedupeKey: `${PHARMACY_BILL_TEMPLATE}:${input.invoiceId}`,
    occurredAt: input.occurredAt,
    patientId: input.patientId,
    sourceEventId: input.sourceEventId,
    refType: BILL_REF_TYPE,
    refId: input.invoiceId,
  });
  return { id: queued?.id ?? null, skipped: null };
}

/** The consumer's one decision per event: which invoice, whose. Exported for the tests, which drive it directly. */
export async function handlePharmacyMessageEvent(tx: Tx, e: Pick<DispatchedEvent, "eventId" | "name" | "payload" | "occurredAt">): Promise<{ id: string | null; skipped: BillEnqueueSkip | "downtime" | "not_ours" | null }> {
  if (e.name === dispenseHandedOver.name) {
    const p = dispenseHandedOver.payloadSchema.parse(e.payload);
    const d = (await tx.select({ invoiceId: pharmacyDispenses.invoiceId }).from(pharmacyDispenses).where(eq(pharmacyDispenses.id, p.dispenseId)))[0];
    if (d?.invoiceId == null) return { id: null, skipped: "no_invoice" };
    return enqueueBillMessage(tx, { patientId: p.patientId, invoiceId: d.invoiceId, occurredAt: e.occurredAt, sourceEventId: e.eventId });
  }
  if (e.name === retailSold.name) {
    const p = retailSold.payloadSchema.parse(e.payload);
    // A paper dispense is typed in after the outage, days after the patient left with the paper bill.
    if (p.channel === "downtime") return { id: null, skipped: "downtime" };
    return enqueueBillMessage(tx, { patientId: p.patientId, invoiceId: p.invoiceId, occurredAt: e.occurredAt, sourceEventId: e.eventId });
  }
  return { id: null, skipped: "not_ours" };
}

export function pharmacyMessagesConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== dispenseHandedOver.name && e.name !== retailSold.name) {
      // The manifest routes exactly these two here; anything else means the two halves drifted.
      throw new Error(`pharmacy messages consumer: no branch for event "${e.name}"`);
    }
    await withTx(db, (tx) => handlePharmacyMessageEvent(tx, e));
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE REMINDER
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` plus `n` calendar days. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * How many days `qtyBase` lasts at the prescription's own rate, or null when its words do not parse
 * (SOS, "as directed", a dose with no number). PURE. "1 tab BD" and 60 tablets is 30 days; "5 ml TDS"
 * and 100 ml is 6⅔ days.
 */
export function supplyDays(line: Pick<RxLine, "dose" | "frequency">, qtyBase: number): number | null {
  const perDay = dosesPerDay(line.frequency);
  const units = doseUnits(line.dose);
  if (perDay === null || units === null || !(qtyBase > 0)) return null;
  return qtyBase / (perDay * units);
}

export type RefillLine = {
  itemId: string | null; qtyBase: number | null; rxLine: RxLine; scheduleFlag: string | null; ndpsClass: string | null;
};

/**
 * The names a message may ever carry, when the owner has switched names ON: the doctor's words for each
 * line, never a Schedule X, NDPS or H1 line's. PURE, and the only door a name has into a message.
 */
export function namableDrugs(lines: readonly RefillLine[]): string[] {
  return lines
    .filter((l) => l.scheduleFlag !== "H1" && !controlOf(l.scheduleFlag, l.ndpsClass).controlled)
    .map((l) => l.rxLine.drug.trim())
    .filter((d) => d !== "");
}

/**
 * One dispense's reminder, or null. PURE. The chronic lines are those lasting at least `minSupplyDays`
 * and not controlled; the dispense runs out when its FIRST chronic line does; the reminder is due from
 * `leadDays` before that day until the day itself.
 */
export function refillDue(
  handedOverOn: string,
  lines: readonly RefillLine[],
  today: string,
  opts: { leadDays: number; minSupplyDays: number },
): { runsOutOn: string; lines: RefillLine[] } | null {
  const chronic: { line: RefillLine; days: number }[] = [];
  for (const l of lines) {
    if (l.qtyBase === null || controlOf(l.scheduleFlag, l.ndpsClass).controlled) continue;
    const days = supplyDays(l.rxLine, l.qtyBase);
    if (days === null || days < opts.minSupplyDays) continue;
    chronic.push({ line: l, days });
  }
  if (chronic.length === 0) return null;
  const firstOut = Math.min(...chronic.map((c) => Math.floor(c.days)));
  const runsOutOn = addDays(handedOverOn, firstOut);
  if (today < addDays(runsOutOn, -opts.leadDays) || today > runsOutOn) return null;
  return { runsOutOn, lines: chronic.map((c) => c.line) };
}

export type RefillRunResult = {
  /** Why nothing could be sent at all, or null. */
  held: "no_contact_phone" | null;
  enqueued: { dispenseId: string; patientId: string }[];
};

/**
 * THE DAILY JOB (`kernel/worker/jobs.ts`, 10:00 IST — inside the message hours, so the pump need not
 * hold anything overnight). Reads only opted-in, un-stopped patients with a phone; enqueues through the
 * kernel, whose opt-in brace refuses anything this function got wrong.
 */
export async function runRefillReminders(
  db: Db,
  now: Date,
  opts: { leadDays?: number; minSupplyDays?: number; nameDrugs?: boolean } = {},
): Promise<RefillRunResult> {
  const leadDays = opts.leadDays ?? REFILL_REMINDER_LEAD_DAYS;
  const minSupplyDays = opts.minSupplyDays ?? REFILL_MIN_SUPPLY_DAYS;
  const nameDrugs = opts.nameDrugs ?? REFILL_REMINDER_NAMES_DRUGS;
  const settings = (await db.select().from(pharmacyMessageSettings).where(eq(pharmacyMessageSettings.id, "main")))[0];
  if (settings === undefined) return { held: "no_contact_phone", enqueued: [] };

  const today = istDateOf(now);
  const since = new Date(now.getTime() - REFILL_LOOKBACK_DAYS * 86_400_000);
  const optedIn = await db.select({ patientId: patientMessagePreferences.patientId })
    .from(patientMessagePreferences)
    .innerJoin(patients, eq(patients.id, patientMessagePreferences.patientId))
    .where(and(
      eq(patientMessagePreferences.refillReminders, true), isNull(patientMessagePreferences.optedOutAt),
      isNotNull(patients.phone), isNull(patients.deceasedAt),
    ));
  const hospital = await hospitalName(db);
  const enqueued: RefillRunResult["enqueued"] = [];

  for (const { patientId } of optedIn) {
    const dispenses = await db.select({ id: pharmacyDispenses.id, handedOverAt: pharmacyDispenses.handedOverAt })
      .from(pharmacyDispenses)
      .where(and(eq(pharmacyDispenses.patientId, patientId), eq(pharmacyDispenses.status, "handed_over"), gte(pharmacyDispenses.handedOverAt, since)))
      .orderBy(desc(pharmacyDispenses.handedOverAt));
    if (dispenses.length === 0) continue;
    const lines = await db.select({
      dispenseId: pharmacyDispenseLines.dispenseId, itemId: pharmacyDispenseLines.itemId, qtyBase: pharmacyDispenseLines.qtyBase,
      rxLine: pharmacyDispenseLines.rxLine, scheduleFlag: pharmacyDispenseLines.scheduleFlag, ndpsClass: pharmacyDispenseLines.ndpsClass,
    }).from(pharmacyDispenseLines)
      .where(and(inArray(pharmacyDispenseLines.dispenseId, dispenses.map((d) => d.id)), eq(pharmacyDispenseLines.status, "open"), isNotNull(pharmacyDispenseLines.ledgerEntryId)));
    // A walk-in purchase of the same item is a refill too.
    const retail = await db.select({ itemId: pharmacyRetailSaleLines.itemId, soldAt: pharmacyRetailSales.soldAt })
      .from(pharmacyRetailSaleLines)
      .innerJoin(pharmacyRetailSales, eq(pharmacyRetailSales.id, pharmacyRetailSaleLines.saleId))
      .where(and(eq(pharmacyRetailSales.patientId, patientId), gte(pharmacyRetailSales.soldAt, since)));

    /** The last time each item left this pharmacy for this patient, by either counter. */
    const lastOut = new Map<string, number>();
    const note = (itemId: string | null, at: Date | null): void => {
      if (itemId === null || at === null) return;
      lastOut.set(itemId, Math.max(lastOut.get(itemId) ?? 0, at.getTime()));
    };
    for (const d of dispenses) for (const l of lines) if (l.dispenseId === d.id) note(l.itemId, d.handedOverAt);
    for (const r of retail) note(r.itemId, r.soldAt);

    for (const d of dispenses) {
      if (d.handedOverAt === null) continue;
      const at = d.handedOverAt.getTime();
      // A line bought again since is not running low: it was refilled.
      const own = lines.filter((l) => l.dispenseId === d.id && (l.itemId === null || (lastOut.get(l.itemId) ?? 0) <= at))
        .map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase, rxLine: l.rxLine as RxLine, scheduleFlag: l.scheduleFlag, ndpsClass: l.ndpsClass }));
      const due = refillDue(istDateOf(d.handedOverAt), own, today, { leadDays, minSupplyDays });
      if (due === null) continue;
      const drugs = nameDrugs ? namableDrugs(due.lines).join(", ") : "";
      const queued = await withTx(db, async (tx) => {
        // Re-read inside the transaction: the consent may have been withdrawn since the list was read.
        if (!consentsTo(await messagePreferenceOf(tx, patientId), "refill_reminders")) return null;
        return enqueueNotification(tx, {
          templateKey: PHARMACY_REFILL_TEMPLATE,
          params: {
            hospital, since: istDateOf(d.handedOverAt!), runsOutOn: due.runsOutOn, contactPhone: settings.contactPhone,
            ...(drugs === "" ? {} : { drugs }),
          },
          dedupeKey: `${PHARMACY_REFILL_TEMPLATE}:${d.id}`,
          occurredAt: now,
          patientId,
          refType: REFILL_REF_TYPE,
          refId: d.id,
        });
      });
      if (queued !== null) enqueued.push({ dispenseId: d.id, patientId });
    }
  }
  return { held: null, enqueued };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE DESK SEES
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ProviderState = { sms: boolean; whatsapp: boolean };

export type BillMessageState =
  | "not_yet" | "no_phone" | "stopped" | "zero_bill" | "pending"
  | "queued" | "held_quiet_hours" | "sending" | "sent" | "logged_only" | "suppressed" | "expired" | "failed";

export type PatientMessagesView = {
  hasPhone: boolean;
  phoneLast4: string | null;
  /** The language a message would go in today: the patient's own word, else the registered one. */
  language: "hi" | "en";
  channel: "sms" | "whatsapp" | null;
  refillReminders: boolean;
  remindersConsent: { at: Date; byName: string | null; via: string } | null;
  stopped: { at: Date; byName: string | null; via: string } | null;
  bill: { state: BillMessageState; channel: string | null; at: Date | null };
};

function billStateOf(
  row: { status: string; sentChannel: string | null; nextAttemptAt: Date | null; updatedAt: Date; sentAt: Date | null } | undefined,
  provider: ProviderState,
  now: Date,
): { state: BillMessageState; channel: string | null; at: Date | null } {
  if (row === undefined) return { state: "pending", channel: null, at: null };
  switch (row.status) {
    case "queued":
      return row.nextAttemptAt !== null && row.nextAttemptAt > now
        ? { state: "held_quiet_hours", channel: null, at: row.nextAttemptAt }
        : { state: "queued", channel: null, at: null };
    case "sending": return { state: "sending", channel: null, at: null };
    case "sent": {
      const live = row.sentChannel === "sms" ? provider.sms : row.sentChannel === "whatsapp" ? provider.whatsapp : false;
      return { state: live ? "sent" : "logged_only", channel: row.sentChannel, at: row.sentAt };
    }
    case "suppressed": return { state: "suppressed", channel: null, at: row.updatedAt };
    case "expired": return { state: "expired", channel: null, at: row.updatedAt };
    default: return { state: "failed", channel: null, at: row.updatedAt };
  }
}

/** The desk's read for the patient of one dispense: their messaging word, and where this bill's message is. */
export async function patientMessagesFor(db: Db, dispenseId: string, provider: ProviderState, now: Date): Promise<PatientMessagesView> {
  const d = (await db.select({ patientId: pharmacyDispenses.patientId, status: pharmacyDispenses.status, invoiceId: pharmacyDispenses.invoiceId })
    .from(pharmacyDispenses).where(eq(pharmacyDispenses.id, dispenseId)))[0];
  if (d === undefined) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  const p = (await db.select({ phone: patients.phone, language: patients.language }).from(patients).where(eq(patients.id, d.patientId)))[0];
  const pref = await messagePreferenceOf(db, d.patientId);
  const names = await userNames(db, [pref?.remindersConsent?.by ?? null, pref?.optedOut?.by ?? null]);
  const digits = (p?.phone ?? "").replace(/\D/g, "");

  let bill: PatientMessagesView["bill"];
  if (d.status !== "handed_over" || d.invoiceId === null) bill = { state: "not_yet", channel: null, at: null };
  else {
    const row = (await db.select({ status: notifications.status, sentChannel: notifications.sentChannel, nextAttemptAt: notifications.nextAttemptAt, updatedAt: notifications.updatedAt, sentAt: notifications.sentAt })
      .from(notifications).where(eq(notifications.dedupeKey, `${PHARMACY_BILL_TEMPLATE}:${d.invoiceId}`)))[0];
    if (row === undefined && pref?.optedOut != null) bill = { state: "stopped", channel: null, at: null };
    else if (row === undefined && digits === "") bill = { state: "no_phone", channel: null, at: null };
    else bill = billStateOf(row, provider, now);
  }
  return {
    hasPhone: digits !== "",
    phoneLast4: digits === "" ? null : digits.slice(-4),
    language: (pref?.language ?? (p?.language === "en" ? "en" : "hi")),
    channel: pref?.channel ?? null,
    refillReminders: pref?.refillReminders === true && pref.optedOut === null,
    remindersConsent: consentOf(pref?.remindersConsent ?? null, names),
    stopped: consentOf(pref?.optedOut ?? null, names),
    bill,
  };
}

function consentOf(c: MessagePreference["optedOut"], names: Map<string, string>): { at: Date; byName: string | null; via: string } | null {
  return c === null ? null : { at: c.at, byName: names.get(c.by) ?? null, via: c.via };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OFFICE'S MESSAGES SIDE
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A sample the office can register on the DLT portal verbatim: each variable becomes `{#var#}`. */
function registrationText(key: string, language: "en" | "hi", sample: Record<string, unknown>): string {
  const t = templateByKey(key);
  let text = t.render[language](sample);
  for (const v of t.variables?.(sample) ?? []) text = text.replace(v, "{#var#}");
  return text;
}

const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  [PHARMACY_BILL_TEMPLATE]: { hospital: "Hospital", billNo: "PB-0001", amountPaise: 123450, paidOn: "2026-01-01" },
  [PHARMACY_REFILL_TEMPLATE]: { hospital: "Hospital", since: "2026-01-01", runsOutOn: "2026-01-31", contactPhone: "0000000000" },
};

export type MessagesOffice = {
  provider: ProviderState;
  contactPhone: string | null;
  templates: {
    key: string; purpose: "bill" | "refill"; dltTemplateId: string | null; whatsappTemplateName: string | null;
    variables: number; text: { en: string; hi: string };
  }[];
  /** The last thirty days of the pharmacy's two messages, by outcome. */
  counts: { sent: number; loggedOnly: number; queued: number; failed: number; suppressed: number; expired: number };
  patients: { remindersOn: number; stopped: number };
  /** What stands between this hospital and a message that reaches a phone, in the order to do it. */
  needs: ("provider" | "dlt_ids" | "whatsapp_names" | "contact_phone")[];
};

export const OFFICE_COUNT_DAYS = 30;

export async function messagesOffice(db: Db, provider: ProviderState, now: Date): Promise<MessagesOffice> {
  const regs = await db.select().from(notifyTemplateRegistrations).where(inArray(notifyTemplateRegistrations.templateKey, [...PHARMACY_MESSAGE_TEMPLATES]));
  const byKey = new Map(regs.map((r) => [r.templateKey, r]));
  const settings = (await db.select().from(pharmacyMessageSettings).where(eq(pharmacyMessageSettings.id, "main")))[0];
  const since = new Date(now.getTime() - OFFICE_COUNT_DAYS * 86_400_000);
  const grouped = await db.select({ status: notifications.status, channel: notifications.sentChannel, n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(inArray(notifications.templateKey, [...PHARMACY_MESSAGE_TEMPLATES]), gte(notifications.createdAt, since)))
    .groupBy(notifications.status, notifications.sentChannel);
  const counts = { sent: 0, loggedOnly: 0, queued: 0, failed: 0, suppressed: 0, expired: 0 };
  for (const g of grouped) {
    if (g.status === "sent") {
      const live = g.channel === "sms" ? provider.sms : g.channel === "whatsapp" ? provider.whatsapp : false;
      if (live) counts.sent += g.n; else counts.loggedOnly += g.n;
    } else if (g.status === "queued" || g.status === "sending") counts.queued += g.n;
    else if (g.status === "suppressed") counts.suppressed += g.n;
    else if (g.status === "expired") counts.expired += g.n;
    else counts.failed += g.n;
  }
  const [prefCounts] = await db.select({
    remindersOn: sql<number>`count(*) filter (where ${patientMessagePreferences.refillReminders} and ${patientMessagePreferences.optedOutAt} is null)::int`,
    stopped: sql<number>`count(*) filter (where ${patientMessagePreferences.optedOutAt} is not null)::int`,
  }).from(patientMessagePreferences);

  const templates = PHARMACY_MESSAGE_TEMPLATES.map((key) => {
    const r = byKey.get(key);
    const sample = SAMPLE_PARAMS[key]!;
    return {
      key, purpose: key === PHARMACY_BILL_TEMPLATE ? "bill" as const : "refill" as const,
      dltTemplateId: r?.dltTemplateId ?? null, whatsappTemplateName: r?.whatsappTemplateName ?? null,
      variables: templateByKey(key).variables?.(sample).length ?? 0,
      text: { en: registrationText(key, "en", sample), hi: registrationText(key, "hi", sample) },
    };
  });
  const needs: MessagesOffice["needs"] = [];
  if (!provider.sms && !provider.whatsapp) needs.push("provider");
  if (templates.some((t) => t.dltTemplateId === null)) needs.push("dlt_ids");
  if (provider.whatsapp && templates.some((t) => t.whatsappTemplateName === null)) needs.push("whatsapp_names");
  if (settings === undefined) needs.push("contact_phone");
  return {
    provider, contactPhone: settings?.contactPhone ?? null, templates, counts,
    patients: { remindersOn: prefCounts?.remindersOn ?? 0, stopped: prefCounts?.stopped ?? 0 }, needs,
  };
}

/** The census's two questions (`scripts/standup-check.ts`). */
export function pharmacyMessagingProviderLive(env: NodeJS.ProcessEnv = process.env): boolean {
  const live = patientMessagingLive(env);
  return live.sms || live.whatsapp;
}

export async function pharmacyDltTemplateIdsRecorded(db: Db): Promise<boolean> {
  const rows = await db.select({ key: notifyTemplateRegistrations.templateKey, dlt: notifyTemplateRegistrations.dltTemplateId })
    .from(notifyTemplateRegistrations).where(inArray(notifyTemplateRegistrations.templateKey, [...PHARMACY_MESSAGE_TEMPLATES]));
  return PHARMACY_MESSAGE_TEMPLATES.every((k) => rows.some((r) => r.key === k && r.dlt !== null && r.dlt.trim() !== ""));
}

/**
 * The pharmacy's line for the reminder's "call <number>". A mobile or a landline with its STD code —
 * 10 to 12 digits once spaces, dashes and a leading `+` are dropped. Recorded by a person.
 */
export async function recordContactPhone(tx: Tx, userId: string, phone: string, now: Date): Promise<string> {
  const typed = phone.trim();
  const digits = typed.replace(/\D/g, "");
  if (!/^[0-9+\-\s()]+$/.test(typed) || digits.length < 10 || digits.length > 12) {
    throw new PharmacyError("invalid_message_setting", "the pharmacy's phone is a mobile or a landline with its STD code — 10 to 12 digits");
  }
  await tx.insert(pharmacyMessageSettings).values({ id: "main", contactPhone: typed, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: pharmacyMessageSettings.id, set: { contactPhone: typed, updatedBy: userId, updatedAt: now } });
  return typed;
}

/** The provider state the desk and the office show, from the API's own config. */
export function providerStateOf(cfg: { notifyProvider: string; notifySms: unknown; notifyWhatsapp: unknown }): ProviderState {
  return { sms: cfg.notifyProvider === "live" && cfg.notifySms !== null, whatsapp: cfg.notifyProvider === "live" && cfg.notifyWhatsapp !== null };
}
