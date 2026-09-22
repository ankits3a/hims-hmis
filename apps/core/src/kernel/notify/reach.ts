import { and, count, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { alerts, notifications, roleAssignments, userReachProfiles } from "../db/schema";
import { withTx } from "../db/client";
import { enqueueNotification } from "./enqueue";
import { defaultReachProfile } from "./reach-defaults";
import type { ReachChannel, ReachLanguage } from "../db/schema/reach";
import type { Db, Tx } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — THE CHANNEL LADDER: THE SAME PERSON, LOUDER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * O3 names two ladders and they are orthogonal. The ROLE ladder (T1) climbs to a HIGHER PERSON
 * at percentages of the budget. This one climbs to a LOUDER CHANNEL for the SAME person, on no
 * read and then on no acknowledgement. They never send the same fact twice to the same person
 * (S5): a role rung produces a new alert, and this job relays an alert that already exists.
 *
 * ═══ THE INPUT IS AN UNREAD ALERT, NOT AN OBLIGATION ═══
 *
 * Every rung starts from `alerts`: a row addressed to one human, already filtered by whatever
 * raised it. That keeps the job's question small — *has this person seen this yet, and how long
 * has it been?* — and means the relay cannot reach anybody the in-app surface did not.
 *
 * ═══ WHAT STOPS IT ═══
 *
 * A READ does not. `read_at` says a browser rendered the row, which is exactly the state this
 * job exists to escalate past. An ACK does: `ack_kind` is somebody saying so, and T3 made that
 * a different column for this reason. So does the alert's lane running out of rungs.
 */

/** The consumer-visible name; the scheduler registers it under this. */
export const REACH_LADDER_JOB = "runReachLadder";

/**
 * The lane an alert belongs to, derived from its KIND.
 *
 * ═══ THIS IS A STAND-IN AND IT IS MARKED AS ONE ═══
 *
 * T7 puts a real `priority_lane` on `approvals`, derived from the type's floor raised by live
 * signals, and when it lands the lane comes from the obligation rather than from the alert's
 * kind word. Until then a kind is the only lane information that exists, and inventing a
 * column here that T7 would immediately replace would be two migrations for one fact.
 */
const LANE_BY_KIND: Record<string, ReachLane> = {
  escalation: "now",
  respond_overdue: "now",
  manual_notify: "now",
  approval_requested: "today",
  operating_mode: "today",
};
export type ReachLane = "now" | "today" | "can_wait";
const DEFAULT_LANE: ReachLane = "can_wait";

/**
 * How long a lane waits before the ladder climbs one rung. The same three numbers T5 gives the
 * respond clock (Now 5, Today 30, Can wait 240), because they answer the same question: how
 * long is silence acceptable for a thing of this urgency.
 */
export const LANE_MINUTES: Record<ReachLane, number> = { now: 5, today: 30, can_wait: 240 };

/**
 * R9 — SIX INTERRUPTS PER PERSON PER HOUR, ACROSS ALL KINDS.
 *
 * The failure this exists for: five subsystems each escalating correctly, and a phone that has
 * been buzzing for twenty minutes, so the person mutes it and the sixth message — the one that
 * mattered — arrives in silence. The budget is deliberately across ALL kinds rather than per
 * kind, because the phone does not know which subsystem is calling.
 */
export const REACH_BUDGET_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;
const SHORTEST_LANE_MINUTES = 5;
/** Past this, an unanswered alert is the ageing sweep's (T10 / O14), not the relay's. */
const RELAY_HORIZON_DAYS = 7;

const RELAY_TEMPLATE_NOW = "staff_alert_relay_now";
const RELAY_TEMPLATE_LATER = "staff_alert_relay_later";
const DIGEST_TEMPLATE = "staff_alert_digest";
/**
 * The order the three relay templates declare their `channels` in. A row's `rung` is an index
 * into THIS array, not into the person's own ladder — the person's ladder decides WHICH channel
 * and this decides how the pump is told.
 *
 * ═══ ONE SEAM, NAMED RATHER THAN GUARDED ═══
 *
 * The pump climbs a row to `rung + 1` after `maxAttemptsPerRung` adapter failures, which would
 * move a relay onto a channel this job will also try, and the two could produce one duplicate.
 * It is unreachable today — WhatsApp and SMS are the console sink and never throw, and a push
 * that fails everywhere is revoked rather than retried — and it is phase P's (providers
 * go-live) to close when a real adapter can refuse. Recorded here rather than guarded, because
 * a guard for a case no test can construct is a guard nobody can check.
 */
const RELAY_CHANNEL_ORDER: readonly ReachChannel[] = ["web_push", "whatsapp", "sms"];

/** The deep link the relay carries. Relative on purpose: the body is short and the app owns the host. */
function linkFor(refType: string | null, refId: string | null): string {
  if (refType === "approval" && refId !== null) return `/approvals?focus=${refId}`;
  return "/";
}

export function laneOf(kind: string): ReachLane {
  return LANE_BY_KIND[kind] ?? DEFAULT_LANE;
}

/** The dedupe unit: one relay per (alert, channel). A second pass enqueues nothing. */
export function reachDedupeKey(alertId: string, channel: ReachChannel): string {
  return `reach:${alertId}:${channel}`;
}

type ReachProfile = { language: ReachLanguage; ladder: readonly ReachChannel[]; quietExempt: boolean };

/**
 * The person's own row if they have one, else their class's answer (census §Q.4). Read at RELAY
 * time rather than snapshotted, exactly as the pump reads contact truth at SEND time (D4): a
 * ladder edited while an alert waits is the one that gets used.
 */
export async function reachProfileFor(tx: Tx, userId: string): Promise<ReachProfile> {
  const rows = await tx
    .select({
      language: userReachProfiles.language,
      ladder: userReachProfiles.ladder,
      quietExempt: userReachProfiles.quietExempt,
    })
    .from(userReachProfiles)
    .where(eq(userReachProfiles.userId, userId));
  const own = rows[0];
  if (own !== undefined) {
    return {
      language: own.language as ReachLanguage,
      ladder: own.ladder as ReachChannel[],
      quietExempt: own.quietExempt,
    };
  }
  // Permanent assignments only. A TEMPORARY grant (`auth.temp_role.grant`) makes somebody an
  // addressee for the role's obligations (A9) but should not rewrite how they are REACHED for
  // a week — a covering cashier does not want the duty manager's night ladder.
  const roles = await tx
    .select({ roleKey: roleAssignments.roleKey })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  return defaultReachProfile(roles.map((r) => r.roleKey));
}

/**
 * How many relay messages this person has already been sent this hour. Counted from the OUTBOX
 * rather than from a counter column, so it cannot drift from what was actually enqueued, and so
 * a message that was suppressed or expired still counts as an interrupt attempted.
 */
async function interruptsThisHour(tx: Tx, userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - HOUR_MS);
  const rows = await tx
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.audience, "staff"),
        gte(notifications.createdAt, since),
      ),
    );
  return rows[0]?.n ?? 0;
}

