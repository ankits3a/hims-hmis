import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { RemindersError, cancelReminder, createReminder, listReminders } from "./reminders";
import type { Actor, ReminderRow } from "@hmis/contracts";
import type { Db } from "../db/client";

function toHttp(e: unknown): never {
  if (e instanceof RemindersError) {
    if (e.code === "user_actor_required") throw new ForbiddenException(e.code);
    if (e.code === "unknown_reminder") throw new NotFoundException(e.code);
    if (e.code === "reminder_limit") throw new ConflictException(e.code);
    throw new BadRequestException(e.message);
  }
  throw e;
}

/**
 * E1.2 — a person's own reminders. NEITHER @Public NOR @RequirePermission, the `/alerts` reasoning
 * (alerts.controller.ts D6): any signed-in person may keep reminders, and they are theirs by
 * identity, not by role — so no permission is minted and no seeded role changes. An agent key
 * passes AuthGuard on a permissionless route; `createReminder` & co. refuse any actor that is not a
 * user, which is the 403 between an agent key and a person's reminders.
 */
@Controller("reminders")
export class RemindersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ items: ReminderRow[] }> {
    try { return { items: await listReminders(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Post()
  async create(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ReminderRow> {
    try { return await createReminder(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ id: string; cancelled: boolean }> {
    try { return await cancelReminder(this.db, actor, id); } catch (e) { toHttp(e); }
  }
}
