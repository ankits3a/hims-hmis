import { and, desc, eq, gt, gte, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { authDevices, authSessions, phonePushSends } from "../db/schema";
import type { Db } from "../db/client";
import type { PhoneMessage, PhonePushSender } from "./fcm";

/**
 * ═══ MOBILE M6b — A NOTIFICATION ON A STAFF PHONE ═══
 *
 * Owner, 2026-10-06 (delegated: "go with your recommendations"): notifications go through FCM, and
 * the payload carries NO patient text — a bare "open HMIS" notice with a category and a key that
 * says which screen to open.
 *
 * THE FEED IS THE BELL. Every row the web bell shows (`alerts`) is raised with `alert.raised`; this
 * relays that one fact to the person's signed-in phones, at once. It is the phone's bell, not a
 * rung of the reach ladder (`notify/reach.ts` climbs to louder channels after minutes of silence —
 * a different question, untouched here).
 *
 * WHO GETS ONE. A phone that (a) holds a LIVE session for the alert's person, (b) has given the
 * server an address, and (c) has not switched that category off. (a) is the rule that makes "signed
 * out" mean "silent" without anybody remembering to delete anything: an administrator's sign-out,
 * a deactivation, a password reset and an expired session all end the session, and a phone with no
 * session is not asked. The address is ALSO cleared on the acts that name a phone (logout, "sign
 * out this phone") and on deactivation and reset — the query is the guard, the clearing is hygiene.
 */

export const PUSH_CATEGORIES = ["alert", "roster", "queue", "reminder", "approvals"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/**
 * The categories something RAISES today — the phone is told this list and offers a switch only for
 * these, so nobody is shown a switch that controls nothing. §3i (2026-10-07) made all four live:
 * `queue` ("patients are waiting and you are not in") and `reminder` (a duty an hour / twelve hours
 * ahead) now have alert kinds behind them.
 *
 * `reminder` IS ITS OWN SWITCH, NOT A FIFTH THING UNDER `roster`: a daily "your duty starts at
 * 09:00" is the first notification a person will want gone, and the only switch that silenced it
 * must not also silence "a colleague asks you to cover tonight".
 */
export const LIVE_PUSH_CATEGORIES: readonly PushCategory[] = ["alert", "roster", "queue", "reminder", "approvals"];

/**
 * A build older than this knows three categories and would draw `reminder` as a raw key. It is
 * simply not offered that switch (it still RECEIVES reminders, on the default channel, and its
 * banner calls an unknown category an alert — `notifications.tsx`).
 */
export const REMINDER_CATEGORY_SINCE = "0.10.0";
function atLeast(version: string | null, floor: string): boolean {
  if (version === null) return false;
  const [a, b] = [version, floor].map((v) => v.split(".").map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i += 1) { if ((a![i] ?? 0) !== (b![i] ?? 0)) return (a![i] ?? 0) > (b![i] ?? 0); }
  return true;
}
export function categoriesFor(appVersion: string | null): readonly PushCategory[] {
  /* `approvals` is offered only to a phone that SAYS it knows it (`knownTo`): no build number separates the ones that do. */
  const byVersion = LIVE_PUSH_CATEGORIES.filter((c) => c !== "approvals");
  return atLeast(appVersion, REMINDER_CATEGORY_SINCE) ? byVersion : byVersion.filter((c) => c !== "reminder");
}
/**
 * App home round 2 — the phone names the categories it can draw (`?knows=a,b`), and is offered the
 * live ones among them. A build that says nothing gets the list its version earned, as before; so an
 * older app never sees a switch it would print as a raw key, and no version constant has to be
 * guessed for a build another session cuts.
 */
export function knownTo(appVersion: string | null, knows: string | undefined): readonly PushCategory[] {
  if (knows === undefined || knows.trim() === "") return categoriesFor(appVersion);
  const said = new Set(knows.split(",").map((k) => k.trim()));
  return LIVE_PUSH_CATEGORIES.filter((c) => said.has(c));
}

/**
 * ═══ A FLAG IS NEVER STARVED BY A REMINDER ═══
 *
 * Twelve an hour is one budget across every kind, because the phone does not know which subsystem
 * is calling. But two of the four categories repeat on a clock (`reminder`, `queue`), and a doctor
 * who is out with a full line could spend the hour's twelve on "patients are waiting" and then not
 * hear "the roster is wrong, you are on call NOW". So the clock-driven categories may use only the
 * first `PUSH_PER_USER_PER_HOUR - PUSH_RESERVED_FOR_ASKS`; the rest is kept for `alert` and `roster`.
 */
export const PUSH_RESERVED_FOR_ASKS = 4;
const CLOCK_DRIVEN: readonly PushCategory[] = ["queue", "reminder"];

/** Which screen a tap opens. Closed vocabulary; the app maps a word it knows and goes home on one it does not. */
export const PUSH_LINKS = ["home", "onNow", "myDuties", "consult", "approvals", "attendance", "attendanceRequests"] as const;
export type PushLink = (typeof PUSH_LINKS)[number];

/** R9's cousin: a phone that buzzes all hour gets muted, and then the one that mattered is silent. */
export const PUSH_PER_USER_PER_HOUR = 12;

/** FCM registration tokens are URL-safe text; this bounds what a phone may hand us, it does not validate it. */
export const pushTokenSchema = z.string().regex(/^[A-Za-z0-9_:.-]{32,4096}$/);
export const pushLanguageSchema = z.enum(["en", "hi"]);
export const pushMutedSchema = z.array(z.enum(PUSH_CATEGORIES)).max(PUSH_CATEGORIES.length);

/**
 * An alert's kind → the category the phone files it under and the screen a tap opens. A kind this
 * table does not know is an `alert` that opens the home screen: a new alert kind reaches phones the
 * day it is added, generically, and gets a better door when somebody gives it one.
 */
const BY_ALERT_KIND: Record<string, { category: PushCategory; link: PushLink }> = {
  roster_flag: { category: "roster", link: "onNow" },
  // §3i — a person's own duties open My duties, where the request is answered and the roster read.
  roster_cover_asked: { category: "roster", link: "myDuties" },
  roster_cover_answered: { category: "roster", link: "myDuties" },
  roster_cover_decided: { category: "roster", link: "myDuties" },
  roster_duty_changed: { category: "roster", link: "myDuties" },
  roster_month_published: { category: "roster", link: "myDuties" },
  roster_duty_reminder: { category: "reminder", link: "myDuties" },
  // §3i — the doctor's own line.
  opd_not_in: { category: "queue", link: "consult" },
  opd_long_wait: { category: "queue", link: "consult" },
  approval_overdue: { category: "approvals", link: "approvals" },
  // STAFF ATTENDANCE (owner 2026-10-09) — a meeting request opens the committee's requests list; "your
  // request was closed" opens the person's own attendance. Filed under the general switch: an app
  // that does not know these two words lands on home, as for any word it does not know.
  attendance_meeting_request: { category: "alert", link: "attendanceRequests" },
  attendance_request_closed: { category: "alert", link: "attendance" },
};
export function routeOfAlertKind(kind: string): { category: PushCategory; link: PushLink } {
  return BY_ALERT_KIND[kind] ?? { category: "alert", link: "home" };
}

/**
 * ═══ WHAT A PHONE IS TOLD — AND THE WHOLE OF IT ═══
 *
 * A lock screen is read by whoever is holding the phone, and these are personal phones. So the
 * sentence is chosen from THIS table by category and language and from nothing else: the function
 * takes no alert, no title, no body, no ref — there is no argument through which a patient's name,
 * a UHID or a finding could arrive. `phone-push.test.ts` pins the output shape.
 */
const SENTENCES: Record<PushCategory | "test", Record<"en" | "hi", string>> = {
  alert: { en: "Something needs you. Open HMIS to see it.", hi: "कुछ आपका ध्यान चाहता है। देखने के लिए HMIS खोलें।" },
  roster: { en: "The duty board needs you. Open HMIS to see it.", hi: "ड्यूटी बोर्ड पर आपकी ज़रूरत है। देखने के लिए HMIS खोलें।" },
  queue: { en: "Your OPD queue needs you. Open HMIS to see it.", hi: "आपकी ओपीडी कतार को आपकी ज़रूरत है। देखने के लिए HMIS खोलें।" },
  reminder: { en: "You have a duty coming up. Open HMIS to see it.", hi: "आपकी ड्यूटी आने वाली है। देखने के लिए HMIS खोलें।" },
  approvals: { en: "An approval is waiting past its time. Open HMIS to decide it.", hi: "एक मंज़ूरी समय से ज़्यादा देर से रुकी है। तय करने के लिए HMIS खोलें।" },
  test: { en: "Test — this phone can receive HMIS notifications.", hi: "जाँच — यह फ़ोन HMIS की सूचनाएँ पा सकता है।" },
};
export function phoneMessage(category: PushCategory | "test", link: PushLink, language: string): PhoneMessage {
  const lang = language === "hi" ? "hi" : "en";
  return { title: "HMIS", body: SENTENCES[category][lang], data: { category: category === "test" ? "alert" : category, link } };
}

export type PushState = {
  /** The server has a Firebase key and can send at all. */
  configured: boolean;
  /** This phone has given an address. */
  registered: boolean;
  muted: PushCategory[];
  categories: readonly PushCategory[];
  /** For the phone's own diagnosis: when it last handed its address over, and when the server last sent it anything / a test. Instants only. */
  addressAt: string | null;
  lastSentAt: string | null;
  lastTestAt: string | null;
};

export async function pushStateOf(db: Db, deviceRowId: string, configured: boolean, knows?: string): Promise<PushState> {
  const rows = await db.select({ token: authDevices.pushToken, muted: authDevices.pushMuted, at: authDevices.pushTokenAt, appVersion: authDevices.appVersion }).from(authDevices).where(eq(authDevices.id, deviceRowId));
  const row = rows[0];
  const muted = (row?.muted ?? []).filter((m): m is PushCategory => (PUSH_CATEGORIES as readonly string[]).includes(m));
  const sends = await db.select({ category: phonePushSends.category, at: phonePushSends.createdAt }).from(phonePushSends)
    .where(and(eq(phonePushSends.deviceRowId, deviceRowId), eq(phonePushSends.outcome, "sent"))).orderBy(desc(phonePushSends.createdAt)).limit(50);
  const iso = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString());
  return {
    configured, registered: row?.token != null, muted, categories: knownTo(row?.appVersion ?? null, knows),
    addressAt: iso(row?.at), lastSentAt: iso(sends[0]?.at), lastTestAt: iso(sends.find((s) => s.category === "test")?.at),
  };
}

/**
 * The phone hands over (or refreshes) its address. ONE PHONE, ONE ROW: the same address on any
 * other row is cleared in the same statement pair — a phone that was reinstalled, or handed to a
 * colleague who signed in on it, must not go on receiving for the row it used to be.
 */
export async function registerPushToken(db: Db, deviceRowId: string, token: string, now: Date = new Date()): Promise<void> {
  await db.update(authDevices).set({ pushToken: null, pushTokenAt: null }).where(and(eq(authDevices.pushToken, token), ne(authDevices.id, deviceRowId)));
  await db.update(authDevices).set({ pushToken: token, pushTokenAt: now }).where(eq(authDevices.id, deviceRowId));
}

export async function setPushPreferences(db: Db, deviceRowId: string, prefs: { muted?: PushCategory[]; language?: "en" | "hi" }): Promise<void> {
  const set: { pushMuted?: string[]; pushLanguage?: string } = {};
  if (prefs.muted !== undefined) set.pushMuted = [...new Set(prefs.muted)];
  if (prefs.language !== undefined) set.pushLanguage = prefs.language;
  if (Object.keys(set).length === 0) return;
  await db.update(authDevices).set(set).where(eq(authDevices.id, deviceRowId));
}

/** This phone takes no more notifications (the person switched them off, or signed out of it). */
export async function clearPushToken(db: Db, deviceRowId: string): Promise<void> {
  await db.update(authDevices).set({ pushToken: null, pushTokenAt: null }).where(eq(authDevices.id, deviceRowId));
}

/** Every phone of this person forgets its address (deactivated, or the password was reset). */
export async function clearPushTokensOfUser(db: Db, userId: string): Promise<void> {
  await db.update(authDevices).set({ pushToken: null, pushTokenAt: null }).where(and(eq(authDevices.userId, userId), isNotNull(authDevices.pushToken)));
}

type Recipient = { deviceRowId: string; token: string; language: string; muted: string[] };

/** The phones of `userId` that hold a LIVE session and an address. The session join is the guard (see the header). */
async function livePhonesOf(db: Db, userId: string, now: Date): Promise<Recipient[]> {
  const rows = await db
    .selectDistinct({ deviceRowId: authDevices.id, token: authDevices.pushToken, language: authDevices.pushLanguage, muted: authDevices.pushMuted })
    .from(authDevices)
    .innerJoin(authSessions, eq(authSessions.deviceRowId, authDevices.id))
    .where(and(
      eq(authDevices.userId, userId), isNotNull(authDevices.pushToken),
      eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now),
    ));
  return rows.flatMap((r) => (r.token === null ? [] : [{ deviceRowId: r.deviceRowId, token: r.token, language: r.language, muted: r.muted }]));
}

