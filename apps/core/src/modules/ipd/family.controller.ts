import { randomBytes } from "node:crypto";
import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import {
  IpdCloseCallbackSchema, IpdFamilyCallbackRequestSchema, IpdFamilyOtpSchema, IpdIssueFamilyLinkSchema, IpdSetConditionSchema,
} from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, Public, RequirePermission } from "../../kernel/auth/decorators";
import { IpdError } from "./errors";
import {
  closeFamilyCallback, issueFamilyLink, listFamilyCallbacks, readFamilyPanel, revokeFamilyLink, setCondition,
} from "./family";
import {
  familyGate, readFamilyBillDetails, readFamilyView, requestFamilyCallback, sendFamilyOtp, verifyFamilyOtp,
} from "./family-public";
import { familyOtpSender } from "./family-otp";
import { IPD_CONDITION_SET, IPD_DISCHARGE_VIEW, IPD_FAMILY_ISSUE } from "./manifest";
import type { z } from "zod";
import type {
  Actor, IpdFamilyBillDetails, IpdFamilyCallbackList, IpdFamilyGate, IpdFamilyLinkIssued, IpdFamilyPanel, IpdFamilyView,
} from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { FamilyOtpSender } from "./family-otp";

/**
 * E3.3 (#731) — the family link over HTTP (`IPD_FAMILY_ROUTES`).
 *
 * STAFF routes carry `@RequirePermission` like every other. The PUBLIC routes (`/ipd/family/:token…`) are `@Public()` to
 * the staff AuthGuard — the attendant holds no staff session — and authenticate themselves: the link token in the path,
 * a device cookie and (after the OTP) a session cookie, both http-only, `SameSite=Strict`, scoped to `/api/ipd/family`
 * (the browser's path; Caddy strips `/api`). Refusals use 401 (verify first), 404/410 (closed), 429 (limits).
 */
const COOKIE_PATH = "/api/ipd/family";
const DEVICE_COOKIE = "hmis_fdev";
const SESSION_COOKIE = "hmis_fses";
const DEVICE_DAYS = 30;

type Req = { headers: Record<string, string | string[] | undefined>; secure?: boolean };
type Res = { setHeader(name: string, value: string | string[]): void; getHeader(name: string): unknown };

function cookiesOf(req: Req): { device?: string; session?: string } {
  const raw = req.headers.cookie;
  const header = Array.isArray(raw) ? raw.join(";") : raw ?? "";
  const out: { device?: string; session?: string } = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(v)) continue;
    if (k === DEVICE_COOKIE) out.device = v;
    if (k === SESSION_COOKIE) out.session = v;
  }
  return out;
}

