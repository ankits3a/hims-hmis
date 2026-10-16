import { and, eq, inArray, sql } from "drizzle-orm";
import { ER_AGE_BAND_INFO } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { ER_OPEN_STATE_VALUES, erEpisodes } from "../../kernel/db/schema";
import { WorkflowError, transition } from "../../kernel/workflow/instances";
import { withIdempotency } from "../billing";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { ErError, ErRefusal } from "./errors";
import type { Actor, ErAgeBand, ErEpisodeState, ErIntentName } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ER lane 1 (#808) — THE EPISODE ROW'S SHARED HELPERS: permission, idempotency, the ER number and the alias, the lock,
 * the move (workflow instance and mirror together), and the patient's identity through the merge chain.
 *
 * LOCK ORDER: every act on an episode first takes the episode's transaction-scoped advisory lock, then the row FOR
 * UPDATE, then the band register. Registration takes the PATIENT's advisory lock first (`erPatientLock`), so two desks
 * registering one person race on it and the partial unique index is only the backstop.
 */
export type EpisodeRow = typeof erEpisodes.$inferSelect;

export function provenanceOf(actor: Actor): "person" | "agent" | "system" {
  if (actor.type === "agent") return "agent";
  if (actor.type === "system") return "system";
  return "person";
}

export async function requireErPermission(db: Db, actor: Actor, permission: string): Promise<void> {
  if (actor.type === "system") return;
  if (!(await hasPermission(db, actor.id, permission, "hospital"))) {
    throw new ErError("er_forbidden", `this act needs the permission ${permission}`, { permission });
  }
}

/** The contract's idempotency key scopes the act: a retry with the same key and body answers the first result. */
export function onceEr<T>(db: Db, actor: Actor, intent: ErIntentName, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `er:${intent}`, key: key.toLowerCase() }, body, work, now);
}

export const lockKey = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

export async function erPatientLock(tx: Tx, patientId: string): Promise<void> {
  await lockKey(tx, `er_patient:${patientId}`);
}

export async function lockEpisode(tx: Tx, episodeId: string): Promise<EpisodeRow> {
  await lockKey(tx, `er_episode:${episodeId}`);
  const row = (await tx.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)).for("update"))[0];
  if (row === undefined) throw new ErRefusal("episode_not_found");
  return row;
}

export async function readEpisode(db: Db | Tx, episodeId: string): Promise<EpisodeRow> {
  const row = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (row === undefined) throw new ErRefusal("episode_not_found");
  return row;
}

/**
 * The person behind a record: the canonical record (through the merge chain) and every record merged into it. A merge
 * of an unknown into the true record therefore carries the unknown's episode — it is found under the true record, and
 * the one-open-episode rule holds for the PERSON, not the row.
 */
export async function personRecords(db: Db | Tx, patientId: string): Promise<{ canonicalId: string; ids: string[] } | null> {
  const canonicalId = await resolvePatientId(db, patientId);
  if (canonicalId === null) return null;
  return { canonicalId, ids: [canonicalId, ...(await listMergedLoserIds(db, canonicalId))] };
}

/** The person's open episode (any record of theirs), if any. */
export async function openEpisodeOf(db: Db | Tx, ids: readonly string[]): Promise<EpisodeRow | undefined> {
  if (ids.length === 0) return undefined;
  return (await db.select().from(erEpisodes).where(and(
    inArray(erEpisodes.patientId, [...ids]), inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES]),
  )))[0];
}

/** The refusal that shows the first episode (spec §4.1: "second refused, shows the first"). */
export function alreadyOpen(first: EpisodeRow): ErRefusal {
  return new ErRefusal("episode_already_open", {
    episodeId: first.id, episodeNo: first.episodeNo, state: first.state, arrivedAt: first.arrivedAt.toISOString(),
  });
}

export function isOpenEpisodeRace(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = err.cause ?? err;
  return c.code === "23505" && c.constraint === "er_episodes_open_patient_ux";
}