async function sentInLastHour(db: Db, userId: string, now: Date): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(phonePushSends)
    .where(and(eq(phonePushSends.userId, userId), eq(phonePushSends.outcome, "sent"), gte(phonePushSends.createdAt, new Date(now.getTime() - 60 * 60 * 1000))));
  return rows[0]?.n ?? 0;
}

async function record(db: Db, row: { userId: string; deviceRowId: string; alertId: string | null; category: string; outcome: "sent" | "gone" }, now: Date): Promise<void> {
  await db.insert(phonePushSends).values({ id: newId(), ...row, createdAt: now }).onConflictDoNothing();
}

export type RelayResult = { sent: number; gone: number; skipped: number; limited: boolean };

/**
 * One alert, relayed to its person's phones. Safe to run again for the same alert: a phone that
 * already has its row is skipped, so a retry after a half-finished run sends only what is missing.
 * A transient refusal from FCM is THROWN after the other phones have been tried — the dispatcher's
 * backoff is the retry (`events/dispatcher.ts`, five attempts), and this function adds none of its own.
 */
export async function relayAlertToPhones(
  db: Db, sender: PhonePushSender, alert: { id: string; userId: string; kind: string }, now: Date = new Date(),
): Promise<RelayResult> {
  const { category, link } = routeOfAlertKind(alert.kind);
  const phones = (await livePhonesOf(db, alert.userId, now)).filter((p) => !p.muted.includes(category));
  const result: RelayResult = { sent: 0, gone: 0, skipped: 0, limited: false };
  if (phones.length === 0) return result;
  const done = await db.select({ deviceRowId: phonePushSends.deviceRowId }).from(phonePushSends).where(eq(phonePushSends.alertId, alert.id));
  let budget = PUSH_PER_USER_PER_HOUR - (CLOCK_DRIVEN.includes(category) ? PUSH_RESERVED_FOR_ASKS : 0) - (await sentInLastHour(db, alert.userId, now));
  let failure: unknown = null;
  for (const phone of phones) {
    if (done.some((d) => d.deviceRowId === phone.deviceRowId)) { result.skipped += 1; continue; }
    if (budget <= 0) { result.limited = true; result.skipped += 1; continue; }
    try {
      const outcome = await sender.send(phone.token, phoneMessage(category, link, phone.language));
      if (outcome === "gone") {
        await clearPushToken(db, phone.deviceRowId);
        result.gone += 1;
      } else {
        result.sent += 1;
        budget -= 1;
      }
      await record(db, { userId: alert.userId, deviceRowId: phone.deviceRowId, alertId: alert.id, category, outcome }, now);
    } catch (e) {
      failure = e;
    }
  }
  if (failure !== null) throw failure instanceof Error ? failure : new Error("phone push: send failed");
  return result;
}

export type TestPushOutcome = "sent" | "gone" | "no_address" | "not_signed_in" | "not_configured" | "failed";

/** An administrator's "send a test" to ONE phone: the generic test sentence, recorded with no alert. */
export async function sendTestPush(db: Db, sender: PhonePushSender | null, userId: string, deviceRowId: string, now: Date = new Date()): Promise<TestPushOutcome | null> {
  const owned = await db.select({ id: authDevices.id, token: authDevices.pushToken }).from(authDevices)
    .where(and(eq(authDevices.id, deviceRowId), eq(authDevices.userId, userId)));
  if (owned[0] === undefined) return null;
  if (sender === null) return "not_configured";
  if (owned[0].token === null) return "no_address";
  const phone = (await livePhonesOf(db, userId, now)).find((p) => p.deviceRowId === deviceRowId);
  if (phone === undefined) return "not_signed_in";
  try {
    const outcome = await sender.send(phone.token, phoneMessage("test", "home", phone.language));
    if (outcome === "gone") await clearPushToken(db, deviceRowId);
    await record(db, { userId, deviceRowId, alertId: null, category: "test", outcome }, now);
    return outcome;
  } catch {
    return "failed";
  }
}
