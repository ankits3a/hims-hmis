import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DB } from "../kernel/tokens";
import { Public } from "../kernel/auth/decorators";
import type { Db } from "../kernel/db/client";

@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get()
  async health(): Promise<{ status: string; db: string }> {
    await this.db.execute(sql`select 1`);
    return { status: "ok", db: "ok" };
  }
}
