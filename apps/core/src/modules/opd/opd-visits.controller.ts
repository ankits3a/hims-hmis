import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { asc, inArray } from "drizzle-orm";
import { z } from "zod";
import { APPOINTMENT_MODES, patientAbsentBody } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { opdQueueEntries } from "../../kernel/db/schema";
import { getPatientSummaries, PatientError } from "../patients";
import { findTodaysVisits, requestSlipRetake, slipDay, slipReadback } from "./slips";
import type { SlipDay, SlipReadback } from "./slips";
import { appointmentForList, bookAppointment, cancelAppointment, checkInAppointment, listAppointments, rescheduleAppointment } from "./appointments";
import {
  abandonVisit, counterState, deskComplaintFor, getEncounterByVisitNo, getVisit, grantFeeBypass, joinQueue, listVisits, openVisit,
  patientTimeline, reEnterVisit, reclassifyVisit,
} from "./encounters";
import { patientRxHistory, patientVitalsHistory } from "./history";
import { feeMarksFor } from "./prestage";
import { listDepartments } from "./masters";
import type { RxHistoryItem, VitalsHistoryItem } from "./history";
import type { AppConfig } from "../../kernel/config";
import { walkIn } from "./walk-in";
import { moveVisitDepartment, previewDepartmentMove } from "./department-move";
import type { DepartmentMovePreview, DepartmentMoveResult } from "./department-move";
import { continuityDoctorFor } from "./continuity";
import { suggestDepartments } from "./triage";
import type { TriageChoice } from "./triage";
import { chooserFor } from "../../kernel/inference/openai-decisions";
import type { TriageResult } from "./triage";
import type { ContinuityAnchor } from "./continuity";
import type { WalkInDeferredResult, WalkInInput, WalkInResult } from "./walk-in";
import { OpdError } from "./errors";
import { parsed, toHttp } from "./opd-masters.controller";
import { availableSlots } from "./schedules";
import { istDate } from "./time";
import { amendVitals, getVitalsForAmend, listVitals, recordVitals } from "./vitals";
import { markPatientAbsent, patientAbsentOf } from "./patient-absent";
import type { PatientAbsent } from "./patient-absent";
import { BENCH_STATES, listBench, locateVisit, setBenchState } from "./bench";
import { cancelEscalation, demandRecheck, escalate, escalationFor } from "./escalation";
import { preStage } from "./prestage";
import { READING_SOURCES, UNLOCK_REASONS } from "./vitals-rules";
import { GLUCOSE_TIMINGS, VITAL_KEYS } from "./config";
import type { BenchRow, VisitOnBench } from "./bench";
import { scanResolve } from "./scan";
import type { ScanQuery, ScanResult } from "./scan";
import type { EscalationView } from "./escalation";
import type { PreStage } from "./prestage";
import type { AppointmentRow } from "./appointments";
import { recordTeleAdvance, teleDeskMarks, teleFee } from "./tele";
import { teleSlotOf } from "./tele-call";
import type { TeleAdvanceResult, TeleDeskMark, TeleFee } from "./tele";
import { withIdempotency } from "../billing";
import type { CounterState, EncounterRow, JoinQueueResult, OpenVisitResult, QueueEntryRow, TimelineItem, VitalsRow } from "./encounters";
import type { VitalsRowWithRecorder } from "./vitals";
import type { Slot } from "./slots";
import type { PatientSummary } from "../patients";
import type { Db } from "../../kernel/db/client";

/* UX-AUDIT 2026-09-28 · BOARD — the slip desk's torn-QR search and the doctor's retake request. */
const slipFindQuery = z.object({ q: z.string().trim().min(2).max(120) });
const slipRetakeBody = z.object({ reason: z.string().max(300).nullable().optional() });
const slotsQuery = z.object({ doctorId: z.string().min(1), date: z.string().max(10).optional() });
/**
 * FD-7 T2 — both ids are REQUIRED. A continuity read without a department would be "list the places
 * this patient has been", which is the diagnosis-shaped read this route exists not to be.
 */
