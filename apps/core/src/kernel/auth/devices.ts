import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { authDevices, authSessions, users } from "../db/schema";
import type { Db } from "../db/client";

/**
 * ═══ MOBILE M6a — THE PHONES A PERSON IS SIGNED IN ON ═══
 *
 * Owner, 2026-10-06: the staff app goes to everyone at once, on PERSONAL phones, for some months.
 * A personal phone gets lost, sold, handed to a child. Before this file the only ways to end its
 * session were a password reset or deactivating the person — both of which also put the person out
 * of every counter PC. This is the narrower act: an administrator sees which phones hold a session
 * for somebody and signs ONE of them out.
 *
 * WHAT A DEVICE CLAIM IS. The app sends `{ deviceId, model, os, appVersion }` with its sign-in.
 * `deviceId` is made up by the app at install and kept in the phone's secure store. It is a LABEL:
 * the server grants nothing for it, and every field is what the phone SAYS (bounded, never trusted
 * — an admin screen renders it as text). A sign-in with no claim is a browser's, and nothing here
 * touches it.
 *
 * ONE SESSION PER PHONE. A phone that signs in again (the app was cleared, the logout never reached
 * the server) ends that phone's earlier live sessions — otherwise "signed in on 1 phone" could mean
 * three tokens.
 *
 * THE CAP (DECIDED, default 2 — mobile plan §3f). A person may hold a live session on at most
 * `PHONES_PER_USER` phones. The third phone is REFUSED after the password is verified (never
 * before: an unauthenticated caller learns nothing about anybody's phones), and the refusal says
 * which phones hold the two, so the person knows what to ask the administrator to sign out. An
 * expired session frees its place by itself (`SESSION_TTL_MINUTES`).
 */
export const PHONES_PER_USER = 2;

const label = (max: number) => z.string().trim().min(1).max(max).optional();
export const deviceClaimSchema = z.object({
  /** 16–64 of [A-Za-z0-9_-]: an identifier the app generated, never a path or a sentence. */
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  model: label(80),
  os: label(40),
  appVersion: label(40),
});
export type DeviceClaim = z.infer<typeof deviceClaimSchema>;

export type PhoneView = {
  id: string; model: string | null; osVersion: string | null; appVersion: string | null;
  firstSeenAt: Date; lastSeenAt: Date; lastIp: string | null;
  /** Mobile M6b — this phone has given the server an address for notifications. Never the address itself. */
  notifications: boolean;
  /** A live (unrevoked, unexpired) session exists on this phone; `signedInSince` is when it opened. */
  signedIn: boolean; signedInSince: Date | null;
};

/** The third phone. Carries what the refusal may say: the phones that hold the places. */
export class PhoneLimitError extends Error {
  constructor(readonly userId: string, readonly phones: { model: string | null; lastSeenAt: Date }[]) {
    super(`already signed in on ${phones.length} phones`);
  }
}

/** Every phone this person has signed in on, most recently opened first, with whether it holds a session now. */
export async function listPhones(db: Db, userId: string, now: Date = new Date()): Promise<PhoneView[]> {
  const devices = await db.select().from(authDevices).where(eq(authDevices.userId, userId)).orderBy(desc(authDevices.lastSeenAt));
  if (devices.length === 0) return [];
  const live = await db
    .select({ deviceRowId: authSessions.deviceRowId, createdAt: authSessions.createdAt })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now)));
  return devices.map((d) => {
    const mine = live.filter((s) => s.deviceRowId === d.id).map((s) => s.createdAt.getTime());
    return {
      id: d.id, model: d.model, osVersion: d.osVersion, appVersion: d.appVersion,
      firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastIp: d.lastIp,
      notifications: d.pushToken !== null,
      signedIn: mine.length > 0, signedInSince: mine.length > 0 ? new Date(Math.max(...mine)) : null,
    };
  });
}

/**
 * A verified person's phone claims its place, inside the caller's transaction and BEFORE the new
 * session exists. Returns the row the session will point at, whether the phone is new to this
 * person (`bound` — the route audits it), and the earlier live sessions of this same phone it ended.
 * Throws `PhoneLimitError` when OTHER phones already hold every place.
 */
