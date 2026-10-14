import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { RequirePermission } from "../../kernel/auth/decorators";
import { metricsRangeQuery } from "../../kernel/report/metrics";
import { parsed } from "./radiology-http";
import { radiologyMetrics } from "./metrics";
import type { RadiologyMetrics } from "./metrics";
import type { Db } from "../../kernel/db/client";

/**
 * IMAGING NUMBERS (owner 2026-10-13, #777) — `GET /radiology/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`,
 * IST days, inclusive, at most 92 (`kernel/report/metrics.ts`). Read-only, aggregate only, naming
 * nobody. See `metrics.ts` for what each figure is anchored on.
 */
@Controller("radiology/metrics")
export class RadiologyMetricsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission("radiology.metrics.read", "hospital")
  async metrics(@Query() query: unknown): Promise<RadiologyMetrics> {
    return radiologyMetrics(this.db, parsed(metricsRangeQuery, query));
  }
}
