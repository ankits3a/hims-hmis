import { Body, Controller, Get, Header, HttpCode, HttpException, Inject, Param, Post, Query, StreamableFile } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { PatientError } from "../patients";
import { AbhaError } from "./abha-client";
import { AbhaFlowError } from "./abha-service";
import { counterQrUrl, ShareError } from "./profile-shares";
import { AbdmRuntime } from "./runtime";
import type { Actor } from "@hmis/contracts";
import type { AbhaFlowView } from "./abha-service";
import type { DemographicChange, FieldComparison } from "./profile";
import type { ShareView } from "./profile-shares";

/**
 * ═══ ABDM S1 — THE COUNTER'S ABHA ROUTES ═══
 *
 * PERMISSIONS: none new. Every step a registration clerk takes rides the permission the counter's
 * own ABHA question already uses — `patients.register` (FD-12's `GET /patients/abha/capability`) —
 * and the two steps that WRITE to an existing patient (the links) ride `patients.update`, the
 * permission `PATCH /patients/:id` needs for the same columns. `front_office` and
 * `front_office_supervisor` hold both (seed-roles), so Desk One's register-then-link works; the two
 * roles that hold `patients.register` WITHOUT `patients.update` (`pharmacy`'s walk-in counter and
 * `billing_manager`'s stopgap cover) can verify an ABHA but not write it to a record — exactly what
 * they may do through `PATCH /patients/:id` today.
 *
 * NOT CONFIGURED ⇒ 503 "ABDM not configured" on every route here, like S0's callbacks.
 *
 * THE BROWSER NEVER SEES ABDM's `txnId` or the patient's X-token: a flow is an opaque
 * `transactionId` (`abha-transactions.ts`), and the answers are `AbhaFlowView`s.
 */
const verifyBody = z.object({
  identifier: z.string().min(1).max(100),
  method: z.enum(["aadhaar_otp", "mobile_otp"]),
  patientId: z.string().min(1).max(64).nullable().optional(),
}).strict();
/**
 * `aadhaar` is a STRING of at most 20 characters and nothing else is said about it here: a zod issue
 * would echo the value in its 400, and the Aadhaar number must never be in an error. The service
 * checks its shape and says only that the shape was wrong.
 */
const createBody = z.object({
  aadhaar: z.string().max(20),
  patientConsented: z.boolean(),
  patientId: z.string().min(1).max(64).nullable().optional(),
}).strict();
const otpBody = z.object({ otp: z.string().max(10), mobile: z.string().max(15).nullable().optional() }).strict();
const mobileOtpBody = z.object({ otp: z.string().max(10) }).strict();
/** A re-send of an AADHAAR OTP carries the number again (nothing kept it) — the same silence as `createBody`. */
const resendBody = z.object({ aadhaar: z.string().max(20).optional() }).strict();
const accountBody = z.object({ abhaNumber: z.string().min(1).max(20) }).strict();
const addressBody = z.object({ abhaAddress: z.string().min(1).max(40) }).strict();
const patientBody = z.object({ patientId: z.string().min(1).max(64) }).strict();
/**
 * `acceptAbdmDemographics` — the clerk has seen ABDM's name, birth and gender beside the record's
 * and accepts ABDM's (DECIDED: ABDM-verified demographics are authoritative, NHA's M1 workbook).
 */
