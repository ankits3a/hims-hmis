import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { asc, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { opdQueueEntries } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { bookAppointment, cancelAppointment, checkInAppointment, listAppointments, rescheduleAppointment } from "./appointments";
import { abandonVisit, counterState, getVisit, joinQueue, listVisits, openVisit, patientTimeline, reEnterVisit } from "./encounters";
import { patientRxHistory, patientVitalsHistory } from "./history";
import { listDepartments } from "./masters";
import type { RxHistoryItem, VitalsHistoryItem } from "./history";
import type { AppConfig } from "../../kernel/config";
import { walkIn } from "./walk-in";
import { continuityDoctorFor } from "./continuity";
import { suggestDepartments } from "./triage";
import type { TriageResult } from "./triage";
import type { ContinuityAnchor } from "./continuity";
import type { WalkInDeferredResult, WalkInInput, WalkInResult } from "./walk-in";
import { OpdError } from "./errors";
import { parsed, toHttp } from "./opd-masters.controller";
import { availableSlots } from "./schedules";
import { istDate } from "./time";
import { amendVitals, getVitalsForAmend, listVitals, recordVitals } from "./vitals";
import { BENCH_STATES, listBench, setBenchState } from "./bench";
import { cancelEscalation, demandRecheck, escalate, escalationFor } from "./escalation";
import { preStage } from "./prestage";
import { READING_SOURCES, UNLOCK_REASONS } from "./vitals-rules";
import { VITAL_KEYS } from "./config";
import type { BenchRow } from "./bench";
import type { EscalationView } from "./escalation";
import type { PreStage } from "./prestage";
import type { AppointmentRow } from "./appointments";
import type { CounterState, EncounterRow, JoinQueueResult, OpenVisitResult, QueueEntryRow, TimelineItem, VitalsRow } from "./encounters";
import type { Slot } from "./slots";
import type { PatientSummary } from "../patients";
import type { Db } from "../../kernel/db/client";

const slotsQuery = z.object({ doctorId: z.string().min(1), date: z.string().max(10).optional() });
/**
 * FD-7 T2 — both ids are REQUIRED. A continuity read without a department would be "list the places
 * this patient has been", which is the diagnosis-shaped read this route exists not to be.
 */
const triageBody = z.object({ text: z.string().min(1).max(400) });

const continuityQuery = z.object({
  patientId: z.string().min(1),
  departmentId: z.string().min(1),
});

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
  /** FD-7 T9 / R4 — the partner slip, captured where the patient hands it over. `.max(64)` matches
   *  `issueInvoiceBody.attributionCode` exactly, so a code the desk accepts cannot be one billing refuses. */
  attributionCode: z.string().min(1).max(64).optional(),
});
/**
 * PLAN 07b T6 — the walk-in body. It is `visitOpenBody` with the patient made a UNION rather than a
 * required id, because the whole point is that a first-time patient and a returning one are the
 * same act at the counter.
 */
