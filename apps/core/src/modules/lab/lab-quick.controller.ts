import { Body, Controller, Get, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { httpError, idSchema, parsed } from "./lab-http";
import {
  getQuickReport, quickCatalogue, QuickEntryError, quickQueue, quickRanges, quickReportsForPatient, saveQuickResults,
  startQuick,
} from "./quick";
import { LAB_DESK_OPERATE } from "./desk";
import { LAB_RESULTS_READ } from "./reports";
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
});

const rangesQuery = z.object({
  patientId: idSchema,
  analyteIds: z.string().max(20000).transform((s) => s.split(",").filter((x) => x !== "")),
});

function quickHttp(e: unknown): never {
  if (e instanceof QuickEntryError) {
    const status = e.code === "patient_not_found" || e.code === "report_not_found" ? 404 : 422;
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
  @RequirePermission(LAB_DESK_OPERATE, "hospital")
  async start(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(startBody, body);
    try { return await withTx(this.db, (tx) => startQuick(tx, actor, input)); } catch (e) { quickHttp(e); }
  }

  @Get("queue")
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
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async results(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(resultsBody, body);
    try {
      return await withTx(this.db, (tx) => saveQuickResults(tx, actor, { ...input, id: parsed(idSchema, id) }));
    } catch (e) { quickHttp(e); }
  }
}
