import { Body, Controller, Get, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { httpError, idSchema, parsed } from "./lab-http";
import {
  getQuickReport, quickCatalogue, QuickEntryError, quickRanges, quickReportsForPatient, saveQuickReport,
} from "./quick";
import { LAB_RESULTS_ENTER } from "./results";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * QUICK ENTRY over HTTP (decision 0061) — five routes, all under `lab.results.enter`: the person
 * who keys values at the bench is the person who uses quick mode. No new permission, so no role
 * gains or loses anything.
 */
const saveBody = z.object({
  patientId: idSchema,
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
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async catalogue(): Promise<unknown> {
    return quickCatalogue(this.db);
  }

  @Get("ranges")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async ranges(@Query() query: unknown): Promise<unknown> {
    const q = parsed(rangesQuery, query);
    try { return { items: await quickRanges(this.db, q.patientId, q.analyteIds) }; } catch (e) { quickHttp(e); }
  }

  @Get("reports")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async list(@Query("patientId") patientId: string): Promise<unknown> {
    const id = parsed(idSchema, patientId);
    return { items: await quickReportsForPatient(this.db, id) };
  }

  @Post("reports")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async create(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(saveBody, body);
    try { return await withTx(this.db, (tx) => saveQuickReport(tx, actor, input)); } catch (e) { quickHttp(e); }
  }

  @Put("reports/:id")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async update(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(saveBody, body);
    try {
      await getQuickReport(this.db, parsed(idSchema, id));
      return await withTx(this.db, (tx) => saveQuickReport(tx, actor, { ...input, id }));
    } catch (e) { quickHttp(e); }
  }
}
