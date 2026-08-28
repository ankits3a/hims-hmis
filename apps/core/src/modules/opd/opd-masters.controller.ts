import {
  BadRequestException, Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Put, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { SodViolationError } from "../../kernel/auth/sod";
import { WorkflowError } from "../../kernel/workflow/instances";
import { withTx } from "../../kernel/db/client";
import { PatientError } from "../patients";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources";
import { loadOpdConfig, updateOpdConfig } from "./config";
import { OpdError } from "./errors";
import { cancelDoctorLeave, listLeaves, scheduleDoctorLeave } from "./leaves";
import {
  createDepartment, createDoctor, createRoom, doctorForUser, getDoctor, listDepartments, listDoctors, listRooms,
  updateDepartment, updateDoctor, updateRoom,
} from "./masters";
import { listDoctorSchedules, replaceDoctorSchedules } from "./schedules";
import { OPD_VISIT_DEFINITION_JSON } from "./workflow-def";
import type { DangerRangesConfig, Letterhead, OpdConfig, OpdConfigPatch } from "./config";
import type { OpdErrorCode } from "./errors";
import type { LeaveRow } from "./leaves";
import type { DepartmentRow, DoctorRow, RoomRow } from "./masters";
import type { Db } from "../../kernel/db/client";

/**
 * OPD errors → HTTP, defined ONCE for the module's three controllers (the other two import it).
 *
 * The body is an OBJECT — `{ statusCode, message, code, detail? }` — deliberately WIDER than the patients and
 * tariff modules' message-only bodies (which carry the code as a `code: message` string prefix). Six screens and
 * a pharmacy scanner branch on `code`, and the allergy hard-warning has to carry its matches; a string prefix
 * cannot do that. The older modules are NOT realigned (gate reports 01–06.2 §4/§5).
 */
const OPD_CONFLICT_CODES = new Set<OpdErrorCode>([
  "slot_taken", "call_conflict", "doctor_out", "session_closed", "doctor_on_leave", "appointment_not_today",
  "extension_cap_reached", "allergy_conflict", "user_already_doctor", "opd_not_configured", "opd_config_invalid",
  "not_your_patient", "consult_gate_refused",
  // PLAN 16a T5 — the two new hard warnings answer 409 exactly as `allergy_conflict` does, and this
  // line is functional rather than cosmetic: without it `opdStatus` falls through to its 400
  // default, and a clinical refusal the client must render with an override dialog would arrive
  // looking like a malformed request. Plan 09's counter-side 500 is the same lesson one step milder.
  "interaction_conflict", "duplicate_salt_conflict",
]);

function opdStatus(code: OpdErrorCode): number {
  if (code.startsWith("unknown_") || code === "patient_not_found") return 404;
  // PLAN 07b T6 — an authorization answer, not a client mistake. The walk-in route is guarded on
  // `opd.visits.open`; `patients.register` is asserted in the service (the decorator writes one
  // metadata key, so a second `@RequirePermission` would silently replace the first), and its
  // refusal must read as 403 rather than falling through to the 400 default.
  if (code === "registration_not_permitted") return 403;
  if (code.endsWith("_state_conflict") || code.startsWith("duplicate_") || OPD_CONFLICT_CODES.has(code)) return 409;
  return 400; // invalid_*, vitals_incomplete, reason_required, empty_prescription, … — a client mistake
}

function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

/** Unrecognized errors rethrow — a 500 is a genuine bug, loudly (the patients toHttp convention). */
export function toHttp(e: unknown): never {
  if (e instanceof OpdError) throw httpError(opdStatus(e.code), e.message, e.code, e.detail);
  /**
   * PLAN 13 CLOSE PASS 2 / R2 — **THIS CONTROLLER CAN RECEIVE A `ResourceError`, SO IT MAPS ONE.**
   *
   * OPD's room masters delegate into the kernel registry (DD9). `masters.ts`'s `asOpdError`
   * translates the two codes that were reachable when it was written and rethrows the rest, on the
   * argument that guessing at the others would turn a genuine bug into a misleading refusal — which
   * is right, and which makes THIS the place the remaining codes have to land.
   *
   * The close's own M1 fix is what made that urgent: `updateRoom({ active: false })` on an occupied
   * room now raises `already_occupied` from `changeResourceStatus`, and `OpdError`'s union has no
   * code for an occupied room. Without this clause that refusal reached the masters counter as a
   * **500** — Plan 09's `MembershipError` escaping `billing.controller.ts` exactly, one phase later,
   * introduced by the commit that fixed a different defect. `errors.ts` exports `resourceHttpStatus`
   * so every controller that can receive one maps it from the SAME table; this is the second caller.
   */
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code, e.detail);
  // The engine's own refusals: role_denied is an authorization answer, everything else a state conflict.
  if (e instanceof WorkflowError) throw httpError(e.code === "role_denied" ? 403 : 409, e.message, e.code);
  if (e instanceof SodViolationError) throw httpError(403, e.message, "sod_violation");
  if (e instanceof PatientError) throw httpError(e.code === "patient_not_found" ? 404 : 400, e.message, e.code);
  throw e;
}

