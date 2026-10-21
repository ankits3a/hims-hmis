import { and, asc, eq, inArray } from "drizzle-orm";
import { labSlipScans } from "../../kernel/db/schema";
import { openChecks, slipCounts } from "./slip-map";
import type { SlipCounts, SlipRowView } from "./slip-map";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ SPEC #934 — WHERE A SLIP MEETS THE QUICK BENCH ═══
 *
 * `quick.ts` owns the report; `slips.ts` owns the scan. This file is the narrow seam between them,
 * and it imports neither, so `saveQuickResults` can call it without a cycle:
 *
 *   · a line the slip placed carries a marker (`QuickLine.slip`, jsonb, no migration);
 *   · a person who EDITS such a line clears its checks, and the scan records who (`recordSlipEdits`);
 *   · Save & Complete is refused while any attached slip has an open check or an unresolved row
 *     (`slipChecksOpen`) — the refusal that turns "never silently dropped" into a guarantee;
 *   · the bench read shows the CURRENT checks on each line and the "not placed" panel (`slipBench`).
 */
export type QuickLineSlip = {
  scanId: string;
  /** The slip row's position (0-based, printed order). */
  row: number;
  /** The checks OPEN on this line, as of the read. */
  checks: string[];
  checkedBy?: string;
  /** The slip's value, where it is not the line's (a person's value kept, or a computed line's cross-check). */
  slipValue?: string;
  /** A person changed the value after the slip placed it: the value is theirs now. */
  edited?: boolean;
  /** A person's value was already there and was kept; the slip's value is `slipValue`. */
  kept?: boolean;
};

export type SlipRowBrief = Pick<SlipRowView, "position" | "code" | "value" | "unit" | "machineFlag" | "reason" | "settingReason" | "analyteId" | "analyteName"> & {
  placement: SlipRowView["placement"];
};

/** What the bench (web and phone) shows for one attached slip. */
export type SlipBenchView = {
  scanId: string; matchKind: string | null; capturedAt: string; instrumentId: string;
  counts: SlipCounts;
  notPlaced: SlipRowBrief[];
  ignoredBySetting: SlipRowBrief[];
  ignored: (SlipRowBrief & { ignoreReason: string | null })[];
  rowsMissing: string[];
};

type LineLike = { analyteId: string; slip?: QuickLineSlip };

const brief = (r: SlipRowView): SlipRowBrief => ({
  position: r.position, code: r.code, value: r.value, unit: r.unit, machineFlag: r.machineFlag, reason: r.reason,
  settingReason: r.settingReason, analyteId: r.analyteId, analyteName: r.analyteName, placement: r.placement,
});

/** The scans attached to one report, oldest first. */
async function attachedScans(exec: Db | Tx, reportId: string) {
  return (exec as Db).select().from(labSlipScans)
    .where(and(eq(labSlipScans.quickReportId, reportId), eq(labSlipScans.status, "attached")))
    .orderBy(asc(labSlipScans.capturedAt));
}

/**
 * A person edited (or removed) slip-placed values: each such row's checks are cleared by that edit,
 * and the scan records who. A row already checked keeps its first checker.
 */
export async function recordSlipEdits(
  tx: Tx, actor: Actor, edits: readonly { scanId: string; row: number }[], now: Date,
): Promise<void> {
  if (edits.length === 0) return;
  const ids = [...new Set(edits.map((e) => e.scanId))];
  const scans = await tx.select({ id: labSlipScans.id, rows: labSlipScans.rows }).from(labSlipScans)
    .where(inArray(labSlipScans.id, ids)).for("update");
  for (const s of scans) {
    const rows = s.rows as SlipRowView[];
    let changed = false;
    for (const e of edits.filter((x) => x.scanId === s.id)) {
      const r = rows.find((x) => x.position === e.row);
      if (r === undefined || r.checked !== null) continue;
      r.checked = { by: actor.id, at: now.toISOString(), via: "edit" };
      changed = true;
    }
    if (changed) await tx.update(labSlipScans).set({ rows }).where(eq(labSlipScans.id, s.id));
  }
}

/** True while any slip attached to the report has an open check or a row nobody placed or ignored. */
export async function slipChecksOpen(exec: Db | Tx, reportId: string): Promise<boolean> {
  for (const s of await attachedScans(exec, reportId)) {
    const rows = s.rows as SlipRowView[];
    if (rows.some((r) => r.placement === "not_placed" || openChecks(r).length > 0)) return true;
  }
  return false;
}

/**
 * The bench's view: each line's marker brought up to date with the scan (its OPEN checks, the slip's
 * value beside a person's), a cross-check marker on each computed line a slip printed, and one panel
 * per attached slip.
 */
export async function slipBench<L extends LineLike>(exec: Db | Tx, reportId: string, lines: readonly L[]): Promise<{ lines: L[]; slips: SlipBenchView[] }> {
  const scans = await attachedScans(exec, reportId);
  const out = lines.map((l) => ({ ...l }));
  const slips: SlipBenchView[] = [];
  for (const s of scans) {
    const rows = s.rows as SlipRowView[];
    for (const r of rows) {
      if (r.analyteId === null) continue;
      const line = out.find((l) => l.analyteId === r.analyteId);
      if (line === undefined) continue;
      if (r.placement === "placed" && line.slip?.scanId === s.id && line.slip.row === r.position) {
        line.slip = {
          ...line.slip, checks: openChecks(r),
          ...(r.checked !== null ? { checkedBy: r.checked.by } : {}),
          ...(line.slip.kept === true && r.placedValue !== null ? { slipValue: r.placedValue } : {}),
        };
      } else if (r.placement === "cross_check" && line.slip === undefined) {
        line.slip = {
          scanId: s.id, row: r.position, checks: openChecks(r),
          ...(r.checked !== null ? { checkedBy: r.checked.by } : {}),
          ...(r.placedValue !== null ? { slipValue: r.placedValue } : {}),
        };
      }
    }
    const identity = (s.identity ?? {}) as { rowsMissing?: string[] };
    slips.push({
      scanId: s.id, matchKind: s.matchKind, capturedAt: s.capturedAt.toISOString(), instrumentId: s.instrumentId,
      counts: slipCounts(rows),
      notPlaced: rows.filter((r) => r.placement === "not_placed").map(brief),
      ignoredBySetting: rows.filter((r) => r.placement === "ignored_setting").map(brief),
      ignored: rows.filter((r) => r.placement === "ignored").map((r) => ({ ...brief(r), ignoreReason: r.resolution?.action === "ignore" ? r.resolution.reason : null })),
      rowsMissing: identity.rowsMissing ?? [],
    });
  }
  return { lines: out, slips };
}
