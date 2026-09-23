import { and, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdEncounters } from "../../kernel/db/schema";
import { requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ D17 — THE EDIT LEASE: ONE TAB WRITES A CONSULTATION AT A TIME (owner, 2026-09-23) ═══
 *
 * Each tab that opens a consultation mints a random token and asks for the lease. It gets it when nobody
 * holds it, when the holder's lease has lapsed, or when the tab already holds it (the heartbeat). Anyone
 * else is told who holds it and until when, and is read-only until they TAKE OVER — which is always
 * allowed to the treating doctor, because the other tab is theirs, and is recorded: who, when, and which
 * token lost the lease. `saveConsultNote` refuses a note that names a token which does not hold the lease.
 *
 * Only the encounter's own treating doctor may hold a lease, in an open consultation — the same person
 * and the same state the note itself requires.
 */
export const LEASE_SECONDS = 45;

export type LeaseAnswer = { held: boolean; until: string | null; holderIsMe: boolean; tookOver: boolean };

export async function acquireEditLease(
  db: Db, actor: Actor, encounterId: string, token: string, opts: { takeover?: boolean } = {}, now: Date = new Date(),
): Promise<LeaseAnswer> {
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, enc);
  if (enc.status !== "in_consultation") throw new OpdError("encounter_state_conflict", `a lease needs in_consultation, not ${enc.status}`);
  return withTx(db, async (tx) => {
    const [row] = await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update");
    const live = row!.editLeaseToken !== null && row!.editLeaseUntil !== null && row!.editLeaseUntil.getTime() > now.getTime();
    const mine = live && row!.editLeaseToken === token;
    const until = new Date(now.getTime() + LEASE_SECONDS * 1000);
    if (live && !mine && opts.takeover !== true) {
      return { held: false, until: row!.editLeaseUntil!.toISOString(), holderIsMe: false, tookOver: false };
    }
    const tookOver = live && !mine;
    const takeovers = Array.isArray(row!.editTakeovers) ? (row!.editTakeovers as unknown[]) : [];
    await tx.update(opdEncounters).set({
      editLeaseToken: token, editLeaseBy: actor.id, editLeaseUntil: until,
      ...(tookOver ? { editTakeovers: [...takeovers, { by: actor.id, at: now.toISOString(), fromToken: row!.editLeaseToken }] } : {}),
    }).where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.status, "in_consultation")));
    return { held: true, until: until.toISOString(), holderIsMe: true, tookOver };
  });
}

/** Let go when the tab closes, so the next tab need not wait out the heartbeat. Only the holder can release. */
export async function releaseEditLease(db: Db, actor: Actor, encounterId: string, token: string): Promise<{ released: boolean }> {
  const rows = await db.update(opdEncounters)
    .set({ editLeaseToken: null, editLeaseBy: null, editLeaseUntil: null })
    .where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.editLeaseToken, token), eq(opdEncounters.editLeaseBy, actor.id)))
    .returning({ id: opdEncounters.id });
  return { released: rows.length > 0 };
}
