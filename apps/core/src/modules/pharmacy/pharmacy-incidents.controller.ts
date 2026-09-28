import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { DB } from "../../kernel/tokens";
import {
  MED_INCIDENT_FACTORS, MED_INCIDENT_KINDS, MED_INCIDENT_STAGES, MED_INCIDENT_TYPES, NCC_MERP_CATEGORIES,
} from "../../kernel/db/schema";
import { withIdempotency } from "../billing";
import {
  INCIDENT_RECORD_PERMISSION, INCIDENT_REVIEW_PERMISSION, addIncidentEvent, getIncident, incidentIndicator, listIncidents, recordIncident,
} from "./incidents";
import { PHARMACY_IDEMPOTENT_ROUTES, idSchema, parsed, toHttp } from "./pharmacy-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { IncidentIndicatorMonth, IncidentRow } from "./incidents";

const recordBody = z.object({
  kind: z.enum(MED_INCIDENT_KINDS),
  stage: z.enum(MED_INCIDENT_STAGES),
  type: z.enum(MED_INCIDENT_TYPES),
  category: z.enum(NCC_MERP_CATEGORIES),
  patientId: idSchema.nullable().optional(),
  dispenseLine: z.object({ dispenseId: idSchema, lineIdx: z.number().int().min(0).max(999) }).nullable().optional(),
  itemId: idSchema.nullable().optional(),
  factors: z.array(z.enum(MED_INCIDENT_FACTORS)).max(MED_INCIDENT_FACTORS.length).optional(),
  whatHappened: z.string().trim().min(1).max(4000),
});

const note = z.string().trim().max(1000).nullable().optional();
const eventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reviewed"), rootCause: z.string().trim().min(1).max(2000), actionTaken: z.string().trim().min(1).max(2000), note }),
  z.object({ kind: z.literal("closed"), note }),
]);

const listQuery = z.object({ open: z.enum(["true", "false"]).optional() });
const indicatorQuery = z.object({ months: z.coerce.number().int().min(1).max(24).optional() });

/**
 * ═══ PHARMACY STAGE D2 — THE MEDICATION INCIDENT LOG'S ROUTES ═══
 *
 * Record: `pharmacy.incidents.record` (pharmacy, the aide, the in-charge, a doctor). Review and close:
 * `pharmacy.incidents.review` (the in-charge, the medical superintendent). The reads — the log, one
 * incident, the indicator — are AUTHENTICATED-ONLY at the route and check `record` OR `review` inside
 * (`assertIncidentReader`), the ADR register's shape; the same check decides whether this reader is told
 * the reporter's name (review) or only their role (everyone else).
 */
@Controller("pharmacy/incidents")
export class PharmacyIncidentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<{ items: IncidentRow[] }> {
    const input = parsed(listQuery, q);
    try { return { items: await listIncidents(this.db, actor, { open: input.open === "true" }) }; } catch (e) { toHttp(e); }
  }

  /** Errors per 1,000 dispensed lines per month, and near misses per month — no person on it. */
  @Get("indicator")
  async indicator(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<{ months: IncidentIndicatorMonth[] }> {
    const input = parsed(indicatorQuery, q);
    try { return await incidentIndicator(this.db, actor, input.months === undefined ? {} : { months: input.months }, new Date()); } catch (e) { toHttp(e); }
  }

  @Get(":id")
  async get(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IncidentRow> {
    try { return await getIncident(this.db, actor, parsed(idSchema, id)); } catch (e) { toHttp(e); }
  }

  @RequirePermission(INCIDENT_RECORD_PERMISSION, "hospital")
  @Post()
  async record(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<{ incidentId: string; no: string }> {
    const input = parsed(recordBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.incident, key }, input,
        () => recordIncident(this.db, actor, input, new Date()));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(INCIDENT_REVIEW_PERMISSION, "hospital")
  @Post(":id/events")
  async event(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ eventId: string }> {
    const input = parsed(eventBody, body);
    try { return await addIncidentEvent(this.db, actor, parsed(idSchema, id), input, new Date()); } catch (e) { toHttp(e); }
  }
}