const linkBody = z.object({ patientId: z.string().min(1).max(64), acceptAbdmDemographics: z.boolean().optional() }).strict();
const qrQuery = z.object({ counter: z.string().max(40).optional() });

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    // The issues' PATHS, never their input values — see `createBody`.
    throw new HttpException({ statusCode: 400, code: "invalid_body", message: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.code}`).join("; ") }, 400);
  }
  return r.data;
}

const FLOW_STATUS: Record<AbhaFlowError["code"], number> = {
  abdm_not_configured: 503,
  abha_create_disabled: 403,
  abha_find_by_aadhaar_disabled: 403,
  otp_resend_too_soon: 429,
  otp_resend_limit: 429,
  abha_account_not_offered: 400,
  abha_address_invalid: 400,
  abha_already_linked: 409,
  abdm_transaction_not_found: 404,
  abdm_transaction_expired: 410,
  abdm_transaction_wrong_step: 409,
  abha_identifier_invalid: 400,
  otp_invalid: 400,
  otp_attempts_exhausted: 429,
  aadhaar_invalid: 400,
  mobile_invalid: 400,
  aadhaar_consent_required: 400,
  abha_profile_mismatch: 409,
  abha_profile_no_number: 409,
  patient_not_found: 404,
};
const SHARE_STATUS: Record<ShareError["code"], number> = {
  share_not_found: 404, share_not_pending: 409, share_expired: 410, counter_invalid: 400,
  abha_profile_mismatch: 409, patient_not_found: 404, abha_already_linked: 409,
};

/** Every refusal as `{statusCode, code, message, detail?}` — the shape `OpdError` and FD-8 use. */
function toHttp(e: unknown): never {
  const out = (status: number, code: string, message: string, detail?: unknown): never => {
    throw new HttpException({ statusCode: status, code, message, ...(detail !== undefined ? { detail } : {}) }, status);
  };
  if (e instanceof AbhaFlowError) {
    if (e.code === "abdm_not_configured") out(503, e.code, "ABDM not configured");
    out(FLOW_STATUS[e.code], e.code, e.message, e.detail);
  }
  if (e instanceof ShareError) out(SHARE_STATUS[e.code], e.code, e.message, e.detail);
  if (e instanceof AbhaError) out(e.code === "abdm_refused" ? 422 : 502, e.code, e.message);
  if (e instanceof PatientError) {
    if (e.code === "patient_not_found") out(404, e.code, e.message);
    if (e.code === "patient_not_active") out(409, e.code, e.message);
    // A race the pre-check lost (the index said no), or the lock — both conflicts, the first with its holder.
    if (e.code === "abha_already_linked") out(409, e.code, e.message.replace(/^abha_already_linked: /, ""), e.detail);
    if (e.code === "abha_demographics_locked") out(409, e.code, e.message);
    if (e.code === "abha_number_invalid") out(502, e.code, e.message);
    out(400, e.code, e.message);
  }
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    toHttp(e);
  }
}

@Controller("abdm")
export class AbdmAbhaController {
  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  private shares() {
    const shares = this.runtime.shares;
    if (shares === null) throw new HttpException({ statusCode: 503, code: "abdm_not_configured", message: "ABDM not configured" }, 503);
    return shares;
  }

  // ——— verify an existing ABHA ———

  @RequirePermission("patients.register", "hospital")
  @Post("abha/verify")
  startVerification(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<AbhaFlowView> {
    const b = parsed(verifyBody, body);
    return guarded(() => this.runtime.abhaService.startVerification(actor, b));
  }

  // ——— create an ABHA by Aadhaar OTP (403 abha_create_disabled until the owner rules) ———

  @RequirePermission("patients.register", "hospital")
  @Post("abha/create")
  startCreate(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<AbhaFlowView> {
    // The flag is asked FIRST — before the body is read at all — so a switched-off deployment never
    // so much as parses an Aadhaar number.
    return guarded(async () => {
      if (this.runtime.settings !== null && !this.runtime.abhaService.isCreateEnabled()) {
        throw new AbhaFlowError("abha_create_disabled", "creating an ABHA by Aadhaar OTP is switched off at this hospital");
      }
      const b = parsed(createBody, body);
      return this.runtime.abhaService.startCreate(actor, b);
    });
  }

  // ——— find an ABHA by Aadhaar (403 abha_find_by_aadhaar_disabled while Aadhaar creation is off) ———

  @RequirePermission("patients.register", "hospital")
  @Post("abha/find-by-aadhaar")
  startFindByAadhaar(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<AbhaFlowView> {
    return guarded(async () => {
      if (this.runtime.settings !== null && !this.runtime.abhaService.isCreateEnabled()) {
        throw new AbhaFlowError("abha_find_by_aadhaar_disabled", "finding an ABHA by Aadhaar is switched off at this hospital");
      }
      const b = parsed(createBody, body);
      return this.runtime.abhaService.startFindByAadhaar(actor, b);
    });
  }

  // ——— one flow, by its opaque handle ———

  /** Re-send the OTP: at most twice, 60 s apart (FT CRT_ABHA_106, VRFY_ABHA_305/405). */
  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/resend")
  @HttpCode(200)
  resend(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<AbhaFlowView> {
    const b = parsed(resendBody, body);
    return guarded(() => this.runtime.abhaService.resendOtp(actor, id, b));
  }

  /** Pick one of the ABHAs a mobile / Aadhaar find returned (VRFY_ABHA_303/404). */
  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/account")
  @HttpCode(200)
  chooseAccount(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<AbhaFlowView> {
    const b = parsed(accountBody, body);
    return guarded(() => this.runtime.abhaService.chooseAccount(actor, id, b));
  }

  /** Creation: an OTP to a communication mobile that is not Aadhaar's (CRT_ABHA_109). */
  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/mobile/otp")
  @HttpCode(200)
  sendMobileOtp(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AbhaFlowView> {
    return guarded(() => this.runtime.abhaService.sendMobileOtp(actor, id));
  }

  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/mobile/verify")
  @HttpCode(200)
  verifyMobileOtp(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<AbhaFlowView> {
    const b = parsed(mobileOtpBody, body);
    return guarded(() => this.runtime.abhaService.verifyMobileOtp(actor, id, b));
  }

  /** Creation: ABDM's suggested ABHA addresses, then the chosen one (CRT_ABHA_112). */
  @RequirePermission("patients.register", "hospital")
  @Get("abha/transactions/:id/address-suggestions")
  suggestAddresses(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AbhaFlowView> {
    return guarded(() => this.runtime.abhaService.suggestAddresses(actor, id));
  }

  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/address")
  @HttpCode(200)
  createAddress(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<AbhaFlowView> {
    const b = parsed(addressBody, body);
    return guarded(() => this.runtime.abhaService.createAddress(actor, id, b));
  }

  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/otp")
  @HttpCode(200)
  submitOtp(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<AbhaFlowView> {
    const b = parsed(otpBody, body);
    return guarded(() => this.runtime.abhaService.submitOtp(actor, id, b));
  }

  @RequirePermission("patients.register", "hospital")
  @Get("abha/transactions/:id")
  current(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AbhaFlowView> {
    return guarded(() => this.runtime.abhaService.current(actor, id));
  }

  /** The ABHA card, as `{mimeType, imageBase64}` — the patient photo's shape. Never stored. */
  @RequirePermission("patients.register", "hospital")
  @Get("abha/transactions/:id/card")
  async card(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ mimeType: string; imageBase64: string }> {
    const c = await guarded(() => this.runtime.abhaService.card(actor, id));
    return { mimeType: c.contentType, imageBase64: c.bytes.toString("base64") };
  }

  /**
   * THE CARD AS A FILE (CRT_ABHA_114): ABDM's PNG or PDF streamed straight to the clerk with a
   * download disposition, `no-store` so no proxy or browser cache keeps it, and nothing persisted.
   */
  @RequirePermission("patients.register", "hospital")
  @Get("abha/transactions/:id/card/download")
  @Header("Cache-Control", "no-store")
  async cardDownload(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<StreamableFile> {
    const c = await guarded(() => this.runtime.abhaService.card(actor, id));
    const ext = c.contentType === "application/pdf" ? "pdf" : c.contentType === "image/jpeg" ? "jpg" : "png";
    const tail = (c.abhaNumber ?? "").replace(/\D/g, "").slice(-4);
    return new StreamableFile(c.bytes, {
      type: c.contentType,
      disposition: `attachment; filename="ABHA-card${tail === "" ? "" : `-${tail}`}.${ext}"`,
      length: c.bytes.length,
    });
  }

  @RequirePermission("patients.register", "hospital")
  @Post("abha/transactions/:id/compare")
  @HttpCode(200)
  compare(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ comparison: FieldComparison[]; demographicsToApply: DemographicChange[] }> {
    const b = parsed(patientBody, body);
    return guarded(() => this.runtime.abhaService.compare(actor, id, b.patientId));
  }

  @RequirePermission("patients.update", "hospital")
  @Post("abha/transactions/:id/link")
  @HttpCode(200)
  link(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ patientId: string; changed: string[]; comparison: FieldComparison[]; demographicsApplied: DemographicChange[] }> {
    const b = parsed(linkBody, body);
    return guarded(() => this.runtime.abhaService.link(actor, id, b));
  }

  // ——— scan and share ———

  @RequirePermission("patients.register", "hospital")
  @Get("scan-share/qr")
  qr(@Query() query: unknown): { url: string; hipId: string; counterId: string } {
    const q = parsed(qrQuery, query);
    const settings = this.runtime.settings;
    if (settings === null) throw new HttpException({ statusCode: 503, code: "abdm_not_configured", message: "ABDM not configured" }, 503);
    const counterId = q.counter ?? "1";
    try {
      return { url: counterQrUrl(settings, counterId), hipId: settings.hipId, counterId };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.register", "hospital")
  @Get("scan-share/shares")
  async listShares(@CurrentActor() actor: Actor): Promise<{ shares: ShareView[] }> {
    return { shares: await this.shares().listPending(actor) };
  }

  @RequirePermission("patients.register", "hospital")
  @Get("scan-share/shares/:id")
  getShare(@Param("id") id: string): Promise<ShareView> {
    return guarded(() => this.shares().get(id));
  }

  @RequirePermission("patients.update", "hospital")
  @Post("scan-share/shares/:id/link")
  @HttpCode(200)
  linkShare(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ share: ShareView; changed: string[]; comparison: FieldComparison[]; demographicsApplied: DemographicChange[] }> {
    const b = parsed(linkBody, body);
    return guarded(() => this.shares().link(actor, id, b));
  }

  @RequirePermission("patients.register", "hospital")
  @Post("scan-share/shares/:id/dismiss")
  @HttpCode(200)
  dismissShare(@Param("id") id: string): Promise<ShareView> {
    return guarded(() => this.shares().dismiss(id));
  }
}
