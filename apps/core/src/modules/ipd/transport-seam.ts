import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ipdAdmissions, ipdBands, ipdBedStays, resources } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E1.6 TRANSPORT (issue #723) — what the transport module needs to know about an admission, and what a wristband
 * scan resolves to. Read-only; transport reaches these through `ipd/index.ts`.
 */

/** Bed classes whose patient is critical by placement: their moves need a nurse or doctor escort. */
export const CRITICAL_CARE_BED_CLASSES: readonly string[] = ["icu", "hdu", "nicu", "picu"];

/** States in which a patient is in the hospital's beds and may be moved (requested/reserved have no bed yet). */
const MOVABLE_STATES = ["admitted", "transferring", "fit_declared", "discharging"] as const;

export type TransportAdmissionFacts = {
  admissionId: string;
  patientId: string;
  state: string;
  movable: boolean;
  admissionNo: string | null;
  /** The ICU flag on the admission request (no bed yet, or bed class not critical). */
  icuRequested: boolean;
  bedId: string | null;
  bedName: string | null;
  bedClass: string | null;
  criticalCareBed: boolean;
};

export async function admissionForTransport(exec: Db | Tx, admissionId: string): Promise<TransportAdmissionFacts | null> {
  const a = (await (exec as Db).select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined) return null;
  const stay = (await (exec as Db).select({ bedId: ipdBedStays.bedId, bedClass: ipdBedStays.bedClass, bedName: resources.name, bedCode: resources.code })
    .from(ipdBedStays).innerJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .where(and(eq(ipdBedStays.admissionId, a.id), isNull(ipdBedStays.endedAt))))[0];
  return {
    admissionId: a.id, patientId: a.patientId, state: a.state, movable: (MOVABLE_STATES as readonly string[]).includes(a.state),
    admissionNo: a.admissionNo, icuRequested: a.icu,
    bedId: stay?.bedId ?? null, bedName: stay === undefined ? null : stay.bedName, bedClass: stay?.bedClass ?? null,
    criticalCareBed: stay !== undefined && CRITICAL_CARE_BED_CLASSES.includes(stay.bedClass),
  };
}

/** Open, movable admissions with their current bed — the request sheet's patient list (at most `limit`). */
export async function movableAdmissions(exec: Db | Tx, limit = 2000): Promise<TransportAdmissionFacts[]> {
  const rows = await (exec as Db).select({
    a: ipdAdmissions, bedId: ipdBedStays.bedId, bedClass: ipdBedStays.bedClass, bedName: resources.name,
  }).from(ipdAdmissions)
    .leftJoin(ipdBedStays, and(eq(ipdBedStays.admissionId, ipdAdmissions.id), isNull(ipdBedStays.endedAt)))
    .leftJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .where(inArray(ipdAdmissions.state, [...MOVABLE_STATES]))
    .orderBy(desc(ipdAdmissions.admittedAt)).limit(limit);
  return rows.map((r) => ({
    admissionId: r.a.id, patientId: r.a.patientId, state: r.a.state, movable: true, admissionNo: r.a.admissionNo,
    icuRequested: r.a.icu, bedId: r.bedId, bedName: r.bedName, bedClass: r.bedClass,
    criticalCareBed: r.bedClass !== null && CRITICAL_CARE_BED_CLASSES.includes(r.bedClass),
  }));
}

export type BandScan = { admissionId: string; serial: string; live: boolean };

/**
 * What a wristband scan says. The band's Code 128 carries its SERIAL; its QR carries `IPDBAND1|<serial>|<uhid>`
 * (`bands.ts`). A handheld scanner types either into the field. Null when no band has that serial.
 */
export async function resolveBandScan(exec: Db | Tx, code: string): Promise<BandScan | null> {
  const raw = code.trim();
  const serial = raw.startsWith("IPDBAND1|") ? (raw.split("|")[1] ?? "").trim() : raw;
  if (serial === "") return null;
  const band = (await (exec as Db).select({ admissionId: ipdBands.admissionId, serial: ipdBands.serial, status: ipdBands.status })
    .from(ipdBands).where(eq(ipdBands.serial, serial)))[0];
  if (band === undefined) return null;
  return { admissionId: band.admissionId, serial: band.serial, live: band.status === "printed" };
}