/** Moves the workflow instance AND the mirror in the caller's transaction; engine refusals become ER words. */
export async function moveEpisode(tx: Tx, actor: Actor, e: EpisodeRow, to: ErEpisodeState, at: Date, set: Partial<EpisodeRow> = {}): Promise<void> {
  try {
    await transition(tx, e.workflowInstanceId, to, actor, {});
  } catch (err) {
    throw workflowRefusal(err);
  }
  const done = await tx.update(erEpisodes).set({ ...set, state: to, updatedAt: at })
    .where(and(eq(erEpisodes.id, e.id), eq(erEpisodes.state, e.state)))
    .returning({ id: erEpisodes.id });
  if (done.length === 0) throw new ErRefusal("state_changed");
}

export function workflowRefusal(e: unknown): unknown {
  if (!(e instanceof WorkflowError)) return e;
  if (e.code === "role_denied") return new ErError("er_forbidden", e.message, { workflow: "role_denied" });
  if (e.code === "stale_transition") return new ErRefusal("state_changed");
  if (e.code === "unknown_transition" || e.code === "instance_not_active") return new ErRefusal("episode_wrong_state");
  if (e.code === "no_active_definition") {
    return new ErError("er_workflow_inactive", "the emergency episode workflow is not active yet: a go-live step activates it");
  }
  return e;
}

/** IST calendar year of an instant (the ER number and the alias restart every IST year). */
export function istYear(at: Date): number {
  return Number(istDayString(at).slice(0, 4));
}

/**
 * The ER number: `ER` + two-digit year + `-` + a six-digit serial that restarts every IST year (`ER26-000123`), the IP
 * number's grammar. Serialised by a transaction-scoped advisory lock on the year; the unique index is the backstop.
 */
export async function mintEpisodeNo(tx: Tx, at: Date): Promise<{ year: number; serial: number; episodeNo: string }> {
  const year = istYear(at);
  await lockKey(tx, `er_episode_no:${String(year)}`);
  const rows = (await tx.execute(sql`
    select coalesce(max(episode_serial), 0) + 1 as next from er_episodes where episode_year = ${year}
  `)).rows as { next: number | string }[];
  const serial = Number(rows[0]!.next);
  return { year, serial, episodeNo: `ER${String(year % 100).padStart(2, "0")}-${String(serial).padStart(6, "0")}` };
}

/**
 * The unidentified patient's alias: `Unknown-0412` / `अज्ञात-0412`, a four-digit serial per IST year (five digits past
 * 9999). Two unknowns registered in the same minute get two serials: the year lock serialises them.
 */
export async function mintAlias(tx: Tx, at: Date): Promise<{ year: number; serial: number; alias: string; aliasHi: string }> {
  const year = istYear(at);
  await lockKey(tx, `er_alias:${String(year)}`);
  const rows = (await tx.execute(sql`
    select coalesce(max(alias_serial), 0) + 1 as next from er_episodes where alias_year = ${year}
  `)).rows as { next: number | string }[];
  const serial = Number(rows[0]!.next);
  return { year, serial, ...aliasWords(serial) };
}

export function aliasWords(serial: number): { alias: string; aliasHi: string } {
  const n = String(serial).padStart(4, "0");
  return { alias: `Unknown-${n}`, aliasHi: `अज्ञात-${n}` };
}

/** The Hindi alias of an alias row (`Unknown-0412` → `अज्ञात-0412`); null for a named patient. */
export function aliasHiOf(alias: string | null): string | null {
  return alias === null ? null : alias.replace(/^Unknown-/, "अज्ञात-");
}

/** "~30 y" from the band, or "42 y" from a recorded date of birth; "?" when neither is known. */
export function ageWords(ageYears: number | null, band: ErAgeBand | null): string {
  if (ageYears !== null) return `${String(ageYears)} y`;
  if (band !== null) return band === "infant" ? "<1 y" : `~${String(ER_AGE_BAND_INFO[band].approxYears)} y`;
  return "?";
}

/** Whole years between a date of birth and `at` (null without a DOB). */
export function yearsOld(dob: Date | null, at: Date): number | null {
  if (dob === null) return null;
  let y = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) y -= 1;
  return Math.max(0, y);
}
