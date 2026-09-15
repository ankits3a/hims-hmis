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

  /**
   * PHASE 11i T3 (§2b row 22) — `environment` RIDES ON `/health`, and that is a deliberate choice
   * of surface rather than a new route.
   *
   * The banner it feeds has to be readable BEFORE anyone logs in: the moment a trainee is most
   * likely to type a real patient into UAT is while they are looking at a login screen identical
   * to production's. `/health` is the one `@Public()` endpoint this application has, the SPA can
   * read it with no token, and the edge gate already fetches it on every deploy — so the fact
   * travels on a wire that is already proven to work rather than on a second one that is not.
   *
   * `null` on production, always: the key is unset there and `deploy-parity` pins that the
   * production environment template does not carry it.
   */
  @Public()
  @Get()
  async health(): Promise<{ status: string; db: string; worker: WorkerHealth; environment: string | null }> {
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
    return {
      status: worker === "stale" ? "degraded" : "ok", db: "ok", worker,
      environment: this.cfg.environmentLabel,
    };
  }
}
