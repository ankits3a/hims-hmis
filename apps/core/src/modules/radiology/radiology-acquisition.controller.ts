import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import {
  CONTRAST_REACTION_ONSETS, CONTRAST_REACTION_OUTCOMES, CONTRAST_REACTION_SEVERITIES,
} from "../../kernel/db/schema/radiology";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { abortAcquisition, recordAcquired, startAcquisition } from "./acquisition";
import { recordContrastAdministration } from "./contrast";
import { recordContrastReaction } from "./reactions";
import { studyContrastAdministrations, studyContrastReactions } from "./read";
import { linkInvoiceLine } from "./money";
import { idSchema, parsed, toHttp } from "./radiology-http";
import { imagingAcquiredBody, imagingContrastBody } from "@hmis/contracts";
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
 * F52 — NO DATE. The scan's IST calendar day used to arrive here and decide whether the
 * machine's PCPNDT registration was live. It is the server's now. The schema stays so the route
 * keeps refusing a body that is not an object, and so a client still sending `onDate` is not
 * silently believed (`.strict()` still refuses it). RS6 adds the one field a start may carry.
 */
const startBody = z.object({
  /** 18-S RS6 — the bedside radiation checklist, as attested text; see `startAcquisition`. */
  bedsideSafety: z.string().min(1).max(400).optional(),
}).strict();

/**
 * #1077 — the acquisition and the injection are `@hmis/contracts`'s act bodies
 * (`imagingAcquiredBody`, `imagingContrastBody`; the contrast routes held equal to
 * `CONTRAST_ROUTES` by `act-bodies.test.ts`). `volumeMl` is `.positive()` for the reason the service
 * repeats: a one-millilitre TEST DOSE is a real administration and a zero-millilitre one is not an
 * event. `vialExpiry` is a DATE on a label, never an instant, and the service refuses an expired one.
 */
const acquiredBody = imagingAcquiredBody;
const contrastBody = imagingContrastBody;

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
    const input = parsed(startBody, body);
    try {
      return await withTx(this.db, (tx) => startAcquisition(tx, actor, this.decls(), {
        studyId, bedsideSafety: input.bedsideSafety ?? null,
      }));
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
        doseAgd: input.doseAgd ?? null,
        doseKar: input.doseKar ?? null,
        doseManual: input.doseManual ?? false,
        contrastGiven: input.contrastGiven ?? false,
        contrastAgent: input.contrastAgent ?? null,
        contrastVolumeMl: input.contrastVolumeMl ?? null,
        repeatOfStudyId: input.repeatOfStudyId ?? null,
        repeatReason: input.repeatReason ?? null,
        drlReason: input.drlReason ?? null,
        contrastNotGivenReason: input.contrastNotGivenReason ?? null,
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
  // 18-S RS5 — `radiology.contrast.record` (held by radiographer, radiologist and radiology_nurse),
  // split off `radiology.acquire` so the nurse who injects can record it without driving the machine.
  @RequirePermission("radiology.contrast.record", "hospital")
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

  /**
   * The register for one study. Codes and volumes; no name, no finding — nothing `worklist` hides.
   * #1076 — read through the study reader (`read.ts`): the study's own rule and an access row per read.
   */
  @Get(":studyId/contrast")
  @RequirePermission("radiology.worklist.read", "hospital")
  async contrastRegister(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { administrations: (await studyContrastAdministrations(this.db, actor, studyId)) ?? [] };
    } catch (e) { toHttp(e); }
  }

  /**
   * 18a-iii T2 — the reaction, on `radiology.acquire` for T1's reason: the person watching the
   * patient react is the person at the console. A reaction recorded late by a radiologist works too
   * — `radiologist` holds the same permission — and `observedBy` is the person who SAW it, which is
   * deliberately not the actor who typed the row.
   */
  @Post("contrast-reactions")
  // 18-S RS5 — the nurse watching the patient after the injection records the reaction too.
  @RequirePermission("radiology.contrast.record", "hospital")
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

  /**
   * The reactions on one study. The manifestation IS here — this is the clinical record, not an event.
   * #1076 — read through the study reader, as the register above.
   */
  @Get(":studyId/contrast-reactions")
  @RequirePermission("radiology.worklist.read", "hospital")
  async reactions(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { reactions: (await studyContrastReactions(this.db, actor, studyId)) ?? [] };
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
