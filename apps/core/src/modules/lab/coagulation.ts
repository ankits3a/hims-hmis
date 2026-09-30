import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { labAnalytes, labResults, labSpecimens, orderItems, orders } from "../../kernel/db/schema";
import { listMergedLoserIds } from "../patients";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 18-S RS12b (radiology, the IR suite) — **the latest SIGNED INR and platelet count for a patient.**
 *
 * The interventional sign-in asks the lab two questions before a needle goes into a kidney or a
 * liver: *what is this patient's latest INR, and latest platelet count, and when was the blood
 * drawn?* Same rules as `latestVerifiedCreatinine` (RS5), for the same reasons:
 *
 *  · **`verified` only, not superseded, not restricted, across the merge chain.**
 *  · **`sampledAt` is the specimen's collection instant**, falling back to verification — the
 *    seven-day window is about when the blood was drawn.
 *  · **Units.** INR is a ratio: a blank unit, `INR` or `ratio` is taken as is; any other unit is
 *    skipped. Platelets are returned per µL: `10^3/uL` / `x10^3/µL` / `10^9/L` / `K/uL` ×1,000,
 *    `lakh/cumm` / `lakhs/µL` ×100,000, `/uL` / `/cumm` as is. A row in any other unit is skipped
 *    rather than guessed at — a platelet count off by a thousand is the one mistake this read exists
 *    to prevent.
 *
 * No PHI row is written here: the caller (the IR case read) logs its own disclosure.
 */
export const INR_ANALYTE_CODES: readonly string[] = ["INR"];
export const PLATELET_ANALYTE_CODES: readonly string[] = ["PLT"];

export type LatestLabNumber = {
  resultId: string;
  /** INR as a ratio; platelets per µL. */
  value: number;
  reported: { value: string; unit: string | null };
  sampledAt: Date;
  verifiedAt: Date;
};

function normUnit(unit: string | null): string {
  return (unit ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/[µμ]/g, "u").replace("×", "x");
}

export function inrFromReported(value: number, unit: string | null): number | null {
  const u = normUnit(unit);
  return u === "" || u === "inr" || u === "ratio" ? value : null;
}

const PLATELET_FACTORS: Record<string, number> = {
  "10^3/ul": 1_000, "x10^3/ul": 1_000, "10^9/l": 1_000, "x10^9/l": 1_000, "k/ul": 1_000, "thou/ul": 1_000,
  "10^3/cumm": 1_000, "x10^3/cumm": 1_000,
  "lakh/cumm": 100_000, "lakhs/cumm": 100_000, "lakh/ul": 100_000, "lakhs/ul": 100_000,
  "/ul": 1, "/cumm": 1, "cells/ul": 1,
};

export function plateletsPerUlFromReported(value: number, unit: string | null): number | null {
  const factor = PLATELET_FACTORS[normUnit(unit)];
  return factor === undefined ? null : Math.round(value * factor);
}

async function latestVerifiedNumber(
  exec: Db | Tx, patientId: string, codes: readonly string[], convert: (value: number, unit: string | null) => number | null,
): Promise<LatestLabNumber | null> {
  const chainIds = [patientId, ...(await listMergedLoserIds(exec, patientId))];
  const superseded = sql`exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`;
  const rows = await (exec as Db)
    .select({
      id: labResults.id, valueNumeric: labResults.valueNumeric, unit: labResults.unit,
      verifiedAt: labResults.verifiedAt, collectedAt: labSpecimens.collectedAt,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .leftJoin(labSpecimens, eq(labSpecimens.id, labResults.specimenId))
    .where(and(
      inArray(orders.patientId, chainIds),
      inArray(labAnalytes.code, [...codes]),
      eq(labResults.verificationStatus, "verified"),
      eq(orderItems.restricted, false),
      sql`${labResults.valueNumeric} is not null`,
      sql`${labResults.verifiedAt} is not null`,
      sql`not ${superseded}`,
    ))
    .orderBy(desc(sql`coalesce(${labSpecimens.collectedAt}, ${labResults.verifiedAt})`))
    .limit(10);

  for (const r of rows) {
    const value = convert(Number(r.valueNumeric), r.unit);
    if (value === null || !(value > 0)) continue;
    return {
      resultId: r.id,
      value,
      reported: { value: r.valueNumeric!, unit: r.unit },
      sampledAt: r.collectedAt ?? r.verifiedAt!,
      verifiedAt: r.verifiedAt!,
    };
  }
  return null;
}

export async function latestVerifiedInr(exec: Db | Tx, patientId: string): Promise<LatestLabNumber | null> {
  return latestVerifiedNumber(exec, patientId, INR_ANALYTE_CODES, inrFromReported);
}

export async function latestVerifiedPlatelets(exec: Db | Tx, patientId: string): Promise<LatestLabNumber | null> {
  return latestVerifiedNumber(exec, patientId, PLATELET_ANALYTE_CODES, plateletsPerUlFromReported);
}
