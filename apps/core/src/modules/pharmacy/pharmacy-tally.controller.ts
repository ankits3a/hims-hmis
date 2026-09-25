import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { contentDisposition } from "../../kernel/report/csv";
import { parsed, toHttp } from "./pharmacy-http";
import { TALLY_EXPORT, saveTallyLedgers, tallyExport, tallyExportFile, tallyExports, tallyLedgers, tallyPreview } from "./tally";
import type { TallyExportSummary, TallyLedgerState, TallyPreview } from "./tally";
import type { Actor } from "@hmis/contracts";
import type { Response } from "express";
import type { Db } from "../../kernel/db/client";

/**
 * PARITY P5 — the Tally export (TallyPrime XML, owner ruling 2026-09-25), inside the office's
 * Reports. Guarded on `pharmacy.tally.export` (the owner and the billing office); every act asserts it
 * again inside. The two files download from a RECORDED export, through the app's download path (a
 * GET with `Content-Disposition`, the OPD report's CSV route's shape).
 */
const name = z.string().max(100);
const ledgersBody = z.object({
  companyName: name.optional(), sales: name, salesReturns: name, outputCgst: name, outputSgst: name, purchases: name, purchaseReturns: name,
  inputCgst: name, inputSgst: name, inputIgst: name, cash: name, bank: name, roundOff: name, returnShortfall: name,
  patientParty: z.enum(["patient", "single"]), patientLedger: name,
});
const rangeBody = z.object({ preset: z.string().max(16).optional(), from: z.string().max(10).nullable().optional(), to: z.string().max(10).nullable().optional() });

@Controller("pharmacy/office/tally")
export class PharmacyTallyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(TALLY_EXPORT, "hospital")
  @Get("ledgers")
  async ledgers(@CurrentActor() actor: Actor): Promise<TallyLedgerState> {
    try { return await tallyLedgers(this.db, actor); } catch (e) { toHttp(e); }
  }

  /** The accountant saves the ledger names, which confirms them. */
  @RequirePermission(TALLY_EXPORT, "hospital")
  @Put("ledgers")
  async saveLedgers(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<TallyLedgerState> {
    const b = parsed(ledgersBody, body);
    try { return await saveTallyLedgers(this.db, actor, b, new Date()); } catch (e) { toHttp(e); }
  }

  /** What an export of the range would carry; nothing is recorded. */
  @RequirePermission(TALLY_EXPORT, "hospital")
  @Get("preview")
  async preview(@CurrentActor() actor: Actor, @Query("preset") preset?: string, @Query("from") from?: string, @Query("to") to?: string): Promise<TallyPreview> {
    try { return await tallyPreview(this.db, actor, { ...(preset === undefined ? {} : { preset }), from: from ?? null, to: to ?? null }, new Date()); } catch (e) { toHttp(e); }
  }

  /** The export: both files written and recorded. */
  @RequirePermission(TALLY_EXPORT, "hospital")
  @Post("exports")
  async export(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ export: TallyExportSummary }> {
    const b = parsed(rangeBody, body ?? {});
    try {
      return { export: await tallyExport(this.db, actor, { ...(b.preset === undefined ? {} : { preset: b.preset }), from: b.from ?? null, to: b.to ?? null }, new Date()) };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(TALLY_EXPORT, "hospital")
  @Get("exports")
  async exports(@CurrentActor() actor: Actor): Promise<{ exports: TallyExportSummary[] }> {
    try { return { exports: await tallyExports(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(TALLY_EXPORT, "hospital")
  @Get("exports/:id/vouchers.xml")
  async vouchers(@CurrentActor() actor: Actor, @Param("id") id: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    return this.file(actor, id, "vouchers", res);
  }

  @RequirePermission(TALLY_EXPORT, "hospital")
  @Get("exports/:id/masters.xml")
  async masters(@CurrentActor() actor: Actor, @Param("id") id: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    return this.file(actor, id, "masters", res);
  }

  private async file(actor: Actor, id: string, file: "vouchers" | "masters", res: Response): Promise<string> {
    try {
      const f = await tallyExportFile(this.db, actor, id, file);
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", contentDisposition(f.fileName));
      return f.xml;
    } catch (e) { toHttp(e); }
  }
}
