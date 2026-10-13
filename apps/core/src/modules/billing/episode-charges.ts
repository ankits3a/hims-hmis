import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * #785 — THE EPISODE CHARGE SINK. Some episodes do not take a department's invoice: an inpatient admission (`IP26-000123`)
 * keeps ONE running bill, composed into one invoice at discharge, so a lab test or a scan ordered on it must land as a line
 * of that bill and never as a held invoice of its own. The module that owns the episode series registers a sink under its
 * prefix (the `registerEncounterResolver` / `registerReceiptGuard` shape: pushed in, so billing imports no module); a
 * department that would have issued an invoice asks `episodeChargeSinkFor(encounterNo)` first.
 *
 * Default: no sinks — every department bills exactly as before.
 *
 * `standing` says whether the sink owns this episode NOW: `live` (post to it, raise no invoice), `ended` (the episode
 * exists but has ended — a NEW order on it is refused by the department; a consequence of an earlier order, such as a
 * reflex test, still posts), or `null` (not this sink's episode: bill as before).
 *
 * `post` and `reverse` run on the department's transaction. They never refuse for money (a missing rate is the sink's
 * own exception record); only an infrastructure fault throws.
 */
export type EpisodeStanding = "live" | "ended" | null;
export type EpisodeChargeItem = { orderId: string; orderItemId: string; serviceId: string };
export type EpisodeChargeSink = {
  standing(exec: Db | Tx, encounterNo: string): Promise<EpisodeStanding>;
  post(tx: Tx, actor: Actor, input: {
    encounterNo: string; department: "lab" | "imaging"; items: readonly EpisodeChargeItem[]; at: Date;
  }): Promise<void>;
  /**
   * An order item was cancelled. `workStarted` is the DEPARTMENT's answer to "was the work begun?" (lab: a sample was
   * collected; imaging: the study reached the machine); the sink decides what that costs.
   */
  reverse(tx: Tx, actor: Actor, input: { orderItemId: string; workStarted: boolean; reason: string; at: Date }): Promise<void>;
};

const sinks = new Map<string, EpisodeChargeSink>();

/** Registers (or replaces) the sink for an episode-number prefix; returns the unregister function. */
export function registerEpisodeChargeSink(prefix: string, sink: EpisodeChargeSink): () => void {
  sinks.set(prefix, sink);
  return () => { if (sinks.get(prefix) === sink) sinks.delete(prefix); };
}

/** The sink whose prefix the episode number starts with (longest prefix first), or null. */
export function episodeChargeSinkFor(encounterNo: string): EpisodeChargeSink | null {
  for (const prefix of [...sinks.keys()].sort((a, b) => b.length - a.length)) {
    if (encounterNo.startsWith(prefix)) return sinks.get(prefix)!;
  }
  return null;
}

/** The sink and its answer for one episode, in one call (`null` when no sink owns it). */
export async function episodeChargeStanding(
  exec: Db | Tx, encounterNo: string,
): Promise<{ sink: EpisodeChargeSink; standing: "live" | "ended" } | null> {
  const sink = episodeChargeSinkFor(encounterNo);
  if (sink === null) return null;
  const standing = await sink.standing(exec, encounterNo);
  return standing === null ? null : { sink, standing };
}
