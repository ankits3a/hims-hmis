import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import {
  CONTRAST_REACTION_ONSETS, CONTRAST_REACTION_OUTCOMES, CONTRAST_REACTION_SEVERITIES,
  CONTRAST_ROUTES,
} from "../../kernel/db/schema/radiology";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { abortAcquisition, recordAcquired, startAcquisition } from "./acquisition";
import { contrastAdministrationsFor, recordContrastAdministration } from "./contrast";
import { contrastReactionsFor, recordContrastReaction } from "./reactions";
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
  /** 18b T2 — optional for `pacs` (the minted one is used), refused for the other two sources. */
  studyInstanceUid: z.string().min(1).max(64).nullish(),
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

/**
 * 18a-iii T1 — the injection. `volumeMl` is `.positive()` for the reason the service repeats: a
 * one-millilitre TEST DOSE is a real administration and a zero-millilitre one is not an event.
 * `vialExpiry` is a DATE on a label, never an instant, and the service refuses an expired one.
 */
const contrastBody = z.object({
  agent: z.string().min(1).max(120),
  volumeMl: z.number().positive().max(9_999),
  route: z.enum(CONTRAST_ROUTES),
  site: z.string().min(1).max(120).nullish(),
  vialBatchNo: z.string().min(1).max(60).nullish(),
  vialExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  givenBy: idSchema,
  givenAt: z.string().datetime(),
});

/**
 * 18a-iii T2 — the reaction. `treatmentGiven` and `managingClinicianId` are optional HERE and
 * REQUIRED by the service when severity is `severe` (D3): the rule is one sentence in one place, and
 * a zod refinement restating it would be a second copy to drift.
 */
const reactionBody = z.object({
  administrationId: idSchema,
  severity: z.enum(CONTRAST_REACTION_SEVERITIES),
  onset: z.enum(CONTRAST_REACTION_ONSETS),
  manifestation: z.string().min(1).max(2_000),
  treatmentGiven: z.string().min(1).max(2_000).nullish(),
  managingClinicianId: idSchema.nullish(),
  outcome: z.enum(CONTRAST_REACTION_OUTCOMES).nullish(),
  observedBy: idSchema,
  observedAt: z.string().datetime(),
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
        studyInstanceUid: input.studyInstanceUid ?? null,
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

  /**
   * ═══ 18a-iii T1 — THE CONTRAST REGISTER, ON `radiology.acquire` AND NOT ON A NEW PERMISSION ═══
   *
   * The injection and the acquisition are one act by one person at one console. A separate
   * permission would let a hospital grant the scan without the dose or the dose without the scan,
   * which is a separation nobody has asked for and which the seed-roles model would then have to
   * carry a reason for. `radiographer` and `radiologist` hold it; `radiology_receptionist` does
   * not, which is the separation that actually matters here.
   */
  @Post(":studyId/contrast")
  @RequirePermission("radiology.acquire", "hospital")
  async contrast(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(contrastBody, body);
    try {
      return await withTx(this.db, (tx) => recordContrastAdministration(tx, actor, {
        studyId,
        agent: input.agent,
        volumeMl: input.volumeMl,
        route: input.route,
        site: input.site ?? null,
        vialBatchNo: input.vialBatchNo ?? null,
        vialExpiry: input.vialExpiry ?? null,
        givenBy: input.givenBy,
        givenAt: new Date(input.givenAt),
      }));
    } catch (e) { toHttp(e); }
  }

  /** The register for one study. Codes and volumes; no name, no finding — nothing `worklist` hides. */
  @Get(":studyId/contrast")
  @RequirePermission("radiology.worklist.read", "hospital")
  async contrastRegister(@Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { administrations: await contrastAdministrationsFor(this.db, studyId) };
    } catch (e) { toHttp(e); }
  }

  /**
   * 18a-iii T2 — the reaction, on `radiology.acquire` for T1's reason: the person watching the
   * patient react is the person at the console. A reaction recorded late by a radiologist works too
   * — `radiologist` holds the same permission — and `observedBy` is the person who SAW it, which is
   * deliberately not the actor who typed the row.
   */
  @Post("contrast-reactions")
  @RequirePermission("radiology.acquire", "hospital")
  async reaction(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(reactionBody, body);
    try {
      return await withTx(this.db, (tx) => recordContrastReaction(tx, actor, {
        administrationId: input.administrationId,
        severity: input.severity,
        onset: input.onset,
        manifestation: input.manifestation,
        treatmentGiven: input.treatmentGiven ?? null,
        managingClinicianId: input.managingClinicianId ?? null,
        outcome: input.outcome ?? null,
        observedBy: input.observedBy,
        observedAt: new Date(input.observedAt),
      }));
    } catch (e) { toHttp(e); }
  }

  /** The reactions on one study. The manifestation IS here — this is the clinical record, not an event. */
  @Get(":studyId/contrast-reactions")
  @RequirePermission("radiology.worklist.read", "hospital")
  async reactions(@Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { reactions: await contrastReactionsFor(this.db, studyId) };
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