const walkInBody = z.object({
  patient: z.union([
    z.object({ existingId: z.string().min(1) }),
    z.object({ register: z.record(z.string(), z.unknown()) }),
  ]),
  departmentId: z.string().min(1),
  doctorId: z.string().min(1),
  intendedPayer: z.enum(["self", "tpa", "pmjay", "corporate"]).optional(),
  referralSource: z.enum(["self", "internal_doctor", "external_rmp", "camp", "other"]).optional(),
  referrerName: z.string().max(200).optional(),
  /** FD-7 T9 / R4 — see `visitOpenBody`. The walk-in is where the front desk actually opens a visit. */
  attributionCode: z.string().min(1).max(64).optional(),
  acknowledgedDuplicates: z.boolean().optional(),
  // RC-1 T3 / D4 — bill-first defers the QUEUE JOIN, never the doctor: the visit opens with its
  // assignment, the token arrives with POST /opd/visits/:id/join-queue after the money.
  join: z.enum(["queue", "defer"]).optional(),
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
  /** VD-1 T1 / D5 — required under six, and the reason the bay carries a ₹160 tape. */
  muacCm: z.number().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

/**
 * ═══ VD-1 T5 — THE DETAIL BLOCK, AND ZOD IS THE POINT OF THIS TASK ═══
 *
 * **Every field the bay sends is declared here, because a field this schema does not name is a
 * field zod SILENTLY STRIPS.** The whole of RC-1 T1 existed for one instance of that: the web sent
 * `receipt.changeGivenPaise`, the billing controller's block did not declare it, and the drawer
 * lane was statically dead over HTTP while every test below the controller passed. That defect is
 * invisible to a service-level test by construction — it lives exactly at this boundary — so the
 * suite for this task drives the CONTROLLER SCHEMA PATH rather than the service.
 *
 * `readings` is the authority when present and the scalars above are DERIVED from it, so the two
 * shapes can never disagree (`vitals-rules.ts`'s own header). `overrides` clears a sanity gate with
 * a named reason; `unlockReasons` unlocks a carried value from the preset list and never free text.
 */
const readingBlock = z.object({
  takes: z.array(z.number()).min(1),
  source: z.enum(READING_SOURCES),
  held: z.array(z.number()).optional(),
  note: z.string().max(300).optional(),
});
const vitalsDetailBody = z.object({
  readings: z.object({
    heightCm: readingBlock.optional(), weightKg: readingBlock.optional(), pulse: readingBlock.optional(),
    rr: readingBlock.optional(), spo2: readingBlock.optional(), tempC: readingBlock.optional(),
    muacCm: readingBlock.optional(),
    bp: z.object({
      takes: z.array(z.tuple([z.number(), z.number()])).min(1),
      source: z.enum(READING_SOURCES),
      held: z.array(z.number()).optional(),
      note: z.string().max(300).optional(),
    }).optional(),
  }).optional(),
  contextChips: z.array(z.object({
    key: z.string().min(1).max(40), question: z.string().min(1).max(200), answer: z.string().min(1).max(200),
  })).optional(),
  carriedForward: z.array(z.enum(VITAL_KEYS)).optional(),
  emergency: z.boolean().optional(),
  overrides: z.partialRecord(z.enum(VITAL_KEYS), z.string().min(1).max(120)).optional(),
  unlockReasons: z.partialRecord(z.enum(VITAL_KEYS), z.enum(UNLOCK_REASONS)).optional(),
});
const vitalsPostBody = vitalsBody.extend(vitalsDetailBody.shape);
const vitalsAmendBody = vitalsBody.extend(vitalsDetailBody.shape).extend({
  reason: z.string().min(1).max(500),
});

/** VD-1 T4 — `state: null` is "back at the bench", which is a real act and not an omission. */
const benchStateBody = z.object({
  state: z.enum(BENCH_STATES).nullable(),
  restMinutes: z.number().int().positive().max(120).optional(),
  note: z.string().max(500).optional(),
});
const benchQuery = z.object({
  departmentId: z.string().min(1).optional(),
  doctorId: z.string().min(1).optional(),
  serviceDate: z.string().max(10).optional(),
});
/** T3 — the reading the bay is asking the SERVER to judge. It asks; the band decides. */
const escalationBody = z.object({
  sbp: z.number().optional(), dbp: z.number().optional(), pulse: z.number().optional(),
  rr: z.number().optional(), spo2: z.number().optional(), tempC: z.number().optional(),
  muacCm: z.number().optional(),
});

type AppointmentView = AppointmentRow & { patient: PatientSummary | null };
type VisitListItem = EncounterRow & { patient: PatientSummary | null; queueEntry: QueueEntryRow | null };
type VisitDetail = NonNullable<Awaited<ReturnType<typeof getVisit>>> & { patient: PatientSummary | null };

@Controller("opd")
export class OpdVisitsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

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

  /**
   * RULE 1 OF THE WALK-IN. Guarded on `opd.visits.open` — the permission the FRONT DESK holds,
   * because routing an arriving patient is a visit act; `opd.appointments.manage` is what the seat's
   * NAV row needs, and a clerk who may open a visit but not book one still has to route the walk-in.
   */
  /**
   * FD-8 — THE COMPLAINT, IN THE PATIENT'S OWN WORDS. Desk One's appointment stage asks "what brings
   * them in?" and ranks the hospital's departments from the answer; this is the server side of that.
   *
   * On `opd.visits.open` — the front desk's own key — because routing an arriving patient is a visit
   * act, and a clerk who may open a visit must be able to work out where to send them.
   *
   * The MODEL CALL IS SERVER-SIDE and that is not incidental: the gateway key must never reach a
   * browser bundle, where every user of the hospital could read it.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Post("triage")
  @HttpCode(200) // a suggestion is an answer, not a created thing
  async triage(@Body() body: unknown): Promise<TriageResult> {
    const b = parsed(triageBody, body);
    const departments = await listDepartments(this.db, { activeOnly: true });
    return suggestDepartments(
      b.text,
      departments.map((d) => ({ id: d.id, name: d.name })),
      this.config.triage,
    );
  }

  @RequirePermission("opd.visits.open", "hospital")
  @Get("continuity")
  async continuity(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ anchor: ContinuityAnchor | null }> {
    const q = parsed(continuityQuery, query);
    try {
      return { anchor: await continuityDoctorFor(this.db, actor, q) };
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

  /**
   * PLAN 07b T6 — ONE call where the browser used to orchestrate several, and the only place a
   * patient can be registered AND put in the queue as a single act.
   *
   * ═══ THE SECOND PERMISSION IS CHECKED IN THE SERVICE, NOT BY A SECOND DECORATOR ═══
   *
   * This route can CREATE A PATIENT, so it must also demand `patients.register`. Stacking a second
   * `@RequirePermission` looks like it would say that and does not: the decorator is
   * `SetMetadata(PERMISSION_KEY, …)` on ONE key, so a second call OVERWRITES the first and exactly
   * one requirement survives — silently. Written that way, a holder of `opd.visits.open` alone
   * could have registered patients through this route. `walkIn` therefore asserts
   * `patients.register` itself, and only on the branch that actually creates one.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Post("walk-in")
  async walkInRoute(
    @CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") idemKey?: string,
  ): Promise<WalkInResult | WalkInDeferredResult> {
    const b = parsed(walkInBody, body);
    try {
      return await walkIn(this.db, actor, b as unknown as WalkInInput, idemKey);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * RC-1 T3 / D4 — the second half of a bill-first walk-in: the deferred visit joins its
   * doctor's day. Idempotent — a replay answers the existing live entry, `alreadyJoined: true`.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits/:id/join-queue")
  async joinQueueRoute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<JoinQueueResult> {
    try {
      return await joinQueue(this.db, actor, id);
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

  /**
   * RC-4 CLOSE / pass 2 N2+N3 — the counter's polled read: status, fee status, whether the visit
   * has ever joined, and its token. No patient, no clinical payload, no PHI log — it carries none.
   * Under the seat's own permission. A sealed patient's visit answers the same as any other: the
   * seat holds the encounter id because it opened the visit, and a token number is not PHI.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Get("visits/:id/counter-state")
  async counterStateRoute(@Param("id") id: string): Promise<CounterState> {
    const state = await counterState(this.db, id);
    if (!state) toHttp(new OpdError("unknown_encounter", `unknown encounter ${id}`));
    return state;
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
    const { readings, contextChips, carriedForward, emergency, overrides, unlockReasons, ...scalars } =
      parsed(vitalsPostBody, body);
    try {
      return await recordVitals(this.db, actor, id, scalars, new Date(), {
        readings, contextChips, carriedForward, emergency, overrides, unlockReasons,
      });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * VD-1 T5 / D2 — amend a saved chart. `opd.vitals.record` rather than a new permission: the act
   * is recording a vital, and the owner ruled it a staff RIGHT at this desk rather than a
   * supervisory one. The audit is the superseding row and its event, not a narrower gate.
   */
  @RequirePermission("opd.vitals.record", "hospital")
  @Get("vitals/:vitalsId")
  async getVitalsRow(@CurrentActor() actor: Actor, @Param("vitalsId") vitalsId: string): Promise<{ vitals: VitalsRow }> {
    try {
      const vitals = await getVitalsForAmend(this.db, actor, vitalsId);
      if (vitals === null) throw new OpdError("unknown_vitals", `unknown vitals ${vitalsId}`);
      return { vitals };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.vitals.record", "hospital")
  @Post("vitals/:vitalsId/amend")
  async postVitalsAmend(@CurrentActor() actor: Actor, @Param("vitalsId") vitalsId: string, @Body() body: unknown): Promise<unknown> {
    const { reason, readings, contextChips, carriedForward, emergency, overrides, unlockReasons, ...scalars } =
      parsed(vitalsAmendBody, body);
    try {
      return await amendVitals(this.db, actor, vitalsId, scalars, reason, new Date(), {
        readings, contextChips, carriedForward, emergency, overrides, unlockReasons,
      });
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— VD-1 T4/T5 — the bench, the pre-stage, and the danger protocol ———

  @RequirePermission("opd.queue.read", "hospital")
  @Get("bench")
  async getBench(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ items: BenchRow[] }> {
    const q = parsed(benchQuery, query);
    try {
      return { items: await listBench(this.db, actor, { ...q, serviceDate: q.serviceDate ?? istDate(new Date()) }) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.vitals.record", "hospital")
  @Post("visits/:id/bench-state")
  async postBenchState(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<BenchRow> {
    const b = parsed(benchStateBody, body);
    try {
      return await setBenchState(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  /** The narrow permission R15 exists for — NOT `opd.consult`, and not the whole history. */
  @RequirePermission("opd.vitals.history.read", "hospital")
  @Get("visits/:id/prestage")
  async getPreStage(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<PreStage> {
    try {
      return await preStage(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.vitals.record", "hospital")
  @Get("visits/:id/escalation")
  async getEscalation(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ escalation: EscalationView | null }> {
    void actor;
    return { escalation: await escalationFor(this.db, id) };
  }

  @RequirePermission("opd.vitals.record", "hospital")
  @Post("visits/:id/escalation/recheck")
  async postRecheck(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<EscalationView> {
    const b = parsed(escalationBody, body);
    try {
      return await demandRecheck(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.vitals.record", "hospital")
  @Post("visits/:id/escalation/escalate")
  async postEscalate(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<EscalationView> {
    const b = parsed(escalationBody, body);
    try {
      return await escalate(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * The ten seconds. `opd.vitals.record` holds it: the owner ruled the cancel a DESK act — the
   * person who saw the cuff go on is the person who may decline the reorder, inside the window.
   * After it closes the server refuses and reversal becomes supervisory, which is where a wider
   * permission would belong if one is ever minted.
   */
  @RequirePermission("opd.vitals.record", "hospital")
  @Post("visits/:id/escalation/cancel")
  async postCancelEscalation(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<EscalationView> {
    try {
      return await cancelEscalation(this.db, actor, id);
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

  /**
   * PLAN 07d T1 — THE TWO CROSS-VISIT HISTORIES, gated on `opd.consult` and NOT on
   * `opd.visits.read`.
   *
   * The timeline above is `opd.visits.read`, which `front_office` holds, and that is right for what
   * it returns: dates, departments, a diagnosis line and a count — the shape a clerk needs to answer
   * "when was this patient last here". These two return the CLINICAL RECORD: what a patient was
   * prescribed across every visit they have ever made, and every vitals reading ever taken. A
   * registration clerk has no reason to read either, and `opd.consult` is the permission that means
   * "this person conducts consultations".
   *
   * That is a deliberate NARROWING relative to the surface beside them, recorded here because a
   * permission chosen quietly is how a permission model rots (07d DD6's own argument, applied to
   * the strings this task does not add).
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("patients/:patientId/prescriptions")
  async rxHistory(
    @CurrentActor() actor: Actor, @Param("patientId") patientId: string,
  ): Promise<{ items: RxHistoryItem[] }> {
    try {
      return { items: await patientRxHistory(this.db, actor, patientId) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Get("patients/:patientId/vitals")
  async vitalsHistory(
    @CurrentActor() actor: Actor, @Param("patientId") patientId: string,
  ): Promise<{ items: VitalsHistoryItem[] }> {
    try {
      return { items: await patientVitalsHistory(this.db, actor, patientId) };
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
