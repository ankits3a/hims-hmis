import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { asc, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { opdQueueEntries } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { bookAppointment, cancelAppointment, checkInAppointment, listAppointments, rescheduleAppointment } from "./appointments";
import { abandonVisit, getVisit, listVisits, openVisit, patientTimeline, reEnterVisit } from "./encounters";
import { OpdError } from "./errors";
import { parsed, toHttp } from "./opd-masters.controller";
import { availableSlots } from "./schedules";
import { istDate } from "./time";
import { listVitals, recordVitals } from "./vitals";
import type { AppointmentRow } from "./appointments";
import type { EncounterRow, OpenVisitResult, QueueEntryRow, TimelineItem, VitalsRow } from "./encounters";
import type { Slot } from "./slots";
import type { PatientSummary } from "../patients";
import type { Db } from "../../kernel/db/client";

const slotsQuery = z.object({ doctorId: z.string().min(1), date: z.string().max(10).optional() });
const appointmentsQuery = z.object({
  doctorId: z.string().min(1).optional(),
  serviceDate: z.string().max(10).optional(),
  patientId: z.string().min(1).optional(),
  status: z.string().max(200).optional(), // comma-separated
  needsRebooking: z.enum(["true", "false"]).optional(),
});
// z.coerce.date() on an ISO instant: the wire carries slot starts as ISO strings (flag ⑫).
const appointmentCreateBody = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  slotStart: z.coerce.date(),
  source: z.enum(["desk", "phone"]).optional(),
  note: z.string().max(1000).optional(),
});
const rescheduleBody = z.object({ slotStart: z.coerce.date(), doctorId: z.string().min(1).optional() });
const reasonBody = z.object({ reason: z.string().max(500) }); // blank ⇒ reason_required from the service, with its code
const visitOpenBody = z.object({
  patientId: z.string().min(1),
  departmentId: z.string().min(1),
  doctorId: z.string().min(1),
  intendedPayer: z.enum(["self", "tpa", "pmjay", "corporate"]).optional(),
  referralSource: z.enum(["self", "internal_doctor", "external_rmp", "camp", "other"]).optional(),
  referrerName: z.string().max(200).optional(),
});
const visitsQuery = z.object({
  status: z.enum(["registered", "waiting", "in_consultation", "awaiting_results", "completed", "abandoned"]).optional(),
  departmentId: z.string().min(1).optional(),
  doctorId: z.string().min(1).optional(),
  serviceDate: z.string().max(10).optional(),
});
// No numeric bounds here on purpose: implausible values answer invalid_vitals (with the offending field in
// `detail`) from vitals-rules, and completeness answers vitals_incomplete — both with their OPD code.
const vitalsBody = z.object({
  heightCm: z.number().nullable().optional(),
  weightKg: z.number().nullable().optional(),
  sbp: z.number().nullable().optional(),
  dbp: z.number().nullable().optional(),
  pulse: z.number().nullable().optional(),
  rr: z.number().nullable().optional(),
  spo2: z.number().nullable().optional(),
  tempC: z.number().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

type AppointmentView = AppointmentRow & { patient: PatientSummary | null };
type VisitListItem = EncounterRow & { patient: PatientSummary | null; queueEntry: QueueEntryRow | null };
type VisitDetail = NonNullable<Awaited<ReturnType<typeof getVisit>>> & { patient: PatientSummary | null };

@Controller("opd")
export class OpdVisitsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ——— slots and appointments ———

  @RequirePermission("opd.appointments.read", "hospital")
  @Get("slots")
  async slots(@Query() query: unknown): Promise<{ slots: Slot[] }> {
    const q = parsed(slotsQuery, query);
    try {
      return { slots: await availableSlots(this.db, q.doctorId, q.date ?? istDate(new Date())) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.appointments.read", "hospital")
  @Get("appointments")
  async appointments(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ items: AppointmentView[] }> {
    const q = parsed(appointmentsQuery, query);
    const items = await listAppointments(this.db, {
      doctorId: q.doctorId,
      serviceDate: q.serviceDate,
      patientId: q.patientId,
      status: q.status === undefined ? undefined : q.status.split(",").filter((s) => s !== ""),
      needsRebooking: q.needsRebooking === "true",
    });
    return { items: await this.withPatients(actor, items) };
  }

  @RequirePermission("opd.appointments.manage", "hospital")
  @Post("appointments")
  async book(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ appointment: AppointmentRow }> {
    const b = parsed(appointmentCreateBody, body);
    try {
      return await bookAppointment(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.appointments.manage", "hospital")
  @Post("appointments/:id/reschedule")
  async reschedule(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ from: AppointmentRow; to: AppointmentRow }> {
    const b = parsed(rescheduleBody, body);
    try {
      return await rescheduleAppointment(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.appointments.manage", "hospital")
  @Post("appointments/:id/cancel")
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ appointment: AppointmentRow }> {
    const b = parsed(reasonBody, body);
    try {
      return await cancelAppointment(this.db, actor, id, b.reason);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.open", "hospital")
  @Post("appointments/:id/check-in")
  async checkIn(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<OpenVisitResult> {
    try {
      return await checkInAppointment(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— visits ———

  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits")
  async open(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<OpenVisitResult> {
    const b = parsed(visitOpenBody, body);
    try {
      return await openVisit(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits")
  async visits(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ items: VisitListItem[] }> {
    const q = parsed(visitsQuery, query);
    const encounters = await listVisits(this.db, q);
    // ONE summaries call and ONE queue-entry query per request — never per row (§2 self-review 2).
    const summaries = await getPatientSummaries(this.db, actor, encounters.map((e) => e.patientId));
    const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
    const ids = encounters.map((e) => e.id);
    const entries = ids.length === 0
      ? []
      : await this.db.select().from(opdQueueEntries).where(inArray(opdQueueEntries.encounterId, ids)).orderBy(asc(opdQueueEntries.seq));
    const newest = new Map<string, QueueEntryRow>();
    for (const row of entries) newest.set(row.encounterId, row); // ascending seq ⇒ the last write wins
    return {
      items: encounters.map((e) => ({
        ...e, patient: byPatient.get(e.patientId) ?? null, queueEntry: newest.get(e.id) ?? null,
      })),
    };
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits/:id")
  async visit(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<VisitDetail> {
    const found = await getVisit(this.db, actor, id);
    if (!found) toHttp(new OpdError("unknown_encounter", `unknown encounter ${id}`));
    const [summary] = await getPatientSummaries(this.db, actor, [found.encounter.patientId]);
    return { ...found, patient: summary ?? null };
  }

  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits/:id/abandon")
  async abandon(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(reasonBody, body);
    try {
      return await abandonVisit(this.db, actor, id, b.reason);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits/:id/re-enter")
  async reEnter(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
    try {
      return await reEnterVisit(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— vitals ———

  @RequirePermission("opd.vitals.record", "hospital")
  @Post("visits/:id/vitals")
  async postVitals(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(vitalsBody, body);
    try {
      return await recordVitals(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits/:id/vitals")
  async getVitals(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ items: VitalsRow[] }> {
    return { items: await listVitals(this.db, actor, id) };
  }

  // ——— the patient's OPD history (merge-chain aware) ———

  @RequirePermission("opd.visits.read", "hospital")
  @Get("patients/:patientId/timeline")
  async timeline(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<{ items: TimelineItem[] }> {
    try {
      return { items: await patientTimeline(this.db, actor, patientId) };
    } catch (e) {
      toHttp(e);
    }
  }

  /** Attaches the patients module's summaries to a list — ONE call per request (spec §4: no patient table here). */
  private async withPatients(actor: Actor, items: AppointmentRow[]): Promise<AppointmentView[]> {
    const summaries = await getPatientSummaries(this.db, actor, items.map((a) => a.patientId));
    const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
    return items.map((a) => ({ ...a, patient: byPatient.get(a.patientId) ?? null }));
  }
}
