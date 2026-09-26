import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { labAnalytes, labOrderables, labResults, orderItems, orders } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — WHAT THE LAB RELEASES TO THE NATIONAL NETWORK, READ BY THE LAB ═══
 *
 * One row per TEST (order item) of the named visits, each with its releasable values. The ABDM
 * connector builds a DiagnosticReportRecord (DiagnosticReportLab + Observations) from this and from
 * nothing else.
 *
 * THE EXCLUSIONS ARE THE BRIEF'S (`patient-results.ts`), APPLIED FOR A READER WHO IS NOBODY INSIDE:
 *  · **Unverified values** — `verification_status = 'verified'` with a `verified_at`, exactly.
 *  · **Superseded values** — a verified row a later row supersedes is the bench's working-out.
 *  · **Restricted tests (DD11)** — the brief shows them to the ordering clinician or a holder of
 *    `orders.read.restricted`. An HIU is neither, so a restricted test is OMITTED, not counted: for an
 *    HIV test the existence of the test is the sensitive fact, and it must not reach a PHR app.
 *  · **A test that reports foetal sex** (`reports_foetal_sex`) — never released (PCPNDT Act s.5/s.6).
 *    `lab_orderables_no_foetal_sex_ck` already forbids such a test existing; the clause is kept so
 *    this reader's rule does not depend on a constraint in another file staying put.
 *  · Cancelled items.
 * No actor and no PHI row here; the connector audits the disclosure against the patient.
 */
export type LabReleaseValue = {
  resultId: string;
  analyteName: string;
  loincCode: string | null;
  valueNumeric: string | null;
  valueText: string | null;
  unit: string | null;
  flag: string | null;
  refLow: string | null;
  refHigh: string | null;
  refText: string | null;
  verifiedAt: Date;
  remarks: string | null;
};
export type LabReleaseTest = {
  orderItemId: string;
  orderNo: string;
  encounterNo: string;
  patientId: string;
  testName: string;
  testCode: string;
  /** The latest verification among its values — the report's `issued`. */
  issuedAt: Date;
  values: LabReleaseValue[];
};

export async function verifiedLabTestsForRelease(db: Db | Tx, encounterNos: readonly string[]): Promise<LabReleaseTest[]> {
  const nos = [...new Set(encounterNos)];
  if (nos.length === 0) return [];
  const superseded = sql`exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`;
  const rows = await db
    .select({
      orderItemId: orderItems.id, orderNo: orders.orderNo, encounterNo: orders.encounterNo, patientId: orders.patientId,
      testName: labOrderables.nameEn, testCode: labOrderables.code,
      analyteName: labAnalytes.nameEn, loincCode: labAnalytes.loincCode, r: labResults,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .where(and(
      inArray(orders.encounterNo, nos),
      eq(orders.kind, "lab"),
      ne(orderItems.status, "cancelled"),
      eq(orderItems.restricted, false),
      eq(labOrderables.reportsFoetalSex, false),
      eq(labResults.verificationStatus, "verified"),
      isNotNull(labResults.verifiedAt),
      sql`not ${superseded}`,
    ))
    .orderBy(asc(orders.orderNo), asc(orderItems.id), asc(labAnalytes.nameEn));

  const byItem = new Map<string, LabReleaseTest>();
  for (const row of rows) {
    const r = row.r;
    let test = byItem.get(row.orderItemId);
    if (test === undefined) {
      test = {
        orderItemId: row.orderItemId, orderNo: row.orderNo, encounterNo: row.encounterNo, patientId: row.patientId,
        testName: row.testName, testCode: row.testCode, issuedAt: r.verifiedAt!, values: [],
      };
      byItem.set(row.orderItemId, test);
    }
    if (r.verifiedAt!.getTime() > test.issuedAt.getTime()) test.issuedAt = r.verifiedAt!;
    test.values.push({
      resultId: r.id, analyteName: row.analyteName, loincCode: row.loincCode,
      valueNumeric: r.valueNumeric, valueText: r.valueText ?? r.valueCoded, unit: r.unit, flag: r.flag,
      refLow: r.refLow, refHigh: r.refHigh, refText: r.refText, verifiedAt: r.verifiedAt!, remarks: r.remarks,
    });
  }
  return [...byItem.values()];
}

/** The visit number a lab order was placed against — `lab.report_published` names the order, not the visit. */
export async function encounterNoOfLabOrder(db: Db | Tx, orderId: string): Promise<string | null> {
  const rows = await db.select({ encounterNo: orders.encounterNo }).from(orders).where(and(eq(orders.id, orderId), eq(orders.kind, "lab")));
  return rows[0]?.encounterNo ?? null;
}
