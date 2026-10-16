import { and, desc, eq, lte } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { cdsDoctorPrefs, events } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { OpdError } from "./errors";
import { copilotDraftProseSet } from "./events";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #619 — DECISION 0006: THE DOCTOR'S TWO COPILOT TOGGLES, ON THE SERVER ═══
 *
 * Owner, 2026-09-17: *"it's the choice of the doctor to disable/enable the toggle to switch between
 * Proactive or ask-only"* and *"only if the doctor has enable the copilot to draft clinical prose only
 * then it will draft (confirmation/submition will always be from doctor side)"*.
 *
 *   proactive    off (default) — the copilot speaks only when asked (F2). On — it may offer the pre-read
 *                and the pending pile unasked on patient-open (brainstorm T4, not built yet).
 *   draftProse   off (default) — retrieve, check and structure only, no generated clinical sentence.
 *                On — it may draft a sentence AS A PROPOSAL; the doctor confirms and submits, always.
 *
 * DECIDED (owner's delegation, decision 0006): server-side and per user — the same answer on every
 * device — in the doctor's own `cds_doctor_prefs` row. A flip of `draftProse` appends
 * `opd.copilot_draft_prose_set`, so `copilotDraftProseAt` answers "was drafting permitted at that
 * moment?" from the record. `proactive` is UX and appends nothing.
 *
 * WHAT READS THESE TODAY: the doctor's settings card (web consult). No copilot tool drafts clinical prose
 * yet and the pre-read is not built; each, when built, must read `doctorCopilotSettings` first (and a
 * drafting tool must answer "drafting is switched off — Copilot settings" rather than degrade quietly).
 */
export type CopilotSettings = { proactive: boolean; draftProse: boolean };
export const COPILOT_DEFAULTS: CopilotSettings = { proactive: false, draftProse: false };

export async function doctorCopilotSettings(db: Db, userId: string): Promise<CopilotSettings> {
  const [row] = await db.select({ proactive: cdsDoctorPrefs.copilotProactive, draftProse: cdsDoctorPrefs.copilotDraftProse })
    .from(cdsDoctorPrefs).where(eq(cdsDoctorPrefs.userId, userId));
  return row ?? { ...COPILOT_DEFAULTS };
}

/** The doctor's own row only; nobody sets it for them. A partial change leaves the other toggle as it is. */
export async function setDoctorCopilotSettings(
  db: Db, actor: Actor, change: Partial<CopilotSettings>, now: Date = new Date(),
): Promise<CopilotSettings> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a doctor's own setting is a doctor's");
  return withTx(db, async (tx) => {
    const [row] = await tx.select().from(cdsDoctorPrefs).where(eq(cdsDoctorPrefs.userId, actor.id)).for("update");
    const before: CopilotSettings = row === undefined ? { ...COPILOT_DEFAULTS } : { proactive: row.copilotProactive, draftProse: row.copilotDraftProse };
    const after: CopilotSettings = { proactive: change.proactive ?? before.proactive, draftProse: change.draftProse ?? before.draftProse };
    await tx.insert(cdsDoctorPrefs)
      .values({ userId: actor.id, copilotProactive: after.proactive, copilotDraftProse: after.draftProse, updatedAt: now })
      .onConflictDoUpdate({ target: cdsDoctorPrefs.userId, set: { copilotProactive: after.proactive, copilotDraftProse: after.draftProse, updatedAt: now } });
    if (after.draftProse !== before.draftProse) {
      await appendEvent(tx, copilotDraftProseSet.make({
        actor, occurredAt: now,
        payload: { userId: actor.id, draftProse: after.draftProse, previous: before.draftProse },
      }));
    }
    return after;
  });
}

/** Was the copilot permitted to draft clinical prose for this doctor at `at`? The newest flip at or before it; none ⇒ the default, off. */
export async function copilotDraftProseAt(db: Db, userId: string, at: Date): Promise<boolean> {
  const rows = await db.select({ payload: events.payload, occurredAt: events.occurredAt }).from(events)
    .where(and(eq(events.name, copilotDraftProseSet.name), eq(events.actorId, userId), lte(events.occurredAt, at)))
    .orderBy(desc(events.occurredAt), desc(events.seq)).limit(1);
  const p = rows[0]?.payload as { draftProse?: boolean } | undefined;
  return p?.draftProse ?? COPILOT_DEFAULTS.draftProse;
}
