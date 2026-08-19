import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { receipts, receiptTenders, reconBatches } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { getPatientSummaries } from "../patients";
import { loadBillingConfig, updateBillingConfig } from "./config";
import { BillingError } from "./errors";
import { degradedModeChanged, tenderMismatched, tenderReconciled } from "./events";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 D7/E-25/E-26 -- tender lifecycle + statement-upload reconciliation, and the E-24
 * degraded-tender toggle (the flag itself lives on `billing_config`; its receipt-side effect is
 * entirely T5's, asserted here where the flag lives -- see `setDegraded` below).
 *
 * `expectedNetPaise` is CONSUMED here, never recomputed: `insertReceiptWithTenders`
 * (invoices.ts, T5) stamps it on every upi/card tender AT CAPTURE, from the fee-bps config in
 * force at that moment (self-review 12). Recomputing it here from the CURRENT config would let a
 * later fee-config revision silently rewrite what "expected" meant for money already taken --
 * this file only ever READS `receipt_tenders.expected_net_paise` (K31).
 *
 * Re-upload is idempotent by construction: every per-tender write below is a single-winner
 * conditional UPDATE `WHERE id = ... AND state = 'captured'` (the sessions.ts `beginClose` /
 * `confirmClose` shape, the refunds.ts `payRefundVoucher` shape). The MATCH is by ref alone, not
 * by state -- so a ref that resolves to an already-settled tender is still FOUND, and the
 * conditional UPDATE on it touches zero rows; the batch reports it by its existing recorded
 * state instead of rewriting it. That is what makes a second upload of the same statement unable
 * to change any tender's state, settled amount or reconciled-at a second time (K32).
 *
 * No PSP API anywhere in this file -- statement upload only (D7, D10). The CSV is a flat,
 * unquoted comma format: there is no PSP integration here to need escaping a comma inside a
 * field.
 */

export type TenderReconState = "captured" | "reconciled" | "mismatched";

export type ReconCsvRow = { ref: string; settledPaise: number; settledOn: string; feePaise?: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED_HEADER = ["ref", "settledPaise", "settledOn"];

function parseFailed(lineNo: number, detailMsg: string): never {
  throw new BillingError("recon_parse_failed", `line ${String(lineNo)}: ${detailMsg}`, { line: lineNo });
}

/** A money cell from an untrusted CSV -- a non-negative safe integer of paise, or a named parse failure. */
function parseMoneyCell(raw: string | undefined, field: string, lineNo: number): number {
  if (raw === undefined || raw.trim() === "") parseFailed(lineNo, `${field} is required`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    parseFailed(lineNo, `${field} must be a non-negative integer of paise, got "${raw}"`);
  }
  return n;
}

/**
 * The CSV parse (D7/E-26): `ref,settledPaise,settledOn` with an optional `feePaise` fourth
 * column -- accepted and carried on the row; the tolerance compare in `uploadSettlement` never
 * uses it (the file header above explains why the compare is against the STORED
 * `expectedNetPaise`, never a statement-supplied fee). A header row is REQUIRED (interpretation:
 * the plan names the columns by header text, and a header is what lets the optional fourth
 * column be recognised at all -- disclosed in the task report). Runs to completion BEFORE any
 * transaction opens and before `recon_batches` is touched: a malformed row or a duplicate ref
 * anywhere in the file means NOTHING from this upload is persisted, by construction (Step 1
 * tests 1 and 9) -- there is no code path between this function and any write.
 */
export function parseReconCsv(csv: string): ReconCsvRow[] {
  const lines = csv.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) parseFailed(1, "the statement is empty");

  const header = lines[0]!.split(",").map((h) => h.trim());
  const headerOk = REQUIRED_HEADER.every((col, i) => header[i] === col);
  if (!headerOk) {
    parseFailed(1, `header must be "${REQUIRED_HEADER.join(",")}[,feePaise]", got "${lines[0]}"`);
  }
  const hasFeeCol = header[3] === "feePaise";

  const rows: ReconCsvRow[] = [];
  const seenRefs = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1; // 1-indexed, matching what a text editor shows (header is line 1)
    const raw = lines[i]!;
    if (raw.trim() === "") continue; // a blank line inside the file is tolerated, never a data row

    const cols = raw.split(",").map((c) => c.trim());
    const minCols = hasFeeCol ? 4 : 3;
    if (cols.length < minCols) {
      parseFailed(lineNo, `expected ${String(minCols)} columns, got ${String(cols.length)}`);
    }
    const ref = cols[0]!;
    if (ref === "") parseFailed(lineNo, "ref is required");
    const settledOn = cols[2]!;
    if (!DATE_RE.test(settledOn)) parseFailed(lineNo, `settledOn must be YYYY-MM-DD, got "${settledOn}"`);
    const settledPaise = parseMoneyCell(cols[1], "settledPaise", lineNo);
    const feePaise = hasFeeCol && cols[3] !== "" ? parseMoneyCell(cols[3], "feePaise", lineNo) : undefined;

    if (seenRefs.has(ref)) {
      throw new BillingError("duplicate_ref", `ref "${ref}" appears more than once in this upload (line ${String(lineNo)})`, {
        ref, line: lineNo,
      });
    }
    seenRefs.add(ref);
    rows.push({ ref, settledPaise, settledOn, feePaise });
  }
  return rows;
}

