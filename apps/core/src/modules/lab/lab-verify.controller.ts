import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { withIdempotency } from "../billing";
import { deliveryAllowed } from "./interlock";
import {
  amendReport, getReport, listResultsForEncounter, listProvisionalResultsForEncounter,
  printReport, publishReport, releaseUnpaid, reportVersions, deliveryRegister, reportsForPatient,
} from "./reports";
import { amendResult, requestRerun } from "./results";
import { verifyResult } from "./verify";
import { publishableOrders, verifyWorklist } from "./worklist";
import { LAB_IDEMPOTENT_ROUTES, LAB_REPORT_ROUTES, idSchema, isoDateSchema, parsed, toHttp } from "./lab-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 17b T8 — **THE SIGNATURE AND THE DOCUMENT OVER HTTP.**
 *
 * ═══ FOUR PERMISSIONS, FOUR HANDS, AND THE SPLITS ARE DD16's ═══
 *
 *   · `lab.results.verify` signs a number.        · `lab.reports.publish` signs the document.
 *   · `lab.reports.print`  hands it over.         · `lab.reports.amend`   corrects a signed one.
 *
 * `lab_reception` holds `print` and none of the other three: a counter clerk hands reports to
 * patients all day and could never have signed one. `lab.reports.release_unpaid` is held by
 * `billing_manager` and by nobody in the laboratory — a permission this module declares and no lab
 * role holds is the honest shape for a control another office exercises (DD6).
 *
 * ═══ THE DOCTOR'S READ IS ON THIS CONTROLLER AND CARRIES **NO** INTERLOCK ═══
 *
 * `GET /lab/results/encounter/:encounterNo` returns verified results for an unpaid self-pay order.
 * That is 02 O-1 and it is the one route in this phase whose failure kills somebody rather than
 * annoying them.
 */
const rerunBody = z.object({ resultId: idSchema, reason: z.string().max(300).optional() });
const publishBody = z.object({ orderId: idSchema, partial: z.boolean().optional() });
const printBody = z.object({
  /** `doctor_screen` is not a hand-over this route can make — see `PrintReportInput` (m2). */
  channel: z.enum(["print", "whatsapp", "in_person"]),
  collectorIdentity: z.string().max(200).optional(),
});
const releaseBody = z.object({
  approvalId: idSchema,
  channel: z.enum(["print", "in_person"]).optional(),
  collectorIdentity: z.string().min(1).max(200),
});
const amendReportBody = z.object({
  reasonCode: z.enum(["corrected_result", "corrected_demographics", "added_analyte", "clerical"]),
});
const amendResultBody = z.object({
  resultId: idSchema,
  value: z.string().min(1).max(500),
  unit: z.string().max(32).nullish(),
  remarks: z.string().max(500).nullish(),
});

