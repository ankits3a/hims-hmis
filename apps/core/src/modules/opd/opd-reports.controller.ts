import { Controller, Get, Inject, NotFoundException, Param, Query, Res } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { contentDisposition, toCsv } from "../../kernel/report/csv";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed } from "./opd-masters.controller";
import { loadOpdDayReport, loadOpdDepartmentDayReport } from "./day-report";
import {
  dayReportCsvRows, departmentDayReportCsvRows, fileStem, renderDayReport, renderDepartmentDayReport,
} from "./day-report-render";
import { dayReportPatientsListed } from "./events";
import { istDate } from "./time";
import type { OpdDayReport, OpdDepartmentDayReport } from "./day-report";
import type { RenderedReport } from "./day-report-render";
import type { Response } from "express";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE OPD DAY REPORT — SIX READS, ONE PERMISSION ═══
 *
 * `opd.reports.read`, held by the front-office supervisor, the medical superintendent and the owner
 * (owner, 2026-09-19). The hospital summary is integers; the department report names patients, and
 * every read of it — screen, spreadsheet or printable sheet — writes `day_report.patients_listed`
 * naming the reader, the day, the department, the format and the row count BEFORE the rows leave.
 *
 * Each format has its own route and is built from the same load as the screen (07c's rule: a file
 * built by a second query disagrees with the screen silently).
 */
const dayQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "not a calendar date").optional(),
});

@Controller("opd/reports")
export class OpdReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private dateOf(query: unknown): string {
    return parsed(dayQuery, query).date ?? istDate(new Date());
  }

  private async department(actor: Actor, query: unknown, departmentId: string, format: "screen" | "csv" | "document"): Promise<OpdDepartmentDayReport> {
    const date = this.dateOf(query);
    const report = await loadOpdDepartmentDayReport(this.db, actor, date, departmentId);
    if (report === null) throw new NotFoundException({ message: "no such department", code: "unknown_department" });
    await withTx(this.db, (tx) => appendEvent(tx, dayReportPatientsListed.make({
      actor, payload: { date, departmentId, format, rows: report.rows.length },
    })));
    return report;
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("day")
  async day(@Query() query: unknown): Promise<OpdDayReport> {
    return loadOpdDayReport(this.db, this.dateOf(query));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("day/csv")
  async dayCsv(@Query() query: unknown, @Res({ passthrough: true }) res: Response): Promise<string> {
    const report = await loadOpdDayReport(this.db, this.dateOf(query));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`${fileStem(report.date)}.csv`));
    return toCsv(dayReportCsvRows(report));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("day/document")
  async dayDocument(@Query() query: unknown): Promise<RenderedReport> {
    return renderDayReport(await loadOpdDayReport(this.db, this.dateOf(query)));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("day/departments/:departmentId")
  async departmentDay(
    @CurrentActor() actor: Actor, @Param("departmentId") departmentId: string, @Query() query: unknown,
  ): Promise<OpdDepartmentDayReport> {
    return this.department(actor, query, departmentId, "screen");
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("day/departments/:departmentId/csv")
  async departmentDayCsv(
    @CurrentActor() actor: Actor, @Param("departmentId") departmentId: string, @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.department(actor, query, departmentId, "csv");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`${fileStem(report.date, report.department)}.csv`));
    return toCsv(departmentDayReportCsvRows(report));
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Get("day/departments/:departmentId/document")
  async departmentDayDocument(
    @CurrentActor() actor: Actor, @Param("departmentId") departmentId: string, @Query() query: unknown,
  ): Promise<RenderedReport> {
    return renderDepartmentDayReport(await this.department(actor, query, departmentId, "document"));
  }
}
