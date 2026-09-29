import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { labAnalytes, labResults, labSpecimens, orderItems, orders } from "../../kernel/db/schema";
import { listMergedLoserIds } from "../patients";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 18-S RS5 (radiology, the kidney gate) — **the latest SIGNED serum creatinine for a patient.**
 *
 * The imaging kidney gate asks one question of the lab: *what is this patient's most recent
 * creatinine, and when was the blood drawn?* This answers it from the lab's own rows so a prep nurse
 * does not copy a number off a report by hand.
 *
 * WHAT COUNTS, AND BY WHICH RULE:
 *  · **The analyte code is `CREA`** — the catalogue's serum creatinine. Urine creatinine and
 *    creatinine clearance carry other codes and are not this number.
 *  · **`verified` only, not superseded** — the same line `patientResultsForDoctor` draws: an
 *    unsigned number is a working note, not evidence for a safety gate.
 *  · **Restricted items are skipped** — a creatinine is never ordered restricted, and a read that
 *    could surface a restricted test's existence to the imaging bay is not worth the edge case.
 *  · **The whole merge chain** — a creatinine drawn under a duplicate UHID is still this patient's.
 *  · **Units:** `mg/dL` is converted (× 88.42); `µmol/L` / `umol/L` is taken as is; a row in any
 *    other unit is skipped rather than guessed at.
 *  · **`sampledAt` is the specimen's collection instant** (the validity window is about when the
 *    blood was drawn), falling back to the verification instant for a row with no specimen.
 *
 * No PHI row is written here: the caller (the imaging prep read) logs its own disclosure.
 */
export const CREATININE_ANALYTE_CODES: readonly string[] = ["CREA"];

const UMOL_PER_MG_DL = 88.42;

export type LatestCreatinine = {
  resultId: string;
  valueUmolL: number;
  /** As the bench reported it, with its unit — the screen shows both. */
  reported: { value: string; unit: string | null };
  sampledAt: Date;
  verifiedAt: Date;
};

function toUmolL(value: number, unit: string | null): number | null {
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "mg/dl") return value * UMOL_PER_MG_DL;
  if (u === "µmol/l" || u === "umol/l" || u === "μmol/l") return value;
  return null;
}

export async function latestVerifiedCreatinine(
  exec: Db | Tx, patientId: string,
): Promise<LatestCreatinine | null> {
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
      inArray(labAnalytes.code, [...CREATININE_ANALYTE_CODES]),
      eq(labResults.verificationStatus, "verified"),
      eq(orderItems.restricted, false),
      sql`${labResults.valueNumeric} is not null`,
      sql`${labResults.verifiedAt} is not null`,
      sql`not ${superseded}`,
    ))
    .orderBy(desc(sql`coalesce(${labSpecimens.collectedAt}, ${labResults.verifiedAt})`))
    .limit(10);

  for (const r of rows) {
    const value = Number(r.valueNumeric);
    const umol = toUmolL(value, r.unit);
    if (umol === null || !(umol > 0)) continue;
    return {
      resultId: r.id,
      valueUmolL: umol,
      reported: { value: r.valueNumeric!, unit: r.unit },
      sampledAt: r.collectedAt ?? r.verifiedAt!,
      verifiedAt: r.verifiedAt!,
    };
  }
  return null;
}
