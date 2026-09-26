import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, Public, RequirePermission } from "../../kernel/auth/decorators";
import { HiuError, readExternalRecords } from "./hiu";
import { HIU_PUSH_PREFIX } from "./hiu-client";
import { loggableHeaders } from "./redact";
import { AbdmRuntime } from "./runtime";
import type { Actor } from "@hmis/contracts";
import type { Request, Response } from "express";
import type { HiuErrorCode, HiuRequestView, PatientExternalRecords } from "./hiu";

/**
 * ═══ ABDM S3 — THE HIU'S ROUTES: THE DOCTOR'S THREE, AND THE PUSH ═══
 *
 * PERMISSION: none new (DECIDED). All three ride `opd.consult` — "this person conducts consultations",
 * the permission the consult's own cross-visit histories use — and the REQUEST additionally takes the
 * consult's own guards in the service: the encounter's TREATING doctor (`requireTreatingDoctor`, D5)
 * and an OPEN consultation. A permission-holder who is not that doctor is refused `not_your_patient`.
 *
 *   GET  /abdm/hiu/patients/:patientId/records      the requests, their status, the received records
 *   POST /abdm/hiu/consent-requests                  ask (treating doctor, open consult)
 *   POST /abdm/hiu/consent-requests/:id/status       ask ABDM where it stands (FT HIU_FLOW_104)
 *
 * The read works with ABDM off (it reads what is stored and still erases what has expired); the two
 * writes answer 503 `abdm_hiu_not_configured` unless ABDM is configured WITH `ABDM_HIU_ID`.
 *
 * THE PUSH — `POST /abdm/callbacks/hiu/data-push/:token` — is `@Public()` to user auth and NOT behind
 * the callback JWT guard: it is the HIP's POST to the `dataPushUrl` we gave ABDM, which the NHA
 * wrapper's HIP sends with no Authorization at all. Its authentication is the address itself plus the
 * transaction and the key (`hiu-client.ts` says why, UNVERIFIED). Under `/abdm/callbacks` so the public
 * URL is `{ABDM_CALLBACK_BASE_URL}/hiu/data-push/<token>` behind the existing `/api/*` proxy.
 */
const requestBody = z.object({
  encounterId: z.string().min(1).max(64),
  purposeCode: z.string().min(1).max(16).optional(),
  hiTypes: z.array(z.string().min(1).max(40)).min(1).max(8).optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  dataEraseAt: z.string().min(1).max(40).optional(),
}).strict();

const STATUS: Record<HiuErrorCode, number> = {
  abdm_hiu_not_configured: 503,
  encounter_not_found: 404,
  not_a_doctor: 403,
  not_your_patient: 403,
  consultation_not_open: 409,
  patient_not_found: 404,
  abha_not_verified: 409,
  purpose_not_allowed: 400,
  hi_types_invalid: 400,
  date_range_invalid: 400,
  expiry_invalid: 400,
  consent_request_not_found: 404,
  consent_request_not_ready: 409,
};

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HiuError) throw new HttpException({ statusCode: STATUS[e.code], code: e.code, message: e.message }, STATUS[e.code]);
    throw e;
  }
}

@Controller("abdm/hiu")
export class AbdmHiuController {
  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  private hiu() {
    const hiu = this.runtime.hiu;
    if (hiu === null) throw new HiuError("abdm_hiu_not_configured", "ABDM is not configured as an HIU at this hospital (ABDM_HIU_ID)");
    return hiu;
  }

  @RequirePermission("opd.consult", "hospital")
  @Get("patients/:patientId/records")
  records(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<PatientExternalRecords> {
    return guarded(() => readExternalRecords(this.runtime.db, actor, patientId, { hiuConfigured: this.runtime.hiu !== null, now: this.runtime.now() }));
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("consent-requests")
  request(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<HiuRequestView> {
    return guarded(async () => {
      const hiu = this.hiu();
      const r = requestBody.safeParse(body ?? {});
      if (!r.success) {
        throw new HttpException({ statusCode: 400, code: "invalid_body", message: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.code}`).join("; ") }, 400);
      }
      return hiu.requestConsent(actor, r.data);
    });
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("consent-requests/:id/status")
  @HttpCode(200)
  status(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<HiuRequestView> {
    return guarded(() => this.hiu().refreshStatus(actor, id));
  }
}

const PUSH_HEADERS = ["request-id", "timestamp", "x-cm-id", "x-hip-id", "x-hiu-id", "content-type", "authorization"];

@Controller(`abdm/callbacks${HIU_PUSH_PREFIX}`)
export class AbdmHiuPushController {
  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  @Public()
  @Post(":token")
  async push(@Param("token") token: string, @Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ code: string; message: string }> {
    const hiu = this.runtime.hiu;
    if (hiu === null) throw new HttpException({ statusCode: 503, code: "abdm_hiu_not_configured", message: "ABDM not configured" }, 503);
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new HttpException({ statusCode: 404, code: "unknown_transfer", message: "no such push address" }, 404);
    const kept: Record<string, string> = {};
    for (const name of PUSH_HEADERS) {
      const v = req.headers[name];
      const one = Array.isArray(v) ? v[0] : v;
      if (typeof one === "string" && one.trim() !== "") kept[name] = one.trim();
    }
    const answer = await hiu.receivePush(token, loggableHeaders(kept), body ?? null);
    res.status(answer.status);
    return { code: answer.code, message: answer.message };
  }
}
