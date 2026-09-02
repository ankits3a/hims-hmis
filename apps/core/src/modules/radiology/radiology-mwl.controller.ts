import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { istDayString } from "../../kernel/approvals/cumulative";
import { MWL_READ, mwlExport, renderMwlDump, renderMwlDumpHeader } from "./mwl";
import { idSchema, isoDateSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { Response } from "express";

/**
 * PLAN 18b T1 — `GET /radiology/mwl?date=YYYY-MM-DD&deviceResourceId=&format=json|dump`.
 *
 * `date` defaults to TODAY IN IST, derived on the server (18a F52: a browser's or a bridge host's
 * UTC day is yesterday between 00:00 and 05:30). `format=dump` answers `text/plain` with one
 * dcmtk dump per study separated by a blank line, which is what the runbook's bridge feeds to
 * `dump2dcm`; anything else answers JSON for a screen.
 */
const query = z.object({
  date: isoDateSchema.optional(),
  deviceResourceId: idSchema.optional(),
  format: z.enum(["json", "dump"]).optional(),
});

@Controller("radiology")
export class RadiologyMwlController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("mwl")
  @RequirePermission(MWL_READ, "hospital")
  async mwl(
    @CurrentActor() actor: Actor,
    @Query() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const q = parsed(query, raw);
    try {
      const out = await mwlExport(this.db, actor, {
        date: q.date ?? istDayString(new Date()), deviceResourceId: q.deviceResourceId,
      });
      if (q.format === "dump") {
        res.type("text/plain");
        res.setHeader("X-Hmis-Mwl-Withheld", String(out.withheld));
        res.setHeader("X-Hmis-Mwl-Malformed-Ae-Title", out.malformedAeTitle.join(","));
        return renderMwlDumpHeader(out) + out.rows.map(renderMwlDump).join("\n");
      }
      return out;
    } catch (e) { toHttp(e); }
  }
}