@Controller("lab")
export class LabVerifyController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  /** As the other two write controllers: the INSTALLED registry, never the manifest catalogue. */
  private decls() { return collectOrderKinds(this.registry); }

  /* ───────────────────────────── the signature ───────────────────────────── */

  /** DD11's queue: numbers keyed and awaiting a signature, oldest first. */
  @Get("verify/worklist")
  @RequirePermission("lab.worklist.read", "hospital")
  async worklist(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await verifyWorklist(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("verify/results/:resultId")
  @RequirePermission("lab.results.verify", "hospital")
  async sign(
    @CurrentActor() actor: Actor,
    @Param("resultId") resultId: string,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.verifyResult, key },
        { resultId },
        /** `verifyResult` is `Db`-FIRST: the SoD refusal must be evented outside its own rollback. */
        () => verifyResult(this.db, actor, this.decls(), { resultId }),
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * A rerun is free and is a state move — no order, no invoice, no credit note. **It still carries
   * an idempotency key** (close review m7): it is a workflow transition, and a double-submit that
   * lost the race would surface `stale_transition` to a pathologist who pressed one button once.
   */
  @Post("verify/rerun")
  @RequirePermission("lab.results.verify", "hospital")
  async rerun(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(rerunBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_REPORT_ROUTES.rerun, key },
        input,
        () => withTx(this.db, (tx) => requestRerun(tx, actor, input)),
      );
    } catch (e) { toHttp(e); }
  }

  /* ───────────────────────────── the document ───────────────────────────── */

  /**
   * The orders a report can actually be published for (close review, web C3). It is a SEPARATE
   * queue from the verify worklist because the two conditions are mutually exclusive: an item
   * leaves the verify queue at the very moment it becomes publishable.
   */
  @Get("reports/publishable")
  @RequirePermission("lab.worklist.read", "hospital")
  async publishable(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await publishableOrders(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("reports")
  @RequirePermission("lab.reports.publish", "hospital")
  async publish(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(publishBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_REPORT_ROUTES.publish, key },
        input,
        () => publishReport(this.db, actor, input),
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * PLAN 17c T5 — THE REPORT CENTRE. Both readers are gated on `lab.reports.print`, the counter's
   * permission (§8.5's decision); the by-patient reader logs the read and sends a snapshot only
   * when the interlock allows the hand-over.
   */
  @Get("reports/patient/:patientId")
  @RequirePermission("lab.reports.print", "hospital")
  async byPatient(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<unknown> {
    try { return await reportsForPatient(this.db, actor, patientId); } catch (e) { toHttp(e); }
  }

  @Get("reports/register")
  @RequirePermission("lab.reports.print", "hospital")
  async register(@CurrentActor() actor: Actor, @Query("serviceDate") serviceDate?: string): Promise<unknown> {
    const q = parsed(z.object({ serviceDate: isoDateSchema }), { serviceDate });
    try { return await deliveryRegister(this.db, actor, q.serviceDate); } catch (e) { toHttp(e); }
  }

  @Get("reports/:reportId")
  @RequirePermission("lab.results.read", "hospital")
  async report(@CurrentActor() actor: Actor, @Param("reportId") reportId: string): Promise<unknown> {
    try { return await getReport(this.db, actor, reportId); } catch (e) { toHttp(e); }
  }

  /** Every version of one order's report, newest first — the history a reprint reads. */
  @Get("reports/order/:orderId")
  @RequirePermission("lab.results.read", "hospital")
  async versions(@Param("orderId") orderId: string): Promise<unknown> {
    try {
      return {
        versions: await reportVersions(this.db, orderId),
        delivery: await deliveryAllowed(this.db, orderId),
      };
    } catch (e) { toHttp(e); }
  }

  @Post("reports/:reportId/print")
  @RequirePermission("lab.reports.print", "hospital")
  async print(
    @CurrentActor() actor: Actor,
    @Param("reportId") reportId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(printBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_REPORT_ROUTES.print, key },
        { reportId, ...input },
        () => printReport(this.db, actor, { reportId, ...input }),
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * DD6 — `billing_manager`'s decision to carry a receivable. It moves NO money: the dues row is
   * untouched, because it was already the receivable (T7 A4).
   */
  @Post("reports/:reportId/release")
  @RequirePermission("lab.reports.release_unpaid", "hospital")
  async release(
    @CurrentActor() actor: Actor,
    @Param("reportId") reportId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(releaseBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_REPORT_ROUTES.release, key },
        { reportId, ...input },
        () => releaseUnpaid(this.db, actor, { reportId, ...input }),
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * R-018 — the corrected VALUE first, then the new report version over it. Two acts, two routes.
   *
   * **Idempotent** (close review m7): `amendResult` inserts an unconditional new `lab_results` row,
   * so a double-submit wrote TWO superseding rows for one correction and the second superseded the
   * first — an audit chain with a phantom link in it.
   */
  @Post("results/amend")
  @RequirePermission("lab.reports.amend", "hospital")
  async correct(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(amendResultBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_REPORT_ROUTES.amendResult, key },
        input,
        () => withTx(this.db, (tx) => amendResult(tx, actor, input)),
      );
    } catch (e) { toHttp(e); }
  }

  @Post("reports/:reportId/amend")
  @RequirePermission("lab.reports.amend", "hospital")
  async amend(
    @CurrentActor() actor: Actor,
    @Param("reportId") reportId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(amendReportBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_REPORT_ROUTES.amend, key },
        { reportId, ...input },
        () => amendReport(this.db, actor, { reportId, ...input }),
      );
    } catch (e) { toHttp(e); }
  }

  /* ───────────────── the doctor's read — NEVER held for money (02 O-1) ───────────────── */

  @Get("results/encounter/:encounterNo")
  @RequirePermission("lab.results.read", "hospital")
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param("encounterNo") encounterNo: string,
  ): Promise<unknown> {
    try { return await listResultsForEncounter(this.db, actor, encounterNo); } catch (e) { toHttp(e); }
  }

  /**
   * 17d T5 / D6 — THE UNSIGNED NUMBERS, ON THEIR OWN ROUTE. Design board EdgeCases #18: the doctor
   * wants the values before the pathologist signs, which is a constant and legitimate request. A
   * SEPARATE path, never a query parameter on the read above: a caller reaches unsigned values by
   * asking for them and cannot arrive at them by forgetting a flag.
   *
   * The same permission as the signed read (`lab.results.read`) — this is not a MORE privileged
   * fact, it is a less finished one, and gating it behind a second grant would send clinicians back
   * to telephoning the bench, which is the practice this route exists to replace.
   */
  @Get("results/encounter/:encounterNo/provisional")
  @RequirePermission("lab.results.read", "hospital")
  async provisionalForEncounter(
    @CurrentActor() actor: Actor,
    @Param("encounterNo") encounterNo: string,
  ): Promise<unknown> {
    try { return await listProvisionalResultsForEncounter(this.db, actor, encounterNo); } catch (e) { toHttp(e); }
  }
}
