import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { RequirePermission } from "../../kernel/auth/decorators";
import { isoDateSchema, parsed } from "./lab-http";
import { istDayStart, labMetrics } from "./metrics";
import type { LabMetrics } from "./metrics";
import type { Db } from "../../kernel/db/client";

/** The longest range one request may read: a quarter. A year of parameter rows is a report job, not a screen. */
export const LAB_METRICS_MAX_DAYS = 92;

export const labMetricsQuery = z.object({ from: isoDateSchema, to: isoDateSchema }).refine(
  (q) => {
    const days = (istDayStart(q.to).getTime() - istDayStart(q.from).getTime()) / 86_400_000;
    return Number.isFinite(days) && days >= 0 && days < LAB_METRICS_MAX_DAYS;
  },
  { message: `from must not be after to, and the range is at most ${String(LAB_METRICS_MAX_DAYS)} days` },
);

/**
 * LAB NUMBERS (owner 2026-10-13, #768) — `GET /lab/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`, IST days,
 * inclusive. Read-only and in BOTH lab modes (no `@LabModeOnly`): the owner reads the numbers
 * whichever way the bench runs. See `metrics.ts` for what each figure is anchored on.
 */
@Controller("lab/metrics")
export class LabMetricsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission("lab.metrics.read", "hospital")
  async metrics(@Query() query: unknown): Promise<LabMetrics> {
    return labMetrics(this.db, parsed(labMetricsQuery, query));
  }
}
