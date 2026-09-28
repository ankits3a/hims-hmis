import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { DB } from "../../kernel/tokens";
import { COLD_EXCURSION_DECISIONS } from "../../kernel/db/schema";
import { withIdempotency } from "../billing";
import {
  COLDCHAIN_MANAGE_PERMISSION, COLDCHAIN_RECORD_PERMISSION, closeColdExcursion, coldChainStores, listColdExcursions, listColdReadings,
  listColdUnits, recordColdReading, saveColdUnit,
} from "./cold-chain";
import { PHARMACY_IDEMPOTENT_ROUTES, idSchema, parsed, toHttp } from "./pharmacy-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ColdExcursionView, ColdReadingView, ColdUnitView, RecordedColdReading } from "./cold-chain";

const temp = z.number().finite().min(-50).max(60);
const unitBody = z.object({
  storeResourceId: idSchema.optional(),
  label: z.string().trim().min(1).max(80),
  lowC: temp.optional(),
  highC: temp.optional(),
  active: z.boolean().optional(),
});
const readingBody = z.object({
  unitId: idSchema,
  currentC: temp,
  minC: temp,
  maxC: temp,
  takenAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
const closeBody = z.object({
  decisions: z.array(z.object({
    batchId: idSchema,
    decision: z.enum(COLD_EXCURSION_DECISIONS),
    reason: z.string().trim().max(1000).nullable().optional(),
    qtyBase: z.number().int().positive().optional(),
  })).max(300),
  note: z.string().trim().max(1000).nullable().optional(),
});
const readingsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });
const excursionsQuery = z.object({ open: z.enum(["true", "false"]).optional() });

/**
 * ═══ PHARMACY STAGE D3 — THE FRIDGE LOG'S ROUTES ═══
 *
 * Record a reading: `pharmacy.coldchain.record` (the pharmacist, the aide, the storekeeper). Add or edit a
 * fridge, and close an excursion: `pharmacy.coldchain.manage` (the in-charge, the materials head). The reads
 * are AUTHENTICATED-ONLY at the route and check `record` OR `manage` inside (`assertColdReader`), the D1/D2 shape.
 */
@Controller("pharmacy/cold-chain")
export class PharmacyColdChainController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("units")
  async units(@CurrentActor() actor: Actor): Promise<{ items: ColdUnitView[] }> {
    try { return { items: await listColdUnits(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(COLDCHAIN_MANAGE_PERMISSION, "hospital")
  @Get("stores")
  async stores(@CurrentActor() actor: Actor): Promise<{ items: { id: string; code: string; name: string }[] }> {
    try { return { items: await coldChainStores(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(COLDCHAIN_MANAGE_PERMISSION, "hospital")
  @Post("units")
  async addUnit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ unitId: string }> {
    const input = parsed(unitBody, body);
    try { return await saveColdUnit(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(COLDCHAIN_MANAGE_PERMISSION, "hospital")
  @Post("units/:id")
  async editUnit(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ unitId: string }> {
    const input = parsed(unitBody, body);
    try { return await saveColdUnit(this.db, actor, { ...input, id: parsed(idSchema, id) }, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("units/:id/readings")
  async readings(@CurrentActor() actor: Actor, @Param("id") id: string, @Query() q: unknown): Promise<{ items: ColdReadingView[] }> {
    const input = parsed(readingsQuery, q);
    try {
      return { items: await listColdReadings(this.db, actor, parsed(idSchema, id), input.days === undefined ? {} : { days: input.days }, new Date()) };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(COLDCHAIN_RECORD_PERMISSION, "hospital")
  @Post("readings")
  async record(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<RecordedColdReading> {
    const input = parsed(readingBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.coldReading, key }, input,
        () => recordColdReading(this.db, actor, { ...input, takenAt: input.takenAt == null ? null : new Date(input.takenAt) }, new Date()));
    } catch (e) { toHttp(e); }
  }

  @Get("excursions")
  async excursions(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<{ items: ColdExcursionView[] }> {
    const input = parsed(excursionsQuery, q);
    try { return { items: await listColdExcursions(this.db, actor, { open: input.open === "true" }) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(COLDCHAIN_MANAGE_PERMISSION, "hospital")
  @Post("excursions/:id/close")
  async close(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ excursionId: string; writeOffId: string | null }> {
    const input = parsed(closeBody, body);
    try { return await closeColdExcursion(this.db, actor, parsed(idSchema, id), input, new Date()); } catch (e) { toHttp(e); }
  }
}
