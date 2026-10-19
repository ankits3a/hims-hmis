import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { labAnalytes, labResults, orderItems, orders, services } from "../../src/kernel/db/schema";
import type { Db } from "../../src/kernel/db/client";

/**
 * A SIGNED serum creatinine on the lab's own rows (analyte CREA, mg/dL), verified at `verifiedAt` and
 * with no specimen row, so `latestVerifiedCreatinine` dates it by `verified_at`. The same shape
 * `radiology/prep-bay.test.ts` writes inline; shared here for the renal dose check (#621).
 */
export async function signedCreatinine(
  db: Db, patientId: string, mgDl: string, verifiedAt: Date, status: "verified" | "unverified" = "verified",
): Promise<string> {
  const svc = newId();
  await db.insert(services).values({ id: svc, code: `LAB-${svc.slice(-6)}`, name: "Creatinine", category: "investigation", createdBy: "t", updatedBy: "t" });
  const existing = await db.select().from(labAnalytes).where(eq(labAnalytes.code, "CREA"));
  const analyteId = existing[0]?.id ?? newId();
  if (!existing[0]) {
    await db.insert(labAnalytes).values({ id: analyteId, code: "CREA", nameEn: "Creatinine", resultType: "numeric", unit: "mg/dL", createdBy: "t", updatedBy: "t" });
  }
  const orderId = newId();
  await db.insert(orders).values({
    id: orderId, orderNo: `L${orderId.slice(-8)}`, orderGroupId: orderId, kind: "lab", patientId,
    encounterNo: "V-LAB-TEST", serviceDate: verifiedAt.toISOString().slice(0, 10), priority: "routine", authority: "clinician",
    orderedByType: "user", orderedById: "t", placedAt: verifiedAt,
  });
  const itemId = newId();
  await db.insert(orderItems).values({ id: itemId, orderId, serviceId: svc });
  const resultId = newId();
  await db.insert(labResults).values({
    id: resultId, orderItemId: itemId, analyteId, valueNumeric: mgDl, unit: "mg/dL",
    enteredByType: "user", enteredById: "t", entryMode: "manual",
    verificationStatus: status, verifiedBy: status === "verified" ? "path" : null,
    verifiedAt: status === "verified" ? verifiedAt : null,
  });
  return resultId;
}
