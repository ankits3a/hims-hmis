import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { withTx } from "../../kernel/db/client";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { listAdviceTemplates, retireAdviceTemplate, saveAdviceTemplate } from "./advice";
import { parsed, toHttp } from "./opd-masters.controller";
import type { AdviceTemplate } from "./advice";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE ADVICE LIBRARY, UNDER THE CONSULTATION'S OWN GRANT ═══
 *
 * `opd.consult` and no permission of its own, for the reason the CDS reads have none: this is the
 * doctor who is already writing the note, and a second name for that authority is a grant to keep
 * in step for ever (and a census pin in `seed-roles.ts` to churn).
 *
 * It reads and writes NO patient data. A template is the doctor's own words about a condition, not
 * about a person — so there is no PHI gate here and nothing to log. The one thing it is careful
 * about is WHOSE row: `owner_user_id` is taken from the actor on the way in and is never a field a
 * body can set.
 */
const templateBody = z.object({
  title: z.string().min(1).max(80),
  /* Either script, at least one — the service refuses a title with no text in either. A doctor
     who writes their advice in Hindi must not have it filed under English. */
  textEn: z.string().max(2000).nullable().optional(),
  textHi: z.string().max(2000).nullable().optional(),
});

@Controller("opd/advice-templates")
export class OpdAdviceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The doctor's own first, then the hospital's. Ordered in SQL so every reader agrees. */
  @RequirePermission("opd.consult", "hospital")
  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ items: AdviceTemplate[] }> {
    try {
      return { items: await listAdviceTemplates(this.db, actor) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post()
  async create(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ templateId: string }> {
    const b = parsed(templateBody, body);
    try {
      return await withTx(this.db, (tx) => saveAdviceTemplate(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  /** Deactivates, never deletes: a template that printed on a slip last week explains that slip. */
  @RequirePermission("opd.consult", "hospital")
  @Delete(":id")
  async retire(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => retireAdviceTemplate(tx, actor, id));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
}
