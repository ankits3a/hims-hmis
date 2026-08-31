import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import {
  activeDefinitionRow, draftDefinition, publishDefinition, requestDefinitionPublish,
} from "./definitions";
import { IMAGING_DEFINITION_KIND_VALUES } from "../../kernel/db/schema/radiology";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ImagingDefinitionKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18a T4 / DD13 — **THE GOVERNED BOOK OVER HTTP: draft, request, publish, read.**
 *
 * ═══ FOUR ROUTES, AND THE SPLIT IS THE POINT ═══
 *
 * Drafting and publishing are DIFFERENT permissions on different desks. `radiology.definitions.manage`
 * buys the right to draft and to request; the PUBLISH still requires a granted
 * `imaging_definition_publish` approval, whose approver role is `medical_superintendent` with
 * `actFirstAllowed: false`. A radiologist can therefore propose a new gate set and cannot enact it,
 * which is what makes this data governed rather than merely stored.
 *
 * There is deliberately NO route that edits an active definition. A change is a new version through
 * the same three steps, and the old one becomes `superseded` rather than disappearing — which is how
 * an inspector can be shown which gate set was in force on the day of a given scan.
 */
const draftBody = z.object({
  kind: z.enum(IMAGING_DEFINITION_KIND_VALUES),
  /** The body's shape is the KIND's own zod schema; `draftDefinition` validates before storing. */
  body: z.unknown(),
});

const publishBody = z.object({
  definitionId: idSchema,
  approvalId: idSchema,
});

@Controller("radiology/definitions")
export class RadiologyDefinitionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Drafts a version AND files its publish approval in ONE transaction, so a draft never exists
   * without the request that makes it actionable — the OT's own contract, and the reason
   * `requestDefinitionPublish` takes a `tx` rather than a `Db`.
   */
  @Post("draft")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async draft(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(draftBody, body);
    try {
      return await withTx(this.db, async (tx) => {
        const drafted = await draftDefinition(tx, actor, { kind: input.kind, body: input.body });
        const { approvalId } = await requestDefinitionPublish(tx, actor, drafted.definitionId);
        return { ...drafted, approvalId };
      });
    } catch (e) { toHttp(e); }
  }

  /**
   * Publishes a draft whose approval is GRANTED. The approval is re-checked here — status AND
   * subject — rather than trusted from the caller, so a granted approval for one definition cannot
   * publish another.
   */
  @Post("publish")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async publish(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(publishBody, body);
    try {
      return await publishDefinition(this.db, actor, input);
    } catch (e) { toHttp(e); }
  }

  /**
   * The ACTIVE version of a kind. `radiology.definitions.read` rather than `.manage`: a
   * radiographer at a console needs to know which gates a study type opens and has no business
   * drafting one.
   */
  @Get(":kind/active")
  @RequirePermission("radiology.definitions.read", "hospital")
  async active(@Param("kind") kind: string): Promise<unknown> {
    if (!(IMAGING_DEFINITION_KIND_VALUES as readonly string[]).includes(kind)) {
      /** An unknown kind is a 400 from the wire, not a 404 — the path segment is the bad input. */
      parsed(z.enum(IMAGING_DEFINITION_KIND_VALUES), kind);
    }
    try {
      const row = await activeDefinitionRow(this.db, kind as ImagingDefinitionKind);
      return row
        ? { definitionId: row.id, kind: row.kind, version: row.version, body: row.body }
        : { definitionId: null, kind, version: null, body: null };
    } catch (e) { toHttp(e); }
  }
}
