import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { BillingError, billingHttpStatus } from "../billing";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import {
  administerDose, decideAllergyFlag, holdDose, issueMed, markDoseInError, missDose, recordInfusionEvent, recordNarcoticWastage, refuseDose, reofferHeldDoses,
  resolveAllergyFlag, returnMed, secondCheck, signVerbalOrder, verifyOrder,
} from "./emar";
import { readAdmissionAllergyFlags, readEmarDue, readEmarPatient, readLabelSheet, readOverrideCounts, readPharmacyQueue, readWardChart, scanAtBedside } from "./emar-read";
import { placeIpOrder } from "./orders";
import { IPD_EMAR_GIVE, IPD_EMAR_ISSUE, IPD_EMAR_VERIFY, IPD_EMAR_VIEW, IPD_ORDER_PLACE } from "./permissions";
import type {
  Actor, IpdEmarDueList, IpdEmarLabelSheet, IpdEmarOverrideCounts, IpdEmarPatient, IpdEmarPharmacyQueue, IpdEmarScan, IpdEmarWardChart, IpdRefusalBody,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E4.3 (#735) — the eMAR routes (`IPD_EMAR_ROUTES`). Thin: each route is its act function, which re-checks the permission
 * (the copilot never reaches these: doses and orders have no agent tier, §4.11). Refusals answer `IpdRefusalBody`. No answer
 * here carries money (decision 0058).
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code.endsWith("_not_found") ? 404 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof BillingError) {
    // The idempotency helper's answers (a key still in flight, or reused with another body): 409, never a 500.
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const idParam = z.ulid();
const wardQuery = z.object({ wardId: z.ulid().optional(), day: z.iso.date().optional() });
const scanBody = z.strictObject({
  wristbandCode: z.string().trim().max(128).optional(), admissionId: z.ulid().optional(), labelCode: z.string().trim().max(128).optional(),
});
const overridesQuery = z.object({ days: z.coerce.number().int().min(1).max(365).optional() });

@Controller("ipd/emar")
export class IpdEmarController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("pharmacy")
  @RequirePermission(IPD_EMAR_VERIFY, "hospital")
  async pharmacy(@CurrentActor() actor: Actor): Promise<IpdEmarPharmacyQueue> {
    try { return await readPharmacyQueue(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("verify")
  @RequirePermission(IPD_EMAR_VERIFY, "hospital")
  async verify(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await verifyOrder(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("issue")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async issue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await issueMed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("issues/:issueId/labels")
  @RequirePermission(IPD_EMAR_VERIFY, "hospital")
  async labels(@CurrentActor() actor: Actor, @Param("issueId") id: string): Promise<IpdEmarLabelSheet> {
    try { return await readLabelSheet(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Post("return")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async returnMed(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await returnMed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("allergy-flags/resolve")
  @RequirePermission(IPD_EMAR_VERIFY, "hospital")
  async resolveFlag(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await resolveAllergyFlag(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("admissions/:admissionId")
  @RequirePermission(IPD_EMAR_VIEW, "hospital")
  async patient(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdEmarPatient> {
    try { return await readEmarPatient(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("admissions/:admissionId/allergy-flags")
  @RequirePermission(IPD_EMAR_VIEW, "hospital")
  async admissionFlags(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<unknown> {
    try { return await readAdmissionAllergyFlags(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("ward")
  @RequirePermission(IPD_EMAR_VIEW, "hospital")
  async ward(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdEmarWardChart> {
    try {
      const q = wardQuery.parse(query);
      // The IST day is the kernel's (`istDayWindow` inside the read): any instant of that date does; UTC noon is inside it.
      return await readWardChart(this.db, actor, { ...(q.wardId ? { wardId: q.wardId } : {}), ...(q.day ? { day: istDayWindow(new Date(`${q.day}T12:00:00Z`)).start } : {}) });
    } catch (e) { toHttp(e); }
  }

  @Get("due")
  @RequirePermission(IPD_EMAR_VIEW, "hospital")
  async due(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdEmarDueList> {
    try { const q = wardQuery.parse(query); return await readEmarDue(this.db, actor, q.wardId ? { wardId: q.wardId } : {}); } catch (e) { toHttp(e); }
  }

  @Post("scan")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async scan(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IpdEmarScan> {
    try { return await scanAtBedside(this.db, actor, scanBody.parse(body)); } catch (e) { toHttp(e); }
  }

  @Post("give")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async give(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await administerDose(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  // A doctor may hold a dose too (`doctor_instruction`); the act accepts `ipd.emar.give` or `ipd.order.place`.
  @Post("hold")
  @RequirePermission(IPD_EMAR_VIEW, "hospital")
  async hold(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await holdDose(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("refuse")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async refuse(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await refuseDose(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("miss")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async miss(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await missDose(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("reoffer")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async reoffer(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reofferHeldDoses(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("correct")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async correct(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await markDoseInError(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("second-check")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async secondCheck(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await secondCheck(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("infusion")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async infusion(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordInfusionEvent(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("narcotic-wastage")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async wastage(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordNarcoticWastage(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  /** A nurse records an emergency verbal order (read back): the act requires `ipd.emar.give` and the `verbal` block. */
  @Post("verbal-orders")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async verbal(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try {
      const b = (body ?? {}) as { verbal?: unknown };
      if (b.verbal === undefined) throw new IpdRefusal("verbal_order_only");
      return await placeIpOrder(this.db, actor, body);
    } catch (e) { toHttp(e); }
  }

  @Post("verbal-orders/sign")
  @RequirePermission(IPD_ORDER_PLACE, "hospital")
  async signVerbal(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await signVerbalOrder(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("allergy-flags/decide")
  @RequirePermission(IPD_ORDER_PLACE, "hospital")
  async decideFlag(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await decideAllergyFlag(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("overrides")
  @RequirePermission(IPD_EMAR_VIEW, "hospital")
  async overrides(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdEmarOverrideCounts> {
    try { const q = overridesQuery.parse(query); return await readOverrideCounts(this.db, actor, q.days ? { days: q.days } : {}); } catch (e) { toHttp(e); }
  }
}
