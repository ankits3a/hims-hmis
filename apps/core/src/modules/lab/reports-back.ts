import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { labReports, orderItems, orders, patients } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayName, resolvePatientId } from "../patients";
import { LabError } from "./errors";
import { LAB_REPORTS_BACK_HOURS } from "./waiting";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ReportSnapshot } from "./reports";

/**
 * #681 — THE DOCTOR'S "LAB REPORTS BACK", READ ON THE PHONE.
 *
 * Open loops counts `lab.reportsBack` (`waiting.ts`): current reports published in the last day on orders
 * this person is the RESPONSIBLE clinician of. These two readers list exactly that set and open one of
 * it, read-only:
 *
 *  · **Only my orders.** `orders.ordering_clinician_id = me` (DD6), so a report is never opened by id
 *    from someone else's order — an unknown and a not-mine report are the same refusal.
 *  · **The restricted-test rule (DD11, `kernel/orders/read.ts` `visibleItems`).** A restricted panel is
 *    shown to its ordering clinician or a holder of `orders.read.restricted`, and otherwise OMITTED, not
 *    counted. Every row here is mine by construction; the filter is still applied, so widening the
 *    list later cannot widen what a restricted test discloses.
 *  · **The alias rule.** The name is re-rendered from the canonical patient's CURRENT confidential flag
 *    (`displayName`), exactly as `getReport` does — never read out of the snapshot.
 *  · **No money.** `getReport` carries the delivery interlock (unpaid invoices, outstanding paise); this
 *    projection carries none of it. A doctor's read is never held for money (02 O-1) and never shows it.
 *  · **One `phi_access_log` row per read** under `lab.report`, as `getReport` writes: the list logs one
 *    per patient listed, the open logs one for its patient.
 */

/** How many reports the list returns. A doctor's day is far below it. */
export const REPORTS_BACK_LIMIT = 100;
const CURRENT = ["published", "amended"] as const;

export type ReportBackRow = {
  reportId: string;
  orderNo: string;
  encounterNo: string;
  patientName: string;
  uhid: string;
  publishedAt: string;
  amended: boolean;
  /** The panels' names, restricted ones omitted. */
  tests: string[];
  /** Values flagged outside the reference (any non-empty flag). */
  abnormal: number;
};

export type ReportBackLine = {
  name: string; value: string; unit: string | null; flag: string | null;
  refLow: string | null; refHigh: string | null; refText: string | null;
};
export type ReportBackView = Omit<ReportBackRow, "tests" | "abnormal"> & {
  partial: boolean;
  panels: { name: string; lines: ReportBackLine[] }[];
  signedBy: string | null;
  signedAt: string | null;
};

type Clearance = { me: string; restricted: boolean; confidential: boolean };

async function clearanceOf(db: Db, actor: Actor): Promise<Clearance> {
  if (actor.type !== "user") throw new LabError("user_actor_required", "a doctor's reports are read by a person");
  const [restricted, confidential] = await Promise.all([
    hasPermission(db, actor.id, "orders.read.restricted", "hospital"),
    hasPermission(db, actor.id, "patients.confidential.read", "hospital"),
  ]);
  return { me: actor.id, restricted, confidential };
}

/** DD11: the panels this reader may see — every one for the ordering clinician or a restricted-read holder. */
function visiblePanels(snapshot: ReportSnapshot, orderingClinicianId: string | null, restrictedItems: Set<string>, c: Clearance) {
  if (c.restricted || orderingClinicianId === c.me) return snapshot.panels;
  return snapshot.panels.filter((p) => !restrictedItems.has(p.orderItemId));
}

async function restrictedItemsOf(db: Db, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await db.select({ id: orderItems.id }).from(orderItems)
    .where(and(inArray(orderItems.orderId, orderIds), eq(orderItems.restricted, true)));
  return new Set(rows.map((r) => r.id));
}