const triageBody = z.object({
  text: z.string().min(1).max(400),
  /**
   * ═══ THE AGE, AND EXACTLY WHAT IT IS ALLOWED TO DO ═══
   *
   * `red-flags.ts` gates ONE rule on age — chest pain below 12 is not treated as cardiac — and this
   * is how the desk supplies it. The screen already knows: it renders the age on the row it found.
   *
   * IT CAN ONLY EVER NARROW THAT ONE RULE, and absence fails SAFE (an unknown age flags). That
   * bound is what makes a client-supplied value acceptable here: triage runs on every keystroke, so
   * reading the DOB from the database per call would be a query per character, and the worst a
   * wrong value can do is suppress the chest-pain flag for a patient it claims is a small child.
   * Every other red flag is age-independent and unreachable from this field.
   */
  ageYears: z.number().int().min(0).max(130).optional(),
  /**
   * ═══ THE NAMES, AND THE ONE THING THEY ARE FOR ═══
   *
   * Masked out of the complaint before the model is asked — `triage.ts` — and used for nothing else:
   * never matched, stored or echoed. Client-supplied is safe for the same reason the age is: the
   * worst a wrong value can do is mask one word too many, or leave shapes-only masking in place,
   * which is exactly what a desk that sends none gets. Capped because each becomes a pattern.
   */
  names: z.array(z.string().min(1).max(120)).max(4).optional(),
});

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
  /**
   * FD-25 — the rebooking rail's phone numbers, opt-in and NARROW ON PURPOSE.
   *
   * Accepted only alongside `needsRebooking=true` (enforced below, not merely documented): the one
   * screen that needs a number is the one answering "the doctor is away, who do I have to call?".
   * Left open, this would have become a contact-details tap on every appointment read in the
   * product, which is the privacy widening the narrow option was chosen to avoid.
   */
  contact: z.enum(["true", "false"]).optional(),
});
// z.coerce.date() on an ISO instant: the wire carries slot starts as ISO strings (flag ⑫).
const appointmentCreateBody = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  slotStart: z.coerce.date(),
  source: z.enum(["desk", "phone"]).optional(),
  note: z.string().max(1000).optional(),
  // Owner 2026-10-09 — tele-call. The service judges the number (and names the refusal).
  mode: z.enum(APPOINTMENT_MODES).optional(),
  telePhone: z.string().max(40).optional(),
});
/** Owner 2026-10-09 — the desk collects a tele-call's fee. The service judges the amount, the tenders and the UPI reference. */
const teleAdvanceBody = z.object({
  amountPaise: z.number().int().min(0),
  tenders: z.array(z.object({
    mode: z.enum(["cash", "upi", "card"]), amountPaise: z.number().int().positive(), refText: z.string().trim().max(80).optional(),
  })).max(3).optional(),
});
const rescheduleBody = z.object({ slotStart: z.coerce.date(), doctorId: z.string().min(1).optional(), reason: z.string().max(400).optional(), telePhone: z.string().max(40).optional() });
const reasonBody = z.object({ reason: z.string().max(500) }); // blank ⇒ reason_required from the service, with its code
/* FD-32 — the same shape, and the same choice: a blank reason is refused by the SERVICE so the
   clerk gets `reason_required` with its code rather than a zod shape error they cannot map. */
const feeBypassBody = z.object({ reason: z.string().max(500) });
/**
 * `encounters.ts`'s `DESK_COMPLAINT_MAX`, written as a literal ON PURPOSE: this module is part of an
 * import cycle through `encounters.ts`, so the imported const is still undefined when these zod
 * schemas are built at load time (measured: zod threw inside its own error formatter). The desk
 * complaint test pins the two to the same behaviour.
 */
