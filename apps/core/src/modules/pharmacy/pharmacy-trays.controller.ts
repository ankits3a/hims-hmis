import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { DB } from "../../kernel/tokens";
import { TRAY_CHECK_KINDS } from "../../kernel/db/schema";
import { withIdempotency } from "../billing";
import { PHARMACY_IDEMPOTENT_ROUTES, idSchema, parsed, toHttp } from "./pharmacy-http";
import {
  TRAYS_CHECK_PERMISSION, TRAYS_MANAGE_PERMISSION, listTrayChecks, listTrays, receiveTrayRestock, recordTrayCheck, restockTrayCheck,
  saveTray, saveTrayTemplateLine, trayItemChoices,
} from "./trays";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RecordedTrayCheck, TrayCheckView, TrayView } from "./trays";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const trayBody = z.object({
  name: z.string().trim().min(1).max(80),
  location: z.string().trim().max(80).optional(),
  custodianRoles: z.array(z.string().trim().min(1).max(64)).min(1).max(10),
});
const keepersBody = z.object({ custodianRoles: z.array(z.string().trim().min(1).max(64)).min(1).max(10) });
const templateBody = z.object({
  itemId: idSchema,
  parQty: z.number().int().positive().max(10_000),
  minExpiryDays: z.number().int().min(0).max(365).nullable().optional(),
  active: z.boolean().optional(),
});
const checkBody = z.object({
  trayId: idSchema,
  kind: z.enum(TRAY_CHECK_KINDS),
  sealSeen: z.string().trim().max(40).nullable().optional(),
  sealNew: z.string().trim().max(40).nullable().optional(),
  lines: z.array(z.object({
    itemId: idSchema,
    qtyPresent: z.number().int().min(0).max(100_000),
    earliestExpiry: isoDate.nullable().optional(),
    batchId: idSchema.nullable().optional(),
    qtyExpiring: z.number().int().min(0).max(100_000).nullable().optional(),
  })).max(200).optional(),
  patientId: idSchema.nullable().optional(),
  event: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  checkedAt: z.string().datetime({ offset: true }).nullable().optional(),
});
const receiveBody = z.object({
  lines: z.array(z.object({ lineId: idSchema, qtyReceived: z.number().int().min(0).max(100_000) })).max(200).optional(),
});
const itemsQuery = z.object({ q: z.string().max(80).default("") });

/**
 * ═══ PHARMACY STAGE D4 — THE EMERGENCY TRAYS' ROUTES ═══
 *
 * Record a check, restock a deficient one (the pharmacy's own keepers, inside), and receive a restock (the tray's
 * keepers, inside — `materials.receiveStock`'s own rule): `pharmacy.trays.check`. Set up a tray, change its keepers,
 * edit its list: `pharmacy.trays.manage`. The reads are AUTHENTICATED-ONLY at the route and check `check` OR `manage`
 * inside (`assertTrayReader`), the D1–D3 shape.
 */
@Controller("pharmacy/trays")
export class PharmacyTraysController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async trays(@CurrentActor() actor: Actor): Promise<{ items: TrayView[] }> {
    try { return { items: await listTrays(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_MANAGE_PERMISSION, "hospital")
  @Post()
  async addTray(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ trayId: string; code: string }> {
    const input = parsed(trayBody, body);
    try { return await saveTray(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_MANAGE_PERMISSION, "hospital")
  @Get("items")
  async itemChoices(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<{ items: { id: string; code: string; name: string; baseUom: string }[] }> {
    const input = parsed(itemsQuery, q);
    try { return { items: await trayItemChoices(this.db, actor, input.q) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_MANAGE_PERMISSION, "hospital")
  @Post(":id/keepers")
  async setKeepers(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ trayId: string; code: string }> {
    const input = parsed(keepersBody, body);
    try { return await saveTray(this.db, actor, { id: parsed(idSchema, id), custodianRoles: input.custodianRoles }, new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_MANAGE_PERMISSION, "hospital")
  @Post(":id/template")
  async saveLine(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ templateId: string }> {
    const input = parsed(templateBody, body);
    try { return await saveTrayTemplateLine(this.db, actor, { ...input, trayId: parsed(idSchema, id) }, new Date()); } catch (e) { toHttp(e); }
  }

  @Get(":id/checks")
  async checks(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ items: TrayCheckView[] }> {
    try { return { items: await listTrayChecks(this.db, actor, parsed(idSchema, id)) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_CHECK_PERMISSION, "hospital")
  @Post("checks")
  async record(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<RecordedTrayCheck> {
    const input = parsed(checkBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.trayCheck, key }, input,
        () => recordTrayCheck(this.db, actor, { ...input, checkedAt: input.checkedAt == null ? null : new Date(input.checkedAt) }, new Date()));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_CHECK_PERMISSION, "hospital")
  @Post("checks/:id/restock")
  async restock(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ transferId: string; units: number }> {
    try { return await restockTrayCheck(this.db, actor, parsed(idSchema, id), new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(TRAYS_CHECK_PERMISSION, "hospital")
  @Post("checks/:id/receive")
  async receive(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ status: string }> {
    const input = parsed(receiveBody, body ?? {});
    try { return await receiveTrayRestock(this.db, actor, parsed(idSchema, id), input.lines === undefined ? {} : { lines: input.lines }, new Date()); } catch (e) { toHttp(e); }
  }
}
