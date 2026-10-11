import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { labOrderables, labQuickReports, opdDepartments, opdDoctors, orderItems, orders } from "../../kernel/db/schema";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { LAB_DEPARTMENT_CODE } from "../opd";
import { BillingError, feeOffNow, loadBillingConfig } from "../billing";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-10-11 — what the lab desk's new-walk-in picker needs beyond the catalogue search
 * (spec `SPEC-lab-desk-flow-2026-10-11.md`).
 */

/**
 * IS THE LAB FEE OFF RIGHT NOW? The desk skips its money step when it is, so it must know — and
 * billing's own switch reader is gated on `billing.reports.read`, which the lab counter does not
 * hold and should not. This answers the one boolean and nothing else of the billing config. A
 * missing config reads as "charged": the safe default is the step that takes money, never the one
 * that skips it.
 */
export async function labFeeFree(db: Db): Promise<boolean> {
  try {
    return feeOffNow((await loadBillingConfig(db)).chargeRules, "lab");
  } catch (e) {
    if (e instanceof BillingError) return false;
    throw e;
  }
}

/**
 * THE COMMON TESTS — the tap-chips above the search: the tests this lab actually ordered most in
 * the last 90 days, topped up from a starter list so a new installation still offers something.
 */
/** The catalogue's own codes (a code the catalogue does not hold simply never shows). */
export const STARTER_COMMON_CODES = ["CBC", "GLUF", "GLUR", "HBA1C", "LFT", "RFT", "LIPID", "TFT", "TSH", "URINE", "ESR", "CRP", "WIDAL", "DENGUE", "MP"];

export type CommonOrderable = { serviceId: string; code: string; nameEn: string; container: string; specimenType: string };

export async function commonOrderables(db: Db, now: Date = new Date(), limit = 12): Promise<CommonOrderable[]> {
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const used = await db
    .select({ serviceId: orderItems.serviceId, n: sql<number>`count(*)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.kind, "lab"), gte(orderItems.createdAt, since)))
    .groupBy(orderItems.serviceId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit * 2);
  const pick = { serviceId: labOrderables.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn,
    container: labOrderables.container, specimenType: labOrderables.specimenType };
  const ranked = used.length === 0 ? [] : await db.select(pick).from(labOrderables)
    .where(and(inArray(labOrderables.serviceId, used.map((u) => u.serviceId)), eq(labOrderables.active, true)));
  const rank = new Map(used.map((u, i) => [u.serviceId, i]));
  const out = ranked.sort((a, b) => (rank.get(a.serviceId) ?? 0) - (rank.get(b.serviceId) ?? 0)).slice(0, limit);
  if (out.length < limit) {
    const starters = await db.select(pick).from(labOrderables)
      .where(and(inArray(labOrderables.code, STARTER_COMMON_CODES), eq(labOrderables.active, true)));
    starters.sort((a, b) => STARTER_COMMON_CODES.indexOf(a.code) - STARTER_COMMON_CODES.indexOf(b.code));
    for (const s of starters) {
      if (out.length >= limit) break;
      if (!out.some((o) => o.serviceId === s.serviceId)) out.push(s);
    }
  }
  return out;
}

/**
 * CAN THIS DESK OPEN A WALK-IN? A walk-in (a patient with no visit today) is a visit to the
 * LABORATORY department under its pathologist of record (`openLabWalkinInTx`), and that refuses
 * when the hospital has not declared the department or put a doctor in it. The desk asks first, so
 * the clerk is told what is missing BEFORE pressing the button, in words the OPD admin can act on —
 * not after, in the server's.
 */
export type WalkInReadiness = { ready: boolean; problem: "no_lab_department" | "lab_department_inactive" | "no_pathologist" | null };

export async function walkInReadiness(db: Db): Promise<WalkInReadiness> {
  const [dept] = await db.select({ id: opdDepartments.id, active: opdDepartments.active })
    .from(opdDepartments).where(eq(opdDepartments.code, LAB_DEPARTMENT_CODE));
  if (!dept) return { ready: false, problem: "no_lab_department" };
  if (!dept.active) return { ready: false, problem: "lab_department_inactive" };
  const [doc] = await db.select({ id: opdDoctors.id }).from(opdDoctors)
    .where(and(eq(opdDoctors.departmentId, dept.id), eq(opdDoctors.active, true))).limit(1);
  return doc ? { ready: true, problem: null } : { ready: false, problem: "no_pathologist" };
}

/**
 * OWNER 2026-10-11 — THE COUNTER'S "LAST TESTS": a person's lab orders, newest first, each with its
 * test names and where it stands (waiting for blood, sample taken, report ready, handed over). Test
 * names only — no value — and a RESTRICTED test (HIV, HBsAg …) is shown by its name only to a reader
 * holding `orders.read.restricted`, otherwise as "Restricted test".
 */
export type RecentLabOrder = {
  orderId: string; orderNo: string; encounterNo: string; placedAt: string;
  tests: { code: string; nameEn: string }[];
  stage: "awaiting_blood" | "sample_taken" | "draft" | "report_ready" | "handed_over" | "cancelled" | "in_lab";
  /** The quick report, when the quick chain collected this order — what the lane opens to view or reprint. */
  quickId: string | null;
};

export async function recentLabOrders(db: Db, patientId: string, canSeeRestricted: boolean, limit = 20): Promise<RecentLabOrder[]> {
  const canonical = (await resolvePatientId(db, patientId)) ?? patientId;
  const chain = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const heads = await db.select({ id: orders.id, orderNo: orders.orderNo, encounterNo: orders.encounterNo, placedAt: orders.placedAt, status: orders.status })
    .from(orders).where(and(inArray(orders.patientId, chain), eq(orders.kind, "lab")))
    .orderBy(desc(orders.placedAt)).limit(Math.min(Math.max(limit, 1), 50));
  if (heads.length === 0) return [];
  const ids = heads.map((h) => h.id);
  const items = await db.select({ orderId: orderItems.orderId, status: orderItems.status, code: labOrderables.code, nameEn: labOrderables.nameEn, sensitive: labOrderables.sensitive })
    .from(orderItems).innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .where(inArray(orderItems.orderId, ids));
  const quick = await db.select({ id: labQuickReports.id, orderId: labQuickReports.orderId, status: labQuickReports.status, handedOverAt: labQuickReports.handedOverAt })
    .from(labQuickReports).where(inArray(labQuickReports.orderId, ids));
  const quickBy = new Map(quick.map((q) => [q.orderId!, q]));
  return heads.map((h) => {
    const mine = items.filter((i) => i.orderId === h.id);
    const q = quickBy.get(h.id);
    const stage: RecentLabOrder["stage"] = mine.length > 0 && mine.every((i) => i.status === "cancelled") ? "cancelled"
      : q === undefined ? (mine.every((i) => i.status === "placed") ? "awaiting_blood" : "in_lab")
      : q.handedOverAt !== null ? "handed_over"
      : q.status === "reported" ? "report_ready"
      : q.status === "draft" ? "draft" : "sample_taken";
    return {
      orderId: h.id, orderNo: h.orderNo, encounterNo: h.encounterNo, placedAt: h.placedAt.toISOString(), stage, quickId: q?.id ?? null,
      tests: mine.map((i) => (i.sensitive && !canSeeRestricted ? { code: "—", nameEn: "Restricted test" } : { code: i.code, nameEn: i.nameEn })),
    };
  });
}
