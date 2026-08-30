import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { withIdempotency } from "../billing";
import { collect, collectionQueue } from "./collection";
import { getSpecimenByNo, printLabels } from "./specimens";
import { idSchema, isoDateSchema, LAB_IDEMPOTENT_ROUTES, parsed, toHttp } from "./lab-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T8 — **COLLECTION OVER HTTP**: the label, the scan, and the draw.
 *
 * ═══ THE SCAN IS A REQUIRED FIELD ON THE WIRE, NOT A CLIENT COURTESY (DD10 / E1) ═══
 *
 * `scannedUhid` is `.min(1)` and there is no default. Two Ram Kumars in one morning queue is the
 * case every laboratory in India has had, and a schema that let the field be omitted would make
 * the right-patient check a thing the SCREEN remembers to do. `printLabels` refuses a mismatch
 * before any `lab_specimens` row exists and flags it on its own transaction (17a F20).
 */
const labelsBody = z.object({
  orderGroupId: idSchema,
  scannedUhid: z.string().min(1).max(32),
  labelSource: z.enum(["printer", "downtime_kit"]).optional(),
  downtimeKitSerial: z.string().max(64).optional(),
  serviceDate: isoDateSchema.optional(),
});
const collectBody = z.object({
  specimenId: idSchema,
  /** DD10 / 02 A2 — RECORDED, never judged: `false` forces a named identity re-check at accession. */
  wristbandScanned: z.boolean(),
  site: z.enum(["opd", "ward", "home", "camp", "external"]).optional(),
});
const queueQuery = z.object({
  serviceDate: isoDateSchema,
  site: z.enum(["opd", "ward", "home", "camp", "external"]).optional(),
});

@Controller("lab/collection")
export class LabCollectionController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The phlebotomist's list: who is waiting, for which tube, and how long they have waited. */
  @Get("queue")
  @RequirePermission("lab.collection.operate", "hospital")
  async queue(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<unknown> {
    const filter = parsed(queueQuery, query);
    try { return await collectionQueue(this.db, actor, filter); } catch (e) { toHttp(e); }
  }

  /** One tube by its `S` number — what a scanner at the bench door resolves. */
  @Get("specimen/:specimenNo")
  @RequirePermission("lab.collection.operate", "hospital")
  async specimen(@Param("specimenNo") specimenNo: string): Promise<unknown> {
    try {
      /** `null` rather than a 404: "that barcode is not one of ours" is a state the screen renders. */
      return await withTx(this.db, (tx) => getSpecimenByNo(tx, specimenNo));
    } catch (e) { toHttp(e); }
  }

  @Post("labels")
  @RequirePermission("lab.collection.operate", "hospital")
  async labels(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(labelsBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.printLabels, key },
        input,
        /** `printLabels` is `Db`-FIRST — it must write its near-miss flag outside the rollback. */
        () => printLabels(this.db, actor, input),
      );
    } catch (e) { toHttp(e); }
  }

  @Post("collect")
  @RequirePermission("lab.collection.operate", "hospital")
  async draw(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(collectBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.collect, key },
        input,
        () => withTx(this.db, (tx) => collect(tx, actor, input)),
      );
    } catch (e) { toHttp(e); }
  }
}
