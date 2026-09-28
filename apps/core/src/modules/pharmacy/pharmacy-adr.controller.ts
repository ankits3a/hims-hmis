import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { DB } from "../../kernel/tokens";
import {
  ADR_CAUSALITY, ADR_CHALLENGE, ADR_CHANNELS, ADR_OUTCOMES, ADR_SERIOUSNESS,
} from "../../kernel/db/schema";
import { withIdempotency } from "../billing";
import { suggestMoieties } from "../formulary";
import { ADR_MANAGE_PERMISSION, ADR_RECORD_PERMISSION, addAdrEvent, getAdr, listAdr, recordAdr } from "./adr";
import { adrDocument } from "./adr-print";
import { PHARMACY_IDEMPOTENT_ROUTES, idSchema, parsed, toHttp } from "./pharmacy-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";
import type { AdrDetail, AdrListRow } from "./adr";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD");
const short = z.string().trim().max(200).nullable().optional();

const suspectBody = z.object({
  saltId: idSchema.nullable().optional(),
  name: short,
  itemId: idSchema.nullable().optional(),
  batchNo: z.string().trim().max(60).nullable().optional(),
  manufacturer: short,
  dose: z.string().trim().max(100).nullable().optional(),
  route: z.string().trim().max(60).nullable().optional(),
  frequency: z.string().trim().max(60).nullable().optional(),
  indication: short,
  startDate: day.nullable().optional(),
  stopDate: day.nullable().optional(),
  dispenseId: idSchema.nullable().optional(),
});

const concomitantBody = z.object({
  name: z.string().trim().min(1).max(200),
  dose: z.string().trim().max(100).nullable().optional(),
  route: z.string().trim().max(60).nullable().optional(),
  startDate: day.nullable().optional(),
  stopDate: day.nullable().optional(),
  indication: short,
});

const recordBody = z.object({
  patientId: idSchema,
  reaction: z.string().trim().min(1).max(4000),
  onsetDate: day,
  recoveryDate: day.nullable().optional(),
  seriousness: z.enum(ADR_SERIOUSNESS),
  outcome: z.enum(ADR_OUTCOMES),
  dechallenge: z.enum(ADR_CHALLENGE),
  rechallenge: z.enum(ADR_CHALLENGE),
  weightKg: z.number().positive().max(999).nullable().optional(),
  suspects: z.array(suspectBody).min(1).max(10),
  concomitants: z.array(concomitantBody).max(20).optional(),
  relevantTests: z.string().trim().max(2000).nullable().optional(),
  relevantHistory: z.string().trim().max(2000).nullable().optional(),
});

const note = z.string().trim().max(1000).nullable().optional();
const eventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("causality_assessed"), causality: z.enum(ADR_CAUSALITY), note }),
  z.object({ kind: z.literal("sent_to_pvpi"), sentOn: day, channel: z.enum(ADR_CHANNELS), pvpiRef: z.string().trim().max(120).nullable().optional(), note }),
  z.object({ kind: z.literal("closed"), note }),
]);

const listQuery = z.object({ open: z.enum(["true", "false"]).optional(), patientId: idSchema.optional() });
const saltQuery = z.object({ q: z.string().trim().min(2).max(80) });

/**
 * ═══ PHARMACY STAGE D1 — THE ADR REGISTER'S ROUTES ═══
 *
 * Record: `pharmacy.adr.record` (pharmacy, the in-charge, a doctor). Causality, sent to PvPI, closed:
 * `pharmacy.adr.manage` (the in-charge, the medical superintendent). The reads — the register, one
 * report, the PvPI form — are AUTHENTICATED-ONLY at the route and check `record` OR `manage` inside
 * (`assertAdrReader`), the controlled register's shape: a route decorator names one grant, and the MS who
 * manages reports and records none must still read them.
 */
@Controller("pharmacy/adr")
export class PharmacyAdrController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<{ items: AdrListRow[] }> {
    const input = parsed(listQuery, q);
    try {
      return { items: await listAdr(this.db, actor, { open: input.open === "true", ...(input.patientId === undefined ? {} : { patientId: input.patientId }) }) };
    } catch (e) { toHttp(e); }
  }

  /** The record sheet's drug picker: formulary moieties by name, so the allergy it writes is coded. */
  @RequirePermission(ADR_RECORD_PERMISSION, "hospital")
  @Get("salts")
  async salts(@Query() q: unknown): Promise<{ items: { id: string; name: string }[] }> {
    const input = parsed(saltQuery, q);
    return { items: await suggestMoieties(this.db, input.q, 12) };
  }

  @Get(":id")
  async get(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AdrDetail> {
    try { return await getAdr(this.db, actor, parsed(idSchema, id)); } catch (e) { toHttp(e); }
  }

  /** The PvPI Suspected ADR Reporting Form on A4, printed by the browser. */
  @Get(":id/document")
  async document(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<RenderedDocument> {
    try { return await adrDocument(this.db, actor, parsed(idSchema, id)); } catch (e) { toHttp(e); }
  }

  @RequirePermission(ADR_RECORD_PERMISSION, "hospital")
  @Post()
  async record(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<{ reportId: string; no: string; allergyIds: string[] }> {
    const input = parsed(recordBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.adr, key }, input,
        () => recordAdr(this.db, actor, input, new Date()));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(ADR_MANAGE_PERMISSION, "hospital")
  @Post(":id/events")
  async event(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ eventId: string }> {
    const input = parsed(eventBody, body);
    try { return await addAdrEvent(this.db, actor, parsed(idSchema, id), input, new Date()); } catch (e) { toHttp(e); }
  }
}
