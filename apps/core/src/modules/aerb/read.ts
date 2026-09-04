import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { aerbLicences, aerbPersons } from "../../kernel/db/schema/aerb";
import { resources } from "../../kernel/db/schema/resources";
import { users } from "../../kernel/db/schema/auth";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18c T1 — the register as a BOOK, which is the form an inspector asks for it in.
 *
 * ═══ NO PHI HERE, AND THAT IS WHY THERE IS NO `recordPhiAccess` IN THIS FILE ═══
 *
 * Licences are about machines and appointments are about staff; neither is patient data, so this
 * reader logs nothing and requires only `aerb.registers.read`. The one AERB surface that IS PHI is
 * the patient dose register, which T3 builds behind its own permission (`aerb.doses.read`) and its
 * own `PhiSurface` (D7). Keeping them in separate files is what stops the second from inheriting
 * the first's silence.
 *
 * The joins reach `resources` and `users` — both kernel tables, both readable from any module —
 * and never a radiology table (D1).
 */

export interface LicenceRegisterRow {
  id: string;
  deviceResourceId: string;
  deviceCode: string;
  deviceName: string;
  modality: string | null;
  licenceType: string;
  licenceNo: string;
  eloraRef: string | null;
  typeApprovalRef: string | null;
  layoutApprovalRef: string | null;
  validFrom: string;
  validTo: string;
  status: string;
  rsoUserId: string | null;
  rsoName: string | null;
  decommissionedAt: string | null;
  decommissionRef: string | null;
  remarks: string | null;
}

/**
 * The whole file, newest validity first, with the machine's own label beside it — because the
 * inspector's question is *"show me the licence for THAT CT"* and a bare `device_resource_id`
 * answers it only to somebody holding a second screen.
 *
 * `includeInactive` defaults FALSE so the working view is the live file; the inspector's print
 * (T5) passes true, since a surrendered licence for a decommissioned unit is exactly the record
 * the Rules require to survive.
 */
export async function licenceRegister(
  db: Db, opts: { includeInactive?: boolean } = {},
): Promise<LicenceRegisterRow[]> {
  const rows = await db.select({
    id: aerbLicences.id,
    deviceResourceId: aerbLicences.deviceResourceId,
    deviceCode: resources.code,
    deviceName: resources.name,
    attributes: resources.attributes,
    licenceType: aerbLicences.licenceType,
    licenceNo: aerbLicences.licenceNo,
    eloraRef: aerbLicences.eloraRef,
    typeApprovalRef: aerbLicences.typeApprovalRef,
    layoutApprovalRef: aerbLicences.layoutApprovalRef,
    validFrom: aerbLicences.validFrom,
    validTo: aerbLicences.validTo,
    status: aerbLicences.status,
    rsoUserId: aerbLicences.rsoUserId,
    rsoName: users.fullName,
    decommissionedAt: aerbLicences.decommissionedAt,
    decommissionRef: aerbLicences.decommissionRef,
    remarks: aerbLicences.remarks,
  })
    .from(aerbLicences)
    .innerJoin(resources, eq(resources.id, aerbLicences.deviceResourceId))
    /**
     * LEFT, not inner: `rso_user_id` is nullable by design (R1 — the RSO may not be named yet) and
     * an inner join would make the whole licence vanish from the register for want of a name.
     */
    .leftJoin(users, eq(users.id, aerbLicences.rsoUserId))
    .where(opts.includeInactive === true ? sql`true` : eq(aerbLicences.status, "active"))
    .orderBy(desc(aerbLicences.validTo), asc(aerbLicences.licenceNo));

  return rows.map((r) => ({
    id: r.id,
    deviceResourceId: r.deviceResourceId,
    deviceCode: r.deviceCode,
    deviceName: r.deviceName,
    modality: typeof r.attributes?.modality === "string" ? r.attributes.modality : null,
    licenceType: r.licenceType,
    licenceNo: r.licenceNo,
    eloraRef: r.eloraRef,
    typeApprovalRef: r.typeApprovalRef,
    layoutApprovalRef: r.layoutApprovalRef,
    validFrom: r.validFrom,
    validTo: r.validTo,
    status: r.status,
    rsoUserId: r.rsoUserId,
    rsoName: r.rsoName ?? null,
    decommissionedAt: r.decommissionedAt?.toISOString() ?? null,
    decommissionRef: r.decommissionRef,
    remarks: r.remarks,
  }));
}

export interface AppointmentRow {
  id: string;
  userId: string;
  userName: string;
  personRole: string;
  approvalRef: string | null;
  qualification: string;
  validFrom: string;
  validTo: string | null;
  active: boolean;
}

/** Who is in post, and who was. `onDate` filters to the appointments live that day. */
export async function appointments(
  db: Db, opts: { onDate?: string; includeEnded?: boolean } = {},
): Promise<AppointmentRow[]> {
  const live = [
    eq(aerbPersons.active, true),
    ...(opts.onDate
      ? [
          sql`${aerbPersons.validFrom} <= ${opts.onDate}`,
          or(isNull(aerbPersons.validTo), sql`${aerbPersons.validTo} >= ${opts.onDate}`),
        ]
      : []),
  ];
  const rows = await db.select({
    id: aerbPersons.id,
    userId: aerbPersons.userId,
    userName: users.fullName,
    personRole: aerbPersons.personRole,
    approvalRef: aerbPersons.approvalRef,
    qualification: aerbPersons.qualification,
    validFrom: aerbPersons.validFrom,
    validTo: aerbPersons.validTo,
    active: aerbPersons.active,
  })
    .from(aerbPersons)
    .innerJoin(users, eq(users.id, aerbPersons.userId))
    .where(opts.includeEnded === true && !opts.onDate ? sql`true` : and(...live))
    .orderBy(asc(aerbPersons.personRole), desc(aerbPersons.validFrom));
  return rows;
}

/**
 * **The devices that emit and have no paper.** The negative-space row: the register's value is not
 * the licences it holds but the machines it cannot account for, and a screen that only lists rows
 * can never show one. `kind = 'device'` and an ionising-capable modality with no active licence
 * covering today.
 *
 * The modality list lives here rather than in a shared constant because it answers a REGULATORY
 * question — which modalities AERB licences — and not radiology's clinical one. Ultrasound and MRI
 * are absent because they emit no ionising radiation and never appear on an eLORA licence.
 */
export const AERB_LICENSABLE_MODALITIES: readonly string[] = ["xray", "ct", "mammography", "fluoroscopy", "dexa"];

export async function unlicensedDevices(
  db: Db, onDate: string,
): Promise<{ deviceResourceId: string; code: string; name: string; modality: string }[]> {
  const rows = await db.select({
    id: resources.id,
    code: resources.code,
    name: resources.name,
    attributes: resources.attributes,
    licenceId: aerbLicences.id,
  })
    .from(resources)
    .leftJoin(
      aerbLicences,
      and(
        eq(aerbLicences.deviceResourceId, resources.id),
        eq(aerbLicences.status, "active"),
        sql`${aerbLicences.validFrom} <= ${onDate}`,
        sql`${aerbLicences.validTo} >= ${onDate}`,
      ),
    )
    .where(and(eq(resources.kind, "device"), sql`${resources.status} <> 'retired'`))
    .orderBy(asc(resources.code));

  return rows
    .filter((r) => r.licenceId === null)
    .map((r) => ({
      deviceResourceId: r.id,
      code: r.code,
      name: r.name,
      modality: typeof r.attributes?.modality === "string" ? r.attributes.modality : "",
    }))
    .filter((r) => AERB_LICENSABLE_MODALITIES.includes(r.modality));
}
