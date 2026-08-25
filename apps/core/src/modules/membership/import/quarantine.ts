import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { importQuarantine } from "../../../kernel/db/schema";
import type { Tx } from "../../../kernel/db/client";
import type { Db } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — THE QUARANTINE LANE: a row the importer refused to guess at, kept verbatim.
 *
 * ═══ WHOLE ROWS, BOTH SIDES OF A DUPLICATE, AND NEVER LAST-WINS ═══
 *
 * The temptation with a duplicate key is to take the later row and move on. It is wrong for a
 * reason that only shows up months later: the two rows disagree about WHO holds a card, and taking
 * the later one silently picks a person. A hospital that honours a card for the wrong holder has no
 * way to discover it — the card works, the counter is happy, and the partner's own book says
 * something else. So BOTH rows are quarantined, with the same reason, and NEITHER is applied. A
 * human reads the two lines side by side and tells the partner which is right.
 *
 * `raw` IS THE SOURCE LINE, VERBATIM. The schema's own header says why: a human needs to see what
 * the partner actually sent, not what the parser made of it. A parsed object here would hide
 * exactly the class of defect that put the row in this table — a stray comma, a quoted field, a
 * cell that is empty rather than absent.
 */

/**
 * The reasons this lane can give. Each is a DIFFERENT decision a human has to make, which is what
 * makes them separate rather than one `parse_failed`:
 *  · `duplicate_key`     — two rows in one drop claim the same sale reference or the same card.
 *  · `inverted_validity` — the card expires before it starts.
 *  · `unknown_plan`      — the drop names a plan code this hospital has never been given.
 *  · `missing_required`  — a column the map declares is present but empty on this row.
 *  · `bad_date`          — a date cell that is not a date.
 *  · `short_row`         — fewer cells than the header has columns.
 */
export const QUARANTINE_REASONS = [
  "duplicate_key",
  "inverted_validity",
  "unknown_plan",
  "missing_required",
  "bad_date",
  "short_row",
] as const;

export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/**
 * PRECEDENCE, and it is not cosmetic. A row can be wrong in several ways at once, and
 * `import_quarantine.reason` is one column. `duplicate_key` outranks everything because it is the
 * reason that binds a SECOND row — the other half of the pair has no defect of its own and must
 * still carry the same word, or a human reading the batch sees one quarantined row and one that
 * silently vanished.
 */
const REASON_RANK: Record<QuarantineReason, number> = {
  duplicate_key: 0,
  short_row: 1,
  missing_required: 2,
  bad_date: 3,
  inverted_validity: 4,
  unknown_plan: 5,
};

export function primaryReason(reasons: readonly QuarantineReason[]): QuarantineReason {
  const sorted = [...reasons].sort((a, b) => REASON_RANK[a] - REASON_RANK[b]);
  const first = sorted[0];
  if (first === undefined) throw new Error("primaryReason called with no reasons — the caller has a bug");
  return first;
}

export type QuarantineSource = "holder_book" | "partner_statement";

export type QuarantineInput = {
  source: QuarantineSource;
  /** `holder_book_imports.id` today, a statement reference when T7 imports one — plain text, no FK. */
  batchId: string;
  rowNo: number;
  reason: QuarantineReason;
  /** The source LINE, exactly as it arrived. */
  line: string;
};

export type QuarantineRow = {
  id: string;
  batchId: string;
  rowNo: number;
  reason: string;
  line: string;
};

/**
 * Writes the rows inside the caller's transaction — the importer's own — so a drop that fails
 * halfway leaves neither instances nor quarantine rows behind. One `insert` for the batch: a
 * per-row round trip on a ten-thousand-row drop is the difference between a minute and an hour.
 */
export async function quarantineRows(tx: Tx, rows: readonly QuarantineInput[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const values = rows.map((r) => ({
    id: newId(),
    source: r.source,
    batchId: r.batchId,
    rowNo: r.rowNo,
    reason: r.reason,
    raw: { line: r.line },
  }));
  await tx.insert(importQuarantine).values(values);
  return values.map((v) => v.id);
}

/** Everything one batch quarantined, in the file's own row order — the order a human reads. */
export async function listQuarantine(db: Db, batchId: string): Promise<QuarantineRow[]> {
  const rows = await db
    .select({
      id: importQuarantine.id,
      batchId: importQuarantine.batchId,
      rowNo: importQuarantine.rowNo,
      reason: importQuarantine.reason,
      raw: importQuarantine.raw,
    })
    .from(importQuarantine)
    .where(eq(importQuarantine.batchId, batchId))
    .orderBy(asc(importQuarantine.rowNo), asc(importQuarantine.seq));
  return rows.map((r) => ({
    id: r.id,
    batchId: r.batchId,
    rowNo: r.rowNo,
    reason: r.reason,
    line: typeof (r.raw as { line?: unknown }).line === "string" ? (r.raw as { line: string }).line : "",
  }));
}
