import { Body, Controller, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { abortAcquisition, recordAcquired, startAcquisition } from "./acquisition";
import { linkInvoiceLine } from "./money";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 18a T7 — **THE CONSOLE: start, acquired, abort, and the counter's invoice link.**
 *
 * ═══ ONE PERMISSION, `radiology.acquire`, AND IT IS THE TECHNOLOGIST'S ═══
 *
 * `radiographer` and `radiologist` hold it; `radiology_receptionist` does not. The desk that books
 * the scan and takes the money does not record that it happened — the same separation `checkin`
 * and `gates.satisfy` are drawn on, for the same reason.
 *
 * **`linkInvoiceLine` is the exception and carries `radiology.bill_decisions.manage`**, because it
 * is a COUNTER act: the cashier raised a line and attaches it. `billing_manager` and
 * `radiology_receptionist` hold that one, and neither holds `radiology.acquire`.
 *
 * ═══ NO IDEMPOTENCY CLAIM ON `acquired`, AND THE CAS IS WHY ═══
 *
 * A double-submitted acquisition is refused `already_acquired` by the status compare-and-set inside
 * `recordAcquired`, so the event fires exactly once (A6). A `withIdempotency` wrapper would be a
 * second mechanism guarding a property the database already holds — T4's argument for its own
 * routes, unchanged.
 */
/**
 * F52 — DELIBERATELY EMPTY. The scan's IST calendar day used to arrive here and decide whether the
 * machine's PCPNDT registration was live. It is the server's now. The schema stays so the route
 * keeps refusing a body that is not an object, and so a client still sending `onDate` is not
 * silently believed.
 */
const startBody = z.object({}).strict();

const acquiredBody = z.object({
  imageSource: z.enum(["pacs", "no_pacs_images", "outside"]),
  doseCtdivol: z.number().nonnegative().max(9_999_999).nullish(),
  doseDlp: z.number().nonnegative().max(9_999_999).nullish(),
  doseDap: z.number().nonnegative().max(9_999_999).nullish(),
  fluoroSeconds: z.number().int().nonnegative().max(86_400).nullish(),
  doseManual: z.boolean().optional(),
  contrastGiven: z.boolean().optional(),
  contrastAgent: z.string().min(1).max(120).nullish(),
  contrastVolumeMl: z.number().positive().max(999_999).nullish(),
  repeatOfStudyId: idSchema.nullish(),
  repeatReason: z.string().min(1).max(400).nullish(),
  /** E11 — the PAPER instant for a downtime backfill. `lateEntry` is derived, never sent. */
  acquiredAt: z.string().datetime().optional(),
});

const abortBody = z.object({ reason: z.string().min(1).max(400) });
const linkBody = z.object({ invoiceLineId: idSchema });

@Controller("radiology/studies")
export class RadiologyAcquisitionController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  private decls() { return collectOrderKinds(this.registry); }

  @Post(":studyId/acquisition/start")
  @RequirePermission("radiology.acquire", "hospital")
  async start(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    /**
     * F52 — `startBody` no longer carries `onDate`. The PCPNDT registration window is a legal DATE
     * and it is now the SERVER's IST day: a client that chose it could walk a scan onto a machine
     * whose registration had lapsed, and the shipped console was sending the browser's UTC day,
     * which is yesterday for five and a half hours every night.
     */
    parsed(startBody, body);
    try {
      return await withTx(this.db, (tx) => startAcquisition(tx, actor, this.decls(), { studyId }));
    } catch (e) { toHttp(e); }
  }

  @Post(":studyId/acquisition/acquired")
  @RequirePermission("radiology.acquire", "hospital")
  async acquired(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(acquiredBody, body);
    try {
      return await withTx(this.db, (tx) => recordAcquired(tx, actor, this.decls(), {
        studyId,
        imageSource: input.imageSource,
        doseCtdivol: input.doseCtdivol ?? null,
        doseDlp: input.doseDlp ?? null,
        doseDap: input.doseDap ?? null,
        fluoroSeconds: input.fluoroSeconds ?? null,
        doseManual: input.doseManual ?? false,
        contrastGiven: input.contrastGiven ?? false,
        contrastAgent: input.contrastAgent ?? null,
        contrastVolumeMl: input.contrastVolumeMl ?? null,
        repeatOfStudyId: input.repeatOfStudyId ?? null,
        repeatReason: input.repeatReason ?? null,
        acquiredAt: input.acquiredAt === undefined ? undefined : new Date(input.acquiredAt),
      }));
    } catch (e) { toHttp(e); }
  }

  /** Not a cancel — the study keeps its slot, its accession and its gates and goes back to `ready`. */
  @Post(":studyId/acquisition/abort")
  @RequirePermission("radiology.acquire", "hospital")
  async abort(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(abortBody, body);
    try {
      return await withTx(this.db, (tx) => abortAcquisition(tx, actor, this.decls(), {
        studyId, reason: input.reason,
      }));
    } catch (e) { toHttp(e); }
  }

  /** The COUNTER's act: a line was raised and is attached. This module composes no invoice. */
  @Post(":studyId/invoice-line")
  @RequirePermission("radiology.bill_decisions.manage", "hospital")
  async link(@Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(linkBody, body);
    try {
      return await withTx(this.db, (tx) => linkInvoiceLine(tx, studyId, input.invoiceLineId));
    } catch (e) { toHttp(e); }
  }
}
