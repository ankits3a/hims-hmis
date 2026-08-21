import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { notifications } from "../db/schema";
import { appendEvent } from "../events/append";
import { notificationExpired } from "./events";
import { templateByKey } from "./templates";
import type { Tx } from "../db/client";

// The outbox's ONLY writer (Plan 10, D9/D13/D14). Everything that would ever message a human —
// the `kernel.notify` consumer today, the 12a digest producer later — comes through this
// function, which is why the four things it refuses live here and not in five call sites.
//
// IT TAKES A `Tx`, NOT A `Db`, DELIBERATELY: an enqueue rides the caller's transaction, so a
// module whose own write rolls back never leaves an orphan message behind, and Global
// Constraint 1 (no human flow ever blocks on the gateway) holds because the only work done here
// is one INSERT.

/**
 * The generic enqueue API (D14): audience `owner`, any template, a caller-supplied dedupe key.
 * `params` carries ONLY the producing event's payload fields (D8/N10) — this function looks
 * nothing up and renders nothing; rendering is the pump's, at send time, from contact truth
 * that does not exist yet at enqueue (D4).
 */
export type EnqueueNotificationInput = {
  templateKey: string;
  /** Exactly the payload fields the template interpolates. A paramless template passes `{}` —
   *  `notifications.params` is `jsonb NOT NULL`, so `null`/`undefined` is a constraint error. */
  params: Record<string, unknown>;
  /** The at-least-once guard (GC15). Redelivery of the same event inserts nothing (N6). */
  dedupeKey: string;
  /** The EVENT's time, never the wall clock (D5/D13) — the expiry anchor, and what makes a
   *  replayed month-old booking expire instead of sending. */
  occurredAt: Date;
  patientId?: string | null;
  userId?: string | null;
  sourceEventId?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** `null` = due immediately; the reminder sets `slotStart − 24 h` (D13). */
  scheduledFor?: Date | null;
};

/** The system actor on every event this file appends. */
const ENQUEUE_ACTOR: Actor = { type: "system", id: "notify-enqueue" };

/**
 * Enqueues one outbox row, or nothing.
 *
 * THE PROMOTIONAL REFUSAL IS THE PHASE-1 DPDP MECHANISM (D9, Assertion Book N2), and it is
 * structural on purpose: there is no opt-in check in the send path because there is nothing it
 * could correctly gate — no promotional message can exist. The shipped catalog contains zero
 * `class: "promotional"` templates, so this `throw` is unreachable from production code today;
 * that is exactly why its assertion has to register a SYNTHETIC promotional template to have
 * anything to discriminate (§2.49 — the honest pin that the catalog is empty would pass against
 * a deleted check). The CRM plan that builds promotional sending owns replacing this refusal
 * with a check against `patients.promotional_opt_in`.
 *
 * AUDIENCE/RECIPIENT COHERENCE IS ENFORCED HERE BECAUSE NOTHING ELSE ENFORCES IT. Migration
 * 0015 leaves `patient_id` and `user_id` both nullable with no CHECK tying either to
 * `audience` (schema/notifications.ts:22-27 states the trade), so an `audience='patient'` row
 * with no `patient_id` inserts fine at the DB layer and then reaches the pump, which cannot
 * send it to anybody. The narrow gate is this function.
 *
 * Returns `{ id }` when the row was inserted and `null` when the dedupe key already existed —
 * the caller learns which happened, which is what lets a consumer stay silent on redelivery.
 */
export async function enqueueNotification(
  tx: Tx,
  input: EnqueueNotificationInput,
): Promise<{ id: string } | null> {
  // Validates the template EXISTS: `templateByKey` throws on an unregistered key, and an
  // enqueue is the last moment a typo in a key is cheap — after this the row is data, and the
  // pump discovers the same typo with a human waiting on the other end.
  const template = templateByKey(input.templateKey);

  if (template.class === "promotional") {
    throw new Error(
      `enqueueNotification: template "${input.templateKey}" is class "promotional" and this ` +
        `gateway refuses promotional messages outright (Plan 10 D9 — DPDP; the CRM plan owns the ` +
        `opt-in check that replaces this refusal)`,
    );
  }

  const patientId = input.patientId ?? null;
  const userId = input.userId ?? null;
  if (template.audience === "patient") {
    if (patientId === null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is patient-audience but no patientId was given`);
    }
    if (userId !== null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is patient-audience but a userId was given`);
    }
  } else {
    if (userId === null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is ${template.audience}-audience but no userId was given`);
    }
    if (patientId !== null) {
      throw new Error(`enqueueNotification: template "${input.templateKey}" is ${template.audience}-audience but a patientId was given`);
    }
  }

  // D5: the template computes its own expiry, anchored on the message's MEANING and on the
  // EVENT's time — never on elapsed-time-since-enqueue. This is the whole replay defense and
  // the reason quiet hours compose with staleness instead of fighting it.
  const expiresAt = template.expiresAt(input.params, input.occurredAt);

  const inserted = await tx
    .insert(notifications)
    .values({
      id: newId(),
      audience: template.audience,
      patientId,
      userId,
      templateKey: input.templateKey,
      params: input.params,
      dedupeKey: input.dedupeKey,
      sourceEventId: input.sourceEventId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      occurredAt: input.occurredAt,
      expiresAt,
      scheduledFor: input.scheduledFor ?? null,
    })
    // GC15 / N6: at-least-once is the dispatcher's contract and this is how the gateway absorbs
    // it. A redelivered event re-computes the same dedupe key, wins nothing, and returns null.
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });

  return inserted[0] ?? null;
}

/**
 * Expire every still-QUEUED outbox row carrying this ref (D13) — what a reschedule or a
 * cancellation does to the confirmation and the reminder it already enqueued.
 *
 * IT IS A CONDITIONAL UPDATE OVER `status = 'queued'` ROWS ONLY, and that predicate is the
 * whole design: a `sending` row may already be at the provider and a `sent` row is already with
 * the patient — neither can be un-sent, so neither is ever touched here. `RETURNING` makes the
 * statement its own claim, so appending one `notification.expired` per WON row is idempotent
 * under the redelivery the dispatcher guarantees: a second call wins zero rows and appends
 * nothing.
 */
export async function expireByRef(
  tx: Tx,
  refType: string,
  refId: string,
  now: Date,
): Promise<number> {
  const won = await tx
    .update(notifications)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(notifications.refType, refType),
        eq(notifications.refId, refId),
        eq(notifications.status, "queued"),
      ),
    )
    .returning({
      id: notifications.id,
      templateKey: notifications.templateKey,
      audience: notifications.audience,
      patientId: notifications.patientId,
    });

  for (const row of won) {
    await appendEvent(
      tx,
      notificationExpired.make({
        actor: ENQUEUE_ACTOR,
        occurredAt: now,
        // §10.5: the envelope's own patientId column carries the linkage; the payload does not
        // duplicate it (D12).
        patientId: row.patientId ?? undefined,
        payload: {
          notificationId: row.id,
          templateKey: row.templateKey,
          audience: row.audience,
        },
      }),
    );
  }

  return won.length;
}
