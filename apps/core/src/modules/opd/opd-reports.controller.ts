import {
  BadRequestException, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Res,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { rangeProblem } from "@hmis/contracts";
import type { FlowReport, OwnerAppointments, OwnerLearning } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import type { AppConfig } from "../../kernel/config";
import { ownerAppointments, ownerLearning } from "./owner-reads";
import { flowAskOf, loadFlowReport } from "./flow";
import { dismissFinding, triedFinding } from "./flow-learning";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { contentDisposition, toCsv } from "../../kernel/report/csv";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { hasPermission } from "../../kernel/auth/permissions";
import { parsed } from "./opd-masters.controller";
import { loadOpdDepartmentReport, loadOpdReport, rangeFor } from "./report";
import { loadRecording } from "./recording";
import type { RecordingReport } from "./recording";
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
 * ═══ THE OPD REPORT — SIX READS, ONE PERMISSION ═══ (and the owner pages' reads below it)
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

/**
 * THE STAFF APP'S OWNER PAGES (owner 2026-10-09) ask in DAYS: `from`..`to`, IST, at most 92 of them and
 * never the future, with an optional comparison range `cfrom`..`cto`. The report's own Monday-to-Saturday
 * week is untouched — a range spelt out is a range, not a named period.
 */
const daysQuery = z.object({
  from: z.string().max(10).optional(), to: z.string().max(10).optional(),
  cfrom: z.string().max(10).optional(), cto: z.string().max(10).optional(),
  period: z.string().max(8).optional(), date: z.string().max(10).optional(),
});

@Controller("opd/reports")
export class OpdReportsController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  /** `from`..`to` (today when both are absent) and the comparison range, refused in the contract's four words. */
  private daysOf(query: unknown): { range: { from: string; to: string }; compare: { from: string; to: string } | null } {
    const q = parsed(daysQuery, query);
    const today = istDate(new Date());
    const from = q.from ?? q.to ?? today, to = q.to ?? q.from ?? today;
    const bad = rangeProblem(from, to, today)
      ?? (q.cfrom === undefined && q.cto === undefined ? null : rangeProblem(q.cfrom, q.cto, today));
    if (bad !== null) throw new BadRequestException({ message: `the range cannot be read: ${bad}`, code: "invalid_range" });
    return { range: { from, to }, compare: q.cfrom === undefined ? null : { from: q.cfrom, to: q.cto! } };
  }

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

  /**
   * "Is today being recorded?" (owner 2026-10-07). No permission on the door: WHAT a login sees is
   * decided inside from the login alone (`loadRecording`) — the desks see the hospital's integers, a
   * doctor their own, per-doctor names only with the staff figures, and anybody else nothing.
   */
  @Get("recording")
  async recording(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<RecordingReport> {
    /*
      Owner 2026-10-09 — the app's Recorded page asks for a week to date, a month to date or a custom
      range, and compares like with like: `from`/`to` spell the days out. Who sees what is decided
      inside exactly as before; a spelt-out range of more than a day reads as the month grain (a row
      per day) with `to` as its anchor.
    */
    const q = (query ?? {}) as { from?: unknown; to?: unknown };
    if (q.from !== undefined || q.to !== undefined) {
      const { range } = this.daysOf(query);
      return loadRecording(this.db, actor, { period: range.from === range.to ? "day" : "month", anchor: range.to, from: range.from, to: range.to });
    }
    return loadRecording(this.db, actor, this.rangeOf(query));
  }

  /**
   * THE OWNER'S APPOINTMENTS PAGE (owner 2026-10-09) — counts by status and by doctor for the days asked
   * for (`owner-reads.ts`). No patient, no appointment number.
   */
  @RequirePermission("opd.reports.read", "hospital")
  @Get("appointments-summary")
  async appointmentsSummary(@Query() query: unknown): Promise<OwnerAppointments> {
    const { range, compare } = this.daysOf(query);
    return ownerAppointments(this.db, range, compare);
  }

  /**
   * THE OWNER'S LEARNING PAGE (owner 2026-10-09) — the nicknames changed in the last seven days, how
   * often an acted-on suggestion was tapped, and how many words matched nothing. READ ONLY: taking a
   * nickname back stays on `POST /opd/consult/nicknames/:id/undo` behind `opd.masters.manage`.
   */
  @RequirePermission("opd.reports.read", "hospital")
  @Get("learning")
  async learning(@CurrentActor() actor: Actor): Promise<OwnerLearning> {
    return ownerLearning(this.db, actor, this.cfg.aliases.enabled);
  }

  /**
   * HOW LONG PATIENTS WAIT (owner 2026-10-09) — desk → vitals → doctor, hospital-wide or for one
   * department, grouped by department / day / hour / weekday, with the like period before, and the
   * findings the nightly learning raised (`flow.ts`, `flow-learning.ts`). Minutes and counts only: no
   * patient and no member of staff in the payload. `period=today|week|month` is read against the
   * server's own today; `from`/`to` (+ `cfrom`/`cto`) as the other owner pages.
   */
  @RequirePermission("opd.reports.read", "hospital")
  @Get("flow")
  async flow(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<FlowReport> {
    const now = new Date();
    const asked = flowAskOf(query, now);
    if (!asked.ok) throw new BadRequestException({ message: `the wait report cannot be read: ${asked.problem}`, code: asked.problem === "bad_group" || asked.problem === "bad_department" ? asked.problem : "invalid_range" });
    return loadFlowReport(this.db, asked.ask, { mayAct: await this.mayActOnFlow(actor), learning: this.cfg.flowFindings.enabled, now });
  }

  /**
   * × and "Tried it" on a finding — the owner and the Medical Superintendent only: the OPD report's
   * permission AND the unbounded staff history, which together only their two roles hold (the same
   * pair the phone's tile home is drawn for). A front-office supervisor reads the waits and does not act.
   */
  private async mayActOnFlow(actor: Actor): Promise<boolean> {
    return actor.type === "user" && hasPermission(this.db, actor.id, "staff.reports.history.full", "hospital");
  }

  private async flowAct(actor: Actor, id: string, act: typeof dismissFinding): Promise<{ ok: true }> {
    if (!(await this.mayActOnFlow(actor))) throw new ForbiddenException({ message: "only the owner or the Medical Superintendent acts on a finding", code: "permission_denied" });
    if (!this.cfg.flowFindings.enabled) throw new ConflictException({ message: "the waits' learning is switched off", code: "flow_learning_off" });
    const r = await act(this.db, actor, id);
    if (r.ok) return { ok: true };
    if (r.problem === "unknown_finding") throw new NotFoundException({ message: "no such finding", code: r.problem });
    throw new ConflictException({ message: `the finding cannot take that: ${r.problem}`, code: r.problem });
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Post("flow/findings/:id/dismiss")
  @HttpCode(200)
  async dismissFlowFinding(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    return this.flowAct(actor, id, dismissFinding);
  }

  @RequirePermission("opd.reports.read", "hospital")
  @Post("flow/findings/:id/tried")
  @HttpCode(200)
  async triedFlowFinding(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    return this.flowAct(actor, id, triedFinding);
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
