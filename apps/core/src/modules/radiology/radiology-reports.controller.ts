import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import {
  acknowledgeCritical, amendReport, draftReport, flagCritical, proposeDraft, publishReport, savePrelim, signReport,
} from "./reports";
import { reportView, studyView, worklist } from "./read";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { AuthedRequest } from "../../kernel/auth/decorators";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 18a T8 — **REPORTING OVER HTTP, AND THE SIGNATURE CARRIES THE SESSION.**
 *
 * ═══ WHY `signReport` TAKES THE SESSION AND NOT A PARAMETER ═══
 *
 * §11.19-D-27 requires a signature to be made under a SECOND FACTOR that is fresh. The freshness is
 * a property of the SESSION — `sessions.second_factor_at`, stamped when the signer last presented
 * their TOTP — and a route that let the caller send `secondFactorAt` in the body would be letting
 * the signature attest to its own freshness. So the controller reads it off `req.hmisSession` and
 * the service compares; the body cannot carry it and there is no parameter for it.
 *
 * The decorator's own `secondFactor: true` option is the guard's half of the same rule: it refuses
 * the request outright when the session's factor is stale. The service check is not redundant with
 * it — the guard protects the ROUTE and the service protects the FUNCTION, and T9's end-to-end
 * proof and any future internal caller reach only the second.
 *
 * (That option is named here WITHOUT the decorator's `@` and parentheses on purpose — F44:
 * `roles-catalog.e2e.test.ts` parses this whole tree as TEXT, so a comment quoting a decorator
 * verbatim is indistinguishable from one, and this file's prose failed that census for real.)
 */
const contentBody = z.object({
  templateKey: z.string().min(1).max(40).optional(),
  body: z.record(z.string(), z.unknown()),
  impression: z.string().max(8000).nullish(),
  laterality: z.enum(["left", "right", "bilateral", "na"]).nullish(),
  /** F66 — the medical superintendent who approved a demographic-tier lockout hit, and why. */
  lockoutOverride: z.object({
    approvedBy: z.string().min(1).max(64),
    reason: z.string().min(1).max(400),
  }).nullish(),
});

const signBody = z.object({
  reportId: idSchema,
  criticalCategory: z.enum(["red", "orange", "yellow"]).nullish(),
});

const amendBody = contentBody.extend({
  reason: z.string().min(1).max(400),
  criticalCategory: z.enum(["red", "orange", "yellow"]).nullish(),
});

const criticalBody = z.object({
  category: z.enum(["red", "orange", "yellow"]),
  communicatedTo: z.string().min(1).max(120).nullish(),
});

/**
 * F76 — the acknowledgement names the CLINICIAN who received the call. It used to name whoever
 * typed it, and `radiology.criticals.ack` is granted to `radiologist` alone, so the loop was closed
 * at both ends by one person while the event told the downstream chaser it had reached a human.
 */
const ackBody = z.object({
  acknowledgedByClinicianId: z.string().min(1).max(64),
  readBack: z.string().min(1).max(2000).nullish(),
});

@Controller("radiology")
export class RadiologyReportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
    /**
     * §6.8 — the SAME window `AuthGuard` compared against on this very request. Passing it through
     * is what keeps the route and the function from disagreeing about one signature (see
     * `reports.ts`'s `SECOND_FACTOR_WINDOW_MINUTES`).
     */
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private decls() { return collectOrderKinds(this.registry); }

  /* ── the reads ── */

  @Get("worklist")
  @RequirePermission("radiology.worklist.read", "hospital")
  async worklist(
    @CurrentActor() actor: Actor,
    @Query("view") view?: string,
    @Query("deviceResourceId") deviceResourceId?: string,
  ): Promise<unknown> {
    try {
      const v = view === "unread" || view === "all" ? view : "floor";
      return { rows: await worklist(this.db, actor, { view: v, deviceResourceId }) };
    } catch (e) { toHttp(e); }
  }

  @Get("studies/:studyId")
  @RequirePermission("radiology.worklist.read", "hospital")
  async study(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { study: await studyView(this.db, actor, studyId) };
    } catch (e) { toHttp(e); }
  }

  @Get("reports/:reportId")
  @RequirePermission("radiology.reports.read", "hospital")
  async report(@CurrentActor() actor: Actor, @Param("reportId") reportId: string): Promise<unknown> {
    try {
      return { report: await reportView(this.db, actor, reportId) };
    } catch (e) { toHttp(e); }
  }

  /* ── the writes ── */

  @Post("studies/:studyId/reports/draft")
  @RequirePermission("radiology.reports.write", "hospital")
  async draft(
    @CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(contentBody, body);
    try {
      return await withTx(this.db, (tx) => draftReport(tx, actor, {
        studyId, ...input, impression: input.impression ?? null, laterality: input.laterality ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  /** O-11 — the night registrar's UNVERIFIED read. Real, quotable, and not publishable. */
  /** 18b T4 — the drafter proposes; the body is the study's own facts, so there is no body. */
  @Post("studies/:studyId/reports/propose")
  @RequirePermission("radiology.reports.write", "hospital")
  async propose(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => proposeDraft(tx, actor, { studyId }));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/reports/prelim")
  @RequirePermission("radiology.reports.write", "hospital")
  async prelim(
    @CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(contentBody, body);
    try {
      return await withTx(this.db, (tx) => savePrelim(tx, actor, {
        studyId, ...input, impression: input.impression ?? null, laterality: input.laterality ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  /** THE SIGNATURE. `secondFactor: true` on the guard, and the session's instant to the service. */
  @Post("studies/:studyId/reports/sign")
  @RequirePermission("radiology.reports.sign", "hospital", { secondFactor: true })
  async sign(
    @CurrentActor() actor: Actor,
    @Req() req: AuthedRequest,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(signBody, body);
    try {
      return await withTx(this.db, (tx) => signReport(tx, actor, {
        studyId, reportId: input.reportId,
        secondFactorAt: req.hmisSession?.secondFactorAt ?? null,
        windowMinutes: this.cfg.secondFactorWindowMinutes,
        criticalCategory: input.criticalCategory ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/reports/amend")
  @RequirePermission("radiology.reports.amend", "hospital", { secondFactor: true })
  async amend(
    @CurrentActor() actor: Actor,
    @Req() req: AuthedRequest,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(amendBody, body);
    try {
      return await withTx(this.db, (tx) => amendReport(tx, actor, {
        studyId, ...input,
        impression: input.impression ?? null, laterality: input.laterality ?? null,
        criticalCategory: input.criticalCategory ?? null,
        secondFactorAt: req.hmisSession?.secondFactorAt ?? null,
        windowMinutes: this.cfg.secondFactorWindowMinutes,
      }));
    } catch (e) { toHttp(e); }
  }

  /** Publication never waits on the cashier — settlement decides the MESSAGE only (D5/O-2). */
  @Post("studies/:studyId/reports/publish")
  @RequirePermission("radiology.reports.sign", "hospital")
  async publish(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => publishReport(tx, actor, this.decls(), { studyId }));
    } catch (e) { toHttp(e); }
  }

  @Post("reports/:reportId/critical")
  @RequirePermission("radiology.reports.write", "hospital")
  async critical(
    @CurrentActor() actor: Actor, @Param("reportId") reportId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(criticalBody, body);
    try {
      return await withTx(this.db, (tx) => flagCritical(tx, actor, {
        reportId, category: input.category, communicatedTo: input.communicatedTo ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  /** DD15 — a RED critical is acknowledged with a READ-BACK, not with a click. */
  @Post("criticals/:criticalId/acknowledge")
  @RequirePermission("radiology.criticals.ack", "hospital")
  async acknowledge(
    @CurrentActor() actor: Actor, @Param("criticalId") criticalId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(ackBody, body);
    try {
      return await withTx(this.db, (tx) => acknowledgeCritical(tx, actor, {
        criticalId,
        acknowledgedByClinicianId: input.acknowledgedByClinicianId,
        readBack: input.readBack ?? null,
      }));
    } catch (e) { toHttp(e); }
  }
}
