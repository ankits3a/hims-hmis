import { getTableColumns } from "drizzle-orm";
import { patients } from "../../kernel/db/schema";
import { accrualLedger } from "./accrual";
import { agingReport } from "./aging";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 09 T8 / DD15 — "NOTHING PARTNER-FACING CARRIES IDENTITY" AS A FUNCTION THAT REFUSES, NOT
 * ONLY A TEST THAT NOTICES.
 *
 * `aging.test.ts` (T7) and `accrual.ts`'s own row shape are already identity-free BY CONSTRUCTION
 * — their queries never reach `patients` — and their own tests walk the output and confirm it. This
 * file exists for the NEXT partner-visible surface this phase adds and every one after it:
 * `exportCounterpartyStatement` below, the shape this hospital would actually hand a partner (or an
 * auditor) — every commission-ledger row and every open or contested receivable claim for one
 * counterparty, reshaped to instrument ids, attribution ids, states and amounts.
 *
 * ═══ WHY THE GUARD IS PRODUCTION CODE, NOT A TEST-SIDE HABIT ═══
 *
 * `aging.test.ts`'s DD15 legs re-derive the patients-table column list and walk the report's keys
 * INSIDE THE TEST — which proves that ONE reader is identity-free on the day the test is written,
 * but a second reader (this one) would have to copy the same walk into a second test to get the
 * same guarantee, and a third would copy it again. `assertIdentityFree` is that walk, written once,
 * called by the function that builds the export AND by whatever calls it next — so a later screen
 * or a later export cannot reintroduce a patient field without an exception at the point it tried,
 * not only a red test somebody has to notice.
 *
 * ═══ THE COLUMN LIST IS READ FROM THE SCHEMA, NEVER TRANSCRIBED (aging.test.ts's own discipline) ═══
 *
 * A column added to `patients` next year is caught without anybody remembering to update a list
 * here.
 */

const PATIENT_COLUMN_NAMES: ReadonlySet<string> = new Set(
  Object.entries(getTableColumns(patients)).flatMap(([tsName, column]) => [
    tsName.toLowerCase(), column.name.toLowerCase(),
  ]),
);

/** Every key of every object in `value`, however deeply nested — `Date`s are leaves, not objects. */
function keyPaths(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keyPaths(v, out);
    return out;
  }
  if (value instanceof Date) return out;
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.add(k);
    keyPaths(v, out);
  }
  return out;
}

/** Every patients-table column name found anywhere among `value`'s own keys, however deep. */
export function identityLeaks(value: unknown): string[] {
  return [...keyPaths(value)].filter((k) => PATIENT_COLUMN_NAMES.has(k.toLowerCase()));
}

/**
 * DD15 as a REFUSAL. `context` names what was being built, so a thrown message is actionable
 * rather than a bare stack trace three modules away from the query that caused it.
 */
export function assertIdentityFree(value: unknown, context: string): void {
  const leaks = identityLeaks(value);
  if (leaks.length > 0) {
    throw new Error(`${context}: identity-bearing field(s) [${leaks.join(", ")}] refused (DD15)`);
  }
}

export type PartnerExportRow = {
  /**
   * NOT `id` — `patients.id` is itself a patients-table column, so a bare `id` key would be an
   * unconditional false positive under `identityLeaks` (every row in this system has one) and
   * would mask a real leak inside the noise. `aging.ts`'s `AgingItem` made the same choice
   * (`expectationId`, never `id`) for the same reason; this is that convention, generalised.
   */
  rowId: string;
  kind: "commission" | "receivable";
  counterpartyId: string;
  instrumentId: string | null;
  attributionId: string | null;
  amountPaise: number;
  state: string;
  periodKey: string | null;
  occurredAt: Date;
};

export type PartnerExport = {
  counterpartyId: string;
  asOf: Date;
  rows: PartnerExportRow[];
};

/**
 * THE THING A PARTNER COULD ACTUALLY BE HANDED. Built from two readers T6 and T7 already ship
 * (`accrualLedger`, `agingReport`) rather than a third query over the same tables, so this function
 * cannot disagree with the channel P&L or the receivables desk about what a row means — and DD15's
 * guard runs over the finished rows before they leave this function, so a future change to either
 * reader that quietly joined in a patient column is refused HERE rather than discovered by a partner
 * holding a printout.
 */
export async function exportCounterpartyStatement(
  exec: Db | Tx,
  input: { counterpartyId: string; asOf: Date },
): Promise<PartnerExport> {
  const [ledger, aging] = await Promise.all([
    accrualLedger(exec, { counterpartyId: input.counterpartyId }),
    agingReport(exec, { counterpartyId: input.counterpartyId, asOf: input.asOf }),
  ]);

  const rows: PartnerExportRow[] = [
    ...ledger.map((r) => ({
      rowId: r.id,
      kind: "commission" as const,
      counterpartyId: r.counterpartyId,
      instrumentId: r.instrumentId,
      attributionId: null,
      amountPaise: r.amountPaise,
      state: r.state,
      periodKey: r.periodKey,
      occurredAt: r.occurredAt,
    })),
    ...aging.items.map((i) => ({
      rowId: i.expectationId,
      kind: "receivable" as const,
      counterpartyId: i.counterpartyId,
      instrumentId: null,
      attributionId: i.attributionId,
      amountPaise: i.amountPaise,
      state: i.state,
      periodKey: i.statementPeriod,
      occurredAt: i.expectedAt,
    })),
  ];

  assertIdentityFree(rows, "partner export");
  return { counterpartyId: input.counterpartyId, asOf: input.asOf, rows };
}
