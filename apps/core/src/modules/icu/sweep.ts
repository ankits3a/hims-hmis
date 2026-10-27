import { escalateAlarms, syncFeedGaps } from "./alarms";
import { ensureBundles } from "./bundles";
import { reconcileLinks } from "./devices";
import { dropExpiredNumericsPartitions } from "./partitions";
import type { Db } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984) — THE ICU CLOCK, `sweepIcuAlarms`, every 10 s (one job; no pool client of its own beyond it):
 *   1. the alarm ladder (D5): life-threatening alarms climb when their rung's clock runs out;
 *   2. feed gaps (D7): open on the kernel's `down` verdict, close on the next heartbeat;
 *   3. links whose stay ended (D2): closed at the stay's own end instant;
 *   4. bundles (D8): the next one of every standing trigger raised;
 *   5. once an hour, the raw numerics partitions past 72 hours dropped.
 * Each part in its own try: one failing part never stops the ladder. The first failure is rethrown after all ran, so the
 * scheduler records the tick as failed. A quiet tick reads a handful of indexed rows and writes nothing.
 */
export type IcuSweepResult = { escalated: number; gapsOpened: number; gapsClosed: number; linksClosed: number; bundlesRaised: number; partitionsDropped: string[] };

let lastPartitionRun = 0;

export async function sweepIcuAlarms(db: Db, now: Date = new Date()): Promise<IcuSweepResult> {
  const out: IcuSweepResult = { escalated: 0, gapsOpened: 0, gapsClosed: 0, linksClosed: 0, bundlesRaised: 0, partitionsDropped: [] };
  let first: unknown = undefined;
  const run = async (fn: () => Promise<void>): Promise<void> => { try { await fn(); } catch (e) { first ??= e; } };
  await run(async () => { out.escalated = await escalateAlarms(db, now); });
  await run(async () => { const g = await syncFeedGaps(db, now); out.gapsOpened = g.opened; out.gapsClosed = g.closed; });
  await run(async () => { out.linksClosed = await reconcileLinks(db, now); });
  await run(async () => { out.bundlesRaised = await ensureBundles(db, now); });
  if (Math.abs(now.getTime() - lastPartitionRun) >= 3_600_000) {
    await run(async () => { out.partitionsDropped = await dropExpiredNumericsPartitions(db, now); lastPartitionRun = now.getTime(); });
  }
  if (first !== undefined) throw first;
  return out;
}
