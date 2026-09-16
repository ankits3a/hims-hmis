import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import { endPharmacistRegistration, listPharmacists, recordPharmacistRegistration } from "./pharmacists";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { PharmacistView } from "./pharmacists";

const recordBody = z.object({
  council: z.string().min(1).max(120),
  registrationNo: z.string().min(1).max(60),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
const endBody = z.object({ reason: z.string().min(3).max(500) });

/**
 * PHARMACY P2 — the register of pharmacists. Every route is gated by `@RequirePermission`; the rule
 * that nobody files or ends their own registration lives in the act itself (`self_registration`),
 * where no route can skip it.
 */
@Controller("pharmacy/pharmacists")
export class PharmacyPharmacistsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("pharmacy.pharmacists.manage", "hospital")
  @Get()
  async list(): Promise<{ items: PharmacistView[] }> {
    return { items: await listPharmacists(this.db) };
  }

  @RequirePermission("pharmacy.pharmacists.manage", "hospital")
  @Post(":userId/registrations")
  async record(@CurrentActor() actor: Actor, @Param("userId") userId: string, @Body() body: unknown): Promise<{ id: string; supersededId: string | null }> {
    const input = parsed(recordBody, body);
    const person = parsed(idSchema, userId);
    try {
      return await withTx(this.db, (tx) => recordPharmacistRegistration(tx, actor, {
        userId: person, council: input.council, registrationNo: input.registrationNo, validUntil: input.validUntil ?? null,
      }));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.pharmacists.manage", "hospital")
  @Post("registrations/:registrationId/end")
  async end(@CurrentActor() actor: Actor, @Param("registrationId") registrationId: string, @Body() body: unknown): Promise<{ ok: true }> {
    const { reason } = parsed(endBody, body);
    const id = parsed(idSchema, registrationId);
    try {
      await withTx(this.db, (tx) => endPharmacistRegistration(tx, actor, id, reason));
      return { ok: true };
    } catch (e) {
      return toHttp(e);
    }
  }
}
