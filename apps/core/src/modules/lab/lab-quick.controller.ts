import { Body, Controller, Get, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { LabModeOnly } from "./mode";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { httpError, idSchema, parsed } from "./lab-http";
import {
  getQuickReport, handOverQuick, quickCatalogue, quickCollect, quickCollectQueue, QuickEntryError, quickQueue, quickRanges,
  quickReportsDesk, quickReportsForPatient, saveQuickResults, sendBackQuick, startQuick,
} from "./quick";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { hasPermission } from "../../kernel/auth/permissions";
import { recentLabOrders } from "./desk-picker";
import { patients } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { LAB_DESK_OPERATE } from "./desk";
import { LAB_REPORTS_PRINT, LAB_RESULTS_READ } from "./reports";
import { LAB_RESULTS_ENTER } from "./results";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * QUICK MODE over HTTP (decision 0061). Start is the counter's act and rides `lab.desk.operate`,
 * the grant that already finds patients at `GET /lab/desk/find`; the queue and the results are the
 * bench's and ride `lab.results.enter`. No new permission, so no role gains or loses anything. The
 * catalogue rides `lab.catalogue.read`, which both seats hold.
 */
const startBody = z.object({
  patientId: idSchema,
  encounterNo: z.string().max(32).nullable(),
  serviceIds: z.array(idSchema).max(60),
  bloodCollected: z.boolean(),
});

const resultsBody = z.object({
  lines: z.array(z.object({ analyteId: idSchema, value: z.string().max(200) })).max(300),
  summary: z.string().max(4000),
  /** Owner 2026-10-11 — `false` is /lab/qbench's Save draft. */
  complete: z.boolean().optional(),
  /**
   * Owner 2026-10-12 — the antibiotic sensitivity tables. Loose here on purpose: the row rules (S/I/R,
   * a plain-number MIC, blank rows dropped) are `cleanAstRows`'s, applied in `saveQuickResults`, whose
   * 400 names the row.
   */
  ast: z.array(z.object({
    serviceId: idSchema,
    rows: z.array(z.object({
      antibiotic: z.string().max(200),
      result: z.string().max(20).nullable(),
      mic: z.string().max(40).nullable(),
    })).max(100),
  })).max(30).optional(),
});

const rangesQuery = z.object({
  patientId: idSchema,
  analyteIds: z.string().max(20000).transform((s) => s.split(",").filter((x) => x !== "")),
});

export function quickHttp(e: unknown): never {
  if (e instanceof QuickEntryError) {
    const status = e.code === "patient_not_found" || e.code === "report_not_found" || e.code === "order_not_found" ? 404
      : e.code === "not_permitted" ? 403
      : e.code === "already_collected" || e.code === "already_handed_over" || e.code === "not_completed" ? 409
      : e.code === "ast_invalid" ? 400
      : 422;
    throw httpError(status, e.message, e.code, e.detail);
  }
  throw e;
}

@Controller("lab/quick")
export class LabQuickController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("catalogue")
  @RequirePermission("lab.catalogue.read", "hospital")
  async catalogue(): Promise<unknown> {
    return quickCatalogue(this.db);
  }

  @Post("start")
  @LabModeOnly("quick")
  @RequirePermission(LAB_DESK_OPERATE, "hospital")
  async start(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(startBody, body);
    try { return await withTx(this.db, (tx) => startQuick(tx, actor, input)); } catch (e) { quickHttp(e); }
  }

  @Get("queue")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async queue(@CurrentActor() actor: Actor): Promise<unknown> {
    return quickQueue(this.db, actor);
  }

  @Get("ranges")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async ranges(@Query() query: unknown): Promise<unknown> {
    const q = parsed(rangesQuery, query);
    try { return { items: await quickRanges(this.db, q.patientId, q.analyteIds) }; } catch (e) { quickHttp(e); }
  }

  /** The profile's and the doctor's read: reported quick reports, labelled unsigned on every screen. */
  @Get("patient/:patientId")
  @RequirePermission(LAB_RESULTS_READ, "hospital")
  async forPatient(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<unknown> {
    try { return { items: await quickReportsForPatient(this.db, actor, parsed(idSchema, patientId)) }; } catch (e) { quickHttp(e); }
  }

  @Get("reports/:id")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async report(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await getQuickReport(this.db, actor, parsed(idSchema, id)); } catch (e) { quickHttp(e); }
  }

  @Put("reports/:id")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async results(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(resultsBody, body);
    try {
      return await withTx(this.db, (tx) => saveQuickResults(tx, actor, { ...input, id: parsed(idSchema, id) }));
    } catch (e) { quickHttp(e); }
  }

  /* ═══ owner 2026-10-11 — the quick chain: /lab/qcollect, /lab/qreports ═══ */

  /** Lab orders still waiting for blood. Reception and the phlebotomist both read the worklist. */
  @Get("collect")
  @LabModeOnly("quick")
  @RequirePermission("lab.worklist.read", "hospital")
  async collectQueue(@CurrentActor() actor: Actor): Promise<unknown> {
    return quickCollectQueue(this.db, actor);
  }

  /** Blood collected — the counter or the phlebotomist (checked inside: either grant). */
  @Post("collect/:orderId")
  @LabModeOnly("quick")
  @RequirePermission("lab.worklist.read", "hospital")
  async collect(@CurrentActor() actor: Actor, @Param("orderId") orderId: string): Promise<unknown> {
    try { return await withTx(this.db, (tx) => quickCollect(tx, actor, parsed(idSchema, orderId))); } catch (e) { quickHttp(e); }
  }

  /** Completed reports waiting to be handed over, and today's hand-overs. */
  @Get("ready")
  @LabModeOnly("quick")
  @RequirePermission(LAB_REPORTS_PRINT, "hospital")
  async ready(@CurrentActor() actor: Actor): Promise<unknown> {
    return quickReportsDesk(this.db, actor);
  }

  /**
   * One completed report for printing at the hand-over counter. The counter holds the PRINT grant,
   * not the results grant (17c §8.5's rule for the report centre), and pays for it the same way: one
   * access-log row per read.
   */
  @Get("ready/:id")
  @RequirePermission(LAB_REPORTS_PRINT, "hospital")
  async readyOne(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try {
      const report = await getQuickReport(this.db, actor, parsed(idSchema, id));
      if (report.status !== "reported") throw new QuickEntryError("not_completed", "this report is not complete");
      /** `sealed` is the PATIENT's fact, not the reader's (`getReport`'s rule). */
      const [p] = await this.db.select({ sealed: patients.isConfidential }).from(patients).where(eq(patients.id, report.patient.id));
      await recordPhiAccess(this.db, { actor, patientId: report.patient.id, surface: "lab.quick_reports", sealed: p?.sealed ?? false, reason: null });
      return report;
    } catch (e) { quickHttp(e); }
  }

  @Post("reports/:id/hand-over")
  @LabModeOnly("quick")
  @RequirePermission(LAB_REPORTS_PRINT, "hospital")
  async handOver(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await withTx(this.db, (tx) => handOverQuick(tx, actor, parsed(idSchema, id))); } catch (e) { quickHttp(e); }
  }

  @Post("reports/:id/send-back")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async sendBack(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await withTx(this.db, (tx) => sendBackQuick(tx, actor, parsed(idSchema, id))); } catch (e) { quickHttp(e); }
  }

  /**
   * Owner 2026-10-11 — "if front desk staff has access to lab counter then he can access patients reports
   * from the patient profile page and print the report from there." The lab counter holds the PRINT
   * grant, not the results grant, so the profile reads through it here — the same reader, the same
   * visibility, sensitive-test and access-log rules as `GET patient/:patientId`.
   */
  @Get("patient/:patientId/printable")
  @RequirePermission(LAB_REPORTS_PRINT, "hospital")
  async patientPrintable(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<unknown> {
    try { return { items: await quickReportsForPatient(this.db, actor, parsed(idSchema, patientId)) }; } catch (e) { quickHttp(e); }
  }

  /**
   * Owner 2026-10-11 — "let the user click on the visit card to access the reports and tests related
   * to that visit" and name the tests (CBC, LFT, KFT) on the card. The profile's read of a person's
   * lab orders: test codes and names, stage, visit number — no values. The results grant reads it
   * here, the lab counter's print grant at `/printable`, as the quick reports above.
   */
  @Get("patient/:patientId/orders")
  @RequirePermission(LAB_RESULTS_READ, "hospital")
  async patientOrders(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<unknown> {
    return { items: await this.ordersOf(actor, patientId) };
  }

  @Get("patient/:patientId/orders/printable")
  @RequirePermission(LAB_REPORTS_PRINT, "hospital")
  async patientOrdersPrintable(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<unknown> {
    return { items: await this.ordersOf(actor, patientId) };
  }

  private async ordersOf(actor: Actor, patientId: string): Promise<unknown[]> {
    const id = parsed(idSchema, patientId);
    const canSeeRestricted = actor.type === "user" && await hasPermission(this.db, actor.id, "orders.read.restricted", "hospital");
    return recentLabOrders(this.db, id, canSeeRestricted, 50);
  }
}
