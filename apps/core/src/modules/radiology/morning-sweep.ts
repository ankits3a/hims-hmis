import { sendPatientReminders, sweepNoShows } from "./automation";
import { sweepRegisterCompleteness } from "./completeness";
import { sendHodDigest } from "./digest";
import type { CompletenessSweep } from "./completeness";
import type { DigestSweep } from "./digest";
import type { NoShowSweep, ReminderSweep } from "./automation";
import type { Db } from "../../kernel/db/client";

export type MorningSweep = {
  noShows: NoShowSweep | null; completeness: CompletenessSweep | null; digest: DigestSweep | null; reminders: ReminderSweep | null;
};

/**
 * #1085 (IM6c) — THE FOUR, IN THE ORDER THE DIGEST NEEDS THEM: yesterday's no-shows first (the digest
 * counts them), the registers next (the digest counts the gaps), then the HOD's digest, then the patient
 * reminders. Called from the existing 08:00 IST radiology job — no new worker job. Each is idempotent
 * per day on its own run row, and one failing never stops the next: the first failure is re-thrown at the
 * end so the scheduler's own alerting sees it.
 */
export async function runMorningSweep(db: Db, now: Date): Promise<MorningSweep> {
  const out: MorningSweep = { noShows: null, completeness: null, digest: null, reminders: null };
  let first: unknown = null;
  const step = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { first ??= e; return null; }
  };
  out.noShows = await step(() => sweepNoShows(db, now));
  out.completeness = await step(() => sweepRegisterCompleteness(db, now));
  out.digest = await step(() => sendHodDigest(db, now));
  out.reminders = await step(() => sendPatientReminders(db, now));
  if (first !== null) throw first;
  return out;
}
