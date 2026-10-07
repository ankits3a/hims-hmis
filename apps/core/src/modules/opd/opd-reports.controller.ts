import { Controller, Get, Inject, NotFoundException, Param, Query, Res } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { contentDisposition, toCsv } from "../../kernel/report/csv";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { hasPermission } from "../../kernel/auth/permissions";
import { parsed } from "./opd-masters.controller";
import { loadOpdDepartmentReport, loadOpdReport, rangeFor } from "./report";
import {
  departmentReportCsvRows, fileStem, renderDepartmentReport, renderReport, reportCsvRows,
} from "./report-render";
import { dayReportPatientsListed } from "./events";
import { istDate } from "./time";
import type { OpdDepartmentReport, OpdReport, ReportRange } from "./report";
import type { RenderedReport } from "./report-render";
import type { Response } from "express";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE OPD REPORT — SIX READS, ONE PERMISSION ═══
 *
 * `opd.reports.read`, held by the front-office supervisor, the medical superintendent and the owner
 * (owner, 2026-09-19). The hospital summary is integers; the department report names patients, and
 * every read of it — screen, spreadsheet or printable sheet — writes `day_report.patients_listed`
 * naming the reader, the period, the department, the format and the row count BEFORE the rows leave.
 *
 * Each format has its own route and is built from the same load as the screen (07c's rule: a file
 * built by a second query disagrees with the screen silently).
 *
 * ═══ THE PERIOD IS NAMED, NOT SPELT OUT ═══
 *
 * The caller asks for `period=day|week|month` on a `date` ANCHOR (today unless a day was picked), and
 * `rangeFor` turns that into days. The alternative — a caller passing `from`/`to` — would put the
 * owner's "a week is Monday to Saturday" ruling in the browser, where the printed sheet cannot read
 * it, and the two would drift apart at the first correction.
 */
const reportQuery = z.object({
  period: z.enum(["day", "week", "month"]).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "not a calendar date").optional(),
});

@Controller("opd/reports")
export class OpdReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private rangeOf(query: unknown): ReportRange {
    const q = parsed(reportQuery, query);
    return rangeFor(q.period ?? "day", q.date ?? istDate(new Date()));
  }

  /**
   * "Opened by" names what each clerk did. It rides only for a reader who already holds the staff
   * figures (`staff.reports.read`, 07c) — `opd.reports.read` alone is the department's load, not a
   * person's output — and never for a non-person actor.
   */
  private async staffFigures(actor: Actor): Promise<boolean> {
    return actor.type === "user" && hasPermission(this.db, actor.id, "staff.reports.read", "hospital");
  }

  private async department(
    actor: Actor, query: unknown, departmentId: string, format: "screen" | "csv" | "document",
  ): Promise<OpdDepartmentReport> {
    const range = this.rangeOf(query);
    const report = await loadOpdDepartmentReport(this.db, actor, range, departmentId, { staffFigures: await this.staffFigures(actor) });
    if (report === null) throw new NotFoundException({ message: "no such department", code: "unknown_department" });
    await withTx(this.db, (tx) => appendEvent(tx, dayReportPatientsListed.make({
      actor,
      payload: {
        date: range.anchor, period: range.period, from: range.from, to: range.to,
        departmentId, format, rows: report.rows.length,
      },
    })));
    return report;
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("consultations")
  async consultations(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<OpdReport> {
    return loadOpdReport(this.db, this.rangeOf(query), { staffFigures: await this.staffFigures(actor) });
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("consultations/csv")
  async consultationsCsv(
    @CurrentActor() actor: Actor, @Query() query: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await loadOpdReport(this.db, this.rangeOf(query), { staffFigures: await this.staffFigures(actor) });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`${fileStem(report)}.csv`));
    return toCsv(reportCsvRows(report));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("consultations/document")
  async consultationsDocument(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<RenderedReport> {
    return renderReport(await loadOpdReport(this.db, this.rangeOf(query), { staffFigures: await this.staffFigures(actor) }));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("consultations/departments/:departmentId")
  async departmentReport(
    @CurrentActor() actor: Actor, @Param("departmentId") departmentId: string, @Query() query: unknown,
  ): Promise<OpdDepartmentReport> {
    return this.department(actor, query, departmentId, "screen");
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("consultations/departments/:departmentId/csv")
  async departmentReportCsv(
    @CurrentActor() actor: Actor, @Param("departmentId") departmentId: string, @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.department(actor, query, departmentId, "csv");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`${fileStem(report, report.department)}.csv`));
    return toCsv(departmentReportCsvRows(report));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("consultations/departments/:departmentId/document")
  async departmentReportDocument(
    @CurrentActor() actor: Actor, @Param("departmentId") departmentId: string, @Query() query: unknown,
  ): Promise<RenderedReport> {
    return renderDepartmentReport(await this.department(actor, query, departmentId, "document"));
  }
}
