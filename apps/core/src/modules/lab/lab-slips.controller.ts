import { Body, Controller, Get, Inject, Logger, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { CONFIG, DB, DOCUMENT_STORE } from "../../kernel/tokens";
import { httpError, idSchema, parsed } from "./lab-http";
import { LabModeOnly } from "./mode";
import { quickHttp } from "./lab-quick.controller";
import { LAB_RESULTS_ENTER } from "./results";
import { slipReaderFromConfig } from "./slip-reader";
import {
  attachSlip, detachSlip, discardSlip, getSlipScan, listWaitingSlips, readSlipImage, rereadSlip, resolveSlipRow, scanSlip,
  SlipError, slipHttpStatus, slipSetup, SLIP_MAX_BYTES,
} from "./slips";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { SlipDeps, SlipRowAction } from "./slips";
import type { SlipReader } from "./slip-reader";

/**
 * SPEC #934 over HTTP — `/lab/slips`, the phone's Scan slip / Fill from slip and the waiting list. Every
 * route is Quick mode's and the bench's (`lab.results.enter`); saving a code map or an ignore setting
 * also needs `lab.instruments.manage`, checked inside. The web resolves a slip (attach, rows, discard)
 * and never uploads one.
 *
 * The provider is chosen ONCE, when this controller is built at boot (rule 6): a readable Gemini key
 * file, else a readable OpenRouter one, else reading is off and `POST` answers `slip_reading_off`.
 */
const scanBody = z.object({
  /** Base64 of the straightened JPEG; the server refuses past 1.5 MB of bytes. */
  image: z.string().min(1).max(Math.ceil((SLIP_MAX_BYTES * 4) / 3) + 8),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  source: z.enum(["camera", "gallery"]),
  instrumentId: idSchema,
  photoTakenAt: z.string().datetime({ offset: true }).nullable().optional(),
  quickReportId: idSchema.nullable().optional(),
});
const attachBody = z.object({ quickReportId: idSchema, confirmed: z.boolean().optional() });
const reasonBody = z.object({ reason: z.string().max(500) });
const rowBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("checked") }),
  z.object({ action: z.literal("place"), analyteId: idSchema }),
  z.object({ action: z.literal("ignore"), reason: z.string().max(500) }),
  z.object({ action: z.literal("map"), analyteId: idSchema, unit: z.string().max(40).nullable().optional(), factor: z.string().regex(/^\d+(\.\d+)?$/).max(20).optional() }),
  z.object({ action: z.literal("ignore_always"), reason: z.string().max(500) }),
]);
const listQuery = z.object({ status: z.literal("waiting").default("waiting") });
const rowParam = z.coerce.number().int().min(0).max(59);

function slipHttp(e: unknown): never {
  if (e instanceof SlipError) throw httpError(slipHttpStatus(e.code), e.message, e.code, e.detail);
  return quickHttp(e);
}

@Controller("lab/slips")
export class LabSlipsController {
  private readonly reader: SlipReader | null;
  private readonly deps: SlipDeps;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CONFIG) cfg: AppConfig,
  ) {
    this.reader = slipReaderFromConfig(cfg.labSlip);
    this.deps = { store, reader: this.reader, timeoutMs: cfg.labSlip.timeoutMs, dailyCapInr: cfg.copilotSpend.dailyCapInr };
    new Logger("LabSlips").log(this.reader === null
      ? "lab slip reading is OFF: no readable HMIS_GEMINI_KEY_FILE or HMIS_OPENROUTER_KEY_FILE (the bench types as today)"
      : `lab slip reading is on: ${this.reader.provider} ${this.reader.model}`);
  }

  /** Is reading on, and which analysers have a code map — the phone hides Scan slip when it is off. */
  @Get("setup")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async setup(): Promise<unknown> {
    return slipSetup(this.db, this.reader);
  }

  @Post()
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async scan(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(scanBody, body);
    try {
      return await scanSlip(this.db, this.deps, actor, {
        image: Buffer.from(b.image, "base64"), mimeType: b.mimeType, source: b.source, instrumentId: b.instrumentId,
        photoTakenAt: b.photoTakenAt ?? null, quickReportId: b.quickReportId ?? null,
      });
    } catch (e) { slipHttp(e); }
  }

  @Get()
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async waiting(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<unknown> {
    parsed(listQuery, query);
    try { return { items: await listWaitingSlips(this.db, actor) }; } catch (e) { slipHttp(e); }
  }

  @Get(":id")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async one(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await getSlipScan(this.db, actor, parsed(idSchema, id)); } catch (e) { slipHttp(e); }
  }

  /** The stored image, as base64 JSON (the patient photo's and the desk slip's shape). One PHI access row per read. */
  @Get(":id/image")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async image(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try {
      const img = await readSlipImage(this.db, this.store, actor, parsed(idSchema, id));
      return { mimeType: img.mimeType, imageBase64: img.bytes.toString("base64") };
    } catch (e) { slipHttp(e); }
  }

  @Post(":id/attach")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async attach(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(attachBody, body);
    try { return await attachSlip(this.db, actor, parsed(idSchema, id), b); } catch (e) { slipHttp(e); }
  }

  @Post(":id/detach")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async detach(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await detachSlip(this.db, actor, parsed(idSchema, id)); } catch (e) { slipHttp(e); }
  }

  @Post(":id/rows/:n")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async row(@CurrentActor() actor: Actor, @Param("id") id: string, @Param("n") n: string, @Body() body: unknown): Promise<unknown> {
    const act = parsed(rowBody, body) as SlipRowAction;
    try { return await resolveSlipRow(this.db, actor, parsed(idSchema, id), parsed(rowParam, n), act); } catch (e) { slipHttp(e); }
  }

  @Post(":id/reread")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async reread(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await rereadSlip(this.db, this.deps, actor, parsed(idSchema, id)); } catch (e) { slipHttp(e); }
  }

  @Post(":id/discard")
  @LabModeOnly("quick")
  @RequirePermission(LAB_RESULTS_ENTER, "hospital")
  async discard(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(reasonBody, body);
    try { return await discardSlip(this.db, actor, parsed(idSchema, id), b.reason); } catch (e) { slipHttp(e); }
  }
}