type Candidate = {
  alertId: string;
  userId: string;
  kind: string;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
};

/**
 * ═══ THE JOB ═══
 *
 * One pass: every unacknowledged alert whose lane's minutes have elapsed, grouped by person,
 * relayed onto the first ladder channel not already enqueued for it. Returns how many rows it
 * put in the outbox, which is what the scheduler census and the tests read.
 */
export async function runReachLadder(db: Db, now: Date = new Date()): Promise<number> {
  const candidates: Candidate[] = await db
    .select({
      alertId: alerts.id,
      userId: alerts.userId,
      kind: alerts.kind,
      refType: alerts.refType,
      refId: alerts.refId,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(
      and(
        // AN ACK STOPS IT; A READ DOES NOT. That is the whole of T3's reason for being a
        // separate column, and this predicate is where it pays.
        isNull(alerts.ackKind),
        // Cheap pre-filter on the SHORTEST lane — anything younger cannot be due in any lane.
        // The per-lane test below is the real one; this one only keeps the scan small.
        lte(alerts.createdAt, new Date(now.getTime() - SHORTEST_LANE_MINUTES * 60_000)),
        // And a floor, so the job never walks the whole table: an alert nobody acknowledged for
        // a week has stopped being a nudge and is the ageing sweep's problem (T10 / O14).
        gte(alerts.createdAt, new Date(now.getTime() - RELAY_HORIZON_DAYS * 24 * HOUR_MS)),
      ),
    );

  const due = candidates.filter((c) => {
    const lane = laneOf(c.kind);
    return now.getTime() - c.createdAt.getTime() >= LANE_MINUTES[lane] * 60_000;
  });

  // Oldest first, so that when a person's budget runs out mid-pass the messages they DID get
  // are the ones that have been waiting longest.
  due.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const byUser = new Map<string, Candidate[]>();
  for (const c of due) {
    const list = byUser.get(c.userId);
    if (list === undefined) byUser.set(c.userId, [c]);
    else list.push(c);
  }

  let enqueued = 0;
  for (const [userId, items] of byUser) {
    enqueued += await withTx(db, (tx) => relayForUser(tx, userId, items, now));
  }
  return enqueued;
}

async function relayForUser(tx: Tx, userId: string, items: Candidate[], now: Date): Promise<number> {
  const profile = await reachProfileFor(tx, userId);
  if (profile.ladder.length === 0) return 0;

  let spent = profile.quietExempt ? 0 : await interruptsThisHour(tx, userId, now);
  let enqueued = 0;
  let coalesced = 0;

  for (const item of items) {
    const rung = await nextRung(tx, item.alertId, profile.ladder);
    if (rung === null) continue; // every rung of this person's ladder already tried

    /**
     * ═══ EACH RUNG WAITS THE LANE'S MINUTES AGAIN ═══
     *
     * The first draft climbed whenever the previous rung had been enqueued, which — with the
     * job on a 60-second cadence — walked a `now` alert from the browser to WhatsApp to SMS in
     * three minutes. That is not a ladder, it is a burst, and it is R9's failure arriving from
     * inside the mechanism meant to prevent it.
     *
     * So rung k is due at `created + lane minutes × (k + 1)`: five minutes of silence buys the
     * browser, ten buys WhatsApp, fifteen buys the SMS. The clock is the ALERT's, not the
     * previous message's, so a pass the worker missed does not push the whole ladder later.
     */
    const dueAfterMs = LANE_MINUTES[laneOf(item.kind)] * (rung.index + 1) * 60_000;
    if (now.getTime() - item.createdAt.getTime() < dueAfterMs) continue;
    const channel = rung.channel;

    if (!profile.quietExempt && spent >= REACH_BUDGET_PER_HOUR) {
      coalesced += 1;
      continue;
    }

    const lane = laneOf(item.kind);
    const remainingMinutes = Math.max(
      0,
      LANE_MINUTES[lane] - Math.floor((now.getTime() - item.createdAt.getTime()) / 60_000),
    );
    const inserted = await enqueueNotification(tx, {
      templateKey: lane === "now" ? RELAY_TEMPLATE_NOW : RELAY_TEMPLATE_LATER,
      // The pump picks its channel as `template.channels[row.rung]`, so the relay's choice has
      // to arrive as an INDEX into the template's own array rather than as a channel name.
      // This is where the person's ladder (which may be short, or in a different order) is
      // translated into the one the template declares.
      rung: RELAY_CHANNEL_ORDER.indexOf(channel),
      // EXACTLY FOUR PARAMS, and `kind` is the alert's kind word rather than its title: a title
      // is prose somebody wrote and prose is where a patient's name ends up (O10 / R10).
      params: {
        kind: item.kind,
        lane,
        remainingMinutes: String(remainingMinutes),
        link: linkFor(item.refType, item.refId),
      },
      dedupeKey: reachDedupeKey(item.alertId, channel),
      // THE RELAY'S OWN MINT TIME, NOT THE ALERT'S — the same anchor the digest below has
      // always used.
      //
      // `occurredAt` is the EXPIRY ANCHOR and, here, nothing else: `enqueueNotification` hands
      // it to `template.expiresAt` and stores it, and no reader reads the column back (the pump
      // claims and orders on `created_at`, and expires on `expires_at`). So anchoring on
      // `item.createdAt` gave a `now`-lane relay `alert + 2h` — for a BACKLOG alert, an instant
      // already in the past. Measured on production 2026-09-21: 28 of 28 `staff_alert_relay_now`
      // rows had `expires_at < created_at` and went straight to `expired` with attempts=0 and
      // `last_error` NULL — no adapter call, no error text — appending 28 `notification.expired`
      // events for messages nobody was ever offered. D5's "never the wall clock" is a REPLAY
      // defense, and the event replayed here is the LADDER PASS rather than the alert: a re-run
      // recomputes the same dedupe key and wins nothing, so `now` costs that defense nothing.
      //
      // IT DOES CHANGE BEHAVIOUR, for backlog only: a relay for an alert older than its
      // template's window now lives its full 2h/24h instead of arriving dead, so those messages
      // are actually attempted. WHETHER a stale obligation should relay AT ALL is the owner's
      // call and stays exactly where it already was — the selection gate above
      // (RELAY_HORIZON_DAYS, plus the per-rung lane schedule). No predicate that picks an alert
      // reads `occurredAt`, so WHICH alerts relay is unchanged; only how long the row lives is.
      occurredAt: now,
      userId,
      refType: item.refType,
      refId: item.refId,
    });
    if (inserted !== null) {
      enqueued += 1;
      spent += 1;
    }
  }

  /**
   * R9's other half: the seventh interrupt and everything after it become ONE message saying
   * how many things are waiting. It carries a COUNT and no kinds — five obligations listed by
   * kind is five leaks rather than one — and it is itself deduped per person per hour, so a
   * second pass in the same hour adds nothing.
   */
  if (coalesced > 0) {
    const hourKey = Math.floor(now.getTime() / HOUR_MS);
    const inserted = await enqueueNotification(tx, {
      templateKey: DIGEST_TEMPLATE,
      // The digest goes on the person's FIRST channel: it is the message that replaces the
      // ones the budget stopped, so it belongs where they would have gone.
      rung: RELAY_CHANNEL_ORDER.indexOf(profile.ladder[0]!),
      params: { kind: String(coalesced), lane: "digest", remainingMinutes: "0", link: "/" },
      dedupeKey: `reach-digest:${userId}:${String(hourKey)}`,
      occurredAt: now,
      userId,
    });
    if (inserted !== null) enqueued += 1;
  }

  return enqueued;
}

/**
 * The first channel of this person's ladder that has not already been enqueued for this alert.
 * `null` when every rung has been tried — the channel ladder is exhausted and the ROLE ladder
 * (T1's percent rungs) is what climbs next, which is the orthogonality O3 asks for.
 */
async function nextRung(
  tx: Tx,
  alertId: string,
  ladder: readonly ReachChannel[],
): Promise<{ channel: ReachChannel; index: number } | null> {
  const keys = ladder.map((c) => reachDedupeKey(alertId, c));
  const existing = await tx
    .select({ dedupeKey: notifications.dedupeKey })
    .from(notifications)
    .where(inArray(notifications.dedupeKey, keys));
  const taken = new Set(existing.map((r) => r.dedupeKey));
  for (const [index, channel] of ladder.entries()) {
    if (!taken.has(reachDedupeKey(alertId, channel))) return { channel, index };
  }
  return null;
}