export async function claimPhone(
  tx: Db, userId: string, claim: DeviceClaim, clientIp: string | null, now: Date = new Date(),
): Promise<{ deviceRowId: string; bound: boolean; replacedSessionIds: string[] }> {
  // Two phones signing in at the same moment must not both read "one place left": the person's row
  // is the lock, held to the end of the caller's transaction.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  const phones = await listPhones(tx, userId, now);
  const known = await tx.select({ id: authDevices.id }).from(authDevices)
    .where(and(eq(authDevices.userId, userId), eq(authDevices.deviceId, claim.deviceId)));
  const existingId = known[0]?.id ?? null;
  const others = phones.filter((p) => p.signedIn && p.id !== existingId);
  if (others.length >= PHONES_PER_USER) {
    throw new PhoneLimitError(userId, others.map((p) => ({ model: p.model, lastSeenAt: p.lastSeenAt })));
  }
  const seen = { model: claim.model ?? null, osVersion: claim.os ?? null, appVersion: claim.appVersion ?? null, lastSeenAt: now, lastIp: clientIp };
  if (existingId === null) {
    const id = newId();
    await tx.insert(authDevices).values({ id, userId, deviceId: claim.deviceId, firstSeenAt: now, ...seen });
    return { deviceRowId: id, bound: true, replacedSessionIds: [] };
  }
  await tx.update(authDevices).set(seen).where(eq(authDevices.id, existingId));
  const replaced = await tx.update(authSessions).set({ revokedAt: now })
    .where(and(eq(authSessions.deviceRowId, existingId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return { deviceRowId: existingId, bound: false, replacedSessionIds: replaced.map((r) => r.id) };
}

/**
 * ═══ M6b FIX (owner's phone, 2026-10-06) — A SESSION THAT WAS OPENED BEFORE THE APP NAMED ITS PHONE ═══
 *
 * An app updated in place keeps its session. A session opened by a build older than 0.7.0 carries
 * no phone, so the updated app's notification routes answered `not_a_phone` for up to a whole
 * session lifetime and the administrator's Phones list showed nothing for a person who was
 * visibly using the app. DECIDED: the app links its phone to the session it ALREADY holds, rather
 * than being signed out — the person proved who they are when that session was opened, the cap is
 * the same cap (`claimPhone`), and the act is evented. A session that already names a phone is
 * left exactly as it is: a session never moves from one phone to another.
 */
export async function linkSessionToPhone(
  tx: Db, session: { sessionId: string; userId: string; deviceRowId: string | null }, claim: DeviceClaim, clientIp: string | null, now: Date = new Date(),
): Promise<{ deviceRowId: string; linked: boolean; bound: boolean; replacedSessionIds: string[] }> {
  if (session.deviceRowId !== null) return { deviceRowId: session.deviceRowId, linked: false, bound: false, replacedSessionIds: [] };
  const phone = await claimPhone(tx, session.userId, claim, clientIp, now);
  await tx.update(authSessions).set({ deviceRowId: phone.deviceRowId }).where(and(eq(authSessions.id, session.sessionId), eq(authSessions.userId, session.userId)));
  return { ...phone, linked: true };
}

/** The app was opened: stamp the phone's last-seen. Cheap, and never a reason for a request to fail. */
export async function touchPhone(db: Db, deviceRowId: string, clientIp: string | null, now: Date = new Date()): Promise<void> {
  await db.update(authDevices).set({ lastSeenAt: now, ...(clientIp === null ? {} : { lastIp: clientIp }) }).where(eq(authDevices.id, deviceRowId));
}

/**
 * An administrator signs ONE phone out: every live session opened on it ends now, so the app's next
 * call is a 401 and it returns to sign-in. The phone's row stays — it is the record that this phone
 * was this person's — and the person may sign in on it again with their password; taking the
 * PASSWORD away is the reset, a different act. Returns null when the phone is not this person's.
 */
export async function signOutPhone(tx: Db, userId: string, deviceRowId: string, now: Date = new Date()): Promise<{ sessionIds: string[]; model: string | null } | null> {
  const rows = await tx.select({ id: authDevices.id, model: authDevices.model }).from(authDevices)
    .where(and(eq(authDevices.id, deviceRowId), eq(authDevices.userId, userId)));
  const phone = rows[0];
  if (phone === undefined) return null;
  const ended = await tx.update(authSessions).set({ revokedAt: now })
    .where(and(eq(authSessions.deviceRowId, deviceRowId), eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  // Mobile M6b — a signed-out phone takes no more notifications: its address goes with its session.
  await tx.update(authDevices).set({ pushToken: null, pushTokenAt: null }).where(eq(authDevices.id, deviceRowId));
  return { sessionIds: ended.map((r) => r.id), model: phone.model };
}
