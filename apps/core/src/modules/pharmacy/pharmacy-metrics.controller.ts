import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { metricsRangeQuery } from "../../kernel/report/metrics";
import { parsed } from "./pharmacy-http";
import { pharmacyMetrics } from "./metrics";
import type { PharmacyMetrics } from "./metrics";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PHARMACY NUMBERS (owner 2026-10-13, #777) — `GET /pharmacy/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`,
 * IST days, inclusive, at most 92 (`kernel/report/metrics.ts`). Read-only and aggregate: no patient,
 * no bill number. Margin rides only for a holder of `pharmacy.reports.margin` (asserted in `metrics.ts`).
 */
@Controller("pharmacy/metrics")
export class PharmacyMetricsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission("pharmacy.metrics.read", "hospital")
  async metrics(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<PharmacyMetrics> {
    return pharmacyMetrics(this.db, actor, parsed(metricsRangeQuery, query));
  }
}
