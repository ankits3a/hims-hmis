import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { RequirePermission } from "../../kernel/auth/decorators";
import { metricsRangeQuery } from "../../kernel/report/metrics";
import { parsed } from "./lab-http";
import { labMetrics } from "./metrics";
import type { LabMetrics } from "./metrics";
import type { Db } from "../../kernel/db/client";

/**
 * LAB NUMBERS (owner 2026-10-13, #768) — `GET /lab/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`, IST days,
 * inclusive. Read-only and in BOTH lab modes (no `@LabModeOnly`): the owner reads the numbers
 * whichever way the bench runs. The range (max 92 days) is `kernel/report/metrics.ts`'s. See `metrics.ts` for what each figure is anchored on.
 */
@Controller("lab/metrics")
export class LabMetricsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission("lab.metrics.read", "hospital")
  async metrics(@Query() query: unknown): Promise<LabMetrics> {
    return labMetrics(this.db, parsed(metricsRangeQuery, query));
  }
}
