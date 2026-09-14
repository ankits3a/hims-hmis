import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { withTx } from "../../kernel/db/client";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import {
  createComplaintConcept, listComplaintConcepts, mapComplaintTerm, proposeConceptFor,
  unmappedComplaintTerms,
} from "./complaints";
import { parsed, toHttp } from "./opd-masters.controller";
import type { ConceptProposal, UnmappedTerm } from "./complaints";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE COMPLAINT VOCABULARY'S CURATION SURFACE ═══
 *
 * The worklist of phrases this hospital types and nobody has mapped, the local proposer, and the
 * act of accepting a mapping.
 *
 * ═══ `opd.masters.manage`, AND NO NEW PERMISSION ═══
 *
 * Mapping a phrase to a concept changes what the co-pilot considers for every doctor from then on —
 * `chest_tightness` reaching SYN_ASTHMA_06 and `chest_pain` reaching nothing is a CLINICAL
 * distinction, and the seed's own header records what happened when it was got wrong. That is
 * curation of a master list, which is exactly what `opd.masters.manage` already names. A permission
 * of its own would be a second name for the same authority, four edits to keep in step (the root
 * README is parsed by `seed-roles.test.ts` in both directions) and a census pin to churn.
 *
 * The READ is under the same grant rather than `opd.consult`: a worklist is a curator's screen, and
 * a doctor mid-consultation has no use for it.
 */
const unmappedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });
const proposeQuery = z.object({ term: z.string().min(1).max(200) });
const conceptBody = z.object({ label: z.string().min(1).max(80) });
const mapBody = z.object({
  term: z.string().min(1).max(200),
  conceptKey: z.string().min(1).max(64),
  script: z.enum(["en", "hi", "hinglish"]),
});

@Controller("opd/vocabulary")
export class OpdVocabularyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** What the hospital types that means nothing to the machine yet, most frequent first. */
  @RequirePermission("opd.masters.manage", "hospital")
  @Get("unmapped")
  async unmapped(@Query() query: unknown): Promise<{ items: UnmappedTerm[] }> {
    const q = parsed(unmappedQuery, query);
    return { items: await unmappedComplaintTerms(this.db, q.limit ?? 25) };
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Get("concepts")
  async concepts(): Promise<{ items: { key: string; label: string }[] }> {
    return { items: await listComplaintConcepts(this.db) };
  }

  /**
   * A suggestion for what an unmapped phrase might mean. It DECIDES NOTHING — the row it proposes
   * does not exist until `map` is called by a person. See `proposeConceptFor` for why this runs on
   * the box rather than through the inference kernel.
   */
  @RequirePermission("opd.masters.manage", "hospital")
  @Get("propose")
  async propose(@Query() query: unknown): Promise<{ items: ConceptProposal[] }> {
    const q = parsed(proposeQuery, query);
    return { items: await proposeConceptFor(this.db, q.term) };
  }

  /** A new meaning, for a phrase that fits none of the existing ones. Idempotent by derived key. */
  @RequirePermission("opd.masters.manage", "hospital")
  @Post("concepts")
  async createConcept(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ key: string }> {
    const b = parsed(conceptBody, body);
    try {
      return await withTx(this.db, (tx) => createComplaintConcept(tx, actor, b.label));
    } catch (e) {
      toHttp(e);
    }
  }

  /** A human accepting a mapping. `source` on the stored row says so. */
  @RequirePermission("opd.masters.manage", "hospital")
  @Post("map")
  async map(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ termId: string }> {
    const b = parsed(mapBody, body);
    try {
      return await withTx(this.db, (tx) => mapComplaintTerm(tx, actor, b.term, b.conceptKey, b.script));
    } catch (e) {
      toHttp(e);
    }
  }
}