export type UploadSettlementInput = { csv: string; source: "upi" | "card" };
export type UploadSettlementResult = {
  batchId: string;
  rowsTotal: number;
  rowsMatched: number;
  rowsMismatched: number;
  rowsUnmatched: number;
  unmatchedRefs: string[]; // reported, never guessed onto a tender (D7)
};

const uploadSettlementSchema = z.object({ csv: z.string(), source: z.enum(["upi", "card"]) });

function mismatchNoteFor(settledPaise: number, expectedNetPaise: number, tolerancePaise: number): string {
  return `settled ${String(settledPaise)}p vs expected ${String(expectedNetPaise)}p (tolerance ${String(tolerancePaise)}p)`;
}

/**
 * E-26. One transaction per batch. Each row is matched by ref against upi/card tenders
 * REGARDLESS of this upload's own `source` label: `source` names what statement this batch IS
 * (`recon_batches.source`), not a filter on what it may match against -- D7's own wording is
 * "match by ref against captured upi/card tenders", not "against tenders of this upload's
 * source" (interpretation, disclosed in the task report). A ref one PSP rail issues is not going
 * to collide with the other rail's tenders in practice.
 */
export async function uploadSettlement(
  db: Db,
  actor: Actor,
  rawInput: UploadSettlementInput,
  now: Date = new Date(),
): Promise<UploadSettlementResult> {
  const input = uploadSettlementSchema.parse(rawInput);
  const rows = parseReconCsv(input.csv); // throws BEFORE any read or write -- nothing persists on a bad file
  const cfg = await loadBillingConfig(db);

  return withTx(db, async (tx) => {
    let rowsMatched = 0;
    let rowsMismatched = 0;
    const unmatchedRefs: string[] = [];

    for (const row of rows) {
      const candidates = await tx
        .select({
          id: receiptTenders.id, receiptId: receiptTenders.receiptId, state: receiptTenders.state,
          expectedNetPaise: receiptTenders.expectedNetPaise, patientId: receipts.patientId,
        })
        .from(receiptTenders)
        .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
        .where(and(eq(receiptTenders.refText, row.ref), inArray(receiptTenders.mode, ["upi", "card"])));
      const candidate = candidates[0];
      if (!candidate) {
        unmatchedRefs.push(row.ref);
        continue;
      }

      // K31/M-N1: settled against the STAMPED expected-net, never the tender's gross amount and
      // never a statement-supplied fee column.
      const expectedNetPaise = candidate.expectedNetPaise ?? 0;
      const withinTolerance = Math.abs(row.settledPaise - expectedNetPaise) <= cfg.reconTolerancePaise;
      const targetState: TenderReconState = withinTolerance ? "reconciled" : "mismatched";

      const updated = await tx
        .update(receiptTenders)
        .set({
          state: targetState,
          settledPaise: row.settledPaise,
          reconciledAt: now,
          mismatchNote: withinTolerance ? null : mismatchNoteFor(row.settledPaise, expectedNetPaise, cfg.reconTolerancePaise),
        })
        // K32/M-N2: conditional on the tender STILL being 'captured'. An already-reconciled or
        // already-mismatched row updates ZERO rows here, so a second upload of the same
        // statement can never rewrite it.
        .where(and(eq(receiptTenders.id, candidate.id), eq(receiptTenders.state, "captured")))
        .returning();

      if (updated.length > 0) {
        if (withinTolerance) {
          rowsMatched++;
          await appendEvent(
            tx,
            tenderReconciled.make({
              actor,
              payload: { tenderId: candidate.id, receiptId: candidate.receiptId, settledPaise: row.settledPaise, expectedNetPaise },
              patientId: candidate.patientId,
            }),
          );
        } else {
          rowsMismatched++;
          await appendEvent(
            tx,
            tenderMismatched.make({
              actor,
              payload: { tenderId: candidate.id, receiptId: candidate.receiptId, settledPaise: row.settledPaise, expectedNetPaise },
              patientId: candidate.patientId,
            }),
          );
        }
      } else {
        // Idempotent no-op (K32): the tender already left 'captured' on a prior upload. Report it
        // by its EXISTING recorded state -- never touch the row and never emit a second event.
        if (candidate.state === "reconciled") rowsMatched++;
        else if (candidate.state === "mismatched") rowsMismatched++;
      }
    }

    const [batch] = await tx
      .insert(reconBatches)
      .values({
        id: newId(), uploadedBy: actor.id, uploadedAt: now, source: input.source,
        rowsTotal: rows.length, rowsMatched, rowsMismatched, rowsUnmatched: unmatchedRefs.length,
      })
      .returning({ id: reconBatches.id });

    return {
      batchId: batch!.id, rowsTotal: rows.length, rowsMatched, rowsMismatched,
      rowsUnmatched: unmatchedRefs.length, unmatchedRefs,
    };
  });
}

