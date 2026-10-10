import { eq, sql } from "drizzle-orm";
import { COPILOT_HALT_SCOPES, copilotHalts } from "../db/schema";
import { withTx } from "../db/client";
import { istDayWindow } from "../approvals/cumulative";
import { appendEvent } from "../events/append";
import { copilotHaltCleared, copilotHaltSet } from "./events";
import type { CopilotHaltScope } from "../db/schema";
import type { CopilotToolDecl } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E0.3 — THE COPILOT'S HALT SWITCH, AND E0.5'S CAP READ BESIDE IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Plan E0.3 (decision 0064; spec /opt/hmis-context/SPEC-copilot-halt-and-cap-2026-10-11.md). Four
 * scopes, and what each stops:
 *
 *   global — everything: every ask answers "paused" and nothing routes.
 *   read   — every ask answers "paused" (an ask IS the read path).
 *   act    — tools that WRITE (`kind: "act"`) refuse with "paused"; reads still answer.
 *   draft  — tools that DRAFT (`kind: "draft"`) refuse with "paused"; reads still answer.
 *
 * ═══ ONE ROUND TRIP PER ASK, NO CACHE ═══
 *
 * `getOperatingMode`'s rule: a cache is a window in which a halt does not hold, and the halt's whole
 * job is to hold on the very NEXT ask — on this box and on the failover site, which reads the same
 * replicated table. The same statement sums the IST day's estimated spend for the ₹ cap (E0.5), so
 * the two together cost one indexed round trip (G4: the phrasebook path keeps its latency budget).
 */
export type CopilotGate = {
  halts: ReadonlySet<CopilotHaltScope>;
  /** Estimated copilot spend since midnight IST of `now`, micro-rupees. */
  spentMicroInr: number;
};

export async function readCopilotGate(db: Db, now: Date): Promise<CopilotGate> {
  const { start, end } = istDayWindow(now);
  const rows = (await db.execute(sql`
    select
      coalesce((select array_agg(scope) from copilot_halts), '{}'::text[]) as "scopes",
      coalesce((
        select sum(cost_micro_inr) from copilot_asks
        where cost_micro_inr > 0 and at >= ${start.toISOString()}::timestamptz and at < ${end.toISOString()}::timestamptz
      ), 0)::float8 as "spent"
  `)).rows as [{ scopes: string[]; spent: number | string }];
  const row = rows[0]!;
  return { halts: new Set(row.scopes as CopilotHaltScope[]), spentMicroInr: Number(row.spent) };
}

/** Does the halt state stop every ask before routing? */
export const asksHalted = (halts: ReadonlySet<CopilotHaltScope>): boolean => halts.has("global") || halts.has("read");

/**
 * Does the halt state stop THIS tool? Generic on the tool's declared `kind`, so a write tool E0.2
 * adds is covered by declaring `kind: "act"`, with no edit here.
 */
export function toolHalted(tool: Pick<CopilotToolDecl, "kind">, halts: ReadonlySet<CopilotHaltScope>): boolean {
  if (asksHalted(halts)) return true;
  const kind = tool.kind ?? "read";
  return (kind === "act" && halts.has("act")) || (kind === "draft" && halts.has("draft"));
}

export type HaltRow = { scope: CopilotHaltScope; haltedBy: string; haltedAt: string; reason: string | null };

export async function listHalts(db: Db): Promise<HaltRow[]> {
  const rows = await db.select().from(copilotHalts).orderBy(copilotHalts.scope);
  return rows.map((r) => ({ scope: r.scope as CopilotHaltScope, haltedBy: r.haltedBy, haltedAt: r.haltedAt.toISOString(), reason: r.reason }));
}

/**
 * Throw the switch. Idempotent: halting a halted scope changes nothing and writes no second event.
 * The row and its audit event commit together, or neither does.
 */
export async function setHalt(db: Db, actor: Actor, scope: CopilotHaltScope, reason: string | null): Promise<{ changed: boolean }> {
  return withTx(db, async (tx) => {
    const inserted = await tx.insert(copilotHalts)
      .values({ scope, haltedBy: actor.id, reason })
      .onConflictDoNothing()
      .returning({ scope: copilotHalts.scope });
    if (inserted.length === 0) return { changed: false };
    await appendEvent(tx, copilotHaltSet.make({ actor, payload: { scope, reason } }));
    return { changed: true };
  });
}

/**
 * Clear it. WHO MAY is the controller's question (global needs `copilot.halt.clear_global`, owner
 * only); this only clears and records. Clearing a scope that is not halted changes nothing.
 */
export async function clearHalt(db: Db, actor: Actor, scope: CopilotHaltScope): Promise<{ changed: boolean }> {
  return withTx(db, async (tx) => {
    const removed = await tx.delete(copilotHalts).where(eq(copilotHalts.scope, scope)).returning();
    const row = removed[0];
    if (row === undefined) return { changed: false };
    await appendEvent(tx, copilotHaltCleared.make({
      actor, payload: { scope, haltedBy: row.haltedBy, haltedAt: row.haltedAt.toISOString() },
    }));
    return { changed: true };
  });
}

export const isHaltScope = (x: unknown): x is CopilotHaltScope =>
  typeof x === "string" && (COPILOT_HALT_SCOPES as readonly string[]).includes(x);
