import { and, asc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import {
  commissionAccruals, importQuarantine, receivableExpectations,
} from "../../kernel/db/schema";
import { counterpartyFacts, requireAgreementAt } from "./agreements";
import { receivableSnapshotOf, receivableTermsOf, requireReceivableLane } from "./attribution";
import { PartnersError } from "./errors";
import { expectationCorrected, expectationDisputed, statementImported } from "./events";
import { periodKeyFor } from "./kicker";
import { resolveStatementRef } from "./reconcile";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD13 — THE PARTNER STATEMENT, IMPORTED BY NAME AND JOINED BY ID.
 *
 * ═══ THERE IS NO STATEMENT HEADER OR LINE TABLE, AND THAT IS THE PLAN'S OWN BUDGET ═══
 *
 * Seventeen tables were budgeted for this phase and all seventeen are spent; the phase relay
 * records the ruling. So a statement lands as ONE `receivable_expectations` ROW PER PARSEABLE LINE
 * — the columns are already there (`statement_ref`, `statement_period`, `statement_line_no`,
 * `dispute_reason`, `state`) — and `receivable_expectations_statement_line_ux`, the partial unique
 * index on `(counterparty_id, statement_ref, statement_line_no) WHERE statement_ref is not null`,
 * is what stops one statement being imported twice. Rows created at ISSUANCE carry a null
 * `statement_ref` and sit outside that index, which is what lets a match UPDATE one in place.
 *
 * ═══ WHAT ONE LINE CAN BECOME, AND WHY EVERY ARM IS A ROW SOMEBODY CAN SEE ═══
 *
 *   · UNPARSEABLE                  → `import_quarantine` alone (`source = 'partner_statement'`,
 *                                     `batch_id` = the statement's own reference), verbatim.
 *   · resolves to NOTHING          → a NEW `disputed` row, `attribution_id` null (V1). Never an
 *                                     accrual: a partner cannot create a claim by asserting one.
 *   · resolves to ANOTHER partner  → a NEW `disputed` row carrying the foreign attribution id (V6).
 *                                     DD13 makes this a RULE, not a conflict to resolve: the
 *                                     partner whose id is on the slip is the partner with the claim.
 *   · resolves, amount AGREES      → the OPEN expectation is UPDATED to `matched`, and ONE
 *                                     `commission_accruals` receivable row records the money.
 *   · resolves, amount DIFFERS     → the OPEN expectation is UPDATED to `disputed`
 *                                     (`amount_mismatch`) and NO money is recorded. Its
 *                                     `amount_paise` stays OUR figure, because a dispute is
 *                                     precisely the state in which we do not accept the partner's.
 *   · resolves, nothing OPEN       → V3's LATE CORRECTION: a NEW `matched` row for this line and an
 *                                     ADJUSTMENT accrual naming the period it corrects. The prior
 *                                     row and the prior ledger entry are BOTH untouched — DD5, and
 *                                     `commission_accruals` is append-only by trigger, so an
 *                                     implementation that tried to edit them would be REFUSED by
 *                                     the database rather than merely wrong.
 *
 * **EVERY DISPUTED LINE IS ALSO QUARANTINED VERBATIM.** The expectation row carries our reading of
 * the line; `import_quarantine.raw` carries what the partner actually sent. Without it the
 * partner's own figure on an `amount_mismatch` would exist nowhere in this system, because there
 * is no statement-line table to hold it. The shape is `{ line }` — byte-identical to the holder
 * book's, so `listQuarantine`'s reader serves both lanes.
 *
 * ═══ THE JOIN IS `reconcile.ts`'s AND THERE IS NO OTHER ONE ═══
 *
 * V7. This file calls `resolveStatementRef` and does no matching of its own. It contains no
 * `ilike`, no `similarity`, no prefix and no normalisation beyond `trim()`; `reconcile.test.ts`
 * asserts that absence over the source of both files, in a leg with a negative control.
 */

/** Headers are folded case- and space-insensitively; nothing else is normalised (T5's rule). */
export function foldHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The canonical fields a statement line can carry. Everything downstream speaks these. */
export type StatementField = "attributionRef" | "partnerRef" | "amountPaise" | "period";

export type StatementColumnMap = {
  readonly version: string;
  /** folded header text → canonical field. Its KEY SET identifies the map. */
  readonly headers: Readonly<Record<string, StatementField>>;
};

/**
 * TWO MAPS SHIP, AND THE SECOND IS NOT DECORATION. v2 carries a per-line `period`, which is how a
 * partner names the period a correction amends (V3); v1 has no such column, so a correction under
 * v1 amends the period the row it corrects was settled in. Both are a fact about a FILE FORMAT —
 * no partner, no plan code, no rate and no person appears here (DD3/O-9).
 *
 * There is deliberately no positional fallback: a drop whose header set matches no map refuses the
 * WHOLE file (`statement_columns_unknown`) rather than importing the prefix it happened to
 * understand. A renamed column is a conversation with the partner, not a silent re-read.
 */
export const STATEMENT_COLUMN_MAPS: readonly StatementColumnMap[] = [
  {
    version: "partner-statement-v1",
    headers: {
      "attribution_ref": "attributionRef",
      "partner_ref": "partnerRef",
      "amount_paise": "amountPaise",
    },
  },
  {
    version: "partner-statement-v2",
    headers: {
      "our ref": "attributionRef",
      "their ref": "partnerRef",
      "amount paise": "amountPaise",
      "period": "period",
    },
  },
];

export const STATEMENT_MAP_VERSIONS: readonly string[] = STATEMENT_COLUMN_MAPS.map((m) => m.version);

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Which map describes this header row? A REPEATED HEADING IS AN UNKNOWN SHAPE, not a near-miss:
 * set equality cannot tell `ref,ref,amount` from `ref,amount` on its own, and a file with two
 * columns of one name has no by-name reading at all.
 */
export function resolveStatementColumnMap(headerCells: readonly string[], requested?: string): StatementColumnMap {
  const folded = headerCells.map(foldHeader);
  const distinct = new Set(folded);
  if (distinct.size !== folded.length) {
    throw new PartnersError(
      "statement_columns_unknown",
      "the header row repeats a column name, so no column can be read by name",
      { headers: folded, knownVersions: STATEMENT_MAP_VERSIONS },
    );
  }
  const candidates =
    requested === undefined
      ? STATEMENT_COLUMN_MAPS
      : STATEMENT_COLUMN_MAPS.filter((m) => m.version === requested);
  if (requested !== undefined && candidates.length === 0) {
    throw new PartnersError(
      "statement_columns_unknown",
      `no statement column map named "${requested}"`,
      { headers: folded, knownVersions: STATEMENT_MAP_VERSIONS },
    );
  }
  for (const map of candidates) {
    if (sameSet(distinct, new Set(Object.keys(map.headers)))) return map;
  }
  throw new PartnersError(
    "statement_columns_unknown",
    "this statement's column shape matches no known map — it will NOT be read by position",
    { headers: folded, knownVersions: requested === undefined ? STATEMENT_MAP_VERSIONS : [requested] },
  );
}

/**
 * The reasons a statement line can be refused before it is ever resolved, plus the three a
 * RESOLUTION can give. They share one vocabulary because they share one quarantine table, and a
 * human clearing a statement is doing one job.
 *
 * `long_row` exists because the holder-book parser has `short_row` and no long-row check, and the
 * gate that measured it found the narrow path where that loses data silently: a cell beyond the
 * header's length is dropped without a word. A statement's last column is an AMOUNT, so the same
 * stray comma would move money.
 */
export const STATEMENT_QUARANTINE_REASONS = [
  "short_row", "long_row", "missing_required", "bad_amount", "bad_period",
  "unknown_attribution", "attribution_partner_mismatch", "amount_mismatch",
] as const;

export type StatementQuarantineReason = (typeof STATEMENT_QUARANTINE_REASONS)[number];

export type ParsedStatementRow = {
  rowNo: number;
  /** The source LINE, exactly as it arrived — what the partner sent, not what the parser made of it. */
  line: string;
  attributionRef: string | null;
  partnerRef: string | null;
  amountPaise: number | null;
  period: string | null;
  reasons: StatementQuarantineReason[];
};

export type ParsedStatement = {
  map: StatementColumnMap;
  headerCells: string[];
  rows: ParsedStatementRow[];
};

const PERIOD_RE = /^(\d{4})-(M(0[1-9]|1[0-2])|Q[1-4])$/;

/**
 * Paise, and only paise. A statement quoting `1234.50` is quoting RUPEES, and silently multiplying
 * by a hundred is how a money import ships a factor-of-100 defect that nobody sees until a partner
 * disputes it. It is `bad_amount`, and the operator asks the partner for the format the map names.
 */
function parsePaise(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || !/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function parseStatement(csv: string, requestedVersion?: string): ParsedStatement {
  const lines = csv.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    // An empty file has no header, so it has no column shape — the same refusal, not a new one.
    return { map: resolveStatementColumnMap([], requestedVersion), headerCells: [], rows: [] };
  }
  const headerCells = headerLine.split(",").map((h) => h.trim());
  const map = resolveStatementColumnMap(headerCells, requestedVersion);

  const rows: ParsedStatementRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue; // a blank line inside the file is tolerated, never a data row
    const cells = line.split(",").map((c) => c.trim());
    const reasons: StatementQuarantineReason[] = [];
    if (cells.length < headerCells.length) reasons.push("short_row");
    if (cells.length > headerCells.length) reasons.push("long_row");

    const fields: Partial<Record<StatementField, string>> = {};
    headerCells.forEach((rawHeader, idx) => {
      const field = map.headers[foldHeader(rawHeader)];
      if (field === undefined) return;
      const cell = cells[idx];
      if (cell === undefined) return;
      const value = cell.trim();
      if (value !== "") fields[field] = value;
    });

    const attributionRef = fields.attributionRef ?? null;
    const partnerRef = fields.partnerRef ?? null;
    // A line naming NEITHER reference cannot be resolved by any join, fuzzy or otherwise. It is
    // refused here rather than disputed, because there is nothing for a human to decide about it.
    if (attributionRef === null && partnerRef === null) reasons.push("missing_required");

    const amountPaise = parsePaise(fields.amountPaise);
    if (amountPaise === null) reasons.push("bad_amount");

    const period = fields.period ?? null;
    if (period !== null && !PERIOD_RE.test(period)) reasons.push("bad_period");

    rows.push({ rowNo: i + 1, line, attributionRef, partnerRef, amountPaise, period, reasons });
  }
  return { map, headerCells, rows };
}

export type StatementLineOutcome =
  | { rowNo: number; outcome: "quarantined"; reason: StatementQuarantineReason }
  | { rowNo: number; outcome: "matched"; expectationId: string; attributionId: string; accrualId: string; amountPaise: number }
  | { rowNo: number; outcome: "corrected"; expectationId: string; attributionId: string; accrualId: string | null; correctsPeriod: string; deltaPaise: number }
  | { rowNo: number; outcome: "disputed"; expectationId: string; attributionId: string | null; reason: StatementQuarantineReason };

export type StatementImportResult = {
  counterpartyId: string;
  statementRef: string;
  statementPeriod: string;
  columnMapVersion: string;
  linesTotal: number;
  linesMatched: number;
  linesDisputed: number;
  linesCorrected: number;
  linesQuarantined: number;
  /** The money this statement CONFIRMED — the sum of the ledger rows it wrote, corrections included. */
  confirmedPaise: number;
  lines: StatementLineOutcome[];
};

export type ImportStatementInput = {
  counterpartyId: string;
  /** The partner's own reference for this statement — it is also the quarantine batch id. */
  statementRef: string;
  /** `YYYY-Mnn` / `YYYY-Qn`, IST — `periodKeyFor`'s vocabulary, because `periodSettled` reads it. */
  statementPeriod: string;
  csv: string;
  columnMapVersion?: string;
};

/**
 * ONE STATEMENT, ONE TRANSACTION, IMPORTED ONCE.
 *
 * The whole file is PARSED before anything is written (the `parseReconCsv` precedent), and every
 * write below happens in one transaction — so a statement that fails halfway leaves neither
 * expectations nor quarantine rows behind, and a human re-sends the corrected file rather than
 * reconciling a half-applied one.
 *
 * **THE PERIOD VOCABULARY IS `periodKeyFor`'s, AND IT HAS TO BE.** `kicker.ts`'s `periodSettled`
 * treats a period as closed once any line of that counterparty's statement for it reaches
 * `matched`, and it looks the period up by string equality on `statement_period`. Two lanes
 * spelling one quarter differently would never agree that it was settled, so the spelling is
 * validated here against the same function that produces it.
 */
export async function importStatement(
  db: Db,
  actor: Actor,
  input: ImportStatementInput,
  at: Date,
): Promise<StatementImportResult> {
  requireReceivableLane();

  const statementRef = input.statementRef.trim();
  if (statementRef === "") {
    throw new PartnersError("statement_columns_unknown", "a statement must carry its own reference");
  }
  if (!PERIOD_RE.test(input.statementPeriod)) {
    throw new PartnersError(
      "statement_columns_unknown",
      `statementPeriod must be ${periodKeyFor("month", at)} or ${periodKeyFor("quarter", at)} shaped (IST), got "${input.statementPeriod}"`,
      { statementPeriod: input.statementPeriod },
    );
  }

  const facts = await counterpartyFacts(db, input.counterpartyId);
  if (facts === null) {
    throw new PartnersError("unknown_counterparty", `no counterparty ${input.counterpartyId}`);
  }

  // The unique index is the structural guard; this is the LEGIBLE one in front of it. A partner
  // re-sending last month's file by mistake gets a sentence, not an integrity error.
  const alreadyImported = await db
    .select({ id: receivableExpectations.id })
    .from(receivableExpectations)
    .where(
      and(
        eq(receivableExpectations.counterpartyId, input.counterpartyId),
        eq(receivableExpectations.statementRef, statementRef),
      ),
    )
    .limit(1);
  if (alreadyImported[0] !== undefined) {
    throw new PartnersError(
      "statement_already_imported",
      `statement "${statementRef}" has already been imported for ${input.counterpartyId}`,
      { statementRef, counterpartyId: input.counterpartyId },
    );
  }

  const parsed = parseStatement(input.csv, input.columnMapVersion);

  return withTx(db, async (tx) => {
    const outcomes: StatementLineOutcome[] = [];
    const quarantine: { rowNo: number; reason: StatementQuarantineReason; line: string }[] = [];
    let confirmedPaise = 0;

    for (const row of parsed.rows) {
      if (row.reasons.length > 0 || row.amountPaise === null) {
        const reason = row.reasons[0] ?? "bad_amount";
        quarantine.push({ rowNo: row.rowNo, reason, line: row.line });
        outcomes.push({ rowNo: row.rowNo, outcome: "quarantined", reason });
        continue;
      }
      const amountPaise = row.amountPaise;

      // ── THE ONLY JOIN (V7). Two exact lookups in `reconcile.ts` and nothing after them. ──
      const resolution = await resolveStatementRef(tx, input.counterpartyId, {
        attributionCode: row.attributionRef,
        partnerRef: row.partnerRef,
      });

      // ── V1 — a claim against a slip this hospital never issued. Disputed, never accrued. ──
      if (resolution.outcome === "unknown") {
        const id = await insertDisputed(tx, {
          counterpartyId: input.counterpartyId, attributionId: null, amountPaise,
          statementRef, statementPeriod: input.statementPeriod, statementLineNo: row.rowNo,
          reason: "unknown_attribution", actorId: actor.id, at,
        });
        quarantine.push({ rowNo: row.rowNo, reason: "unknown_attribution", line: row.line });
        outcomes.push({ rowNo: row.rowNo, outcome: "disputed", expectationId: id, attributionId: null, reason: "unknown_attribution" });
        await appendEvent(tx, expectationDisputed.make({
          actor, occurredAt: at,
          idempotencyKey: `partners.expectation_disputed:${input.counterpartyId}:${statementRef}:${String(row.rowNo)}`,
          payload: {
            expectationId: id, counterpartyId: input.counterpartyId, attributionId: null,
            statementRef, statementLineNo: row.rowNo, amountPaise, reason: "unknown_attribution",
          },
        }));
        continue;
      }

      // ── V6 — DD13's rule, stated: the partner whose id is on the slip is the partner with the
      //    claim. The foreign attribution id is RECORDED on the row, because "who else claimed
      //    this referral" is the whole evidence of the dispute.
      if (resolution.counterpartyId !== input.counterpartyId) {
        const id = await insertDisputed(tx, {
          counterpartyId: input.counterpartyId, attributionId: resolution.attributionId, amountPaise,
          statementRef, statementPeriod: input.statementPeriod, statementLineNo: row.rowNo,
          reason: "attribution_partner_mismatch", actorId: actor.id, at,
        });
        quarantine.push({ rowNo: row.rowNo, reason: "attribution_partner_mismatch", line: row.line });
        outcomes.push({
          rowNo: row.rowNo, outcome: "disputed", expectationId: id,
          attributionId: resolution.attributionId, reason: "attribution_partner_mismatch",
        });
        await appendEvent(tx, expectationDisputed.make({
          actor, occurredAt: at,
          idempotencyKey: `partners.expectation_disputed:${input.counterpartyId}:${statementRef}:${String(row.rowNo)}`,
          payload: {
            expectationId: id, counterpartyId: input.counterpartyId, attributionId: resolution.attributionId,
            statementRef, statementLineNo: row.rowNo, amountPaise, reason: "attribution_partner_mismatch",
          },
        }));
        continue;
      }

      /**
       * PLAN 09a DD4 — THE SERIALIZER THE PAYABLE LANE ALWAYS HAD AND THIS ONE DID NOT.
       *
       * Without `for update` this is a read-modify-write with nothing holding the row: two
       * statements quoting ONE slip both read it `expected`, both matched it, and both appended a
       * full receivable accrual. Plan 09's T7 gate measured 7 of 8 trials double-counting; this
       * phase's own fail-first measured **8 of 8**.
       *
       * The lock is what makes the second import WAIT. When it wakes, the winner has set `state` to
       * `matched`, `state = 'expected'` no longer holds, and the loser takes the V3 correction path
       * below — which computes `claimed − already-confirmed` = 0 for an honest duplicate and appends
       * no row.
       *
       * ═══ TWO CLAIMS THAT WOULD BE WRONG TO MAKE HERE, BOTH CORRECTED BY THE CLOSE REVIEW ═══
       *
       * **(1) The re-evaluation does NOT simply return nothing.** With `order by seq limit 1 for
       * update` the `LockRows` node sits above the `Sort` and below the `Limit`, so Postgres
       * RE-SCANS: given two open rows the loser blocks and then returns the SECOND one (measured,
       * 1,398 ms, returned `r2`). The loser finds nothing here for a NARROWER reason, and it is an
       * INVARIANT rather than a mechanism: `issueAttribution` is the only writer of
       * `state = 'expected'`, it writes exactly one row per attribution, and no path returns a row to
       * `expected`. **If a second open expectation per attribution ever becomes reachable, this
       * lookup quietly starts matching it — and this paragraph is the thing that was wrong.**
       *
       * **(2) The partner is NOT owed the money once "however the two imports interleave".** That
       * holds only where both statements quote the SAME amount. Quoting DIFFERENT amounts, the total
       * depends on which import wins this lock: the winner's figure stands and the loser's is
       * absorbed as a V3 correction — or disputed, if it arrived first and met the open claim. The
       * absorption is Plan 09's ruled V3 behaviour (`G4/V3` pins an upward correction to 75 000 over
       * a 60 000 expectation deliberately); what concurrency adds is that "later" is decided by a
       * lock rather than by an operator. **Recorded as an open item gating the receivable flag, and
       * NOT fixed here: overturning V3 is the owner's ruling to make, not a lock's to smuggle.**
       *
       * `statements.contention.test.ts` asserts the BLOCK and not merely the outcome, because a
       * forced interleave ends identically with and without a lock (§3 Q6 / §3.21).
       */
      const open = await tx
        .select()
        .from(receivableExpectations)
        .where(
          and(
            eq(receivableExpectations.attributionId, resolution.attributionId),
            eq(receivableExpectations.counterpartyId, input.counterpartyId),
            eq(receivableExpectations.state, "expected"),
          ),
        )
        .orderBy(asc(receivableExpectations.seq))
        .limit(1)
        .for("update");
      const claim = open[0];

      // ── V3 — nothing open: this statement is amending a period that has already been settled. ──
      if (claim === undefined) {
        const correction = await appendCorrection(tx, {
          actor, at, counterpartyId: input.counterpartyId, attributionId: resolution.attributionId,
          amountPaise, statementRef, statementPeriod: input.statementPeriod,
          statementLineNo: row.rowNo, linePeriod: row.period, actorId: actor.id,
        });
        confirmedPaise += correction.deltaPaise;
        outcomes.push({
          rowNo: row.rowNo, outcome: "corrected", expectationId: correction.expectationId,
          attributionId: resolution.attributionId, accrualId: correction.accrualId,
          correctsPeriod: correction.correctsPeriod, deltaPaise: correction.deltaPaise,
        });
        continue;
      }

      // ── The partner's figure disagrees with ours. Disputed, and NO money is recorded: the
      //    row keeps OUR number, and `import_quarantine` keeps the partner's line verbatim.
      if (claim.amountPaise !== amountPaise) {
        await tx
          .update(receivableExpectations)
          .set({
            state: "disputed", disputeReason: "amount_mismatch", statementRef,
            statementPeriod: input.statementPeriod, statementLineNo: row.rowNo,
            updatedBy: actor.id, updatedAt: at,
          })
          .where(eq(receivableExpectations.id, claim.id));
        quarantine.push({ rowNo: row.rowNo, reason: "amount_mismatch", line: row.line });
        outcomes.push({
          rowNo: row.rowNo, outcome: "disputed", expectationId: claim.id,
          attributionId: resolution.attributionId, reason: "amount_mismatch",
        });
        await appendEvent(tx, expectationDisputed.make({
          actor, occurredAt: at,
          idempotencyKey: `partners.expectation_disputed:${input.counterpartyId}:${statementRef}:${String(row.rowNo)}`,
          payload: {
            expectationId: claim.id, counterpartyId: input.counterpartyId, attributionId: resolution.attributionId,
            statementRef, statementLineNo: row.rowNo, amountPaise, reason: "amount_mismatch",
          },
        }));
        continue;
      }

      // ── MATCHED. The claim is confirmed, so the LEDGER records the money (DD5). ──
      await tx
        .update(receivableExpectations)
        .set({
          state: "matched", statementRef, statementPeriod: input.statementPeriod,
          statementLineNo: row.rowNo, matchedAt: at, updatedBy: actor.id, updatedAt: at,
        })
        .where(eq(receivableExpectations.id, claim.id));
      const accrualId = await appendReceivable(tx, {
        counterpartyId: input.counterpartyId, payeeClass: facts.payeeClass,
        attributionId: resolution.attributionId, expectationId: claim.id,
        agreementId: claim.agreementId, amountPaise, kind: "accrual",
        periodKey: input.statementPeriod, statementRef, statementLineNo: row.rowNo,
        pinnedAt: claim.expectedAt, occurredAt: at,
      });
      confirmedPaise += amountPaise;
      outcomes.push({
        rowNo: row.rowNo, outcome: "matched", expectationId: claim.id,
        attributionId: resolution.attributionId, accrualId, amountPaise,
      });
    }

    if (quarantine.length > 0) {
      await tx.insert(importQuarantine).values(quarantine.map((q) => ({
        id: newId(),
        source: "partner_statement",
        batchId: statementRef,
        rowNo: q.rowNo,
        reason: q.reason,
        raw: { line: q.line },
      })));
    }

    const linesMatched = outcomes.filter((o) => o.outcome === "matched").length;
    const linesDisputed = outcomes.filter((o) => o.outcome === "disputed").length;
    const linesCorrected = outcomes.filter((o) => o.outcome === "corrected").length;
    const linesQuarantined = outcomes.filter((o) => o.outcome === "quarantined").length;

    await appendEvent(tx, statementImported.make({
      actor,
      occurredAt: at,
      idempotencyKey: `partners.statement_imported:${input.counterpartyId}:${statementRef}`,
      payload: {
        counterpartyId: input.counterpartyId, statementRef, statementPeriod: input.statementPeriod,
        columnMapVersion: parsed.map.version,
        linesTotal: parsed.rows.length, linesMatched, linesDisputed, linesCorrected, linesQuarantined,
        // SIGNED, and never clamped: a statement that is net a downward correction really did
        // confirm a negative total, and an event that said 0 would disagree with the ledger row it
        // is describing.
        confirmedPaise,
      },
    }));

    return {
      counterpartyId: input.counterpartyId, statementRef, statementPeriod: input.statementPeriod,
      columnMapVersion: parsed.map.version,
      linesTotal: parsed.rows.length, linesMatched, linesDisputed, linesCorrected, linesQuarantined,
      confirmedPaise, lines: outcomes,
    };
  }).catch((e: unknown) => {
    throw mapImportConflict(e, statementRef, input.counterpartyId);
  });
}

/**
 * PLAN 09a CLOSE — the two Postgres refusals T4's row lock made reachable, given sentences.
 *
 * Both were found by the close reviewer, both were measured, and in both the MONEY IS ALREADY
 * CORRECT: the transaction rolls back whole. What was wrong is that an operator got a raw driver
 * error for a situation the system understands perfectly well.
 *
 *  · **`40P01` (deadlock)** — two imports listing the same slips in OPPOSITE order take this lane's
 *    row locks in opposite order. Measured 3/3 under a forced interleave, and 3/3 clean against the
 *    lock-less mutant, so it is T4's to own. **The better repair is a deterministic lock order** —
 *    resolve every row first, then sort by attribution id before the loop — and it is deliberately
 *    NOT taken here: it moves resolution out of the loop and changes the order of `lines` in a
 *    money path's result, which deserves its own task and its own review rather than a close
 *    remediation. Named in the CLOSE as a follow-up.
 *  · **`23505` on `receivable_expectations_statement_line_ux`** — two imports of the SAME
 *    `statementRef` racing. The legible pre-check at the top of `importStatement` runs on `db`
 *    OUTSIDE the transaction, so it cannot see an in-flight twin; the loser collides on the partial
 *    unique index instead. It means exactly what the pre-check means, so it answers the same code.
 *    **Known masking risk, named rather than left to be discovered:** this branch keys on the
 *    CONSTRAINT NAME, not on evidence that a race occurred. If `appendCorrection` ever produced a
 *    genuine duplicate `(counterparty_id, statement_ref, statement_line_no)` through a logic error,
 *    the operator would read "already imported" instead of the loud 500 a logic error deserves.
 *    Only reachable through the race today — `appendCorrection` writes one row per statement line
 *    and the line number is the file's own — so it is a risk this comment carries rather than a
 *    defect this code has.
 */
function mapImportConflict(e: unknown, statementRef: string, counterpartyId: string): unknown {
  const err = e as { code?: unknown; constraint?: unknown };
  if (err.code === "40P01") {
    return new PartnersError(
      "statement_import_conflict",
      `statement "${statementRef}" deadlocked against a concurrent import and was rolled back whole — retry it`,
      { statementRef, counterpartyId, pgCode: "40P01" },
    );
  }
  if (err.code === "23505" && err.constraint === "receivable_expectations_statement_line_ux") {
    return new PartnersError(
      "statement_already_imported",
      `statement "${statementRef}" is being imported concurrently for ${counterpartyId}`,
      { statementRef, counterpartyId, pgCode: "23505" },
    );
  }
  return e;
}

/** V1/V6's row: a claim we did not make, recorded rather than discarded. */
async function insertDisputed(
  tx: Tx,
  input: {
    counterpartyId: string; attributionId: string | null; amountPaise: number;
    statementRef: string; statementPeriod: string; statementLineNo: number;
    reason: StatementQuarantineReason; actorId: string; at: Date;
  },
): Promise<string> {
  const id = newId();
  await tx.insert(receivableExpectations).values({
    id,
    counterpartyId: input.counterpartyId,
    attributionId: input.attributionId,
    // No agreement: this hospital never agreed to this claim, so there is no version that priced it.
    agreementId: null,
    amountPaise: input.amountPaise,
    state: "disputed",
    statementRef: input.statementRef,
    statementPeriod: input.statementPeriod,
    statementLineNo: input.statementLineNo,
    disputeReason: input.reason,
    expectedAt: input.at,
    updatedBy: input.actorId,
    updatedAt: input.at,
    createdAt: input.at,
  });
  return id;
}

/**
 * ONE APPEND-ONLY LEDGER ROW. `subject_id` and `basis_event_id` are both null — the receivable
 * lane answers a STATEMENT, not a dispatched event, and Postgres treats nulls as distinct so
 * `commission_accruals_basis_event_ux` leaves these rows unconstrained. What stops a second row for
 * one line is `receivable_expectations_statement_line_ux` plus the `statement_already_imported`
 * refusal in front of it: a statement cannot be imported twice, so a line cannot accrue twice.
 *
 * `state` is always `accrued` and never `escrowed`. O-7 escrows what the hospital OWES a suspended
 * partner; what a partner owes the hospital "stays collectible" in the ruling's own words, and both
 * payable totals filter on `direction = 'payable'` anyway.
 */
async function appendReceivable(
  tx: Tx,
  input: {
    counterpartyId: string; payeeClass: string; attributionId: string; expectationId: string;
    agreementId: string | null; amountPaise: number; kind: "accrual" | "adjustment";
    periodKey: string; statementRef: string; statementLineNo: number;
    pinnedAt: Date; occurredAt: Date;
  },
): Promise<string> {
  const agreementId = input.agreementId;
  if (agreementId === null) {
    throw new PartnersError(
      "no_effective_agreement",
      `expectation ${input.expectationId} carries no agreement version, so no ledger row can name the terms it was priced under`,
      { expectationId: input.expectationId },
    );
  }
  const agreement = await requireAgreementAt(tx, input.counterpartyId, input.pinnedAt);
  const terms = receivableTermsOf(agreement);
  const id = newId();
  await tx.insert(commissionAccruals).values({
    id,
    subjectId: null,
    counterpartyId: input.counterpartyId,
    payeeClass: input.payeeClass,
    agreementId,
    direction: "receivable",
    invoiceId: null,
    instrumentId: null,
    kind: input.kind,
    state: "accrued",
    amountPaise: input.amountPaise,
    rateSnapshot: receivableSnapshotOf(agreement, terms, input.pinnedAt, {
      attributionId: input.attributionId,
      expectationId: input.expectationId,
      statementRef: input.statementRef,
      statementLineNo: input.statementLineNo,
    }),
    basisEventId: null,
    basisEventName: null,
    periodKey: input.periodKey,
    occurredAt: input.occurredAt,
  });
  return id;
}

/**
 * V3 — THE LATE CORRECTION, AS AN APPEND.
 *
 * The delta is measured against what the LEDGER already says this attribution earned, not against
 * the prior expectation row's number: the ledger is where money lives (DD5), and a partner listing
 * one referral twice at the same figure must move nothing. `deltaPaise` is signed, and a zero delta
 * appends no row at all — an adjustment of nothing is not an adjustment.
 *
 * The period a correction names is the LINE's own `period` column where the map carries one
 * (`partner-statement-v2`), otherwise the period the prior settlement was recorded in, otherwise
 * this statement's. Nothing about the prior row or the prior ledger entry is read for WRITING —
 * both are left exactly as they were, which is what the append-only trigger would enforce anyway.
 */
async function appendCorrection(
  tx: Tx,
  input: {
    actor: Actor; at: Date; counterpartyId: string; attributionId: string; amountPaise: number;
    statementRef: string; statementPeriod: string; statementLineNo: number;
    linePeriod: string | null; actorId: string;
  },
): Promise<{ expectationId: string; accrualId: string | null; correctsPeriod: string; deltaPaise: number }> {
  // What the ledger already confirmed for this attribution. `rate_snapshot->>'attributionId'` is
  // the link because `commission_accruals` carries no attribution column — the seventeen-table
  // budget, recorded in the phase relay — and the slice is one counterparty's receivable rows.
  const priorRows = (await tx.execute(sql`
    select coalesce(sum(amount_paise), 0) as total from commission_accruals
    where counterparty_id = ${input.counterpartyId}
      and direction = 'receivable'
      and rate_snapshot->>'attributionId' = ${input.attributionId}
  `)).rows as { total: string | number }[];
  const priorPaise = Number(priorRows[0]!.total);
  const deltaPaise = input.amountPaise - priorPaise;

  // The period this correction amends: the line's own, else the one the prior settlement was
  // recorded in, else this statement's.
  const prior = await tx
    .select({ statementPeriod: receivableExpectations.statementPeriod, agreementId: receivableExpectations.agreementId, expectedAt: receivableExpectations.expectedAt })
    .from(receivableExpectations)
    .where(
      and(
        eq(receivableExpectations.attributionId, input.attributionId),
        eq(receivableExpectations.counterpartyId, input.counterpartyId),
      ),
    )
    .orderBy(asc(receivableExpectations.seq))
    .limit(1);
  const priorRow = prior[0];
  const correctsPeriod = input.linePeriod ?? priorRow?.statementPeriod ?? input.statementPeriod;

  const expectationId = newId();
  await tx.insert(receivableExpectations).values({
    id: expectationId,
    counterpartyId: input.counterpartyId,
    attributionId: input.attributionId,
    agreementId: priorRow?.agreementId ?? null,
    amountPaise: input.amountPaise,
    state: "matched",
    statementRef: input.statementRef,
    statementPeriod: input.statementPeriod,
    statementLineNo: input.statementLineNo,
    disputeReason: null,
    expectedAt: priorRow?.expectedAt ?? input.at,
    matchedAt: input.at,
    updatedBy: input.actorId,
    updatedAt: input.at,
    createdAt: input.at,
  });

  let accrualId: string | null = null;
  if (deltaPaise !== 0) {
    const facts = await counterpartyFacts(tx, input.counterpartyId);
    accrualId = await appendReceivable(tx, {
      counterpartyId: input.counterpartyId,
      payeeClass: facts!.payeeClass,
      attributionId: input.attributionId,
      expectationId,
      agreementId: priorRow?.agreementId ?? null,
      amountPaise: deltaPaise,
      kind: "adjustment",
      periodKey: correctsPeriod,
      statementRef: input.statementRef,
      statementLineNo: input.statementLineNo,
      pinnedAt: priorRow?.expectedAt ?? input.at,
      occurredAt: input.at,
    });
    await appendEvent(tx, expectationCorrected.make({
      actor: input.actor,
      occurredAt: input.at,
      idempotencyKey: `partners.expectation_corrected:${input.statementRef}:${String(input.statementLineNo)}`,
      payload: {
        expectationId, counterpartyId: input.counterpartyId, attributionId: input.attributionId,
        accrualId, correctsPeriod, statementRef: input.statementRef, deltaPaise,
      },
    }));
  }

  return { expectationId, accrualId, correctsPeriod, deltaPaise };
}

/** Every line one statement refused, verbatim — the answer to "we billed you for that referral". */
export async function listStatementQuarantine(
  exec: Db | Tx,
  statementRef: string,
): Promise<{ id: string; rowNo: number; reason: string; line: string }[]> {
  const rows = await exec
    .select({
      id: importQuarantine.id,
      rowNo: importQuarantine.rowNo,
      reason: importQuarantine.reason,
      raw: importQuarantine.raw,
      source: importQuarantine.source,
    })
    .from(importQuarantine)
    .where(and(eq(importQuarantine.batchId, statementRef), eq(importQuarantine.source, "partner_statement")))
    .orderBy(asc(importQuarantine.rowNo), asc(importQuarantine.seq));
  return rows.map((r) => ({
    id: r.id,
    rowNo: r.rowNo,
    reason: r.reason,
    // Tolerant of a `raw` this lane did not write, exactly as `listQuarantine` is: the two lanes
    // share one table and neither may take the other down by shipping a shape it does not know.
    line: typeof (r.raw as { line?: unknown }).line === "string" ? (r.raw as { line: string }).line : "",
  }));
}
