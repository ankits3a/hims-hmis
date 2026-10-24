import { BillingError } from "./errors";
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
/** What a cancel cost on the running bill — the department hands it back to its caller (#785 review). */
export type EpisodeReverseOutcome = "reversed" | "work_done" | "billed" | "not_posted" | "none";
export type EpisodeChargeSink = {
  standing(exec: Db | Tx, encounterNo: string): Promise<EpisodeStanding>;
  /**
   * Takes the episode's own lock on the caller's transaction and answers the standing UNDER it (#785 review, lock
   * order): a department calls this FIRST, before it writes anything, so every path takes the episode lock before its
   * own rows — the same order the episode's own acts use.
   */
  lock(tx: Tx, encounterNo: string): Promise<EpisodeStanding>;
  post(tx: Tx, actor: Actor, input: {
    encounterNo: string; department: "lab" | "imaging"; items: readonly EpisodeChargeItem[]; at: Date;
  }): Promise<void>;
  /**
   * An order item was cancelled. `workStarted` is the DEPARTMENT's answer to "was the work begun?" (lab: a sample was
   * collected; imaging: the study reached the machine); the sink decides what that costs and says so.
   */
  reverse(tx: Tx, actor: Actor, input: { orderItemId: string; workStarted: boolean; reason: string; at: Date }): Promise<EpisodeReverseOutcome>;
  /** True when this order item is charged on the episode's running bill (a line, or an open missing-rate record). */
  covers(exec: Db | Tx, orderItemId: string): Promise<boolean>;
};

/**
 * #785 review (fail closed) — the episode grammars that bill on a running bill, WRITTEN OUT here because billing imports no
 * module (ipd `IPD_ADMISSION_NO_RE`; radiology mirrors it the same way). A number of this grammar is never invoiced by a
 * department, sink or no sink: `issueInvoice` refuses it (`ipd_running_bill`), and a department that finds no sink
 * registered for it refuses the order (`running_bill_unavailable`) instead of billing it the old way.
 */
// ER lane 3 (#810): the emergency episode (`ER26-000123`) bills on its own charge sink too — never invoiced at a counter.
export const RUNNING_BILL_EPISODE_RES: readonly RegExp[] = [/^IP\d{2}-\d{6}$/, /^ER\d{2}-\d{6}$/];
export function isRunningBillEpisode(encounterNo: string | undefined | null): boolean {
  return typeof encounterNo === "string" && RUNNING_BILL_EPISODE_RES.some((re) => re.test(encounterNo));
}

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

function requireSink(encounterNo: string): EpisodeChargeSink | null {
  const sink = episodeChargeSinkFor(encounterNo);
  if (sink === null && isRunningBillEpisode(encounterNo)) {
    throw new BillingError("running_bill_unavailable",
      `${encounterNo} bills on a running bill and no running bill is registered in this process — the order is refused, never invoiced`,
      { encounterNo });
  }
  return sink;
}

/**
 * The sink and its answer for one episode (`null` when no sink owns it). With `lock`, the episode's lock is taken first on
 * the caller's transaction and the standing is read under it. Refuses `running_bill_unavailable` for a running-bill
 * grammar with no sink (fail closed).
 */
export async function episodeChargeStanding(
  exec: Db | Tx, encounterNo: string, opts: { lock?: boolean } = {},
): Promise<{ sink: EpisodeChargeSink; standing: "live" | "ended" } | null> {
  const sink = requireSink(encounterNo);
  if (sink === null) return null;
  const standing = opts.lock === true ? await sink.lock(exec as Tx, encounterNo) : await sink.standing(exec, encounterNo);
  return standing === null ? null : { sink, standing };
}

/** #785 review — a tender offered for a running-bill episode is refused: the money is taken on the running bill. */
export function refuseRunningBillTender(encounterNo: string): never {
  throw new BillingError("ipd_running_bill",
    `${encounterNo} is billed on the inpatient running bill — no receipt is taken at this counter`, { encounterNo });
}