function addCookie(req: Req, res: Res, name: string, value: string, maxAgeSeconds: number): void {
  const proto = req.headers["x-forwarded-proto"];
  const secure = req.secure === true || proto === "https";
  const cookie = `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${String(maxAgeSeconds)}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  const prev = res.getHeader("Set-Cookie");
  const list = Array.isArray(prev) ? prev.map(String) : typeof prev === "string" ? [prev] : [];
  res.setHeader("Set-Cookie", [...list, cookie]);
}

/** The device id: the cookie's, or a fresh one set on this response. */
function deviceOf(req: Req, res: Res): string {
  const have = cookiesOf(req).device;
  if (have !== undefined) return have;
  const fresh = randomBytes(24).toString("base64url");
  addCookie(req, res, DEVICE_COOKIE, fresh, DEVICE_DAYS * 86_400);
  return fresh;
}

const STATUS: Partial<Record<string, number>> = {
  ipd_forbidden: 403, family_link_not_found: 404, family_callback_not_found: 404, family_link_closed: 410, family_otp_limit: 429,
  family_callback_limit: 429, family_session_required: 401, family_otp_invalid: 401, family_otp_unavailable: 503,
};

function toHttp(e: unknown): never {
  if (e instanceof IpdError) {
    const status = STATUS[e.code] ?? 409;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  throw e;
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpException({ statusCode: 400, code: "invalid_body", message: "invalid body", issues: r.error.issues }, 400);
  return r.data;
}

@Controller("ipd")
export class IpdFamilyController {
  private readonly sender: FamilyOtpSender;

  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) cfg: AppConfig) {
    this.sender = familyOtpSender(cfg);
  }

  // ═══ staff ═══

  @Get("admissions/:id/family")
  @RequirePermission(IPD_DISCHARGE_VIEW, "hospital")
  async panel(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IpdFamilyPanel> {
    try { return await readFamilyPanel(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/family-link")
  @RequirePermission(IPD_FAMILY_ISSUE, "hospital")
  async issue(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<IpdFamilyLinkIssued> {
    const input = parse(IpdIssueFamilyLinkSchema, body);
    try { return await issueFamilyLink(this.db, actor, id, input); } catch (e) { toHttp(e); }
  }

  @Post("family-links/:id/revoke")
  @HttpCode(200)
  @RequirePermission(IPD_FAMILY_ISSUE, "hospital")
  async revoke(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ revoked: boolean }> {
    try { return await revokeFamilyLink(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Put("admissions/:id/condition")
  @RequirePermission(IPD_CONDITION_SET, "hospital")
  async condition(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ word: string | null; familyOff: string | null }> {
    const input = parse(IpdSetConditionSchema, body);
    try { return await setCondition(this.db, actor, id, input); } catch (e) { toHttp(e); }
  }

  @Get("family-callbacks")
  @RequirePermission(IPD_FAMILY_ISSUE, "hospital")
  async callbacks(@CurrentActor() actor: Actor, @Query("status") status?: string): Promise<IpdFamilyCallbackList> {
    try { return await listFamilyCallbacks(this.db, actor, { status: status === "done" ? "done" : "open" }); } catch (e) { toHttp(e); }
  }

  @Post("family-callbacks/:id/close")
  @HttpCode(200)
  @RequirePermission(IPD_FAMILY_ISSUE, "hospital")
  async close(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ closed: boolean }> {
    const input = parse(IpdCloseCallbackSchema, body);
    try { return await closeFamilyCallback(this.db, actor, id, input.note); } catch (e) { toHttp(e); }
  }

  // ═══ public: the attendant's phone ═══

  @Public()
  @Get("family/:token")
  async gate(@Param("token") token: string, @Req() req: Req, @Res({ passthrough: true }) res: Res): Promise<IpdFamilyGate> {
    deviceOf(req, res);
    try { return await familyGate(this.db, token, cookiesOf(req)); } catch (e) { toHttp(e); }
  }

  @Public()
  @Post("family/:token/otp")
  @HttpCode(200)
  async otp(@Param("token") token: string, @Req() req: Req, @Res({ passthrough: true }) res: Res): Promise<{ phoneMasked: string; expiresAt: string }> {
    const device = deviceOf(req, res);
    try { return await sendFamilyOtp(this.db, token, device, this.sender); } catch (e) { toHttp(e); }
  }

  @Public()
  @Post("family/:token/verify")
  @HttpCode(200)
  async verify(@Param("token") token: string, @Body() body: unknown, @Req() req: Req, @Res({ passthrough: true }) res: Res): Promise<{ verified: true; expiresAt: string }> {
    const input = parse(IpdFamilyOtpSchema, body);
    const device = cookiesOf(req).device;
    if (device === undefined) throw new HttpException({ statusCode: 401, code: "family_otp_invalid", message: "Please ask for a new code." }, 401);
    try {
      const s = await verifyFamilyOtp(this.db, token, device, input.code);
      addCookie(req, res, SESSION_COOKIE, s.sessionToken, Math.max(1, Math.floor((s.expiresAt.getTime() - Date.now()) / 1000)));
      return { verified: true, expiresAt: s.expiresAt.toISOString() };
    } catch (e) { toHttp(e); }
  }

  @Public()
  @Get("family/:token/view")
  async view(@Param("token") token: string, @Req() req: Req): Promise<IpdFamilyView> {
    try { return await readFamilyView(this.db, token, cookiesOf(req)); } catch (e) { toHttp(e); }
  }

  @Public()
  @Post("family/:token/bill-details")
  @HttpCode(200)
  async billDetails(@Param("token") token: string, @Req() req: Req): Promise<IpdFamilyBillDetails> {
    try { return await readFamilyBillDetails(this.db, token, cookiesOf(req)); } catch (e) { toHttp(e); }
  }

  @Public()
  @Post("family/:token/callback")
  @HttpCode(200)
  async callback(@Param("token") token: string, @Body() body: unknown, @Req() req: Req): Promise<{ callbackId: string; status: "open" }> {
    const input = parse(IpdFamilyCallbackRequestSchema, body);
    try { return await requestFamilyCallback(this.db, token, cookiesOf(req), input.text); } catch (e) { toHttp(e); }
  }
}
