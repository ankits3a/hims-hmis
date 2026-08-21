import { Controller, Get, Inject } from "@nestjs/common";
import { desc, sql } from "drizzle-orm";
import { CONFIG, DB } from "../kernel/tokens";
import { Public } from "../kernel/auth/decorators";
import { schedulerHeartbeats } from "../kernel/db/schema/worker";
import type { AppConfig } from "../kernel/config";
import type { Db } from "../kernel/db/client";

// D7. The worker is never load-bearing for a human flow (Global Constraint 1), so a missing
// or stalled worker DEGRADES this endpoint and can never bring it down: `status` is "ok" or
// "degraded", never "down". Zero heartbeat rows is `not_running` with status "ok" on
// purpose — a deployment without a worker is not a fault the API can diagnose.
export type WorkerHealth = "ok" | "stale" | "not_running";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Get()
  async health(): Promise<{ status: string; db: string; worker: WorkerHealth }> {
    await this.db.execute(sql`select 1`);
    // The FRESHEST heartbeat decides: one aged job among fresh ones is not a stalled worker.
    const [freshest] = await this.db
      .select({ lastStartedAt: schedulerHeartbeats.lastStartedAt })
      .from(schedulerHeartbeats)
      .orderBy(desc(schedulerHeartbeats.lastStartedAt))
      .limit(1);
    let worker: WorkerHealth = "not_running";
    if (freshest !== undefined) {
      const ageMs = Date.now() - freshest.lastStartedAt.getTime();
      worker = ageMs > this.cfg.workerStaleAfterMs ? "stale" : "ok";
    }
    return { status: worker === "stale" ? "degraded" : "ok", db: "ok", worker };
  }
}