export type MismatchRow = {
  tenderId: string;
  receiptId: string;
  receiptNo: string;
  patientId: string;
  uhid: string;
  name: string | null; // null whenever the row is restricted
  alias: string | null;
  restricted: boolean;
  mode: "upi" | "card";
  amountPaise: number;
  expectedNetPaise: number;
  settledPaise: number;
  mismatchNote: string | null;
  reconciledAt: Date | null;
};

/** E-26's worklist: every tender still `mismatched`, with receipt + confidential-safe patient context. */
export async function listMismatches(db: Db, actor: Actor): Promise<MismatchRow[]> {
  const rows = await db
    .select({
      id: receiptTenders.id, receiptId: receiptTenders.receiptId, mode: receiptTenders.mode,
      amountPaise: receiptTenders.amountPaise, expectedNetPaise: receiptTenders.expectedNetPaise,
      settledPaise: receiptTenders.settledPaise, mismatchNote: receiptTenders.mismatchNote,
      reconciledAt: receiptTenders.reconciledAt, receiptNo: receipts.receiptNo, patientId: receipts.patientId,
    })
    .from(receiptTenders)
    .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
    .where(eq(receiptTenders.state, "mismatched"));
  if (rows.length === 0) return [];

  // Names come from the patients module's own confidential gate (§14): a restricted row renders
  // its alias and never the name, the `listDues` (receipts.ts) precedent.
  const summaries = await getPatientSummaries(db, actor, rows.map((r) => r.patientId));
  const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));

  return rows.map((row) => {
    const summary = byPatient.get(row.patientId);
    return {
      tenderId: row.id, receiptId: row.receiptId, receiptNo: row.receiptNo, patientId: row.patientId,
      uhid: summary?.uhid ?? "", name: summary?.name ?? null, alias: summary?.alias ?? null,
      restricted: summary?.restricted ?? false,
      mode: row.mode as "upi" | "card", amountPaise: row.amountPaise,
      expectedNetPaise: row.expectedNetPaise ?? 0, settledPaise: row.settledPaise ?? 0,
      mismatchNote: row.mismatchNote, reconciledAt: row.reconciledAt,
    };
  });
}

const setDegradedReasonSchema = z.string().min(1);

/**
 * E-24. Flips `billing_config.degraded_tender` and appends `degraded_mode.changed` in ONE
 * transaction. The receipt-side effect -- the `degraded: true` stamp on every receipt recorded
 * while this is on -- is entirely T5's `insertReceiptWithTenders` reading `cfg.degradedTender` at
 * capture; this function only ever flips the flag those callers read. The settlement-reference
 * requirement on upi/card tenders is unconditional either way (`tender_ref_required`,
 * invoices.ts), so the stamp really is degraded mode's whole additional effect (Task 9 notes).
 */
export async function setDegraded(
  db: Db,
  actor: Actor,
  on: boolean,
  reason: string,
  now: Date = new Date(),
): Promise<{ degradedTender: boolean }> {
  const checkedReason = setDegradedReasonSchema.parse(reason);
  return withTx(db, async (tx) => {
    const cfg = await updateBillingConfig(tx, { degradedTender: on }, now);
    await appendEvent(tx, degradedModeChanged.make({ actor, payload: { on, reason: checkedReason } }));
    return { degradedTender: cfg.degradedTender };
  });
}