export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

/** Query flags arrive as strings; never z.coerce.boolean() — it reads "false" as true (§3.19). */
const flagQuery = z.enum(["true", "false"]).optional();

const activeQuery = z.object({ active: flagQuery });
const doctorsQuery = z.object({ departmentId: z.string().min(1).optional(), active: flagQuery });
const departmentCreateBody = z.object({ code: z.string().min(1).max(50), name: z.string().min(1).max(200) });
const departmentPatchBody = z.object({ name: z.string().min(1).max(200).optional(), active: z.boolean().optional() });
const roomCreateBody = z.object({
  code: z.string().min(1).max(50), name: z.string().min(1).max(200), floor: z.string().max(50).optional(),
});
const roomPatchBody = z.object({
  name: z.string().min(1).max(200).optional(), floor: z.string().max(50).nullable().optional(), active: z.boolean().optional(),
});
const doctorCreateBody = z.object({
  username: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200),
  registrationNo: z.string().max(100).optional(),
  departmentId: z.string().min(1),
  specialty: z.string().max(200).optional(),
});
const doctorPatchBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  registrationNo: z.string().max(100).nullable().optional(),
  departmentId: z.string().min(1).optional(),
  specialty: z.string().max(200).nullable().optional(),
  active: z.boolean().optional(),
});
// Numbers coerced: an <input type="number"> posts strings (§3.19 class). The HH:MM strings and the
// weekday/validity ranges are validated by validateScheduleSet → invalid_schedule (400).
const scheduleItemBody = z.object({
  weekday: z.coerce.number().int(),
  startTime: z.string().max(5),
  endTime: z.string().max(5),
  roomId: z.string().min(1),
  slotMinutes: z.coerce.number().int().nullable().optional(),
  validFrom: z.string().min(1).max(10),
  validTo: z.string().max(10).nullable().optional(),
});
const schedulesBody = z.object({ items: z.array(scheduleItemBody) });
const leavesQuery = z.object({
  doctorId: z.string().min(1).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  status: z.enum(["scheduled", "cancelled"]).optional(),
});
const leaveCreateBody = z.object({
  doctorId: z.string().min(1), fromDate: z.string().min(1).max(10), toDate: z.string().min(1).max(10), reason: z.string().max(500),
});
// dangerRanges / letterhead stay unknown here on purpose: updateOpdConfig validates them with the SAME schemas
// loadOpdConfig reads through, so a bad shape answers invalid_config (with the zod issues) rather than a
// schema-shaped 400 the admin screen cannot label.
const configPatchBody = z.object({
  slotMinutes: z.number().int().optional(),
  followUpDefaultDays: z.number().int().optional(),
  followUpExtensionDays: z.array(z.number()).optional(),
  extensionCapPerDoctorPerMonth: z.number().int().optional(),
  maxSkipsBeforeLeft: z.number().int().optional(),
  perkEveryNth: z.number().int().nullable().optional(),
  dangerRanges: z.unknown().optional(),
  letterhead: z.unknown().optional(),
});

function toConfigPatch(b: z.infer<typeof configPatchBody>): OpdConfigPatch {
  const patch: OpdConfigPatch = {};
  if (b.slotMinutes !== undefined) patch.slotMinutes = b.slotMinutes;
  if (b.followUpDefaultDays !== undefined) patch.followUpDefaultDays = b.followUpDefaultDays;
  if (b.followUpExtensionDays !== undefined) patch.followUpExtensionDays = b.followUpExtensionDays;
  if (b.extensionCapPerDoctorPerMonth !== undefined) patch.extensionCapPerDoctorPerMonth = b.extensionCapPerDoctorPerMonth;
  if (b.maxSkipsBeforeLeft !== undefined) patch.maxSkipsBeforeLeft = b.maxSkipsBeforeLeft;
  if (b.perkEveryNth !== undefined) patch.perkEveryNth = b.perkEveryNth;
  if (b.dangerRanges !== undefined) patch.dangerRanges = b.dangerRanges as DangerRangesConfig;
  if (b.letterhead !== undefined) patch.letterhead = b.letterhead as Letterhead;
  return patch;
}