const DESK_COMPLAINT_MAX = 400;
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
  /** The patient's words from the desk (2026-09-23). Text only — the author is the actor. */
  deskComplaint: z.string().max(DESK_COMPLAINT_MAX).optional(),
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
  /** See `visitOpenBody.deskComplaint` — and this is the route Desk One actually sends it on. */
  deskComplaint: z.string().max(DESK_COMPLAINT_MAX).optional(),
  acknowledgedDuplicates: z.boolean().optional(),
  // RC-1 T3 / D4 — bill-first defers the QUEUE JOIN, never the doctor: the visit opens with its
  // assignment, the token arrives with POST /opd/visits/:id/join-queue after the money.
  join: z.enum(["queue", "defer"]).optional(),
});
/* Owner 2026-10-05 — a blank reason is the SERVICE's `reason_required`, as for abandon. */
const moveDepartmentBody = z.object({
  departmentId: z.string().min(1), doctorId: z.string().min(1), reason: z.string().max(400),
  /** Owner 2026-10-05, rule 3 — the difference a higher fee in the new department costs, taken now. */
  tenders: z.array(z.object({
    mode: z.enum(["cash", "upi", "card"]), amountPaise: z.number().int().positive(), refText: z.string().max(80).optional(),
  })).max(3).optional(),
});
const movePreviewQuery = z.object({ departmentId: z.string().min(1) });
const reclassifyBody = z.object({
  visitType: z.enum(["new", "revisit", "renewal"]),
  reason: z.string().min(1).max(400),
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
  /** Owner 2026-10-08 — finger-prick glucose (mg/dL) and when it was taken; one is refused without the other in `checkGlucose`. */
  glucoseMgDl: z.number().nullable().optional(),
  glucoseTiming: z.enum(GLUCOSE_TIMINGS).nullable().optional(),
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
    muacCm: readingBlock.optional(), glucoseMgDl: readingBlock.optional(),
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
/** Owner 2026-10-08 — the phone's quick scan: the READING of a code (the phone's `doorsOf`), never the raw text. */
const scanQuery = z.object({
  by: z.enum(["visit", "encounter", "token", "uhid", "patient"]),
  value: z.string().trim().min(1).max(80),
  departmentCode: z.string().trim().min(1).max(8).optional(),
});
const benchLocateQuery = z.object({ visitNo: z.string().trim().min(1).max(40), serviceDate: z.string().max(10).optional() });
/** T3 — the reading the bay is asking the SERVER to judge. It asks; the band decides. */
const escalationBody = z.object({
  sbp: z.number().optional(), dbp: z.number().optional(), pulse: z.number().optional(),
  rr: z.number().optional(), spo2: z.number().optional(), tempC: z.number().optional(),
  muacCm: z.number().optional(),
});

/** `teleDesk` is the DESK's money mark on a tele-call row (to pay / paid). It exists on this desk route only. */
type AppointmentView = AppointmentRow & { patient: PatientSummary | null; teleDesk?: TeleDeskMark };
type VisitListItem = EncounterRow & { patient: PatientSummary | null; queueEntry: QueueEntryRow | null };
/**
 * FD-32 — the visit read carries the two money marks as well, so the CONSULTATION and the OPD Order
 * Desk wear the owner's warning from the same derivation the vitals bay uses (`feeMarksFor`). On
 * consultation the pair that matters is the BYPASSED one: the fee gate already refuses an unpaid
 * consult, so the patient a doctor actually meets unpaid is the one the front desk waved through —
 * and the doctor should see whose decision that was and why.
 */
type VisitDetail = NonNullable<Awaited<ReturnType<typeof getVisit>>> & {
  patient: PatientSummary | null;
  /** Absent — not false — on a tele visit: nothing about its money is ever put on this read (owner 2026-10-09). */
  feeUnpaid?: boolean;
  feeBypass?: { by: string; reason: string; at: Date } | null;
  /** What the front desk heard, by whom and when — `null` when nothing was typed (D15). */
  deskComplaint: { text: string; by: string; at: Date } | null;
  /** Owner 2026-10-07 — the guardian came with the reports and the patient did not (`patient-absent.ts`). */
  patientAbsent: PatientAbsent | null;
  teleSlotAt: Date | null;
};

/** The encounter's own fee columns — absent from a tele visit's read (fix round 2026-10-09). */
const TELE_HIDDEN_ENCOUNTER_KEYS = ["feeBypassBy", "feeBypassReason", "feeBypassAt", "consultFeeOverrideBy", "consultFeeOverrideReason", "consultFeeOverrideAt"] as const;

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
      undefined,
      undefined,
      { ageYears: b.ageYears ?? null, names: b.names ?? [] },
      this.triageChoice(),
    );
  }

  /**
   * Triage's FIRST model (owner, 2026-09-19: TypeSafe as priority, the chat model its fallback), or
   * null with no key configured — and then `config.triage` answers alone, exactly as before.
   */
  private triageChoice(): TriageChoice | null {
    const client = chooserFor({
      order: this.config.triageChooserOrder, typesafe: this.config.triageChoice, decisions: this.config.decisions,
      openaiKeyFile: this.config.openaiKeyFile, minConfidence: this.config.triageChoice.minConfidence,
    });
    return client === null ? null : { client, minConfidence: this.config.triageChoice.minConfidence };
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
    /*
      CONTACT DETAILS ONLY ON THE REBOOKING READ, and refused rather than ignored elsewhere. A
      silently-dropped parameter teaches a caller that it worked; a refusal tells them the rule.
    */
    if (q.contact === "true" && q.needsRebooking !== "true") {
      throw new BadRequestException({
        code: "contact_needs_rebooking",
        message: "contact=true is available only with needsRebooking=true — the rebooking rail is the one surface that calls patients",
      });
    }
    return {
      items: await this.withPatients(actor, items, q.contact === "true"
        ? { reason: `rebooking rail: ${String(items.length)} appointment(s) needing a call` }
        : undefined),
    };
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

  /** Owner 2026-10-09 — what a tele-call costs: the in-person fee for that patient, doctor and slot date. Desk only. */
  @RequirePermission("opd.appointments.manage", "hospital", { alsoAdmits: ["billing.receipt.record"] })
  @Get("appointments/:id/tele-fee")
  async teleFeeRoute(@Param("id") id: string): Promise<TeleFee> {
    try {
      return await teleFee(this.db, id);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * The desk takes the fee: one ordinary advance receipt in the acting cashier's open drawer, for
   * exactly the quote. `Idempotency-Key` is honoured as `POST /billing/receipts` honours it — the
   * same store, so a retried request is answered, not repeated.
   */
  @RequirePermission("billing.receipt.record", "hospital")
  @Post("appointments/:id/advance")
  async teleAdvance(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") idemKey?: string,
  ): Promise<TeleAdvanceResult> {
    const b = parsed(teleAdvanceBody, body);
    try {
      return await withIdempotency(
        this.db, { actorId: actor.id, route: `POST /opd/appointments/${id}/advance`, key: idemKey }, b,
        () => recordTeleAdvance(this.db, actor, id, b),
      );
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

  /**
   * ═══ A SCANNED VISIT NUMBER → WHO IT IS, SO A HUMAN CAN CHECK BEFORE FILING ═══
   *
   * The desk outside the consultation room scans the QR in the slip's footer, which encodes exactly
   * the visit number. Before anything is photographed against that visit, the operator must SEE who
   * it matched — a slip filed against the wrong visit is a clinical-record error, and "the staff
   * only ever press capture or retake" needs this one control more than the description implies.
   *
   * IT MUST BE DECLARED ABOVE `@Get("visits/:id")`. Nest matches in declaration order and `:id`
   * would otherwise swallow `by-number` — the same trap `formulary/medicines/search` documents.
   *
   * `opd.visits.read` and no new permission: the front office, its supervisor, the vitals bay and
   * the doctor all hold it, which is exactly the set of seats that might hold the paper.
   */
  /*
    UX-AUDIT 2026-09-28 · BOARD — the read-back grew the Doctor ID, the department, the room and
    what is already filed against the visit (`slips.ts`). ADDITIVE: the five fields every existing
    caller reads are unchanged and still come first.
  */
  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits/by-number/:visitNo")
  async visitByNumber(
    @CurrentActor() actor: Actor, @Param("visitNo") visitNo: string,
  ): Promise<SlipReadback> {
    const encounter = await getEncounterByVisitNo(this.db, visitNo.trim());
    if (!encounter) toHttp(new OpdError("unknown_encounter", `no visit numbered ${visitNo}`));
    const back = await slipReadback(this.db, actor, encounter);
    /* A sealed patient the caller may not see answers exactly as a visit that does not exist: a
       visit number must not be a way to learn that a record exists. */
    if (back === null) toHttp(new OpdError("unknown_encounter", `no visit numbered ${visitNo}`));
    return back;
  }

  /**
   * UX-AUDIT 2026-09-28 · BOARD — the slip desk's right column: every consultation finished today,
   * waiting / retake / filed, with the day's three counts. `opd.visits.read`, the grant the
   * read-back above already needs, so the desk that can scan a slip can see the day's slips.
   */
  @RequirePermission("opd.visits.read", "hospital")
  @Get("slips/today")
  async slipsToday(@CurrentActor() actor: Actor): Promise<SlipDay> {
    return slipDay(this.db, actor);
  }

  /**
   * UX-AUDIT 2026-09-28 · BOARD / owner ruling 28-Sep-2026 — the QR is torn: find TODAY's visit by
   * name, UHID or mobile, and get the same read-back the scan gets, so the person is still checked.
   */
  @RequirePermission("opd.visits.read", "hospital")
  @Get("slips/find")
  async slipsFind(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ items: SlipReadback[] }> {
    const q = parsed(slipFindQuery, query);
    try {
      return { items: await findTodaysVisits(this.db, actor, q.q) };
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * UX-AUDIT 2026-09-28 · BOARD — the doctor could not read a line and asks the desk to photograph
   * the page again. `opd.consult`, the doctor's own grant: a desk cannot ask itself for a retake.
   */
  @RequirePermission("opd.consult", "hospital")
  @Post("slips/:documentId/retake")
  @HttpCode(200)
  async slipRetake(
    @CurrentActor() actor: Actor, @Param("documentId") documentId: string, @Body() body: unknown,
  ): Promise<{ documentId: string; encounterId: string; alreadyRequested: boolean }> {
    const b = parsed(slipRetakeBody, body ?? {});
    try {
      return await requestSlipRetake(this.db, actor, documentId, b.reason ?? null);
    } catch (e) {
      if (e instanceof PatientError && e.code === "document_not_found") throw new NotFoundException(e.message);
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

  /**
   * ═══ FD-32 — THE FRONT DESK'S BYPASS (OWNER RULING 2026-09-13) ═══
   *
   * *"In case of emergency or VIP patient, the front desk could enable the patient to bypass the
   * billing."* `opd.visits.open` is that desk's own key — the seat that opens the visit is the seat
   * that may wave it past the counter, and it is held by `front_office`, its supervisor and nobody
   * downstream. Deliberately NOT the cashier's: a counter that can excuse its own collection is the
   * separation this hospital draws everywhere else.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits/:id/fee-bypass")
  async feeBypass(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(feeBypassBody, body);
    try {
      return { encounter: await grantFeeBypass(this.db, actor, id, b.reason) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits/:id")
  async visit(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<VisitDetail> {
    const found = await getVisit(this.db, actor, id);
    if (!found) toHttp(new OpdError("unknown_encounter", `unknown encounter ${id}`));
    const [summary] = await getPatientSummaries(this.db, actor, [found.encounter.patientId]);
    /*
      Fix round 2026-10-09 — a tele visit's read carries NO money key at all: not the two marks, and
      not the encounter's own fee columns (absent, not null). Nothing about its money is a reader's
      of this route; the desk reads that off the appointment.
    */
    if (found.encounter.consultMode === "tele") {
      const encounter: Record<string, unknown> = { ...found.encounter };
      for (const key of TELE_HIDDEN_ENCOUNTER_KEYS) delete encounter[key];
      return {
        ...found, encounter: encounter as typeof found.encounter, patient: summary ?? null,
        deskComplaint: await deskComplaintFor(this.db, found.encounter),
        patientAbsent: patientAbsentOf(found.encounter),
        teleSlotAt: await teleSlotOf(this.db, found.encounter),
      };
    }
    return {
      ...found, patient: summary ?? null,
      ...(found.encounter.consultMode === "tele" ? {} : await feeMarksFor(this.db, found.encounter)),
      deskComplaint: await deskComplaintFor(this.db, found.encounter),
      patientAbsent: patientAbsentOf(found.encounter),
      // Owner 2026-10-09 — a tele-call's own slot, for the doctor's card. Null on every other visit.
      teleSlotAt: await teleSlotOf(this.db, found.encounter),
    };
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

  /**
   * Owner 2026-10-05 — "Wrong department — move patient" (`department-move.ts`). The preview is a
   * read: what the visit becomes in that department, and the bill that would refuse the move.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Get("visits/:id/move-preview")
  async movePreview(@CurrentActor() actor: Actor, @Param("id") id: string, @Query() query: unknown): Promise<DepartmentMovePreview> {
    const q = parsed(movePreviewQuery, query);
    try {
      return await previewDepartmentMove(this.db, id, q.departmentId, new Date(), actor);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits/:id/move-department")
  async moveDepartment(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<DepartmentMoveResult> {
    const b = parsed(moveDepartmentBody, body);
    try {
      return await moveVisitDepartment(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * FD-18 — the owner's billing override, built as a CORRECTION rather than a discount.
   *
   * ON `opd.visits.open`, which is the counter's own permission — the seat that opens a visit is
   * the seat that corrects what kind of visit it was, and the owner ruled the cashier acts alone
   * (2026-09-04). A dedicated permission would be tidier and would also mean editing `seed-roles`,
   * a file CLAUDE.md marks as shared and count-pinned; that is a coordination cost this correction
   * does not justify while the audit event carries the whole control.
   */
  @RequirePermission("opd.visits.open", "hospital")
  @Post("visits/:id/reclassify")
  async reclassify(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ encounter: EncounterRow }> {
    const b = parsed(reclassifyBody, body);
    try {
      return await reclassifyVisit(this.db, actor, id, { visitType: b.visitType, reason: b.reason });
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
   * ═══ OWNER 2026-10-07 — THE GUARDIAN CAME WITH THE REPORTS ═══
   *
   * A revisit still waiting for vitals skips the bay and joins the doctor's line (`patient-absent.ts`).
   * Either the bay's grant or the front desk's admits — the two seats a guardian walks up to. The
   * decorator writes ONE metadata key, so the second is `alsoAdmits`; the service asserts the pair
   * itself as well, and every other rule (revisit only, still registered, the fee door) lives there.
   */
  @RequirePermission("opd.vitals.record", "hospital", { alsoAdmits: ["opd.visits.open"] })
  @Post("visits/:id/patient-absent")
  async postPatientAbsent(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ encounter: EncounterRow; patientAbsent: PatientAbsent; alreadyMarked: boolean }> {
    const b = parsed(patientAbsentBody, body);
    try {
      return await markPatientAbsent(this.db, actor, id, { relation: b.relation, name: b.name ?? null });
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
  async getVitalsRow(@CurrentActor() actor: Actor, @Param("vitalsId") vitalsId: string): Promise<{ vitals: VitalsRowWithRecorder }> {
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

  /** Owner 2026-10-06 — why a typed or scanned visit number is not on today's bench. The bench's own door. */
  @RequirePermission("opd.queue.read", "hospital")
  @Get("bench/locate")
  async locateOnBench(@Query() query: unknown): Promise<VisitOnBench> {
    const q = parsed(benchLocateQuery, query);
    try {
      return await locateVisit(this.db, { visitNo: q.visitNo, serviceDate: q.serviceDate ?? istDate(new Date()) });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * Owner 2026-10-08 — the phone's quick scan (`scan.ts`): where a scanned or typed code's visit
   * stands today, and which of the phone's actions this caller holds the permission for. READ ONLY.
   * `opd.visits.read`, the grant `visits/by-number` already asks for — every desk that might hold the
   * paper. The answer only decides what is OFFERED; each action route keeps its own guard.
   */
  @RequirePermission("opd.visits.read", "hospital")
  @Get("scan")
  async scan(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<ScanResult> {
    const q = parsed(scanQuery, query);
    let by: ScanQuery;
    if (q.by === "token") {
      if (!/^\d{1,6}$/.test(q.value)) throw new BadRequestException("a token is a number");
      by = { by: "token", tokenNo: Number(q.value), ...(q.departmentCode === undefined ? {} : { departmentCode: q.departmentCode }) };
    } else if (q.by === "visit") by = { by: "visit", visitNo: q.value };
    else if (q.by === "encounter") by = { by: "encounter", encounterId: q.value };
    else if (q.by === "uhid") by = { by: "uhid", uhid: q.value };
    else by = { by: "patient", patientId: q.value };
    try {
      return await scanResolve(this.db, actor, by);
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
  private async withPatients(
    actor: Actor,
    items: AppointmentRow[],
    withContact?: { reason: string },
  ): Promise<AppointmentView[]> {
    const summaries = await getPatientSummaries(
      this.db, actor, items.map((a) => a.patientId),
      withContact === undefined ? {} : { withContact },
    );
    const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
    const marks = await teleDeskMarks(this.db, items);
    return items.map((a) => {
      const patient = byPatient.get(a.patientId) ?? null;
      const teleDesk = marks.get(a.id);
      return { ...appointmentForList(a, patient, withContact !== undefined), patient, ...(teleDesk === undefined ? {} : { teleDesk }) };
    });
  }
}
