import { and, eq, isNull } from "drizzle-orm";
import { pushSubscriptions, userReachProfiles } from "../db/schema";
import { reachProfileFor } from "./reach";
import type { ReachChannel, ReachLanguage } from "../db/schema/reach";
import type { Tx } from "../db/client";

/**
 * ═══ PHASE O T4 — THE ONE SCREEN A PERSON HAS OVER THEIR OWN REACH ═══
 *
 * `/me/reach`. What it can change is deliberately small: the language they are written to in,
 * the order their channels are tried, and whether this browser may push. What it cannot change
 * is anything that is a fact about the HOSPITAL rather than a preference — `quiet_exempt` is a
 * seat (R9's two), `shared_phone` is a handset the roster knows about (R1), and `consent_at` is
 * captured at onboarding with its wording (R2) rather than toggled on a settings page.
 */
export type ReachSettings = {
  language: ReachLanguage;
  ladder: readonly ReachChannel[];
  quietExempt: boolean;
  sharedPhone: boolean;
  consentAt: Date | null;
  /** True when these values come from the person's own row rather than their class's default. */
  isOwnProfile: boolean;
  /** One entry per browser that has granted permission and not been revoked. */
  pushSubscriptions: { id: string; endpoint: string; userAgent: string | null; createdAt: Date }[];
  /**
   * The VAPID public key the browser needs to subscribe, or NULL when push is on the console
   * sink. It is served from here rather than baked into the bundle at build time because it is
   * a DEPLOYMENT fact: the same build runs at a hospital that has generated keys and one that
   * has not, and a null here is how the page says "push is not configured" instead of failing
   * at the moment somebody taps the button.
   *
   * Public by construction — it is the key browsers are given — so no permission gates it.
   */
  vapidPublicKey: string | null;
};

export async function readReachSettings(
  tx: Tx,
  userId: string,
  vapidPublicKey: string | null = null,
): Promise<ReachSettings> {
  const own = await tx
    .select()
    .from(userReachProfiles)
    .where(eq(userReachProfiles.userId, userId));
  const row = own[0];
  const effective = await reachProfileFor(tx, userId);
  const subs = await tx
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));

  return {
    language: effective.language,
    ladder: effective.ladder,
    quietExempt: effective.quietExempt,
    sharedPhone: row?.sharedPhone ?? false,
    consentAt: row?.consentAt ?? null,
    isOwnProfile: row !== undefined,
    pushSubscriptions: subs,
    vapidPublicKey,
  };
}

/**
 * Upsert on the person's own row. The FIRST save is what turns a class default into a personal
 * one, and it copies the class's answer for whatever the person did not send — so a person who
 * only changes their language does not silently inherit `DEFAULT_REACH_LADDER` over a class
 * ladder that was shorter on purpose.
 */
export async function saveReachProfile(
  tx: Tx,
  userId: string,
  input: { language?: ReachLanguage; ladder?: readonly ReachChannel[] },
  vapidPublicKey: string | null = null,
): Promise<ReachSettings> {
  const effective = await reachProfileFor(tx, userId);
  const language = input.language ?? effective.language;
  const ladder = [...(input.ladder ?? effective.ladder)];

  await tx
    .insert(userReachProfiles)
    .values({
      userId, language, ladder,
      // Neither is settable here; on a first save they take the value the class implies, and a
      // hospital fact about the seat or the handset overwrites them elsewhere.
      quietExempt: effective.quietExempt,
      createdBy: userId, updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: userReachProfiles.userId,
      // `quiet_exempt` is deliberately NOT in the update set: a person may not exempt
      // themselves from the interrupt budget by saving their language.
      set: { language, ladder, updatedAt: new Date(), updatedBy: userId },
    });

  return readReachSettings(tx, userId, vapidPublicKey);
}

/**
 * ═══ ONE ENDPOINT, ONE ROW, WHOEVER IS SIGNED IN ═══
 *
 * `endpoint` is UNIQUE across the table rather than per user, because the browser mints it and
 * two people signing into one machine produce two different endpoints. The same endpoint
 * arriving for a SECOND user therefore means the first signed out of that browser — so the row
 * moves to the new person and un-revokes, rather than a second row being created that would
 * keep pushing the first person's obligations to a machine somebody else is now using.
 */
export async function subscribeToPush(
  tx: Tx,
  userId: string,
  sub: { id: string; endpoint: string; p256dh: string; auth: string; userAgent?: string },
): Promise<{ subscriptionId: string }> {
  const rows = await tx
    .insert(pushSubscriptions)
    .values({
      id: sub.id, userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth,
      userAgent: sub.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId, p256dh: sub.p256dh, auth: sub.auth, userAgent: sub.userAgent ?? null,
        revokedAt: null,
      },
    })
    .returning({ id: pushSubscriptions.id });
  return { subscriptionId: rows[0]!.id };
}

/**
 * The person turning push OFF in their own browser. Scoped to their own rows: revoking by
 * endpoint alone would let anybody who learned an endpoint silence somebody else.
 */
export async function unsubscribeFromPush(
  tx: Tx,
  userId: string,
  endpoint: string,
  now: Date = new Date(),
): Promise<{ revoked: number }> {
  const revoked = await tx
    .update(pushSubscriptions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.userId, userId),
        isNull(pushSubscriptions.revokedAt),
      ),
    )
    .returning({ id: pushSubscriptions.id });
  return { revoked: revoked.length };
}
