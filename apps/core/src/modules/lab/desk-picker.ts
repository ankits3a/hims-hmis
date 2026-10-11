import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { labOrderables, opdDepartments, opdDoctors, orderItems, orders } from "../../kernel/db/schema";
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
export const STARTER_COMMON_CODES = ["CBC", "FBS", "RBS", "HBA1C", "LFT", "KFT", "LIPID", "TSH", "URINE-RM", "ESR", "CRP", "WIDAL"];

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
