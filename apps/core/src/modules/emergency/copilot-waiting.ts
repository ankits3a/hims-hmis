import { and, eq, inArray, isNull } from "drizzle-orm";
import { ER_STAGE_WORDS_HI } from "@hmis/contracts";
import { ER_OPEN_STATE_VALUES, erEpisodes, erMlcs, orderItems, orders, patients } from "../../kernel/db/schema";
import { requireErPermission } from "./core";
import { ER_BOARD_WAITING } from "./names";
import type { Actor, ErStageWord, ErWaitingDisplay } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 9 (#816) — THE WAITING-AREA DISPLAY (spec §5 I, §4.9 "family display: stage words only, never clinical text").
 * A token (the last four digits of the ER number, on the band and the arrival slip) and one stage word. No name, no
 * initials, no complaint, no ESI colour, no bay. RULES ONLY (autonomy ladder: "family stage messages — rules").
 *
 * WHO IS NEVER ON IT: an MLC episode, a sealed (`sensitive_context`) or confidential patient — spec §3.7 "MLC patients:
 * family surfaces off" — and a brought-dead or departed episode (only open ones are read). Read from the record on every
 * call, never from a flag the screen sends.
 *
 * Stage words (DECIDED, standard practice): not yet seen → "Waiting"; with the doctor → "Being seen", or "Waiting for test"
 * while a test ordered for the visit is not done; decided: admit → "Admitting", discharge → "Going home soon", refer out →
 * "Transfer arranged".
 */
export function stageOf(e: Pick<EpisodeRow, "state" | "disposition">, testPending: boolean): ErStageWord {
  if (e.state === "disposition_decided") {
    return e.disposition === "admit" ? "Admitting" : e.disposition === "refer_out" ? "Transfer arranged" : "Going home soon";
  }
  if (e.state === "in_treatment") return testPending ? "Waiting for test" : "Being seen";
  return "Waiting";
}

export async function readErWaitingDisplay(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<ErWaitingDisplay> {
  await requireErPermission(db, actor, ER_BOARD_WAITING);
  const now = opts.now ?? new Date();
  const open = await db.select({ e: erEpisodes, sealed: patients.sensitiveContext, confidential: patients.isConfidential })
    .from(erEpisodes).innerJoin(patients, eq(patients.id, erEpisodes.patientId))
    .where(inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES])).orderBy(erEpisodes.arrivedAt);
  if (open.length === 0) return { generatedAt: now.toISOString(), rows: [] };
  const mlc = new Set((await db.select({ id: erMlcs.episodeId }).from(erMlcs).where(inArray(erMlcs.episodeId, open.map((r) => r.e.id)))).map((r) => r.id));
  const shown = open.filter((r) => !r.sealed && !r.confidential && !mlc.has(r.e.id)).map((r) => r.e);
  const pending = new Set(shown.length === 0 ? [] : (await db.select({ no: orders.encounterNo }).from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inArray(orders.encounterNo, shown.map((e) => e.episodeNo)), isNull(orderItems.completedAt), isNull(orderItems.cancelledAt)))).map((r) => r.no));
  return {
    generatedAt: now.toISOString(),
    rows: shown.map((e) => {
      const stage = stageOf(e, pending.has(e.episodeNo));
      return { token: e.episodeNo.slice(-4), stage, stageHi: ER_STAGE_WORDS_HI[stage] };
    }),
  };
}
