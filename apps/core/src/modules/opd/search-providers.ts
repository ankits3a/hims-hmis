import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { SearchHit } from "@hmis/contracts";
import { opdAppointments, opdDepartments, opdDoctors } from "../../kernel/db/schema";
import { wordPrefixMatch } from "../../kernel/search/text";
import { getPatientSummaries, searchPatients } from "../patients";
import type { SearchProvider, SearchProviderCtx, SearchProviderResult } from "../../kernel/search/types";

/**
 * PLAN 11h T3 — the OPD module's three providers. ROUTINE tier: tests required, mutants not.
 *
 * The one rule worth stating up front, because it is the rule a second module is most likely to
 * break: **no provider here re-implements patient confidentiality.** Appointment rows carry a
 * `patient_id`, and rendering a patient's NAME beside one is exactly the surface §14 governs. Both
 * places that need a patient — the candidate search and the label — go through the patients
 * module's own exported helpers (`searchPatients`, `getPatientSummaries`), which apply the gate
 * and return an alias for a restricted row. That is the shipped cross-module pattern (queue.ts,
 * vitals.ts, prescriptions.ts all do it) and it is the whole reason `patients/index.ts` exports
 * them.
 */

const chipId = (ctx: SearchProviderCtx, entity: string): string | undefined =>
  ctx.query.chips.find((c) => c.entity === entity)?.id;

/** Doctors — by display name, and narrowable to a department chip. */
export const doctorSearchProvider: SearchProvider = {
  key: "opd.doctor",
  entity: "doctor",
  permission: "opd.masters.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    const departmentId = chipId(ctx, "department");
    if (text.length < 2 && departmentId === undefined) return { hits: [], total: 0 };

    const conditions = [eq(opdDoctors.active, true)];
    if (text.length >= 2) conditions.push(wordPrefixMatch(opdDoctors.displayName, text)); // 'Dr Mehra' must answer to `mehra`
    if (departmentId !== undefined) conditions.push(eq(opdDoctors.departmentId, departmentId));
    const where = and(...conditions);

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({
          id: opdDoctors.id,
          displayName: opdDoctors.displayName,
          specialty: opdDoctors.specialty,
          departmentName: opdDepartments.name,
        })
        .from(opdDoctors)
        .innerJoin(opdDepartments, eq(opdDepartments.id, opdDoctors.departmentId))
        .where(where)
        .orderBy(asc(opdDoctors.displayName))
        .limit(ctx.limit),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(opdDoctors).where(where),
    ]);

    return {
      hits: rows.map((r): SearchHit => ({
        entity: "doctor",
        id: r.id,
        title: r.displayName,
        subtitle: [r.departmentName, r.specialty].filter(Boolean).join(" · "),
        href: "/opd/appointments",
      })),
      total: counted[0]?.n ?? 0,
    };
  },
};

/** Departments — by code OR name, because desks say "MED" as often as "Medicine". */
export const departmentSearchProvider: SearchProvider = {
  key: "opd.department",
  entity: "department",
  permission: "opd.masters.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    if (text.length < 2) return { hits: [], total: 0 };

    const where = and(
      eq(opdDepartments.active, true),
      or(wordPrefixMatch(opdDepartments.name, text), wordPrefixMatch(opdDepartments.code, text)),
    );

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({ id: opdDepartments.id, code: opdDepartments.code, name: opdDepartments.name })
        .from(opdDepartments)
        .where(where)
        .orderBy(asc(opdDepartments.name))
        .limit(ctx.limit),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(opdDepartments).where(where),
    ]);

    return {
      hits: rows.map((r): SearchHit => ({
        entity: "department",
        id: r.id,
        title: r.name,
        subtitle: r.code,
        href: "/opd/admin",
      })),
      total: counted[0]?.n ?? 0,
    };
  },
};

/**
 * Appointments — the first provider whose ANSWER DEPENDS ON CHIPS.
 *
 * A patient chip means "this person's appointments" and needs no text at all; free text means
 * "appointments for whoever matches this", which is resolved through `searchPatients` so the
 * confidential gate applies once, in the module that owns it. Doctor, department and date-range
 * chips narrow whatever the patient lane produced. With no chips and no text there is no query —
 * "all appointments" is a worklist screen's job, not a palette's.
 */
export const appointmentSearchProvider: SearchProvider = {
  key: "opd.appointment",
  entity: "appointment",
  permission: "opd.appointments.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    const patientChip = chipId(ctx, "patient");
    const doctorId = chipId(ctx, "doctor");
    const departmentId = chipId(ctx, "department");
    const range = ctx.query.range;

    let patientIds: string[] | undefined;
    if (patientChip !== undefined) {
      patientIds = [patientChip];
    } else if (text.length >= 2) {
      // The gate lives in the patients module; a sealed patient yields no ids, so their
      // appointments are unreachable here without a second confidentiality rule existing.
      patientIds = (await searchPatients(ctx.db, ctx.actor, text, Math.max(ctx.limit * 2, 10))).map((p) => p.id);
      if (patientIds.length === 0) return { hits: [], total: 0 };
    }

    if (patientIds === undefined && doctorId === undefined && departmentId === undefined) {
      return { hits: [], total: 0 };
    }

    const conditions = [];
    if (patientIds !== undefined) conditions.push(inArray(opdAppointments.patientId, patientIds));
    if (doctorId !== undefined) conditions.push(eq(opdAppointments.doctorId, doctorId));
    if (departmentId !== undefined) conditions.push(eq(opdAppointments.departmentId, departmentId));
    if (range !== undefined) {
      conditions.push(gte(opdAppointments.serviceDate, range.from));
      conditions.push(lte(opdAppointments.serviceDate, range.to));
    }
    const where = and(...conditions);

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({
          id: opdAppointments.id,
          patientId: opdAppointments.patientId,
          serviceDate: opdAppointments.serviceDate,
          slotStart: opdAppointments.slotStart,
          status: opdAppointments.status,
          doctorName: opdDoctors.displayName,
          departmentName: opdDepartments.name,
        })
        .from(opdAppointments)
        .innerJoin(opdDoctors, eq(opdDoctors.id, opdAppointments.doctorId))
        .innerJoin(opdDepartments, eq(opdDepartments.id, opdAppointments.departmentId))
        .where(where)
        .orderBy(desc(opdAppointments.slotStart)) // most recent first: the desk asks about today, not 2019
        .limit(ctx.limit),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(opdAppointments).where(where),
    ]);

    // ONE call for every row's label, and it is the gate-applying one.
    const summaries = await getPatientSummaries(ctx.db, ctx.actor, rows.map((r) => r.patientId));
    const labelById = new Map(summaries.map((s) => [s.requestedId, s.restricted ? (s.alias ?? "Restricted record") : (s.name ?? "—")] as const));

    return {
      hits: rows.map((r): SearchHit => ({
        entity: "appointment",
        id: r.id,
        title: `${labelById.get(r.patientId) ?? "—"} · ${r.serviceDate}`,
        subtitle: `${r.doctorName} · ${r.departmentName} · ${r.status}`,
        meta: { status: r.status, date: r.serviceDate },
        href: "/opd/appointments",
      })),
      total: counted[0]?.n ?? 0,
    };
  },
};

export const opdSearchProviders: SearchProvider[] = [
  doctorSearchProvider,
  departmentSearchProvider,
  appointmentSearchProvider,
];