async function nameOf(db: Db, snapshot: ReportSnapshot, c: Clearance): Promise<{ patientId: string; name: string; sealed: boolean }> {
  const canonical = (await resolvePatientId(db, snapshot.patient.id)) ?? snapshot.patient.id;
  const [p] = await db.select({ name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(eq(patients.id, canonical));
  /* No patient row: the snapshot's name only if it could not be a sealed one — a dash otherwise. */
  return p === undefined
    ? { patientId: canonical, name: "—", sealed: true }
    : { patientId: canonical, name: displayName(p, c.confidential), sealed: p.isConfidential };
}

const mineSince = (me: string, since: Date) => and(
  eq(orders.orderingClinicianId, me),
  inArray(labReports.status, [...CURRENT]),
  isNotNull(labReports.publishedAt),
  gte(labReports.publishedAt, since),
);

export async function myReportsBack(db: Db, actor: Actor, now: Date = new Date()): Promise<ReportBackRow[]> {
  const c = await clearanceOf(db, actor);
  const since = new Date(now.getTime() - LAB_REPORTS_BACK_HOURS * 3_600_000);
  const rows = await db
    .select({ report: labReports, orderingClinicianId: orders.orderingClinicianId })
    .from(labReports)
    .innerJoin(orders, eq(orders.id, labReports.orderId))
    .where(mineSince(c.me, since))
    .orderBy(desc(labReports.publishedAt))
    .limit(REPORTS_BACK_LIMIT);
  const restricted = await restrictedItemsOf(db, rows.map((r) => r.report.orderId));
  const logged = new Set<string>();
  const out: ReportBackRow[] = [];
  for (const r of rows) {
    const snapshot = r.report.snapshot as ReportSnapshot;
    const panels = visiblePanels(snapshot, r.orderingClinicianId, restricted, c);
    if (panels.length === 0) continue;
    const who = await nameOf(db, snapshot, c);
    if (!logged.has(who.patientId)) {
      logged.add(who.patientId);
      await recordPhiAccess(db, { actor, patientId: who.patientId, surface: "lab.report", encounterId: snapshot.encounterNo, sealed: who.sealed, now });
    }
    out.push({
      reportId: r.report.id, orderNo: snapshot.orderNo, encounterNo: snapshot.encounterNo,
      patientName: who.name, uhid: snapshot.patient.uhid, publishedAt: r.report.publishedAt!.toISOString(),
      amended: r.report.status === "amended", tests: panels.map((p) => p.nameEn),
      abnormal: panels.reduce((n, p) => n + p.analytes.filter((a) => a.flag !== null && a.flag !== "" && a.flag !== "N").length, 0),
    });
  }
  return out;
}

export async function myReportBack(db: Db, actor: Actor, reportId: string, now: Date = new Date()): Promise<ReportBackView> {
  const c = await clearanceOf(db, actor);
  const [r] = await db
    .select({ report: labReports, orderingClinicianId: orders.orderingClinicianId })
    .from(labReports)
    .innerJoin(orders, eq(orders.id, labReports.orderId))
    .where(and(eq(labReports.id, reportId), eq(orders.orderingClinicianId, c.me), inArray(labReports.status, [...CURRENT]), isNotNull(labReports.publishedAt)));
  /* Not mine, not current, not published, or not there: one refusal, so a report id cannot be probed. */
  if (r === undefined) throw new LabError("unknown_report", `no lab report ${reportId} for this doctor`);
  const snapshot = r.report.snapshot as ReportSnapshot;
  const panels = visiblePanels(snapshot, r.orderingClinicianId, await restrictedItemsOf(db, [r.report.orderId]), c);
  if (panels.length === 0) throw new LabError("unknown_report", `no lab report ${reportId} for this doctor`);
  const who = await nameOf(db, snapshot, c);
  await recordPhiAccess(db, { actor, patientId: who.patientId, surface: "lab.report", encounterId: snapshot.encounterNo, sealed: who.sealed, now });
  return {
    reportId: r.report.id, orderNo: snapshot.orderNo, encounterNo: snapshot.encounterNo,
    patientName: who.name, uhid: snapshot.patient.uhid, publishedAt: r.report.publishedAt!.toISOString(),
    amended: r.report.status === "amended", partial: r.report.partial,
    panels: panels.map((p) => ({
      name: p.nameEn,
      lines: p.analytes.map((a) => ({ name: a.nameEn, value: a.value, unit: a.unit, flag: a.flag, refLow: a.refLow, refHigh: a.refHigh, refText: a.refText })),
    })),
    signedBy: snapshot.signatory.fullName ?? null,
    signedAt: snapshot.signatory.signedAt ?? null,
  };
}