@Controller("opd")
export class OpdMastersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ——— literal-segment routes FIRST (Nest matches in declaration order) ———

  @RequirePermission("opd.masters.read", "hospital")
  @Get("definition")
  definition(): typeof OPD_VISIT_DEFINITION_JSON {
    return OPD_VISIT_DEFINITION_JSON; // the exact JSON the go-live runbook POSTs to /workflow/definitions
  }

  @RequirePermission("opd.masters.read", "hospital")
  @Get("config")
  async getConfig(): Promise<OpdConfig> {
    try {
      return await loadOpdConfig(this.db);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.config.manage", "hospital")
  @Put("config")
  async putConfig(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<OpdConfig> {
    const b = parsed(configPatchBody, body);
    try {
      return await withTx(this.db, (tx) => updateOpdConfig(tx, actor, toConfigPatch(b)));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Get("me/doctor")
  async myDoctor(@CurrentActor() actor: Actor): Promise<DoctorRow> {
    if (actor.type !== "user") toHttp(new OpdError("user_actor_required", "only a user actor has a doctor profile"));
    const doctor = await doctorForUser(this.db, actor.id);
    // 404 here (not the mapping table's 400 for not_a_doctor): the consultation screen asks "is this user a
    // doctor?" and an absent profile is an absent resource, not a malformed request.
    if (!doctor) throw httpError(404, "no OPD doctor profile for this user", "not_a_doctor");
    return doctor;
  }

  // ——— departments ———

  @RequirePermission("opd.masters.read", "hospital")
  @Get("departments")
  async departments(@Query() query: unknown): Promise<{ items: DepartmentRow[] }> {
    const q = parsed(activeQuery, query);
    return { items: await listDepartments(this.db, { activeOnly: q.active === "true" }) };
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Post("departments")
  async createDepartment(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ departmentId: string }> {
    const b = parsed(departmentCreateBody, body);
    try {
      return await withTx(this.db, (tx) => createDepartment(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Patch("departments/:id")
  async patchDepartment(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(departmentPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateDepartment(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— rooms ———

  @RequirePermission("opd.masters.read", "hospital")
  @Get("rooms")
  async rooms(@Query() query: unknown): Promise<{ items: RoomRow[] }> {
    const q = parsed(activeQuery, query);
    return { items: await listRooms(this.db, { activeOnly: q.active === "true" }) };
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Post("rooms")
  async createRoom(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ roomId: string }> {
    const b = parsed(roomCreateBody, body);
    try {
      return await withTx(this.db, (tx) => createRoom(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Patch("rooms/:id")
  async patchRoom(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(roomPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateRoom(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— doctors (the list route is declared before ':id') ———

  @RequirePermission("opd.masters.read", "hospital")
  @Get("doctors")
  async doctors(@Query() query: unknown): Promise<{ items: DoctorRow[] }> {
    const q = parsed(doctorsQuery, query);
    return { items: await listDoctors(this.db, { departmentId: q.departmentId, activeOnly: q.active === "true" }) };
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Post("doctors")
  async createDoctor(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ doctorId: string; userId: string }> {
    const b = parsed(doctorCreateBody, body);
    try {
      return await withTx(this.db, (tx) => createDoctor(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.masters.read", "hospital")
  @Get("doctors/:id")
  async doctor(@Param("id") id: string): Promise<DoctorRow> {
    const doctor = await getDoctor(this.db, id);
    if (!doctor) toHttp(new OpdError("unknown_doctor", `doctor ${id} not found`));
    return doctor;
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Patch("doctors/:id")
  async patchDoctor(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(doctorPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateDoctor(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— weekly schedules ———

  @RequirePermission("opd.masters.read", "hospital")
  @Get("doctors/:id/schedules")
  async schedules(@Param("id") id: string): Promise<{ items: Awaited<ReturnType<typeof listDoctorSchedules>> }> {
    return { items: await listDoctorSchedules(this.db, id, { activeOnly: true }) };
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Put("doctors/:id/schedules")
  async putSchedules(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ scheduleIds: string[] }> {
    const b = parsed(schedulesBody, body);
    try {
      return await withTx(this.db, (tx) => replaceDoctorSchedules(tx, actor, id, b.items.map((item) => ({
        weekday: item.weekday,
        startTime: item.startTime,
        endTime: item.endTime,
        roomId: item.roomId,
        slotMinutes: item.slotMinutes ?? null,
        validFrom: item.validFrom,
        validTo: item.validTo ?? null,
      }))));
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— leaves (§11.5 cascade) ———

  @RequirePermission("opd.masters.read", "hospital")
  @Get("leaves")
  async leaves(@Query() query: unknown): Promise<{ items: LeaveRow[] }> {
    const q = parsed(leavesQuery, query);
    return { items: await listLeaves(this.db, q) };
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Post("leaves")
  async createLeave(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ leaveId: string; affectedAppointmentIds: string[] }> {
    const b = parsed(leaveCreateBody, body);
    try {
      return await scheduleDoctorLeave(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Post("leaves/:id/cancel")
  async cancelLeave(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ restored: number }> {
    try {
      return await cancelDoctorLeave(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }
}
